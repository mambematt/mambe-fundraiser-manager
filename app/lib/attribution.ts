// The attribution engine. This module is the ONLY code that decides whether an
// order line is a qualifying fundraiser unit, and the only code that counts
// units. See docs/SPEC.md, "Attribution rules".
//
// It is pure: no database, no Shopify, no clock. Callers load the data, call
// attributeOrder(), and store the results on the lines.

import { effectiveWindow, windowContains } from "./window";

/** Shopify financial statuses whose orders can qualify (spec rule 4). */
export const ELIGIBLE_FINANCIAL_STATUSES: ReadonlySet<string> = new Set([
  "PAID",
  "PARTIALLY_PAID",
  "PARTIALLY_REFUNDED",
]);

/** More than this many units of a fundraiser product on one order is flagged. */
export const BULK_UNIT_THRESHOLD = 4;

export type OrderSource = "web" | "pos" | "draft" | "other";

export type ReviewFlag =
  | "bulk_order"
  | "discount"
  | "draft_order"
  | "pos_order"
  | "money_only_refund"
  | "window_conflict";

export const REVIEW_FLAG_LABELS: Record<ReviewFlag, string> = {
  bulk_order: `More than ${BULK_UNIT_THRESHOLD} units on one order`,
  discount: "Discount on a fundraiser line",
  draft_order: "Draft order",
  pos_order: "POS sale",
  money_only_refund: "Money-only refund",
  window_conflict: "Sale falls in more than one fundraiser window",
};

export type LineOutcome =
  /** Steps 1–5 pass and not excluded by an admin. Counts toward the payout. */
  | "qualifying"
  /** Linked product, but no fundraiser window matches. Evergreen sale. */
  | "non_fundraiser"
  /** Cancelled order, or every unit refunded/removed. */
  | "refunded_cancelled"
  /** In a window but flagged and excluded by an admin. */
  | "excluded"
  /** In a window but the order isn't paid (pending, authorized, voided…). */
  | "not_eligible";

export type AdminDecision = "include" | "exclude";

export interface AttributionOrder {
  /** Shopify checkout time (processed_at). */
  processedAt: Date;
  cancelledAt: Date | null;
  /** Shopify displayFinancialStatus, e.g. "PAID". */
  financialStatus: string;
  source: OrderSource;
  /** A refund on this order returned money without returning any units. */
  hasMoneyOnlyRefund: boolean;
}

export interface LineAttribution {
  /** The fundraiser whose window contains the sale, if any. */
  fundraiserId: number | null;
  /** Units after refunds and removals, regardless of window or eligibility. */
  netUnits: number;
  /** Units that count toward the fundraiser's payout. */
  qualifyingUnits: number;
  outcome: LineOutcome;
  flags: ReviewFlag[];
}

export interface AttributionLine {
  /** Any identifier the caller wants back (e.g. the Shopify line item ID). */
  key: string;
  shopifyProductId: string;
  quantity: number;
  refundedQuantity: number;
  /** Shopify's currentQuantity: quantity minus removed units. */
  currentQuantity: number;
  discountCents: number;
  adminDecision: AdminDecision | null;
  /** Locked once its payout is frozen: attribution never changes again. */
  locked: boolean;
  /** The stored attribution. Required when locked. */
  current?: LineAttribution | null;
}

export interface AttributionFundraiser {
  id: number;
  shopifyProductId: string;
  status: string;
  windowStart: Date;
  windowEnd: Date;
  cancelledAt: Date | null;
}

export interface AttributedLine extends LineAttribution {
  key: string;
}

/** Units remaining on a line after refunds and removals. */
export function netUnits(line: Pick<
  AttributionLine,
  "quantity" | "refundedQuantity" | "currentQuantity"
>): number {
  // currentQuantity already excludes removed units; taking the smaller of the
  // two never double-subtracts, whichever way Shopify reports a refund.
  const units = Math.min(line.quantity - line.refundedQuantity, line.currentQuantity);
  return Math.max(0, units);
}

function matchingFundraisers(
  line: AttributionLine,
  processedAt: Date,
  fundraisers: AttributionFundraiser[],
): AttributionFundraiser[] {
  return fundraisers
    .filter(
      (f) =>
        f.shopifyProductId === line.shopifyProductId &&
        f.status !== "declined" &&
        windowContains(
          effectiveWindow({ start: f.windowStart, end: f.windowEnd }, f.cancelledAt),
          processedAt,
        ),
    )
    .sort((a, b) => a.windowStart.getTime() - b.windowStart.getTime() || a.id - b.id);
}

/**
 * Decide attribution for every line of one order.
 *
 * `lines` should be every saved line of the order (only linked products are
 * ever saved). `fundraisers` must include every fundraiser on those products
 * that could match; declined ones are ignored here.
 */
export function attributeOrder(
  order: AttributionOrder,
  lines: AttributionLine[],
  fundraisers: AttributionFundraiser[],
): AttributedLine[] {
  const orderCancelled = order.cancelledAt !== null;
  const orderEligible = ELIGIBLE_FINANCIAL_STATUSES.has(order.financialStatus);
  const fullyRefunded = order.financialStatus === "REFUNDED";

  // First pass: window match and net units for every line.
  const matched = lines.map((line) => {
    const candidates = matchingFundraisers(line, order.processedAt, fundraisers);
    const units = netUnits(line);
    const countsAsUnits = !orderCancelled && !fullyRefunded && units > 0;
    return { line, candidates, fundraiser: candidates[0] ?? null, units, countsAsUnits };
  });

  // Bulk check: units of each fundraiser's product on this order.
  const unitsPerFundraiser = new Map<number, number>();
  for (const m of matched) {
    if (m.fundraiser && m.countsAsUnits) {
      unitsPerFundraiser.set(
        m.fundraiser.id,
        (unitsPerFundraiser.get(m.fundraiser.id) ?? 0) + m.units,
      );
    }
  }

  return matched.map(({ line, candidates, fundraiser, units, countsAsUnits }) => {
    if (line.locked) {
      if (!line.current) {
        throw new Error(`Line ${line.key} is locked but has no stored attribution`);
      }
      return { key: line.key, ...line.current, flags: [...line.current.flags] };
    }

    const fundraiserId = fundraiser?.id ?? null;

    if (!countsAsUnits) {
      return { key: line.key, fundraiserId, netUnits: units, qualifyingUnits: 0, outcome: "refunded_cancelled", flags: [] };
    }
    if (!fundraiser) {
      return { key: line.key, fundraiserId: null, netUnits: units, qualifyingUnits: 0, outcome: "non_fundraiser", flags: [] };
    }

    const flags: ReviewFlag[] = [];
    if ((unitsPerFundraiser.get(fundraiser.id) ?? 0) > BULK_UNIT_THRESHOLD) flags.push("bulk_order");
    if (line.discountCents > 0) flags.push("discount");
    if (order.source === "draft") flags.push("draft_order");
    if (order.source === "pos") flags.push("pos_order");
    if (order.hasMoneyOnlyRefund) flags.push("money_only_refund");
    if (candidates.length > 1) flags.push("window_conflict");

    if (!orderEligible) {
      return { key: line.key, fundraiserId, netUnits: units, qualifyingUnits: 0, outcome: "not_eligible", flags };
    }
    if (line.adminDecision === "exclude") {
      return { key: line.key, fundraiserId, netUnits: units, qualifyingUnits: 0, outcome: "excluded", flags };
    }
    // Flagged lines still count until an admin decides.
    return { key: line.key, fundraiserId, netUnits: units, qualifyingUnits: units, outcome: "qualifying", flags };
  });
}

export interface StoredLineForTotals {
  attributedFundraiserId: number | null;
  qualifyingUnits: number;
  outcome: string;
  reviewFlags: string[];
  adminDecision: string | null;
}

export interface FundraiserTotals {
  qualifyingUnits: number;
  /** Qualifying units × rate. Estimated until the payout is frozen. */
  estimatedPayoutCents: number;
  /** Flagged lines with no admin decision yet. Must be 0 to approve a payout. */
  unresolvedFlaggedLines: number;
  refundedOrCancelledLines: number;
  excludedLines: number;
}

/** Totals for one fundraiser from its stored, attributed lines. */
export function fundraiserTotals(
  fundraiserId: number,
  payoutRateCents: number,
  lines: StoredLineForTotals[],
): FundraiserTotals {
  const totals: FundraiserTotals = {
    qualifyingUnits: 0,
    estimatedPayoutCents: 0,
    unresolvedFlaggedLines: 0,
    refundedOrCancelledLines: 0,
    excludedLines: 0,
  };
  for (const line of lines) {
    if (line.attributedFundraiserId !== fundraiserId) continue;
    if (line.outcome === "qualifying") totals.qualifyingUnits += line.qualifyingUnits;
    if (line.outcome === "refunded_cancelled") totals.refundedOrCancelledLines += 1;
    if (line.outcome === "excluded") totals.excludedLines += 1;
    if (
      line.reviewFlags.length > 0 &&
      line.adminDecision === null &&
      (line.outcome === "qualifying" || line.outcome === "not_eligible")
    ) {
      totals.unresolvedFlaggedLines += 1;
    }
  }
  totals.estimatedPayoutCents = totals.qualifyingUnits * payoutRateCents;
  return totals;
}

export interface StoredLineForLifetime {
  quantity: number;
  refundedQuantity: number;
  currentQuantity: number;
  outcome: string;
  qualifyingUnits: number;
  orderCancelled: boolean;
  orderIsTest: boolean;
}

export interface ProductLifetimeTotals {
  /** Units ordered, before refunds (test orders left out). */
  orderedUnits: number;
  /** Units refunded, removed or on cancelled orders. */
  refundedOrCancelledUnits: number;
  /** orderedUnits minus refundedOrCancelledUnits. Compare with Shopify Analytics "net items sold". */
  netUnits: number;
  /** Net units that qualified for a fundraiser. */
  inWindowUnits: number;
  /** Net units sold outside any fundraiser window (evergreen). */
  outsideWindowUnits: number;
}

/** Lifetime unit totals for one product from its stored lines. */
export function productLifetimeTotals(lines: StoredLineForLifetime[]): ProductLifetimeTotals {
  const totals: ProductLifetimeTotals = {
    orderedUnits: 0,
    refundedOrCancelledUnits: 0,
    netUnits: 0,
    inWindowUnits: 0,
    outsideWindowUnits: 0,
  };
  for (const line of lines) {
    if (line.orderIsTest) continue;
    const net = line.orderCancelled ? 0 : netUnits(line);
    totals.orderedUnits += line.quantity;
    totals.refundedOrCancelledUnits += line.quantity - net;
    totals.netUnits += net;
    if (line.outcome === "qualifying") totals.inWindowUnits += line.qualifyingUnits;
    if (line.outcome === "non_fundraiser") totals.outsideWindowUnits += net;
  }
  return totals;
}

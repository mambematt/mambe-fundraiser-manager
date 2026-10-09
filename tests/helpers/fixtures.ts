import { DateTime } from "luxon";
import type {
  AttributionFundraiser,
  AttributionLine,
  AttributionOrder,
} from "../../app/lib/attribution";
import { computeWindow } from "../../app/lib/window";
import type { ShopifyOrderNode } from "../../app/lib/shopify-order";

export const CAPE = "1001"; // Central High Girls Lacrosse cape (team product)
export const COACH = "1002"; // separate coach product

/** A wall-clock time in Pacific, e.g. pt("2026-10-01T00:00:00"). */
export function pt(local: string): Date {
  const dt = DateTime.fromISO(local, { zone: "America/Los_Angeles" });
  if (!dt.isValid) throw new Error(`Bad time ${local}`);
  return dt.toJSDate();
}

/** The sample fundraiser: Central High Girls Lacrosse, Oct 1–31 2026, $25. */
export function sampleFundraiser(
  overrides: Partial<AttributionFundraiser> & { startDate?: string; endDate?: string } = {},
): AttributionFundraiser {
  const { startDate = "2026-10-01", endDate = "2026-10-31", ...rest } = overrides;
  const window = computeWindow(startDate, endDate, "America/Los_Angeles");
  return {
    id: 1,
    shopifyProductId: CAPE,
    status: "active",
    windowStart: window.start,
    windowEnd: window.end,
    cancelledAt: null,
    ...rest,
  };
}

export const RATE_CENTS = 2500;

export function order(overrides: Partial<AttributionOrder> = {}): AttributionOrder {
  return {
    processedAt: pt("2026-10-15T12:00:00"),
    cancelledAt: null,
    financialStatus: "PAID",
    source: "web",
    hasMoneyOnlyRefund: false,
    isTest: false,
    ...overrides,
  };
}

let nextKey = 1;
export function line(overrides: Partial<AttributionLine> = {}): AttributionLine {
  const quantity = overrides.quantity ?? 1;
  return {
    key: `line-${nextKey++}`,
    shopifyProductId: CAPE,
    quantity,
    refundedQuantity: 0,
    currentQuantity: quantity,
    discountCents: 0,
    adminDecision: null,
    locked: false,
    ...overrides,
  };
}

/** A Shopify GraphQL order as ORDER_QUERY returns it. */
export function shopifyOrderNode(args: {
  id?: string;
  name?: string;
  processedAt?: Date;
  updatedAt?: Date;
  cancelledAt?: Date | null;
  financialStatus?: string;
  sourceName?: string;
  test?: boolean;
  refunds?: Array<{ amount: string; lines: Array<{ lineId: string; quantity: number }> }>;
  lines: Array<{
    id: string;
    productId: string | null;
    quantity: number;
    currentQuantity?: number;
    price?: string;
    discount?: string;
    cost?: string | null;
  }>;
}): ShopifyOrderNode {
  return {
    id: `gid://shopify/Order/${args.id ?? "9001"}`,
    name: args.name ?? "#1001",
    processedAt: (args.processedAt ?? pt("2026-10-15T12:00:00")).toISOString(),
    updatedAt: (args.updatedAt ?? new Date("2026-10-15T20:00:00Z")).toISOString(),
    cancelledAt: args.cancelledAt ? args.cancelledAt.toISOString() : null,
    displayFinancialStatus: args.financialStatus ?? "PAID",
    sourceName: args.sourceName ?? "web",
    test: args.test ?? false,
    discountCodes: [],
    refunds: (args.refunds ?? []).map((r, i) => ({
      id: `gid://shopify/Refund/${i + 1}`,
      totalRefundedSet: { shopMoney: { amount: r.amount } },
      refundLineItems: {
        nodes: r.lines.map((l) => ({
          quantity: l.quantity,
          lineItem: { id: `gid://shopify/LineItem/${l.lineId}` },
        })),
        pageInfo: { hasNextPage: false },
      },
    })),
    lineItems: {
      nodes: args.lines.map((l) => ({
        id: `gid://shopify/LineItem/${l.id}`,
        quantity: l.quantity,
        currentQuantity: l.currentQuantity ?? l.quantity,
        product: l.productId ? { id: `gid://shopify/Product/${l.productId}` } : null,
        variant: {
          id: `gid://shopify/ProductVariant/${l.id}0`,
          inventoryItem: { unitCost: l.cost === null ? null : { amount: l.cost ?? "80.00" } },
        },
        originalUnitPriceSet: { shopMoney: { amount: l.price ?? "195.00" } },
        totalDiscountSet: { shopMoney: { amount: l.discount ?? "0.00" } },
      })),
      pageInfo: { hasNextPage: false },
    },
  };
}

// The 24 owner-approved cases from docs/SPEC.md, "Attribution and payout test
// cases". Numbered to match the spec. Cases that need the database are in
// tests/db/spec-cases.db.test.ts and tests/db/lifecycle.db.test.ts; cases
// that need later build steps are
// test.todo here with their number.
//
// Sample fundraiser: Central High Girls Lacrosse, Oct 1–31 2026, $25 per cape.
// Daylight saving ends Nov 1, so the window closes at Nov 1, 07:00 UTC.

import { describe, expect, test } from "vitest";
import {
  attributeOrder,
  fundraiserTotals,
  type AttributedLine,
  type AttributionFundraiser,
  type AttributionLine,
  type AttributionOrder,
} from "../../app/lib/attribution";
import { normalizeOrder } from "../../app/lib/shopify-order";
import {
  CAPE,
  COACH,
  RATE_CENTS,
  line,
  order,
  pt,
  sampleFundraiser,
  shopifyOrderNode,
} from "../helpers/fixtures";

const F = sampleFundraiser();

function run(
  o: Partial<AttributionOrder>,
  lines: AttributionLine[],
  fundraisers: AttributionFundraiser[] = [F],
): AttributedLine[] {
  return attributeOrder(order(o), lines, fundraisers);
}

/** Totals for fundraiser `id` across attributed lines (with optional admin decisions). */
function totals(results: AttributedLine[], id = F.id, decisions: Record<string, string> = {}) {
  return fundraiserTotals(
    id,
    RATE_CENTS,
    results.map((r) => ({
      attributedFundraiserId: r.fundraiserId,
      qualifyingUnits: r.qualifyingUnits,
      outcome: r.outcome,
      reviewFlags: r.flags,
      adminDecision: decisions[r.key] ?? null,
    })),
  );
}

describe("Attribution and payout test cases (spec)", () => {
  test("sample window closes at Nov 1, 07:00 UTC", () => {
    expect(F.windowStart.toISOString()).toBe("2026-10-01T07:00:00.000Z");
    expect(F.windowEnd.toISOString()).toBe("2026-11-01T07:00:00.000Z");
  });

  test("Case 1: checkout Sep 30 11:59:59 PM Pacific → 0 units, evergreen sale", () => {
    const [r] = run({ processedAt: pt("2026-09-30T23:59:59") }, [line()]);
    expect(r.fundraiserId).toBeNull();
    expect(r.qualifyingUnits).toBe(0);
    expect(r.outcome).toBe("non_fundraiser");
    expect(r.netUnits).toBe(1); // still a sale for evergreen/lifetime totals
    expect(totals([r]).qualifyingUnits).toBe(0);
  });

  test("Case 2: checkout Oct 1 12:00:00 AM Pacific → 1 unit, $25", () => {
    const results = run({ processedAt: pt("2026-10-01T00:00:00") }, [line()]);
    expect(results[0]).toMatchObject({ fundraiserId: 1, qualifyingUnits: 1, outcome: "qualifying", flags: [] });
    expect(totals(results)).toMatchObject({ qualifyingUnits: 1, estimatedPayoutCents: 2500 });
  });

  test("Case 3: checkout Oct 31 11:59:59 PM Pacific (Nov 1 in UTC) → 1 unit, $25", () => {
    const at = pt("2026-10-31T23:59:59");
    expect(at.toISOString()).toBe("2026-11-01T06:59:59.000Z");
    const results = run({ processedAt: at }, [line()]);
    expect(results[0]).toMatchObject({ fundraiserId: 1, qualifyingUnits: 1, outcome: "qualifying" });
    expect(totals(results)).toMatchObject({ qualifyingUnits: 1, estimatedPayoutCents: 2500 });
  });

  test("Case 4: checkout Nov 1 12:00:00 AM Pacific → 0 units, evergreen sale", () => {
    const [r] = run({ processedAt: pt("2026-11-01T00:00:00") }, [line()]);
    expect(r).toMatchObject({ fundraiserId: null, qualifyingUnits: 0, outcome: "non_fundraiser", netUnits: 1 });
  });

  test("Case 5: one line, quantity 3 → 3 units, $75", () => {
    const results = run({}, [line({ quantity: 3 })]);
    expect(results[0]).toMatchObject({ qualifyingUnits: 3, outcome: "qualifying", flags: [] });
    expect(totals(results)).toMatchObject({ qualifyingUnits: 3, estimatedPayoutCents: 7500 });
  });

  test("Case 6: quantity 3, then 1 refunded by quantity → 2 units, $50", () => {
    // Shopify reports the refund in refundLineItems and in currentQuantity.
    const results = run({ financialStatus: "PARTIALLY_REFUNDED" }, [
      line({ quantity: 3, refundedQuantity: 1, currentQuantity: 2 }),
    ]);
    expect(results[0]).toMatchObject({ qualifyingUnits: 2, outcome: "qualifying" });
    expect(totals(results)).toMatchObject({ qualifyingUnits: 2, estimatedPayoutCents: 5000 });

    // Same answer if currentQuantity didn't reflect the refund: never double-subtracted.
    const [alt] = run({ financialStatus: "PARTIALLY_REFUNDED" }, [
      line({ quantity: 3, refundedQuantity: 1, currentQuantity: 3 }),
    ]);
    expect(alt.qualifyingUnits).toBe(2);
  });

  test("Case 7: quantity 1, then a $20 money-only refund → 1 unit, $25, flagged", () => {
    // The Shopify order as it arrives: a refund of $20 with no line quantities.
    const { order: o, lines } = normalizeOrder(
      shopifyOrderNode({
        financialStatus: "PARTIALLY_REFUNDED",
        refunds: [{ amount: "20.00", lines: [] }],
        lines: [{ id: "1", productId: CAPE, quantity: 1 }],
      }),
    );
    expect(o.hasMoneyOnlyRefund).toBe(true);
    expect(lines[0].refundedQuantity).toBe(0);

    const results = run(
      { financialStatus: o.financialStatus, hasMoneyOnlyRefund: o.hasMoneyOnlyRefund },
      [line({ quantity: 1 })],
    );
    expect(results[0]).toMatchObject({ qualifyingUnits: 1, outcome: "qualifying", flags: ["money_only_refund"] });
    expect(totals(results)).toMatchObject({ qualifyingUnits: 1, estimatedPayoutCents: 2500, unresolvedFlaggedLines: 1 });
  });

  test("Case 8: order cancelled → 0 units, line kept in the refund column", () => {
    const results = run(
      { cancelledAt: pt("2026-10-16T09:00:00"), financialStatus: "REFUNDED" },
      [line({ quantity: 1, refundedQuantity: 1, currentQuantity: 0 })],
    );
    expect(results[0]).toMatchObject({ fundraiserId: 1, qualifyingUnits: 0, outcome: "refunded_cancelled" });
    expect(totals(results)).toMatchObject({ qualifyingUnits: 0, estimatedPayoutCents: 0, refundedOrCancelledLines: 1 });

    // Cancelled even if Shopify still shows the units and a PAID status.
    const [alt] = run({ cancelledAt: pt("2026-10-16T09:00:00"), financialStatus: "PAID" }, [line()]);
    expect(alt).toMatchObject({ qualifyingUnits: 0, outcome: "refunded_cancelled" });
  });

  // Case 9 (duplicate and out-of-order webhooks) is in tests/db/spec-cases.db.test.ts.

  test("Case 10: one order with 4 capes → 4 units, $100, no flag", () => {
    const single = run({}, [line({ quantity: 4 })]);
    expect(single[0]).toMatchObject({ qualifyingUnits: 4, flags: [] });
    expect(totals(single)).toMatchObject({ qualifyingUnits: 4, estimatedPayoutCents: 10000, unresolvedFlaggedLines: 0 });

    // Split across two lines (e.g. two sizes) is still 4 on the order: no flag.
    const split = run({}, [line({ quantity: 2 }), line({ quantity: 2 })]);
    expect(split.every((r) => r.flags.length === 0)).toBe(true);
    expect(totals(split).qualifyingUnits).toBe(4);
  });

  test("Case 11: one order with 5 capes → 5 estimated, flagged; include $125 or exclude $0", () => {
    const flagged = run({}, [line({ quantity: 5 })]);
    expect(flagged[0]).toMatchObject({ qualifyingUnits: 5, outcome: "qualifying", flags: ["bulk_order"] });
    // Counted as estimated, but blocks payout approval until decided.
    expect(totals(flagged)).toMatchObject({ qualifyingUnits: 5, estimatedPayoutCents: 12500, unresolvedFlaggedLines: 1 });

    const key = "bulk";
    const included = run({}, [line({ key, quantity: 5, adminDecision: "include" })]);
    expect(included[0]).toMatchObject({ qualifyingUnits: 5, outcome: "qualifying" });
    expect(totals(included, F.id, { [key]: "include" })).toMatchObject({
      estimatedPayoutCents: 12500,
      unresolvedFlaggedLines: 0,
    });

    const excluded = run({}, [line({ key, quantity: 5, adminDecision: "exclude" })]);
    expect(excluded[0]).toMatchObject({ qualifyingUnits: 0, outcome: "excluded", flags: ["bulk_order"] });
    expect(totals(excluded, F.id, { [key]: "exclude" })).toMatchObject({
      estimatedPayoutCents: 0,
      unresolvedFlaggedLines: 0,
    });

    // 3 + 2 on separate lines of the same order is also more than 4: both flagged.
    const split = run({}, [line({ quantity: 3 }), line({ quantity: 2 })]);
    expect(split.map((r) => r.flags)).toEqual([["bulk_order"], ["bulk_order"]]);
  });
  test.todo("Case 11: payout approval is refused while the bulk line is unresolved (settlement step)");

  test("Case 12: a discount code applied to a fundraiser cape → counts, flagged", () => {
    const results = run({}, [line({ discountCents: 1950 })]);
    expect(results[0]).toMatchObject({ qualifyingUnits: 1, outcome: "qualifying", flags: ["discount"] });
    expect(totals(results)).toMatchObject({ estimatedPayoutCents: 2500, unresolvedFlaggedLines: 1 });

    // A code applied to the whole order (the usual case on the live store,
    // e.g. #111494, WELCOME code, Oct 2 2026): Shopify leaves the line's
    // totalDiscountSet at $0 and puts the amount in discountAllocations.
    const { lines } = normalizeOrder(
      shopifyOrderNode({
        lines: [
          { id: "1", productId: CAPE, quantity: 1, orderDiscount: "19.50" },
          { id: "2", productId: CAPE, quantity: 1, orderDiscount: "19.50" },
        ],
      }),
    );
    expect(lines.map((l) => l.discountCents)).toEqual([1950, 1950]);
    const wholeOrder = run({}, lines.map((l) => line({ quantity: l.quantity, discountCents: l.discountCents })));
    expect(wholeOrder.map((r) => r.flags)).toEqual([["discount"], ["discount"]]);
    expect(totals(wholeOrder)).toMatchObject({ qualifyingUnits: 2, estimatedPayoutCents: 5000, unresolvedFlaggedLines: 2 });
  });

  test("Case 13: coach product bought during the window → 0 units", () => {
    const results = run({}, [line({ shopifyProductId: COACH, quantity: 2 })]);
    expect(results[0]).toMatchObject({ fundraiserId: null, qualifyingUnits: 0 });
    expect(totals(results).qualifyingUnits).toBe(0);

    // On the same order as a cape: only the cape counts, and the coach units
    // don't push the order over the bulk threshold.
    const mixed = run({}, [line({ quantity: 4 }), line({ shopifyProductId: COACH, quantity: 3 })]);
    expect(mixed[0]).toMatchObject({ qualifyingUnits: 4, flags: [] });
    expect(mixed[1]).toMatchObject({ qualifyingUnits: 0, fundraiserId: null });
    expect(totals(mixed).qualifyingUnits).toBe(4);

    // And a coach product that isn't linked is never saved at all.
    const { lines } = normalizeOrder(
      shopifyOrderNode({ lines: [{ id: "1", productId: COACH, quantity: 1 }] }),
    );
    expect(lines.map((l) => l.shopifyProductId)).toEqual([COACH]); // the sync step drops unlinked products
  });

  test("Case 14: cape with personalization, line price $230 → 1 unit, $25", () => {
    const { lines } = normalizeOrder(
      shopifyOrderNode({ lines: [{ id: "1", productId: CAPE, quantity: 1, price: "230.00" }] }),
    );
    expect(lines[0].unitPriceCents).toBe(23000);
    const results = run({}, [line({ quantity: lines[0].quantity })]);
    expect(totals(results)).toMatchObject({ qualifyingUnits: 1, estimatedPayoutCents: 2500 });
  });

  test("Case 15: draft order or POS sale of 1 cape → 1 unit, flagged for review", () => {
    const draftSource = normalizeOrder(
      shopifyOrderNode({ sourceName: "shopify_draft_order", lines: [{ id: "1", productId: CAPE, quantity: 1 }] }),
    ).order.source;
    const posSource = normalizeOrder(
      shopifyOrderNode({ sourceName: "pos", lines: [{ id: "1", productId: CAPE, quantity: 1 }] }),
    ).order.source;
    expect(draftSource).toBe("draft");
    expect(posSource).toBe("pos");

    const draft = run({ source: draftSource }, [line()]);
    expect(draft[0]).toMatchObject({ qualifyingUnits: 1, flags: ["draft_order"] });
    const pos = run({ source: posSource }, [line()]);
    expect(pos[0]).toMatchObject({ qualifyingUnits: 1, flags: ["pos_order"] });
    expect(totals(pos)).toMatchObject({ qualifyingUnits: 1, unresolvedFlaggedLines: 1 });
  });

  // Case 16 (overlap refused by the database) is in tests/db/spec-cases.db.test.ts.

  test("Case 17: next fundraiser starts Nov 1; order Nov 1 12:00 AM Pacific → new fundraiser only", () => {
    const next = sampleFundraiser({ id: 2, startDate: "2026-11-01", endDate: "2026-11-30" });
    expect(next.windowStart.getTime()).toBe(F.windowEnd.getTime());

    const atBoundary = run({ processedAt: pt("2026-11-01T00:00:00") }, [line()], [F, next]);
    expect(atBoundary[0]).toMatchObject({ fundraiserId: 2, qualifyingUnits: 1, flags: [] });
    expect(totals(atBoundary, 1).qualifyingUnits).toBe(0);
    expect(totals(atBoundary, 2).qualifyingUnits).toBe(1);

    const justBefore = run({ processedAt: pt("2026-10-31T23:59:59") }, [line()], [F, next]);
    expect(justBefore[0]).toMatchObject({ fundraiserId: 1, flags: [] });
  });

  test("Case 18: cancelled Oct 20 at 3:00 PM; 12 sold before, 2 after → 12 units, $300", () => {
    const cancelled = sampleFundraiser({ status: "cancelled", cancelledAt: pt("2026-10-20T15:00:00") });
    const before = Array.from({ length: 12 }, (_, i) =>
      run({ processedAt: pt(`2026-10-${String(8 + i).padStart(2, "0")}T10:00:00`) }, [line()], [cancelled]),
    ).flat();
    const lastSecond = run({ processedAt: pt("2026-10-20T14:59:59") }, [line()], [cancelled]);
    const after = [
      ...run({ processedAt: pt("2026-10-20T15:00:00") }, [line()], [cancelled]),
      ...run({ processedAt: pt("2026-10-25T10:00:00") }, [line()], [cancelled]),
    ];
    expect(lastSecond[0].fundraiserId).toBe(1);
    expect(after.every((r) => r.fundraiserId === null && r.qualifyingUnits === 0)).toBe(true);
    expect(totals([...before, ...after])).toMatchObject({ qualifyingUnits: 12, estimatedPayoutCents: 30000 });
  });

  // Case 19 (date change preview and save) is in tests/db/lifecycle.db.test.ts.

  // Case 20's nightly re-check half is in tests/db/lifecycle.db.test.ts.
  test.todo("Case 20: the settlement re-pull confirms the order the nightly re-check added (settlement)");

  test.todo("Case 21: settlement re-pull fails; stays in Settling, flagged, no payout calculated (settlement)");

  test.todo("Case 22: refund on Dec 1 after the payout was frozen and paid; paid amount unchanged, refund on history (settlement)");

  // Case 23 (cost per item kept from time of sale) is in tests/db/spec-cases.db.test.ts.

  test.todo("Case 24: organizer A opens organizer B's fundraiser, or reuses an old login link; both refused (portal, session 4)");
});

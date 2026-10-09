import { describe, expect, test } from "vitest";
import { computeWindow, effectiveWindow, windowContains } from "../../app/lib/window";
import { decimalToCents, formatCents } from "../../app/lib/money";
import { attributeOrder, netUnits, productLifetimeTotals } from "../../app/lib/attribution";
import { line, order, pt, sampleFundraiser } from "../helpers/fixtures";

describe("computeWindow", () => {
  test("a window crossing the Nov 1 daylight-saving change", () => {
    const w = computeWindow("2026-10-25", "2026-11-05");
    expect(w.start.toISOString()).toBe("2026-10-25T07:00:00.000Z"); // PDT, UTC-7
    expect(w.end.toISOString()).toBe("2026-11-06T08:00:00.000Z"); // PST, UTC-8
  });

  test("a window crossing the March daylight-saving change", () => {
    const w = computeWindow("2027-03-01", "2027-03-31");
    expect(w.start.toISOString()).toBe("2027-03-01T08:00:00.000Z");
    expect(w.end.toISOString()).toBe("2027-04-01T07:00:00.000Z");
  });

  test("a one-day fundraiser is a full local day", () => {
    const w = computeWindow("2026-10-15", "2026-10-15");
    expect(w.end.getTime() - w.start.getTime()).toBe(24 * 3600 * 1000);
  });

  test("other timezones, and dates read back from a Postgres DATE column", () => {
    const w = computeWindow(new Date("2026-10-01T00:00:00Z"), new Date("2026-10-31T00:00:00Z"), "America/New_York");
    expect(w.start.toISOString()).toBe("2026-10-01T04:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-11-01T04:00:00.000Z");
  });

  test("rejects bad input", () => {
    expect(() => computeWindow("2026-10-31", "2026-10-01")).toThrow();
    expect(() => computeWindow("2026-10-01", "2026-10-31", "Mars/Olympus")).toThrow();
    expect(() => computeWindow("10/01/2026", "2026-10-31")).toThrow();
  });

  test("windows are half-open and cancellation ends them", () => {
    const w = computeWindow("2026-10-01", "2026-10-31");
    expect(windowContains(w, w.start)).toBe(true);
    expect(windowContains(w, w.end)).toBe(false);
    const cut = effectiveWindow(w, pt("2026-10-20T15:00:00"));
    expect(cut.end.toISOString()).toBe("2026-10-20T22:00:00.000Z");
    expect(effectiveWindow(w, pt("2026-12-01T00:00:00"))).toEqual(w);
  });
});

describe("money", () => {
  test("decimal strings to integer cents without floating point", () => {
    expect(decimalToCents("195.00")).toBe(19500);
    expect(decimalToCents("0.1")).toBe(10);
    expect(decimalToCents("80")).toBe(8000);
    expect(decimalToCents("5.855")).toBe(586);
    expect(decimalToCents("-20.00")).toBe(-2000);
    expect(decimalToCents(null)).toBe(0);
    expect(() => decimalToCents("abc")).toThrow();
    expect(formatCents(12500)).toBe("$125.00");
    expect(formatCents(123456789)).toBe("$1,234,567.89");
  });
});

describe("attribution engine details", () => {
  const F = sampleFundraiser();

  test("unpaid orders don't count yet", () => {
    for (const status of ["PENDING", "AUTHORIZED", "VOIDED", "EXPIRED"]) {
      const [r] = attributeOrder(order({ financialStatus: status }), [line()], [F]);
      expect(r).toMatchObject({ fundraiserId: 1, qualifyingUnits: 0, outcome: "not_eligible" });
    }
    const [partial] = attributeOrder(order({ financialStatus: "PARTIALLY_PAID" }), [line()], [F]);
    expect(partial.qualifyingUnits).toBe(1);
  });

  test("declined fundraisers never match", () => {
    const [r] = attributeOrder(order(), [line()], [sampleFundraiser({ status: "declined" })]);
    expect(r.fundraiserId).toBeNull();
  });

  test("attribution doesn't depend on status (a late Scheduled → Active flip)", () => {
    const [r] = attributeOrder(order({ processedAt: pt("2026-10-01T00:05:00") }), [line()], [sampleFundraiser({ status: "scheduled" })]);
    expect(r.qualifyingUnits).toBe(1);
  });

  test("a locked line keeps its stored attribution even after a later refund", () => {
    const stored = { fundraiserId: 1, netUnits: 2, qualifyingUnits: 2, outcome: "qualifying" as const, flags: [] };
    const [r] = attributeOrder(
      order({ financialStatus: "PARTIALLY_REFUNDED" }),
      [line({ quantity: 2, refundedQuantity: 1, currentQuantity: 1, locked: true, current: stored })],
      [F],
    );
    expect(r).toMatchObject(stored);
    expect(() => attributeOrder(order(), [line({ locked: true })], [F])).toThrow(/locked/);
  });

  test("a sale inside two fundraisers' windows is flagged, never silently split", () => {
    const cancelled = sampleFundraiser({ id: 1, status: "cancelled", cancelledAt: pt("2026-10-20T15:00:00") });
    const replacement = sampleFundraiser({ id: 2, startDate: "2026-10-20", endDate: "2026-10-31" });
    const [r] = attributeOrder(order({ processedAt: pt("2026-10-20T09:00:00") }), [line()], [cancelled, replacement]);
    expect(r.flags).toContain("window_conflict");
    expect(r.qualifyingUnits).toBe(1);
  });

  test("Shopify test orders: ignored on the live store, counted on staging (owner decision 2026-10-09)", () => {
    const testOrder = order({ isTest: true });
    const [live] = attributeOrder(testOrder, [line({ quantity: 2 })], [F]);
    expect(live).toMatchObject({ fundraiserId: 1, qualifyingUnits: 0, outcome: "test_order", flags: [] });

    const [staging] = attributeOrder(testOrder, [line({ quantity: 2 })], [F], { countTestOrders: true });
    expect(staging).toMatchObject({ fundraiserId: 1, qualifyingUnits: 2, outcome: "qualifying" });

    // An ignored test order never trips the bulk flag either.
    const [bulk] = attributeOrder(testOrder, [line({ quantity: 6 })], [F]);
    expect(bulk.flags).toEqual([]);
  });

  test("net units never go negative", () => {
    expect(netUnits({ quantity: 1, refundedQuantity: 2, currentQuantity: 0 })).toBe(0);
  });
});

describe("product lifetime totals", () => {
  const base = { refundedQuantity: 0, discountCents: 0, orderCancelled: false, orderIsTest: false, qualifyingUnits: 0, outcome: "non_fundraiser" };
  test("counts orders older than 60 days, gross sales and discounts; leaves out test orders", () => {
    const now = new Date("2026-10-09T12:00:00Z");
    const totals = productLifetimeTotals(
      [
        { ...base, orderId: 1, processedAt: new Date("2026-08-01T12:00:00Z"), quantity: 1, currentQuantity: 1, unitPriceCents: 19500 },
        { ...base, orderId: 1, processedAt: new Date("2026-08-01T12:00:00Z"), quantity: 1, currentQuantity: 1, unitPriceCents: 23000 },
        { ...base, orderId: 2, processedAt: new Date("2026-08-10T12:00:01Z"), quantity: 2, currentQuantity: 2, unitPriceCents: 19500, discountCents: 1950, outcome: "qualifying", qualifyingUnits: 2 },
        { ...base, orderId: 3, processedAt: new Date("2026-10-01T12:00:00Z"), quantity: 5, currentQuantity: 5, unitPriceCents: 19500, orderIsTest: true },
      ],
      now,
    );
    expect(totals).toMatchObject({
      orders: 2,
      ordersOlderThan60Days: 1, // Aug 10 12:00:01 is just inside 60 days
      orderedUnits: 4,
      grossSalesCents: 19500 + 23000 + 2 * 19500,
      discountsCents: 1950,
      inWindowUnits: 2,
      inWindowRevenueCents: 39000,
      outsideWindowUnits: 2,
      outsideWindowRevenueCents: 42500,
    });
  });
});

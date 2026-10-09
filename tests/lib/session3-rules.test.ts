import { describe, expect, test } from "vitest";
import { adminOrderUrl, adminProductUrl, storefrontProductUrl } from "../../app/lib/shopify-links";
import { addDays, dayStatus, monthToDate, todayPacific, yearToDate } from "../../app/lib/calendar";
import { buildWorkQueue, type QueueFundraiser, type QueueInput } from "../../app/lib/work-queue";
import { describeAudit } from "../../app/lib/audit-describe";
import { periodTotals, type StoredLineForPeriod } from "../../app/lib/attribution";
import { pt } from "../helpers/fixtures";

describe("Shopify admin links", () => {
  test("order and product links open inside Shopify admin", () => {
    expect(adminOrderUrl("5551234567890")).toBe("shopify://admin/orders/5551234567890");
    expect(adminOrderUrl("gid://shopify/Order/5551234567890")).toBe("shopify://admin/orders/5551234567890");
    expect(adminProductUrl("8042548592828")).toBe("shopify://admin/products/8042548592828");
    expect(storefrontProductUrl("mambe.myshopify.com", "custom-nazareth-hooded-blanket")).toBe(
      "https://mambe.myshopify.com/products/custom-nazareth-hooded-blanket",
    );
    expect(() => adminOrderUrl("not-an-id")).toThrow();
  });
});

describe("Pacific calendar", () => {
  test("today flips at midnight Pacific, not UTC", () => {
    expect(todayPacific(pt("2026-10-09T23:59:59"))).toBe("2026-10-09");
    expect(todayPacific(pt("2026-10-10T00:00:00"))).toBe("2026-10-10");
    expect(addDays("2026-10-30", 3)).toBe("2026-11-02");
  });

  test("month and year to date start at 12:00 AM Pacific", () => {
    expect(monthToDate(pt("2026-10-09T10:00:00")).start.toISOString()).toBe("2026-10-01T07:00:00.000Z");
    // After the DST change, the month starts at UTC-8.
    expect(monthToDate(pt("2026-11-20T10:00:00")).start.toISOString()).toBe("2026-11-01T07:00:00.000Z");
    expect(monthToDate(pt("2026-12-05T10:00:00")).start.toISOString()).toBe("2026-12-01T08:00:00.000Z");
    expect(yearToDate(pt("2026-10-09T10:00:00")).start.toISOString()).toBe("2026-01-01T08:00:00.000Z");
    // 11 PM Pacific on Dec 31 is still last year, though it's Jan 1 in UTC.
    expect(yearToDate(pt("2026-12-31T23:00:00")).start.toISOString()).toBe("2026-01-01T08:00:00.000Z");
  });

  test("days left / since end", () => {
    const now = pt("2026-10-09T10:00:00");
    expect(dayStatus("2026-10-01", "2026-11-15", now)).toBe("37 days left");
    expect(dayStatus("2026-10-01", "2026-10-09", now)).toBe("Ends today");
    expect(dayStatus("2026-10-01", "2026-10-10", now)).toBe("1 day left");
    expect(dayStatus("2026-09-01", "2026-10-06", now)).toBe("Ended 3 days ago");
    expect(dayStatus("2026-10-10", "2026-10-20", now)).toBe("Starts tomorrow");
    expect(dayStatus("2026-10-12", "2026-10-20", now)).toBe("Starts in 3 days");
  });
});

describe("number strip totals", () => {
  const line = (at: Date, outcome: string, units: number, rate: number | null = 2500): StoredLineForPeriod => ({
    processedAt: at,
    outcome,
    qualifyingUnits: outcome === "qualifying" ? units : 0,
    quantity: units,
    refundedQuantity: 0,
    currentQuantity: units,
    payoutRateCents: rate,
  });

  test("month boundary is 12:00 AM Pacific on the 1st", () => {
    const now = pt("2026-10-09T10:00:00");
    const lines = [
      line(pt("2026-09-30T23:59:59"), "qualifying", 1), // September in Pacific (Oct 1 in UTC)
      line(pt("2026-10-01T00:00:00"), "qualifying", 2),
      line(pt("2026-10-05T12:00:00"), "qualifying", 3, 3000),
    ];
    const month = monthToDate(now);
    expect(periodTotals(lines, month.start, now)).toEqual({ qualifyingUnits: 5, estimatedPayoutCents: 2 * 2500 + 3 * 3000, outsideWindowUnits: 0 });
    const year = yearToDate(now);
    expect(periodTotals(lines, year.start, now).qualifyingUnits).toBe(6);
  });

  test("test orders (live-store setting) and non-counting outcomes are left out; outside-window units counted", () => {
    const now = pt("2026-10-09T10:00:00");
    const lines = [
      line(pt("2026-10-02T12:00:00"), "test_order", 4),
      line(pt("2026-10-02T12:00:00"), "excluded", 5),
      line(pt("2026-10-02T12:00:00"), "refunded_cancelled", 1),
      line(pt("2026-10-03T12:00:00"), "non_fundraiser", 2, null),
      line(pt("2026-10-03T12:00:00"), "qualifying", 1),
    ];
    expect(periodTotals(lines, monthToDate(now).start, now)).toEqual({ qualifyingUnits: 1, estimatedPayoutCents: 2500, outsideWindowUnits: 2 });
  });
});

describe("work queue", () => {
  const now = pt("2026-10-09T10:00:00"); // today = Oct 9 in Pacific
  const f = (over: Partial<QueueFundraiser>): QueueFundraiser => ({
    id: 1,
    publicCode: "F",
    status: "setup",
    startDate: "2026-11-01",
    endDate: "2026-11-30",
    windowEnd: pt("2026-12-01T00:00:00"),
    waitingOnOrganizerSince: null,
    ...over,
  });
  const input = (over: Partial<QueueInput>): QueueInput => ({
    now,
    fundraisers: [],
    newApplications: 0,
    flagsByFundraiser: [],
    payoutsToSend: { count: 0, amountCents: 0 },
    failedWebhooks: 0,
    lastNightlyOkAt: pt("2026-10-09T03:00:00"),
    webhookSilence: false,
    ...over,
  });
  const group = (groups: ReturnType<typeof buildWorkQueue>, key: string) => groups.find((g) => g.key === key);

  test("empty groups are hidden", () => {
    expect(buildWorkQueue(input({}))).toEqual([]);
  });

  test("launching within 3 days (Pacific) or already started, but not Scheduled, is red", () => {
    const groups = buildWorkQueue(
      input({
        fundraisers: [
          f({ id: 1, publicCode: "IN-3-DAYS", startDate: "2026-10-12" }), // today + 3: included
          f({ id: 2, publicCode: "IN-4-DAYS", startDate: "2026-10-13" }), // excluded
          f({ id: 3, publicCode: "STARTED", startDate: "2026-10-01", endDate: "2026-11-15" }), // started, still Setup
          f({ id: 4, publicCode: "SCHEDULED", status: "scheduled", startDate: "2026-10-10" }), // already scheduled
          f({ id: 5, publicCode: "ENDED", startDate: "2026-09-01", endDate: "2026-10-08" }), // over
          f({ id: 6, publicCode: "APPLICATION", status: "application", startDate: "2026-10-11" }),
        ],
      }),
    );
    const launch = group(groups, "launch_soon")!;
    expect(launch.tone).toBe("critical");
    expect(launch.items.map((i) => i.label)).toEqual(["STARTED", "APPLICATION", "IN-3-DAYS"]);
    expect(launch.items[0]!.href).toBe("/app/fundraisers/3");
  });

  test("ending in the next 7 days (Pacific), active or scheduled only", () => {
    const groups = buildWorkQueue(
      input({
        fundraisers: [
          f({ id: 1, publicCode: "TODAY", status: "active", startDate: "2026-10-01", endDate: "2026-10-09" }),
          f({ id: 2, publicCode: "PLUS-7", status: "active", startDate: "2026-10-01", endDate: "2026-10-16" }),
          f({ id: 3, publicCode: "PLUS-8", status: "active", startDate: "2026-10-01", endDate: "2026-10-17" }),
          f({ id: 4, publicCode: "YESTERDAY", status: "active", startDate: "2026-10-01", endDate: "2026-10-08" }),
          f({ id: 5, publicCode: "SETUP", status: "setup", startDate: "2026-10-20", endDate: "2026-10-14" }),
        ],
      }),
    );
    expect(group(groups, "ending_soon")!.items.map((i) => i.label)).toEqual(["TODAY", "PLUS-7"]);
  });

  test("waiting on organizer more than 5 days", () => {
    const groups = buildWorkQueue(
      input({
        fundraisers: [
          f({ id: 1, publicCode: "SIX-DAYS", waitingOnOrganizerSince: pt("2026-10-03T10:00:00") }),
          f({ id: 2, publicCode: "FOUR-DAYS", waitingOnOrganizerSince: pt("2026-10-05T10:00:00") }),
          f({ id: 3, publicCode: "CANCELLED", status: "cancelled", waitingOnOrganizerSince: pt("2026-09-01T10:00:00") }),
        ],
      }),
    );
    expect(group(groups, "waiting")!.items.map((i) => i.label)).toEqual(["SIX-DAYS"]);
  });

  test("flags total and by fundraiser; settlements ready 10 days after the end; payouts to send", () => {
    const groups = buildWorkQueue(
      input({
        flagsByFundraiser: [
          { id: 7, publicCode: "NS-GSB-F26", count: 2 },
          { id: 8, publicCode: "OTHER", count: 1 },
        ],
        fundraisers: [
          f({ id: 9, publicCode: "READY", status: "settling", startDate: "2026-09-01", endDate: "2026-09-28", windowEnd: pt("2026-09-29T00:00:00") }),
          f({ id: 10, publicCode: "NOT-YET", status: "settling", startDate: "2026-09-01", endDate: "2026-09-30", windowEnd: pt("2026-10-01T00:00:00") }),
        ],
        payoutsToSend: { count: 2, amountCents: 30000 },
      }),
    );
    const flags = group(groups, "flags")!;
    expect(flags.count).toBe(3);
    expect(flags.items.map((i) => [i.label, i.href, i.detail])).toEqual([
      ["NS-GSB-F26", "/app/fundraisers/7#flags", "2 lines"],
      ["OTHER", "/app/fundraisers/8#flags", "1 line"],
    ]);
    expect(group(groups, "settlements")!.items.map((i) => i.label)).toEqual(["READY"]);
    expect(group(groups, "payouts")!.items[0]!.detail).toBe("$300.00");
  });

  test("sync problems: failed webhooks, nightly older than 26 hours, webhook silence", () => {
    expect(group(buildWorkQueue(input({ lastNightlyOkAt: pt("2026-10-08T09:00:00") })), "sync")).toBeUndefined();
    const groups = buildWorkQueue(
      input({ failedWebhooks: 2, lastNightlyOkAt: pt("2026-10-08T07:59:00"), webhookSilence: true }),
    );
    expect(group(groups, "sync")!.items.map((i) => i.label)).toEqual([
      "2 failed webhooks",
      "Nightly re-check is more than 26 hours old",
      "No webhooks in 24 hours while a fundraiser is Active",
    ]);
    expect(group(buildWorkQueue(input({ lastNightlyOkAt: null })), "sync")!.items[0]!.label).toMatch(/hasn't succeeded/);
  });
});

describe("history in plain words", () => {
  test("date change with reason", () => {
    expect(
      describeAudit({
        action: "change_dates_rate",
        actor: "Matt Weir",
        reason: "Organizer moved the kickoff",
        before: { startDate: "2026-10-01", endDate: "2026-10-31", payoutRateCents: 2500, qualifyingUnits: 7 },
        after: { startDate: "2026-10-05", endDate: "2026-10-31", payoutRateCents: 2500, qualifyingUnits: 4 },
      }),
    ).toBe("Matt Weir changed start date Oct 1 → Oct 5. Units 7 → 4. Reason: Organizer moved the kickoff");
  });

  test("status moves, the clock, and line decisions", () => {
    expect(describeAudit({ action: "status:start", actor: "clock", reason: "Start time passed", before: { status: "scheduled" }, after: { status: "active" } })).toBe(
      "The clock moved it from Scheduled to Active. Reason: Start time passed",
    );
    expect(
      describeAudit({ action: "line_decision", actor: "Matt Weir", reason: "Family discount, OK", before: {}, after: { decision: "include", orderName: "#111494", units: 1 } }),
    ).toBe("Matt Weir chose to include #111494 (1 unit). Note: Family discount, OK");
  });
});

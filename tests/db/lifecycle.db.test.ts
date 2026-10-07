// Session 2: fundraiser lifecycle against the real database. Spec cases
// 16–20 are exercised here through the same services the admin pages use.
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { normalizeOrder, type ShopifyOrderNode } from "../../app/lib/shopify-order";
import { CHECKLIST_ITEMS } from "../../app/lib/checklist";
import { saveOrder } from "../../app/services/order-sync.server";
import {
  applyDatesRateChange,
  createFundraiser,
  previewDatesRateChange,
  setChecklistItem,
  storedTotals,
  transitionFundraiser,
  UserError,
} from "../../app/services/fundraisers.server";
import { runClock, runNightlyRecheck, nightlyIsDue } from "../../app/services/jobs.server";
import type { ShopifyClient } from "../../app/services/shopify-api.server";
import { linkProduct } from "../../app/services/products.server";
import { resetDb, seedTeamAndProduct, testDb } from "../helpers/db";
import { CAPE, pt, shopifyOrderNode } from "../helpers/fixtures";

const db = testDb();
beforeEach(resetDb);
afterAll(() => db.$disconnect());

async function seed() {
  const { org, team, product } = await seedTeamAndProduct(CAPE);
  const organizer = await db.organizer.create({ data: { name: "Pat Coach", email: "pat@centralhigh.org" } });
  return { org, team, product, organizer };
}

async function newFundraiser(
  s: Awaited<ReturnType<typeof seed>>,
  startDate = "2026-10-01",
  endDate = "2026-10-31",
  extra: { publicCode?: string } = {},
) {
  return createFundraiser(
    db,
    {
      teamId: s.team.id,
      productId: s.product.id,
      seasonLabel: "Fall 2026",
      startDate,
      endDate,
      paypalPayeeEmail: "boosters@centralhigh.org",
      organizerIds: [s.organizer.id],
      primaryOrganizerId: s.organizer.id,
      ...extra,
    },
    "Matt",
  );
}

let orderSeq = 100;
async function sell(at: Date, quantity = 1) {
  const id = String(orderSeq++);
  const parsed = normalizeOrder(
    shopifyOrderNode({ id, name: `#${id}`, processedAt: at, lines: [{ id: `${id}0`, productId: CAPE, quantity }] }),
  );
  await saveOrder(db, parsed.order, parsed.lines);
}

async function completeChecklist(fundraiserId: number) {
  for (const item of CHECKLIST_ITEMS) await setChecklistItem(db, fundraiserId, item.key, true, "Matt");
}

describe("creating fundraisers", () => {
  test("defaults: Setup, $25 copied in, Pacific time, generated code, primary organizer", async () => {
    const s = await seed();
    const f = await newFundraiser(s);
    expect(f).toMatchObject({ status: "setup", payoutRateCents: 2500, timezone: "America/Los_Angeles", publicCode: "CHS-GLAX-F26" });
    expect(f.windowStart.toISOString()).toBe("2026-10-01T07:00:00.000Z");
    expect(f.windowEnd.toISOString()).toBe("2026-11-01T07:00:00.000Z");
    const links = await db.fundraiserOrganizer.findMany({ where: { fundraiserId: f.id } });
    expect(links).toEqual([expect.objectContaining({ organizerId: s.organizer.id, isPrimary: true })]);
    expect(await db.auditLog.count({ where: { entity: "fundraiser", action: "create" } })).toBe(1);

    // Next season gets its own code.
    const spring = await newFundraiser(s, "2027-03-01", "2027-03-31");
    expect(spring.publicCode).toBe("CHS-GLAX-S27");
  });

  test("an archived product or a missing organizer is refused", async () => {
    const s = await seed();
    await db.product.update({ where: { id: s.product.id }, data: { status: "ARCHIVED" } });
    await expect(newFundraiser(s)).rejects.toThrow(/archived/);
    await db.product.update({ where: { id: s.product.id }, data: { status: "ACTIVE" } });
    await expect(
      createFundraiser(db, { teamId: s.team.id, productId: s.product.id, startDate: "2026-10-01", endDate: "2026-10-31", organizerIds: [], primaryOrganizerId: null }, "Matt"),
    ).rejects.toThrow(/organizer/);
  });

  test("linking a product requires it to be active", async () => {
    const shopify = {
      fetchProduct: async () => ({ shopifyProductId: "5555", handle: "x", title: "Draft Cape", status: "DRAFT", tags: ["fundraiser"] }),
    } as unknown as ShopifyClient;
    await expect(linkProduct(db, shopify, "5555", "Matt")).rejects.toThrow(/Only active products/);
  });
});

describe("Attribution and payout test cases (spec), through the lifecycle services", () => {
  test("Case 16: a second fundraiser for Oct 15–Nov 15 is refused with a plain message", async () => {
    const s = await seed();
    await newFundraiser(s);
    const attempt = newFundraiser(s, "2026-10-15", "2026-11-15", { publicCode: "CHS-GLAX-F26B" });
    await expect(attempt).rejects.toBeInstanceOf(UserError);
    await expect(newFundraiser(s, "2026-10-15", "2026-11-15", { publicCode: "CHS-GLAX-F26B" })).rejects.toThrow(
      "These dates overlap CHS-GLAX-F26 (Oct 1, 2026 – Oct 31, 2026) on the same product.",
    );
    expect(await db.fundraiser.count()).toBe(1);
  });

  test("Case 17: the next fundraiser starting Nov 1 is allowed, and a Nov 1 12:00 AM sale counts for it only", async () => {
    const s = await seed();
    const fall = await newFundraiser(s);
    const next = await newFundraiser(s, "2026-11-01", "2026-11-30", { publicCode: "CHS-GLAX-NOV" });
    await sell(pt("2026-11-01T00:00:00"));
    expect((await storedTotals(db, fall)).qualifyingUnits).toBe(0);
    expect((await storedTotals(db, next)).qualifyingUnits).toBe(1);
  });

  test("Case 18: cancelled Oct 20 at 3:00 PM; 12 sold before, 2 after → 12 units, $300", async () => {
    const s = await seed();
    const f = await newFundraiser(s);
    for (let day = 8; day < 20; day++) await sell(pt(`2026-10-${String(day).padStart(2, "0")}T10:00:00`));
    // Before cancelling, sales after 3 PM still count (the window is open).
    await sell(pt("2026-10-20T15:00:00"));
    await sell(pt("2026-10-25T10:00:00"));
    expect((await storedTotals(db, f)).qualifyingUnits).toBe(14);

    const cancelled = await transitionFundraiser(db, f.id, "cancel", {
      reason: "School cancelled the season",
      actor: "Matt",
      now: pt("2026-10-20T15:00:00"),
    });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelledAt?.toISOString()).toBe("2026-10-20T22:00:00.000Z");
    expect(await storedTotals(db, cancelled)).toMatchObject({ qualifyingUnits: 12, estimatedPayoutCents: 30000 });

    const audit = await db.auditLog.findFirstOrThrow({ where: { entity: "fundraiser", action: "status:cancel" } });
    expect(audit).toMatchObject({ before: { status: "setup" }, reason: "School cancelled the season", actor: "Matt" });
    expect(audit.after).toMatchObject({ status: "cancelled", cancelledAt: "2026-10-20T22:00:00.000Z" });
  });

  test("Case 19: start date Oct 1 → Oct 5 after sales; preview shows before/after; saved numbers match; logged with reason", async () => {
    const s = await seed();
    const f = await newFundraiser(s);
    await sell(pt("2026-10-02T09:00:00"));
    await sell(pt("2026-10-04T23:59:59"), 2);
    await sell(pt("2026-10-05T00:00:00"));
    await sell(pt("2026-10-20T12:00:00"), 3);
    expect((await storedTotals(db, f)).qualifyingUnits).toBe(7);

    const change = { startDate: "2026-10-05", endDate: "2026-10-31", payoutRateCents: 2500 };
    const preview = await previewDatesRateChange(db, f.id, change);
    expect(preview.before).toMatchObject({ startDate: "2026-10-01", qualifyingUnits: 7, estimatedPayoutCents: 17500 });
    expect(preview.after).toMatchObject({ startDate: "2026-10-05", qualifyingUnits: 4, estimatedPayoutCents: 10000 });
    // Previewing changes nothing.
    expect((await storedTotals(db, f)).qualifyingUnits).toBe(7);

    await expect(applyDatesRateChange(db, f.id, change, "  ", "Matt")).rejects.toThrow(/reason is required/);

    const { saved } = await applyDatesRateChange(db, f.id, change, "Organizer moved the kickoff", "Matt");
    expect(saved.qualifyingUnits).toBe(preview.after.qualifyingUnits);
    expect(saved.estimatedPayoutCents).toBe(preview.after.estimatedPayoutCents);

    const updated = await db.fundraiser.findUniqueOrThrow({ where: { id: f.id } });
    expect(updated.windowStart.toISOString()).toBe("2026-10-05T07:00:00.000Z");
    const audit = await db.auditLog.findFirstOrThrow({ where: { entity: "fundraiser", action: "change_dates_rate" } });
    expect(audit).toMatchObject({ reason: "Organizer moved the kickoff", actor: "Matt" });
    expect(audit.before).toMatchObject({ startDate: "2026-10-01", qualifyingUnits: 7 });
    expect(audit.after).toMatchObject({ startDate: "2026-10-05", qualifyingUnits: 4 });

    // A rate change shows the payout change with the same units.
    const ratePreview = await previewDatesRateChange(db, f.id, { ...change, payoutRateCents: 3000 });
    expect(ratePreview.after).toMatchObject({ qualifyingUnits: 4, estimatedPayoutCents: 12000 });

    // Locked once Settling.
    await db.fundraiser.update({ where: { id: f.id }, data: { status: "settling" } });
    await expect(previewDatesRateChange(db, f.id, change)).rejects.toThrow(/can't be changed once a fundraiser is Settling/);
  });

  test("Case 19 (overlap): moving dates onto another fundraiser is refused with a plain message", async () => {
    const s = await seed();
    const fall = await newFundraiser(s);
    await newFundraiser(s, "2026-11-01", "2026-11-30", { publicCode: "CHS-GLAX-NOV" });
    await expect(
      applyDatesRateChange(db, fall.id, { startDate: "2026-10-01", endDate: "2026-11-05", payoutRateCents: 2500 }, "extend", "Matt"),
    ).rejects.toThrow(/overlap CHS-GLAX-NOV \(Nov 1, 2026 – Nov 30, 2026\)/);
  });

  test("Case 20: a paid order whose webhooks never arrived is added by the nightly re-check", async () => {
    const s = await seed();
    const f = await newFundraiser(s);
    const missed: ShopifyOrderNode = shopifyOrderNode({
      id: "777",
      name: "#777",
      processedAt: pt("2026-10-10T10:00:00"),
      lines: [{ id: "7770", productId: CAPE, quantity: 2 }],
    });
    let askedSince: Date | null = null;
    const shopify: ShopifyClient = {
      fetchOrder: async (id) => (id === "777" ? missed : null),
      fetchProduct: async () => null,
      listOrderIdsForProduct: async () => [],
      listOrderIdsUpdatedSince: async (since) => {
        askedSince = since;
        return ["777"];
      },
      searchProducts: async () => [],
    };
    expect(await db.shopifyOrder.count()).toBe(0);

    const now = new Date("2026-10-12T10:00:00Z");
    const result = await runNightlyRecheck(db, shopify, { now });
    expect(result.status).toBe("succeeded");
    expect((await storedTotals(db, f)).qualifyingUnits).toBe(2);
    // First run looks back 2 days.
    expect(askedSince!.toISOString()).toBe("2026-10-10T10:00:00.000Z");

    // The next run starts from the last successful run minus the 2-day overlap,
    // and re-checking the same order again changes nothing.
    await runNightlyRecheck(db, shopify, { now: new Date("2026-10-13T10:00:00Z") });
    const lastOk = await db.jobRun.findFirstOrThrow({ where: { name: "nightly", status: "succeeded" }, orderBy: { id: "asc" } });
    expect(askedSince!.getTime()).toBe(lastOk.startedAt.getTime() - 48 * 3600 * 1000);
    expect((await storedTotals(db, f)).qualifyingUnits).toBe(2);
    expect(await db.orderLineItem.count()).toBe(1);
  });
});

describe("nightly health check and failures", () => {
  const quietShopify: ShopifyClient = {
    fetchOrder: async () => null,
    fetchProduct: async () => null,
    listOrderIdsForProduct: async () => [],
    listOrderIdsUpdatedSince: async () => [],
    searchProducts: async () => [],
  };

  test("flags 24 hours without webhooks while a fundraiser is Active", async () => {
    const s = await seed();
    const f = await newFundraiser(s);
    const now = new Date("2026-10-12T10:00:00Z");
    await db.webhookEvent.create({ data: { webhookId: "w1", topic: "ORDERS_CREATE", shop: "s", receivedAt: new Date("2026-10-11T09:00:00Z") } });

    // Not active yet: no alarm.
    expect((await runNightlyRecheck(db, quietShopify, { now })).details?.webhookSilence).toBe(false);

    await db.fundraiser.update({ where: { id: f.id }, data: { status: "active" } });
    expect((await runNightlyRecheck(db, quietShopify, { now })).details?.webhookSilence).toBe(true);

    // A recent webhook clears it.
    await db.webhookEvent.create({ data: { webhookId: "w2", topic: "ORDERS_CREATE", shop: "s", receivedAt: new Date("2026-10-12T08:00:00Z") } });
    expect((await runNightlyRecheck(db, quietShopify, { now })).details?.webhookSilence).toBe(false);
  });

  test("a Shopify failure marks the run failed and keeps the last successful time", async () => {
    const broken: ShopifyClient = { ...quietShopify, listOrderIdsUpdatedSince: async () => { throw new Error("Shopify is down"); } };
    const result = await runNightlyRecheck(db, broken, { now: new Date("2026-10-12T10:00:00Z") });
    expect(result).toMatchObject({ status: "failed", error: "Shopify is down" });
    expect(await db.jobRun.count({ where: { name: "nightly", status: "succeeded" } })).toBe(0);
  });

  test("runs once a night, during the 3 AM Pacific hour", async () => {
    expect(await nightlyIsDue(db, pt("2026-10-12T03:05:00"))).toBe(true);
    expect(await nightlyIsDue(db, pt("2026-10-12T04:05:00"))).toBe(false);
    await runNightlyRecheck(db, quietShopify, { now: pt("2026-10-12T03:05:00") });
    expect(await nightlyIsDue(db, pt("2026-10-12T03:20:00"))).toBe(false);
  });
});

describe("status clock", () => {
  test("Scheduled → Active at the start, Active → Settling at the end, safe to repeat", async () => {
    const s = await seed();
    const f = await newFundraiser(s);
    await completeChecklist(f.id);
    await transitionFundraiser(db, f.id, "approve_launch", { actor: "Matt", now: pt("2026-09-25T10:00:00") });

    expect((await runClock(db, pt("2026-09-30T23:59:59"))).details).toEqual({ started: [], ended: [] });
    expect((await db.fundraiser.findUniqueOrThrow({ where: { id: f.id } })).status).toBe("scheduled");

    expect((await runClock(db, pt("2026-10-01T00:00:00"))).details).toEqual({ started: ["CHS-GLAX-F26"], ended: [] });
    expect((await runClock(db, pt("2026-10-01T00:15:00"))).details).toEqual({ started: [], ended: [] });
    expect((await db.fundraiser.findUniqueOrThrow({ where: { id: f.id } })).status).toBe("active");

    expect((await runClock(db, pt("2026-11-01T00:00:00"))).details).toEqual({ started: [], ended: ["CHS-GLAX-F26"] });
    expect((await runClock(db, pt("2026-11-01T00:15:00"))).details).toEqual({ started: [], ended: [] });
    expect((await db.fundraiser.findUniqueOrThrow({ where: { id: f.id } })).status).toBe("settling");

    // Exactly one audit entry per move, by the clock.
    const moves = await db.auditLog.findMany({ where: { entity: "fundraiser", actor: "clock" }, orderBy: { id: "asc" } });
    expect(moves.map((m) => m.action)).toEqual(["status:start", "status:end"]);
    expect(await db.jobRun.count({ where: { name: "clock", status: "succeeded" } })).toBe(5);
  });

  test("two clock runs at the same moment move a fundraiser once", async () => {
    const s = await seed();
    const f = await newFundraiser(s);
    await db.fundraiser.update({ where: { id: f.id }, data: { status: "scheduled" } });
    const now = pt("2026-10-01T00:05:00");
    const [a, b] = await Promise.all([runClock(db, now), runClock(db, now)]);
    expect([...(a.details!.started as string[]), ...(b.details!.started as string[])]).toEqual(["CHS-GLAX-F26"]);
    expect(await db.auditLog.count({ where: { action: "status:start" } })).toBe(1);
  });

  test("a late clock moves Scheduled straight through to Settling; Setup and Cancelled are left alone", async () => {
    const s = await seed();
    const late = await newFundraiser(s);
    await db.fundraiser.update({ where: { id: late.id }, data: { status: "scheduled" } });
    const stillSetup = await newFundraiser(s, "2026-11-01", "2026-11-05", { publicCode: "SETUP-ONLY" });
    const cancelled = await newFundraiser(s, "2026-11-10", "2026-11-12", { publicCode: "CANC" });
    await transitionFundraiser(db, cancelled.id, "cancel", { reason: "no", actor: "Matt", now: pt("2026-11-01T00:00:00") });

    const result = await runClock(db, pt("2026-12-01T00:00:00"));
    expect(result.details).toEqual({ started: ["CHS-GLAX-F26"], ended: ["CHS-GLAX-F26"] });
    const statuses = await db.fundraiser.findMany({ orderBy: { id: "asc" }, select: { status: true } });
    expect(statuses.map((x) => x.status)).toEqual(["settling", "setup", "cancelled"]);
  });

  test("attribution doesn't depend on status: a sale before the clock catches up still counts", async () => {
    const s = await seed();
    const f = await newFundraiser(s);
    await db.fundraiser.update({ where: { id: f.id }, data: { status: "scheduled" } });
    await sell(pt("2026-10-01T00:01:00"));
    expect((await storedTotals(db, f)).qualifyingUnits).toBe(1);
  });
});

describe("admin transitions and checklist", () => {
  test("approve launch is blocked until the checklist is done; every move is audited", async () => {
    const s = await seed();
    const f = await newFundraiser(s);
    await expect(transitionFundraiser(db, f.id, "approve_launch", { actor: "Matt" })).rejects.toThrow(/Launch is blocked/);

    await completeChecklist(f.id);
    const checklistAudit = await db.auditLog.count({ where: { entity: "fundraiser", action: "checklist:done" } });
    expect(checklistAudit).toBe(6);
    const row = await db.fundraiser.findUniqueOrThrow({ where: { id: f.id } });
    expect(row.artworkApprovedBy).toBe("Matt");
    expect(row.artworkApprovedAt).not.toBeNull();

    // The product must be active at launch time, not just when the box was ticked.
    await db.product.update({ where: { id: s.product.id }, data: { status: "DRAFT" } });
    await expect(transitionFundraiser(db, f.id, "approve_launch", { actor: "Matt" })).rejects.toThrow(/must be active/);
    await db.product.update({ where: { id: s.product.id }, data: { status: "ACTIVE" } });

    const scheduled = await transitionFundraiser(db, f.id, "approve_launch", { actor: "Matt", now: pt("2026-09-20T10:00:00") });
    expect(scheduled.status).toBe("scheduled");

    await expect(
      transitionFundraiser(db, f.id, "back_to_setup", { reason: "Artwork redo", actor: "Matt", now: pt("2026-10-02T10:00:00") }),
    ).rejects.toThrow(/only allowed before the start date/);
    const back = await transitionFundraiser(db, f.id, "back_to_setup", { reason: "Artwork redo", actor: "Matt", now: pt("2026-09-21T10:00:00") });
    expect(back.status).toBe("setup");

    const moves = await db.auditLog.findMany({ where: { action: { startsWith: "status:" } }, orderBy: { id: "asc" } });
    expect(moves.map((m) => [m.action, m.before, m.after, m.reason])).toEqual([
      ["status:approve_launch", { status: "setup" }, { status: "scheduled" }, null],
      ["status:back_to_setup", { status: "scheduled" }, { status: "setup" }, "Artwork redo"],
    ]);
  });

  test("checklist items with real-world checks", async () => {
    const s = await seed();
    const f = await newFundraiser(s);
    await db.product.update({ where: { id: s.product.id }, data: { tags: [] } });
    await expect(setChecklistItem(db, f.id, "productReady", true, "Matt")).rejects.toThrow(/fundraiser" tag/);
    await db.fundraiser.update({ where: { id: f.id }, data: { paypalPayeeEmail: null } });
    await expect(setChecklistItem(db, f.id, "organizerInfoReceived", true, "Matt")).rejects.toThrow(/PayPal/);
    // Unticking clears who and when.
    await setChecklistItem(db, f.id, "artworkApproved", true, "Matt");
    await setChecklistItem(db, f.id, "artworkApproved", false, "Matt");
    const row = await db.fundraiser.findUniqueOrThrow({ where: { id: f.id } });
    expect([row.artworkApprovedAt, row.artworkApprovedBy]).toEqual([null, null]);
  });

  test("decline needs a reason and frees the dates", async () => {
    const s = await seed();
    const f = await newFundraiser(s);
    await expect(transitionFundraiser(db, f.id, "decline", { actor: "Matt" })).rejects.toThrow(/reason is required/);
    await transitionFundraiser(db, f.id, "decline", { reason: "Duplicate request", actor: "Matt" });
    // A declined fundraiser holds no dates.
    await newFundraiser(s, "2026-10-01", "2026-10-31", { publicCode: "CHS-GLAX-F26B" });
  });
});

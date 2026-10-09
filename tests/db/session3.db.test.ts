// Session 3: flag decisions, assets and the Home dashboard against the database.
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { normalizeOrder } from "../../app/lib/shopify-order";
import { saveOrder } from "../../app/services/order-sync.server";
import { createFundraiser, storedTotals } from "../../app/services/fundraisers.server";
import { decideLine } from "../../app/services/line-decisions.server";
import { addAsset, organizerVisibleAssets, replaceAsset } from "../../app/services/assets.server";
import { loadNumberStrip, loadWorkQueue } from "../../app/services/dashboard.server";
import { resetDb, seedTeamAndProduct, testDb } from "../helpers/db";
import { CAPE, pt, shopifyOrderNode } from "../helpers/fixtures";

const db = testDb();
beforeEach(resetDb);
afterAll(() => db.$disconnect());

async function seedFundraiser(startDate = "2026-10-01", endDate = "2026-10-31") {
  const { team, product } = await seedTeamAndProduct(CAPE);
  const organizer = await db.organizer.create({ data: { name: "Pat", email: "pat@example.org" } });
  return createFundraiser(
    db,
    { teamId: team.id, productId: product.id, startDate, endDate, paypalPayeeEmail: "club@example.org", organizerIds: [organizer.id], primaryOrganizerId: organizer.id },
    "Matt",
  );
}

let seq = 500;
async function sell(at: Date, opts: { quantity?: number; orderDiscount?: string; test?: boolean; name?: string } = {}) {
  const id = String(seq++);
  const parsed = normalizeOrder(
    shopifyOrderNode({
      id,
      name: opts.name ?? `#${id}`,
      processedAt: at,
      test: opts.test,
      lines: [{ id: `${id}0`, productId: CAPE, quantity: opts.quantity ?? 1, orderDiscount: opts.orderDiscount }],
    }),
  );
  await saveOrder(db, parsed.order, parsed.lines);
  return db.orderLineItem.findFirstOrThrow({ where: { shopifyLineItemId: `${id}0` } });
}

describe("Case 11 (include/exclude half): flag decisions", () => {
  test("bulk line: exclude removes its units, include keeps them, each change is audited", async () => {
    const f = await seedFundraiser();
    await sell(pt("2026-10-05T10:00:00"));
    const bulk = await sell(pt("2026-10-06T10:00:00"), { quantity: 5, name: "#BULK" });
    expect(bulk.reviewFlags).toEqual(["bulk_order"]);
    expect(await storedTotals(db, f)).toMatchObject({ qualifyingUnits: 6, estimatedPayoutCents: 15000, unresolvedFlaggedLines: 1 });

    await expect(decideLine(db, bulk.id, "exclude", "  ", "Matt")).rejects.toThrow(/note is required/);

    const excluded = await decideLine(db, bulk.id, "exclude", "Coach order, not a fundraiser sale", "Matt");
    expect(excluded).toMatchObject({ qualifyingUnits: 1, estimatedPayoutCents: 2500, unresolvedFlaggedLines: 0, excludedLines: 1 });
    expect(await db.orderLineItem.findUniqueOrThrow({ where: { id: bulk.id } })).toMatchObject({
      outcome: "excluded",
      qualifyingUnits: 0,
      adminDecision: "exclude",
      adminDecisionNote: "Coach order, not a fundraiser sale",
      adminDecisionBy: "Matt",
    });

    // Changed my mind: include it, with a new note.
    const included = await decideLine(db, bulk.id, "include", "Confirmed 5 families ordered together", "Matt");
    expect(included).toMatchObject({ qualifyingUnits: 6, estimatedPayoutCents: 15000, unresolvedFlaggedLines: 0 });

    const history = await db.auditLog.findMany({ where: { entity: "fundraiser", action: "line_decision" }, orderBy: { id: "asc" } });
    expect(history.map((h) => [h.reason, (h.after as { decision: string }).decision])).toEqual([
      ["Coach order, not a fundraiser sale", "exclude"],
      ["Confirmed 5 families ordered together", "include"],
    ]);
    expect(history[1]!.before).toMatchObject({ decision: "exclude", note: "Coach order, not a fundraiser sale" });
  });

  test("a whole-order discount code on a window sale is flagged and can be excluded", async () => {
    const f = await seedFundraiser();
    const line = await sell(pt("2026-10-02T06:44:00"), { quantity: 2, orderDiscount: "39.00", name: "#111494" });
    expect(line).toMatchObject({ discountCents: 3900, reviewFlags: ["discount"], qualifyingUnits: 2 });
    expect((await decideLine(db, line.id, "exclude", "Welcome code leak", "Matt")).qualifyingUnits).toBe(0);
    expect((await storedTotals(db, f)).revenueCents).toBe(0);
  });

  test("only flagged fundraiser lines take decisions, and decisions lock once the payout is frozen", async () => {
    const f = await seedFundraiser();
    const plain = await sell(pt("2026-10-05T10:00:00"));
    await expect(decideLine(db, plain.id, "exclude", "x", "Matt")).rejects.toThrow(/Only flagged lines/);
    const outside = await sell(pt("2026-11-05T10:00:00"), { quantity: 5 });
    await expect(decideLine(db, outside.id, "exclude", "x", "Matt")).rejects.toThrow(/isn't part of a fundraiser/);

    const bulk = await sell(pt("2026-10-06T10:00:00"), { quantity: 5 });
    await db.fundraiser.update({ where: { id: f.id }, data: { status: "paid" } });
    await expect(decideLine(db, bulk.id, "exclude", "x", "Matt")).rejects.toThrow(/paid/);
    await db.fundraiser.update({ where: { id: f.id }, data: { status: "payout_pending" } });
    await db.payout.create({ data: { fundraiserId: f.id, rateCents: 2500, qualifyingUnits: 6, amountCents: 15000, status: "approved" } });
    await expect(decideLine(db, bulk.id, "exclude", "x", "Matt")).rejects.toThrow(/frozen/);
  });
});

describe("assets", () => {
  test("add, replace, and what organizers may see", async () => {
    const f = await seedFundraiser();
    await expect(addAsset(db, f.id, { title: "Flyer", kind: "flyer", url: "drive link", visibility: "organizer" }, "Matt")).rejects.toThrow(/full link/);

    const flyer = await addAsset(db, f.id, { title: "Flyer v1", kind: "flyer", url: "https://drive.google.com/file/d/abc/view", visibility: "organizer" }, "Matt");
    await addAsset(db, f.id, { title: "Internal notes", kind: "other", url: "https://drive.google.com/x", visibility: "internal" }, "Matt");
    const v2 = await replaceAsset(db, flyer.id, { title: "Flyer v2", kind: "flyer", url: "https://drive.google.com/file/d/def/view", visibility: "organizer" }, "Matt");

    expect(await db.asset.findUniqueOrThrow({ where: { id: flyer.id } })).toMatchObject({ isCurrent: false, replacedById: v2.id });
    expect((await organizerVisibleAssets(db, f.id)).map((a) => a.title)).toEqual(["Flyer v2"]);
    await expect(replaceAsset(db, flyer.id, { title: "v3", kind: "flyer", url: "https://x.example", visibility: "organizer" }, "Matt")).rejects.toThrow(/already replaced/);
    expect(await db.auditLog.count({ where: { action: { startsWith: "asset:" } } })).toBe(3);
  });
});

describe("Home dashboard", () => {
  test("number strip: counts, month/year in Pacific, outside-window units, live-store test orders left out", async () => {
    const f = await seedFundraiser("2026-09-15", "2026-10-31");
    await db.fundraiser.update({ where: { id: f.id }, data: { status: "active" } });
    await sell(pt("2026-09-30T23:30:00")); // September (Pacific)
    await sell(pt("2026-10-02T10:00:00"), { quantity: 2 });
    await sell(pt("2026-10-03T10:00:00"), { test: true, quantity: 3 }); // live store: ignored
    await sell(pt("2026-11-05T10:00:00")); // after the window: outside-window sale

    const strip = await loadNumberStrip(db, pt("2026-11-06T10:00:00"));
    expect(strip).toMatchObject({
      active: 1,
      scheduled: 0,
      settling: 0,
      payoutsOutstandingCents: 0,
      month: { units: 0, estimatedPayoutCents: 0 }, // November: nothing qualifying yet
      year: { units: 3, estimatedPayoutCents: 7500 },
      outsideWindowUnits30d: 1,
    });
    expect((await loadNumberStrip(db, pt("2026-10-09T10:00:00"))).month).toEqual({ units: 2, estimatedPayoutCents: 5000 });
  });

  test("work queue from the database: started-but-not-launched, flags, sync", async () => {
    const f = await seedFundraiser("2026-10-01", "2026-11-15");
    await sell(pt("2026-10-02T10:00:00"), { orderDiscount: "19.50" });
    const queue = await loadWorkQueue(db, pt("2026-10-09T10:00:00"));
    const byKey = Object.fromEntries(queue.map((g) => [g.key, g]));
    expect(byKey.launch_soon!.items.map((i) => i.href)).toEqual([`/app/fundraisers/${f.id}`]);
    expect(byKey.flags!.count).toBe(1);
    expect(byKey.sync!.items[0]!.label).toMatch(/hasn't succeeded/);
  });
});

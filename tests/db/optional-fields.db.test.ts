// Session 6: product and dates are optional while a fundraiser is in Setup
// (one created from an application has neither yet). Launch requires both,
// and a fundraiser without them never claims a sale.
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { CHECKLIST_ITEMS } from "../../app/lib/checklist";
import { normalizeOrder } from "../../app/lib/shopify-order";
import {
  applyDatesRateChange,
  createFundraiser,
  launchBlockersFor,
  setChecklistItem,
  setFundraiserProduct,
  storedTotals,
  transitionFundraiser,
} from "../../app/services/fundraisers.server";
import { saveOrder } from "../../app/services/order-sync.server";
import { portalView } from "../../app/services/portal.server";
import { loadPayoutView } from "../../app/services/payout-view.server";
import { hasLaunchFields, MissingLaunchFieldsError } from "../../app/lib/launched";
import { resetDb, seedTeamAndProduct, testDb } from "../helpers/db";
import { CAPE, pt, shopifyOrderNode } from "../helpers/fixtures";

const db = testDb();
beforeEach(resetDb);
afterAll(() => db.$disconnect());

async function seed() {
  const { team, product } = await seedTeamAndProduct(CAPE);
  const organizer = await db.organizer.create({ data: { name: "Pat Coach", email: "pat@centralhigh.org" } });
  return { team, product, organizer };
}

async function bare(s: Awaited<ReturnType<typeof seed>>) {
  return createFundraiser(db, { teamId: s.team.id, organizerIds: [s.organizer.id], primaryOrganizerId: s.organizer.id, notes: "Timing: Fall 2026" }, "Matt");
}

async function sell(id: string, at: Date) {
  const parsed = normalizeOrder(shopifyOrderNode({ id, name: `#${id}`, processedAt: at, lines: [{ id: `${id}0`, productId: CAPE, quantity: 1 }] }));
  await saveOrder(db, parsed.order, parsed.lines);
}

describe("fundraiser without product or dates (Setup)", () => {
  test("can be created in Setup with no product and no dates", async () => {
    const s = await seed();
    const f = await bare(s);
    expect(f).toMatchObject({ status: "setup", productId: null, startDate: null, endDate: null, windowStart: null, windowEnd: null, notes: "Timing: Fall 2026" });
    expect(f.publicCode).toMatch(/^CHS-GLAX-/);
  });

  test("one date without the other is refused", async () => {
    const s = await seed();
    await expect(
      createFundraiser(db, { teamId: s.team.id, startDate: "2026-10-01", organizerIds: [s.organizer.id], primaryOrganizerId: s.organizer.id }, "Matt"),
    ).rejects.toThrow(/both the start and end dates/);
  });

  test("launch is blocked until the product and dates are set", async () => {
    const s = await seed();
    const f = await bare(s);
    const blockers = await launchBlockersFor(db, f.id);
    expect(blockers).toContain("No product is linked yet.");
    expect(blockers).toContain("Start and end dates aren't set.");
    await expect(transitionFundraiser(db, f.id, "approve_launch", { actor: "Matt" })).rejects.toThrow(/Launch is blocked/);
  });

  test("never claims a sale, even one on the product it later links", async () => {
    const s = await seed();
    const f = await bare(s);
    await sell("9001", pt("2026-10-05T10:00"));
    expect((await storedTotals(db, f)).qualifyingUnits).toBe(0);
    const line = await db.orderLineItem.findFirstOrThrow();
    expect(line.attributedFundraiserId).toBeNull();
  });

  test("set product, then first dates (no reason needed): sales are claimed, audited", async () => {
    const s = await seed();
    const f = await bare(s);
    await sell("9002", pt("2026-10-05T10:00"));
    await setFundraiserProduct(db, f.id, s.product.id, "Matt");
    expect((await storedTotals(db, f)).qualifyingUnits).toBe(0); // no window yet
    const { saved } = await applyDatesRateChange(db, f.id, { startDate: "2026-10-01", endDate: "2026-10-31", payoutRateCents: 2500 }, "", "Matt");
    expect(saved.qualifyingUnits).toBe(1);
    const actions = (await db.auditLog.findMany({ where: { entity: "fundraiser", entityId: String(f.id) } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["create", "set_product", "set_dates_rate"]));
    // Changing dates that already exist still needs a reason.
    await expect(applyDatesRateChange(db, f.id, { startDate: "2026-10-02", endDate: "2026-10-31", payoutRateCents: 2500 }, "", "Matt")).rejects.toThrow(/reason is required/);
  });

  test("dates first, product later (production bug Oct 16): the page must not load the payout section yet", async () => {
    const s = await seed();
    const f = await bare(s);
    await applyDatesRateChange(db, f.id, { startDate: "2026-10-19", endDate: "2026-11-30", payoutRateCents: 2500 }, "", "Matt");
    const page = await db.fundraiser.findUniqueOrThrow({ where: { id: f.id }, include: { product: true } });
    expect(page).toMatchObject({ productId: null, startDate: new Date("2026-10-19T00:00:00Z") });
    // The fundraiser page shows the payout section only when this is true...
    expect(hasLaunchFields(page)).toBe(false);
    // ...because the (frozen) payout code refuses a fundraiser without a product.
    await expect(loadPayoutView(db, f.id, null)).rejects.toThrow(MissingLaunchFieldsError);
    // Linking the product afterwards makes it whole.
    await setFundraiserProduct(db, f.id, s.product.id, "Matt");
    expect(hasLaunchFields(await db.fundraiser.findUniqueOrThrow({ where: { id: f.id }, include: { product: true } }))).toBe(true);
    expect((await loadPayoutView(db, f.id, null)).payout).toBeNull();
  });

  test("with product and dates set and the checklist done, it launches like any other", async () => {
    const s = await seed();
    const f = await bare(s);
    await setFundraiserProduct(db, f.id, s.product.id, "Matt");
    await applyDatesRateChange(db, f.id, { startDate: "2030-10-01", endDate: "2030-10-31", payoutRateCents: 2500 }, "", "Matt");
    await db.fundraiser.update({ where: { id: f.id }, data: { paypalPayeeEmail: "boosters@centralhigh.org" } });
    for (const item of CHECKLIST_ITEMS) await setChecklistItem(db, f.id, item.key, true, "Matt");
    expect(await launchBlockersFor(db, f.id)).toEqual([]);
    expect((await transitionFundraiser(db, f.id, "approve_launch", { actor: "Matt" })).status).toBe("scheduled");
  });

  test("overlap rule still applies once dates are set; undated fundraisers never overlap", async () => {
    const s = await seed();
    const a = await bare(s);
    const b = await bare(s);
    await setFundraiserProduct(db, a.id, s.product.id, "Matt");
    await setFundraiserProduct(db, b.id, s.product.id, "Matt"); // both undated on one product: fine
    await applyDatesRateChange(db, a.id, { startDate: "2026-10-01", endDate: "2026-10-31", payoutRateCents: 2500 }, "", "Matt");
    await expect(
      applyDatesRateChange(db, b.id, { startDate: "2026-10-15", endDate: "2026-11-15", payoutRateCents: 2500 }, "", "Matt"),
    ).rejects.toThrow(/overlap/);
  });

  test("ticking Product ready needs a product; cancel is refused (use Decline)", async () => {
    const s = await seed();
    const f = await bare(s);
    await expect(setChecklistItem(db, f.id, "productReady", true, "Matt")).rejects.toThrow(/Choose the product first/);
    await expect(transitionFundraiser(db, f.id, "cancel", { actor: "Matt", reason: "No longer needed" })).rejects.toThrow(/Use Decline/);
    expect((await transitionFundraiser(db, f.id, "decline", { actor: "Matt", reason: "No longer needed" })).status).toBe("declined");
  });

  test("the database refuses half-set dates", async () => {
    const s = await seed();
    const f = await bare(s);
    await expect(db.fundraiser.update({ where: { id: f.id }, data: { startDate: new Date("2026-10-01T00:00:00Z") } })).rejects.toThrow(/fundraisers_dates_together/);
  });

  test("portal shows it without dates or numbers", async () => {
    const s = await seed();
    const f = await bare(s);
    const view = await portalView(db, f.id, s.organizer.id);
    expect(view).toMatchObject({ startDate: "To be set", endDate: "To be set", units: 0, shortLink: null });
  });
});

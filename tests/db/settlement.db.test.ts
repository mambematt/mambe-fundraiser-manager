// Session 5: settlement and payouts, against the real database. Spec cases
// 11 (second half), 20 (second half), 21 and 22, plus the owner decisions:
// Mambe pays PayPal fees, approved payouts can be reopened, and the first 3
// payouts need a Shopify cross-check.
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import type { ShopifyOrderNode } from "../../app/lib/shopify-order";
import { normalizeOrder } from "../../app/lib/shopify-order";
import { accountantCsv, paypalPayoutsCsv, paypalTotalCents } from "../../app/lib/payout-files";
import { saveOrder } from "../../app/services/order-sync.server";
import { createFundraiser } from "../../app/services/fundraisers.server";
import { decideLine } from "../../app/services/line-decisions.server";
import { runClock } from "../../app/services/jobs.server";
import type { KlaviyoClient, MetricName } from "../../app/services/klaviyo.server";
import { setEmailsEnabled } from "../../app/services/communications.server";
import { loadNumberStrip, loadWorkQueue } from "../../app/services/dashboard.server";
import { crosscheckData } from "../../app/services/crosscheck.server";
import {
  addAdjustment,
  approvePayout,
  confirmIndividualPayee,
  dryRunSettlement,
  payoutSummary,
  recordCrossCheck,
  recordPayment,
  reopenPayout,
  settleDue,
  settlementDueAt,
} from "../../app/services/settlement.server";
import { portalView } from "../../app/services/portal.server";
import { resetDb, seedTeamAndProduct, testDb } from "../helpers/db";
import { fakeShopify } from "../helpers/fake-shopify";
import { CAPE, pt, shopifyOrderNode } from "../helpers/fixtures";

const db = testDb();
beforeEach(resetDb);
afterAll(() => db.$disconnect());

const AFTER_SETTLEMENT = pt("2026-11-11T00:05:00"); // Oct 31 end → due Nov 11 00:00 Pacific

/** A Shopify that knows a set of orders and can be told to fail. */
function shopifyWith(orders: Map<string, ShopifyOrderNode>, state = { down: false }) {
  return fakeShopify({
    fetchOrder: async (id) => {
      if (state.down) throw new Error("Shopify is down");
      return orders.get(id) ?? null;
    },
    listOrderIdsForProductSince: async () => {
      if (state.down) throw new Error("Shopify is down");
      return [...orders.keys()];
    },
  });
}

let seq = 1000;
function order(at: Date, quantity = 1, extra: Partial<Parameters<typeof shopifyOrderNode>[0]> = {}) {
  const id = String(seq++);
  return shopifyOrderNode({ id, name: `#${id}`, processedAt: at, lines: [{ id: `${id}0`, productId: CAPE, quantity }], ...extra });
}

async function save(node: ShopifyOrderNode) {
  const parsed = normalizeOrder(node);
  await saveOrder(db, parsed.order, parsed.lines);
}

async function seed(payee = "boosters@centralhigh.org") {
  const { team, product } = await seedTeamAndProduct(CAPE);
  const organizer = await db.organizer.create({ data: { name: "Pat Coach", email: "pat@example.org" } });
  const f = await createFundraiser(
    db,
    { teamId: team.id, productId: product.id, startDate: "2026-10-01", endDate: "2026-10-31", paypalPayeeEmail: payee, organizerIds: [organizer.id], primaryOrganizerId: organizer.id },
    "Matt",
  );
  await db.fundraiser.update({ where: { id: f.id }, data: { status: "settling" } });
  return { f, organizer, product };
}

function klaviyoSpy() {
  const events: Array<{ metric: MetricName; properties: Record<string, unknown> }> = [];
  const client: KlaviyoClient = { sendEvent: async (metric, to, properties) => (events.push({ metric, properties }), { deliveredTo: to.email }) };
  return { client, events };
}

async function settledDraft(units = 3) {
  const s = await seed();
  const orders = new Map<string, ShopifyOrderNode>();
  for (let i = 0; i < units; i++) {
    const o = order(pt(`2026-10-${String(5 + i).padStart(2, "0")}T10:00:00`));
    orders.set(o.id.split("/").pop()!, o);
    await save(o);
  }
  const shopify = shopifyWith(orders);
  await settleDue(db, shopify, AFTER_SETTLEMENT);
  const payout = await db.payout.findUniqueOrThrow({ where: { fundraiserId: s.f.id } });
  return { ...s, payout, orders, shopify };
}

async function crosscheckAndApprove(payoutId: number) {
  const summary = await payoutSummary(db, payoutId);
  await recordCrossCheck(db, payoutId, summary.units, "", "Matt");
  return approvePayout(db, payoutId, "Matt");
}

describe("settlement timing", () => {
  test("window end + 10 days in Pacific, across daylight saving; cancelled from cancelled_at", () => {
    const base = { timezone: "America/Los_Angeles", cancelledAt: null };
    // Oct 31 end: window closes Nov 1 00:00 PDT; settles Nov 11 00:00 PST (08:00 UTC).
    expect(settlementDueAt({ ...base, windowEnd: pt("2026-11-01T00:00:00") }).toISOString()).toBe("2026-11-11T08:00:00.000Z");
    // NS-GSB-F26: Nov 15 end → Nov 26 00:00 PST.
    expect(settlementDueAt({ ...base, windowEnd: pt("2026-11-16T00:00:00") }).toISOString()).toBe("2026-11-26T08:00:00.000Z");
    expect(
      settlementDueAt({ windowEnd: pt("2026-11-01T00:00:00"), cancelledAt: pt("2026-10-20T15:00:00"), timezone: "America/Los_Angeles" }).toISOString(),
    ).toBe("2026-10-30T22:00:00.000Z");
  });

  test("not before it's due; once due, one draft and Payout pending, even when run twice", async () => {
    const { f } = await seed();
    await save(order(pt("2026-10-05T10:00:00"), 2));
    const shopify = shopifyWith(new Map());
    expect(await settleDue(db, shopify, pt("2026-11-10T23:59:00"))).toEqual({ settled: [], failed: [] });
    expect(await db.payout.count()).toBe(0);

    await settleDue(db, shopify, AFTER_SETTLEMENT);
    await settleDue(db, shopify, AFTER_SETTLEMENT);
    await runClock(db, pt("2026-11-11T00:20:00"), { shopify });
    expect(await db.payout.count()).toBe(1);
    expect(await db.payout.findFirstOrThrow()).toMatchObject({ status: "draft", qualifyingUnits: 2, amountCents: 5000, payeeEmail: "boosters@centralhigh.org" });
    expect((await db.fundraiser.findUniqueOrThrow({ where: { id: f.id } })).status).toBe("payout_pending");
  });

  test("a cancelled fundraiser settles from its cancellation and stays Cancelled", async () => {
    const { f } = await seed();
    await save(order(pt("2026-10-05T10:00:00")));
    await db.fundraiser.update({ where: { id: f.id }, data: { status: "cancelled", cancelledAt: pt("2026-10-20T15:00:00") } });
    const shopify = shopifyWith(new Map());
    await settleDue(db, shopify, pt("2026-10-30T14:00:00"));
    expect(await db.payout.count()).toBe(0);
    await settleDue(db, shopify, pt("2026-10-30T15:05:00"));
    expect(await db.payout.findFirstOrThrow()).toMatchObject({ qualifyingUnits: 1, status: "draft" });
    expect((await db.fundraiser.findUniqueOrThrow({ where: { id: f.id } })).status).toBe("cancelled");
  });
});

describe("Attribution and payout test cases (spec): settlement", () => {
  test("Case 20 (second half): an order whose webhooks never arrived is found by the settlement re-pull and counted", async () => {
    const { f } = await seed();
    await save(order(pt("2026-10-05T10:00:00")));
    const missed = order(pt("2026-10-20T10:00:00"), 2); // never delivered
    const orders = new Map([[missed.id.split("/").pop()!, missed]]);
    await settleDue(db, shopifyWith(orders), AFTER_SETTLEMENT);
    const payout = await db.payout.findUniqueOrThrow({ where: { fundraiserId: f.id } });
    expect(payout).toMatchObject({ qualifyingUnits: 3, amountCents: 7500 });
    expect((await db.fundraiser.findUniqueOrThrow({ where: { id: f.id } })).settlementRepullOrders).toBeGreaterThanOrEqual(2);
  });

  test("Case 21: a failed re-pull keeps it in Settling, flagged, with no payout; a later run succeeds", async () => {
    const { f } = await seed();
    await save(order(pt("2026-10-05T10:00:00")));
    const state = { down: true };
    const shopify = shopifyWith(new Map(), state);

    const run = await runClock(db, AFTER_SETTLEMENT, { shopify });
    expect(run.details?.settlement).toEqual({ settled: [], failed: ["CHS-GLAX-F26"] });
    const stuck = await db.fundraiser.findUniqueOrThrow({ where: { id: f.id } });
    expect(stuck).toMatchObject({ status: "settling", settlementRepulledAt: null });
    expect(stuck.settlementError).toMatch(/^Re-pull failed: Shopify is down/);
    expect(await db.payout.count()).toBe(0);
    const queue = await loadWorkQueue(db, AFTER_SETTLEMENT);
    expect(queue.find((g) => g.key === "repull_failed")?.items.map((i) => i.label)).toEqual(["CHS-GLAX-F26"]);

    state.down = false;
    await runClock(db, pt("2026-11-11T00:20:00"), { shopify });
    const ok = await db.fundraiser.findUniqueOrThrow({ where: { id: f.id } });
    expect(ok).toMatchObject({ status: "payout_pending", settlementError: null });
    expect(await db.payout.count()).toBe(1);
  });

  test("Case 11 (second half): approval is blocked until every flag in the window is resolved", async () => {
    const { f } = await seed();
    await save(order(pt("2026-10-05T10:00:00"), 5)); // bulk: flagged
    await settleDue(db, shopifyWith(new Map()), AFTER_SETTLEMENT);
    const payout = await db.payout.findUniqueOrThrow({ where: { fundraiserId: f.id } });
    await recordCrossCheck(db, payout.id, 5, "", "Matt");
    await expect(approvePayout(db, payout.id, "Matt")).rejects.toThrow(/Resolve 1 flagged line: #\d+/);

    const line = await db.orderLineItem.findFirstOrThrow({ where: { attributedFundraiserId: f.id } });
    await decideLine(db, line.id, "exclude", "Coach order", "Matt");
    // The cross-check was for 5 units; the payout is now 0, so it must be redone.
    await expect(approvePayout(db, payout.id, "Matt")).rejects.toThrow(/cross-check was for 5 units; the payout is now 0/);
    await recordCrossCheck(db, payout.id, 0, "", "Matt");
    const approved = await approvePayout(db, payout.id, "Matt");
    expect(approved).toMatchObject({ units: 0, finalCents: 0 });

    // Include instead: $125.
    await reopenPayout(db, payout.id, "Changed decision", "Matt");
    await decideLine(db, line.id, "include", "Five families ordered together", "Matt");
    await recordCrossCheck(db, payout.id, 5, "", "Matt");
    expect(await approvePayout(db, payout.id, "Matt")).toMatchObject({ units: 5, finalCents: 12500 });
  });

  test("Case 22: a refund after Paid leaves the paid amount unchanged, shows in History and once in the work queue", async () => {
    const { f, payout, orders } = await settledDraft(3);
    await crosscheckAndApprove(payout.id);
    await recordPayment(db, null, payout.id, { paidOn: "2026-11-25", method: "PayPal", reference: "PP-123", amountCents: 7500, note: "" }, "Matt");

    // Dec 1: one of the paid orders is refunded.
    const [firstId, first] = [...orders.entries()][0]!;
    const refunded = shopifyOrderNode({
      id: firstId,
      name: `#${firstId}`,
      processedAt: pt("2026-10-05T10:00:00"),
      updatedAt: pt("2026-12-01T10:00:00"),
      financialStatus: "REFUNDED",
      refunds: [{ amount: "195.00", lines: [{ lineId: `${firstId}0`, quantity: 1 }] }],
      lines: [{ id: `${firstId}0`, productId: CAPE, quantity: 1, currentQuantity: 0 }],
    });
    expect(first).toBeDefined();
    await save(refunded);

    const paid = await db.payout.findUniqueOrThrow({ where: { id: payout.id } });
    expect(paid).toMatchObject({ status: "paid", finalCents: 7500, paidAmountCents: 7500, qualifyingUnits: 3 });
    expect((await payoutSummary(db, payout.id)).finalCents).toBe(7500);
    const history = await db.auditLog.findFirstOrThrow({ where: { action: "payout:refund_after_payout" } });
    expect(history.after).toMatchObject({ orderName: `#${firstId}`, units: 1, amountCents: 2500 });
    const queue = await loadWorkQueue(db, pt("2026-12-01T12:00:00"));
    expect(queue.find((g) => g.key === "refund_after_payout")?.items[0]?.label).toBe("CHS-GLAX-F26");

    // Saving the same refund again doesn't add a second record.
    await save(refunded);
    expect(await db.payoutChange.count()).toBe(1);
    expect((await db.fundraiser.findUniqueOrThrow({ where: { id: f.id } })).status).toBe("paid");
  });
});

describe("draft payout", () => {
  test("stays live until approval: a refund during Payout pending changes the draft", async () => {
    const { payout, orders } = await settledDraft(3);
    const [id] = [...orders.keys()];
    await save(
      shopifyOrderNode({
        id,
        name: `#${id}`,
        processedAt: pt("2026-10-05T10:00:00"),
        updatedAt: pt("2026-11-12T10:00:00"),
        financialStatus: "REFUNDED",
        refunds: [{ amount: "195.00", lines: [{ lineId: `${id}0`, quantity: 1 }] }],
        lines: [{ id: `${id}0`, productId: CAPE, quantity: 1, currentQuantity: 0 }],
      }),
    );
    expect(await payoutSummary(db, payout.id)).toMatchObject({ units: 2, amountCents: 5000, finalCents: 5000 });
  });

  test("adjustments need amount, reason, date and note; they change the final amount; locked after approval", async () => {
    const { payout } = await settledDraft(3);
    const base = { amountCents: 2500, reason: "Coach order counted by mistake", effectiveDate: "2026-11-12", adminNote: "Agreed with organizer" };
    await expect(addAdjustment(db, payout.id, { ...base, amountCents: null }, "Matt")).rejects.toThrow(/amount/);
    await expect(addAdjustment(db, payout.id, { ...base, reason: " " }, "Matt")).rejects.toThrow(/reason/);
    await expect(addAdjustment(db, payout.id, { ...base, adminNote: "" }, "Matt")).rejects.toThrow(/note/);
    await expect(addAdjustment(db, payout.id, { ...base, effectiveDate: "" }, "Matt")).rejects.toThrow(/date/);
    await addAdjustment(db, payout.id, { ...base, amountCents: -2500 }, "Matt");
    expect(await payoutSummary(db, payout.id)).toMatchObject({ amountCents: 7500, adjustmentsCents: -2500, finalCents: 5000 });
    expect(await db.auditLog.count({ where: { action: "payout:adjustment" } })).toBe(1);

    await crosscheckAndApprove(payout.id);
    await expect(addAdjustment(db, payout.id, base, "Matt")).rejects.toThrow(/only possible while the payout is a draft/);
  });

  test("cross-check: required for the first 3 payouts, a different count needs a note, not required for the 4th", async () => {
    const { payout } = await settledDraft(2);
    await expect(approvePayout(db, payout.id, "Matt")).rejects.toThrow(/Do the Shopify cross-check/);
    await expect(recordCrossCheck(db, payout.id, 3, "", "Matt")).rejects.toThrow(/Shopify shows 3 and the app 2; a note/);
    await recordCrossCheck(db, payout.id, 3, "Order #x was a test order in Shopify's report", "Matt");
    await approvePayout(db, payout.id, "Matt");

    // Three earlier approved/paid payouts: the next one may skip it.
    for (const code of ["A", "B"]) {
      const f = await db.fundraiser.create({
        data: { publicCode: code, teamId: (await db.team.findFirstOrThrow()).id, productId: (await db.product.create({ data: { shopifyProductId: `9${code.charCodeAt(0)}`, handle: code, title: code, status: "ACTIVE" } })).id, startDate: new Date("2026-01-01"), endDate: new Date("2026-01-02"), windowStart: new Date("2026-01-01T08:00:00Z"), windowEnd: new Date("2026-01-03T08:00:00Z"), status: "paid" },
      });
      await db.payout.create({ data: { fundraiserId: f.id, rateCents: 2500, qualifyingUnits: 0, amountCents: 0, status: "paid" } });
    }
    const p = await db.product.create({ data: { shopifyProductId: "777", handle: "d", title: "D", status: "ACTIVE" } });
    const fourth = await db.fundraiser.create({
      data: { publicCode: "D", teamId: (await db.team.findFirstOrThrow()).id, productId: p.id, startDate: new Date("2026-02-01"), endDate: new Date("2026-02-02"), windowStart: new Date("2026-02-01T08:00:00Z"), windowEnd: new Date("2026-02-03T08:00:00Z"), status: "payout_pending", paypalPayeeEmail: "club@example.org", settlementRepulledAt: new Date() },
    });
    const fourthPayout = await db.payout.create({ data: { fundraiserId: fourth.id, rateCents: 2500, qualifyingUnits: 0, amountCents: 0 } });
    expect((await payoutSummary(db, fourthPayout.id)).crosscheckRequired).toBe(false);
    await approvePayout(db, fourthPayout.id, "Matt");
  });

  test("paying an individual (payee = an organizer's own email) needs confirmation with a note", async () => {
    const s = await seed("pat@example.org");
    await save(order(pt("2026-10-05T10:00:00")));
    await settleDue(db, shopifyWith(new Map()), AFTER_SETTLEMENT);
    const payout = await db.payout.findUniqueOrThrow({ where: { fundraiserId: s.f.id } });
    await recordCrossCheck(db, payout.id, 1, "", "Matt");
    expect((await payoutSummary(db, payout.id)).individualPayee).toBe(true);
    await expect(approvePayout(db, payout.id, "Matt")).rejects.toThrow(/individual, not a club/);
    await expect(confirmIndividualPayee(db, payout.id, "", "Matt")).rejects.toThrow(/note/);
    await confirmIndividualPayee(db, payout.id, "Club has no PayPal; owner exception", "Matt");
    await approvePayout(db, payout.id, "Matt");
  });
});

describe("approve, reopen, pay", () => {
  test("approval freezes the lines: a later Shopify change doesn't alter the frozen payout", async () => {
    const { payout, orders } = await settledDraft(3);
    const approved = await crosscheckAndApprove(payout.id);
    expect(approved).toMatchObject({ units: 3, finalCents: 7500 });
    expect(await db.payoutLine.count({ where: { payoutId: payout.id } })).toBe(3);
    expect(await db.orderLineItem.count({ where: { locked: true } })).toBe(3);

    const [id] = [...orders.keys()];
    await save(
      shopifyOrderNode({
        id,
        name: `#${id}`,
        processedAt: pt("2026-10-05T10:00:00"),
        updatedAt: pt("2026-11-13T10:00:00"),
        cancelledAt: pt("2026-11-13T10:00:00"),
        financialStatus: "REFUNDED",
        lines: [{ id: `${id}0`, productId: CAPE, quantity: 1, currentQuantity: 0 }],
      }),
    );
    expect(await payoutSummary(db, payout.id)).toMatchObject({ units: 3, finalCents: 7500 });
    expect(await db.payoutChange.count()).toBe(1);
    expect(await db.auditLog.count({ where: { action: "payout:refund_after_approval" } })).toBe(1);
  });

  test("reopen: reason required, lines unlocked, snapshot discarded, back to a live draft; paid can't reopen", async () => {
    const { payout } = await settledDraft(2);
    await crosscheckAndApprove(payout.id);
    await expect(reopenPayout(db, payout.id, " ", "Matt")).rejects.toThrow(/reason/);
    await reopenPayout(db, payout.id, "Organizer reported a missing order", "Matt");
    expect(await db.payout.findUniqueOrThrow({ where: { id: payout.id } })).toMatchObject({ status: "draft", approvedAt: null, finalCents: null });
    expect(await db.payoutLine.count()).toBe(0);
    expect(await db.orderLineItem.count({ where: { locked: true } })).toBe(0);
    expect((await db.auditLog.findFirstOrThrow({ where: { action: "payout:reopened" } })).reason).toBe("Organizer reported a missing order");

    await approvePayout(db, payout.id, "Matt");
    await recordPayment(db, null, payout.id, { paidOn: "2026-11-25", method: "PayPal", reference: "PP-1", amountCents: 5000, note: "" }, "Matt");
    await expect(reopenPayout(db, payout.id, "x", "Matt")).rejects.toThrow(/paid payout is final/);
  });

  test("record payment: Paid, Payout Sent only when emails are on, amount mismatch needs a note, nothing editable after", async () => {
    const { f, payout } = await settledDraft(2);
    await crosscheckAndApprove(payout.id);
    const k = klaviyoSpy();
    await expect(recordPayment(db, k.client, payout.id, { paidOn: "2026-11-25", method: "PayPal", reference: "", amountCents: 5000, note: "" }, "Matt")).rejects.toThrow(/reference/);
    await expect(recordPayment(db, k.client, payout.id, { paidOn: "2026-11-25", method: "PayPal", reference: "PP-9", amountCents: 4900, note: "" }, "Matt")).rejects.toThrow(/differs/);

    // Emails off: no Payout Sent.
    await recordPayment(db, k.client, payout.id, { paidOn: "2026-11-25", method: "PayPal", reference: "PP-9", amountCents: 5000, note: "" }, "Matt");
    expect(k.events).toEqual([]);
    expect(await db.payout.findUniqueOrThrow({ where: { id: payout.id } })).toMatchObject({ status: "paid", paypalReference: "PP-9", paidAmountCents: 5000 });
    expect((await db.fundraiser.findUniqueOrThrow({ where: { id: f.id } })).status).toBe("paid");
    await expect(recordPayment(db, k.client, payout.id, { paidOn: "2026-11-25", method: "PayPal", reference: "PP-9", amountCents: 5000, note: "" }, "Matt")).rejects.toThrow(/already paid/);
    await expect(addAdjustment(db, payout.id, { amountCents: 100, reason: "x", effectiveDate: "2026-11-26", adminNote: "x" }, "Matt")).rejects.toThrow(/draft/);
    const line = await db.orderLineItem.findFirstOrThrow();
    await db.orderLineItem.update({ where: { id: line.id }, data: { reviewFlags: ["discount"] } });
    await expect(decideLine(db, line.id, "exclude", "x", "Matt")).rejects.toThrow(/paid|locked/);
  });

  test("portal shows the payout stage: confirming, final (approved), paid with date and reference", async () => {
    const { f, organizer, payout } = await settledDraft(3);
    expect((await portalView(db, f.id, organizer.id))!.payoutStatus).toBe("We're confirming your final total.");
    await crosscheckAndApprove(payout.id);
    const approved = (await portalView(db, f.id, organizer.id))!;
    expect(approved).toMatchObject({ finalAmount: "$75.00", units: 3, payoutStatus: "Final: $75.00, payment on its way." });
    await recordPayment(db, null, payout.id, { paidOn: "2026-11-25", method: "PayPal", reference: "PP-1", amountCents: 7500, note: "" }, "Matt");
    const paid = (await portalView(db, f.id, organizer.id))!;
    expect(paid.payoutStatus).toBe("Paid $75.00 on Nov 25 by PayPal (reference PP-1).");
    expect(JSON.stringify(paid)).not.toMatch(/#\d{4}/); // still no order numbers
  });

  test("Payout Sent fires when Organizer emails is on, with the amount and reference", async () => {
    const { f, payout } = await settledDraft(2);
    await db.fundraiser.update({ where: { id: f.id }, data: { emailsEnabled: true } });
    await crosscheckAndApprove(payout.id);
    const k = klaviyoSpy();
    await recordPayment(db, k.client, payout.id, { paidOn: "2026-11-25", method: "PayPal", reference: "PP-77", amountCents: 5000, note: "" }, "Matt");
    expect(k.events.map((e) => e.metric)).toEqual(["Payout Sent"]);
    expect(k.events[0]!.properties).toMatchObject({ payout_amount: "$50.00", paypal_reference: "PP-77", paid_date: "November 25" });
    expect(setEmailsEnabled).toBeDefined();
  });
});

describe("files, dashboard, cross-check data, dry run", () => {
  test("PayPal Payouts file: no header, email, amount, USD, reference, note, PAYPAL; full amount (Mambe pays fees)", () => {
    const rows = [
      { payeeEmail: "boosters@centralhigh.org", amountCents: 17500, publicCode: "NS-GSB-F26" },
      { payeeEmail: "club, inc@example.org", amountCents: 2550, publicCode: "A VERY LONG CODE THAT GOES ON AND ON AND ON" },
    ];
    expect(paypalPayoutsCsv(rows)).toBe(
      "boosters@centralhigh.org,175.00,USD,NS-GSB-F26,Mambe fundraiser payout NS-GSB-F26,PAYPAL\r\n" +
        '"club, inc@example.org",25.50,USD,AVERYLONGCODETHATGOESONANDONAN,Mambe fundraiser payout A VERY LONG CODE THAT GOES ON AND ON AND ON,PAYPAL\r\n',
    );
    expect(paypalTotalCents(rows)).toBe(20050);
  });

  test("accountant CSV has a header and money in dollars", () => {
    const csv = accountantCsv([
      { publicCode: "NS-GSB-F26", organization: "Nazareth Softball", team: "Girls Softball", payeeEmail: "t@example.org", units: 7, rateCents: 2500, calculatedCents: 17500, adjustmentsCents: -2500, finalCents: 15000, status: "paid", approvedDate: "2026-11-26", paidDate: "2026-11-27", paidAmountCents: 15000, paypalReference: "PP-1" },
    ]);
    expect(csv.split("\r\n")[0]).toBe("Fundraiser,Organization,Team,Payee email,Units,Rate,Calculated,Adjustments,Final,Status,Approved date,Paid date,Amount paid,PayPal reference");
    expect(csv.split("\r\n")[1]).toBe("NS-GSB-F26,Nazareth Softball,Girls Softball,t@example.org,7,25.00,175.00,-25.00,150.00,paid,2026-11-26,2026-11-27,150.00,PP-1");
  });

  test("payouts outstanding = drafts + approved; work queue shows review and to-send", async () => {
    const { payout } = await settledDraft(3);
    expect((await loadNumberStrip(db, AFTER_SETTLEMENT)).payoutsOutstandingCents).toBe(7500);
    let queue = await loadWorkQueue(db, AFTER_SETTLEMENT);
    expect(queue.find((g) => g.key === "payout_review")?.items[0]?.label).toBe("CHS-GLAX-F26");
    await crosscheckAndApprove(payout.id);
    queue = await loadWorkQueue(db, AFTER_SETTLEMENT);
    expect(queue.find((g) => g.key === "payouts")?.count).toBe(1);
    expect((await loadNumberStrip(db, AFTER_SETTLEMENT)).payoutsOutstandingCents).toBe(7500);
  });

  test("cross-check data: store-timezone window, qualifying orders and edge orders with reasons", async () => {
    const { f } = await seed();
    await save(order(pt("2026-09-30T23:30:00"))); // 30 min before the window
    await save(order(pt("2026-10-01T00:10:00"))); // just inside
    await save(order(pt("2026-10-15T10:00:00"), 2));
    const data = await crosscheckData(db, f.id, "America/New_York");
    expect(data.units).toBe(3);
    // Our window closes Nov 1 00:00 PDT = 07:00 UTC, which is 2:00 AM EST in New York
    // (clocks fell back at 2:00 AM EDT that morning), so the last second is 1:59:59 AM EST.
    expect(data.windowInStoreTime).toBe("Oct 1, 2026 3:00 AM EDT to Nov 1, 2026 1:59:59 AM EST");
    expect(data.edgeOrders.map((e) => e.side)).toEqual(["outside", "inside"]);
    expect(data.edgeOrders[0]!.why).toMatch(/is before .* when the window opens/);
    expect(data.edgeOrders[0]!.checkoutStore).toMatch(/2026-10-01 02:30:00 EDT/); // Oct 1 in store time, yet outside
    expect(data.csv.split("\r\n")).toHaveLength(4); // header + 2 qualifying orders (3 units) + trailing
  });

  test("dry run changes nothing: no status change, no payout", async () => {
    const { f } = await seed();
    await db.fundraiser.update({ where: { id: f.id }, data: { status: "active" } });
    await save(order(pt("2026-10-05T10:00:00"), 2));
    const result = await dryRunSettlement(db, shopifyWith(new Map()), f.id);
    expect(result).toMatchObject({ units: 2, amountCents: 5000, unresolvedFlags: 0 });
    expect((await db.fundraiser.findUniqueOrThrow({ where: { id: f.id } })).status).toBe("active");
    expect(await db.payout.count()).toBe(0);
  });
});

// Settlement and payouts: the part of the app that decides how much money each
// school or club receives. Spec: "Settlement", "Security and financial
// controls", cases 11, 20, 21, 22. Owner decisions (session 5):
//   - Mambe pays any PayPal fee; the organization receives the full amount.
//   - An approved, unpaid payout can be reopened to draft with a reason.
//   - The first 3 payouts need a Shopify cross-check before approval.
//
// Units always come from the attribution engine's stored results
// (fundraiserTotals); nothing here counts units another way.

import type { Payout, Prisma, PrismaClient } from "@prisma/client";
import { DateTime } from "luxon";
import { fundraiserTotals } from "../lib/attribution";
import { UserError } from "../lib/errors";
import { hasLaunchFields, launched } from "../lib/launched";
import { DEFAULT_TIMEZONE } from "../lib/window";
import { alert, alertError } from "./alerts.server";
import { writeAudit } from "./audit.server";
import { queueEmail, sendCommunication } from "./communications.server";
import { transitionFundraiser } from "./fundraisers.server";
import type { KlaviyoClient } from "./klaviyo.server";
import { reattributeProduct, syncOrderFromShopify } from "./order-sync.server";
export { acknowledgePayoutChange } from "./payout-changes.server";
import type { ShopifyClient } from "./shopify-api.server";

export const SETTLEMENT_DELAY_DAYS = 10;

/**
 * Staging-only test switches, honored only when ALLOW_TEST_SWITCHES=true
 * (never set on production):
 *   SETTLEMENT_DELAY_DAYS=0       settle right after the end
 *   SIMULATE_REPULL_FAILURE=true  make the settlement re-pull fail
 */
export function testSwitches(env: NodeJS.ProcessEnv = process.env) {
  const allowed = env.ALLOW_TEST_SWITCHES === "true";
  const delay = Number(env.SETTLEMENT_DELAY_DAYS);
  return {
    delayDays: allowed && Number.isInteger(delay) && delay >= 0 ? delay : SETTLEMENT_DELAY_DAYS,
    simulateRepullFailure: allowed && env.SIMULATE_REPULL_FAILURE === "true",
  };
}
/** The first this-many payouts need a Shopify cross-check before approval. */
export const REQUIRED_CROSSCHECKS = 3;
const DAY = 24 * 3600 * 1000;

type Tx = Prisma.TransactionClient;

// ------------------------------------------------------------- timing

/** Window end + 10 days (local time, so DST can't shift it), or cancelled_at + 10 days. */
export function settlementDueAt(f: { windowEnd: Date; cancelledAt: Date | null; timezone: string }): Date {
  if (f.cancelledAt && f.cancelledAt < f.windowEnd) {
    return new Date(f.cancelledAt.getTime() + testSwitches().delayDays * DAY);
  }
  return DateTime.fromJSDate(f.windowEnd).setZone(f.timezone || DEFAULT_TIMEZONE).plus({ days: testSwitches().delayDays }).toJSDate();
}

// ------------------------------------------------------------- re-pull

/**
 * Full re-pull: every order containing the product from 1 day before the
 * window to now (as Shopify lists them, plus any we already hold in that
 * range), re-read and re-attributed. Any failure fails the whole re-pull.
 */
export async function fullRepull(db: PrismaClient, shopify: ShopifyClient, fundraiserId: number) {
  if (testSwitches().simulateRepullFailure) throw new Error("Simulated Shopify failure (staging test switch)");
  const f = launched(await db.fundraiser.findUniqueOrThrow({ where: { id: fundraiserId }, include: { product: true } }));
  const since = new Date(f.windowStart.getTime() - DAY);
  const fromShopify = await shopify.listOrderIdsForProductSince(f.product.shopifyProductId, since);
  const held = await db.shopifyOrder.findMany({
    where: { processedAt: { gte: since }, lineItems: { some: { shopifyProductId: f.product.shopifyProductId } } },
    select: { shopifyOrderId: true },
  });
  const ids = [...new Set([...fromShopify, ...held.map((o) => o.shopifyOrderId)])];
  // Any Shopify error throws and fails the whole re-pull. An order Shopify
  // says doesn't exist (e.g. deleted) keeps our last copy and is reported.
  const missing: string[] = [];
  for (const id of ids) {
    const result = await syncOrderFromShopify(db, shopify, id);
    if (result.status === "not_found") missing.push(id);
  }
  if (missing.length) {
    alert(`Settlement re-pull for ${f.publicCode}: Shopify no longer has ${missing.length} order(s) we hold; kept our last copy`, { missing });
  }
  return { ordersRead: ids.length, missing };
}

// ------------------------------------------------------------- drafts

async function liveTotals(db: PrismaClient | Tx, fundraiserId: number, rateCents: number) {
  const lines = await db.orderLineItem.findMany({ where: { attributedFundraiserId: fundraiserId } });
  return fundraiserTotals(fundraiserId, rateCents, lines);
}

async function createDraft(db: PrismaClient, fundraiserId: number, now: Date): Promise<Payout> {
  const existing = await db.payout.findUnique({ where: { fundraiserId } });
  if (existing) return existing;
  const f = await db.fundraiser.findUniqueOrThrow({ where: { id: fundraiserId } });
  const totals = await liveTotals(db, fundraiserId, f.payoutRateCents);
  const payout = await db.payout.create({
    data: {
      fundraiserId,
      rateCents: f.payoutRateCents,
      qualifyingUnits: totals.qualifyingUnits,
      amountCents: totals.estimatedPayoutCents,
      status: "draft",
      calculatedAt: now,
      payeeEmail: f.paypalPayeeEmail,
    },
  });
  await writeAudit(db, {
    entity: "fundraiser",
    entityId: fundraiserId,
    action: "payout:draft",
    after: { payoutId: payout.id, units: totals.qualifyingUnits, amountCents: totals.estimatedPayoutCents },
    actor: "clock",
  });
  return payout;
}

/** A draft follows the live numbers until approval. */
export async function refreshDraft(db: PrismaClient, payoutId: number, now = new Date()) {
  const payout = await db.payout.findUniqueOrThrow({ where: { id: payoutId }, include: { fundraiser: true } });
  if (payout.status !== "draft") return payout;
  const totals = await liveTotals(db, payout.fundraiserId, payout.fundraiser.payoutRateCents);
  return db.payout.update({
    where: { id: payoutId },
    data: {
      rateCents: payout.fundraiser.payoutRateCents,
      qualifyingUnits: totals.qualifyingUnits,
      amountCents: totals.estimatedPayoutCents,
      payeeEmail: payout.fundraiser.paypalPayeeEmail,
      calculatedAt: now,
    },
  });
}

// --------------------------------------------------------- clock: settle

export interface SettleResult {
  settled: string[];
  failed: string[];
}

/**
 * Run by the clock. For each fundraiser due for settlement: full re-pull,
 * then the draft payout and Settling → Payout pending. If the re-pull fails,
 * nothing is calculated: it stays in Settling, flagged, and retries next run.
 * Safe to run twice: one payout per fundraiser.
 */
export async function settleDue(db: PrismaClient, shopify: ShopifyClient, now = new Date()): Promise<SettleResult> {
  const result: SettleResult = { settled: [], failed: [] };
  const candidates = await db.fundraiser.findMany({
    where: {
      OR: [
        { status: "settling" },
        // A cancelled fundraiser pays what sold before cancelling (owner decision).
        { status: "cancelled", cancelledAt: { not: null }, payout: null, settlementRepulledAt: null },
      ],
    },
    orderBy: { id: "asc" },
  });
  for (const f of candidates) {
    if (!hasLaunchFields(f)) continue; // type guard: a launched fundraiser always has dates
    if (now < settlementDueAt(f)) continue;
    try {
      const { ordersRead, missing } = await fullRepull(db, shopify, f.id);
      await db.fundraiser.update({
        where: { id: f.id },
        data: { settlementRepulledAt: now, settlementRepullOrders: ordersRead, settlementError: null, settlementErrorAt: null },
      });
      await writeAudit(db, { entity: "fundraiser", entityId: f.id, action: "settlement:repull", after: { ordersRead, missingFromShopify: missing }, actor: "clock" });

      if (f.status === "cancelled") {
        const totals = await liveTotals(db, f.id, f.payoutRateCents);
        if (totals.qualifyingUnits === 0 && totals.unresolvedFlaggedLines === 0) continue; // nothing to pay
        await createDraft(db, f.id, now);
      } else {
        await createDraft(db, f.id, now);
        await transitionFundraiser(db, f.id, "settle", { actor: "clock", now });
      }
      result.settled.push(f.publicCode);
    } catch (error) {
      const firstOrStale = !f.settlementErrorAt || now.getTime() - f.settlementErrorAt.getTime() > 6 * 3600 * 1000;
      await db.fundraiser.update({
        where: { id: f.id },
        data: {
          settlementError: `Re-pull failed: ${String((error as Error)?.message ?? error).slice(0, 300)}`,
          settlementErrorAt: firstOrStale ? now : f.settlementErrorAt,
        },
      });
      if (firstOrStale) alertError(error, `Settlement re-pull failed for ${f.publicCode}; no payout calculated, retrying every 15 minutes`);
      result.failed.push(f.publicCode);
    }
  }
  return result;
}

// ------------------------------------------------------- payout summary

export interface PayoutSummary {
  payout: Payout;
  live: boolean;
  units: number;
  rateCents: number;
  amountCents: number;
  adjustmentsCents: number;
  finalCents: number;
  unresolvedFlags: Array<{ lineId: number; orderName: string; flags: string[] }>;
  crosscheckRequired: boolean;
  crosscheckCurrent: boolean;
  individualPayee: boolean;
  blockers: string[];
}

async function crosscheckRequired(db: PrismaClient, payoutId: number): Promise<boolean> {
  const earlier = await db.payout.count({ where: { id: { not: payoutId }, status: { in: ["approved", "paid"] } } });
  return earlier < REQUIRED_CROSSCHECKS;
}

export async function payoutSummary(db: PrismaClient, payoutId: number): Promise<PayoutSummary> {
  const payout = await db.payout.findUniqueOrThrow({
    where: { id: payoutId },
    include: { adjustments: true, fundraiser: { include: { organizers: { include: { organizer: true } } } } },
  });
  const f = payout.fundraiser;
  const live = payout.status === "draft";
  const totals = live ? await liveTotals(db, f.id, f.payoutRateCents) : null;
  const units = totals ? totals.qualifyingUnits : payout.qualifyingUnits;
  const rateCents = live ? f.payoutRateCents : payout.rateCents;
  const amountCents = totals ? totals.estimatedPayoutCents : payout.amountCents;
  const adjustmentsCents = payout.adjustments.reduce((sum, a) => sum + a.amountCents, 0);
  const finalCents = live ? amountCents + adjustmentsCents : (payout.finalCents ?? amountCents + adjustmentsCents);

  const flagged = await db.orderLineItem.findMany({
    where: {
      attributedFundraiserId: f.id,
      adminDecision: null,
      reviewFlags: { isEmpty: false },
      outcome: { in: ["qualifying", "not_eligible"] },
    },
    include: { order: { select: { name: true } } },
    orderBy: { id: "asc" },
  });
  const unresolvedFlags = flagged.map((l) => ({ lineId: l.id, orderName: l.order.name, flags: l.reviewFlags }));
  const payee = (live ? f.paypalPayeeEmail : payout.payeeEmail)?.toLowerCase() ?? null;
  const individualPayee = !!payee && f.organizers.some((o) => o.organizer.email.toLowerCase() === payee);
  const required = live ? await crosscheckRequired(db, payout.id) : false;
  const crosscheckCurrent = !!payout.crosscheckAt && payout.crosscheckAppUnits === units;

  const blockers: string[] = [];
  if (live) {
    if (!f.settlementRepulledAt) blockers.push("The settlement re-pull from Shopify hasn't succeeded yet.");
    if (unresolvedFlags.length) {
      blockers.push(`Resolve ${unresolvedFlags.length} flagged line${unresolvedFlags.length === 1 ? "" : "s"}: ${unresolvedFlags.map((l) => l.orderName).join(", ")}.`);
    }
    if (required && !crosscheckCurrent) {
      blockers.push(
        payout.crosscheckAt
          ? `The Shopify cross-check was for ${payout.crosscheckAppUnits} units; the payout is now ${units}. Check again.`
          : "Do the Shopify cross-check (required for the first 3 payouts).",
      );
    }
    if (!payee) blockers.push("Add the PayPal payee email on the fundraiser.");
    if (individualPayee && !payout.individualPayeeConfirmedAt) {
      blockers.push("The payee email is an organizer's own email (an individual, not a club). Confirm paying an individual.");
    }
    if (finalCents < 0) blockers.push("The final amount can't be negative.");
  }
  return {
    payout,
    live,
    units,
    rateCents,
    amountCents,
    adjustmentsCents,
    finalCents,
    unresolvedFlags,
    crosscheckRequired: required,
    crosscheckCurrent,
    individualPayee,
    blockers,
  };
}

function requireDraft(payout: Payout, what: string) {
  if (payout.status !== "draft") throw new UserError(`${what} is only possible while the payout is a draft (it's ${payout.status}).`);
}

// ---------------------------------------------------------- draft edits

export async function addAdjustment(
  db: PrismaClient,
  payoutId: number,
  input: { amountCents: number | null; reason: string; effectiveDate: string; adminNote: string },
  actor: string,
) {
  const payout = await db.payout.findUniqueOrThrow({ where: { id: payoutId } });
  requireDraft(payout, "Adding an adjustment");
  if (input.amountCents === null || !Number.isInteger(input.amountCents) || input.amountCents === 0) {
    throw new UserError("Enter the adjustment amount, e.g. 25 or -25.");
  }
  if (!input.reason.trim()) throw new UserError("An adjustment needs a reason.");
  if (!input.adminNote.trim()) throw new UserError("An adjustment needs a note.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveDate)) throw new UserError("An adjustment needs a date.");
  const adjustment = await db.payoutAdjustment.create({
    data: {
      payoutId,
      amountCents: input.amountCents,
      reason: input.reason.trim(),
      effectiveDate: new Date(`${input.effectiveDate}T00:00:00Z`),
      adminNote: input.adminNote.trim(),
      createdBy: actor,
    },
  });
  await writeAudit(db, {
    entity: "fundraiser",
    entityId: payout.fundraiserId,
    action: "payout:adjustment",
    after: { amountCents: input.amountCents, reason: input.reason.trim(), date: input.effectiveDate, note: input.adminNote.trim() },
    reason: input.reason.trim(),
    actor,
  });
  return adjustment;
}

export async function recordCrossCheck(db: PrismaClient, payoutId: number, shopifyUnits: number | null, note: string, actor: string) {
  const summary = await payoutSummary(db, payoutId);
  requireDraft(summary.payout, "The cross-check");
  if (shopifyUnits === null || !Number.isInteger(shopifyUnits) || shopifyUnits < 0) {
    throw new UserError("Enter the unit count Shopify shows.");
  }
  if (shopifyUnits !== summary.units && !note.trim()) {
    throw new UserError(`Shopify shows ${shopifyUnits} and the app ${summary.units}; a note explaining the difference is required.`);
  }
  await db.payout.update({
    where: { id: payoutId },
    data: {
      crosscheckShopifyUnits: shopifyUnits,
      crosscheckAppUnits: summary.units,
      crosscheckNote: note.trim() || null,
      crosscheckBy: actor,
      crosscheckAt: new Date(),
    },
  });
  await writeAudit(db, {
    entity: "fundraiser",
    entityId: summary.payout.fundraiserId,
    action: "payout:crosscheck",
    after: { shopifyUnits, appUnits: summary.units, note: note.trim() || null },
    reason: note.trim() || null,
    actor,
  });
}

export async function confirmIndividualPayee(db: PrismaClient, payoutId: number, note: string, actor: string) {
  const payout = await db.payout.findUniqueOrThrow({ where: { id: payoutId } });
  requireDraft(payout, "Confirming the payee");
  if (!note.trim()) throw new UserError("Add a note on why an individual is being paid.");
  await db.payout.update({
    where: { id: payoutId },
    data: { individualPayeeConfirmedBy: actor, individualPayeeConfirmedAt: new Date(), individualPayeeNote: note.trim() },
  });
  await writeAudit(db, {
    entity: "fundraiser",
    entityId: payout.fundraiserId,
    action: "payout:individual_payee_confirmed",
    after: { payee: payout.payeeEmail },
    reason: note.trim(),
    actor,
  });
}

// ------------------------------------------------- approve, reopen, pay

/** Approve: freeze the exact lines and units (payout_lines) and lock them. */
export async function approvePayout(db: PrismaClient, payoutId: number, actor: string, now = new Date()) {
  await refreshDraft(db, payoutId, now);
  const summary = await payoutSummary(db, payoutId);
  requireDraft(summary.payout, "Approval");
  if (summary.blockers.length) throw new UserError(`Can't approve yet: ${summary.blockers.join(" ")}`);
  const fundraiserId = summary.payout.fundraiserId;

  await db.$transaction(async (tx) => {
    const counted = await tx.orderLineItem.findMany({
      where: { attributedFundraiserId: fundraiserId, outcome: "qualifying", qualifyingUnits: { gt: 0 } },
    });
    const units = counted.reduce((sum, l) => sum + l.qualifyingUnits, 0);
    if (units !== summary.units) throw new UserError("The numbers changed while approving; please try again.");
    await tx.payoutLine.createMany({ data: counted.map((l) => ({ payoutId, lineItemId: l.id, unitsCounted: l.qualifyingUnits })) });
    // Lock every line attributed to the fundraiser, counted or not, so
    // nothing can move in or out of the frozen payout.
    await tx.orderLineItem.updateMany({ where: { attributedFundraiserId: fundraiserId }, data: { locked: true } });
    await tx.payout.update({
      where: { id: payoutId },
      data: {
        status: "approved",
        qualifyingUnits: summary.units,
        rateCents: summary.rateCents,
        amountCents: summary.amountCents,
        finalCents: summary.finalCents,
        approvedAt: now,
        approvedBy: actor,
      },
    });
    await writeAudit(tx, {
      entity: "fundraiser",
      entityId: fundraiserId,
      action: "payout:approved",
      after: { units: summary.units, rateCents: summary.rateCents, adjustmentsCents: summary.adjustmentsCents, finalCents: summary.finalCents, lines: counted.length },
      actor,
    });
  });
  return payoutSummary(db, payoutId);
}

export async function reopenPayout(db: PrismaClient, payoutId: number, reason: string, actor: string) {
  const payout = await db.payout.findUniqueOrThrow({ where: { id: payoutId } });
  if (payout.status === "paid") throw new UserError("A paid payout is final and can't be reopened.");
  if (payout.status !== "approved") throw new UserError("Only an approved payout can be reopened.");
  if (!reason.trim()) throw new UserError("A reason is required to reopen a payout.");
  await db.$transaction(async (tx) => {
    await tx.payoutLine.deleteMany({ where: { payoutId } });
    await tx.orderLineItem.updateMany({ where: { attributedFundraiserId: payout.fundraiserId }, data: { locked: false } });
    await tx.payout.update({ where: { id: payoutId }, data: { status: "draft", approvedAt: null, approvedBy: null, finalCents: null } });
    await writeAudit(tx, {
      entity: "fundraiser",
      entityId: payout.fundraiserId,
      action: "payout:reopened",
      before: { status: "approved", finalCents: payout.finalCents },
      after: { status: "draft" },
      reason: reason.trim(),
      actor,
    });
  });
  // Lines may have changed while frozen; bring them up to date.
  const f = launched(await db.fundraiser.findUniqueOrThrow({ where: { id: payout.fundraiserId }, include: { product: true } }));
  await reattributeProduct(db, f.product.shopifyProductId);
  await refreshDraft(db, payoutId);
}

export interface PaymentInput {
  paidOn: string; // YYYY-MM-DD
  method: string;
  reference: string;
  amountCents: number | null;
  note: string;
}

/** Record the PayPal payment. Paid is final. Sends "Payout Sent" only if Organizer emails is on. */
export async function recordPayment(
  db: PrismaClient,
  klaviyo: KlaviyoClient | null,
  payoutId: number,
  input: PaymentInput,
  actor: string,
  now = new Date(),
) {
  const payout = await db.payout.findUniqueOrThrow({ where: { id: payoutId }, include: { fundraiser: true } });
  if (payout.status === "paid") throw new UserError("This payout is already paid.");
  if (payout.status !== "approved") throw new UserError("Approve the payout before recording its payment.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.paidOn)) throw new UserError("Enter the payment date.");
  if (!input.reference.trim()) throw new UserError("Enter the PayPal transaction reference.");
  if (input.amountCents === null || !Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new UserError("Enter the amount sent.");
  }
  if (input.amountCents !== payout.finalCents && !input.note.trim()) {
    throw new UserError(`The amount sent differs from the final amount ($${((payout.finalCents ?? 0) / 100).toFixed(2)}); a note is required.`);
  }
  const paidAt = DateTime.fromISO(input.paidOn, { zone: DEFAULT_TIMEZONE }).set({ hour: 12 }).toJSDate();
  await db.$transaction(async (tx) => {
    await tx.payout.update({
      where: { id: payoutId },
      data: {
        status: "paid",
        paidAt,
        method: input.method || "PayPal",
        paypalReference: input.reference.trim(),
        paidAmountCents: input.amountCents,
        paidNote: input.note.trim() || null,
        paidBy: actor,
      },
    });
    await writeAudit(tx, {
      entity: "fundraiser",
      entityId: payout.fundraiserId,
      action: "payout:paid",
      after: { paidOn: input.paidOn, method: input.method || "PayPal", reference: input.reference.trim(), amountCents: input.amountCents, finalCents: payout.finalCents },
      reason: input.note.trim() || null,
      actor,
    });
  });
  // A cancelled fundraiser stays Cancelled; its payout record shows Paid.
  if (payout.fundraiser.status === "payout_pending") {
    await transitionFundraiser(db, payout.fundraiserId, "record_payment", { actor, now });
  }
  if (payout.fundraiser.emailsEnabled && klaviyo) {
    const row = await queueEmail(db, payout.fundraiserId, "paid", now);
    await sendCommunication(db, klaviyo, row, actor, now);
  }
}

// -------------------------------------------------------------- dry run

/** What the draft would be today. Re-pulls orders (a normal sync) but changes no status and creates no payout. */
export async function dryRunSettlement(db: PrismaClient, shopify: ShopifyClient, fundraiserId: number) {
  const f = await db.fundraiser.findUniqueOrThrow({ where: { id: fundraiserId } });
  if (!["active", "settling", "scheduled"].includes(f.status)) {
    throw new UserError("A dry run is for fundraisers that are Active or Settling.");
  }
  const { ordersRead } = await fullRepull(db, shopify, fundraiserId);
  const totals = await liveTotals(db, fundraiserId, f.payoutRateCents);
  const flagged = await db.orderLineItem.count({
    where: { attributedFundraiserId: fundraiserId, adminDecision: null, reviewFlags: { isEmpty: false }, outcome: { in: ["qualifying", "not_eligible"] } },
  });
  await writeAudit(db, {
    entity: "fundraiser",
    entityId: fundraiserId,
    action: "settlement:dry_run",
    after: { ordersRead, units: totals.qualifyingUnits, amountCents: totals.estimatedPayoutCents, flagged },
    actor: "admin",
  });
  return { ordersRead, units: totals.qualifyingUnits, amountCents: totals.estimatedPayoutCents, unresolvedFlags: flagged };
}

/** For the History "payouts outstanding" and work queue. */
export async function outstandingPayoutCents(db: PrismaClient): Promise<number> {
  const payouts = await db.payout.findMany({ where: { status: { in: ["draft", "approved"] } }, select: { id: true } });
  let total = 0;
  for (const p of payouts) total += (await payoutSummary(db, p.id)).finalCents;
  return total;
}

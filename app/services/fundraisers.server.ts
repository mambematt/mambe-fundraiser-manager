// Fundraiser lifecycle: create, edit, change dates/rate, move between
// statuses, and the setup checklist. Every change is audited.

import type { Fundraiser, PrismaClient } from "@prisma/client";
import { DateTime } from "luxon";
import { fundraiserTotals, type FundraiserTotals } from "../lib/attribution";
import { CHECKLIST_ITEMS, checklistFrom, type ChecklistKey } from "../lib/checklist";
import { launchBlockers } from "../lib/launch-gate";
import { normalizePublicCode, suggestPublicCode } from "../lib/public-code";
import {
  canEditDatesOrRate,
  canTransition,
  findTransition,
  STATUS_LABELS,
  type FundraiserStatus,
  type TransitionAction,
} from "../lib/status";
import { computeWindow, DEFAULT_TIMEZONE, effectiveWindow, type TimeWindow } from "../lib/window";
import { UserError } from "../lib/errors";
import { writeAudit } from "./audit.server";
import { loadFundraisersForProducts, reattributeProduct, runEngineOnOrder } from "./order-sync.server";
import { hasFundraiserTag } from "./products.server";

export const DEFAULT_PAYOUT_RATE_CENTS = 2500;

export { UserError };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function dateColumn(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

export function prettyDate(iso: string): string {
  return DateTime.fromISO(iso).toFormat("LLL d, yyyy");
}

function windowFor(startDate: string, endDate: string, timezone: string): TimeWindow {
  try {
    return computeWindow(startDate, endDate, timezone);
  } catch (error) {
    throw new UserError((error as Error).message);
  }
}

// ---------------------------------------------------------------- overlaps

export interface OverlapInfo {
  id: number;
  publicCode: string;
  startDate: string;
  endDate: string;
}

/** Fundraisers on the product whose (effective) windows overlap `window`. */
export async function findOverlaps(
  db: PrismaClient,
  productId: number,
  window: TimeWindow,
  excludeId?: number,
): Promise<OverlapInfo[]> {
  const others = await db.fundraiser.findMany({
    where: { productId, status: { not: "declined" }, ...(excludeId ? { id: { not: excludeId } } : {}) },
    orderBy: { windowStart: "asc" },
  });
  return others
    .filter((f) => {
      const w = effectiveWindow({ start: f.windowStart, end: f.windowEnd }, f.cancelledAt);
      return w.start < window.end && window.start < w.end && w.end > w.start;
    })
    .map((f) => ({ id: f.id, publicCode: f.publicCode, startDate: isoDate(f.startDate), endDate: isoDate(f.endDate) }));
}

function isOverlapViolation(error: unknown): boolean {
  return /fundraisers_no_overlap|23P01|exclusion constraint/i.test(String((error as Error)?.message ?? error));
}

function overlapMessage(overlaps: OverlapInfo[]): string {
  if (overlaps.length === 0) {
    return "These dates overlap another fundraiser on the same product.";
  }
  const list = overlaps
    .map((o) => `${o.publicCode} (${prettyDate(o.startDate)} – ${prettyDate(o.endDate)})`)
    .join(", ");
  return `These dates overlap ${list} on the same product. Two fundraisers on one product can't run at the same time.`;
}

/** Turn a database overlap refusal into a plain message naming the conflict. */
async function withOverlapMessage<T>(
  db: PrismaClient,
  productId: number,
  window: TimeWindow,
  excludeId: number | undefined,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (isOverlapViolation(error)) {
      throw new UserError(overlapMessage(await findOverlaps(db, productId, window, excludeId)));
    }
    throw error;
  }
}

// ------------------------------------------------------------------ create

export interface CreateFundraiserInput {
  teamId: number;
  productId: number;
  seasonLabel?: string | null;
  startDate: string;
  endDate: string;
  timezone?: string;
  payoutRateCents?: number;
  paypalPayeeEmail?: string | null;
  organizerIds: number[];
  primaryOrganizerId: number | null;
  publicCode?: string | null;
  notes?: string | null;
}

async function uniqueSuggestedCode(db: PrismaClient, base: string): Promise<string> {
  for (let n = 1; n < 100; n++) {
    const code = n === 1 ? base : `${base}-${n}`;
    if (!(await db.fundraiser.findUnique({ where: { publicCode: code } }))) return code;
  }
  throw new UserError("Couldn't generate a unique public code; please type one.");
}

export async function createFundraiser(
  db: PrismaClient,
  input: CreateFundraiserInput,
  actor: string,
): Promise<Fundraiser> {
  const team = await db.team.findUnique({ where: { id: input.teamId }, include: { organization: true } });
  if (!team) throw new UserError("Choose a team.");
  const product = await db.product.findUnique({ where: { id: input.productId }, include: { team: true } });
  if (!product) throw new UserError("Choose a linked product.");
  if (product.deletedAt || product.status === "DELETED" || product.status === "ARCHIVED") {
    throw new UserError(`"${product.title}" is ${product.deletedAt ? "deleted" : "archived"} in Shopify; a fundraiser can't use it.`);
  }
  if (product.teamId && product.teamId !== team.id) {
    throw new UserError(`"${product.title}" belongs to ${product.team?.name ?? "another team"}. Choose that team's product.`);
  }

  const organizerIds = [...new Set(input.organizerIds)];
  if (organizerIds.length === 0) throw new UserError("Add at least one organizer.");
  const primary = input.primaryOrganizerId ?? (organizerIds.length === 1 ? organizerIds[0]! : null);
  if (primary === null || !organizerIds.includes(primary)) {
    throw new UserError("Mark one of the chosen organizers as primary.");
  }

  const payee = input.paypalPayeeEmail?.trim().toLowerCase() || null;
  if (payee && !EMAIL.test(payee)) throw new UserError("The PayPal payee email doesn't look right.");
  const rate = input.payoutRateCents ?? DEFAULT_PAYOUT_RATE_CENTS;
  if (!Number.isInteger(rate) || rate <= 0) throw new UserError("The payout rate must be more than $0.");

  const timezone = input.timezone || DEFAULT_TIMEZONE;
  const window = windowFor(input.startDate, input.endDate, timezone);

  let publicCode = input.publicCode ? normalizePublicCode(input.publicCode) : "";
  if (publicCode) {
    if (await db.fundraiser.findUnique({ where: { publicCode } })) {
      throw new UserError(`The public code ${publicCode} is already used.`);
    }
  } else {
    publicCode = await uniqueSuggestedCode(db, suggestPublicCode(team.organization.name, team.name, input.startDate));
  }

  const fundraiser = await withOverlapMessage(db, product.id, window, undefined, () =>
    db.$transaction(async (tx) => {
      const created = await tx.fundraiser.create({
        data: {
          publicCode,
          teamId: team.id,
          productId: product.id,
          seasonLabel: input.seasonLabel?.trim() || null,
          startDate: dateColumn(input.startDate),
          endDate: dateColumn(input.endDate),
          timezone,
          windowStart: window.start,
          windowEnd: window.end,
          payoutRateCents: rate,
          status: "setup",
          paypalPayeeEmail: payee,
          notes: input.notes?.trim() || null,
          organizers: {
            create: organizerIds.map((organizerId) => ({ organizerId, isPrimary: organizerId === primary })),
          },
        },
      });
      if (!product.teamId) {
        await tx.product.update({ where: { id: product.id }, data: { teamId: team.id } });
      }
      await writeAudit(tx, {
        entity: "fundraiser",
        entityId: created.id,
        action: "create",
        after: {
          publicCode,
          team: `${team.organization.name} – ${team.name}`,
          product: product.title,
          startDate: input.startDate,
          endDate: input.endDate,
          timezone,
          payoutRateCents: rate,
          organizerIds,
          primaryOrganizerId: primary,
        },
        actor,
      });
      return created;
    }),
  );

  // A new window can claim sales already saved for this product.
  await reattributeProduct(db, product.shopifyProductId);
  return fundraiser;
}

// ------------------------------------------------------------ edit details

export interface DetailsInput {
  publicCode: string;
  seasonLabel: string | null;
  paypalPayeeEmail: string | null;
  notes: string | null;
}

export async function updateDetails(db: PrismaClient, id: number, input: DetailsInput, actor: string) {
  const f = await db.fundraiser.findUniqueOrThrow({ where: { id } });
  if (f.status === "paid") throw new UserError("A paid fundraiser can't be edited.");
  const publicCode = normalizePublicCode(input.publicCode);
  if (!publicCode) throw new UserError("The public code can't be empty.");
  if (publicCode !== f.publicCode && (await db.fundraiser.findUnique({ where: { publicCode } }))) {
    throw new UserError(`The public code ${publicCode} is already used.`);
  }
  const payee = input.paypalPayeeEmail?.trim().toLowerCase() || null;
  if (payee && !EMAIL.test(payee)) throw new UserError("The PayPal payee email doesn't look right.");

  const after = {
    publicCode,
    seasonLabel: input.seasonLabel?.trim() || null,
    paypalPayeeEmail: payee,
    notes: input.notes?.trim() || null,
  };
  const before = {
    publicCode: f.publicCode,
    seasonLabel: f.seasonLabel,
    paypalPayeeEmail: f.paypalPayeeEmail,
    notes: f.notes,
  };
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  await db.$transaction(async (tx) => {
    await tx.fundraiser.update({ where: { id }, data: after });
    await writeAudit(tx, { entity: "fundraiser", entityId: id, action: "edit_details", before, after, actor });
  });
}

export async function setOrganizers(
  db: PrismaClient,
  id: number,
  organizerIds: number[],
  primaryOrganizerId: number | null,
  actor: string,
) {
  const f = await db.fundraiser.findUniqueOrThrow({ where: { id }, include: { organizers: true } });
  if (f.status === "paid") throw new UserError("A paid fundraiser can't be edited.");
  const ids = [...new Set(organizerIds)];
  if (ids.length === 0) throw new UserError("A fundraiser needs at least one organizer.");
  const primary = primaryOrganizerId ?? (ids.length === 1 ? ids[0]! : null);
  if (primary === null || !ids.includes(primary)) throw new UserError("Mark one of the organizers as primary.");
  await db.$transaction(async (tx) => {
    await tx.fundraiserOrganizer.deleteMany({ where: { fundraiserId: id } });
    await tx.fundraiserOrganizer.createMany({
      data: ids.map((organizerId) => ({ fundraiserId: id, organizerId, isPrimary: organizerId === primary })),
    });
    await writeAudit(tx, {
      entity: "fundraiser",
      entityId: id,
      action: "set_organizers",
      before: {
        organizerIds: f.organizers.map((o) => o.organizerId),
        primaryOrganizerId: f.organizers.find((o) => o.isPrimary)?.organizerId ?? null,
      },
      after: { organizerIds: ids, primaryOrganizerId: primary },
      actor,
    });
  });
}

// --------------------------------------------------------------- totals

/** Estimated totals from the stored, attributed lines. */
export async function storedTotals(db: PrismaClient, f: Pick<Fundraiser, "id" | "payoutRateCents">): Promise<FundraiserTotals> {
  const lines = await db.orderLineItem.findMany({ where: { attributedFundraiserId: f.id } });
  return fundraiserTotals(f.id, f.payoutRateCents, lines);
}

// ------------------------------------------------------ dates or rate

export interface DatesRateChange {
  startDate: string;
  endDate: string;
  payoutRateCents: number;
}

export interface DatesRatePreview {
  before: { startDate: string; endDate: string; payoutRateCents: number; qualifyingUnits: number; estimatedPayoutCents: number };
  after: { startDate: string; endDate: string; payoutRateCents: number; qualifyingUnits: number; estimatedPayoutCents: number };
  overlaps: OverlapInfo[];
}

async function assertDatesRateEditable(db: PrismaClient, f: Fundraiser) {
  if (!canEditDatesOrRate(f.status)) {
    throw new UserError(`Dates and rate can't be changed once a fundraiser is ${STATUS_LABELS[f.status as FundraiserStatus] ?? f.status}.`);
  }
  // A frozen payout locks everything. (Settlement isn't built yet; the
  // status check above already covers it, this is the belt-and-braces check.)
  const payout = await db.payout.findUnique({ where: { fundraiserId: f.id } });
  if (payout && payout.status !== "draft") throw new UserError("The payout is frozen; dates and rate are locked.");
}

/**
 * What the fundraiser's numbers would be with different dates or rate,
 * computed by the attribution engine over the product's saved orders.
 */
async function computeTotalsWith(
  db: PrismaClient,
  f: Fundraiser & { product: { shopifyProductId: string } },
  window: TimeWindow,
  payoutRateCents: number,
): Promise<FundraiserTotals> {
  const shopifyProductId = f.product.shopifyProductId;
  const fundraisers = (await loadFundraisersForProducts(db, [shopifyProductId])).map((x) =>
    x.id === f.id ? { ...x, windowStart: window.start, windowEnd: window.end } : x,
  );
  const orders = await db.shopifyOrder.findMany({
    where: { lineItems: { some: { shopifyProductId } } },
    include: { lineItems: { orderBy: { id: "asc" } } },
  });
  const lines = orders.flatMap((order) => {
    const byId = new Map(order.lineItems.map((l) => [String(l.id), l]));
    return runEngineOnOrder(order, fundraisers).map((r) => ({
      attributedFundraiserId: r.fundraiserId,
      qualifyingUnits: r.qualifyingUnits,
      outcome: r.outcome,
      reviewFlags: r.flags,
      adminDecision: byId.get(r.key)?.adminDecision ?? null,
    }));
  });
  return fundraiserTotals(f.id, payoutRateCents, lines);
}

export async function previewDatesRateChange(
  db: PrismaClient,
  id: number,
  change: DatesRateChange,
): Promise<DatesRatePreview> {
  const f = await db.fundraiser.findUniqueOrThrow({ where: { id }, include: { product: true } });
  await assertDatesRateEditable(db, f);
  if (!Number.isInteger(change.payoutRateCents) || change.payoutRateCents <= 0) {
    throw new UserError("The payout rate must be more than $0.");
  }
  const newWindow = windowFor(change.startDate, change.endDate, f.timezone);
  const [before, after, overlaps] = await Promise.all([
    computeTotalsWith(db, f, { start: f.windowStart, end: f.windowEnd }, f.payoutRateCents),
    computeTotalsWith(db, f, newWindow, change.payoutRateCents),
    findOverlaps(db, f.productId, effectiveWindow(newWindow, f.cancelledAt), f.id),
  ]);
  return {
    before: {
      startDate: isoDate(f.startDate),
      endDate: isoDate(f.endDate),
      payoutRateCents: f.payoutRateCents,
      qualifyingUnits: before.qualifyingUnits,
      estimatedPayoutCents: before.estimatedPayoutCents,
    },
    after: {
      ...change,
      qualifyingUnits: after.qualifyingUnits,
      estimatedPayoutCents: after.estimatedPayoutCents,
    },
    overlaps,
  };
}

export async function applyDatesRateChange(
  db: PrismaClient,
  id: number,
  change: DatesRateChange,
  reason: string,
  actor: string,
): Promise<{ preview: DatesRatePreview; saved: FundraiserTotals }> {
  if (!reason.trim()) throw new UserError("A reason is required to change dates or rate.");
  const preview = await previewDatesRateChange(db, id, change);
  if (preview.overlaps.length) throw new UserError(overlapMessage(preview.overlaps));

  const f = await db.fundraiser.findUniqueOrThrow({ where: { id }, include: { product: true } });
  const window = windowFor(change.startDate, change.endDate, f.timezone);
  await withOverlapMessage(db, f.productId, window, f.id, () =>
    db.$transaction(async (tx) => {
      await tx.fundraiser.update({
        where: { id },
        data: {
          // A published banner shows the old end date/rate; the clock rewrites it.
          ...(f.bannerState === "on" ? { bannerState: "stale" } : {}),
          startDate: dateColumn(change.startDate),
          endDate: dateColumn(change.endDate),
          windowStart: window.start,
          windowEnd: window.end,
          payoutRateCents: change.payoutRateCents,
        },
      });
      await writeAudit(tx, {
        entity: "fundraiser",
        entityId: id,
        action: "change_dates_rate",
        before: preview.before,
        after: preview.after,
        reason: reason.trim(),
        actor,
      });
    }),
  );

  await reattributeProduct(db, f.product.shopifyProductId);
  const saved = await storedTotals(db, { id, payoutRateCents: change.payoutRateCents });
  return { preview, saved };
}

// ------------------------------------------------------------ statuses

export async function launchBlockersFor(db: PrismaClient, id: number): Promise<string[]> {
  const f = await db.fundraiser.findUniqueOrThrow({ where: { id }, include: { product: true } });
  return launchBlockers({
    checklist: checklistFrom(f),
    productStatus: f.product.status,
    productDeleted: !!f.product.deletedAt,
    hasDates: !!f.startDate && !!f.endDate,
    payoutRateCents: f.payoutRateCents,
    overlapping: await findOverlaps(db, f.productId, { start: f.windowStart, end: f.windowEnd }, f.id),
    storefrontEnabled: f.storefrontEnabled,
    shortLinkWritten: !!f.shortLinkRedirectId,
    bannerWritten: f.bannerState === "on",
  });
}

export interface TransitionOptions {
  reason?: string | null;
  actor: string;
  now?: Date;
}

/** Move a fundraiser along an allowed transition. The only code that sets status. */
export async function transitionFundraiser(
  db: PrismaClient,
  id: number,
  action: TransitionAction,
  options: TransitionOptions,
): Promise<Fundraiser> {
  const now = options.now ?? new Date();
  const f = await db.fundraiser.findUniqueOrThrow({ where: { id }, include: { product: true } });
  const check = canTransition(f.status, action, { now, windowStart: f.windowStart, reason: options.reason });
  if (!check.ok) throw new UserError(check.error);

  if (action === "approve_launch") {
    const blockers = await launchBlockersFor(db, id);
    if (blockers.length) throw new UserError(`Launch is blocked: ${blockers.join(" ")}`);
  }

  const data: { status: string; cancelledAt?: Date; cancelReason?: string } = { status: check.to };
  if (action === "cancel") {
    data.cancelledAt = now;
    data.cancelReason = options.reason!.trim();
  }

  const updated = await db.$transaction(async (tx) => {
    // Only moves if nobody else moved it first (safe to run twice).
    const result = await tx.fundraiser.updateMany({ where: { id, status: f.status }, data });
    if (result.count === 0) throw new UserError("This fundraiser was changed by someone else; reload and try again.");
    await writeAudit(tx, {
      entity: "fundraiser",
      entityId: id,
      action: `status:${action}`,
      before: { status: f.status },
      after: { status: check.to, ...(data.cancelledAt ? { cancelledAt: data.cancelledAt.toISOString() } : {}) },
      reason: options.reason?.trim() || null,
      actor: options.actor,
    });
    return tx.fundraiser.findUniqueOrThrow({ where: { id } });
  });

  // Cancelling shortens the window, so sales after this moment stop counting.
  if (action === "cancel") await reattributeProduct(db, f.product.shopifyProductId);
  return updated;
}

/** Used by the status clock: move every due fundraiser one step. Safe to repeat. */
export async function autoTransitionDue(
  db: PrismaClient,
  action: "start" | "end",
  now: Date,
): Promise<string[]> {
  const t = findTransition(action);
  const due = await db.fundraiser.findMany({
    where:
      action === "start"
        ? { status: { in: t.from }, windowStart: { lte: now } }
        : { status: { in: t.from }, windowEnd: { lte: now } },
    orderBy: { id: "asc" },
  });
  const moved: string[] = [];
  for (const f of due) {
    const changed = await db.$transaction(async (tx) => {
      const result = await tx.fundraiser.updateMany({ where: { id: f.id, status: f.status }, data: { status: t.to } });
      if (result.count === 0) return false;
      await writeAudit(tx, {
        entity: "fundraiser",
        entityId: f.id,
        action: `status:${action}`,
        before: { status: f.status },
        after: { status: t.to },
        reason: action === "start" ? "Start time passed" : "End time passed",
        actor: "clock",
      });
      return true;
    });
    if (changed) moved.push(f.publicCode);
  }
  return moved;
}

// ------------------------------------------------------------ checklist

export async function setChecklistItem(
  db: PrismaClient,
  id: number,
  key: ChecklistKey,
  done: boolean,
  actor: string,
  now = new Date(),
) {
  const f = await db.fundraiser.findUniqueOrThrow({ where: { id }, include: { product: true } });
  if (["paid", "declined"].includes(f.status)) throw new UserError("This fundraiser can't be edited.");
  if (done && key === "productReady") {
    if (f.product.status !== "ACTIVE" || f.product.deletedAt) {
      throw new UserError(`"${f.product.title}" isn't active in Shopify yet.`);
    }
    if (!hasFundraiserTag(f.product.tags)) {
      throw new UserError(`"${f.product.title}" doesn't have the "fundraiser" tag in Shopify yet.`);
    }
  }
  if (done && key === "organizerInfoReceived" && !f.paypalPayeeEmail) {
    throw new UserError("Add the PayPal payee email before ticking organizer info received.");
  }
  const item = CHECKLIST_ITEMS.find((i) => i.key === key)!;
  const before = checklistFrom(f)[key];
  await db.$transaction(async (tx) => {
    await tx.fundraiser.update({
      where: { id },
      data: { [`${key}At`]: done ? now : null, [`${key}By`]: done ? actor : null },
    });
    await writeAudit(tx, {
      entity: "fundraiser",
      entityId: id,
      action: done ? "checklist:done" : "checklist:undone",
      before: { item: item.label, at: before.at, by: before.by },
      after: { item: item.label, at: done ? now : null, by: done ? actor : null },
      actor,
    });
  });
}

export async function setWaitingOnOrganizer(db: PrismaClient, id: number, since: Date | null, actor: string) {
  const f = await db.fundraiser.findUniqueOrThrow({ where: { id } });
  await db.$transaction(async (tx) => {
    await tx.fundraiser.update({ where: { id }, data: { waitingOnOrganizerSince: since } });
    await writeAudit(tx, {
      entity: "fundraiser",
      entityId: id,
      action: since ? "waiting_on_organizer:set" : "waiting_on_organizer:cleared",
      before: { since: f.waitingOnOrganizerSince },
      after: { since },
      actor,
    });
  });
}

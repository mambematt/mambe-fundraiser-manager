// Scheduled jobs, called by the Render cron every 15 minutes:
//   - status clock: Scheduled → Active, Active → Settling (every run)
//   - nightly re-check: re-pull recently updated orders (once a night)
// Every run is logged in job_runs. Both jobs are safe to run twice.

import type { Prisma, PrismaClient } from "@prisma/client";
import { DateTime } from "luxon";
import { DEFAULT_TIMEZONE } from "../lib/window";
import { alert, alertError } from "./alerts.server";
import { autoTransitionDue } from "./fundraisers.server";
import { syncOrderFromShopify } from "./order-sync.server";
import type { ShopifyClient } from "./shopify-api.server";
import { queueEmail, sendDueCommunications } from "./communications.server";
import type { KlaviyoClient } from "./klaviyo.server";
import { syncStorefront } from "./storefront.server";

export type JobName = "clock" | "nightly";

const HOUR = 3600 * 1000;
/** Re-pull this much before the last successful run, in case of clock skew or slow writes. */
export const NIGHTLY_OVERLAP_MS = 48 * HOUR;
/** Alert if no webhook has arrived for this long while a fundraiser is Active. */
export const WEBHOOK_SILENCE_MS = 24 * HOUR;
/** The nightly re-check runs during this Pacific hour (retrying each 15 minutes if it fails). */
export const NIGHTLY_HOUR_PACIFIC = 3;

export interface JobResult {
  name: JobName;
  status: "succeeded" | "failed";
  details?: Record<string, unknown>;
  error?: string;
}

async function runJob(
  db: PrismaClient,
  name: JobName,
  now: Date,
  work: () => Promise<Record<string, unknown>>,
): Promise<JobResult> {
  // Stamped with the job's own clock, which the next run's look-back uses.
  const run = await db.jobRun.create({ data: { name, startedAt: now } });
  try {
    const details = await work();
    await db.jobRun.update({
      where: { id: run.id },
      data: { status: "succeeded", finishedAt: new Date(), details: details as Prisma.InputJsonValue },
    });
    return { name, status: "succeeded", details };
  } catch (error) {
    const message = String((error as Error)?.message ?? error).slice(0, 2000);
    await db.jobRun.update({
      where: { id: run.id },
      data: { status: "failed", finishedAt: new Date(), error: message },
    });
    alertError(error, `Scheduled job "${name}" failed`);
    return { name, status: "failed", error: message };
  }
}

// ------------------------------------------------------------ status clock

export interface ClockDeps {
  shopify?: ShopifyClient | null;
  klaviyo?: KlaviyoClient | null;
}

export async function runClock(db: PrismaClient, now = new Date(), deps: ClockDeps = {}): Promise<JobResult> {
  return runJob(db, "clock", now, async () => {
    // Order matters: a late run can move a fundraiser from Scheduled all the
    // way to Settling in one go.
    const started = await autoTransitionDue(db, "start", now);
    const ended = await autoTransitionDue(db, "end", now);
    const details: Record<string, unknown> = { started, ended };

    // "Fundraiser ended" email, once, for ended fundraisers with emails on.
    const needEnded = await db.fundraiser.findMany({
      where: { status: "settling", emailsEnabled: true, communications: { none: { kind: "ended" } } },
    });
    for (const f of needEnded) await queueEmail(db, f.id, "ended", now);

    // Banner on while Scheduled/Active, off after (the block also checks dates).
    if (deps.shopify) details.storefront = await syncStorefront(db, deps.shopify);
    if (deps.klaviyo) details.emails = await sendDueCommunications(db, deps.klaviyo, now);
    // TODO(settlement): Settling → Payout pending at end + 10 days, after a
    // successful full re-pull.
    return details;
  });
}

// --------------------------------------------------------- nightly re-check

export interface NightlyOptions {
  now?: Date;
}

export async function runNightlyRecheck(
  db: PrismaClient,
  shopify: ShopifyClient,
  options: NightlyOptions = {},
): Promise<JobResult> {
  const now = options.now ?? new Date();
  return runJob(db, "nightly", now, async () => {
    const lastOk = await db.jobRun.findFirst({
      where: { name: "nightly", status: "succeeded" },
      orderBy: { startedAt: "desc" },
    });
    const since = new Date((lastOk?.startedAt ?? now).getTime() - NIGHTLY_OVERLAP_MS);

    const updated = await shopify.listOrdersUpdatedSince(since);
    // Re-read only orders that touch a linked product, or that we already
    // keep (a linked product may have been removed from an order by an edit).
    const [linked, kept] = await Promise.all([
      db.product.findMany({ select: { shopifyProductId: true } }),
      db.shopifyOrder.findMany({ where: { shopifyOrderId: { in: updated.map((o) => o.id) } }, select: { shopifyOrderId: true } }),
    ]);
    const linkedIds = new Set(linked.map((p) => p.shopifyProductId));
    const keptIds = new Set(kept.map((o) => o.shopifyOrderId));
    const orderIds = updated
      .filter((o) => keptIds.has(o.id) || o.productIds === null || o.productIds.some((p) => linkedIds.has(p)))
      .map((o) => o.id);
    let saved = 0;
    const failures: Array<{ shopifyOrderId: string; error: string }> = [];
    for (const id of orderIds) {
      try {
        const result = await syncOrderFromShopify(db, shopify, id);
        if (result.status === "saved") saved += 1;
      } catch (error) {
        failures.push({ shopifyOrderId: id, error: String((error as Error)?.message ?? error) });
      }
    }

    const health = await webhookHealth(db, now);
    if (health.silent) {
      alert(
        `No Shopify webhook has arrived in the last 24 hours while ${health.activeFundraisers} fundraiser(s) are Active.`,
        { lastWebhookAt: health.lastWebhookAt },
      );
    }

    const details = {
      since: since.toISOString(),
      ordersUpdated: updated.length,
      ordersChecked: orderIds.length,
      ordersSaved: saved,
      failures,
      webhookSilence: health.silent,
      lastWebhookAt: health.lastWebhookAt,
    };
    if (failures.length) {
      // Everything else was saved; failing the run makes it alert and retry.
      throw Object.assign(new Error(`${failures.length} order(s) couldn't be re-checked: ${JSON.stringify(failures).slice(0, 500)}`), { details });
    }
    return details;
  });
}

export async function webhookHealth(db: PrismaClient, now: Date) {
  const [activeFundraisers, lastWebhook] = await Promise.all([
    db.fundraiser.count({ where: { status: "active" } }),
    db.webhookEvent.findFirst({ orderBy: { receivedAt: "desc" } }),
  ]);
  const lastWebhookAt = lastWebhook?.receivedAt.toISOString() ?? null;
  const silent =
    activeFundraisers > 0 &&
    (!lastWebhook || now.getTime() - lastWebhook.receivedAt.getTime() > WEBHOOK_SILENCE_MS);
  return { activeFundraisers, lastWebhookAt, silent };
}

/** Run the nightly re-check now? (3 AM Pacific, unless one already succeeded in the last 20 hours.) */
export async function nightlyIsDue(db: PrismaClient, now = new Date()): Promise<boolean> {
  if (DateTime.fromJSDate(now).setZone(DEFAULT_TIMEZONE).hour !== NIGHTLY_HOUR_PACIFIC) return false;
  const recent = await db.jobRun.findFirst({
    where: { name: "nightly", status: "succeeded", startedAt: { gte: new Date(now.getTime() - 20 * HOUR) } },
  });
  return !recent;
}

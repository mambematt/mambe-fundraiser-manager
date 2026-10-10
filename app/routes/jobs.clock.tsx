// Called by the Render cron job every 15 minutes:
//   curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://…/jobs/clock
// Runs the status clock every time, and the nightly re-check when it's due
// (or when called with ?nightly=force).
import { timingSafeEqual } from "node:crypto";
import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { flushAlerts } from "../services/alerts.server";
import { nightlyIsDue, runClock, runNightlyRecheck, type JobResult } from "../services/jobs.server";
import { shopifyClientForInstalledShop } from "../services/shopify-client.server";
import { createKlaviyoClient } from "../services/klaviyo.server";

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const given = Buffer.from(request.headers.get("Authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (!authorized(request)) return new Response("Unauthorized", { status: 401 });

  // The clock also keeps banners in line and sends due organizer emails. Each
  // fundraiser's switches decide whether anything is actually written or sent.
  const shopify = await shopifyClientForInstalledShop().catch(() => null);
  const klaviyo = process.env.KLAVIYO_API_KEY ? createKlaviyoClient() : null;
  const results: JobResult[] = [await runClock(db, new Date(), { shopify, klaviyo })];

  const force = new URL(request.url).searchParams.get("nightly") === "force";
  if (force || (await nightlyIsDue(db))) {
    results.push(await runNightlyRecheck(db, shopify ?? (await shopifyClientForInstalledShop())));
  }

  await flushAlerts();
  const failed = results.some((r) => r.status === "failed");
  return Response.json({ results }, { status: failed ? 500 : 200 });
};

export const loader = () => new Response("Method Not Allowed", { status: 405 });

// Status moves that also touch the store or send email. The admin page calls
// these; the plain status rules stay in fundraisers.server.ts.

import type { PrismaClient } from "@prisma/client";
import { UserError } from "../lib/errors";
import { cancelCommunications, planCommunications, queueEmail, sendCommunication } from "./communications.server";
import { transitionFundraiser } from "./fundraisers.server";
import type { KlaviyoClient } from "./klaviyo.server";
import type { ShopifyClient } from "./shopify-api.server";
import { clearBanner, publishStorefront } from "./storefront.server";

export interface Effects {
  shopify: ShopifyClient | null;
  klaviyo: KlaviyoClient | null;
}

/** Approve launch: storefront writes first (a failure blocks the launch), then the email plan. */
export async function approveLaunch(db: PrismaClient, effects: Effects, id: number, actor: string, now = new Date()) {
  const f = await db.fundraiser.findUniqueOrThrow({ where: { id } });
  if (f.storefrontEnabled) {
    if (!effects.shopify) throw new UserError("Can't reach Shopify to write the storefront items.");
    await publishStorefront(db, effects.shopify, id, actor);
  }
  const launched = await transitionFundraiser(db, id, "approve_launch", { actor, now });
  if (launched.emailsEnabled) {
    await planCommunications(db, id, now);
    const row = await queueEmail(db, id, "launch", now);
    // Best effort now; the clock retries within 15 minutes if this fails.
    if (effects.klaviyo) await sendCommunication(db, effects.klaviyo, row, actor, now);
  }
  return launched;
}

export async function cancelFundraiser(db: PrismaClient, effects: Effects, id: number, reason: string, actor: string, now = new Date()) {
  const cancelled = await transitionFundraiser(db, id, "cancel", { reason, actor, now });
  await cancelCommunications(db, id, "Fundraiser cancelled.");
  // The clock retries the clear if Shopify can't be reached now.
  if (effects.shopify) await clearBanner(db, effects.shopify, id, actor);
  return cancelled;
}

export async function backToSetup(db: PrismaClient, id: number, reason: string, actor: string, now = new Date()) {
  const f = await transitionFundraiser(db, id, "back_to_setup", { reason, actor, now });
  await cancelCommunications(db, id, "Moved back to Setup.");
  return f;
}

/** After dates change: re-plan unsent emails (the banner was marked stale). */
export async function afterDatesChanged(db: PrismaClient, id: number, now = new Date()) {
  await planCommunications(db, id, now);
}

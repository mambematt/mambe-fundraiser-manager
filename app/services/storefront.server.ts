// Writes to the live store: the /go/<slug> short link and the product banner
// metafield. Nothing is written unless the fundraiser's Storefront switch is on.

import type { Fundraiser, PrismaClient } from "@prisma/client";
import { UserError } from "../lib/errors";
import {
  bannerValue,
  defaultBannerTeamName,
  defaultSlug,
  normalizeSlug,
  productPath,
  shortLinkPath,
} from "../lib/storefront";
import { alertError } from "./alerts.server";
import { writeAudit } from "./audit.server";
import type { ShopifyClient } from "./shopify-api.server";

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

/** Statuses during which the banner should be on the product (the block also checks dates). */
const BANNER_STATUSES = new Set(["scheduled", "active"]);

async function load(db: PrismaClient, id: number) {
  return db.fundraiser.findUniqueOrThrow({
    where: { id },
    include: { product: true, team: { include: { organization: true } } },
  });
}

async function recordError(db: PrismaClient, id: number, error: unknown) {
  await db.fundraiser.update({
    where: { id },
    data: { storefrontError: String((error as Error)?.message ?? error).slice(0, 500), storefrontErrorAt: new Date() },
  });
}

export function slugFor(f: Pick<Fundraiser, "shortLinkSlug" | "publicCode">): string {
  return f.shortLinkSlug ?? defaultSlug(f.publicCode);
}

/** Edit the slug; only before the short link is written. */
export async function setShortLinkSlug(db: PrismaClient, id: number, slug: string, actor: string) {
  const f = await db.fundraiser.findUniqueOrThrow({ where: { id } });
  if (f.shortLinkRedirectId) throw new UserError("The short link is already live; its address can't change.");
  const clean = normalizeSlug(slug);
  if (!clean) throw new UserError("Enter a short link like ns-gsb.");
  const taken = await db.fundraiser.findFirst({ where: { shortLinkSlug: clean, id: { not: id } } });
  if (taken) throw new UserError(`/go/${clean} is already used by ${taken.publicCode}.`);
  await db.fundraiser.update({ where: { id }, data: { shortLinkSlug: clean } });
  await writeAudit(db, { entity: "fundraiser", entityId: id, action: "short_link:slug", before: { slug: slugFor(f) }, after: { slug: clean }, actor });
}

export async function setBannerTeamName(db: PrismaClient, id: number, name: string, actor: string) {
  const f = await db.fundraiser.findUniqueOrThrow({ where: { id } });
  const clean = name.trim() || null;
  await db.fundraiser.update({ where: { id }, data: { bannerTeamName: clean, ...(f.bannerState === "on" ? { bannerState: "stale" } : {}) } });
  await writeAudit(db, { entity: "fundraiser", entityId: id, action: "banner:team_name", before: { name: f.bannerTeamName }, after: { name: clean }, actor });
}

/** Write the short link (once) and the banner field now. Requires the Storefront switch. */
export async function publishStorefront(db: PrismaClient, shopify: ShopifyClient, id: number, actor: string) {
  const f = await load(db, id);
  if (!f.storefrontEnabled) throw new UserError("Turn on Storefront items first.");
  try {
    if (!f.shortLinkRedirectId) {
      const slug = slugFor(f);
      const taken = await db.fundraiser.findFirst({ where: { shortLinkSlug: slug, id: { not: id } } });
      if (taken) throw new UserError(`/go/${slug} is already used by ${taken.publicCode}; edit the short link first.`);
      const { id: redirectId } = await shopify.createRedirect(shortLinkPath(slug), productPath(f.product.handle));
      await db.fundraiser.update({
        where: { id },
        data: { shortLinkSlug: slug, shortLinkRedirectId: redirectId, shortLinkWrittenAt: new Date(), shortUrl: shortLinkPath(slug) },
      });
      await writeAudit(db, { entity: "fundraiser", entityId: id, action: "short_link:created", after: { path: shortLinkPath(slug), target: productPath(f.product.handle) }, actor });
    }
    const value = bannerValue({
      publicCode: f.publicCode,
      teamName: f.bannerTeamName ?? defaultBannerTeamName(f.team.organization.name, f.team.name),
      payoutRateCents: f.payoutRateCents,
      startDate: isoDate(f.startDate),
      endDate: isoDate(f.endDate),
    });
    await shopify.setProductBanner(f.product.shopifyProductId, value);
    await db.fundraiser.update({ where: { id }, data: { bannerState: "on", bannerWrittenAt: new Date(), storefrontError: null, storefrontErrorAt: null } });
    await writeAudit(db, { entity: "fundraiser", entityId: id, action: "banner:written", after: value, actor });
  } catch (error) {
    await recordError(db, id, error);
    if (error instanceof UserError) throw error;
    alertError(error, `Storefront write failed for ${f.publicCode}`);
    throw new UserError(`Shopify refused the storefront write: ${String((error as Error)?.message ?? error)}`);
  }
}

/** Remove the banner field. Safe to repeat. The short link stays (old flyers keep working). */
export async function clearBanner(db: PrismaClient, shopify: ShopifyClient, id: number, actor: string) {
  const f = await load(db, id);
  if (f.bannerState === "off") return;
  try {
    await shopify.clearProductBanner(f.product.shopifyProductId);
    await db.fundraiser.update({ where: { id }, data: { bannerState: "off", storefrontError: null, storefrontErrorAt: null } });
    await writeAudit(db, { entity: "fundraiser", entityId: id, action: "banner:cleared", actor });
  } catch (error) {
    await recordError(db, id, error);
    alertError(error, `Banner clear failed for ${f.publicCode}`);
  }
}

export async function setStorefrontEnabled(db: PrismaClient, shopify: ShopifyClient | null, id: number, enabled: boolean, actor: string) {
  const f = await db.fundraiser.findUniqueOrThrow({ where: { id } });
  if (f.storefrontEnabled === enabled) return;
  await db.fundraiser.update({ where: { id }, data: { storefrontEnabled: enabled } });
  await writeAudit(db, { entity: "fundraiser", entityId: id, action: enabled ? "switch:storefront_on" : "switch:storefront_off", actor });
  if (!shopify) return;
  if (!enabled) await clearBanner(db, shopify, id, actor);
}

/** Run by the clock: keep the banner field in line with each fundraiser's status. */
export async function syncStorefront(db: PrismaClient, shopify: ShopifyClient) {
  const published: string[] = [];
  const cleared: string[] = [];
  const failed: string[] = [];
  const candidates = await db.fundraiser.findMany({
    where: { OR: [{ storefrontEnabled: true }, { bannerState: { not: "off" } }] },
  });
  for (const f of candidates) {
    const wantOn = f.storefrontEnabled && BANNER_STATUSES.has(f.status);
    try {
      if (wantOn && (f.bannerState !== "on" || f.storefrontError)) {
        await publishStorefront(db, shopify, f.id, "clock");
        published.push(f.publicCode);
      } else if (!wantOn && f.bannerState !== "off") {
        await clearBanner(db, shopify, f.id, "clock");
        cleared.push(f.publicCode);
      }
    } catch {
      failed.push(f.publicCode);
    }
  }
  return { published, cleared, failed };
}

/** products/update with a new handle: point each short link at the new product address. */
export async function repointShortLinks(db: PrismaClient, shopify: ShopifyClient, productId: number, newHandle: string) {
  const fundraisers = await db.fundraiser.findMany({ where: { productId, shortLinkRedirectId: { not: null } } });
  for (const f of fundraisers) {
    try {
      await shopify.updateRedirect(f.shortLinkRedirectId!, productPath(newHandle));
      await writeAudit(db, {
        entity: "fundraiser",
        entityId: f.id,
        action: "short_link:repointed",
        after: { path: f.shortUrl, target: productPath(newHandle) },
        actor: "shopify",
      });
    } catch (error) {
      await recordError(db, f.id, error);
      alertError(error, `Short link for ${f.publicCode} couldn't follow the product's new address`);
    }
  }
}

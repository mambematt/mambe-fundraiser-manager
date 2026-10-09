// Linking Shopify products to the app, keeping them current, and backfilling
// their order history.

import type { PrismaClient } from "@prisma/client";
import { productLifetimeTotals, type ProductLifetimeTotals } from "../lib/attribution";
import { numericId } from "../lib/shopify-ids";
import type { ShopifyClient } from "./shopify-api.server";
import { syncOrderFromShopify } from "./order-sync.server";
import { UserError } from "../lib/errors";
import { writeAudit } from "./audit.server";
import { alert } from "./alerts.server";

export const FUNDRAISER_TAG = "fundraiser";

export function hasFundraiserTag(tags: string[]): boolean {
  return tags.some((t) => t.trim().toLowerCase() === FUNDRAISER_TAG);
}

/**
 * Accepts a numeric product ID, a gid://shopify/Product/… ID, or a Shopify
 * admin product URL, and returns the numeric ID.
 */
export function parseProductReference(input: string): string {
  const text = input.trim();
  const fromUrl = /\/products\/(\d+)/.exec(text);
  if (fromUrl) return fromUrl[1];
  try {
    return numericId(text);
  } catch {
    throw new UserError(`"${text}" isn't a Shopify product ID or product link.`);
  }
}

export interface LinkResult {
  productId: number;
  shopifyProductId: string;
  title: string;
  alreadyLinked: boolean;
  warnings: string[];
}

/** Product details an admin may edit in the app. */
export async function updateProductDetails(
  db: PrismaClient,
  id: number,
  input: { teamId: number | null; designNotes: string | null },
  actor: string,
) {
  const product = await db.product.findUniqueOrThrow({ where: { id } });
  if (product.teamId && input.teamId !== product.teamId) {
    const used = await db.fundraiser.count({ where: { productId: id } });
    if (used) throw new UserError("This product already has fundraisers for its team, so its team can't change.");
  }
  const after = { teamId: input.teamId, designNotes: input.designNotes?.trim() || null };
  await db.product.update({ where: { id }, data: after });
  await writeAudit(db, {
    entity: "product",
    entityId: id,
    action: "edit",
    before: { teamId: product.teamId, designNotes: product.designNotes },
    after,
    actor,
  });
}

export async function linkProduct(
  db: PrismaClient,
  shopify: ShopifyClient,
  reference: string,
  actor: string,
): Promise<LinkResult> {
  const shopifyProductId = parseProductReference(reference);
  const info = await shopify.fetchProduct(shopifyProductId);
  if (!info) throw new UserError(`No Shopify product with ID ${shopifyProductId}`);

  if (info.status !== "ACTIVE") {
    throw new UserError(`"${info.title}" is ${info.status.toLowerCase()} in Shopify. Only active products can be linked.`);
  }
  const warnings: string[] = [];
  if (!hasFundraiserTag(info.tags)) {
    warnings.push(
      `"${info.title}" doesn't have the tag "${FUNDRAISER_TAG}", so discount codes may not be blocked on it. Add the tag in Shopify.`,
    );
  }

  const existing = await db.product.findUnique({ where: { shopifyProductId } });
  const data = {
    handle: info.handle,
    title: info.title,
    status: info.status,
    tags: info.tags,
    lastSyncedAt: new Date(),
    deletedAt: null,
  };
  const product = await db.product.upsert({
    where: { shopifyProductId },
    create: { shopifyProductId, ...data },
    update: data,
  });
  if (!existing) {
    await writeAudit(db, {
      entity: "product",
      entityId: product.id,
      action: "link",
      after: { shopifyProductId, title: info.title, tags: info.tags },
      actor,
    });
  }
  return { productId: product.id, shopifyProductId, title: info.title, alreadyLinked: !!existing, warnings };
}

/** products/update: refresh title, handle, status and tags of a linked product. */
export async function refreshProduct(
  db: PrismaClient,
  shopify: ShopifyClient,
  shopifyProductId: string,
): Promise<"updated" | "not_linked" | "not_found"> {
  const existing = await db.product.findUnique({ where: { shopifyProductId } });
  if (!existing) return "not_linked";
  const info = await shopify.fetchProduct(shopifyProductId);
  if (!info) return "not_found";
  await db.product.update({
    where: { id: existing.id },
    data: {
      handle: info.handle,
      title: info.title,
      status: info.status,
      tags: info.tags,
      lastSyncedAt: new Date(),
    },
  });
  // Re-pointing the short link when the handle changes comes with short links (later step).
  if (existing.handle !== info.handle) {
    await writeAudit(db, {
      entity: "product",
      entityId: existing.id,
      action: "handle_changed",
      before: { handle: existing.handle },
      after: { handle: info.handle },
      actor: "shopify",
    });
  }
  return "updated";
}

/** products/delete: mark deleted; its order lines are kept. */
export async function markProductDeleted(
  db: PrismaClient,
  shopifyProductId: string,
): Promise<"deleted" | "not_linked"> {
  const existing = await db.product.findUnique({ where: { shopifyProductId } });
  if (!existing) return "not_linked";
  await db.product.update({
    where: { id: existing.id },
    data: { status: "DELETED", deletedAt: new Date() },
  });
  await writeAudit(db, {
    entity: "product",
    entityId: existing.id,
    action: "deleted_in_shopify",
    before: { status: existing.status },
    after: { status: "DELETED" },
    actor: "shopify",
  });
  return "deleted";
}

export async function lifetimeTotalsForProduct(
  db: PrismaClient,
  shopifyProductId: string,
): Promise<ProductLifetimeTotals> {
  const lines = await db.orderLineItem.findMany({
    where: { shopifyProductId },
    include: { order: { select: { cancelledAt: true, isTest: true, processedAt: true } } },
  });
  return productLifetimeTotals(
    lines.map((l) => ({
      orderId: l.orderId,
      processedAt: l.order.processedAt,
      unitPriceCents: l.unitPriceCents,
      discountCents: l.discountCents,
      quantity: l.quantity,
      refundedQuantity: l.refundedQuantity,
      currentQuantity: l.currentQuantity,
      outcome: l.outcome,
      qualifyingUnits: l.qualifyingUnits,
      orderCancelled: l.order.cancelledAt !== null,
      orderIsTest: l.order.isTest,
    })),
  );
}

export interface BackfillSummary {
  ordersFound: number;
  ordersSaved: number;
  failures: Array<{ shopifyOrderId: string; error: string }>;
  totals: ProductLifetimeTotals;
}

/** Load every historical order for a linked product. Lines get "cost approximate". */
export async function backfillProduct(
  db: PrismaClient,
  shopify: ShopifyClient,
  shopifyProductId: string,
  actor: string,
): Promise<BackfillSummary> {
  const product = await db.product.findUnique({ where: { shopifyProductId } });
  if (!product) throw new Error(`Product ${shopifyProductId} isn't linked`);

  const orderIds = await shopify.listOrderIdsForProduct(shopifyProductId);
  let ordersSaved = 0;
  const failures: BackfillSummary["failures"] = [];
  for (const id of orderIds) {
    try {
      const result = await syncOrderFromShopify(db, shopify, id, { costApproximate: true });
      if (result.status === "saved") ordersSaved += 1;
    } catch (error) {
      failures.push({ shopifyOrderId: id, error: String((error as Error).message ?? error) });
    }
  }

  const totals = await lifetimeTotalsForProduct(db, shopifyProductId);
  if (failures.length === 0) {
    await db.product.update({ where: { id: product.id }, data: { backfilledAt: new Date() } });
  }
  const summary = { ordersFound: orderIds.length, ordersSaved, failures, totals };
  if (failures.length) {
    alert(`Backfill of "${product.title}" missed ${failures.length} order(s)`, { failures: failures.slice(0, 5) });
  }
  await writeAudit(db, {
    entity: "product",
    entityId: product.id,
    action: failures.length ? "backfill_incomplete" : "backfill",
    after: summary,
    actor,
  });
  return summary;
}

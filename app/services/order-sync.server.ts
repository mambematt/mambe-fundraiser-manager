// Saves Shopify orders and their linked-product lines, then runs attribution.
// Safe to repeat: everything is an upsert keyed by Shopify ID.

import type { OrderLineItem, Prisma, PrismaClient, ShopifyOrder } from "@prisma/client";
import {
  attributeOrder,
  netUnits,
  type AdminDecision,
  type AttributedLine,
  type AttributionFundraiser,
  type AttributionLine,
  type LineAttribution,
  type LineOutcome,
  type OrderSource,
  type ReviewFlag,
  REVIEW_FLAG_LABELS,
} from "../lib/attribution";
import { normalizeOrder, type NormalizedLine, type NormalizedOrder } from "../lib/shopify-order";
import type { ShopifyClient } from "./shopify-api.server";
import { writeAudit } from "./audit.server";

type Tx = Prisma.TransactionClient;

export interface SyncOptions {
  /** Backfilled lines get today's cost and are marked approximate. */
  costApproximate?: boolean;
  now?: Date;
}

export type SyncResult =
  | { status: "saved"; orderId: number; linesSaved: number }
  | { status: "no_linked_lines" }
  | { status: "stale" }
  | { status: "not_found" };

/** Re-read an order from Shopify and save its current state. */
export async function syncOrderFromShopify(
  db: PrismaClient,
  shopify: ShopifyClient,
  shopifyOrderId: string,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const node = await shopify.fetchOrder(shopifyOrderId);
  if (!node) return { status: "not_found" };
  const { order, lines } = normalizeOrder(node);
  return saveOrder(db, order, lines, options);
}

/** Save one order's current state and re-run attribution for it. */
export async function saveOrder(
  db: PrismaClient,
  order: NormalizedOrder,
  lines: NormalizedLine[],
  options: SyncOptions = {},
): Promise<SyncResult> {
  const now = options.now ?? new Date();

  return db.$transaction(async (tx) => {
    // One writer per order at a time, so duplicate or out-of-order webhooks
    // processed together can't interleave.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"order:" + order.shopifyOrderId}))`;

    const existing = await tx.shopifyOrder.findUnique({
      where: { shopifyOrderId: order.shopifyOrderId },
    });
    // A slower request carrying an older copy of the order must not win.
    if (existing && existing.shopifyUpdatedAt > order.shopifyUpdatedAt) {
      return { status: "stale" } as const;
    }

    // Keep only lines whose product is in the products table.
    const productIds = [...new Set(lines.map((l) => l.shopifyProductId))];
    const linked = await tx.product.findMany({
      where: { shopifyProductId: { in: productIds } },
      select: { shopifyProductId: true },
    });
    const linkedIds = new Set(linked.map((p) => p.shopifyProductId));
    const keptLines = lines.filter((l) => linkedIds.has(l.shopifyProductId));

    if (keptLines.length === 0 && !existing) {
      return { status: "no_linked_lines" } as const;
    }

    const orderData = {
      name: order.name,
      processedAt: order.processedAt,
      financialStatus: order.financialStatus,
      cancelledAt: order.cancelledAt,
      sourceName: order.sourceName,
      source: order.source,
      discountCodes: order.discountCodes,
      hasMoneyOnlyRefund: order.hasMoneyOnlyRefund,
      isTest: order.isTest,
      shopifyUpdatedAt: order.shopifyUpdatedAt,
      lastSyncedAt: now,
    };
    const saved = await tx.shopifyOrder.upsert({
      where: { shopifyOrderId: order.shopifyOrderId },
      create: { shopifyOrderId: order.shopifyOrderId, ...orderData },
      update: orderData,
    });

    for (const line of keptLines) {
      const changing = {
        shopifyVariantId: line.shopifyVariantId,
        quantity: line.quantity,
        refundedQuantity: line.refundedQuantity,
        currentQuantity: line.currentQuantity,
        unitPriceCents: line.unitPriceCents,
        discountCents: line.discountCents,
      };
      await tx.orderLineItem.upsert({
        where: { shopifyLineItemId: line.shopifyLineItemId },
        create: {
          shopifyLineItemId: line.shopifyLineItemId,
          orderId: saved.id,
          shopifyProductId: line.shopifyProductId,
          ...changing,
          // Cost is recorded on first save only and never overwritten.
          unitCostCents: line.currentUnitCostCents,
          costApproximate: options.costApproximate ?? false,
        },
        update: changing,
      });
    }

    await attributeSavedOrder(tx, saved.id, now);
    return { status: "saved", orderId: saved.id, linesSaved: keptLines.length } as const;
  });
}

function storedAttribution(line: {
  attributedFundraiserId: number | null;
  qualifyingUnits: number;
  outcome: string;
  reviewFlags: string[];
  quantity: number;
  refundedQuantity: number;
  currentQuantity: number;
}): LineAttribution {
  return {
    fundraiserId: line.attributedFundraiserId,
    netUnits: netUnits(line),
    qualifyingUnits: line.qualifyingUnits,
    outcome: line.outcome as LineOutcome,
    flags: line.reviewFlags as ReviewFlag[],
  };
}

type OrderWithLines = ShopifyOrder & { lineItems: OrderLineItem[] };

/** Every non-declined fundraiser on the given products, as the engine needs them. */
export async function loadFundraisersForProducts(
  tx: Tx | PrismaClient,
  shopifyProductIds: string[],
): Promise<AttributionFundraiser[]> {
  const fundraisers = await tx.fundraiser.findMany({
    where: { status: { not: "declined" }, product: { shopifyProductId: { in: shopifyProductIds } } },
    include: { product: { select: { shopifyProductId: true } } },
  });
  return fundraisers.map((f) => ({
    id: f.id,
    shopifyProductId: f.product.shopifyProductId,
    status: f.status,
    windowStart: f.windowStart,
    windowEnd: f.windowEnd,
    cancelledAt: f.cancelledAt,
  }));
}

/**
 * Feed one saved order to the attribution engine. Used both to store results
 * and to preview a date/rate change, so the two can never disagree.
 */
export function runEngineOnOrder(order: OrderWithLines, fundraisers: AttributionFundraiser[]): AttributedLine[] {
  const inputs: AttributionLine[] = order.lineItems.map((l) => ({
    key: String(l.id),
    shopifyProductId: l.shopifyProductId,
    quantity: l.quantity,
    refundedQuantity: l.refundedQuantity,
    currentQuantity: l.currentQuantity,
    discountCents: l.discountCents,
    adminDecision: (l.adminDecision as AdminDecision | null) ?? null,
    locked: l.locked,
    current: storedAttribution(l),
  }));
  return attributeOrder(
    {
      processedAt: order.processedAt,
      cancelledAt: order.cancelledAt,
      financialStatus: order.financialStatus,
      source: order.source as OrderSource,
      hasMoneyOnlyRefund: order.hasMoneyOnlyRefund,
    },
    inputs,
    fundraisers,
  );
}

/** Run the attribution engine over one saved order and store the results. */
export async function attributeSavedOrder(tx: Tx, orderId: number, now = new Date()) {
  const order = await tx.shopifyOrder.findUniqueOrThrow({
    where: { id: orderId },
    include: { lineItems: { orderBy: { id: "asc" } } },
  });
  if (order.lineItems.length === 0) return;

  const productIds = [...new Set(order.lineItems.map((l) => l.shopifyProductId))];
  const results = runEngineOnOrder(order, await loadFundraisersForProducts(tx, productIds));

  for (const result of results) {
    const line = order.lineItems.find((l) => String(l.id) === result.key)!;
    if (line.locked) continue;
    const before = storedAttribution(line);
    const changed =
      line.outcome === "pending" ||
      before.fundraiserId !== result.fundraiserId ||
      before.qualifyingUnits !== result.qualifyingUnits ||
      before.outcome !== result.outcome ||
      before.flags.join(",") !== result.flags.join(",");
    if (!changed) continue;

    await tx.orderLineItem.update({
      where: { id: line.id },
      data: {
        attributedFundraiserId: result.fundraiserId,
        qualifyingUnits: result.qualifyingUnits,
        outcome: result.outcome,
        reviewFlags: result.flags,
        reviewReason: result.flags.map((f) => REVIEW_FLAG_LABELS[f]).join("; ") || null,
        attributedAt: now,
      },
    });
    await writeAudit(tx, {
      entity: "order_line_item",
      entityId: line.id,
      action: "attribution",
      before: line.outcome === "pending" ? null : before,
      after: { ...result, key: undefined },
      actor: "system",
    });
  }
}

/** Re-run attribution for every saved order containing a product. */
export async function reattributeProduct(db: PrismaClient, shopifyProductId: string) {
  const orders = await db.shopifyOrder.findMany({
    where: { lineItems: { some: { shopifyProductId } } },
    select: { id: true },
  });
  for (const { id } of orders) {
    await db.$transaction((tx) => attributeSavedOrder(tx, id));
  }
  return orders.length;
}

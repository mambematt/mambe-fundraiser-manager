// Webhook pipeline. The route verifies Shopify's signature, then:
//   1. recordWebhookEvent()  – save it; a duplicate webhook ID is a no-op
//   2. reply 200
//   3. processWebhookEvent() – re-read current state from Shopify, upsert, attribute
// Failures retry a few times, then stay as status "failed" (shown as sync
// errors). The nightly re-check is the backstop.

import { Prisma, type PrismaClient } from "@prisma/client";
import type { ShopifyClient } from "./shopify-api.server";
import { syncOrderFromShopify } from "./order-sync.server";
import { markProductDeleted, refreshProduct } from "./products.server";

export const ORDER_TOPICS = new Set([
  "ORDERS_CREATE",
  "ORDERS_UPDATED",
  "ORDERS_PAID",
  "ORDERS_CANCELLED",
  "REFUNDS_CREATE",
]);
export const PRODUCT_TOPICS = new Set(["PRODUCTS_UPDATE", "PRODUCTS_DELETE"]);

/** Normalizes "orders/create" or "ORDERS_CREATE" to "ORDERS_CREATE". */
export function normalizeTopic(topic: string): string {
  return topic.replace(/\//g, "_").toUpperCase();
}

/** The Shopify order or product ID a webhook is about. */
export function resourceIdFor(
  topic: string,
  payload: { id?: unknown; order_id?: unknown } | null | undefined,
): string | null {
  const t = normalizeTopic(topic);
  if (t === "REFUNDS_CREATE") return payload?.order_id != null ? String(payload.order_id) : null;
  if (ORDER_TOPICS.has(t) || PRODUCT_TOPICS.has(t)) {
    return payload?.id != null ? String(payload.id) : null;
  }
  return null;
}

export interface RecordedEvent {
  duplicate: boolean;
  eventId: number | null;
}

export async function recordWebhookEvent(
  db: PrismaClient,
  event: { webhookId: string; topic: string; shop: string; resourceId: string | null },
): Promise<RecordedEvent> {
  try {
    const row = await db.webhookEvent.create({
      data: {
        webhookId: event.webhookId,
        topic: normalizeTopic(event.topic),
        shop: event.shop,
        resourceId: event.resourceId,
      },
    });
    return { duplicate: false, eventId: row.id };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { duplicate: true, eventId: null };
    }
    throw error;
  }
}

async function handle(db: PrismaClient, shopify: ShopifyClient, topic: string, resourceId: string) {
  if (ORDER_TOPICS.has(topic)) {
    return (await syncOrderFromShopify(db, shopify, resourceId)).status;
  }
  if (topic === "PRODUCTS_UPDATE") return refreshProduct(db, shopify, resourceId);
  if (topic === "PRODUCTS_DELETE") return markProductDeleted(db, resourceId);
  return "ignored";
}

export interface ProcessOptions {
  maxAttempts?: number;
  retryDelayMs?: (attempt: number) => number;
}

export async function processWebhookEvent(
  db: PrismaClient,
  shopify: ShopifyClient,
  eventId: number,
  options: ProcessOptions = {},
): Promise<"processed" | "ignored" | "failed"> {
  const maxAttempts = options.maxAttempts ?? 3;
  const delay = options.retryDelayMs ?? ((attempt) => 2000 * attempt * attempt);
  const event = await db.webhookEvent.findUniqueOrThrow({ where: { id: eventId } });

  if (!event.resourceId) {
    await db.webhookEvent.update({
      where: { id: eventId },
      data: { status: "ignored", processedAt: new Date() },
    });
    return "ignored";
  }

  let lastError = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const outcome = await handle(db, shopify, event.topic, event.resourceId);
      const ignored = outcome === "ignored" || outcome === "no_linked_lines" || outcome === "not_linked";
      await db.webhookEvent.update({
        where: { id: eventId },
        data: {
          status: ignored ? "ignored" : "processed",
          attempts: attempt,
          error: null,
          processedAt: new Date(),
        },
      });
      return ignored ? "ignored" : "processed";
    } catch (error) {
      lastError = String((error as Error)?.stack ?? error).slice(0, 2000);
      await db.webhookEvent.update({
        where: { id: eventId },
        data: { attempts: attempt, error: lastError },
      });
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delay(attempt)));
      }
    }
  }
  await db.webhookEvent.update({ where: { id: eventId }, data: { status: "failed" } });
  console.error(`Webhook event ${eventId} (${event.topic} ${event.resourceId}) failed: ${lastError}`);
  return "failed";
}

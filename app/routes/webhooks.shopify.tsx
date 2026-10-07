// Receives every order and product webhook (see shopify.app.toml).
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  processWebhookEvent,
  recordWebhookEvent,
  resourceIdFor,
} from "../services/webhooks.server";
import { shopifyClientForShop } from "../services/shopify-client.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  // 1. Verify the HMAC. Throws a 401 response for anything unsigned or forged.
  const { topic, shop, payload, webhookId } = await authenticate.webhook(request);

  // 2. Save the event. A duplicate webhook ID is a no-op.
  const recorded = await recordWebhookEvent(db, {
    webhookId,
    topic,
    shop,
    resourceId: resourceIdFor(topic, payload),
  });

  // 4–7. Re-read from Shopify, upsert, attribute — after replying.
  if (!recorded.duplicate && recorded.eventId !== null) {
    const eventId = recorded.eventId;
    void (async () => {
      try {
        const shopify = await shopifyClientForShop(shop);
        await processWebhookEvent(db, shopify, eventId);
      } catch (error) {
        console.error(`Webhook event ${eventId} could not start processing`, error);
        await db.webhookEvent
          .update({
            where: { id: eventId },
            data: { status: "failed", error: String((error as Error)?.stack ?? error).slice(0, 2000) },
          })
          .catch(() => {});
      }
    })();
  }

  // 3. Reply 200 right away.
  return new Response();
};

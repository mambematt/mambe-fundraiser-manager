import { unauthenticated } from "../shopify.server";
import { createShopifyClient, graphqlRunnerFromAdmin, type ShopifyClient } from "./shopify-api.server";

/** A Shopify client using the shop's stored offline session (for background work). */
export async function shopifyClientForShop(shop: string): Promise<ShopifyClient> {
  const { admin } = await unauthenticated.admin(shop);
  return createShopifyClient(graphqlRunnerFromAdmin(admin));
}

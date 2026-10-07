import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { createShopifyClient, graphqlRunnerFromAdmin, type ShopifyClient } from "./shopify-api.server";

/** A Shopify client using the shop's stored offline session (for background work). */
export async function shopifyClientForShop(shop: string): Promise<ShopifyClient> {
  const { admin } = await unauthenticated.admin(shop);
  return createShopifyClient(graphqlRunnerFromAdmin(admin));
}

/** For scheduled jobs: the one shop this app is installed on. */
export async function shopifyClientForInstalledShop(): Promise<ShopifyClient> {
  const session = await db.session.findFirst({ where: { isOnline: false } });
  if (!session) throw new Error("The app isn't installed on any shop (no offline session).");
  return shopifyClientForShop(session.shop);
}

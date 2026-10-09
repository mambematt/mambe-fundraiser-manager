// Links from the embedded admin into Shopify. "shopify://admin/…" links open
// the page inside Shopify admin from an embedded app.

import { numericId } from "./shopify-ids";

export function adminOrderUrl(shopifyOrderId: string | number): string {
  return `shopify://admin/orders/${numericId(shopifyOrderId)}`;
}

export function adminProductUrl(shopifyProductId: string | number): string {
  return `shopify://admin/products/${numericId(shopifyProductId)}`;
}

/** The product's page on the online store. The myshopify domain redirects to the primary domain. */
export function storefrontProductUrl(shopDomain: string, handle: string): string {
  return `https://${shopDomain}/products/${encodeURIComponent(handle)}`;
}

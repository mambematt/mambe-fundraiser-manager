// Shopify GraphQL IDs look like "gid://shopify/Order/5551234567890".
// The database stores just the numeric part.

export function numericId(gidOrId: string | number): string {
  const text = String(gidOrId).trim();
  const match = /(\d+)$/.exec(text);
  if (!match) throw new Error(`Not a Shopify ID: ${text}`);
  return match[1];
}

export function toGid(type: "Order" | "Product" | "ProductVariant" | "LineItem", id: string | number): string {
  return `gid://shopify/${type}/${numericId(id)}`;
}

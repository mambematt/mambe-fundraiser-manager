import type { ShopifyClient } from "../../app/services/shopify-api.server";

export interface ShopifyWrite {
  op: "setBanner" | "clearBanner" | "createRedirect" | "updateRedirect";
  args: unknown[];
}

/** A Shopify client that reads nothing and records every write. */
export function fakeShopify(overrides: Partial<ShopifyClient> = {}): ShopifyClient & { writes: ShopifyWrite[] } {
  const writes: ShopifyWrite[] = [];
  let redirectSeq = 1;
  return {
    writes,
    fetchOrder: async () => null,
    fetchProduct: async () => null,
    listOrderIdsForProduct: async () => [],
    listOrdersUpdatedSince: async () => [],
    searchProducts: async () => [],
    setProductBanner: async (...args) => void writes.push({ op: "setBanner", args }),
    clearProductBanner: async (...args) => void writes.push({ op: "clearBanner", args }),
    createRedirect: async (...args) => {
      writes.push({ op: "createRedirect", args });
      return { id: `gid://shopify/UrlRedirect/${redirectSeq++}` };
    },
    updateRedirect: async (...args) => void writes.push({ op: "updateRedirect", args }),
    ...overrides,
  };
}

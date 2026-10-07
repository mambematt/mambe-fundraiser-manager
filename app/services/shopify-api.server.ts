// Reads from the Shopify Admin GraphQL API. Everything that talks to Shopify
// goes through a ShopifyClient so tests can swap in a fake.

import type { ShopifyOrderNode } from "../lib/shopify-order";
import { numericId, toGid } from "../lib/shopify-ids";

// GraphQL response data; shapes are checked where each query is used.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GraphqlData = any;

/** Runs a GraphQL query and returns its `data`, throwing on errors. */
export type GraphqlRunner = (
  query: string,
  variables?: Record<string, unknown>,
) => Promise<GraphqlData>;

export interface ShopifyProductInfo {
  shopifyProductId: string;
  handle: string;
  title: string;
  status: string;
  tags: string[];
}

export interface ShopifyClient {
  fetchOrder(shopifyOrderId: string): Promise<ShopifyOrderNode | null>;
  fetchProduct(shopifyProductId: string): Promise<ShopifyProductInfo | null>;
  /** Every order ID containing the product, oldest first. */
  listOrderIdsForProduct(shopifyProductId: string): Promise<string[]>;
  /** Every order ID updated at or after `since`. */
  listOrderIdsUpdatedSince(since: Date): Promise<string[]>;
  /** Products whose title matches the words typed. */
  searchProducts(text: string): Promise<ShopifyProductInfo[]>;
}

/** "central lacrosse" → title:central* AND title:lacrosse* */
export function productSearchQuery(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);
  return words.map((w) => `title:${w}*`).join(" AND ");
}

// Only order and line fields the app needs. No customer fields, on purpose.
export const ORDER_QUERY = `#graphql
  query FundraiserOrder($id: ID!) {
    order(id: $id) {
      id
      name
      processedAt
      updatedAt
      cancelledAt
      displayFinancialStatus
      sourceName
      test
      discountCodes
      refunds(first: 50) {
        id
        totalRefundedSet { shopMoney { amount } }
        refundLineItems(first: 100) {
          nodes { quantity lineItem { id } }
          pageInfo { hasNextPage }
        }
      }
      lineItems(first: 100) {
        nodes {
          id
          quantity
          currentQuantity
          product { id }
          variant { id inventoryItem { unitCost { amount } } }
          originalUnitPriceSet { shopMoney { amount } }
          totalDiscountSet { shopMoney { amount } }
        }
        pageInfo { hasNextPage }
      }
    }
  }`;

export const PRODUCT_QUERY = `#graphql
  query FundraiserProduct($id: ID!) {
    product(id: $id) {
      id
      handle
      title
      status
      tags
    }
  }`;

// product_id is an accepted (if lightly documented) order search filter. The
// sync code keeps only lines for linked products anyway, so if Shopify ever
// ignored the filter the results would still be correct, just slower.
export const ORDER_IDS_FOR_PRODUCT_QUERY = `#graphql
  query FundraiserOrderIdsForProduct($query: String!, $after: String) {
    orders(first: 100, after: $after, query: $query, sortKey: PROCESSED_AT) {
      nodes { id }
      pageInfo { hasNextPage endCursor }
    }
  }`;

export const PRODUCT_SEARCH_QUERY = `#graphql
  query FundraiserProductSearch($query: String!) {
    products(first: 25, query: $query, sortKey: TITLE) {
      nodes { id title handle status tags }
    }
  }`;

export const ORDER_IDS_UPDATED_SINCE_QUERY = `#graphql
  query FundraiserOrdersUpdatedSince($query: String!, $after: String) {
    orders(first: 100, after: $after, query: $query, sortKey: UPDATED_AT) {
      nodes { id }
      pageInfo { hasNextPage endCursor }
    }
  }`;

const MAX_ATTEMPTS = 5;

function isThrottled(error: unknown): boolean {
  const text = JSON.stringify(error ?? "") + String((error as Error)?.message ?? "");
  return /THROTTLED|Throttled|429/.test(text);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wraps the Shopify app library's admin.graphql() into a GraphqlRunner. */
export function graphqlRunnerFromAdmin(admin: {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
}): GraphqlRunner {
  return async (query, variables) => {
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await admin.graphql(query, { variables });
        const body = await response.json();
        if (body.errors?.length) {
          throw Object.assign(new Error(`Shopify GraphQL error: ${JSON.stringify(body.errors)}`), {
            errors: body.errors,
          });
        }
        return body.data;
      } catch (error) {
        if (attempt < MAX_ATTEMPTS && isThrottled(error)) {
          await sleep(1000 * attempt);
          continue;
        }
        throw error;
      }
    }
  };
}

export function createShopifyClient(run: GraphqlRunner): ShopifyClient {
  return {
    async fetchOrder(shopifyOrderId) {
      const data = await run(ORDER_QUERY, { id: toGid("Order", shopifyOrderId) });
      return (data?.order as ShopifyOrderNode | null) ?? null;
    },

    async fetchProduct(shopifyProductId) {
      const data = await run(PRODUCT_QUERY, { id: toGid("Product", shopifyProductId) });
      const product = data?.product;
      if (!product) return null;
      return {
        shopifyProductId: numericId(product.id),
        handle: product.handle,
        title: product.title,
        status: product.status,
        tags: product.tags ?? [],
      };
    },

    async listOrderIdsForProduct(shopifyProductId) {
      const ids: string[] = [];
      let after: string | null = null;
      do {
        const data = await run(ORDER_IDS_FOR_PRODUCT_QUERY, {
          query: `product_id:${numericId(shopifyProductId)}`,
          after,
        });
        for (const node of data.orders.nodes) ids.push(numericId(node.id));
        after = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
      } while (after);
      return ids;
    },

    async listOrderIdsUpdatedSince(since) {
      const ids: string[] = [];
      let after: string | null = null;
      do {
        const data = await run(ORDER_IDS_UPDATED_SINCE_QUERY, {
          query: `updated_at:>='${since.toISOString()}'`,
          after,
        });
        for (const node of data.orders.nodes) ids.push(numericId(node.id));
        after = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
      } while (after);
      return ids;
    },

    async searchProducts(text) {
      const query = productSearchQuery(text);
      if (!query) return [];
      const data = await run(PRODUCT_SEARCH_QUERY, { query });
      return data.products.nodes.map((p: { id: string; handle: string; title: string; status: string; tags: string[] }) => ({
        shopifyProductId: numericId(p.id),
        handle: p.handle,
        title: p.title,
        status: p.status,
        tags: p.tags ?? [],
      }));
    },
  };
}

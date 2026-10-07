// Converts an order read from the Shopify Admin GraphQL API into the minimal
// copy the app keeps. Pure; no customer names, emails or addresses are read.

import type { OrderSource } from "./attribution";
import { decimalToCents } from "./money";
import { numericId } from "./shopify-ids";

interface MoneyBag {
  shopMoney: { amount: string };
}

/** Shape returned by ORDER_FIELDS in app/services/shopify-api.server.ts. */
export interface ShopifyOrderNode {
  id: string;
  name: string;
  processedAt: string;
  updatedAt: string;
  cancelledAt: string | null;
  displayFinancialStatus: string | null;
  sourceName: string | null;
  test: boolean;
  discountCodes: string[];
  refunds: Array<{
    id: string;
    totalRefundedSet: MoneyBag;
    refundLineItems: {
      nodes: Array<{ quantity: number; lineItem: { id: string } }>;
      pageInfo?: { hasNextPage: boolean };
    };
  }>;
  lineItems: {
    nodes: Array<{
      id: string;
      quantity: number;
      currentQuantity: number;
      product: { id: string } | null;
      variant: {
        id: string;
        inventoryItem: { unitCost: { amount: string } | null } | null;
      } | null;
      originalUnitPriceSet: MoneyBag;
      totalDiscountSet: MoneyBag;
    }>;
    pageInfo?: { hasNextPage: boolean };
  };
}

export interface NormalizedOrder {
  shopifyOrderId: string;
  name: string;
  processedAt: Date;
  financialStatus: string;
  cancelledAt: Date | null;
  sourceName: string | null;
  source: OrderSource;
  discountCodes: string[];
  hasMoneyOnlyRefund: boolean;
  isTest: boolean;
  shopifyUpdatedAt: Date;
}

export interface NormalizedLine {
  shopifyLineItemId: string;
  shopifyProductId: string;
  shopifyVariantId: string | null;
  quantity: number;
  refundedQuantity: number;
  currentQuantity: number;
  unitPriceCents: number;
  discountCents: number;
  /** The variant's cost per item right now; null if not set in Shopify. */
  currentUnitCostCents: number | null;
}

export function orderSource(sourceName: string | null): OrderSource {
  switch (sourceName) {
    case "web":
      return "web";
    case "pos":
      return "pos";
    case "shopify_draft_order":
      return "draft";
    default:
      return "other";
  }
}

export function normalizeOrder(node: ShopifyOrderNode): {
  order: NormalizedOrder;
  lines: NormalizedLine[];
} {
  if (node.lineItems.pageInfo?.hasNextPage) {
    throw new Error(`Order ${node.name} has more line items than one page; not supported`);
  }

  const refundedByLine = new Map<string, number>();
  let hasMoneyOnlyRefund = false;
  for (const refund of node.refunds ?? []) {
    let refundUnits = 0;
    for (const item of refund.refundLineItems.nodes) {
      const lineId = numericId(item.lineItem.id);
      refundedByLine.set(lineId, (refundedByLine.get(lineId) ?? 0) + item.quantity);
      refundUnits += item.quantity;
    }
    if (refundUnits === 0 && decimalToCents(refund.totalRefundedSet.shopMoney.amount) > 0) {
      hasMoneyOnlyRefund = true;
    }
  }

  const order: NormalizedOrder = {
    shopifyOrderId: numericId(node.id),
    name: node.name,
    processedAt: new Date(node.processedAt),
    financialStatus: node.displayFinancialStatus ?? "UNKNOWN",
    cancelledAt: node.cancelledAt ? new Date(node.cancelledAt) : null,
    sourceName: node.sourceName,
    source: orderSource(node.sourceName),
    discountCodes: node.discountCodes ?? [],
    hasMoneyOnlyRefund,
    isTest: node.test,
    shopifyUpdatedAt: new Date(node.updatedAt),
  };

  const lines: NormalizedLine[] = [];
  for (const item of node.lineItems.nodes) {
    // A line whose product was deleted in Shopify comes back with no product.
    // It can't be matched here; lines saved earlier are kept as they are.
    if (!item.product) continue;
    const lineId = numericId(item.id);
    const cost = item.variant?.inventoryItem?.unitCost?.amount;
    lines.push({
      shopifyLineItemId: lineId,
      shopifyProductId: numericId(item.product.id),
      shopifyVariantId: item.variant ? numericId(item.variant.id) : null,
      quantity: item.quantity,
      refundedQuantity: refundedByLine.get(lineId) ?? 0,
      currentQuantity: item.currentQuantity,
      unitPriceCents: decimalToCents(item.originalUnitPriceSet.shopMoney.amount),
      discountCents: decimalToCents(item.totalDiscountSet.shopMoney.amount),
      currentUnitCostCents: cost === undefined || cost === null ? null : decimalToCents(cost),
    });
  }

  return { order, lines };
}

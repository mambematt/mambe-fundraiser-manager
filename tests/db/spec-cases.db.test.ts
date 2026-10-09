// Spec cases that need the real database (Postgres, real migrations).
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { normalizeOrder, type ShopifyOrderNode } from "../../app/lib/shopify-order";
import { saveOrder } from "../../app/services/order-sync.server";
import type { ShopifyClient } from "../../app/services/shopify-api.server";
import {
  processWebhookEvent,
  recordWebhookEvent,
} from "../../app/services/webhooks.server";
import { insertFundraiser, resetDb, seedTeamAndProduct, testDb } from "../helpers/db";
import { CAPE, pt, shopifyOrderNode } from "../helpers/fixtures";

const db = testDb();

/** A fake Shopify that returns whatever order state the test sets. */
function fakeShopify(state: { order: ShopifyOrderNode | null }): ShopifyClient {
  return {
    fetchOrder: async () => state.order,
    fetchProduct: async () => null,
    listOrderIdsForProduct: async () => [],
    listOrdersUpdatedSince: async () => (state.order ? [{ id: state.order.id.split("/").pop()!, productIds: null }] : []),
    searchProducts: async () => [],
  };
}

async function deliver(shopify: ShopifyClient, webhookId: string, topic: string, orderId: string) {
  const recorded = await recordWebhookEvent(db, { webhookId, topic, shop: "dev.myshopify.com", resourceId: orderId });
  if (!recorded.duplicate) {
    await processWebhookEvent(db, shopify, recorded.eventId!, { retryDelayMs: () => 0 });
  }
  return recorded;
}

beforeEach(resetDb);
afterAll(() => db.$disconnect());

describe("Attribution and payout test cases that need the database (spec)", () => {
  test("Case 9: 3 duplicate webhooks, refund webhook before create → counted once with final units", async () => {
    const { team, product } = await seedTeamAndProduct(CAPE);
    await insertFundraiser({ publicCode: "CHS-GLAX-F26", teamId: team.id, productId: product.id, startDate: "2026-10-01", endDate: "2026-10-31" });

    // Shopify's current state: 3 capes, 1 refunded by quantity.
    const finalState = shopifyOrderNode({
      id: "9001",
      financialStatus: "PARTIALLY_REFUNDED",
      updatedAt: new Date("2026-10-16T18:00:00Z"),
      refunds: [{ amount: "195.00", lines: [{ lineId: "501", quantity: 1 }] }],
      lines: [{ id: "501", productId: CAPE, quantity: 3, currentQuantity: 2 }],
    });
    const shopify = fakeShopify({ order: finalState });

    // The refund webhook arrives first...
    await deliver(shopify, "wh-refund-1", "refunds/create", "9001");
    // ...then the create webhook, delivered three times with the same ID.
    const first = await deliver(shopify, "wh-create-1", "orders/create", "9001");
    const second = await deliver(shopify, "wh-create-1", "orders/create", "9001");
    const third = await deliver(shopify, "wh-create-1", "orders/create", "9001");
    expect([first.duplicate, second.duplicate, third.duplicate]).toEqual([false, true, true]);

    expect(await db.webhookEvent.count()).toBe(2);
    expect(await db.shopifyOrder.count()).toBe(1);
    const lines = await db.orderLineItem.findMany();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ quantity: 3, refundedQuantity: 1, qualifyingUnits: 2, outcome: "qualifying" });

    // A late, older copy of the order (e.g. a slow orders/create) can't undo the refund.
    const older = shopifyOrderNode({
      id: "9001",
      updatedAt: new Date("2026-10-15T20:00:00Z"),
      lines: [{ id: "501", productId: CAPE, quantity: 3 }],
    });
    const parsed = normalizeOrder(older);
    expect((await saveOrder(db, parsed.order, parsed.lines)).status).toBe("stale");
    expect((await db.orderLineItem.findFirstOrThrow()).qualifyingUnits).toBe(2);

    // The line item ID is unique in the database itself.
    const order = await db.shopifyOrder.findFirstOrThrow();
    await expect(
      db.orderLineItem.create({
        data: { shopifyLineItemId: "501", orderId: order.id, shopifyProductId: CAPE, quantity: 1, currentQuantity: 1, unitPriceCents: 19500 },
      }),
    ).rejects.toThrow();
  });

  test("Case 16: second fundraiser on the same product for Oct 15–Nov 15 → refused (overlap)", async () => {
    const { team, product } = await seedTeamAndProduct(CAPE);
    await insertFundraiser({ publicCode: "CHS-GLAX-F26", teamId: team.id, productId: product.id, startDate: "2026-10-01", endDate: "2026-10-31" });

    await expect(
      insertFundraiser({ publicCode: "CHS-GLAX-F26B", teamId: team.id, productId: product.id, startDate: "2026-10-15", endDate: "2026-11-15" }),
    ).rejects.toThrow(/fundraisers_no_overlap|23P01|exclusion/i);
    expect(await db.fundraiser.count()).toBe(1);

    // Declined fundraisers never block.
    await insertFundraiser({ publicCode: "CHS-GLAX-DECL", teamId: team.id, productId: product.id, startDate: "2026-10-15", endDate: "2026-11-15", status: "declined" });

    // Owner decision 2026-10-07: a cancelled fundraiser keeps its window up to
    // the moment it was cancelled. Overlapping that part is refused…
    await expect(
      insertFundraiser({ publicCode: "CHS-GLAX-C1", teamId: team.id, productId: product.id, startDate: "2026-09-15", endDate: "2026-10-20", status: "cancelled", cancelledAt: pt("2026-10-05T12:00:00") }),
    ).rejects.toThrow(/fundraisers_no_overlap|23P01|exclusion/i);
    // …but a fundraiser cancelled before the overlap begins doesn't block.
    await insertFundraiser({ publicCode: "CHS-GLAX-C2", teamId: team.id, productId: product.id, startDate: "2026-09-01", endDate: "2026-10-15", status: "cancelled", cancelledAt: pt("2026-09-20T12:00:00") });

    // A different product with the same dates is fine.
    const other = await db.product.create({ data: { shopifyProductId: "2001", handle: "other", title: "Other cape", status: "ACTIVE" } });
    await insertFundraiser({ publicCode: "OTHER-F26", teamId: team.id, productId: other.id, startDate: "2026-10-15", endDate: "2026-11-15" });
  });

  test("Case 17 (database): a fundraiser starting Nov 1 right after one ending Oct 31 is allowed", async () => {
    const { team, product } = await seedTeamAndProduct(CAPE);
    await insertFundraiser({ publicCode: "CHS-GLAX-F26", teamId: team.id, productId: product.id, startDate: "2026-10-01", endDate: "2026-10-31" });
    await insertFundraiser({ publicCode: "CHS-GLAX-N26", teamId: team.id, productId: product.id, startDate: "2026-11-01", endDate: "2026-11-30" });
    expect(await db.fundraiser.count()).toBe(2);

    // And the saved order at Nov 1 12:00 AM Pacific goes to the new one only.
    const parsed = normalizeOrder(
      shopifyOrderNode({ id: "9100", processedAt: pt("2026-11-01T00:00:00"), lines: [{ id: "600", productId: CAPE, quantity: 1 }] }),
    );
    await saveOrder(db, parsed.order, parsed.lines);
    const saved = await db.orderLineItem.findFirstOrThrow({ include: { attributedFundraiser: true } });
    expect(saved.attributedFundraiser?.publicCode).toBe("CHS-GLAX-N26");
  });

  test("Case 23: cost per item changed in Shopify after an order → line keeps cost from time of sale", async () => {
    await seedTeamAndProduct(CAPE);
    const atSale = normalizeOrder(
      shopifyOrderNode({ id: "9200", updatedAt: new Date("2026-10-15T20:00:00Z"), lines: [{ id: "700", productId: CAPE, quantity: 1, cost: "80.00" }] }),
    );
    await saveOrder(db, atSale.order, atSale.lines);
    expect((await db.orderLineItem.findFirstOrThrow()).unitCostCents).toBe(8000);

    // Later the cost per item is raised to $95 and the order is updated.
    const later = normalizeOrder(
      shopifyOrderNode({ id: "9200", updatedAt: new Date("2026-10-20T20:00:00Z"), financialStatus: "PAID", lines: [{ id: "700", productId: CAPE, quantity: 1, cost: "95.00" }] }),
    );
    await saveOrder(db, later.order, later.lines);
    const line = await db.orderLineItem.findFirstOrThrow();
    expect(line.unitCostCents).toBe(8000);
    expect(line.costApproximate).toBe(false);

    // A backfill of the same order doesn't mark it approximate or change the cost either.
    await saveOrder(db, later.order, later.lines, { costApproximate: true });
    expect(await db.orderLineItem.findFirstOrThrow()).toMatchObject({ unitCostCents: 8000, costApproximate: false });
  });
});

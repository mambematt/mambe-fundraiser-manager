// Database guard rails and the order sync rules (beyond the 24 spec cases).
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { normalizeOrder } from "../../app/lib/shopify-order";
import { saveOrder } from "../../app/services/order-sync.server";
import { backfillProduct, linkProduct, markProductDeleted } from "../../app/services/products.server";
import type { ShopifyClient } from "../../app/services/shopify-api.server";
import { writeAudit } from "../../app/services/audit.server";
import { insertFundraiser, resetDb, seedTeamAndProduct, testDb } from "../helpers/db";
import { CAPE, COACH, pt, shopifyOrderNode } from "../helpers/fixtures";

const db = testDb();
beforeEach(resetDb);
afterAll(() => db.$disconnect());

describe("database guard rails", () => {
  test("audit_log is append-only", async () => {
    await writeAudit(db, { entity: "test", entityId: 1, action: "create", actor: "test" });
    await expect(db.auditLog.updateMany({ data: { action: "changed" } })).rejects.toThrow(/append-only/);
    await expect(db.auditLog.deleteMany()).rejects.toThrow(/append-only/);
    await expect(db.$executeRawUnsafe(`TRUNCATE "audit_log"`)).rejects.toThrow(/append-only/);
    expect(await db.auditLog.count()).toBe(1);
  });

  test("organizer emails must be lowercase and unique", async () => {
    await expect(db.organizer.create({ data: { name: "A", email: "Coach@School.org" } })).rejects.toThrow();
    await db.organizer.create({ data: { name: "A", email: "coach@school.org" } });
    await expect(db.organizer.create({ data: { name: "B", email: "coach@school.org" } })).rejects.toThrow();
  });

  test("shopify order ID and webhook ID are unique", async () => {
    const data = { name: "#1", processedAt: new Date(), financialStatus: "PAID", source: "web", shopifyUpdatedAt: new Date(), lastSyncedAt: new Date() };
    await db.shopifyOrder.create({ data: { shopifyOrderId: "1", ...data } });
    await expect(db.shopifyOrder.create({ data: { shopifyOrderId: "1", ...data } })).rejects.toThrow();
    await db.webhookEvent.create({ data: { webhookId: "w1", topic: "ORDERS_CREATE", shop: "s" } });
    await expect(db.webhookEvent.create({ data: { webhookId: "w1", topic: "ORDERS_CREATE", shop: "s" } })).rejects.toThrow();
  });
});

describe("order sync", () => {
  test("keeps only lines for linked products; skips orders with none", async () => {
    await seedTeamAndProduct(CAPE);
    const mixed = normalizeOrder(
      shopifyOrderNode({ id: "1", lines: [{ id: "10", productId: CAPE, quantity: 1 }, { id: "11", productId: COACH, quantity: 1 }, { id: "12", productId: "3333", quantity: 2 }] }),
    );
    expect((await saveOrder(db, mixed.order, mixed.lines)).status).toBe("saved");
    expect((await db.orderLineItem.findMany()).map((l) => l.shopifyProductId)).toEqual([CAPE]);

    const unrelated = normalizeOrder(shopifyOrderNode({ id: "2", lines: [{ id: "20", productId: "3333", quantity: 1 }] }));
    expect((await saveOrder(db, unrelated.order, unrelated.lines)).status).toBe("no_linked_lines");
    expect(await db.shopifyOrder.count()).toBe(1);
  });

  test("stores no customer data and records attribution with an audit entry", async () => {
    const { team, product } = await seedTeamAndProduct(CAPE);
    await insertFundraiser({ publicCode: "CHS-GLAX-F26", teamId: team.id, productId: product.id, startDate: "2026-10-01", endDate: "2026-10-31" });
    const parsed = normalizeOrder(shopifyOrderNode({ id: "5", lines: [{ id: "50", productId: CAPE, quantity: 1, discount: "19.50" }] }));
    await saveOrder(db, parsed.order, parsed.lines);
    const line = await db.orderLineItem.findFirstOrThrow();
    expect(line).toMatchObject({ qualifyingUnits: 1, outcome: "qualifying", reviewFlags: ["discount"], discountCents: 1950 });
    expect(line.reviewReason).toMatch(/Discount/);
    expect(await db.auditLog.count({ where: { entity: "order_line_item", action: "attribution" } })).toBe(1);

    // Re-saving the same state changes nothing and logs nothing new.
    await saveOrder(db, parsed.order, parsed.lines);
    expect(await db.auditLog.count({ where: { entity: "order_line_item" } })).toBe(1);
  });

  test("locked lines are never re-attributed", async () => {
    const { team, product } = await seedTeamAndProduct(CAPE);
    await insertFundraiser({ publicCode: "CHS-GLAX-F26", teamId: team.id, productId: product.id, startDate: "2026-10-01", endDate: "2026-10-31" });
    const paid = normalizeOrder(shopifyOrderNode({ id: "6", updatedAt: new Date("2026-10-15T20:00:00Z"), lines: [{ id: "60", productId: CAPE, quantity: 2 }] }));
    await saveOrder(db, paid.order, paid.lines);
    await db.orderLineItem.updateMany({ data: { locked: true } });

    const refunded = normalizeOrder(
      shopifyOrderNode({ id: "6", updatedAt: new Date("2026-12-01T20:00:00Z"), financialStatus: "PARTIALLY_REFUNDED", refunds: [{ amount: "195.00", lines: [{ lineId: "60", quantity: 1 }] }], lines: [{ id: "60", productId: CAPE, quantity: 2, currentQuantity: 1 }] }),
    );
    await saveOrder(db, refunded.order, refunded.lines);
    const line = await db.orderLineItem.findFirstOrThrow();
    expect(line.refundedQuantity).toBe(1); // the refund is recorded for history…
    expect(line.qualifyingUnits).toBe(2); // …but the frozen attribution doesn't move
  });

  test("a deleted product keeps its order lines", async () => {
    await seedTeamAndProduct(CAPE);
    const parsed = normalizeOrder(shopifyOrderNode({ id: "7", lines: [{ id: "70", productId: CAPE, quantity: 1 }] }));
    await saveOrder(db, parsed.order, parsed.lines);
    expect(await markProductDeleted(db, CAPE)).toBe("deleted");
    expect((await db.product.findFirstOrThrow()).status).toBe("DELETED");
    expect(await db.orderLineItem.count()).toBe(1);
  });
});

describe("products and backfill", () => {
  const orders = {
    "100": shopifyOrderNode({ id: "100", processedAt: pt("2026-03-01T10:00:00"), lines: [{ id: "1000", productId: CAPE, quantity: 2, cost: "78.00" }] }),
    "101": shopifyOrderNode({ id: "101", processedAt: pt("2026-10-05T10:00:00"), lines: [{ id: "1010", productId: CAPE, quantity: 1 }] }),
    "102": shopifyOrderNode({ id: "102", processedAt: pt("2026-10-06T10:00:00"), cancelledAt: pt("2026-10-06T11:00:00"), financialStatus: "REFUNDED", lines: [{ id: "1020", productId: CAPE, quantity: 1, currentQuantity: 0 }] }),
  } as const;
  const shopify: ShopifyClient = {
    fetchOrder: async (id) => orders[id as keyof typeof orders] ?? null,
    fetchProduct: async (id) =>
      id === CAPE
        ? { shopifyProductId: CAPE, handle: "cape", title: "Central High Girls Lacrosse Cape", status: "ACTIVE", tags: ["Fundraiser"] }
        : id === "4444"
          ? { shopifyProductId: "4444", handle: "untagged", title: "Untagged Cape", status: "ACTIVE", tags: [] }
          : null,
    listOrderIdsForProduct: async () => Object.keys(orders),
    listOrderIdsUpdatedSince: async () => Object.keys(orders),
    searchProducts: async () => [],
  };

  test("linking warns when the fundraiser tag is missing", async () => {
    const tagged = await linkProduct(db, shopify, `https://admin.shopify.com/store/x/products/${CAPE}`, "test");
    expect(tagged.warnings).toEqual([]);
    const untagged = await linkProduct(db, shopify, "gid://shopify/Product/4444", "test");
    expect(untagged.warnings.join(" ")).toMatch(/tag "fundraiser"/);
    await expect(linkProduct(db, shopify, "999", "test")).rejects.toThrow(/No Shopify product/);
  });

  test("backfill loads every order, marks cost approximate, and totals units", async () => {
    const { team } = await seedTeamAndProduct(CAPE);
    const product = await db.product.findFirstOrThrow();
    await insertFundraiser({ publicCode: "CHS-GLAX-F26", teamId: team.id, productId: product.id, startDate: "2026-10-01", endDate: "2026-10-31" });

    const summary = await backfillProduct(db, shopify, CAPE, "test");
    expect(summary).toMatchObject({ ordersFound: 3, ordersSaved: 3, failures: [] });
    expect(summary.totals).toEqual({
      orderedUnits: 4,
      refundedOrCancelledUnits: 1,
      netUnits: 3,
      inWindowUnits: 1,
      outsideWindowUnits: 2,
    });
    const lines = await db.orderLineItem.findMany({ orderBy: { id: "asc" } });
    expect(lines.every((l) => l.costApproximate)).toBe(true);
    expect(lines[0].unitCostCents).toBe(7800);
    expect((await db.product.findFirstOrThrow()).backfilledAt).not.toBeNull();

    // Running it again changes nothing.
    const again = await backfillProduct(db, shopify, CAPE, "test");
    expect(again.totals).toEqual(summary.totals);
    expect(await db.orderLineItem.count()).toBe(3);
  });
});

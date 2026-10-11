// The Shopify cross-check. Shopify reports use the store's timezone; our
// windows use the fundraiser's (Pacific). So the check is by order list: the
// qualifying orders, plus every sale within 24 hours of either window edge
// with which side it fell on and why.

import type { PrismaClient } from "@prisma/client";
import { DateTime } from "luxon";
import { toCsv } from "../lib/payout-files";

const DAY = 24 * 3600 * 1000;

function at(d: Date, zone: string): string {
  return DateTime.fromJSDate(d).setZone(zone).toFormat("yyyy-LL-dd HH:mm:ss ZZZZ");
}

export interface EdgeOrder {
  orderName: string;
  shopifyOrderId: string;
  checkoutPacific: string;
  checkoutStore: string;
  units: number;
  side: "inside" | "outside";
  why: string;
}

export async function crosscheckData(db: PrismaClient, fundraiserId: number, storeTimezone: string) {
  const f = await db.fundraiser.findUniqueOrThrow({ where: { id: fundraiserId }, include: { product: true } });
  const zone = f.timezone;
  const qualifyingLines = await db.orderLineItem.findMany({
    where: { attributedFundraiserId: fundraiserId, outcome: "qualifying" },
    include: { order: true },
    orderBy: { order: { processedAt: "asc" } },
  });
  const byOrder = new Map<string, { name: string; processedAt: Date; units: number }>();
  for (const l of qualifyingLines) {
    const row = byOrder.get(l.order.shopifyOrderId) ?? { name: l.order.name, processedAt: l.order.processedAt, units: 0 };
    row.units += l.qualifyingUnits;
    byOrder.set(l.order.shopifyOrderId, row);
  }
  const qualifyingOrders = [...byOrder.values()];
  const units = qualifyingOrders.reduce((sum, o) => sum + o.units, 0);

  // Sales of the product within 24 hours of either edge, whatever the outcome.
  const near = await db.orderLineItem.findMany({
    where: {
      shopifyProductId: f.product.shopifyProductId,
      OR: [
        { order: { processedAt: { gte: new Date(f.windowStart.getTime() - DAY), lte: new Date(f.windowStart.getTime() + DAY) } } },
        { order: { processedAt: { gte: new Date(f.windowEnd.getTime() - DAY), lte: new Date(f.windowEnd.getTime() + DAY) } } },
      ],
    },
    include: { order: true },
    orderBy: { order: { processedAt: "asc" } },
  });
  const edgeOrders: EdgeOrder[] = near.map((l) => {
    const t = l.order.processedAt;
    const inside = t >= f.windowStart && t < f.windowEnd;
    const nearStart = Math.abs(t.getTime() - f.windowStart.getTime()) <= DAY;
    const edge = nearStart ? f.windowStart : f.windowEnd;
    const relation = t < edge ? "before" : "at or after";
    const edgeName = nearStart ? "the window opens" : "the window closes";
    return {
      orderName: l.order.name,
      shopifyOrderId: l.order.shopifyOrderId,
      checkoutPacific: at(t, zone),
      checkoutStore: at(t, storeTimezone),
      units: l.outcome === "qualifying" ? l.qualifyingUnits : 0,
      side: inside ? "inside" : "outside",
      why: `Checkout ${at(t, zone)} is ${relation} ${at(edge, zone)}, when ${edgeName}${l.outcome !== "qualifying" && inside ? ` (counted 0: ${l.outcome.replace(/_/g, " ")})` : ""}.`,
    };
  });

  const storeStart = DateTime.fromJSDate(f.windowStart).setZone(storeTimezone);
  const storeEnd = DateTime.fromJSDate(f.windowEnd).setZone(storeTimezone).minus({ seconds: 1 });
  const sameZone = DateTime.fromJSDate(f.windowStart).setZone(storeTimezone).offset === DateTime.fromJSDate(f.windowStart).setZone(zone).offset;

  const csv = toCsv([
    ["Order", "Checkout (fundraiser time)", "Checkout (store time)", "Units"],
    ...qualifyingOrders.map((o) => [o.name, at(o.processedAt, zone), at(o.processedAt, storeTimezone), o.units]),
  ]);

  return {
    publicCode: f.publicCode,
    productTitle: f.product.title,
    storeTimezone,
    fundraiserTimezone: zone,
    sameZone,
    windowInStoreTime: `${storeStart.toFormat("LLL d, yyyy h:mm a ZZZZ")} to ${storeEnd.toFormat("LLL d, yyyy h:mm:ss a ZZZZ")}`,
    reportStartDate: storeStart.toFormat("LLL d, yyyy"),
    reportEndDate: storeEnd.toFormat("LLL d, yyyy"),
    units,
    qualifyingOrders: qualifyingOrders.map((o) => ({ name: o.name, checkoutPacific: at(o.processedAt, zone), checkoutStore: at(o.processedAt, storeTimezone), units: o.units })),
    edgeOrders,
    csv,
  };
}

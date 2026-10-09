import type { AttributionOptions } from "../lib/attribution";

/** Per-store attribution settings, from the service's environment. */
export function attributionOptions(): AttributionOptions {
  // Set COUNT_TEST_ORDERS=true on staging only (render.yaml).
  return { countTestOrders: process.env.COUNT_TEST_ORDERS === "true" };
}

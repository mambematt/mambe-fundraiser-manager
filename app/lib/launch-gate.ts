// What must be true before a fundraiser can move Setup → Scheduled.
// Pure: the caller loads the facts.

import { CHECKLIST_ITEMS, type ChecklistState } from "./checklist";

export interface LaunchFacts {
  checklist: ChecklistState;
  productStatus: string; // Shopify status: ACTIVE, DRAFT, ARCHIVED, DELETED
  productDeleted: boolean;
  hasDates: boolean;
  payoutRateCents: number | null;
  /** Other fundraisers on the product whose windows overlap this one. */
  overlapping: Array<{ publicCode: string; startDate: string; endDate: string }>;
}

/** Reasons launch is blocked; empty means it may launch. */
export function launchBlockers(facts: LaunchFacts): string[] {
  const blockers: string[] = [];
  for (const item of CHECKLIST_ITEMS) {
    if (!facts.checklist[item.key].at) blockers.push(`Checklist: "${item.label}" isn't done.`);
  }
  if (facts.productDeleted || facts.productStatus !== "ACTIVE") {
    blockers.push(
      `The product is ${facts.productDeleted ? "deleted" : facts.productStatus.toLowerCase()} in Shopify; it must be active.`,
    );
  }
  if (!facts.hasDates) blockers.push("Start and end dates aren't set.");
  if (facts.payoutRateCents === null || facts.payoutRateCents <= 0) blockers.push("The payout rate isn't set.");
  for (const o of facts.overlapping) {
    blockers.push(`Its dates overlap ${o.publicCode} (${o.startDate} to ${o.endDate}) on the same product.`);
  }
  // TODO(session 4): also require the short link redirect and the product
  // banner field to be written in Shopify (spec: "Scheduled requires").
  return blockers;
}

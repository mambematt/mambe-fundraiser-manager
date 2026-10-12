// A fundraiser's product and dates are optional while it's in Setup (one
// created from an application has neither yet). Launch requires both, so
// everything from Scheduled onward (attribution, storefront, emails,
// settlement, payouts) can rely on them. `launched()` states that at the type
// level, and throws if a record somehow lacks them, rather than guessing.

const REQUIRED = ["productId", "product", "startDate", "endDate", "windowStart", "windowEnd"] as const;
type Required = (typeof REQUIRED)[number];

export type Launched<T> = Omit<T, Required & keyof T> & { [K in Required & keyof T]: NonNullable<T[K]> };

export class MissingLaunchFieldsError extends Error {}

export function hasLaunchFields<T extends object>(f: T): f is T & Launched<T> {
  return REQUIRED.every((k) => !(k in f) || (f as Record<string, unknown>)[k] != null);
}

export function launched<T extends { id?: number; publicCode?: string }>(f: T): Launched<T> {
  if (!hasLaunchFields(f)) {
    throw new MissingLaunchFieldsError(`Fundraiser ${f.publicCode ?? f.id} has no product or dates yet; set them in Setup first.`);
  }
  return f as unknown as Launched<T>;
}

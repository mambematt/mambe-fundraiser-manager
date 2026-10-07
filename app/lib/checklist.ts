// The six setup checklist items. Each stores who completed it and when, in the
// fundraisers table columns named below.

export const CHECKLIST_ITEMS = [
  { key: "organizerInfoReceived", label: "Organizer info received (logo, colors, dates, PayPal email)" },
  { key: "artworkApproved", label: "Artwork approved by organizer" },
  { key: "productReady", label: "Product linked and active, with the fundraiser tag" },
  { key: "assetsUploaded", label: "Promotional assets uploaded" },
  { key: "driveFoldersCreated", label: "Drive folders created" },
  { key: "launchPackageReviewed", label: "Launch package reviewed" },
] as const;

export type ChecklistKey = (typeof CHECKLIST_ITEMS)[number]["key"];

export function isChecklistKey(value: string): value is ChecklistKey {
  return CHECKLIST_ITEMS.some((i) => i.key === value);
}

export type ChecklistState = Record<ChecklistKey, { at: Date | null; by: string | null }>;

/** Read the checklist from a fundraiser row's `<key>At` / `<key>By` columns. */
export function checklistFrom(row: Record<string, unknown>): ChecklistState {
  const state = {} as ChecklistState;
  for (const { key } of CHECKLIST_ITEMS) {
    state[key] = {
      at: (row[`${key}At`] as Date | null) ?? null,
      by: (row[`${key}By`] as string | null) ?? null,
    };
  }
  return state;
}

// The admin work queue: what needs attention, grouped, each with a link.
// Pure: the caller loads the facts. Dates are compared in Pacific time.

import { addDays, todayPacific } from "./calendar";

export const WAITING_ON_ORGANIZER_DAYS = 5;
export const LAUNCH_SOON_DAYS = 3;
export const ENDING_SOON_DAYS = 7;
export const SETTLEMENT_DELAY_DAYS = 10;
export const NIGHTLY_STALE_HOURS = 26;

export interface QueueFundraiser {
  id: number;
  publicCode: string;
  status: string;
  /** "YYYY-MM-DD" */
  startDate: string;
  endDate: string;
  windowEnd: Date;
  waitingOnOrganizerSince: Date | null;
}

export interface QueueInput {
  now: Date;
  fundraisers: QueueFundraiser[];
  newApplications: number;
  /** Unresolved flagged lines per fundraiser. */
  flagsByFundraiser: Array<{ id: number; publicCode: string; count: number }>;
  payoutsToSend: { count: number; amountCents: number };
  failedWebhooks: number;
  lastNightlyOkAt: Date | null;
  webhookSilence: boolean;
  /** Organizer emails that failed after retries. */
  failedEmails?: Array<{ id: number; publicCode: string; count: number }>;
  /** Fundraisers whose last banner/short-link write failed. */
  storefrontErrors?: Array<{ id: number; publicCode: string; error: string }>;
}

export interface QueueItem {
  label: string;
  href: string;
  detail?: string;
}

export interface QueueGroup {
  key: string;
  label: string;
  count: number;
  /** "critical" groups need action or something won't happen. */
  tone: "critical" | "warning" | "info";
  items: QueueItem[];
}

const FINAL = new Set(["paid", "declined", "cancelled"]);
const NOT_LAUNCHED = new Set(["application", "setup"]);

const link = (f: { id: number }) => `/app/fundraisers/${f.id}`;

export function buildWorkQueue(input: QueueInput): QueueGroup[] {
  const { now } = input;
  const today = todayPacific(now);
  const groups: QueueGroup[] = [];
  const add = (g: Omit<QueueGroup, "count">, count = g.items.length) => {
    if (count > 0) groups.push({ ...g, count });
  };

  add(
    {
      key: "applications",
      label: "Applications to review",
      tone: "info",
      items: input.newApplications ? [{ label: `${input.newApplications} new`, href: "/app/fundraisers?status=application" }] : [],
    },
    input.newApplications,
  );

  // Not launched and starting within 3 days, or already started: it won't
  // become Active until someone approves the launch.
  const launchBy = addDays(today, LAUNCH_SOON_DAYS);
  add({
    key: "launch_soon",
    label: `Starting within ${LAUNCH_SOON_DAYS} days (or already started) but not yet Scheduled`,
    tone: "critical",
    items: input.fundraisers
      .filter((f) => NOT_LAUNCHED.has(f.status) && f.startDate <= launchBy && f.endDate >= today)
      .sort((a, b) => a.startDate.localeCompare(b.startDate))
      .map((f) => ({ label: f.publicCode, href: link(f), detail: f.startDate < today ? `started ${f.startDate}` : `starts ${f.startDate}` })),
  });

  const waitingCutoff = now.getTime() - WAITING_ON_ORGANIZER_DAYS * 24 * 3600 * 1000;
  add({
    key: "waiting",
    label: `Waiting on organizer more than ${WAITING_ON_ORGANIZER_DAYS} days`,
    tone: "warning",
    items: input.fundraisers
      .filter((f) => !FINAL.has(f.status) && f.waitingOnOrganizerSince && f.waitingOnOrganizerSince.getTime() < waitingCutoff)
      .map((f) => ({
        label: f.publicCode,
        href: link(f),
        detail: `since ${f.waitingOnOrganizerSince!.toISOString().slice(0, 10)}`,
      })),
  });

  const endBy = addDays(today, ENDING_SOON_DAYS);
  add({
    key: "ending_soon",
    label: `Ending in the next ${ENDING_SOON_DAYS} days`,
    tone: "info",
    items: input.fundraisers
      .filter((f) => (f.status === "active" || f.status === "scheduled") && f.endDate >= today && f.endDate <= endBy)
      .sort((a, b) => a.endDate.localeCompare(b.endDate))
      .map((f) => ({ label: f.publicCode, href: link(f), detail: `ends ${f.endDate}` })),
  });

  const flagTotal = input.flagsByFundraiser.reduce((sum, f) => sum + f.count, 0);
  add(
    {
      key: "flags",
      label: "Flags to resolve",
      tone: "warning",
      items: input.flagsByFundraiser
        .filter((f) => f.count > 0)
        .map((f) => ({ label: f.publicCode, href: `${link(f)}#flags`, detail: `${f.count} line${f.count === 1 ? "" : "s"}` })),
    },
    flagTotal,
  );

  const settleCutoff = now.getTime() - SETTLEMENT_DELAY_DAYS * 24 * 3600 * 1000;
  add({
    key: "settlements",
    label: "Settlements ready",
    tone: "info",
    items: input.fundraisers
      .filter((f) => f.status === "settling" && f.windowEnd.getTime() <= settleCutoff)
      .map((f) => ({ label: f.publicCode, href: link(f), detail: `ended ${f.endDate}` })),
  });

  add(
    {
      key: "payouts",
      label: "Payouts to send",
      tone: "info",
      items: input.payoutsToSend.count
        ? [{ label: `${input.payoutsToSend.count} approved`, href: "/app/fundraisers?status=payout_pending", detail: `$${(input.payoutsToSend.amountCents / 100).toFixed(2)}` }]
        : [],
    },
    input.payoutsToSend.count,
  );

  add({
    key: "storefront",
    label: "Storefront writes failing (banner or short link)",
    tone: "critical",
    items: (input.storefrontErrors ?? []).map((f) => ({ label: f.publicCode, href: link(f), detail: f.error.slice(0, 80) })),
  });

  add(
    {
      key: "emails",
      label: "Organizer emails failed",
      tone: "critical",
      items: (input.failedEmails ?? []).map((f) => ({ label: f.publicCode, href: `${link(f)}#emails`, detail: `${f.count} email${f.count === 1 ? "" : "s"}` })),
    },
    (input.failedEmails ?? []).reduce((sum, f) => sum + f.count, 0),
  );

  const sync: QueueItem[] = [];
  if (input.failedWebhooks > 0) sync.push({ label: `${input.failedWebhooks} failed webhook${input.failedWebhooks === 1 ? "" : "s"}`, href: "/app#sync" });
  const nightlyStale =
    !input.lastNightlyOkAt || now.getTime() - input.lastNightlyOkAt.getTime() > NIGHTLY_STALE_HOURS * 3600 * 1000;
  if (nightlyStale) {
    sync.push({
      label: input.lastNightlyOkAt ? "Nightly re-check is more than 26 hours old" : "Nightly re-check hasn't succeeded yet",
      href: "/app#sync",
    });
  }
  if (input.webhookSilence) sync.push({ label: "No webhooks in 24 hours while a fundraiser is Active", href: "/app#sync" });
  add({ key: "sync", label: "Sync problems", tone: "critical", items: sync });

  return groups;
}

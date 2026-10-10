// Organizer portal: login links, sessions, access log and what an organizer
// may see. Spec "Security": the link authenticates the person; they see only
// fundraisers linked to them; tokens are stored only as hashes.

import type { PrismaClient } from "@prisma/client";
import { STATUS_MESSAGES, suggestedAction, PORTAL_HELP_EMAIL } from "../content/portal-copy";
import { addDays, dayStatus, daysBetween, todayPacific } from "../lib/calendar";
import { hashKey, hashToken, newToken } from "../lib/portal-tokens.server";
import { STATUS_LABELS, type FundraiserStatus } from "../lib/status";
import { writeAudit } from "./audit.server";
import { portalUrl, storefrontUrl } from "./communications.server";
import { isoDate, storedTotals } from "./fundraisers.server";
import { alertError } from "./alerts.server";
import { METRICS, splitName, type KlaviyoClient } from "./klaviyo.server";

export const LOGIN_TOKEN_MINUTES = 30;
export const SESSION_DAYS = 45;
export const RATE_LIMIT_PER_EMAIL_PER_HOUR = 3;
export const RATE_LIMIT_PER_IP_PER_HOUR = 10;
export const NEUTRAL_REPLY = "If we have that email, a link is on its way.";

const HOUR = 3600 * 1000;

// ------------------------------------------------------------ rate limit

async function overLimit(db: PrismaClient, key: string, limit: number, now: Date): Promise<boolean> {
  const recent = await db.rateLimitEvent.count({ where: { key, createdAt: { gte: new Date(now.getTime() - HOUR) } } });
  return recent >= limit;
}

/** Only requests that go through count, so retrying while limited doesn't extend the wait. */
async function countRequest(db: PrismaClient, keys: string[], now: Date) {
  await db.rateLimitEvent.createMany({ data: keys.map((key) => ({ key, createdAt: now })) });
}

// ----------------------------------------------------------- login links

export async function issueLoginLink(
  db: PrismaClient,
  klaviyo: KlaviyoClient,
  organizerId: number,
  now = new Date(),
): Promise<void> {
  const organizer = await db.organizer.findUniqueOrThrow({ where: { id: organizerId } });
  const token = newToken();
  await db.portalLoginToken.create({
    data: { organizerId, tokenHash: hashToken(token), expiresAt: new Date(now.getTime() + LOGIN_TOKEN_MINUTES * 60 * 1000), createdAt: now },
  });
  const { firstName, lastName } = splitName(organizer.name);
  await klaviyo.sendEvent(
    METRICS.loginLink,
    { email: organizer.email, firstName, lastName },
    { login_link: `${portalUrl()}/auth/${token}`, expires_minutes: LOGIN_TOKEN_MINUTES, organizer_first_name: firstName, help_email: PORTAL_HELP_EMAIL },
    `login-${hashToken(token).slice(0, 24)}`,
  );
}

/**
 * "Email me a new link". Always answers the same way, whether or not the
 * email exists or a limit was hit. Login emails don't depend on the
 * fundraiser's Organizer emails switch: they're sent only on request.
 */
export async function requestLoginLink(
  db: PrismaClient,
  klaviyo: KlaviyoClient,
  email: string,
  ip: string,
  now = new Date(),
): Promise<string> {
  const clean = email.trim().toLowerCase();
  await db.rateLimitEvent.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 24 * HOUR) } } });
  const emailKey = hashKey("email", clean);
  const ipKey = hashKey("ip", ip || "unknown");
  const emailLimited = clean ? await overLimit(db, emailKey, RATE_LIMIT_PER_EMAIL_PER_HOUR, now) : true;
  const ipLimited = await overLimit(db, ipKey, RATE_LIMIT_PER_IP_PER_HOUR, now);
  if (emailLimited || ipLimited) {
    console.warn("[portal] login link request rate-limited");
    return NEUTRAL_REPLY;
  }
  await countRequest(db, [emailKey, ipKey], now);

  const organizer = await db.organizer.findUnique({ where: { email: clean } });
  if (organizer) {
    try {
      await issueLoginLink(db, klaviyo, organizer.id, now);
    } catch (error) {
      alertError(error, "Portal login link couldn't be sent");
    }
  }
  return NEUTRAL_REPLY;
}

/** Use a login link: single use, 30 minutes. Returns the organizer, or null. */
export async function consumeLoginToken(db: PrismaClient, token: string, now = new Date()): Promise<number | null> {
  if (!token || token.length < 20) return null;
  const tokenHash = hashToken(token);
  const row = await db.portalLoginToken.findUnique({ where: { tokenHash } });
  if (!row) return null;
  // Atomic: only the first use of an unexpired token succeeds.
  const used = await db.portalLoginToken.updateMany({
    where: { id: row.id, usedAt: null, expiresAt: { gt: now } },
    data: { usedAt: now },
  });
  return used.count === 1 ? row.organizerId : null;
}

// --------------------------------------------------------------- sessions

export async function createSession(db: PrismaClient, organizerId: number, now = new Date()): Promise<string> {
  const raw = newToken();
  await db.portalSession.create({
    data: { organizerId, sessionHash: hashToken(raw), expiresAt: new Date(now.getTime() + SESSION_DAYS * 24 * HOUR), createdAt: now },
  });
  return raw;
}

export async function sessionOrganizerId(db: PrismaClient, raw: string | null, now = new Date()): Promise<number | null> {
  if (!raw) return null;
  const s = await db.portalSession.findUnique({ where: { sessionHash: hashToken(raw) } });
  if (!s || s.revokedAt || s.expiresAt <= now) return null;
  await db.portalSession.update({ where: { id: s.id }, data: { lastSeenAt: now } });
  return s.organizerId;
}

export async function endSession(db: PrismaClient, raw: string | null) {
  if (!raw) return;
  await db.portalSession.updateMany({ where: { sessionHash: hashToken(raw), revokedAt: null }, data: { revokedAt: new Date() } });
}

export async function signOutEverywhere(db: PrismaClient, organizerId: number, actor: string) {
  const result = await db.portalSession.updateMany({ where: { organizerId, revokedAt: null }, data: { revokedAt: new Date() } });
  await db.portalLoginToken.updateMany({ where: { organizerId, usedAt: null }, data: { usedAt: new Date() } });
  await writeAudit(db, { entity: "organizer", entityId: organizerId, action: "portal:sign_out_everywhere", after: { sessionsEnded: result.count }, actor });
  return result.count;
}

export async function logVisit(db: PrismaClient, organizerId: number, fundraiserId: number | null) {
  await db.portalVisit.create({ data: { organizerId, fundraiserId } });
}

// ------------------------------------------------------- what they see

/** Fundraisers this organizer is linked to. Every portal query goes through this link. */
export async function fundraisersForOrganizer(db: PrismaClient, organizerId: number) {
  return db.fundraiser.findMany({
    where: { organizers: { some: { organizerId } }, status: { notIn: ["declined"] } },
    include: { team: { include: { organization: true } } },
    orderBy: { windowStart: "desc" },
  });
}

export interface PortalView {
  id: number;
  publicCode: string;
  organization: string;
  team: string;
  status: string;
  statusLabel: string;
  statusMessage: string;
  startDate: string;
  endDate: string;
  dayStatus: string;
  shortLink: string | null;
  units: number;
  estimatedRaised: string;
  ratePerItem: string;
  /** When the last order data arrived from Shopify. */
  dataAsOf: string | null;
  suggestion: string | null;
  assets: Array<{ id: number; title: string; kind: string; url: string }>;
  payoutStatus: string;
  helpEmail: string;
}

/**
 * One fundraiser for the portal. `organizerId` null is the admin's read-only
 * preview; otherwise the organizer must be linked to it. Counts only: no
 * order numbers, names or other customer details are ever included.
 */
export async function portalView(db: PrismaClient, fundraiserId: number, organizerId: number | null, now = new Date()): Promise<PortalView | null> {
  const f = await db.fundraiser.findFirst({
    where: {
      id: fundraiserId,
      status: { not: "declined" },
      ...(organizerId !== null ? { organizers: { some: { organizerId } } } : {}),
    },
    include: { team: { include: { organization: true } }, assets: { where: { visibility: "organizer", isCurrent: true }, orderBy: { createdAt: "asc" } }, payout: true },
  });
  if (!f) return null;

  const totals = await storedTotals(db, f);
  const lastWebhook = await db.webhookEvent.findFirst({ where: { status: "processed" }, orderBy: { processedAt: "desc" } });
  const startDate = isoDate(f.startDate);
  const endDate = isoDate(f.endDate);
  const today = todayPacific(now);
  const day = daysBetween(startDate, today) + 1;
  const daysLeft = Math.max(0, daysBetween(today, endDate));
  const settleBy = addDays(endDate, 10);

  return {
    id: f.id,
    publicCode: f.publicCode,
    organization: f.team.organization.name,
    team: f.team.name,
    status: f.status,
    statusLabel: STATUS_LABELS[f.status as FundraiserStatus] ?? f.status,
    statusMessage: (STATUS_MESSAGES[f.status] ?? "").replace("{settle date}", settleBy),
    startDate,
    endDate,
    dayStatus: dayStatus(startDate, endDate, now),
    shortLink: f.shortUrl && f.shortLinkRedirectId ? `${storefrontUrl()}${f.shortUrl}` : null,
    units: totals.qualifyingUnits,
    estimatedRaised: `$${(totals.estimatedPayoutCents / 100).toFixed(2)}`,
    ratePerItem: `$${(f.payoutRateCents / 100).toFixed(f.payoutRateCents % 100 ? 2 : 0)}`,
    dataAsOf: lastWebhook?.processedAt?.toISOString() ?? null,
    suggestion: suggestedAction({ status: f.status, day, daysLeft }),
    assets: f.assets.map((a) => ({ id: a.id, title: a.title, kind: a.kind, url: a.url ?? "" })),
    payoutStatus: f.payout ? f.payout.status : "Not calculated yet: your payout is worked out 10 days after the end date.",
    helpEmail: PORTAL_HELP_EMAIL,
  };
}

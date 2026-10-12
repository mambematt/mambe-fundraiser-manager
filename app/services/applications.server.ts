// Applications from the public form (spec "Organizer journey", step 1).
// Save first, then everything else: the application is stored before any
// email is attempted, and a failed email is retried by the clock.

import type { Application, ApplicationEmail, PrismaClient } from "@prisma/client";
import {
  parseApplication,
  RATE_LIMIT_PER_EMAIL,
  RATE_LIMIT_PER_IP,
  roughTiming,
  seasonLabelFor,
  spamReason,
  suggestOrganizations,
  suggestTeams,
  type FieldErrors,
} from "../lib/applications";
import { UserError } from "../lib/errors";
import { ORGANIZATION_TYPES } from "../lib/organizations";
import { hashKey } from "../lib/portal-tokens.server";
import { alert } from "./alerts.server";
import { writeAudit } from "./audit.server";
import { MAX_SEND_ATTEMPTS } from "./communications.server";
import { createDriveFolders, type DriveClient } from "./drive.server";
import { createFundraiser } from "./fundraisers.server";
import { METRICS, splitName, type KlaviyoClient } from "./klaviyo.server";

const HOUR = 3600 * 1000;
export const DEFAULT_NOTIFY_EMAIL = "matt@mambeblankets.com";

/** The global switch for both application emails. Off unless set to "true". */
export function applicationEmailsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.APPLICATION_EMAILS_ENABLED === "true";
}

export function notifyEmail(env: NodeJS.ProcessEnv = process.env): string {
  return env.APPLICATION_NOTIFY_EMAIL?.trim() || DEFAULT_NOTIFY_EMAIL;
}

/** The application's page inside Shopify admin (for the internal email). */
export function adminApplicationUrl(shop: string, applicationId: number, apiKey = process.env.SHOPIFY_API_KEY ?? ""): string {
  const store = shop.replace(/\.myshopify\.com$/, "");
  return `https://admin.shopify.com/store/${store}/apps/${apiKey}/app/applications/${applicationId}`;
}

// ------------------------------------------------------------- submit

export type SubmitResult =
  | { status: "saved"; applicationId: number }
  | { status: "invalid"; errors: FieldErrors }
  /** Spam or over the rate limit: the sender sees the thank-you, nothing is saved. */
  | { status: "ignored"; reason: string };

export async function submitApplication(
  db: PrismaClient,
  raw: Record<string, unknown>,
  context: { ip: string | null; now?: Date; env?: NodeJS.ProcessEnv },
): Promise<SubmitResult> {
  const now = context.now ?? new Date();
  const spam = spamReason(raw, now);
  if (spam) return { status: "ignored", reason: spam };

  const parsed = parseApplication(raw);
  if (!parsed.ok) return { status: "invalid", errors: parsed.errors };
  const a = parsed.value;

  // Rate limits, counted on saved applications only (hashes, never raw values).
  await db.rateLimitEvent.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 24 * HOUR) } } });
  const keys = [hashKey("apply-email", a.email), ...(context.ip ? [hashKey("apply-ip", context.ip)] : [])];
  const since = new Date(now.getTime() - HOUR);
  const [byEmail, byIp] = await Promise.all(
    keys.slice(0, 2).map((key) => db.rateLimitEvent.count({ where: { key, createdAt: { gte: since } } })),
  );
  if ((byEmail ?? 0) >= RATE_LIMIT_PER_EMAIL) return { status: "ignored", reason: "rate_limit_email" };
  if (context.ip && (byIp ?? 0) >= RATE_LIMIT_PER_IP) return { status: "ignored", reason: "rate_limit_ip" };

  const emailsOn = applicationEmailsEnabled(context.env);
  const application = await db.$transaction(async (tx) => {
    const created = await tx.application.create({
      data: {
        // Kept forever: exactly what was submitted (checked and trimmed).
        rawSubmission: { ...a, timing: roughTiming(a), submittedAt: now.toISOString() },
        name: a.name,
        email: a.email,
        phone: a.phone,
        organizationName: a.organizationName,
        teamName: a.teamName,
        role: a.role,
        city: a.city,
        state: a.state,
        roughTiming: roughTiming(a),
        hasLogo: a.hasLogo,
        notes: a.notes,
        status: "new",
        createdAt: now,
        emails: {
          create: (["received", "internal"] as const).map((kind) => ({
            kind,
            status: emailsOn ? "pending" : "off",
            createdAt: now,
          })),
        },
      },
    });
    await tx.rateLimitEvent.createMany({ data: keys.map((key) => ({ key, createdAt: now })) });
    await writeAudit(tx, {
      entity: "application",
      entityId: created.id,
      action: "submitted",
      after: { organization: a.organizationName, team: a.teamName, emails: emailsOn ? "queued" : "off (switch)" },
      actor: "application form",
    });
    return created;
  });
  return { status: "saved", applicationId: application.id };
}

// ------------------------------------------------------------- emails

function properties(app: Application, shop: string | null) {
  const { firstName } = splitName(app.name ?? "");
  return {
    application_id: app.id,
    applicant_name: app.name,
    applicant_first_name: firstName,
    applicant_email: app.email,
    applicant_phone: app.phone,
    organization_name: app.organizationName,
    team_name: app.teamName,
    role: app.role,
    city: app.city,
    state: app.state,
    rough_timing: app.roughTiming,
    has_logo: app.hasLogo ? "Yes" : "No",
    notes: app.notes ?? "",
    submitted_at: app.createdAt.toISOString(),
    admin_link: shop ? adminApplicationUrl(shop, app.id) : "",
  };
}

/**
 * Klaviyo's de-duplication ID for an application email. Staging and production
 * number applications separately and share one Klaviyo account, so the ID
 * names the service: otherwise production's application #1 to the same
 * person as staging's #1 is silently dropped as a duplicate.
 */
export function eventId(applicationId: number, kind: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${env.RENDER_SERVICE_NAME || "local"}-application-${applicationId}-${kind}`;
}

/** Send one application email. Never throws; records the outcome. */
export async function sendApplicationEmail(
  db: PrismaClient,
  klaviyo: KlaviyoClient,
  row: ApplicationEmail,
  options: { shop: string | null; now?: Date; env?: NodeJS.ProcessEnv },
): Promise<"sent" | "retry" | "failed"> {
  const now = options.now ?? new Date();
  const app = await db.application.findUniqueOrThrow({ where: { id: row.applicationId } });
  try {
    const props = properties(app, options.shop);
    if (row.kind === "received") {
      const { firstName, lastName } = splitName(app.name ?? "");
      // Transactional: no list, no marketing consent.
      await klaviyo.sendEvent(METRICS.applicationReceived, { email: app.email!, firstName, lastName }, props, eventId(app.id, "received", options.env), { addToList: false });
    } else {
      await klaviyo.sendEvent(METRICS.newApplication, { email: notifyEmail(options.env) }, props, eventId(app.id, "internal", options.env), { addToList: false });
    }
    await db.applicationEmail.update({
      where: { id: row.id },
      data: { status: "sent", sentAt: now, attempts: row.attempts + 1, lastAttemptAt: now, error: null },
    });
    return "sent";
  } catch (error) {
    const attempts = row.attempts + 1;
    const failed = attempts >= MAX_SEND_ATTEMPTS;
    await db.applicationEmail.update({
      where: { id: row.id },
      data: { attempts, lastAttemptAt: now, error: String((error as Error)?.message ?? error).slice(0, 500), ...(failed ? { status: "failed" } : {}) },
    });
    if (failed) alert(`Application email "${row.kind}" for application #${app.id} failed ${attempts} times`, { applicationId: app.id });
    return failed ? "failed" : "retry";
  }
}

/** Right after saving, and from the clock every 15 minutes. */
export async function sendPendingApplicationEmails(
  db: PrismaClient,
  klaviyo: KlaviyoClient,
  options: { shop: string | null; applicationId?: number; now?: Date; env?: NodeJS.ProcessEnv },
) {
  const summary = { sent: 0, retrying: 0, failed: 0, off: 0 };
  const rows = await db.applicationEmail.findMany({
    where: { status: "pending", ...(options.applicationId ? { applicationId: options.applicationId } : {}) },
    orderBy: { id: "asc" },
  });
  for (const row of rows) {
    // Switched off after it was queued: never sent.
    if (!applicationEmailsEnabled(options.env)) {
      await db.applicationEmail.update({ where: { id: row.id }, data: { status: "off", error: "APPLICATION_EMAILS_ENABLED is off." } });
      summary.off += 1;
      continue;
    }
    const result = await sendApplicationEmail(db, klaviyo, row, options);
    if (result === "sent") summary.sent += 1;
    else if (result === "failed") summary.failed += 1;
    else summary.retrying += 1;
  }
  return summary;
}

/** Admin "Retry": a failed email goes back in the queue with fresh attempts. */
export async function retryApplicationEmail(db: PrismaClient, emailId: number, actor: string) {
  const row = await db.applicationEmail.findUniqueOrThrow({ where: { id: emailId } });
  if (row.status !== "failed") throw new UserError("Only a failed email can be retried.");
  await db.applicationEmail.update({ where: { id: emailId }, data: { status: "pending", attempts: 0 } });
  await writeAudit(db, { entity: "application", entityId: row.applicationId, action: "email:retry", after: { kind: row.kind }, actor });
}

// ------------------------------------------------------------- review

async function openApplication(db: PrismaClient, id: number) {
  const app = await db.application.findUniqueOrThrow({ where: { id } });
  if (app.status !== "new") throw new UserError(`This application is already ${app.status}.`);
  return app;
}

export async function markSpam(db: PrismaClient, id: number, actor: string, now = new Date()) {
  await openApplication(db, id);
  await db.$transaction(async (tx) => {
    await tx.application.update({ where: { id }, data: { status: "spam", reviewedBy: actor, reviewedAt: now } });
    // Unsent emails to a spammer are dropped.
    await tx.applicationEmail.updateMany({ where: { applicationId: id, status: "pending" }, data: { status: "off", error: "Marked as spam." } });
    await writeAudit(tx, { entity: "application", entityId: id, action: "spam", before: { status: "new" }, after: { status: "spam" }, actor });
  });
}

export async function declineApplication(db: PrismaClient, id: number, reason: string, actor: string, now = new Date()) {
  if (!reason.trim()) throw new UserError("A reason is required to decline.");
  await openApplication(db, id);
  await db.$transaction(async (tx) => {
    await tx.application.update({ where: { id }, data: { status: "declined", declineReason: reason.trim(), reviewedBy: actor, reviewedAt: now } });
    await writeAudit(tx, { entity: "application", entityId: id, action: "declined", before: { status: "new" }, after: { status: "declined" }, reason: reason.trim(), actor });
  });
}

/** What the accept screen suggests: possible organizations, their teams, and an organizer with the same email. */
export async function matchSuggestions(db: PrismaClient, id: number) {
  const app = await db.application.findUniqueOrThrow({ where: { id } });
  const organizations = await db.organization.findMany({ select: { id: true, name: true, city: true, state: true } });
  const orgs = suggestOrganizations(app, organizations);
  const teams = await db.team.findMany({ where: { organizationId: { in: orgs.map((o) => o.id) } }, orderBy: { name: "asc" } });
  const organizer = app.email ? await db.organizer.findUnique({ where: { email: app.email.toLowerCase() } }) : null;
  return {
    organizations: orgs.map((o) => {
      const own = teams.filter((t) => t.organizationId === o.id);
      const suggested = suggestTeams(app.teamName, own).map((t) => t.id);
      return {
        ...o,
        teams: own.map((t) => ({ id: t.id, name: t.name, suggested: suggested.includes(t.id) })),
      };
    }),
    organizer: organizer ? { id: organizer.id, name: organizer.name, email: organizer.email } : null,
  };
}

export interface AcceptChoices {
  /** An existing organization, or null to create one from the application. */
  organizationId: number | null;
  /** Type for a new organization. */
  organizationType?: string;
  /** An existing team in that organization, or null to create one. */
  teamId: number | null;
  /** Use the organizer with the application's email (if one exists); otherwise one is created. */
  useExistingOrganizer: boolean;
}

/**
 * Accept: confirm or create the organization, team and organizer, create the
 * fundraiser in Setup (the timing becomes a note; dates come later), link
 * the application, and create the Drive folders (a failure there never
 * blocks; it shows Retry). Everything is audited.
 */
export async function acceptApplication(
  db: PrismaClient,
  id: number,
  choices: AcceptChoices,
  actor: string,
  deps: { drive?: DriveClient | null } = {},
) {
  const app = await openApplication(db, id);
  const email = app.email?.toLowerCase() ?? "";
  if (!email) throw new UserError("The application has no email.");
  if (choices.organizationId === null && !ORGANIZATION_TYPES.includes(choices.organizationType as (typeof ORGANIZATION_TYPES)[number])) {
    throw new UserError("Choose the type of the new organization.");
  }

  const { organizationId, teamId, organizerId } = await db.$transaction(async (tx) => {
    let organizationId = choices.organizationId;
    if (organizationId) {
      await tx.organization.findUniqueOrThrow({ where: { id: organizationId } });
    } else {
      const org = await tx.organization.create({
        data: { name: app.organizationName!, type: choices.organizationType!, city: app.city, state: app.state },
      });
      organizationId = org.id;
      await writeAudit(tx, { entity: "organization", entityId: org.id, action: "create", after: { name: org.name, type: org.type, city: org.city, state: org.state, fromApplication: id }, actor });
    }

    let teamId = choices.teamId;
    if (teamId) {
      const team = await tx.team.findUniqueOrThrow({ where: { id: teamId } });
      if (team.organizationId !== organizationId) throw new UserError("That team belongs to a different organization.");
    } else {
      const team = await tx.team.create({ data: { organizationId, name: app.teamName! } });
      teamId = team.id;
      await writeAudit(tx, { entity: "team", entityId: team.id, action: "create", after: { name: team.name, organizationId, fromApplication: id }, actor });
    }

    const existing = await tx.organizer.findUnique({ where: { email } });
    let organizerId: number;
    if (existing && choices.useExistingOrganizer) {
      organizerId = existing.id;
    } else if (existing) {
      // Emails are unique: the same person can't be created twice.
      throw new UserError(`An organizer with ${email} already exists (${existing.name}); use them.`);
    } else {
      const organizer = await tx.organizer.create({ data: { name: app.name!, email, phone: app.phone, role: app.role } });
      organizerId = organizer.id;
      await writeAudit(tx, { entity: "organizer", entityId: organizer.id, action: "create", after: { name: organizer.name, email, fromApplication: id }, actor });
    }
    return { organizationId, teamId, organizerId };
  });

  const fundraiser = await createFundraiser(
    db,
    {
      teamId,
      seasonLabel: seasonLabelFor((app.rawSubmission ?? {}) as Record<string, unknown>, new Date()),
      organizerIds: [organizerId],
      primaryOrganizerId: organizerId,
      notes: [
        `From application #${id}. Timing: ${app.roughTiming ?? "not given"}.`,
        `Logo: ${app.hasLogo ? "yes" : "no"}.`,
        app.notes ? `Applicant notes: ${app.notes}` : null,
      ].filter(Boolean).join(" "),
    },
    actor,
  );

  await db.$transaction(async (tx) => {
    // Only a still-new application converts (safe if clicked twice).
    const result = await tx.application.updateMany({
      where: { id, status: "new" },
      data: { status: "converted", convertedFundraiserId: fundraiser.id, reviewedBy: actor, reviewedAt: new Date() },
    });
    if (result.count === 0) throw new UserError("This application was already handled; reload.");
    await writeAudit(tx, {
      entity: "application",
      entityId: id,
      action: "accepted",
      before: { status: "new" },
      after: { status: "converted", fundraiser: fundraiser.publicCode, organizationId, teamId, organizerId },
      actor,
    });
    await writeAudit(tx, {
      entity: "fundraiser",
      entityId: fundraiser.id,
      action: "from_application",
      after: { applicationId: id },
      actor,
    });
  });

  const drive = deps.drive ? await createDriveFolders(db, deps.drive, fundraiser.id, actor) : null;
  return { fundraiser, drive };
}

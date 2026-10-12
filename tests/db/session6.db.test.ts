// Session 6: application form (App Proxy), accepting applications, Drive
// folders, reports, the weekly payout backup and the product-deleted alert.
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { appProxySignature, applicantIp, verifyAppProxy } from "../../app/lib/app-proxy";
import { nameSimilarity, parseApplication, seasonLabelFor, suggestOrganizations } from "../../app/lib/applications";
import { buildWorkQueue } from "../../app/lib/work-queue";
import { normalizeOrder } from "../../app/lib/shopify-order";
import {
  acceptApplication,
  declineApplication,
  markSpam,
  matchSuggestions,
  retryApplicationEmail,
  sendPendingApplicationEmails,
  submitApplication,
} from "../../app/services/applications.server";
import { accountantRows, backupIsDue, runPayoutBackup } from "../../app/services/backups.server";
import { loadWorkQueue } from "../../app/services/dashboard.server";
import { createDriveFolders, seasonFolderName } from "../../app/services/drive.server";
import { createFundraiser } from "../../app/services/fundraisers.server";
import { runClock } from "../../app/services/jobs.server";
import type { KlaviyoClient, MetricName } from "../../app/services/klaviyo.server";
import { saveOrder } from "../../app/services/order-sync.server";
import { markProductDeleted } from "../../app/services/products.server";
import { buildReports, ordersByFundraiser, reportCsv } from "../../app/services/reports.server";
import { accountantCsv } from "../../app/lib/payout-files";
import { resetDb, seedTeamAndProduct, testDb } from "../helpers/db";
import { fakeDrive } from "../helpers/fake-drive";
import { CAPE, pt, shopifyOrderNode } from "../helpers/fixtures";

const db = testDb();
beforeEach(resetDb);
afterAll(() => db.$disconnect());

let alerts: string[] = [];
beforeEach(() => {
  alerts = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].startsWith("[ALERT]")) alerts.push(args[0]);
  });
});
afterEach(() => vi.restoreAllMocks());

const ON = { APPLICATION_EMAILS_ENABLED: "true" } as NodeJS.ProcessEnv;
const OFF = {} as NodeJS.ProcessEnv;
const NOW = new Date("2026-10-12T18:00:00Z");

function form(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    name: "Trissy Laurito",
    email: "Trissy@Example.com",
    phone: "(610) 555-0123",
    organization: "Nazareth Softball Boosters",
    team: "Girls Softball",
    role: "Booster president",
    city: "Nazareth",
    state: "PA",
    timing_month: "March",
    timing_season: "Spring",
    has_logo: "yes",
    notes: "We'd love a navy blanket.",
    website: "",
    started_at: String(NOW.getTime() - 60_000),
    ...overrides,
  };
}

function fakeKlaviyo(fail = false) {
  const events: Array<{ metric: MetricName; to: string; properties: Record<string, unknown>; addToList?: boolean }> = [];
  const client: KlaviyoClient = {
    async sendEvent(metric, to, properties, _uniqueId, options) {
      if (fail) throw new Error("Klaviyo 503");
      events.push({ metric, to: to.email, properties, addToList: options?.addToList });
      return { deliveredTo: to.email };
    },
  };
  return { client, events };
}

async function submit(overrides: Record<string, string> = {}, env = ON, ip: string | null = "203.0.113.5") {
  return submitApplication(db, form(overrides), { ip, now: NOW, env });
}

// ------------------------------------------------------------ App Proxy

describe("App Proxy signature", () => {
  const secret = "shpss_test_secret";
  function signed(params: Record<string, string>) {
    const sp = new URLSearchParams(params);
    sp.set("signature", appProxySignature(sp, secret));
    return new URL(`https://mambe-fundraisers.onrender.com/proxy/apply?${sp}`);
  }
  const base = { shop: "mambe-blanket-co.myshopify.com", path_prefix: "/apps/fundraise", timestamp: String(Math.floor(NOW.getTime() / 1000)), logged_in_customer_id: "" };

  test("a correctly signed request is accepted", () => {
    expect(verifyAppProxy(signed(base), secret, NOW)).toEqual({ ok: true, shop: "mambe-blanket-co.myshopify.com" });
  });
  test("unsigned, tampered, wrong secret and stale requests are rejected", () => {
    expect(verifyAppProxy(new URL(`https://x/proxy/apply?shop=${base.shop}&timestamp=${base.timestamp}`), secret, NOW)).toMatchObject({ ok: false, reason: "unsigned" });
    const tampered = signed(base);
    tampered.searchParams.set("shop", "evil.myshopify.com");
    expect(verifyAppProxy(tampered, secret, NOW)).toMatchObject({ ok: false, reason: "bad signature" });
    expect(verifyAppProxy(signed(base), "other", NOW)).toMatchObject({ ok: false, reason: "bad signature" });
    expect(verifyAppProxy(signed({ ...base, timestamp: String(Math.floor(NOW.getTime() / 1000) - 3600) }), secret, NOW)).toMatchObject({ ok: false, reason: "expired" });
    expect(verifyAppProxy(signed(base), undefined, NOW)).toMatchObject({ ok: false });
  });
  test("applicant IP: first of two or more forwarded addresses, none if only Shopify's", () => {
    expect(applicantIp(new Headers({ "x-forwarded-for": "198.51.100.7, 23.227.38.1" }))).toBe("198.51.100.7");
    expect(applicantIp(new Headers({ "x-forwarded-for": "23.227.38.1" }))).toBeNull();
    expect(applicantIp(new Headers())).toBeNull();
  });
});

// ------------------------------------------------------------ submit

describe("application submit", () => {
  test("a valid submission is saved first, with both emails queued", async () => {
    const r = await submit();
    expect(r.status).toBe("saved");
    const app = await db.application.findFirstOrThrow({ include: { emails: true } });
    expect(app).toMatchObject({
      status: "new",
      email: "trissy@example.com",
      organizationName: "Nazareth Softball Boosters",
      teamName: "Girls Softball",
      roughTiming: "March · Spring season",
      hasLogo: true,
      notes: "We'd love a navy blanket.",
    });
    expect((app.rawSubmission as Record<string, unknown>).timing).toBe("March · Spring season");
    expect(app.emails.map((e) => [e.kind, e.status]).sort()).toEqual([["internal", "pending"], ["received", "pending"]]);
    expect(await db.auditLog.count({ where: { entity: "application", action: "submitted" } })).toBe(1);
  });

  test("required fields are checked on the server too", async () => {
    const r = await submit({ email: "not-an-email", phone: "12", timing_season: "", has_logo: "" });
    expect(r.status).toBe("invalid");
    if (r.status === "invalid") expect(Object.keys(r.errors).sort()).toEqual(["email", "hasLogo", "phone", "timingSeason"]);
    expect(await db.application.count()).toBe(0);
    expect(parseApplication(form()).ok).toBe(true);
  });

  test("honeypot and too-fast submissions are ignored quietly (nothing saved)", async () => {
    expect(await submit({ website: "http://spam.example" })).toEqual({ status: "ignored", reason: "honeypot" });
    expect(await submit({ started_at: String(NOW.getTime() - 1500) })).toEqual({ status: "ignored", reason: "too_fast" });
    expect(await submit({ started_at: "" })).toEqual({ status: "ignored", reason: "no_start_time" });
    expect(await db.application.count()).toBe(0);
  });

  test("rate limits: 3 per email and 5 per IP an hour; only hashes stored", async () => {
    for (let i = 0; i < 3; i++) expect((await submit({}, ON, null)).status).toBe("saved");
    expect(await submit({}, ON, null)).toEqual({ status: "ignored", reason: "rate_limit_email" });
    for (let i = 0; i < 2; i++) expect((await submit({ email: `coach${i}@example.com` }, ON, "198.51.100.9")).status).toBe("saved");
    for (let i = 2; i < 5; i++) expect((await submit({ email: `coach${i}@example.com` }, ON, "198.51.100.9")).status).toBe("saved");
    expect(await submit({ email: "coach9@example.com" }, ON, "198.51.100.9")).toEqual({ status: "ignored", reason: "rate_limit_ip" });
    const keys = (await db.rateLimitEvent.findMany()).map((k) => k.key);
    expect(keys.every((k) => /^apply-(email|ip):[0-9a-f]{64}$/.test(k))).toBe(true);
    expect(keys.join(" ")).not.toContain("example.com");
  });

  test("emails: applicant (no list) and internal (to matt@), staging override is the client's job", async () => {
    await submit();
    const k = fakeKlaviyo();
    const summary = await sendPendingApplicationEmails(db, k.client, { shop: "mambe-blanket-co.myshopify.com", env: ON, now: NOW });
    expect(summary).toMatchObject({ sent: 2 });
    expect(k.events.map((e) => [e.metric, e.to, e.addToList])).toEqual([
      ["Application Received", "trissy@example.com", false],
      ["New Application", "matt@mambeblankets.com", false],
    ]);
    expect(k.events[1]!.properties.admin_link).toMatch(/^https:\/\/admin\.shopify\.com\/store\/mambe-blanket-co\/apps\/.*\/app\/applications\/1$/);
  });

  test("an email failure never loses the application; it retries, then shows in the work queue", async () => {
    await submit();
    const failing = fakeKlaviyo(true);
    await sendPendingApplicationEmails(db, failing.client, { shop: null, env: ON, now: NOW });
    expect(await db.application.count()).toBe(1);
    expect((await db.applicationEmail.findMany()).every((e) => e.status === "pending" && e.attempts === 1)).toBe(true);
    let queue = await loadWorkQueue(db, NOW);
    expect(queue.find((g) => g.key === "application_emails")?.items).toHaveLength(2);

    // The clock retries; Klaviyo is back.
    const ok = fakeKlaviyo();
    vi.stubEnv("APPLICATION_EMAILS_ENABLED", "true");
    await runClock(db, NOW, { klaviyo: ok.client });
    vi.unstubAllEnvs();
    expect(ok.events).toHaveLength(2);
    expect((await db.applicationEmail.findMany()).every((e) => e.status === "sent")).toBe(true);
    queue = await loadWorkQueue(db, NOW);
    expect(queue.find((g) => g.key === "application_emails")).toBeUndefined();
  });

  test("after 3 failed tries an email is failed, alerts, and can be retried", async () => {
    await submit();
    const failing = fakeKlaviyo(true);
    for (let i = 0; i < 3; i++) await sendPendingApplicationEmails(db, failing.client, { shop: null, env: ON, now: NOW });
    const rows = await db.applicationEmail.findMany();
    expect(rows.every((e) => e.status === "failed" && e.attempts === 3)).toBe(true);
    expect(alerts.some((a) => a.includes("failed 3 times"))).toBe(true);
    await retryApplicationEmail(db, rows[0]!.id, "Matt");
    expect((await db.applicationEmail.findUniqueOrThrow({ where: { id: rows[0]!.id } })).status).toBe("pending");
  });

  test("with the switch off, nothing is sent (status off)", async () => {
    await submit({}, OFF);
    expect((await db.applicationEmail.findMany()).map((e) => e.status)).toEqual(["off", "off"]);
    const k = fakeKlaviyo();
    await sendPendingApplicationEmails(db, k.client, { shop: null, env: OFF, now: NOW });
    expect(k.events).toHaveLength(0);
  });
});

// ------------------------------------------------------------ review

async function seedExisting() {
  const org = await db.organization.create({ data: { name: "Nazareth Area High School", type: "booster", city: "Nazareth", state: "PA" } });
  const other = await db.organization.create({ data: { name: "Central High School", type: "school", city: "Dallas", state: "TX" } });
  const team = await db.team.create({ data: { organizationId: org.id, name: "Girls Softball", sport: "Softball" } });
  await db.team.create({ data: { organizationId: org.id, name: "Boys Soccer" } });
  return { org, other, team };
}

describe("accept, decline, spam", () => {
  test("matching suggestions: similar name plus city/state, teams in it, organizer by exact email", async () => {
    const { org, team } = await seedExisting();
    const organizer = await db.organizer.create({ data: { name: "Trissy L", email: "trissy@example.com" } });
    await submit();
    const app = await db.application.findFirstOrThrow();
    const s = await matchSuggestions(db, app.id);
    expect(s.organizations.map((o) => o.id)).toEqual([org.id]);
    expect(s.organizations[0]!.why).toContain("same city");
    expect(s.organizations[0]!.teams.find((t) => t.suggested)?.id).toBe(team.id);
    expect(s.organizer?.id).toBe(organizer.id);

    expect(nameSimilarity("Nazareth Softball Boosters", "Nazareth Area High School")).toBe(0.5);
    expect(nameSimilarity("Nazareth Area HS", "Nazareth Area High School")).toBe(1);
    expect(suggestOrganizations({ organizationName: "Central High", city: "Nazareth", state: "PA" }, [{ id: 1, name: "Central High School", city: "Dallas", state: "TX" }])[0]?.why).toBe("same name");
  });

  test("accept into an existing organization and team: Setup, no dates, timing note, linked, audited", async () => {
    const { org, team } = await seedExisting();
    await submit();
    const app = await db.application.findFirstOrThrow();
    const { fundraiser } = await acceptApplication(db, app.id, { organizationId: org.id, teamId: team.id, useExistingOrganizer: false }, "Matt");
    expect(fundraiser).toMatchObject({ status: "setup", teamId: team.id, productId: null, startDate: null, seasonLabel: "Spring 2027" });
    expect(fundraiser.notes).toContain("Timing: March · Spring season");
    expect(fundraiser.notes).toContain("navy blanket");
    expect(await db.organization.count()).toBe(2); // nothing new
    expect(await db.team.count()).toBe(2);
    const organizer = await db.organizer.findUniqueOrThrow({ where: { email: "trissy@example.com" } });
    expect(await db.fundraiserOrganizer.findFirst({ where: { fundraiserId: fundraiser.id, organizerId: organizer.id, isPrimary: true } })).not.toBeNull();
    expect(await db.application.findUniqueOrThrow({ where: { id: app.id } })).toMatchObject({ status: "converted", convertedFundraiserId: fundraiser.id, reviewedBy: "Matt" });
    const actions = (await db.auditLog.findMany()).map((a) => `${a.entity}:${a.action}`);
    expect(actions).toEqual(expect.arrayContaining(["application:accepted", "fundraiser:create", "fundraiser:from_application", "organizer:create"]));
    await expect(acceptApplication(db, app.id, { organizationId: org.id, teamId: team.id, useExistingOrganizer: false }, "Matt")).rejects.toThrow(/already converted/);
  });

  test("create-new path: new organization, team and organizer from the application", async () => {
    await submit();
    const app = await db.application.findFirstOrThrow();
    await expect(acceptApplication(db, app.id, { organizationId: null, teamId: null, useExistingOrganizer: false }, "Matt")).rejects.toThrow(/type of the new organization/);
    const { fundraiser } = await acceptApplication(db, app.id, { organizationId: null, organizationType: "booster", teamId: null, useExistingOrganizer: false }, "Matt");
    const team = await db.team.findUniqueOrThrow({ where: { id: fundraiser.teamId }, include: { organization: true } });
    expect(team.name).toBe("Girls Softball");
    expect(team.organization).toMatchObject({ name: "Nazareth Softball Boosters", type: "booster", city: "Nazareth", state: "PA" });
    expect((await db.auditLog.findMany()).map((a) => `${a.entity}:${a.action}`)).toEqual(expect.arrayContaining(["organization:create", "team:create"]));
  });

  test("an existing organizer with the same email is reused, never duplicated", async () => {
    const existing = await db.organizer.create({ data: { name: "Trissy L", email: "trissy@example.com" } });
    await submit();
    const app = await db.application.findFirstOrThrow();
    await expect(acceptApplication(db, app.id, { organizationId: null, organizationType: "booster", teamId: null, useExistingOrganizer: false }, "Matt")).rejects.toThrow(/already exists/);
    const { fundraiser } = await acceptApplication(db, app.id, { organizationId: null, organizationType: "booster", teamId: null, useExistingOrganizer: true }, "Matt");
    expect(await db.organizer.count()).toBe(1);
    expect(await db.fundraiserOrganizer.findFirst({ where: { fundraiserId: fundraiser.id, organizerId: existing.id } })).not.toBeNull();
  });

  test("a team from another organization is refused", async () => {
    const { other, team } = await seedExisting();
    await submit();
    const app = await db.application.findFirstOrThrow();
    await expect(acceptApplication(db, app.id, { organizationId: other.id, teamId: team.id, useExistingOrganizer: false }, "Matt")).rejects.toThrow(/different organization/);
  });

  test("decline needs a reason; spam hides it and drops unsent emails", async () => {
    await submit();
    await submit({ email: "bot@example.com" });
    const [a, b] = await db.application.findMany({ orderBy: { id: "asc" } });
    await expect(declineApplication(db, a!.id, " ", "Matt")).rejects.toThrow(/reason is required/);
    await declineApplication(db, a!.id, "Outside our area", "Matt");
    expect(await db.application.findUniqueOrThrow({ where: { id: a!.id } })).toMatchObject({ status: "declined", declineReason: "Outside our area" });
    await markSpam(db, b!.id, "Matt");
    expect((await db.application.findUniqueOrThrow({ where: { id: b!.id } })).status).toBe("spam");
    expect((await db.applicationEmail.findMany({ where: { applicationId: b!.id } })).map((e) => e.status)).toEqual(["off", "off"]);
    expect(await db.application.count({ where: { status: { not: "spam" } } })).toBe(1);
    await expect(markSpam(db, a!.id, "Matt")).rejects.toThrow(/already declined/);
  });

  test("the work queue's applications item counts new ones and links to Applications", async () => {
    await submit();
    const queue = await loadWorkQueue(db, NOW);
    expect(queue.find((g) => g.key === "applications")?.items[0]).toMatchObject({ label: "1 new", href: "/app/applications" });
  });

  test("season label from the timing", () => {
    const oct = new Date("2026-10-12T12:00:00Z");
    expect(seasonLabelFor({ timingMonth: "March", timingSeason: "Spring" }, oct)).toBe("Spring 2027");
    expect(seasonLabelFor({ timingMonth: "October", timingSeason: "Fall" }, oct)).toBe("Fall 2026");
    expect(seasonLabelFor({ timingMonth: "Not sure yet", timingSeason: "Winter" }, oct)).toBe("Winter 2026");
    expect(seasonLabelFor({ timingMonth: "March", timingSeason: "" }, oct)).toBeNull();
  });
});

// ------------------------------------------------------------ Drive

async function fundraiserFor(teamId: number, organizerEmail = "pat@example.com", seasonLabel = "Fall 2026") {
  const organizer = await db.organizer.upsert({ where: { email: organizerEmail }, create: { name: "Pat", email: organizerEmail }, update: {} });
  return createFundraiser(db, { teamId, organizerIds: [organizer.id], primaryOrganizerId: organizer.id, seasonLabel }, "Matt");
}

describe("Drive folders", () => {
  test("creates the structure, stores IDs and ticks the checklist", async () => {
    const { org, team } = await seedTeamAndProduct(CAPE);
    const f = await fundraiserFor(team.id);
    const drive = fakeDrive();
    const r = await createDriveFolders(db, drive.client, f.id, "Matt", NOW);
    expect(r.ok).toBe(true);
    expect(drive.paths()).toEqual([
      "Central High School",
      "Central High School/Girls Lacrosse",
      "Central High School/Girls Lacrosse/2026 Fall",
      "Central High School/Girls Lacrosse/2026 Fall/Internal",
      "Central High School/Girls Lacrosse/2026 Fall/Organizer Assets",
      "Central High School/Girls Lacrosse/_Product & Artwork",
    ]);
    const saved = await db.fundraiser.findUniqueOrThrow({ where: { id: f.id }, include: { team: { include: { organization: true } } } });
    expect(saved.team.organization.driveFolderId).toBe(drive.items.find((i) => i.name === org.name)!.id);
    expect(saved.team.driveArtworkFolderId).toBeTruthy();
    expect(saved).toMatchObject({ driveFoldersCreatedBy: "Matt", driveError: null });
    expect(saved.driveFolderId && saved.driveAssetsFolderId && saved.driveInternalFolderId).toBeTruthy();
  });

  test("run twice: no duplicates; a second fundraiser reuses the organization, team and artwork folders", async () => {
    const { team } = await seedTeamAndProduct(CAPE);
    const a = await fundraiserFor(team.id);
    const b = await fundraiserFor(team.id, "pat@example.com", "Spring 2027");
    const drive = fakeDrive();
    await createDriveFolders(db, drive.client, a.id, "Matt", NOW);
    await createDriveFolders(db, drive.client, a.id, "Matt", NOW);
    expect(drive.items).toHaveLength(6);
    await createDriveFolders(db, drive.client, b.id, "Matt", NOW);
    expect(drive.items).toHaveLength(9);
    expect(drive.paths()).toContain("Central High School/Girls Lacrosse/2027 Spring/Organizer Assets");
    expect(drive.items.filter((i) => i.name === "Central High School")).toHaveLength(1);
    expect(drive.items.filter((i) => i.name === "_Product & Artwork")).toHaveLength(1);
  });

  test("same team and season twice: the second folder carries the public code", async () => {
    const { team } = await seedTeamAndProduct(CAPE);
    const a = await fundraiserFor(team.id);
    const b = await fundraiserFor(team.id);
    const drive = fakeDrive();
    await createDriveFolders(db, drive.client, a.id, "Matt", NOW);
    await createDriveFolders(db, drive.client, b.id, "Matt", NOW);
    expect(drive.paths()).toContain(`Central High School/Girls Lacrosse/2026 Fall (${b.publicCode})`);
  });

  test("failure: recorded with Retry and a work-queue item; retry carries on without duplicates", async () => {
    const { team } = await seedTeamAndProduct(CAPE);
    const f = await fundraiserFor(team.id);
    const drive = fakeDrive({ failOn: (name) => name === "Internal" });
    const r = await createDriveFolders(db, drive.client, f.id, "Matt", NOW);
    expect(r).toMatchObject({ ok: false });
    let saved = await db.fundraiser.findUniqueOrThrow({ where: { id: f.id } });
    expect(saved.driveError).toContain("403");
    expect(saved.driveFoldersCreatedAt).toBeNull();
    expect(alerts.some((a) => a.includes("Drive folders failed"))).toBe(true);
    const queue = await loadWorkQueue(db, NOW);
    expect(queue.find((g) => g.key === "drive")?.items[0]).toMatchObject({ label: f.publicCode, href: `/app/fundraisers/${f.id}#drive` });

    drive.setFail(undefined);
    expect((await createDriveFolders(db, drive.client, f.id, "Matt", NOW)).ok).toBe(true);
    saved = await db.fundraiser.findUniqueOrThrow({ where: { id: f.id } });
    expect(saved.driveError).toBeNull();
    expect(saved.driveFoldersCreatedAt).not.toBeNull();
    expect(drive.items).toHaveLength(6);
  });

  test("accepting an application creates the folders too", async () => {
    await submit();
    const app = await db.application.findFirstOrThrow();
    const drive = fakeDrive();
    const { drive: result } = await acceptApplication(db, app.id, { organizationId: null, organizationType: "booster", teamId: null, useExistingOrganizer: false }, "Matt", { drive: drive.client });
    expect(result?.ok).toBe(true);
    expect(drive.paths()).toContain("Nazareth Softball Boosters/Girls Softball/2027 Spring/Organizer Assets");
  });

  test("season folder name: label, else start date, else today", () => {
    expect(seasonFolderName({ seasonLabel: "Fall 2026", startDate: null, timezone: "America/Los_Angeles" })).toBe("2026 Fall");
    expect(seasonFolderName({ seasonLabel: null, startDate: new Date("2026-10-01T00:00:00Z"), timezone: "America/Los_Angeles" })).toBe("2026 Fall");
    expect(seasonFolderName({ seasonLabel: null, startDate: new Date("2027-03-15T00:00:00Z"), timezone: "America/Los_Angeles" })).toBe("2027 Spring");
    expect(seasonFolderName({ seasonLabel: null, startDate: null, timezone: "America/Los_Angeles" }, new Date("2026-12-20T20:00:00Z"))).toBe("2026 Winter");
  });
});

// ------------------------------------------------------------ reports

let orderSeq = 7000;
async function sell(at: Date, quantity = 1, productId = CAPE) {
  const id = String(orderSeq++);
  const parsed = normalizeOrder(shopifyOrderNode({ id, name: `#${id}`, processedAt: at, lines: [{ id: `${id}0`, productId, quantity }] }));
  await saveOrder(db, parsed.order, parsed.lines);
}

async function reportFixtures() {
  const { team, product } = await seedTeamAndProduct(CAPE);
  const organizer = await db.organizer.create({ data: { name: "Pat", email: "pat@example.com" } });
  const base = { teamId: team.id, productId: product.id, organizerIds: [organizer.id], primaryOrganizerId: organizer.id, paypalPayeeEmail: "club@example.com" };
  const fall = await createFundraiser(db, { ...base, startDate: "2026-09-01", endDate: "2026-09-15", publicCode: "CHS-GLAX-F26" }, "Matt");
  const spring = await createFundraiser(db, { ...base, startDate: "2027-03-01", endDate: "2027-03-15", publicCode: "CHS-GLAX-S27" }, "Matt");
  // A second team with one fundraiser and no sales.
  const other = await db.team.create({ data: { organizationId: team.organizationId, name: "Boys Soccer" } });
  await fundraiserFor(other.id, "sam@example.com");
  await sell(pt("2026-08-20T10:00")); // before: outside window, before first ended
  await sell(pt("2026-09-05T10:00"), 2); // fall: 2 qualifying
  await sell(pt("2026-09-10T10:00"), 1); // fall: 1 qualifying
  await sell(pt("2026-10-01T10:00"), 1); // after first ended: outside
  await sell(pt("2027-03-05T10:00"), 2); // spring: after first ended, in a later fundraiser
  // Fall's payout paid ($75), spring has none yet.
  await db.fundraiser.update({ where: { id: fall.id }, data: { status: "paid" } });
  await db.payout.create({
    data: { fundraiserId: fall.id, rateCents: 2500, qualifyingUnits: 3, amountCents: 7500, finalCents: 7500, status: "paid", paidAmountCents: 7500, paidAt: NOW, approvedAt: NOW, paypalReference: "PP-1", payeeEmail: "club@example.com" },
  });
  return { fall, spring, team, other };
}

describe("reports", () => {
  test("each table's numbers against a known set of fixtures", async () => {
    await reportFixtures();
    const tables = Object.fromEntries((await buildReports(db, new Date("2027-04-01T00:00:00Z"))).map((t) => [t.key, t]));

    expect(tables["by-status"]!.rows).toEqual(expect.arrayContaining([["Setup", 2], ["Paid", 1], ["Active", 0]]));
    expect(tables["by-status"]!.totals).toEqual(["Total", 3]);

    expect(tables["raised-by-fundraiser"]!.rows).toEqual([
      ["CHS-GLAX-F26", "Central High School", "Girls Lacrosse", "Paid", 3, 7500, "final"],
      ["CHS-GLAX-S27", "Central High School", "Girls Lacrosse", "Setup", 2, 5000, "estimated"],
      [expect.stringMatching(/^CHS-/), "Central High School", "Boys Soccer", "Setup", 0, 0, "estimated"],
    ]);
    expect(tables["raised-by-team"]!.rows).toEqual([
      ["Girls Lacrosse", "Central High School", 2, 5, 12500],
      ["Boys Soccer", "Central High School", 1, 0, 0],
    ]);
    expect(tables["raised-by-organization"]!.rows).toEqual([["Central High School", 3, 5, 12500]]);

    expect(tables["payouts"]!.rows).toEqual([
      ["Draft (to review)", 0, 0],
      ["Approved, not paid", 0, 0],
      ["Outstanding (draft + approved)", 0, 0],
      ["Paid", 1, 7500],
    ]);

    // 7 net units: 5 in windows, 2 outside (Aug 20 and Oct 1). Fixture price is $40.
    const [title, , net, inU, inR, outU, outR] = tables["products"]!.rows[0]!;
    expect([title, net, inU, outU]).toEqual(["Central High Girls Lacrosse Cape", 7, 5, 2]);
    expect(inR).toBe(5 * (outR as number) / 2);

    expect(tables["repeat-rate"]!.note).toContain("1 of 2 teams");
    expect(tables["repeat-rate"]!.totals).toEqual(["Repeat teams: 1 of 2", null, "50%"]);

    // After CHS-GLAX-F26 ended (Sep 16 PT): Oct 1 (1, outside) + Mar 5 (2, in spring).
    expect(tables["after-first"]!.rows).toEqual([["Girls Lacrosse", "Central High School", "CHS-GLAX-F26", "2026-09-16", 3, expect.any(Number), 2, 1]]);
  });

  test("orders behind each fundraiser: counted lines plus nearby outside-window sales, no customer details", async () => {
    await reportFixtures();
    const table = await ordersByFundraiser(db, "mambe-blanket-co.myshopify.com");
    const fall = table.rows.filter((r) => r[0] === "CHS-GLAX-F26");
    // Aug 20 (outside, within 30 days before), Sep 5 (2), Sep 10 (1), Oct 1 (outside, within 30 days after).
    expect(fall.map((r) => [r[2], r[5], r[6]])).toEqual([
      ["2026-08-20 10:00", 0, "Outside window"],
      ["2026-09-05 10:00", 2, "Qualifying"],
      ["2026-09-10 10:00", 1, "Qualifying"],
      ["2026-10-01 10:00", 0, "Outside window"],
    ]);
    expect(String(fall[1]![11])).toMatch(/^https:\/\/admin\.shopify\.com\/store\/mambe-blanket-co\/orders\/\d+$/);
    const csv = reportCsv(table);
    expect(csv.split(/\r?\n/)[0]).toBe(
      "Fundraiser,Order,Checkout (fundraiser time),Quantity,Refunded,Units counted,Outcome,Line price,Discount codes,Flags,Your decision,Shopify link",
    );
    expect(csv).not.toMatch(/@|Laurito|Pat\b/);
  });

  test("CSV columns and money in dollars", async () => {
    await reportFixtures();
    const tables = await buildReports(db, new Date("2027-04-01T00:00:00Z"));
    const csv = reportCsv(tables.find((t) => t.key === "raised-by-fundraiser")!);
    const lines = csv.trim().split(/\r?\n/);
    expect(lines[0]).toBe("Fundraiser,Organization,Team,Status,Qualifying units,Raised,Basis");
    expect(lines[1]).toBe("CHS-GLAX-F26,Central High School,Girls Lacrosse,Paid,3,75.00,final");
    expect(lines.at(-1)).toBe("Total,,,,5,125.00,");
    for (const t of tables) expect(reportCsv(t).split(/\r?\n/)[0]).toBe(t.columns.map((c) => c.label).join(","));
  });
});

// ------------------------------------------------------------ backup

describe("weekly payout backup", () => {
  const MONDAY = new Date("2026-10-12T16:00:00Z"); // Mon 9 AM PT
  const TUESDAY = new Date("2026-10-13T16:00:00Z");

  test("due on Mondays only, once; writes the accountant CSV to _Backups named with the date", async () => {
    await reportFixtures();
    expect(await backupIsDue(db, TUESDAY)).toBe(false);
    expect(await backupIsDue(db, MONDAY)).toBe(true);
    const drive = fakeDrive();
    await runClock(db, MONDAY, { drive: drive.client });
    expect(drive.paths()).toEqual(["_Backups", "_Backups/mambe-payouts-2026-10-12.csv"]);
    const file = drive.items.find((i) => i.kind === "file")!;
    expect(file.mimeType).toBe("text/csv");
    expect(file.content).toBe(accountantCsv(await accountantRows(db)));
    expect(file.content!.split(/\r?\n/)[0]).toBe("Fundraiser,Organization,Team,Payee email,Units,Rate,Calculated,Adjustments,Final,Status,Approved date,Paid date,Amount paid,PayPal reference");
    expect(file.content).toContain("CHS-GLAX-F26");
    // Later runs that Monday do nothing; next Monday reuses the _Backups folder.
    await runClock(db, new Date(MONDAY.getTime() + 15 * 60_000), { drive: drive.client });
    expect(drive.items.filter((i) => i.kind === "file")).toHaveLength(1);
    await runClock(db, new Date("2026-10-19T16:00:00Z"), { drive: drive.client });
    expect(drive.paths()).toEqual(["_Backups", "_Backups/mambe-payouts-2026-10-12.csv", "_Backups/mambe-payouts-2026-10-19.csv"]);
  });

  test("failure alerts, shows in the work queue, and retries an hour later", async () => {
    const drive = fakeDrive({ failOn: (name) => name.endsWith(".csv") });
    const r = await runPayoutBackup(db, drive.client, MONDAY);
    expect(r.ok).toBe(false);
    expect(alerts.some((a) => a.includes("Weekly payout backup to Drive failed"))).toBe(true);
    const queue = await loadWorkQueue(db, MONDAY);
    expect(queue.find((g) => g.key === "backup")?.tone).toBe("critical");
    expect(await backupIsDue(db, new Date(MONDAY.getTime() + 30 * 60_000))).toBe(false);
    expect(await backupIsDue(db, new Date(MONDAY.getTime() + 61 * 60_000))).toBe(true);
    drive.setFail(undefined);
    expect((await runPayoutBackup(db, drive.client, new Date(MONDAY.getTime() + 61 * 60_000))).ok).toBe(true);
    expect((await loadWorkQueue(db, MONDAY)).find((g) => g.key === "backup")).toBeUndefined();
  });
});

// ------------------------------------------------------------ product deleted

describe("product deleted while its fundraiser is running", () => {
  test("alerts and shows a red work-queue item; lines are kept", async () => {
    const { team, product } = await seedTeamAndProduct(CAPE);
    const organizer = await db.organizer.create({ data: { name: "Pat", email: "pat@example.com" } });
    const f = await createFundraiser(db, { teamId: team.id, productId: product.id, startDate: "2026-10-01", endDate: "2026-10-31", organizerIds: [organizer.id], primaryOrganizerId: organizer.id }, "Matt");
    await db.fundraiser.update({ where: { id: f.id }, data: { status: "active" } });
    await sell(pt("2026-10-05T10:00"));
    await markProductDeleted(db, CAPE);
    expect(alerts.some((a) => a.includes("was deleted in Shopify while") && a.includes(f.publicCode))).toBe(true);
    const group = (await loadWorkQueue(db, NOW)).find((g) => g.key === "product_deleted");
    expect(group).toMatchObject({ tone: "critical", count: 1 });
    expect(group!.items[0]!.label).toBe(f.publicCode);
    expect(await db.orderLineItem.count({ where: { attributedFundraiserId: f.id, outcome: "qualifying" } })).toBe(1);
  });

  test("no alert for a product without a running fundraiser", async () => {
    await seedTeamAndProduct(CAPE);
    await markProductDeleted(db, CAPE);
    expect(alerts.some((a) => a.includes("was deleted in Shopify while"))).toBe(false);
  });
});

describe("work queue (pure)", () => {
  test("undated Setup fundraisers don't break date-based items", () => {
    const groups = buildWorkQueue({
      now: NOW,
      fundraisers: [{ id: 1, publicCode: "X", status: "setup", startDate: null, endDate: null, windowEnd: null, waitingOnOrganizerSince: null }],
      newApplications: 0,
      flagsByFundraiser: [],
      payoutsToSend: { count: 0, amountCents: 0 },
      failedWebhooks: 0,
      lastNightlyOkAt: NOW,
      webhookSilence: false,
    });
    expect(groups.find((g) => g.key === "launch_soon")).toBeUndefined();
  });
});

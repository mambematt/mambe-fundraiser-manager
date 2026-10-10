// Session 4: portal security (Case 24), the two owner switches, the email
// schedule, and storefront writes, against the real database.
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { CHECKLIST_ITEMS } from "../../app/lib/checklist";
import { normalizeOrder } from "../../app/lib/shopify-order";
import { hashToken } from "../../app/lib/portal-tokens.server";
import { saveOrder } from "../../app/services/order-sync.server";
import { applyDatesRateChange, createFundraiser, setChecklistItem } from "../../app/services/fundraisers.server";
import { approveLaunch, afterDatesChanged, cancelFundraiser } from "../../app/services/lifecycle.server";
import { planCommunications, sendNow, setEmailsEnabled } from "../../app/services/communications.server";
import { runClock } from "../../app/services/jobs.server";
import type { KlaviyoClient, MetricName } from "../../app/services/klaviyo.server";
import { setStorefrontEnabled } from "../../app/services/storefront.server";
import { refreshProduct } from "../../app/services/products.server";
import {
  consumeLoginToken,
  createSession,
  issueLoginLink,
  NEUTRAL_REPLY,
  portalView,
  requestLoginLink,
  sessionOrganizerId,
  signOutEverywhere,
} from "../../app/services/portal.server";
import { resetDb, seedTeamAndProduct, testDb } from "../helpers/db";
import { fakeShopify } from "../helpers/fake-shopify";
import { CAPE, pt, shopifyOrderNode } from "../helpers/fixtures";

const db = testDb();
beforeEach(resetDb);
afterAll(() => db.$disconnect());

function fakeKlaviyo() {
  const events: Array<{ metric: MetricName; to: string; properties: Record<string, unknown> }> = [];
  const client: KlaviyoClient = {
    sendEvent: async (metric, to, properties) => {
      events.push({ metric, to: to.email, properties });
      return { deliveredTo: to.email };
    },
  };
  return { client, events };
}

async function seed(startDate = "2026-10-01", endDate = "2026-11-15", email = "trissy@example.org") {
  const { team, product } = await seedTeamAndProduct(CAPE);
  const organizer = await db.organizer.create({ data: { name: "Trissy Laurito", email } });
  const f = await createFundraiser(
    db,
    { teamId: team.id, productId: product.id, startDate, endDate, paypalPayeeEmail: email, organizerIds: [organizer.id], primaryOrganizerId: organizer.id },
    "Matt",
  );
  for (const item of CHECKLIST_ITEMS) await setChecklistItem(db, f.id, item.key, true, "Matt");
  return { f, organizer, product };
}

describe("Case 24: portal access", () => {
  test("organizer A can't see organizer B's fundraiser, even by guessing its id", async () => {
    const { f: fA, organizer: a } = await seed();
    const otherProduct = await db.product.create({ data: { shopifyProductId: "2002", handle: "b", title: "B cape", status: "ACTIVE", tags: ["fundraiser"] } });
    const team = await db.team.findFirstOrThrow();
    const b = await db.organizer.create({ data: { name: "Other Person", email: "b@example.org" } });
    const fB = await createFundraiser(
      db,
      { teamId: team.id, productId: otherProduct.id, startDate: "2026-10-01", endDate: "2026-10-31", organizerIds: [b.id], primaryOrganizerId: b.id },
      "Matt",
    );
    expect(await portalView(db, fA.id, a.id)).not.toBeNull();
    expect(await portalView(db, fB.id, a.id)).toBeNull();
    expect(await portalView(db, fA.id, b.id)).toBeNull();
    expect(await portalView(db, 99999, a.id)).toBeNull();
  });

  test("a used login link and an expired login link are both refused; only the hash is stored", async () => {
    const { organizer } = await seed();
    const k = fakeKlaviyo();
    const now = pt("2026-10-09T10:00:00");
    await issueLoginLink(db, k.client, organizer.id, now);
    const link = String(k.events[0]!.properties.login_link);
    const token = link.split("/auth/")[1]!;
    const row = await db.portalLoginToken.findFirstOrThrow();
    expect(row.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(row)).not.toContain(token);

    expect(await consumeLoginToken(db, token, new Date(now.getTime() + 60_000))).toBe(organizer.id);
    expect(await consumeLoginToken(db, token, new Date(now.getTime() + 120_000))).toBeNull(); // used

    await issueLoginLink(db, k.client, organizer.id, now);
    const token2 = String(k.events[1]!.properties.login_link).split("/auth/")[1]!;
    expect(await consumeLoginToken(db, token2, new Date(now.getTime() + 31 * 60_000))).toBeNull(); // expired
    expect(await consumeLoginToken(db, "made-up-token-that-does-not-exist", now)).toBeNull();
  });
});

describe("login links", () => {
  test("never reveals whether an email exists; rate-limited per email and per IP", async () => {
    await seed();
    const k = fakeKlaviyo();
    const now = pt("2026-10-09T10:00:00");
    expect(await requestLoginLink(db, k.client, "nobody@example.org", "1.1.1.1", now)).toBe(NEUTRAL_REPLY);
    expect(await requestLoginLink(db, k.client, "TRISSY@example.org", "1.1.1.1", now)).toBe(NEUTRAL_REPLY);
    expect(k.events).toHaveLength(1);
    expect(k.events[0]).toMatchObject({ metric: "Portal Login Link", to: "trissy@example.org" });

    await requestLoginLink(db, k.client, "trissy@example.org", "2.2.2.2", now);
    await requestLoginLink(db, k.client, "trissy@example.org", "3.3.3.3", now);
    expect(await requestLoginLink(db, k.client, "trissy@example.org", "4.4.4.4", now)).toBe(NEUTRAL_REPLY); // 4th this hour
    expect(k.events).toHaveLength(3);

    const ipEvents = k.events.length;
    for (let i = 0; i < 12; i++) await requestLoginLink(db, k.client, `x${i}@example.org`, "9.9.9.9", now);
    expect(k.events).toHaveLength(ipEvents); // unknown emails never send anyway
    expect(await db.rateLimitEvent.count({ where: { key: { startsWith: "ip:" } } })).toBeGreaterThan(0);
    expect((await db.rateLimitEvent.findMany()).every((r) => !r.key.includes("@") && !r.key.includes("9.9.9.9"))).toBe(true);
  });

  test("retrying while limited doesn't extend the wait", async () => {
    await seed();
    const k = fakeKlaviyo();
    const t0 = pt("2026-10-09T10:00:00");
    const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);
    for (const m of [0, 1, 2]) await requestLoginLink(db, k.client, "trissy@example.org", `10.0.0.${m}`, at(m));
    expect(k.events).toHaveLength(3);
    for (const m of [5, 20, 40, 59]) await requestLoginLink(db, k.client, "trissy@example.org", "10.0.1.1", at(m)); // limited
    expect(k.events).toHaveLength(3);
    await requestLoginLink(db, k.client, "trissy@example.org", "10.0.1.1", at(61)); // an hour after the first: works again
    expect(k.events).toHaveLength(4);
  });

  test("sessions last 45 days; sign out everywhere ends them", async () => {
    const { organizer } = await seed();
    const now = pt("2026-10-09T10:00:00");
    const raw = await createSession(db, organizer.id, now);
    expect(await sessionOrganizerId(db, raw, new Date(now.getTime() + 44 * 24 * 3600 * 1000))).toBe(organizer.id);
    expect(await sessionOrganizerId(db, raw, new Date(now.getTime() + 46 * 24 * 3600 * 1000))).toBeNull();
    expect(await signOutEverywhere(db, organizer.id, "Matt")).toBe(1);
    expect(await sessionOrganizerId(db, raw, now)).toBeNull();
  });
});

describe("owner switches", () => {
  test("both off (default): launch and the clock write nothing to Shopify and send nothing", async () => {
    const { f } = await seed();
    const shopify = fakeShopify();
    const k = fakeKlaviyo();
    await approveLaunch(db, { shopify, klaviyo: k.client }, f.id, "Matt", pt("2026-09-25T10:00:00"));
    for (const at of ["2026-10-01T00:05:00", "2026-10-14T09:05:00", "2026-11-16T00:05:00"]) {
      await runClock(db, pt(at), { shopify, klaviyo: k.client });
    }
    expect(shopify.writes).toEqual([]);
    expect(k.events).toEqual([]);
    expect(await db.communication.count()).toBe(0);
    expect((await db.fundraiser.findUniqueOrThrow({ where: { id: f.id } })).status).toBe("settling");
  });

  test("Storefront on: launch writes the short link and banner first; the clock clears the banner at the end", async () => {
    const { f, product } = await seed();
    const shopify = fakeShopify();
    await setStorefrontEnabled(db, shopify, f.id, true, "Matt");
    await approveLaunch(db, { shopify, klaviyo: null }, f.id, "Matt", pt("2026-09-25T10:00:00"));
    expect(shopify.writes.map((w) => w.op)).toEqual(["createRedirect", "setBanner"]);
    expect(shopify.writes[0]!.args).toEqual(["/go/chs-glax", `/products/${product.handle}`]);
    const row = await db.fundraiser.findUniqueOrThrow({ where: { id: f.id } });
    expect(row).toMatchObject({ status: "scheduled", shortUrl: "/go/chs-glax", bannerState: "on" });

    await runClock(db, pt("2026-10-01T00:05:00"), { shopify }); // start: already on, nothing to write
    expect(shopify.writes).toHaveLength(2);
    await runClock(db, pt("2026-11-16T00:05:00"), { shopify }); // end: cleared
    expect(shopify.writes.map((w) => w.op)).toEqual(["createRedirect", "setBanner", "clearBanner"]);
    expect((await db.fundraiser.findUniqueOrThrow({ where: { id: f.id } })).bannerState).toBe("off");
    await runClock(db, pt("2026-11-16T00:20:00"), { shopify }); // safe to repeat
    expect(shopify.writes).toHaveLength(3);
    expect(await db.auditLog.count({ where: { action: "switch:storefront_on" } })).toBe(1);
  });

  test("a failed Shopify write blocks the launch and is retried by the clock", async () => {
    const { f } = await seed();
    let fail = true;
    const shopify = fakeShopify({
      setProductBanner: async () => {
        if (fail) throw new Error("Shopify is down");
      },
    });
    await setStorefrontEnabled(db, shopify, f.id, true, "Matt");
    await expect(approveLaunch(db, { shopify, klaviyo: null }, f.id, "Matt", pt("2026-09-25T10:00:00"))).rejects.toThrow(/Shopify refused/);
    expect((await db.fundraiser.findUniqueOrThrow({ where: { id: f.id } })).status).toBe("setup");
    expect((await db.fundraiser.findUniqueOrThrow({ where: { id: f.id } })).storefrontError).toMatch(/Shopify is down/);
    fail = false;
    await approveLaunch(db, { shopify, klaviyo: null }, f.id, "Matt", pt("2026-09-25T10:10:00"));
    expect((await db.fundraiser.findUniqueOrThrow({ where: { id: f.id } })).storefrontError).toBeNull();
  });

  test("a product handle change re-points the short link", async () => {
    const { f, product } = await seed();
    const shopify = fakeShopify({
      fetchProduct: async () => ({ shopifyProductId: CAPE, handle: "new-handle", title: product.title, status: "ACTIVE", tags: ["fundraiser"] }),
    });
    await setStorefrontEnabled(db, shopify, f.id, true, "Matt");
    await approveLaunch(db, { shopify, klaviyo: null }, f.id, "Matt", pt("2026-09-25T10:00:00"));
    await refreshProduct(db, shopify, CAPE);
    const update = shopify.writes.find((w) => w.op === "updateRedirect")!;
    expect(update.args).toEqual(["gid://shopify/UrlRedirect/1", "/products/new-handle"]);
    expect(await db.auditLog.count({ where: { action: "short_link:repointed" } })).toBe(1);
  });
});

describe("organizer emails", () => {
  test("switched on mid-campaign: past reminders are skipped, never sent late; due ones send at 9 AM", async () => {
    const { f } = await seed();
    await db.fundraiser.update({ where: { id: f.id }, data: { status: "active" } });
    const k = fakeKlaviyo();
    await setEmailsEnabled(db, f.id, true, "Matt", pt("2026-10-09T10:00:00"));

    const rows = await db.communication.findMany({ orderBy: { scheduledFor: "asc" } });
    expect(rows.map((r) => [r.kind, r.reminderNumber, r.status])).toEqual([
      ["reminder", 1, "skipped_past_due"],
      ["reminder", 2, "scheduled"],
      ["reminder", 3, "scheduled"],
      ["final", null, "scheduled"],
    ]);

    // Flipping the switch or a deploy never fires anything by itself.
    await runClock(db, pt("2026-10-09T10:15:00"), { klaviyo: k.client });
    expect(k.events).toHaveLength(0);

    await runClock(db, pt("2026-10-14T09:00:00"), { klaviyo: k.client });
    expect(k.events).toHaveLength(1);
    expect(k.events[0]).toMatchObject({ metric: "Fundraiser Reminder", to: "trissy@example.org" });
    expect(k.events[0]!.properties).toMatchObject({ reminder_number: 2, units_so_far: 0, fundraiser_code: "CHS-GLAX-F26", portal_link: expect.stringMatching(/\/portal$/) });
    await runClock(db, pt("2026-10-14T09:15:00"), { klaviyo: k.client });
    expect(k.events).toHaveLength(1); // sent once
  });

  test("a due reminder the clock missed by more than 2 hours is skipped, not sent late", async () => {
    const { f } = await seed();
    await db.fundraiser.update({ where: { id: f.id }, data: { status: "active" } });
    const k = fakeKlaviyo();
    await setEmailsEnabled(db, f.id, true, "Matt", pt("2026-10-09T10:00:00"));
    await runClock(db, pt("2026-10-14T11:30:00"), { klaviyo: k.client });
    expect(k.events).toHaveLength(0);
    expect((await db.communication.findFirstOrThrow({ where: { reminderNumber: 2 } })).status).toBe("skipped_past_due");
  });

  test("emails off sends nothing; a date change re-plans; cancelling cancels unsent rows", async () => {
    const { f } = await seed();
    await db.fundraiser.update({ where: { id: f.id }, data: { status: "active" } });
    expect(await planCommunications(db, f.id, pt("2026-10-09T10:00:00"))).toEqual([]); // switch off: no rows
    await setEmailsEnabled(db, f.id, true, "Matt", pt("2026-10-09T10:00:00"));

    await applyDatesRateChange(db, f.id, { startDate: "2026-10-01", endDate: "2026-10-31", payoutRateCents: 2500 }, "Shorter", "Matt");
    await afterDatesChanged(db, f.id, pt("2026-10-09T10:05:00"));
    const replanned = await db.communication.findMany({ where: { status: "scheduled" }, orderBy: { scheduledFor: "asc" } });
    expect(replanned.map((r) => [r.kind, r.scheduledFor!.toISOString().slice(0, 10)])).toEqual([
      ["reminder", "2026-10-14"],
      ["final", "2026-10-29"],
    ]);
    expect(await db.communication.count({ where: { kind: "reminder", reminderNumber: 1 } })).toBe(1); // the skipped one stays, once

    await cancelFundraiser(db, { shopify: null, klaviyo: null }, f.id, "Season cancelled", "Matt", pt("2026-10-10T10:00:00"));
    expect(await db.communication.count({ where: { status: "scheduled" } })).toBe(0);
    expect(await db.communication.count({ where: { status: "cancelled" } })).toBe(2);
  });

  test("launch with emails on sends the launch email; the end sends Fundraiser Ended once; Send now is audited", async () => {
    const { f } = await seed();
    const k = fakeKlaviyo();
    await setEmailsEnabled(db, f.id, true, "Matt", pt("2026-09-25T09:00:00")); // Setup: nothing planned yet
    expect(await db.communication.count()).toBe(0);
    await approveLaunch(db, { shopify: null, klaviyo: k.client }, f.id, "Matt", pt("2026-09-25T10:00:00"));
    expect(k.events.map((e) => e.metric)).toEqual(["Fundraiser Launched"]);
    expect(await db.communication.count({ where: { kind: { in: ["reminder", "final"] }, status: "scheduled" } })).toBe(4);

    await runClock(db, pt("2026-11-16T00:05:00"), { klaviyo: k.client });
    await runClock(db, pt("2026-11-16T00:20:00"), { klaviyo: k.client });
    expect(k.events.filter((e) => e.metric === "Fundraiser Ended")).toHaveLength(1);

    const row = await db.communication.findFirstOrThrow({ where: { kind: "reminder", status: { not: "sent" } } });
    await sendNow(db, k.client, row.id, "Matt", pt("2026-11-16T09:00:00"));
    expect(await db.auditLog.count({ where: { action: "email:send_now" } })).toBe(1);
    await setEmailsEnabled(db, f.id, false, "Matt");
    const another = await db.communication.findFirstOrThrow({ where: { kind: "final" } });
    await expect(sendNow(db, k.client, another.id, "Matt")).rejects.toThrow(/Turn on Organizer emails/);
  });
});

describe("portal content", () => {
  test("counts only: never order numbers or customer details", async () => {
    const { f, organizer } = await seed();
    await db.fundraiser.update({ where: { id: f.id }, data: { status: "active" } });
    const parsed = normalizeOrder(shopifyOrderNode({ id: "4242", name: "#SECRET-ORDER-111494", processedAt: pt("2026-10-05T10:00:00"), lines: [{ id: "42420", productId: CAPE, quantity: 2 }] }));
    await saveOrder(db, parsed.order, parsed.lines);
    await db.asset.create({ data: { fundraiserId: f.id, kind: "flyer", title: "Flyer", url: "https://example.org/f", visibility: "organizer" } });
    await db.asset.create({ data: { fundraiserId: f.id, kind: "other", title: "Internal plan", url: "https://example.org/i", visibility: "internal" } });

    const view = await portalView(db, f.id, organizer.id, pt("2026-10-09T10:00:00"));
    expect(view).toMatchObject({ units: 2, estimatedRaised: "$50.00", dayStatus: "37 days left", statusMessage: "Your fundraiser is live." });
    expect(view!.assets.map((a) => a.title)).toEqual(["Flyer"]);
    const json = JSON.stringify(view);
    expect(json).not.toContain("SECRET-ORDER");
    expect(json).not.toContain("4242");
    expect(json).not.toMatch(/"order/i);
  });
});

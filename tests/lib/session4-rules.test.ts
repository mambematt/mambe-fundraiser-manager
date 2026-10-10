import { describe, expect, test } from "vitest";
import { planReminders } from "../../app/lib/reminders";
import { bannerValue, bannerVisibleOn, defaultBannerTeamName, defaultSlug, DEFAULT_BANNER_TEXT, normalizeSlug, renderBannerText } from "../../app/lib/storefront";
import { suggestedAction } from "../../app/content/portal-copy";
import { hashToken, newToken } from "../../app/lib/portal-tokens.server";

const plan = (start: string, end: string) =>
  planReminders(start, end).map((e) => [e.kind, e.reminderNumber, e.date, e.scheduledFor.toISOString()]);

describe("reminder plan (owner decision, session 4)", () => {
  test("31-day fundraiser: day 7, day 14, final 3 days (day 28 skipped, within 5 days of final) = 3 emails", () => {
    expect(plan("2026-10-01", "2026-10-31")).toEqual([
      ["reminder", 1, "2026-10-07", "2026-10-07T16:00:00.000Z"],
      ["reminder", 2, "2026-10-14", "2026-10-14T16:00:00.000Z"],
      ["final", null, "2026-10-29", "2026-10-29T16:00:00.000Z"],
    ]);
  });

  test("46-day NS-GSB-F26: Oct 7, Oct 14, Oct 28, final Nov 13; 9 AM Pacific across the Nov 1 change", () => {
    expect(plan("2026-10-01", "2026-11-15")).toEqual([
      ["reminder", 1, "2026-10-07", "2026-10-07T16:00:00.000Z"], // 9 AM PDT
      ["reminder", 2, "2026-10-14", "2026-10-14T16:00:00.000Z"],
      ["reminder", 3, "2026-10-28", "2026-10-28T16:00:00.000Z"],
      ["final", null, "2026-11-13", "2026-11-13T17:00:00.000Z"], // 9 AM PST
    ]);
  });

  test("short fundraisers", () => {
    expect(plan("2026-10-01", "2026-10-03")).toEqual([["final", null, "2026-10-01", "2026-10-01T16:00:00.000Z"]]);
    expect(plan("2026-10-01", "2026-10-10").map((e) => e[0])).toEqual(["final"]); // day 7 is within 5 days of the final (Oct 8)
    expect(plan("2026-10-01", "2026-10-20").map((e) => e[2])).toEqual(["2026-10-07", "2026-10-18"]);
  });
});

describe("short link and banner", () => {
  test("default slug drops the season", () => {
    expect(defaultSlug("NS-GSB-F26")).toBe("ns-gsb");
    expect(defaultSlug("CHS-GLAX-F26-2")).toBe("chs-glax-f26-2");
    expect(normalizeSlug(" /go/NS GSB! ")).toBe("ns-gsb");
  });

  test("banner text and the block's own date check", () => {
    const value = bannerValue({ publicCode: "NS-GSB-F26", teamName: "Nazareth Softball", payoutRateCents: 2500, startDate: "2026-10-01", endDate: "2026-11-15" });
    expect(renderBannerText(DEFAULT_BANNER_TEXT, value)).toBe("Through Nov 15, $25 from every purchase goes to Nazareth Softball.");
    expect(bannerValue({ publicCode: "X", teamName: "T", payoutRateCents: 2550, startDate: "2026-10-01", endDate: "2026-10-31" }).rate).toBe("25.50");
    expect(bannerVisibleOn("2026-09-30", value)).toBe(false);
    expect(bannerVisibleOn("2026-10-01", value)).toBe(true);
    expect(bannerVisibleOn("2026-11-15", value)).toBe(true);
    expect(bannerVisibleOn("2026-11-16", value)).toBe(false); // hides itself even if the field was never cleared
    expect(defaultBannerTeamName("Central High School", "Girls Lacrosse")).toBe("Central High School Girls Lacrosse");
  });
});

describe("portal copy and tokens", () => {
  test("this week's suggestion", () => {
    expect(suggestedAction({ status: "active", day: 2, daysLeft: 30 })).toMatch(/launch email/);
    expect(suggestedAction({ status: "active", day: 10, daysLeft: 20 })).toMatch(/social image/);
    expect(suggestedAction({ status: "active", day: 40, daysLeft: 2 })).toMatch(/Last call/);
    expect(suggestedAction({ status: "settling", day: 50, daysLeft: 0 })).toBeNull();
  });

  test("tokens are 32 random bytes and stored as SHA-256", () => {
    const a = newToken();
    expect(Buffer.from(a, "base64url")).toHaveLength(32);
    expect(newToken()).not.toBe(a);
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(a)).not.toContain(a);
  });
});

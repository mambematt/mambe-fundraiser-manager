import { describe, expect, test } from "vitest";
import { adminActionsFrom, canTransition, STATUSES, TRANSITIONS, type TransitionAction } from "../../app/lib/status";
import { launchBlockers, type LaunchFacts } from "../../app/lib/launch-gate";
import { CHECKLIST_ITEMS, type ChecklistState } from "../../app/lib/checklist";
import { normalizePublicCode, seasonCode, suggestPublicCode } from "../../app/lib/public-code";
import { pt } from "../helpers/fixtures";

const start = pt("2026-10-01T00:00:00");
const before = pt("2026-09-20T10:00:00");
const after = pt("2026-10-02T10:00:00");

describe("transitions list", () => {
  test("has all nine statuses", () => {
    expect(STATUSES).toEqual([
      "application", "setup", "scheduled", "active", "settling", "payout_pending", "paid", "declined", "cancelled",
    ]);
  });

  const allowed: Array<[string, TransitionAction, string]> = [
    ["application", "approve", "setup"],
    ["application", "decline", "declined"],
    ["setup", "decline", "declined"],
    ["setup", "approve_launch", "scheduled"],
    ["scheduled", "back_to_setup", "setup"],
    ["setup", "cancel", "cancelled"],
    ["scheduled", "cancel", "cancelled"],
    ["active", "cancel", "cancelled"],
    ["scheduled", "start", "active"],
    ["active", "end", "settling"],
    ["settling", "settle", "payout_pending"],
    ["payout_pending", "record_payment", "paid"],
  ];
  test.each(allowed)("%s --%s--> %s is allowed", (from, action, to) => {
    expect(canTransition(from, action, { now: before, windowStart: start, reason: "because" })).toEqual({ ok: true, to });
  });

  const refused: Array<[string, TransitionAction]> = [
    ["setup", "approve"],
    ["application", "approve_launch"],
    ["active", "approve_launch"],
    ["active", "back_to_setup"],
    ["settling", "cancel"],
    ["payout_pending", "cancel"],
    ["paid", "cancel"],
    ["cancelled", "approve_launch"],
    ["declined", "approve"],
    ["scheduled", "decline"],
    ["setup", "start"],
    ["scheduled", "end"],
    ["paid", "record_payment"],
  ];
  test.each(refused)("%s --%s--> is refused", (from, action) => {
    expect(canTransition(from, action, { now: before, windowStart: start, reason: "because" }).ok).toBe(false);
  });

  test("paid, declined and cancelled are final", () => {
    for (const status of ["paid", "declined", "cancelled"]) {
      expect(TRANSITIONS.some((t) => t.from.includes(status as never))).toBe(false);
    }
  });

  test("decline, back to setup and cancel need a reason", () => {
    for (const [from, action] of [["setup", "decline"], ["scheduled", "back_to_setup"], ["active", "cancel"]] as const) {
      const check = canTransition(from, action, { now: before, windowStart: start, reason: "  " });
      expect(check).toEqual({ ok: false, error: expect.stringMatching(/reason is required/) });
    }
  });

  test("back to setup only before the start date", () => {
    expect(canTransition("scheduled", "back_to_setup", { now: after, windowStart: start, reason: "x" }).ok).toBe(false);
    expect(canTransition("scheduled", "back_to_setup", { now: start, windowStart: start, reason: "x" }).ok).toBe(false);
  });

  test("buttons shown for each status", () => {
    expect(adminActionsFrom("setup").map((t) => t.action)).toEqual(["decline", "approve_launch", "cancel"]);
    expect(adminActionsFrom("active").map((t) => t.action)).toEqual(["cancel"]);
    expect(adminActionsFrom("settling")).toEqual([]);
  });
});

describe("launch gate", () => {
  const done = Object.fromEntries(
    CHECKLIST_ITEMS.map((i) => [i.key, { at: new Date(), by: "Matt" }]),
  ) as ChecklistState;
  const ready: LaunchFacts = {
    checklist: done,
    productStatus: "ACTIVE",
    productDeleted: false,
    hasDates: true,
    payoutRateCents: 2500,
    overlapping: [],
  };

  test("passes when everything is ready", () => {
    expect(launchBlockers(ready)).toEqual([]);
  });

  test("each open checklist item blocks", () => {
    for (const item of CHECKLIST_ITEMS) {
      const blockers = launchBlockers({ ...ready, checklist: { ...done, [item.key]: { at: null, by: null } } });
      expect(blockers).toEqual([expect.stringContaining(item.label)]);
    }
  });

  test("inactive or deleted product, missing rate, and overlaps block", () => {
    expect(launchBlockers({ ...ready, productStatus: "DRAFT" })[0]).toMatch(/draft/);
    expect(launchBlockers({ ...ready, productDeleted: true })[0]).toMatch(/deleted/);
    expect(launchBlockers({ ...ready, payoutRateCents: 0 })[0]).toMatch(/rate/);
    expect(launchBlockers({ ...ready, hasDates: false })[0]).toMatch(/dates/);
    expect(
      launchBlockers({ ...ready, overlapping: [{ publicCode: "CHS-GLAX-F26", startDate: "2026-10-01", endDate: "2026-10-31" }] })[0],
    ).toMatch(/CHS-GLAX-F26/);
  });
});

describe("public code", () => {
  test("suggests codes like CHS-GLAX-F26", () => {
    expect(suggestPublicCode("Central High School", "Girls Lacrosse", "2026-10-01")).toBe("CHS-GLAX-F26");
    expect(suggestPublicCode("St. Mary's Academy", "Boys Basketball", "2027-01-10")).toBe("SMA-BBBALL-W27");
    expect(suggestPublicCode("Lincoln Boosters", "Cross Country", "2027-04-01")).toBe("LB-XC-S27");
  });

  test("season codes", () => {
    expect(seasonCode("2026-12-01")).toBe("W27");
    expect(seasonCode("2026-06-15")).toBe("U26");
    expect(seasonCode("2026-08-20")).toBe("F26");
  });

  test("edited codes are normalized", () => {
    expect(normalizePublicCode(" chs glax/f26 ")).toBe("CHS-GLAX-F26");
  });
});

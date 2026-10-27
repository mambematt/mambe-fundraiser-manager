// The public application form (spec "Organizer journey", step 1): the fields,
// their checks, and how an application is matched to existing records.
// Pure: no database.

export const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;
export const SEASONS = ["Fall", "Winter", "Spring", "Summer"] as const;
export const NOT_SURE = "Not sure yet";

/** Spam checks: a form filled faster than this is a bot. */
export const MIN_FILL_MS = 3000;
/** Accepted applications per hour, per IP and per email. */
export const RATE_LIMIT_PER_IP = 5;
export const RATE_LIMIT_PER_EMAIL = 3;

export const THANK_YOU = "We received your application, and we'll be in touch within 2 business days. Thanks.";

export interface ApplicationInput {
  name: string;
  email: string;
  phone: string;
  organizationName: string;
  teamName: string;
  role: string;
  city: string;
  state: string;
  timingMonth: string;
  timingSeason: string;
  notes: string | null;
}

export type FieldErrors = Partial<Record<keyof ApplicationInput, string>>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clean = (v: unknown, max = 200) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/**
 * Checks every field the browser checks, again on the server. The logo
 * question was removed (Oct 27, owner: every team has one); a form still
 * cached with it may send has_logo, which is ignored.
 */
export function parseApplication(raw: Record<string, unknown>): { ok: true; value: ApplicationInput } | { ok: false; errors: FieldErrors } {
  const value: ApplicationInput = {
    name: clean(raw.name),
    email: clean(raw.email).toLowerCase(),
    phone: clean(raw.phone, 40),
    organizationName: clean(raw.organization),
    teamName: clean(raw.team),
    role: clean(raw.role),
    city: clean(raw.city, 100),
    state: clean(raw.state, 40),
    timingMonth: clean(raw.timing_month, 40),
    timingSeason: clean(raw.timing_season, 40),
    notes: typeof raw.notes === "string" && raw.notes.trim() ? raw.notes.trim().slice(0, 2000) : null,
  };
  const errors: FieldErrors = {};
  if (!value.name) errors.name = "Please enter your name.";
  if (!EMAIL.test(value.email)) errors.email = "Please enter a valid email address.";
  if ((value.phone.match(/\d/g) ?? []).length < 7) errors.phone = "Please enter a phone number.";
  if (!value.organizationName) errors.organizationName = "Please enter your school or organization.";
  if (!value.teamName) errors.teamName = "Please enter your team or sport.";
  if (!value.role) errors.role = "Please enter your role.";
  if (!value.city) errors.city = "Please enter your city.";
  if (!value.state) errors.state = "Please enter your state.";
  if (![...MONTHS, NOT_SURE].includes(value.timingMonth as (typeof MONTHS)[number])) errors.timingMonth = "Please choose a month.";
  if (!SEASONS.includes(value.timingSeason as (typeof SEASONS)[number])) errors.timingSeason = "Please choose your team's season.";
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value };
}

export function roughTiming(a: Pick<ApplicationInput, "timingMonth" | "timingSeason">): string {
  return `${a.timingMonth === NOT_SURE ? "Month not sure yet" : a.timingMonth} · ${a.timingSeason} season`;
}

/**
 * The season label for a new fundraiser from the applicant's timing, e.g.
 * "Fall 2026": the next time that month comes round (this month counts),
 * or this year when the month isn't known.
 */
export function seasonLabelFor(timing: { timingMonth?: unknown; timingSeason?: unknown }, now: Date): string | null {
  const season = SEASONS.find((s) => s === timing.timingSeason);
  if (!season) return null;
  const year = now.getUTCFullYear();
  const month = MONTHS.indexOf(timing.timingMonth as (typeof MONTHS)[number]);
  return `${season} ${month >= 0 && month < now.getUTCMonth() ? year + 1 : year}`;
}

/** Spam signals that are rejected quietly (the sender still sees the thank-you). */
export function spamReason(raw: Record<string, unknown>, now: Date): string | null {
  if (typeof raw.website === "string" && raw.website.trim()) return "honeypot";
  const started = Number(raw.started_at);
  if (!Number.isFinite(started) || started <= 0) return "no_start_time";
  const elapsed = now.getTime() - started;
  if (elapsed < MIN_FILL_MS) return "too_fast";
  if (elapsed > 7 * 24 * 3600 * 1000) return "stale_form";
  return null;
}

// ------------------------------------------------------------- matching

const STOP_WORDS = new Set([
  "the", "of", "and", "at", "for",
  "high", "school", "hs", "middle", "ms", "academy", "senior", "junior", "jr", "sr",
  "boosters", "booster", "club", "association", "athletics", "athletic", "inc", "llc", "organization",
]);

/** The distinctive words of an organization name: "Nazareth Area High School" → nazareth, area. */
export function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((t) => t && !STOP_WORDS.has(t));
}

/** 0..1: how alike two names are (shared distinctive words). */
export function nameSimilarity(a: string, b: string): number {
  const x = new Set(nameTokens(a));
  const y = new Set(nameTokens(b));
  if (x.size === 0 || y.size === 0) return a.trim().toLowerCase() === b.trim().toLowerCase() ? 1 : 0;
  const shared = [...x].filter((t) => y.has(t)).length;
  // Shared words over the shorter name, so "Nazareth" matches "Nazareth Area".
  return shared / Math.min(x.size, y.size);
}

const same = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

export interface OrganizationCandidate {
  id: number;
  name: string;
  city: string | null;
  state: string | null;
}

export interface OrganizationSuggestion extends OrganizationCandidate {
  score: number;
  why: string;
}

/**
 * Organizations that look like the applicant's: a similar name, ranked up
 * when the city and state match too. Never decides; the admin confirms.
 */
export function suggestOrganizations(
  app: { organizationName: string | null; city: string | null; state: string | null },
  organizations: OrganizationCandidate[],
): OrganizationSuggestion[] {
  if (!app.organizationName) return [];
  return organizations
    .map((o) => {
      const name = nameSimilarity(app.organizationName!, o.name);
      const city = same(app.city, o.city);
      const state = same(app.state, o.state);
      const score = name + (city ? 0.3 : 0) + (state ? 0.2 : 0);
      const why = [
        name >= 1 ? "same name" : name > 0 ? "similar name" : null,
        city ? "same city" : null,
        state ? "same state" : null,
      ].filter(Boolean).join(", ");
      return { suggestion: { ...o, score, why }, name };
    })
    .filter((x) => x.name >= 0.5 || (x.name > 0 && same(app.city, x.suggestion.city)))
    .map((x) => x.suggestion)
    .sort((a, b) => b.score - a.score || a.id - b.id)
    .slice(0, 5);
}

/** Teams in the chosen organization whose name looks like the applicant's team. */
export function suggestTeams<T extends { id: number; name: string; sport?: string | null }>(teamName: string | null, teams: T[]): T[] {
  if (!teamName) return [];
  const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean));
  const wanted = words(teamName);
  return teams
    .map((t) => {
      const have = words(`${t.name} ${t.sport ?? ""}`);
      const shared = [...wanted].filter((w) => have.has(w)).length;
      return { t, score: shared / Math.max(1, Math.min(wanted.size, have.size)) };
    })
    .filter((x) => x.score >= 0.5)
    .sort((a, b) => b.score - a.score || a.t.id - b.t.id)
    .map((x) => x.t);
}

/** A starting guess for a new organization's type; the admin can change it. */
export function guessOrganizationType(name: string | null): "school" | "club" | "booster" | "other" {
  const n = (name ?? "").toLowerCase();
  if (/booster/.test(n)) return "booster";
  if (/\b(school|high|hs|academy|middle|elementary|college|university)\b/.test(n)) return "school";
  if (/\b(club|fc|sc|travel|select|league)\b/.test(n)) return "club";
  return "other";
}

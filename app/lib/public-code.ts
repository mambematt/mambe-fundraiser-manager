// Suggests a fundraiser's public code, e.g. "CHS-GLAX-F26":
// organization initials – team abbreviation – season letter + 2-digit year.
// Admins can always edit it.

const SPORT_ABBREVIATIONS: Array<[RegExp, string]> = [
  [/cross\s*country/, "XC"],
  [/water\s*polo/, "WP"],
  [/track/, "TRK"],
  [/lacrosse/, "LAX"],
  [/soccer/, "SOC"],
  [/basketball/, "BBALL"],
  [/volleyball/, "VB"],
  [/football/, "FB"],
  [/baseball/, "BASE"],
  [/softball/, "SB"],
  [/hockey/, "HKY"],
  [/swim|dive|diving/, "SWIM"],
  [/wrestling/, "WRES"],
  [/tennis/, "TEN"],
  [/golf/, "GOLF"],
  [/cheer/, "CHEER"],
  [/dance/, "DANCE"],
  [/rugby/, "RUG"],
  [/rowing|crew/, "ROW"],
];

const IGNORED_WORDS = new Set(["the", "of", "and", "a", "an", "at", "for"]);

function words(text: string): string[] {
  return text
    .replace(/[^A-Za-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !IGNORED_WORDS.has(w.toLowerCase()));
}

export function organizationInitials(name: string): string {
  const initials = words(name).map((w) => w[0]!.toUpperCase()).join("");
  return initials.slice(0, 5) || "ORG";
}

export function teamAbbreviation(name: string): string {
  const lower = name.toLowerCase();
  let prefix = "";
  if (/\bgirls?\b|\bwomen'?s?\b/.test(lower)) prefix = "G";
  else if (/\bboys?\b|\bmen'?s?\b/.test(lower)) prefix = "B";
  const sport = SPORT_ABBREVIATIONS.find(([pattern]) => pattern.test(lower))?.[1];
  if (sport) return prefix + sport;
  const fallback = words(name)
    .filter((w) => !/^(girls?|boys?|women'?s?|men'?s?)$/i.test(w))
    .map((w) => w.toUpperCase())
    .join("")
    .slice(0, 5);
  return prefix + (fallback || "TEAM");
}

/** F = Aug–Nov, W = Dec–Feb, S = Mar–May, U = Jun–Jul (by start month). */
export function seasonCode(startDate: string): string {
  const [year, month] = startDate.split("-").map(Number);
  let letter = "F";
  let seasonYear = year!;
  if (month === 12) {
    letter = "W";
    seasonYear = year! + 1; // Dec 2026 belongs to winter 2027
  } else if (month! <= 2) letter = "W";
  else if (month! <= 5) letter = "S";
  else if (month! <= 7) letter = "U";
  return `${letter}${String(seasonYear % 100).padStart(2, "0")}`;
}

export function suggestPublicCode(organizationName: string, teamName: string, startDate: string): string {
  return `${organizationInitials(organizationName)}-${teamAbbreviation(teamName)}-${seasonCode(startDate)}`;
}

/** Upper-case, letters/digits/hyphens only. */
export function normalizePublicCode(code: string): string {
  return code.trim().toUpperCase().replace(/[^A-Z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

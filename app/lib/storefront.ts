// What the app writes to the store: the /go/<slug> short link and the banner
// metafield the theme app block reads.

export const BANNER_NAMESPACE = "mambe_fundraiser";
export const BANNER_KEY = "banner";

/** "NS-GSB-F26" → "ns-gsb" (the season part is dropped so the link survives seasons). */
export function defaultSlug(publicCode: string): string {
  const parts = publicCode.toLowerCase().split("-").filter(Boolean);
  const withoutSeason = parts.length > 1 && /^[fwsu]\d{2}$/.test(parts[parts.length - 1]!) ? parts.slice(0, -1) : parts;
  return normalizeSlug(withoutSeason.join("-"));
}

export function normalizeSlug(slug: string): string {
  return slug
    .trim()
    .toLowerCase()
    .replace(/^\/?go\//, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function shortLinkPath(slug: string): string {
  return `/go/${slug}`;
}

export function productPath(handle: string): string {
  return `/products/${handle}`;
}

/** The JSON stored in the product metafield. Keys are snake_case for Liquid. */
export interface BannerValue {
  fundraiser_code: string;
  team_name: string;
  /** "25" or "25.50": the default text already has a "$". */
  rate: string;
  start_date: string; // YYYY-MM-DD
  end_date: string; // YYYY-MM-DD
  end_display: string; // "Nov 15"
}

export function bannerValue(args: {
  publicCode: string;
  teamName: string;
  payoutRateCents: number;
  startDate: string;
  endDate: string;
}): BannerValue {
  const [, month, day] = args.endDate.split("-").map(Number);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const cents = args.payoutRateCents % 100;
  return {
    fundraiser_code: args.publicCode,
    team_name: args.teamName,
    rate: cents === 0 ? String(args.payoutRateCents / 100) : (args.payoutRateCents / 100).toFixed(2),
    start_date: args.startDate,
    end_date: args.endDate,
    end_display: `${months[month! - 1]} ${day}`,
  };
}

/** The banner's team name by default: "Nazareth Softball Girls Softball" is awkward, so it's editable. */
export function defaultBannerTeamName(organizationName: string, teamName: string): string {
  return teamName.toLowerCase().includes(organizationName.toLowerCase()) ? teamName : `${organizationName} ${teamName}`;
}

/** What the theme block shows, given its text setting (for previews and tests; the block does the same in Liquid). */
export function renderBannerText(template: string, value: BannerValue): string {
  return template.replace("{end date}", value.end_display).replace("{rate}", value.rate).replace("{team name}", value.team_name);
}

export const DEFAULT_BANNER_TEXT = "Through {end date}, ${rate} from every purchase goes to {team name}.";

/** The block's own check: show only from the start date through the end date (store time). */
export function bannerVisibleOn(todayIso: string, value: BannerValue): boolean {
  return todayIso >= value.start_date && todayIso <= value.end_date;
}

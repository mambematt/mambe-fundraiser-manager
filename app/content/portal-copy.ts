// Organizer portal wording. Edit freely: this file is copy, not logic.
// Each fundraiser shows one "this week" suggestion based on where it is.

export const PORTAL_HELP_EMAIL = process.env.PORTAL_HELP_EMAIL ?? "fundraising@mambeblankets.com";

export const STATUS_MESSAGES: Record<string, string> = {
  application: "Thanks for applying. We'll be in touch soon.",
  setup: "We're designing your item.",
  scheduled: "You're all set. Your fundraiser starts soon.",
  active: "Your fundraiser is live.",
  settling: "Thanks! Your fundraiser has ended. Your final total will be confirmed by {settle date}.",
  payout_pending: "Your final total is being reviewed for payment.",
  paid: "Paid. Thank you for fundraising with Mambe!",
  cancelled: "This fundraiser was cancelled.",
  declined: "This fundraiser isn't going ahead.",
};

export interface SuggestionContext {
  status: string;
  /** 1 on the start date. */
  day: number;
  daysLeft: number;
}

/** One suggested action for this week. */
export function suggestedAction(ctx: SuggestionContext): string | null {
  if (ctx.status === "setup" || ctx.status === "scheduled") {
    return "Get your team ready: share the dates with families so they know it's coming.";
  }
  if (ctx.status !== "active") return null;
  if (ctx.daysLeft <= 2) return "Last call: send the final reminder to your team families today.";
  if (ctx.day <= 7) return "Send the launch email to your team families, with your short link.";
  if (ctx.day <= 14) return "Post the social image in your team group chat.";
  return "Share your total so far and remind families who haven't ordered yet.";
}

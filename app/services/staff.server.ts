import type { Session } from "@shopify/shopify-api";

/** A readable name for the signed-in staff member, for the audit log. */
export function staffName(session: Session): string {
  const user = session.onlineAccessInfo?.associated_user;
  if (!user) return "admin";
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return name || user.email || `staff #${user.id}`;
}

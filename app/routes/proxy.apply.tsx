// The application form's endpoint. The storefront form posts to
// /apps/fundraise/apply; Shopify's App Proxy signs it and forwards it here.
// Save first, then email: the application is stored before Klaviyo is tried.
import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { applicantIp, verifyAppProxy } from "../lib/app-proxy";
import { THANK_YOU } from "../lib/applications";
import { alertError, flushAlerts } from "../services/alerts.server";
import { sendPendingApplicationEmails, submitApplication } from "../services/applications.server";
import { createKlaviyoClient } from "../services/klaviyo.server";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export const action = async ({ request }: ActionFunctionArgs) => {
  const check = verifyAppProxy(new URL(request.url), process.env.SHOPIFY_API_SECRET);
  if (!check.ok) return json({ ok: false, message: "Not allowed." }, 401);

  let raw: Record<string, unknown>;
  try {
    const type = request.headers.get("content-type") ?? "";
    raw = type.includes("application/json")
      ? ((await request.json()) as Record<string, unknown>)
      : Object.fromEntries((await request.formData()).entries());
  } catch {
    return json({ ok: false, message: "Please try again." }, 400);
  }

  const result = await submitApplication(db, raw, { ip: applicantIp(request.headers) });
  if (result.status === "invalid") return json({ ok: false, errors: result.errors, message: "Please check the highlighted fields." }, 422);
  // Spam and rate-limited submissions see the same thank-you, so bots learn nothing.
  if (result.status === "saved" && process.env.KLAVIYO_API_KEY) {
    try {
      await sendPendingApplicationEmails(db, createKlaviyoClient(), { shop: check.shop, applicationId: result.applicationId });
    } catch (error) {
      // Saved already; the clock retries the emails.
      alertError(error, `Application #${result.applicationId}: emails will be retried`);
    }
    await flushAlerts();
  }
  return json({ ok: true, message: THANK_YOU });
};

export const loader = () => json({ ok: false, message: "Use the form." }, 405);

// Shopify App Proxy signature check. Storefront requests to
// /apps/fundraise/* reach the app with Shopify's signature in the query
// string: HMAC-SHA256 (app secret) over the other parameters, sorted by name,
// each "name=value" (repeated values joined by ","), with no separator.
// Anything unsigned, wrongly signed, or older than MAX_AGE is refused.
import { createHmac, timingSafeEqual } from "node:crypto";

export const MAX_AGE_SECONDS = 10 * 60;

export function appProxySignature(params: URLSearchParams, secret: string): string {
  const keys = [...new Set([...params.keys()])].filter((k) => k !== "signature").sort();
  const message = keys.map((k) => `${k}=${params.getAll(k).join(",")}`).join("");
  return createHmac("sha256", secret).update(message).digest("hex");
}

export type ProxyCheck = { ok: true; shop: string } | { ok: false; reason: string };

export function verifyAppProxy(url: URL, secret: string | undefined, now = new Date()): ProxyCheck {
  if (!secret) return { ok: false, reason: "no app secret configured" };
  const given = url.searchParams.get("signature");
  if (!given) return { ok: false, reason: "unsigned" };
  const expected = appProxySignature(url.searchParams, secret);
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad signature" };
  const timestamp = Number(url.searchParams.get("timestamp"));
  if (!Number.isFinite(timestamp) || Math.abs(now.getTime() / 1000 - timestamp) > MAX_AGE_SECONDS) {
    return { ok: false, reason: "expired" };
  }
  const shop = url.searchParams.get("shop") ?? "";
  if (!/^[a-z0-9-]+\.myshopify\.com$/.test(shop)) return { ok: false, reason: "no shop" };
  return { ok: true, shop };
}

/**
 * The applicant's IP for rate limiting. Shopify passes the visitor's address
 * in X-Forwarded-For and Render appends Shopify's own, so the visitor is the
 * first of two or more entries. A single entry is Shopify itself: no IP limit
 * then (the per-email limit still applies), rather than lumping every
 * applicant together.
 */
export function applicantIp(headers: Headers): string | null {
  const parts = (headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length >= 2 ? parts[0]! : null;
}

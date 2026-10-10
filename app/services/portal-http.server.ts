// Cookies, CSRF and client IP for the organizer portal's public routes.
import { newToken, safeEqual } from "../lib/portal-tokens.server";
import { SESSION_DAYS } from "./portal.server";

export const SESSION_COOKIE = "mf_portal";
export const CSRF_COOKIE = "mf_csrf";

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(/;\s*/)) {
    const [k, ...v] = part.split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

/** Host-only (no Domain), so the cookie belongs to the portal's host alone. */
function cookie(name: string, value: string, maxAgeSeconds: number, sameSite: "Lax" | "Strict"): string {
  return `${name}=${encodeURIComponent(value)}; Path=/portal; HttpOnly; Secure; SameSite=${sameSite}; Max-Age=${maxAgeSeconds}`;
}

export function sessionCookie(raw: string): string {
  return cookie(SESSION_COOKIE, raw, SESSION_DAYS * 24 * 3600, "Lax");
}

export function clearSessionCookie(): string {
  return cookie(SESSION_COOKIE, "", 0, "Lax");
}

/** Double-submit CSRF token: the same value in a cookie and a hidden field. */
export function issueCsrf(): { token: string; setCookie: string } {
  const token = newToken();
  return { token, setCookie: cookie(CSRF_COOKIE, token, 3600, "Strict") };
}

export function csrfOk(request: Request, form: FormData): boolean {
  const fromCookie = readCookie(request, CSRF_COOKIE);
  const fromForm = form.get("csrf");
  return !!fromCookie && typeof fromForm === "string" && safeEqual(fromCookie, fromForm);
}

/** The visitor's IP, used only (hashed) for rate limiting; never stored in the access log. */
export function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

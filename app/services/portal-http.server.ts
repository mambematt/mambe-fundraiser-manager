// Cookies, CSRF and client IP for the organizer portal's public routes.
import { newToken, safeEqual } from "../lib/portal-tokens.server";
import type { PrismaClient } from "@prisma/client";
import { SESSION_DAYS, sessionOrganizerId } from "./portal.server";

export const SESSION_COOKIE = "mf_portal";
export const CSRF_COOKIE = "mf_csrf";

/** Every value sent for a cookie name (a browser can hold two with different paths). */
export function readCookies(request: Request, name: string): string[] {
  const header = request.headers.get("Cookie") ?? "";
  const values: string[] = [];
  for (const part of header.split(/;\s*/)) {
    const [k, ...v] = part.split("=");
    if (k === name && v.length) values.push(decodeURIComponent(v.join("=")));
  }
  return values;
}

export function readCookie(request: Request, name: string): string | null {
  return readCookies(request, name)[0] ?? null;
}

/** The signed-in organizer, trying each session cookie the browser sent. */
export async function currentOrganizerId(db: PrismaClient, request: Request): Promise<number | null> {
  for (const raw of readCookies(request, SESSION_COOKIE)) {
    const id = await sessionOrganizerId(db, raw);
    if (id) return id;
  }
  return null;
}

/**
 * Host-only (no Domain), so the cookie belongs to the portal's host alone.
 * Path=/ rather than /portal: React Router fetches the portal home's data
 * from "/portal.data", which a "/portal" cookie path doesn't cover (found on
 * staging: signing in landed back on "Please sign in").
 */
function cookie(name: string, value: string, maxAgeSeconds: number, sameSite: "Lax" | "Strict"): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=${sameSite}; Max-Age=${maxAgeSeconds}`;
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
  // Lax, not Strict: organizers arrive from an email link (another site), and
  // some phone browsers then withhold Strict cookies from the page's own
  // Continue button. Lax still keeps the cookie off other sites' form posts.
  return { token, setCookie: cookie(CSRF_COOKIE, token, 3600, "Lax") };
}

export function csrfOk(request: Request, form: FormData): boolean {
  const fromForm = form.get("csrf");
  if (typeof fromForm !== "string" || !fromForm) return false;
  return readCookies(request, CSRF_COOKIE).some((value) => safeEqual(value, fromForm));
}

/** The visitor's IP, used only (hashed) for rate limiting; never stored in the access log. */
export function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

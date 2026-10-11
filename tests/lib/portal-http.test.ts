import { describe, expect, test } from "vitest";
import { csrfOk, issueCsrf, readCookie, readCookies, sessionCookie } from "../../app/services/portal-http.server";

describe("portal cookies", () => {
  test("CSRF cookie is Lax (works when arriving from an email link), HttpOnly, Secure, portal-only", () => {
    const { setCookie } = issueCsrf();
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/Secure/);
    expect(setCookie).toMatch(/Path=\/;/); // covers /portal.data (React Router's data request for /portal)
    expect(setCookie).not.toMatch(/Domain=/);
  });

  test("session cookie lasts 45 days and is host-only", () => {
    const c = sessionCookie("abc");
    expect(c).toMatch(/Max-Age=3888000/);
    expect(c).not.toMatch(/Domain=/);
  });

  test("two cookies with the same name (old /portal path and new /): either can match", () => {
    const { token } = issueCsrf();
    const request = new Request("https://x.example/portal/auth/x", { headers: { Cookie: `mf_csrf=old-value; mf_csrf=${token}` } });
    expect(readCookies(request, "mf_csrf")).toEqual(["old-value", token]);
    const form = new FormData();
    form.set("csrf", token);
    expect(csrfOk(request, form)).toBe(true);
  });

  test("double-submit check", () => {
    const { token } = issueCsrf();
    const request = new Request("https://x.example/portal/login", { headers: { Cookie: `other=1; mf_csrf=${token}` } });
    expect(readCookie(request, "mf_csrf")).toBe(token);
    const good = new FormData();
    good.set("csrf", token);
    const bad = new FormData();
    bad.set("csrf", "nope");
    expect(csrfOk(request, good)).toBe(true);
    expect(csrfOk(request, bad)).toBe(false);
    expect(csrfOk(new Request("https://x.example/"), good)).toBe(false);
  });
});

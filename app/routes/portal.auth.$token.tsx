// A login link lands here. Email scanners open links automatically, so the
// link itself does nothing: the organizer presses "Continue", which uses it.
import type { ActionFunctionArgs, MetaFunction } from "react-router";
import { Form, redirect, useActionData, useLoaderData } from "react-router";
import { DateTime } from "luxon";
import db from "../db.server";
import { PortalLayout } from "../components/PortalLayout";
import { DEFAULT_TIMEZONE } from "../lib/window";
import { createSession, redeemLoginToken } from "../services/portal.server";
import { csrfOk, issueCsrf, sessionCookie } from "../services/portal-http.server";

export const meta: MetaFunction = () => [{ title: "Sign in · Mambe Fundraisers" }, { name: "robots", content: "noindex" }];

export const loader = async () => {
  const { token, setCookie } = issueCsrf();
  return Response.json({ csrf: token }, { headers: { "Set-Cookie": setCookie, "Referrer-Policy": "no-referrer" } });
};

const time = (d: Date) => DateTime.fromJSDate(d).setZone(DEFAULT_TIMEZONE).toFormat("LLL d 'at' h:mm a ZZZZ");

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const form = await request.formData();
  if (!csrfOk(request, form)) {
    // The link hasn't been used. The page reloads its check value; press again.
    console.warn("[portal] sign-in Continue failed the CSRF check; link left unused");
    return { retry: true };
  }
  const result = await redeemLoginToken(db, params.token ?? "");
  if (!result.ok) {
    const why =
      result.reason === "used"
        ? `This link was already used, ${time(result.at)}.`
        : result.reason === "expired"
          ? `This link expired ${time(result.at)}.`
          : `This link wasn't recognized (ref ${(params.token ?? "").slice(0, 4)}…${(params.token ?? "").slice(-4)}, ${(params.token ?? "").length} characters, via ${request.headers.get("x-remix-response") ? "app" : new URL(request.url).pathname.endsWith(".data") ? "data request" : "page form"}).`;
    return redirect(`/portal/login?reason=expired&why=${encodeURIComponent(why)}`);
  }
  const raw = await createSession(db, result.organizerId);
  return redirect("/portal", { headers: { "Set-Cookie": sessionCookie(raw) } });
};

export default function PortalAuth() {
  // Always the newest check value: the page reloads it after each try.
  const { csrf } = useLoaderData<{ csrf: string }>();
  const retry = useActionData<{ retry: boolean }>();
  return (
    <PortalLayout>
      <div className="card">
        <h1>Welcome</h1>
        {retry ? (
          <p className="note">Almost there: please press Continue once more.</p>
        ) : (
          <p className="muted">Press continue to open your fundraiser.</p>
        )}
        <Form method="post">
          <input type="hidden" name="csrf" value={csrf} />
          <button type="submit">Continue to your portal</button>
        </Form>
      </div>
    </PortalLayout>
  );
}

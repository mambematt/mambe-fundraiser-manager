// A login link lands here. Email scanners open links automatically, so the
// link itself does nothing: the organizer presses "Continue", which uses it.
import type { ActionFunctionArgs, MetaFunction } from "react-router";
import { Form, redirect, useActionData, useLoaderData } from "react-router";
import db from "../db.server";
import { PortalLayout } from "../components/PortalLayout";
import { consumeLoginToken, createSession } from "../services/portal.server";
import { csrfOk, issueCsrf, sessionCookie } from "../services/portal-http.server";

export const meta: MetaFunction = () => [{ title: "Sign in · Mambe Fundraisers" }, { name: "robots", content: "noindex" }];

export const loader = async () => {
  const { token, setCookie } = issueCsrf();
  return Response.json({ csrf: token }, { headers: { "Set-Cookie": setCookie, "Referrer-Policy": "no-referrer" } });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const form = await request.formData();
  if (!csrfOk(request, form)) {
    // The link hasn't been used: show the page again with a fresh check.
    const { token, setCookie } = issueCsrf();
    console.warn("[portal] sign-in Continue failed the CSRF check; link left unused");
    return Response.json({ retry: true, csrf: token }, { headers: { "Set-Cookie": setCookie } });
  }
  const organizerId = await consumeLoginToken(db, params.token ?? "");
  if (!organizerId) return redirect("/portal/login?reason=expired");
  const raw = await createSession(db, organizerId);
  return redirect("/portal", { headers: { "Set-Cookie": sessionCookie(raw) } });
};

export default function PortalAuth() {
  const loaded = useLoaderData<{ csrf: string }>();
  const retry = useActionData<{ retry: boolean; csrf: string }>();
  const csrf = retry?.csrf ?? loaded.csrf;
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

// "Email me a link": the portal's sign-in page. Always gives the same answer.
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import db from "../db.server";
import { PortalLayout } from "../components/PortalLayout";
import { createKlaviyoClient } from "../services/klaviyo.server";
import { requestLoginLink } from "../services/portal.server";
import { clientIp, csrfOk, issueCsrf } from "../services/portal-http.server";

export const meta: MetaFunction = () => [{ title: "Sign in · Mambe Fundraisers" }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { token, setCookie } = issueCsrf();
  const params = new URL(request.url).searchParams;
  const reason = params.get("reason");
  const why = params.get("why")?.slice(0, 200) ?? null;
  return Response.json({ csrf: token, reason, why }, { headers: { "Set-Cookie": setCookie } });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const form = await request.formData();
  if (!csrfOk(request, form)) return { message: "That page expired. Please try again." };
  const email = String(form.get("email") ?? "");
  const message = await requestLoginLink(db, createKlaviyoClient(), email, clientIp(request));
  return { message };
};

const REASONS: Record<string, string> = {
  expired: "That link has expired or was already used. Links work once, for 30 minutes. Request a new one below.",
  signin: "Please sign in to see your fundraiser.",
};

export default function PortalLogin() {
  const { csrf, reason, why } = useLoaderData<{ csrf: string; reason: string | null; why: string | null }>();
  const result = useActionData<typeof action>();
  return (
    <PortalLayout>
      <div className="card">
        <h1>Sign in</h1>
        {reason && REASONS[reason] && !result && (
          <p className="note">
            {why ? `${why} ` : ""}
            {REASONS[reason]}
          </p>
        )}
        {result ? (
          <p>{result.message}</p>
        ) : (
          <Form method="post">
            <input type="hidden" name="csrf" value={csrf} />
            <p className="muted">Enter the email address we have for you, and we&apos;ll email you a sign-in link.</p>
            <input type="email" name="email" required autoComplete="email" placeholder="you@example.com" />
            <p>
              <button type="submit">Email me a link</button>
            </p>
          </Form>
        )}
      </div>
    </PortalLayout>
  );
}

import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { ResultBanner } from "../components/ResultBanner";
import { attempt } from "../services/actions.server";
import { ORGANIZATION_TYPES } from "../lib/organizations";
import { organizationInput, saveOrganization } from "../services/records.server";
import { staffName } from "../services/staff.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const organizations = await db.organization.findMany({
    orderBy: { name: "asc" },
    include: { teams: { orderBy: { name: "asc" } } },
  });
  return {
    organizations: organizations.map((o) => ({
      id: o.id,
      name: o.name,
      type: o.type,
      place: [o.city, o.state].filter(Boolean).join(", "),
      teams: o.teams.map((t) => t.name).join(", "),
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, redirect } = await authenticate.admin(request);
  const form = await request.formData();
  let createdId: number | null = null;
  const result = await attempt(async () => {
    const created = await saveOrganization(db, null, organizationInput(form), staffName(session));
    createdId = created.id;
    return { ok: true, message: "Organization created." };
  });
  if (createdId) return redirect(`/app/organizations/${createdId}`);
  return result;
};

export default function Organizations() {
  const { organizations } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";

  return (
    <s-page heading="Organizations & teams">
      <ResultBanner result={result} />
      <s-section heading="Organizations">
        {organizations.length === 0 ? (
          <s-paragraph>None yet. Add the first one below.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Name</s-table-header>
              <s-table-header>Type</s-table-header>
              <s-table-header>City</s-table-header>
              <s-table-header>Teams</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {organizations.map((o) => (
                <s-table-row key={o.id}>
                  <s-table-cell>
                    <s-link href={`/app/organizations/${o.id}`}>{o.name}</s-link>
                  </s-table-cell>
                  <s-table-cell>{o.type}</s-table-cell>
                  <s-table-cell>{o.place || "—"}</s-table-cell>
                  <s-table-cell>{o.teams || "—"}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading="Add an organization">
        <Form method="post">
          <s-stack gap="base">
            <s-text-field name="name" label="Name" placeholder="Central High School" required />
            <s-select name="type" label="Type" value="school">
              {ORGANIZATION_TYPES.map((t) => (
                <s-option key={t} value={t}>
                  {t}
                </s-option>
              ))}
            </s-select>
            <s-stack direction="inline" gap="base">
              <s-text-field name="city" label="City" />
              <s-text-field name="state" label="State" placeholder="CA" />
            </s-stack>
            <s-url-field name="website" label="Website" />
            <s-text-area name="notes" label="Notes" />
            <s-button type="submit" variant="primary" disabled={busy}>
              Add organization
            </s-button>
          </s-stack>
        </Form>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { ResultBanner } from "../components/ResultBanner";
import { attempt } from "../services/actions.server";
import { organizerInput, saveOrganizer } from "../services/records.server";
import { staffName } from "../services/staff.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const organizers = await db.organizer.findMany({
    orderBy: { name: "asc" },
    include: { fundraisers: { include: { fundraiser: { select: { publicCode: true } } } } },
  });
  return {
    organizers: organizers.map((o) => ({
      id: o.id,
      name: o.name,
      email: o.email,
      phone: o.phone ?? "",
      role: o.role ?? "",
      fundraisers: o.fundraisers.map((f) => f.fundraiser.publicCode).join(", "),
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  return attempt(async () => {
    const created = await saveOrganizer(db, null, organizerInput(form), staffName(session));
    return { ok: true, message: `Added ${created.name}.` };
  });
};

export default function Organizers() {
  const { organizers } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";

  return (
    <s-page heading="Organizers">
      <ResultBanner result={result} />
      <s-section heading="Organizers">
        {organizers.length === 0 ? (
          <s-paragraph>None yet. Add the first one below.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Name</s-table-header>
              <s-table-header>Email</s-table-header>
              <s-table-header>Phone</s-table-header>
              <s-table-header>Role</s-table-header>
              <s-table-header>Fundraisers</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {organizers.map((o) => (
                <s-table-row key={o.id}>
                  <s-table-cell>
                    <s-link href={`/app/organizers/${o.id}`}>{o.name}</s-link>
                  </s-table-cell>
                  <s-table-cell>{o.email}</s-table-cell>
                  <s-table-cell>{o.phone || "—"}</s-table-cell>
                  <s-table-cell>{o.role || "—"}</s-table-cell>
                  <s-table-cell>{o.fundraisers || "—"}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading="Add an organizer">
        <Form method="post">
          <s-stack gap="base">
            <s-text-field name="name" label="Name" required />
            <s-email-field name="email" label="Email" required />
            <s-text-field name="phone" label="Phone" />
            <s-text-field name="role" label="Role" placeholder="Booster club president" />
            <s-text-area name="notes" label="Notes" />
            <s-button type="submit" variant="primary" disabled={busy}>Add organizer</s-button>
          </s-stack>
        </Form>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

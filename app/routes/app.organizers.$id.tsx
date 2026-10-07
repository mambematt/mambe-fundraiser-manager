import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { ResultBanner } from "../components/ResultBanner";
import { STATUS_LABELS, type FundraiserStatus } from "../lib/status";
import { attempt } from "../services/actions.server";
import { organizerInput, saveOrganizer } from "../services/records.server";
import { staffName } from "../services/staff.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const o = await db.organizer.findUnique({
    where: { id: Number(params.id) },
    include: { fundraisers: { include: { fundraiser: true } } },
  });
  if (!o) throw new Response("Not found", { status: 404 });
  return {
    organizer: { id: o.id, name: o.name, email: o.email, phone: o.phone ?? "", role: o.role ?? "", notes: o.notes ?? "" },
    fundraisers: o.fundraisers.map((link) => ({
      id: link.fundraiser.id,
      publicCode: link.fundraiser.publicCode,
      status: STATUS_LABELS[link.fundraiser.status as FundraiserStatus] ?? link.fundraiser.status,
      primary: link.isPrimary,
    })),
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  return attempt(async () => {
    await saveOrganizer(db, Number(params.id), organizerInput(form), staffName(session));
    return { ok: true, message: "Organizer saved." };
  });
};

export default function Organizer() {
  const { organizer, fundraisers } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";

  return (
    <s-page heading={organizer.name}>
      <s-link slot="breadcrumb-actions" href="/app/organizers">Organizers</s-link>
      <ResultBanner result={result} />
      <s-section heading="Details">
        <Form method="post">
          <s-stack gap="base">
            <s-text-field name="name" label="Name" defaultValue={organizer.name} required />
            <s-email-field
              name="email"
              label="Email"
              defaultValue={organizer.email}
              details="Changing the email signs this organizer out of the portal everywhere."
              required
            />
            <s-text-field name="phone" label="Phone" defaultValue={organizer.phone} />
            <s-text-field name="role" label="Role" defaultValue={organizer.role} />
            <s-text-area name="notes" label="Notes" defaultValue={organizer.notes} />
            <s-button type="submit" variant="primary" disabled={busy}>Save</s-button>
          </s-stack>
        </Form>
      </s-section>
      <s-section heading="Fundraisers">
        {fundraisers.length === 0 ? (
          <s-paragraph>Not on any fundraiser yet.</s-paragraph>
        ) : (
          <s-unordered-list>
            {fundraisers.map((f) => (
              <s-list-item key={f.id}>
                <s-link href={`/app/fundraisers/${f.id}`}>{f.publicCode}</s-link> · {f.status}
                {f.primary ? " · primary" : ""}
              </s-list-item>
            ))}
          </s-unordered-list>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

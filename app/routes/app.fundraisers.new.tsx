import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { ResultBanner } from "../components/ResultBanner";
import { TIMEZONES } from "../lib/format";
import { attempt, formDollarsToCents, formInt, formText } from "../services/actions.server";
import { createFundraiser, UserError } from "../services/fundraisers.server";
import { staffName } from "../services/staff.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const [teams, products, organizers] = await Promise.all([
    db.team.findMany({ include: { organization: true }, orderBy: [{ organization: { name: "asc" } }, { name: "asc" }] }),
    db.product.findMany({ where: { deletedAt: null, status: { notIn: ["ARCHIVED", "DELETED"] } }, include: { team: true }, orderBy: { title: "asc" } }),
    db.organizer.findMany({ orderBy: { name: "asc" } }),
  ]);
  return {
    teams: teams.map((t) => ({ id: t.id, label: `${t.organization.name} – ${t.name}` })),
    products: products.map((p) => ({ id: p.id, label: p.team ? `${p.title} (${p.team.name})` : p.title })),
    organizers: organizers.map((o) => ({ id: o.id, label: `${o.name} (${o.email})` })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, redirect } = await authenticate.admin(request);
  const form = await request.formData();
  let createdId: number | null = null;
  const result = await attempt(async () => {
    const teamId = formInt(form, "teamId");
    const productId = formInt(form, "productId");
    if (!teamId) throw new UserError("Choose a team.");
    if (!productId) throw new UserError("Choose a product.");
    const rate = formDollarsToCents(form, "payoutRate");
    if (rate === null) throw new UserError("Enter the payout rate in dollars, e.g. 25.");
    const f = await createFundraiser(
      db,
      {
        teamId,
        productId,
        seasonLabel: formText(form, "seasonLabel"),
        startDate: formText(form, "startDate"),
        endDate: formText(form, "endDate"),
        timezone: formText(form, "timezone"),
        payoutRateCents: rate,
        paypalPayeeEmail: formText(form, "paypalPayeeEmail"),
        organizerIds: form.getAll("organizerIds").map(Number).filter(Boolean),
        primaryOrganizerId: formInt(form, "primaryOrganizerId"),
        publicCode: formText(form, "publicCode"),
        notes: formText(form, "notes"),
      },
      staffName(session),
    );
    createdId = f.id;
    return { ok: true, message: "Created." };
  });
  if (createdId) return redirect(`/app/fundraisers/${createdId}`);
  return result;
};

export default function NewFundraiser() {
  const { teams, products, organizers } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  const missing = [
    teams.length === 0 && "a team (Organizations & teams)",
    products.length === 0 && "a linked product (Products)",
    organizers.length === 0 && "an organizer (Organizers)",
  ].filter(Boolean);

  return (
    <s-page heading="New fundraiser">
      <s-link slot="breadcrumb-actions" href="/app/fundraisers">Fundraisers</s-link>
      <ResultBanner result={result} />
      {missing.length > 0 && (
        <s-banner tone="warning">
          <s-paragraph>First add {missing.join(", ")}.</s-paragraph>
        </s-banner>
      )}
      <Form method="post">
        <s-section heading="Team and product">
          <s-stack gap="base">
            <s-select name="teamId" label="Team" required>
              <s-option value="">Choose…</s-option>
              {teams.map((t) => (
                <s-option key={t.id} value={String(t.id)}>{t.label}</s-option>
              ))}
            </s-select>
            <s-select name="productId" label="Linked product" required>
              <s-option value="">Choose…</s-option>
              {products.map((p) => (
                <s-option key={p.id} value={String(p.id)}>{p.label}</s-option>
              ))}
            </s-select>
            <s-text-field name="seasonLabel" label="Season" placeholder="Fall 2026" />
          </s-stack>
        </s-section>

        <s-section heading="Dates and payout">
          <s-stack gap="base">
            <s-stack direction="inline" gap="base">
              <s-date-field name="startDate" label="Start date" required />
              <s-date-field name="endDate" label="End date" required />
            </s-stack>
            <s-select name="timezone" label="Timezone" value="America/Los_Angeles">
              {TIMEZONES.map(([zone, label]) => (
                <s-option key={zone} value={zone}>{label}</s-option>
              ))}
            </s-select>
            <s-paragraph>
              <s-text color="subdued">
                The fundraiser runs from 12:00 AM on the start date until midnight at the end of the end date, in this timezone.
              </s-text>
            </s-paragraph>
            <s-text-field name="payoutRate" label="Payout per cape ($)" defaultValue="25.00" required />
            <s-email-field name="paypalPayeeEmail" label="PayPal payee email (the organization's account)" />
          </s-stack>
        </s-section>

        <s-section heading="Organizers">
          <s-stack gap="base">
            {organizers.map((o) => (
              <s-checkbox key={o.id} name="organizerIds" value={String(o.id)} label={o.label} />
            ))}
            <s-select name="primaryOrganizerId" label="Primary organizer">
              <s-option value="">Only one chosen? It&apos;s primary.</s-option>
              {organizers.map((o) => (
                <s-option key={o.id} value={String(o.id)}>{o.label}</s-option>
              ))}
            </s-select>
          </s-stack>
        </s-section>

        <s-section heading="Code and notes">
          <s-stack gap="base">
            <s-text-field
              name="publicCode"
              label="Public code"
              placeholder="Leave blank to generate, e.g. CHS-GLAX-F26"
            />
            <s-text-area name="notes" label="Notes" />
            <s-button type="submit" variant="primary" disabled={busy || missing.length > 0}>
              Create fundraiser
            </s-button>
          </s-stack>
        </s-section>
      </Form>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

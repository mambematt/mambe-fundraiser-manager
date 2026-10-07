import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { ResultBanner } from "../components/ResultBanner";
import { attempt, formText } from "../services/actions.server";
import { ORGANIZATION_TYPES } from "../lib/organizations";
import { organizationInput, saveOrganization, saveTeam, teamInput } from "../services/records.server";
import { staffName } from "../services/staff.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const org = await db.organization.findUnique({
    where: { id: Number(params.id) },
    include: { teams: { orderBy: { name: "asc" }, include: { fundraisers: { select: { publicCode: true } } } } },
  });
  if (!org) throw new Response("Not found", { status: 404 });
  return {
    org: {
      id: org.id,
      name: org.name,
      type: org.type,
      city: org.city ?? "",
      state: org.state ?? "",
      website: org.website ?? "",
      notes: org.notes ?? "",
    },
    teams: org.teams.map((t) => ({
      id: t.id,
      name: t.name,
      sport: t.sport ?? "",
      level: t.level ?? "",
      fundraisers: t.fundraisers.map((f) => f.publicCode).join(", "),
    })),
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const actor = staffName(session);
  const orgId = Number(params.id);
  const form = await request.formData();
  const intent = formText(form, "intent");
  return attempt(async () => {
    if (intent === "org") {
      await saveOrganization(db, orgId, organizationInput(form), actor);
      return { ok: true, message: "Organization saved." };
    }
    if (intent === "team") {
      const id = formText(form, "teamId");
      await saveTeam(db, orgId, id ? Number(id) : null, teamInput(form), actor);
      return { ok: true, message: id ? "Team saved." : "Team added." };
    }
    return { ok: false, message: "Unknown action." };
  });
};

export default function Organization() {
  const { org, teams } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";

  return (
    <s-page heading={org.name}>
      <s-link slot="breadcrumb-actions" href="/app/organizations">
        Organizations
      </s-link>
      <ResultBanner result={result} />

      <s-section heading="Teams">
        <s-stack gap="base">
          {teams.length === 0 && <s-paragraph>No teams yet.</s-paragraph>}
          {teams.map((t) => (
            <Form method="post" key={t.id}>
              <input type="hidden" name="intent" value="team" />
              <input type="hidden" name="teamId" value={t.id} />
              <s-stack direction="inline" gap="base" alignItems="end">
                <s-text-field name="name" label="Team" defaultValue={t.name} required />
                <s-text-field name="sport" label="Sport" defaultValue={t.sport} />
                <s-text-field name="level" label="Level" defaultValue={t.level} placeholder="Varsity" />
                <s-button type="submit" disabled={busy}>
                  Save
                </s-button>
                <s-text color="subdued">
                  {t.fundraisers ? `Fundraisers: ${t.fundraisers}` : "No fundraisers yet"}
                </s-text>
              </s-stack>
            </Form>
          ))}
          <Form method="post">
            <input type="hidden" name="intent" value="team" />
            <s-stack direction="inline" gap="base" alignItems="end">
              <s-text-field name="name" label="New team" placeholder="Girls Lacrosse" required />
              <s-text-field name="sport" label="Sport" placeholder="Lacrosse" />
              <s-text-field name="level" label="Level" placeholder="Varsity" />
              <s-button type="submit" variant="primary" disabled={busy}>
                Add team
              </s-button>
            </s-stack>
          </Form>
        </s-stack>
      </s-section>

      <s-section heading="Details">
        <Form method="post">
          <input type="hidden" name="intent" value="org" />
          <s-stack gap="base">
            <s-text-field name="name" label="Name" defaultValue={org.name} required />
            <s-select name="type" label="Type" value={org.type}>
              {ORGANIZATION_TYPES.map((t) => (
                <s-option key={t} value={t}>
                  {t}
                </s-option>
              ))}
            </s-select>
            <s-stack direction="inline" gap="base">
              <s-text-field name="city" label="City" defaultValue={org.city} />
              <s-text-field name="state" label="State" defaultValue={org.state} />
            </s-stack>
            <s-url-field name="website" label="Website" defaultValue={org.website} />
            <s-text-area name="notes" label="Notes" defaultValue={org.notes} />
            <s-button type="submit" disabled={busy}>
              Save organization
            </s-button>
          </s-stack>
        </Form>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

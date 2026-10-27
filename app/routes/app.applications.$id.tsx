// One application: what they sent, the emails, and the three decisions
// (accept and create fundraiser, decline with a reason, mark as spam).
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { ResultBanner } from "../components/ResultBanner";
import { guessOrganizationType } from "../lib/applications";
import { describeAudit } from "../lib/audit-describe";
import { pacific } from "../lib/format";
import { ORGANIZATION_TYPES } from "../lib/organizations";
import { attempt, formText, type ActionResult } from "../services/actions.server";
import {
  acceptApplication,
  applicationEmailsEnabled,
  declineApplication,
  markSpam,
  matchSuggestions,
  retryApplicationEmail,
} from "../services/applications.server";
import { createDriveClient } from "../services/drive.server";
import { staffName } from "../services/staff.server";
import { UserError } from "../lib/errors";

const EMAIL_LABELS: Record<string, string> = { received: "Application Received (to the applicant)", internal: "New Application (internal)" };
const EMAIL_STATUS: Record<string, string> = {
  pending: "Queued",
  sent: "Sent",
  failed: "Failed",
  off: "Not sent (switch off)",
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const id = Number(params.id);
  const app = await db.application.findUnique({
    where: { id },
    include: { emails: { orderBy: { kind: "desc" } }, convertedFundraiser: { select: { id: true, publicCode: true } } },
  });
  if (!app) throw new Response("Not found", { status: 404 });
  const [suggestions, allOrganizations, history] = await Promise.all([
    app.status === "new" ? matchSuggestions(db, id) : Promise.resolve(null),
    app.status === "new"
      ? db.organization.findMany({ orderBy: { name: "asc" }, include: { teams: { orderBy: { name: "asc" } } } })
      : Promise.resolve([]),
    db.auditLog.findMany({ where: { entity: "application", entityId: String(id) }, orderBy: { id: "desc" } }),
  ]);

  // One choice covers organization + team. Suggestions first, then everything else.
  const suggestedIds = new Set(suggestions?.organizations.map((o) => o.id) ?? []);
  const options: Array<{ value: string; label: string }> = [];
  for (const o of suggestions?.organizations ?? []) {
    const place = [o.city, o.state].filter(Boolean).join(", ");
    for (const t of [...o.teams].sort((a, b) => Number(b.suggested) - Number(a.suggested))) {
      options.push({ value: `${o.id}:${t.id}`, label: `Suggested (${o.why}): ${o.name}${place ? `, ${place}` : ""} → existing team ${t.name}${t.suggested ? " (similar)" : ""}` });
    }
    options.push({ value: `${o.id}:new`, label: `Suggested (${o.why}): ${o.name}${place ? `, ${place}` : ""} → new team "${app.teamName}"` });
  }
  options.push({ value: "new:new", label: `Create new organization "${app.organizationName}" and team "${app.teamName}"` });
  for (const o of allOrganizations.filter((x) => !suggestedIds.has(x.id))) {
    for (const t of o.teams) options.push({ value: `${o.id}:${t.id}`, label: `Other: ${o.name} → existing team ${t.name}` });
    options.push({ value: `${o.id}:new`, label: `Other: ${o.name} → new team "${app.teamName}"` });
  }
  const best = suggestions?.organizations[0];
  const bestTeam = best?.teams.find((t) => t.suggested);
  const defaultChoice = best ? `${best.id}:${bestTeam ? bestTeam.id : "new"}` : "new:new";

  return {
    a: {
      id: app.id,
      status: app.status,
      at: app.createdAt.toISOString(),
      name: app.name,
      email: app.email,
      phone: app.phone,
      organization: app.organizationName,
      team: app.teamName,
      role: app.role,
      place: [app.city, app.state].filter(Boolean).join(", "),
      timing: app.roughTiming,
      hasLogo: app.hasLogo,
      notes: app.notes,
      declineReason: app.declineReason,
      reviewedBy: app.reviewedBy,
      reviewedAt: app.reviewedAt?.toISOString() ?? null,
      fundraiser: app.convertedFundraiser,
    },
    emailsOn: applicationEmailsEnabled(),
    emails: app.emails.map((e) => ({ id: e.id, kind: e.kind, status: e.status, attempts: e.attempts, error: e.error, sentAt: e.sentAt?.toISOString() ?? null })),
    options,
    defaultChoice,
    organizer: suggestions?.organizer ?? null,
    typeGuess: guessOrganizationType(app.organizationName),
    driveReady: (() => {
      try {
        return !!createDriveClient();
      } catch {
        return false;
      }
    })(),
    history: history.map((h) => ({ id: String(h.id), at: h.createdAt.toISOString(), text: describeAudit(h) })),
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session, redirect } = await authenticate.admin(request);
  const actor = staffName(session);
  const id = Number(params.id);
  const form = await request.formData();
  const intent = formText(form, "intent");
  let goTo: string | null = null;
  const result = await attempt(async (): Promise<ActionResult> => {
    switch (intent) {
      case "spam":
        await markSpam(db, id, actor);
        return { ok: true, message: "Marked as spam; it's hidden from the list." };
      case "decline":
        await declineApplication(db, id, formText(form, "reason"), actor);
        return { ok: true, message: "Declined. No email was sent; reply from Outlook if you want to." };
      case "retryEmail":
        await retryApplicationEmail(db, Number(formText(form, "emailId")), actor);
        return { ok: true, message: "Queued again; the clock sends it within 15 minutes." };
      case "accept": {
        const [org, team] = formText(form, "choice").split(":");
        if (!org || !team) throw new UserError("Choose the organization and team.");
        let drive = null;
        try {
          drive = createDriveClient();
        } catch {
          // Shown as a Drive failure on the fundraiser page; accepting still works.
        }
        const { fundraiser, drive: driveResult } = await acceptApplication(
          db,
          id,
          {
            organizationId: org === "new" ? null : Number(org),
            organizationType: formText(form, "organizationType"),
            teamId: team === "new" ? null : Number(team),
            useExistingOrganizer: formText(form, "useExistingOrganizer") === "1",
          },
          actor,
          { drive },
        );
        goTo = `/app/fundraisers/${fundraiser.id}`;
        return { ok: true, message: driveResult && !driveResult.ok ? "Created; Drive folders failed (Retry on the fundraiser page)." : "Created." };
      }
      default:
        return { ok: false, message: "Unknown action." };
    }
  });
  if (goTo && result.ok) return redirect(goTo);
  return result;
};

export default function ApplicationPage() {
  const { a, emails, emailsOn, options, defaultChoice, organizer, typeGuess, driveReady, history } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  const rows: Array<[string, string | null | undefined] | null> = [
    ["Name", a.name],
    ["Email", a.email],
    ["Phone", a.phone],
    ["Organization", a.organization],
    ["Team / sport", a.team],
    ["Role", a.role],
    ["City, state", a.place],
    ["Timing", a.timing],
    // Only older applications were asked about a logo.
    a.hasLogo === null ? null : ["Has a logo", a.hasLogo ? "Yes" : "No"],
    ["Notes", a.notes],
  ];

  return (
    <s-page heading={`Application from ${a.organization ?? "?"}`}>
      <s-link slot="breadcrumb-actions" href="/app/applications">Applications</s-link>
      <ResultBanner result={result} />

      <s-section heading="What they sent">
        <s-stack gap="small">
          <s-paragraph>
            <s-badge tone={a.status === "new" ? "info" : a.status === "converted" ? "success" : a.status === "spam" ? "critical" : "neutral"}>{a.status}</s-badge>{" "}
            Received {pacific(a.at)}
            {a.reviewedBy ? ` · ${a.status} by ${a.reviewedBy} ${pacific(a.reviewedAt)}` : ""}
            {a.declineReason ? ` · reason: ${a.declineReason}` : ""}
          </s-paragraph>
          {a.fundraiser && (
            <s-paragraph>
              Fundraiser: <s-link href={`/app/fundraisers/${a.fundraiser.id}`}>{a.fundraiser.publicCode}</s-link>
            </s-paragraph>
          )}
          {rows.filter((r): r is [string, string | null | undefined] => r !== null).map(([label, value]) => (
            <s-paragraph key={label}>
              <s-text color="subdued">{label}:</s-text> {value || "—"}
            </s-paragraph>
          ))}
        </s-stack>
      </s-section>

      <s-section heading="Emails">
        <s-stack gap="small">
          <s-text color="subdued">Switch: {emailsOn ? "on" : "off (APPLICATION_EMAILS_ENABLED)"}.</s-text>
          {emails.map((e) => (
            <s-stack key={e.id} direction="inline" gap="base" alignItems="center">
              <s-text>
                {EMAIL_LABELS[e.kind] ?? e.kind}: {EMAIL_STATUS[e.status] ?? e.status}
                {e.sentAt ? ` ${pacific(e.sentAt)}` : ""}
                {e.status !== "sent" && e.attempts > 0 ? ` · ${e.attempts} tries` : ""}
                {e.error && e.status !== "sent" ? ` · ${e.error}` : ""}
              </s-text>
              {e.status === "failed" && (
                <Form method="post">
                  <input type="hidden" name="intent" value="retryEmail" />
                  <input type="hidden" name="emailId" value={e.id} />
                  <s-button type="submit" variant="tertiary" disabled={busy}>Retry</s-button>
                </Form>
              )}
            </s-stack>
          ))}
        </s-stack>
      </s-section>

      {a.status === "new" && (
        <>
          <s-section heading="Accept and create fundraiser">
            <Form method="post">
              <input type="hidden" name="intent" value="accept" />
              <s-stack gap="base">
                <s-select name="choice" label="Organization and team" value={defaultChoice}>
                  {options.map((o) => (
                    <s-option key={o.value} value={o.value}>{o.label}</s-option>
                  ))}
                </s-select>
                <s-select name="organizationType" label="Type, if creating a new organization" value={typeGuess}>
                  {ORGANIZATION_TYPES.map((t) => (
                    <s-option key={t} value={t}>{t}</s-option>
                  ))}
                </s-select>
                {organizer ? (
                  <s-checkbox
                    name="useExistingOrganizer"
                    value="1"
                    defaultChecked
                    label={`Use the existing organizer ${organizer.name} (${organizer.email}, same email)`}
                  />
                ) : (
                  <s-paragraph>A new organizer will be created: {a.name} ({a.email}).</s-paragraph>
                )}
                <s-text color="subdued">
                  The fundraiser starts in Setup with no product or dates; the timing goes in its notes.{" "}
                  {driveReady ? "Drive folders are created too." : "Drive isn't set up on this service yet, so no folders are created."}
                </s-text>
                <s-button type="submit" variant="primary" disabled={busy}>Accept and create fundraiser</s-button>
              </s-stack>
            </Form>
          </s-section>

          <s-section heading="Decline or spam">
            <s-stack gap="base">
              <Form method="post">
                <input type="hidden" name="intent" value="decline" />
                <s-stack direction="inline" gap="base" alignItems="end">
                  <s-text-field name="reason" label="Reason to decline" required />
                  <s-button type="submit" tone="critical" disabled={busy}>Decline</s-button>
                </s-stack>
              </Form>
              <s-text color="subdued">No email is sent when you decline; reply personally from Outlook.</s-text>
              <Form method="post">
                <input type="hidden" name="intent" value="spam" />
                <s-button type="submit" variant="tertiary" tone="critical" disabled={busy}>Mark as spam</s-button>
              </Form>
            </s-stack>
          </s-section>
        </>
      )}

      <s-section heading="History">
        {history.length === 0 ? (
          <s-paragraph>No history yet.</s-paragraph>
        ) : (
          <s-stack gap="small">
            {history.map((h) => (
              <s-paragraph key={h.id}>
                <s-text color="subdued">{pacific(h.at)}</s-text> · {h.text}
              </s-paragraph>
            ))}
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

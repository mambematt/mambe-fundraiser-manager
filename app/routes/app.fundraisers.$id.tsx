// One fundraiser: status and actions, setup checklist, date/rate changes
// with preview, details, organizers and history. Session 3 polishes this page.
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { ResultBanner } from "../components/ResultBanner";
import { CHECKLIST_ITEMS, checklistFrom, isChecklistKey } from "../lib/checklist";
import { calendarDate, dollars, pacific, TIMEZONES } from "../lib/format";
import { adminActionsFrom, canEditDatesOrRate, STATUS_LABELS, type FundraiserStatus, type TransitionAction } from "../lib/status";
import { attempt, formDollarsToCents, formInt, formText, type ActionResult } from "../services/actions.server";
import {
  applyDatesRateChange,
  isoDate,
  launchBlockersFor,
  previewDatesRateChange,
  setChecklistItem,
  setOrganizers,
  setWaitingOnOrganizer,
  storedTotals,
  transitionFundraiser,
  updateDetails,
  UserError,
  type DatesRatePreview,
} from "../services/fundraisers.server";
import { staffName } from "../services/staff.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const id = Number(params.id);
  const f = await db.fundraiser.findUnique({
    where: { id },
    include: {
      team: { include: { organization: true } },
      product: true,
      organizers: { include: { organizer: true } },
    },
  });
  if (!f) throw new Response("Not found", { status: 404 });

  const [totals, allOrganizers, history, blockers] = await Promise.all([
    storedTotals(db, f),
    db.organizer.findMany({ orderBy: { name: "asc" } }),
    db.auditLog.findMany({ where: { entity: "fundraiser", entityId: String(id) }, orderBy: { id: "desc" }, take: 50 }),
    f.status === "setup" ? launchBlockersFor(db, id) : Promise.resolve([]),
  ]);
  const checklist = checklistFrom(f);

  return {
    f: {
      id: f.id,
      publicCode: f.publicCode,
      status: f.status,
      statusLabel: STATUS_LABELS[f.status as FundraiserStatus] ?? f.status,
      team: `${f.team.organization.name} – ${f.team.name}`,
      product: f.product.title,
      productStatus: f.product.status,
      seasonLabel: f.seasonLabel ?? "",
      startDate: isoDate(f.startDate),
      endDate: isoDate(f.endDate),
      timezone: f.timezone,
      timezoneLabel: TIMEZONES.find(([z]) => z === f.timezone)?.[1] ?? f.timezone,
      windowStart: f.windowStart.toISOString(),
      windowEnd: f.windowEnd.toISOString(),
      payoutRateCents: f.payoutRateCents,
      paypalPayeeEmail: f.paypalPayeeEmail ?? "",
      notes: f.notes ?? "",
      cancelledAt: f.cancelledAt?.toISOString() ?? null,
      cancelReason: f.cancelReason,
      waitingOnOrganizerSince: f.waitingOnOrganizerSince?.toISOString() ?? null,
      canEditDates: canEditDatesOrRate(f.status),
      organizerIds: f.organizers.map((o) => o.organizerId),
      primaryOrganizerId: f.organizers.find((o) => o.isPrimary)?.organizerId ?? null,
      organizers: f.organizers.map((o) => ({ name: o.organizer.name, email: o.organizer.email, primary: o.isPrimary })),
    },
    totals,
    checklist: CHECKLIST_ITEMS.map((item) => ({
      key: item.key,
      label: item.label,
      at: checklist[item.key].at?.toISOString() ?? null,
      by: checklist[item.key].by,
    })),
    actions: adminActionsFrom(f.status).map((t) => ({ action: t.action, label: t.label, reasonRequired: t.reasonRequired })),
    blockers,
    allOrganizers: allOrganizers.map((o) => ({ id: o.id, label: `${o.name} (${o.email})` })),
    history: history.map((h) => ({
      id: String(h.id),
      at: h.createdAt.toISOString(),
      action: h.action,
      actor: h.actor,
      reason: h.reason,
      before: h.before ? JSON.stringify(h.before) : "",
      after: h.after ? JSON.stringify(h.after) : "",
    })),
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const actor = staffName(session);
  const id = Number(params.id);
  const form = await request.formData();
  const intent = formText(form, "intent");

  return attempt(async (): Promise<ActionResult> => {
    switch (intent) {
      case "transition": {
        const action = formText(form, "action") as TransitionAction;
        const f = await transitionFundraiser(db, id, action, { reason: formText(form, "reason"), actor });
        return { ok: true, message: `Now ${STATUS_LABELS[f.status as FundraiserStatus]}.` };
      }
      case "checklist": {
        const key = formText(form, "key");
        if (!isChecklistKey(key)) throw new UserError("Unknown checklist item.");
        await setChecklistItem(db, id, key, formText(form, "done") === "1", actor);
        return { ok: true, message: "Checklist updated." };
      }
      case "waiting": {
        const date = formText(form, "since");
        await setWaitingOnOrganizer(db, id, formText(form, "clear") ? null : date ? new Date(`${date}T12:00:00Z`) : new Date(), actor);
        return { ok: true, message: "Saved." };
      }
      case "previewDates":
      case "applyDates": {
        const rate = formDollarsToCents(form, "payoutRate");
        if (rate === null) throw new UserError("Enter the payout rate in dollars, e.g. 25.");
        const change = { startDate: formText(form, "startDate"), endDate: formText(form, "endDate"), payoutRateCents: rate };
        if (intent === "previewDates") {
          const preview = await previewDatesRateChange(db, id, change);
          return { ok: true, message: "", preview, reason: formText(form, "reason") };
        }
        const { preview, saved } = await applyDatesRateChange(db, id, change, formText(form, "reason"), actor);
        const matches =
          saved.qualifyingUnits === preview.after.qualifyingUnits &&
          saved.estimatedPayoutCents === preview.after.estimatedPayoutCents;
        return {
          ok: true,
          message: `Saved. Qualifying units are now ${saved.qualifyingUnits}; estimated payout ${dollars(saved.estimatedPayoutCents)}.`,
          warnings: matches ? [] : ["The saved numbers differ from the preview because new orders arrived in between."],
        };
      }
      case "details": {
        await updateDetails(
          db,
          id,
          {
            publicCode: formText(form, "publicCode"),
            seasonLabel: formText(form, "seasonLabel"),
            paypalPayeeEmail: formText(form, "paypalPayeeEmail"),
            notes: formText(form, "notes"),
          },
          actor,
        );
        return { ok: true, message: "Details saved." };
      }
      case "organizers": {
        await setOrganizers(
          db,
          id,
          form.getAll("organizerIds").map(Number).filter(Boolean),
          formInt(form, "primaryOrganizerId"),
          actor,
        );
        return { ok: true, message: "Organizers saved." };
      }
      default:
        return { ok: false, message: "Unknown action." };
    }
  });
};

function previewSentence(p: DatesRatePreview): string {
  return (
    `Qualifying units change from ${p.before.qualifyingUnits} to ${p.after.qualifyingUnits}; ` +
    `estimated payout from ${dollars(p.before.estimatedPayoutCents)} to ${dollars(p.after.estimatedPayoutCents)}.`
  );
}

export default function FundraiserPage() {
  const { f, totals, checklist, actions, blockers, allOrganizers, history } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>() as (ActionResult & { preview?: DatesRatePreview; reason?: string }) | undefined;
  const busy = useNavigation().state !== "idle";
  const preview = result?.preview;

  return (
    <s-page heading={`${f.publicCode} · ${f.statusLabel}`}>
      <s-link slot="breadcrumb-actions" href="/app/fundraisers">Fundraisers</s-link>
      <ResultBanner result={result} />

      <s-section heading="Overview">
        <s-stack gap="small">
          <s-paragraph>
            <s-text type="strong">{f.team}</s-text> · {f.product} {f.productStatus !== "ACTIVE" && `(${f.productStatus.toLowerCase()} in Shopify)`}
          </s-paragraph>
          <s-paragraph>
            {calendarDate(f.startDate)} – {calendarDate(f.endDate)} ({f.timezoneLabel}) · window {pacific(f.windowStart)} up to{" "}
            {pacific(f.cancelledAt ?? f.windowEnd)}
          </s-paragraph>
          {f.cancelledAt && (
            <s-paragraph>
              Cancelled {pacific(f.cancelledAt)}: {f.cancelReason}
            </s-paragraph>
          )}
          <s-paragraph>
            {dollars(f.payoutRateCents)} per cape · <s-text type="strong">{totals.qualifyingUnits} qualifying units</s-text>,{" "}
            {dollars(totals.estimatedPayoutCents)} estimated payout · {totals.refundedOrCancelledLines} refunded/cancelled lines ·{" "}
            {totals.excludedLines} excluded · {totals.unresolvedFlaggedLines} flagged lines to resolve
          </s-paragraph>
          <s-paragraph>
            Organizers: {f.organizers.map((o) => `${o.name}${o.primary ? " (primary)" : ""}`).join(", ") || "—"} · PayPal payee:{" "}
            {f.paypalPayeeEmail || "not set"}
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="Status">
        <s-stack gap="base">
          {f.status === "setup" && blockers.length > 0 && (
            <s-banner tone="info">
              <s-paragraph>Approve launch is blocked until:</s-paragraph>
              <s-unordered-list>
                {blockers.map((b) => (
                  <s-list-item key={b}>{b}</s-list-item>
                ))}
              </s-unordered-list>
            </s-banner>
          )}
          {actions.length === 0 && (
            <s-paragraph>
              <s-text color="subdued">No admin actions from {f.statusLabel}. The clock moves Scheduled → Active → Settling on its own.</s-text>
            </s-paragraph>
          )}
          {actions.map((a) => (
            <Form method="post" key={a.action}>
              <input type="hidden" name="intent" value="transition" />
              <input type="hidden" name="action" value={a.action} />
              <s-stack direction="inline" gap="base" alignItems="end">
                {a.reasonRequired && <s-text-field name="reason" label={`Reason to ${a.label.toLowerCase()}`} required />}
                <s-button
                  type="submit"
                  variant={a.action === "approve_launch" ? "primary" : "secondary"}
                  tone={a.action === "cancel" || a.action === "decline" ? "critical" : "auto"}
                  disabled={busy || (a.action === "approve_launch" && blockers.length > 0)}
                >
                  {a.label}
                </s-button>
              </s-stack>
            </Form>
          ))}
        </s-stack>
      </s-section>

      <s-section heading="Setup checklist">
        <s-stack gap="small">
          {checklist.map((item) => (
            <Form method="post" key={item.key}>
              <input type="hidden" name="intent" value="checklist" />
              <input type="hidden" name="key" value={item.key} />
              <input type="hidden" name="done" value={item.at ? "0" : "1"} />
              <s-stack direction="inline" gap="base" alignItems="center">
                <s-text>{item.at ? "☑" : "☐"} {item.label}</s-text>
                {item.at && <s-text color="subdued">{item.by} · {pacific(item.at)}</s-text>}
                <s-button type="submit" variant="tertiary" disabled={busy}>
                  {item.at ? "Undo" : "Mark done"}
                </s-button>
              </s-stack>
            </Form>
          ))}
          <Form method="post">
            <input type="hidden" name="intent" value="waiting" />
            <s-stack direction="inline" gap="base" alignItems="end">
              <s-date-field
                name="since"
                label="Waiting on organizer since"
                defaultValue={f.waitingOnOrganizerSince?.slice(0, 10) ?? ""}
              />
              <s-button type="submit" disabled={busy}>Set</s-button>
            </s-stack>
          </Form>
          {f.waitingOnOrganizerSince && (
            <Form method="post">
              <input type="hidden" name="intent" value="waiting" />
              <input type="hidden" name="clear" value="1" />
              <s-button type="submit" variant="tertiary" disabled={busy}>
                Clear waiting on organizer (since {calendarDate(f.waitingOnOrganizerSince)})
              </s-button>
            </Form>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Change dates or rate">
        {!f.canEditDates ? (
          <s-paragraph>Dates and rate are locked once a fundraiser is {f.statusLabel}.</s-paragraph>
        ) : (
          <s-stack gap="base">
            <Form method="post">
              <input type="hidden" name="intent" value="previewDates" />
              <s-stack gap="base">
                <s-stack direction="inline" gap="base">
                  <s-date-field name="startDate" label="Start date" defaultValue={preview?.after.startDate ?? f.startDate} required />
                  <s-date-field name="endDate" label="End date" defaultValue={preview?.after.endDate ?? f.endDate} required />
                  <s-text-field
                    name="payoutRate"
                    label="Payout per cape ($)"
                    defaultValue={((preview?.after.payoutRateCents ?? f.payoutRateCents) / 100).toFixed(2)}
                    required
                  />
                </s-stack>
                <s-text-field name="reason" label="Reason for the change" defaultValue={result?.reason ?? ""} />
                <s-button type="submit" disabled={busy}>Preview change</s-button>
              </s-stack>
            </Form>
            {preview && (
              <s-banner tone={preview.overlaps.length ? "critical" : "info"}>
                <s-paragraph>{previewSentence(preview)}</s-paragraph>
                {preview.overlaps.map((o) => (
                  <s-paragraph key={o.id}>
                    Can&apos;t save: overlaps {o.publicCode} ({calendarDate(o.startDate)} – {calendarDate(o.endDate)}).
                  </s-paragraph>
                ))}
                {preview.overlaps.length === 0 && (
                  <Form method="post">
                    <input type="hidden" name="intent" value="applyDates" />
                    <input type="hidden" name="startDate" value={preview.after.startDate} />
                    <input type="hidden" name="endDate" value={preview.after.endDate} />
                    <input type="hidden" name="payoutRate" value={(preview.after.payoutRateCents / 100).toFixed(2)} />
                    <s-stack direction="inline" gap="base" alignItems="end">
                      <s-text-field name="reason" label="Reason (required)" defaultValue={result?.reason ?? ""} required />
                      <s-button type="submit" variant="primary" disabled={busy}>Save change</s-button>
                    </s-stack>
                  </Form>
                )}
              </s-banner>
            )}
          </s-stack>
        )}
      </s-section>

      <s-section heading="Details">
        <Form method="post">
          <input type="hidden" name="intent" value="details" />
          <s-stack gap="base">
            <s-text-field name="publicCode" label="Public code" defaultValue={f.publicCode} required />
            <s-text-field name="seasonLabel" label="Season" defaultValue={f.seasonLabel} />
            <s-email-field name="paypalPayeeEmail" label="PayPal payee email" defaultValue={f.paypalPayeeEmail} />
            <s-text-area name="notes" label="Notes" defaultValue={f.notes} />
            <s-button type="submit" disabled={busy}>Save details</s-button>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading="Organizers">
        <Form method="post">
          <input type="hidden" name="intent" value="organizers" />
          <s-stack gap="base">
            {allOrganizers.map((o) => (
              <s-checkbox
                key={o.id}
                name="organizerIds"
                value={String(o.id)}
                label={o.label}
                defaultChecked={f.organizerIds.includes(o.id)}
              />
            ))}
            <s-select name="primaryOrganizerId" label="Primary organizer" value={f.primaryOrganizerId ? String(f.primaryOrganizerId) : ""}>
              <s-option value="">Only one chosen? It&apos;s primary.</s-option>
              {allOrganizers.map((o) => (
                <s-option key={o.id} value={String(o.id)}>{o.label}</s-option>
              ))}
            </s-select>
            <s-button type="submit" disabled={busy}>Save organizers</s-button>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading="History">
        {history.length === 0 ? (
          <s-paragraph>No history yet.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>When (Pacific)</s-table-header>
              <s-table-header>What</s-table-header>
              <s-table-header>Who</s-table-header>
              <s-table-header>Reason</s-table-header>
              <s-table-header>Before → after</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {history.map((h) => (
                <s-table-row key={h.id}>
                  <s-table-cell>{pacific(h.at)}</s-table-cell>
                  <s-table-cell>{h.action}</s-table-cell>
                  <s-table-cell>{h.actor}</s-table-cell>
                  <s-table-cell>{h.reason ?? "—"}</s-table-cell>
                  <s-table-cell>
                    <s-text color="subdued">{h.before || "—"} → {h.after || "—"}</s-text>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

// One fundraiser: the page used every day. Overview, estimated totals, flags
// to resolve, sales, status and checklist, date/rate changes, assets,
// details, organizers, history, and placeholders for later sessions.
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { ResultBanner } from "../components/ResultBanner";
import { netUnits, REVIEW_FLAG_LABELS, type ReviewFlag } from "../lib/attribution";
import { describeAudit } from "../lib/audit-describe";
import { dayStatus } from "../lib/calendar";
import { CHECKLIST_ITEMS, checklistFrom, isChecklistKey } from "../lib/checklist";
import { calendarDate, dollars, pacific, TIMEZONES } from "../lib/format";
import { adminOrderUrl, adminProductUrl, storefrontProductUrl } from "../lib/shopify-links";
import { adminActionsFrom, canEditDatesOrRate, STATUS_LABELS, type FundraiserStatus, type TransitionAction } from "../lib/status";
import { attempt, formDollarsToCents, formInt, formText, type ActionResult } from "../services/actions.server";
import { ASSET_KINDS } from "../lib/assets";
import { addAsset, replaceAsset } from "../services/assets.server";
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
import { decideLine, decisionsLockedReason } from "../services/line-decisions.server";
import { staffName } from "../services/staff.server";

const TABS = [
  { key: "qualifying", label: "Qualifying" },
  { key: "outside", label: "Outside window" },
  { key: "refunded", label: "Refunded/cancelled" },
  { key: "excluded", label: "Excluded by admin" },
  { key: "unpaid", label: "Not paid yet" },
  { key: "test", label: "Test order (not counted)" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

const OUTCOME_FOR_TAB: Record<Exclude<TabKey, "outside">, string> = {
  qualifying: "qualifying",
  refunded: "refunded_cancelled",
  excluded: "excluded",
  unpaid: "not_eligible",
  test: "test_order",
};

const KIND_LABELS: Record<string, string> = { flyer: "Flyer", email_copy: "Email copy", social_image: "Social image", other: "Other" };
const DAY = 24 * 3600 * 1000;

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const id = Number(params.id);
  const url = new URL(request.url);
  const tab = (TABS.find((t) => t.key === url.searchParams.get("tab"))?.key ?? "qualifying") as TabKey;

  const f = await db.fundraiser.findUnique({
    where: { id },
    include: {
      team: { include: { organization: true } },
      product: true,
      organizers: { include: { organizer: true }, orderBy: [{ isPrimary: "desc" }] },
      assets: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!f) throw new Response("Not found", { status: 404 });

  // Sales near the window that didn't land in it: 30 days either side.
  const outsideWhere = {
    shopifyProductId: f.product.shopifyProductId,
    outcome: "non_fundraiser",
    order: { processedAt: { gte: new Date(f.windowStart.getTime() - 30 * DAY), lte: new Date(f.windowEnd.getTime() + 30 * DAY) } },
  };
  const lineInclude = { order: { select: { name: true, shopifyOrderId: true, processedAt: true } } } as const;

  const [totals, attributed, outside, allOrganizers, history, blockers, lockedReason] = await Promise.all([
    storedTotals(db, f),
    db.orderLineItem.findMany({ where: { attributedFundraiserId: id }, include: lineInclude, orderBy: { order: { processedAt: "desc" } } }),
    db.orderLineItem.findMany({ where: outsideWhere, include: lineInclude, orderBy: { order: { processedAt: "desc" } } }),
    db.organizer.findMany({ orderBy: { name: "asc" } }),
    db.auditLog.findMany({ where: { entity: "fundraiser", entityId: String(id) }, orderBy: { id: "desc" }, take: 100 }),
    f.status === "setup" ? launchBlockersFor(db, id) : Promise.resolve([]),
    decisionsLockedReason(db, id),
  ]);

  const row = (l: (typeof attributed)[number]) => ({
    id: l.id,
    orderName: l.order.name,
    orderUrl: adminOrderUrl(l.order.shopifyOrderId),
    processedAt: l.order.processedAt.toISOString(),
    units: l.outcome === "qualifying" ? l.qualifyingUnits : netUnits(l),
    quantity: l.quantity,
    refundedQuantity: l.refundedQuantity,
    unitPriceCents: l.unitPriceCents,
    discountCents: l.discountCents,
    outcome: l.outcome,
    flags: l.reviewFlags.map((x) => REVIEW_FLAG_LABELS[x as ReviewFlag] ?? x),
    decision: l.adminDecision,
    decisionNote: l.adminDecisionNote,
    decisionBy: l.adminDecisionBy,
    decisionAt: l.adminDecisionAt?.toISOString() ?? null,
  });

  const counts = Object.fromEntries(
    TABS.map((t) => [t.key, t.key === "outside" ? outside.length : attributed.filter((l) => l.outcome === OUTCOME_FOR_TAB[t.key]).length]),
  ) as Record<TabKey, number>;
  const tabLines = tab === "outside" ? outside : attributed.filter((l) => l.outcome === OUTCOME_FOR_TAB[tab]);
  const flagged = attributed.filter((l) => l.reviewFlags.length > 0 && ["qualifying", "excluded", "not_eligible"].includes(l.outcome));
  const checklist = checklistFrom(f);
  const startDate = isoDate(f.startDate);
  const endDate = isoDate(f.endDate);

  return {
    f: {
      id: f.id,
      publicCode: f.publicCode,
      status: f.status,
      statusLabel: STATUS_LABELS[f.status as FundraiserStatus] ?? f.status,
      organization: `${f.team.organization.name} (${f.team.organization.type})`,
      team: f.team.name,
      product: f.product.title,
      productStatus: f.product.status,
      productAdminUrl: adminProductUrl(f.product.shopifyProductId),
      productStoreUrl: storefrontProductUrl(session.shop, f.product.handle),
      seasonLabel: f.seasonLabel ?? "",
      startDate,
      endDate,
      dayStatus: dayStatus(startDate, endDate, new Date()),
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
      organizers: f.organizers.map((o) => ({ id: o.organizerId, name: o.organizer.name, email: o.organizer.email, phone: o.organizer.phone, primary: o.isPrimary })),
    },
    totals,
    tab,
    counts,
    lines: tabLines.map(row),
    flagged: flagged.map(row),
    lockedReason,
    assets: f.assets.map((a) => ({
      id: a.id,
      title: a.title,
      kind: a.kind,
      url: a.url ?? "",
      visibility: a.visibility,
      isCurrent: a.isCurrent,
      createdAt: a.createdAt.toISOString(),
      createdBy: a.createdBy,
      replacedBy: f.assets.find((b) => b.id === a.replacedById)?.title ?? null,
    })),
    checklist: CHECKLIST_ITEMS.map((item) => ({
      key: item.key,
      label: item.label,
      at: checklist[item.key].at?.toISOString() ?? null,
      by: checklist[item.key].by,
    })),
    actions: adminActionsFrom(f.status).map((t) => ({ action: t.action, label: t.label, reasonRequired: t.reasonRequired })),
    blockers,
    allOrganizers: allOrganizers.map((o) => ({ id: o.id, label: `${o.name} (${o.email})` })),
    history: history.map((h) => ({ id: String(h.id), at: h.createdAt.toISOString(), text: describeAudit(h) })),
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
      case "decide": {
        const decision = formText(form, "decision") as "include" | "exclude";
        const totals = await decideLine(db, Number(formText(form, "lineId")), decision, formText(form, "note"), actor);
        return {
          ok: true,
          message: `${decision === "include" ? "Included" : "Excluded"}. Estimate is now ${totals.qualifyingUnits} units, ${dollars(totals.estimatedPayoutCents)}.`,
        };
      }
      case "addAsset":
      case "replaceAsset": {
        const input = {
          title: formText(form, "title"),
          kind: formText(form, "kind"),
          url: formText(form, "url"),
          visibility: formText(form, "visibility"),
        };
        if (intent === "addAsset") await addAsset(db, id, input, actor);
        else await replaceAsset(db, Number(formText(form, "assetId")), input, actor);
        return { ok: true, message: intent === "addAsset" ? "Asset added." : "Asset replaced." };
      }
      case "notes": {
        const f = await db.fundraiser.findUniqueOrThrow({ where: { id } });
        await updateDetails(
          db,
          id,
          { publicCode: f.publicCode, seasonLabel: f.seasonLabel, paypalPayeeEmail: f.paypalPayeeEmail, notes: formText(form, "notes") },
          actor,
        );
        return { ok: true, message: "Notes saved." };
      }
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
          saved.qualifyingUnits === preview.after.qualifyingUnits && saved.estimatedPayoutCents === preview.after.estimatedPayoutCents;
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
        await setOrganizers(db, id, form.getAll("organizerIds").map(Number).filter(Boolean), formInt(form, "primaryOrganizerId"), actor);
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

const OUTCOME_LABELS: Record<string, string> = {
  qualifying: "Qualifying",
  non_fundraiser: "Outside window",
  refunded_cancelled: "Refunded/cancelled",
  excluded: "Excluded by admin",
  not_eligible: "Not paid yet",
  test_order: "Test order (not counted)",
};

type Row = ReturnType<typeof useLoaderData<typeof loader>>["lines"][number];

function AssetFields({ defaults }: { defaults?: { title: string; kind: string; url: string; visibility: string } }) {
  return (
    <s-stack direction="inline" gap="base" alignItems="end">
      <s-text-field name="title" label="Title" defaultValue={defaults?.title ?? ""} required />
      <s-select name="kind" label="Kind" value={defaults?.kind ?? "flyer"}>
        {ASSET_KINDS.map((k) => (
          <s-option key={k} value={k}>{KIND_LABELS[k]}</s-option>
        ))}
      </s-select>
      <s-url-field name="url" label="Link (Drive or other)" defaultValue={defaults?.url ?? ""} required />
      <s-select name="visibility" label="Who can see it" value={defaults?.visibility ?? "organizer"}>
        <s-option value="organizer">Organizer</s-option>
        <s-option value="internal">Internal only</s-option>
      </s-select>
    </s-stack>
  );
}

export default function FundraiserPage() {
  const data = useLoaderData<typeof loader>();
  const { f, totals, checklist, actions, blockers, allOrganizers, history } = data;
  const result = useActionData<typeof action>() as (ActionResult & { preview?: DatesRatePreview; reason?: string }) | undefined;
  const busy = useNavigation().state !== "idle";
  const preview = result?.preview;
  const primary = f.organizers.find((o) => o.primary);

  return (
    <s-page heading={f.publicCode}>
      <s-link slot="breadcrumb-actions" href="/app/fundraisers">Fundraisers</s-link>
      <ResultBanner result={result} />

      <s-section heading="Overview">
        <s-stack gap="small">
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-badge tone={f.status === "active" ? "success" : f.status === "cancelled" || f.status === "declined" ? "critical" : "info"}>
              {f.statusLabel}
            </s-badge>
            <s-text type="strong">{f.team}</s-text>
            <s-text>· {f.organization}</s-text>
          </s-stack>
          <s-paragraph>
            {calendarDate(f.startDate)} – {calendarDate(f.endDate)} ({f.timezoneLabel}) · <s-text type="strong">{f.dayStatus}</s-text>
            {f.cancelledAt && ` · Cancelled ${pacific(f.cancelledAt)}: ${f.cancelReason}`}
          </s-paragraph>
          <s-paragraph>
            Organizers:{" "}
            {f.organizers.map((o) => `${o.name}${o.primary ? " (primary)" : ""} · ${o.email}${o.phone ? ` · ${o.phone}` : ""}`).join("; ") || "—"}
          </s-paragraph>
          <s-paragraph>
            {dollars(f.payoutRateCents)} per cape · PayPal payee: {f.paypalPayeeEmail || "not set"}
            {primary && f.paypalPayeeEmail && f.paypalPayeeEmail === primary.email ? " (the organizer's own email)" : ""}
          </s-paragraph>
          <s-paragraph>
            Product: {f.product}
            {f.productStatus !== "ACTIVE" && ` (${f.productStatus.toLowerCase()} in Shopify)`} ·{" "}
            <s-link href={f.productAdminUrl} target="_blank">Open in Shopify admin</s-link> ·{" "}
            <s-link href={f.productStoreUrl} target="_blank">View on store</s-link>
          </s-paragraph>
          <Form method="post">
            <input type="hidden" name="intent" value="notes" />
            <s-stack direction="inline" gap="base" alignItems="end">
              <s-text-area name="notes" label="Internal notes" defaultValue={f.notes} />
              <s-button type="submit" disabled={busy}>Save notes</s-button>
            </s-stack>
          </Form>
        </s-stack>
      </s-section>

      <s-section heading="Estimated totals">
        <s-banner tone="info">
          <s-paragraph>
            <s-text type="strong">Estimated, final after settlement.</s-text>
          </s-paragraph>
        </s-banner>
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(160px, 1fr))" gap="base">
          {[
            ["Qualifying units", String(totals.qualifyingUnits)],
            ["Estimated payout", dollars(totals.estimatedPayoutCents)],
            ["Fundraiser revenue", dollars(totals.revenueCents)],
            ["Flags to resolve", String(totals.unresolvedFlaggedLines)],
          ].map(([label, value]) => (
            <s-box key={label} padding="base" borderWidth="base" borderRadius="base">
              <s-stack gap="small-200">
                <s-text color="subdued">{label}</s-text>
                <s-heading>{value}</s-heading>
              </s-stack>
            </s-box>
          ))}
        </s-grid>
      </s-section>

      <div id="flags">
        <s-section heading={`Flags to resolve (${totals.unresolvedFlaggedLines} open)`}>
          {data.flagged.length === 0 ? (
            <s-paragraph>No flagged lines in this window.</s-paragraph>
          ) : (
            <s-stack gap="base">
              {data.lockedReason && (
                <s-banner tone="warning">
                  <s-paragraph>{data.lockedReason}</s-paragraph>
                </s-banner>
              )}
              {data.flagged.map((l: Row) => (
                <s-box key={l.id} padding="base" borderWidth="base" borderRadius="base">
                  <s-stack gap="small">
                    <s-paragraph>
                      <s-link href={l.orderUrl} target="_blank">{l.orderName}</s-link> · {pacific(l.processedAt)} · {l.units} unit
                      {l.units === 1 ? "" : "s"} · {dollars(l.unitPriceCents)} each
                      {l.discountCents > 0 && ` · ${dollars(l.discountCents)} discount`} · <s-text type="strong">{l.flags.join("; ")}</s-text>
                    </s-paragraph>
                    <s-paragraph>
                      {l.decision ? (
                        <s-text>
                          {l.decision === "include" ? "Included" : "Excluded"} by {l.decisionBy} {pacific(l.decisionAt)}: “{l.decisionNote}”
                        </s-text>
                      ) : (
                        <s-text tone="caution">Not decided yet; counted in the estimate until you decide.</s-text>
                      )}
                    </s-paragraph>
                    {!data.lockedReason && (
                      <s-stack direction="inline" gap="base" alignItems="end">
                        {(["include", "exclude"] as const).map((decision) => (
                          <Form method="post" key={decision}>
                            <input type="hidden" name="intent" value="decide" />
                            <input type="hidden" name="lineId" value={l.id} />
                            <input type="hidden" name="decision" value={decision} />
                            <s-stack direction="inline" gap="small" alignItems="end">
                              <s-text-field name="note" label={`Note to ${decision}`} required />
                              <s-button
                                type="submit"
                                variant={decision === "include" ? "primary" : "secondary"}
                                tone={decision === "exclude" ? "critical" : "auto"}
                                disabled={busy || l.decision === decision}
                              >
                                {decision === "include" ? "Include" : "Exclude"}
                              </s-button>
                            </s-stack>
                          </Form>
                        ))}
                      </s-stack>
                    )}
                  </s-stack>
                </s-box>
              ))}
            </s-stack>
          )}
        </s-section>
      </div>

      <s-section heading="Sales">
        <s-stack gap="base">
          <s-stack direction="inline" gap="small">
            {TABS.filter((t) => t.key !== "unpaid" || data.counts.unpaid > 0).map((t) => (
              <s-button
                key={t.key}
                href={`/app/fundraisers/${f.id}?tab=${t.key}`}
                variant={data.tab === t.key ? "primary" : "secondary"}
              >
                {t.label} ({data.counts[t.key]})
              </s-button>
            ))}
          </s-stack>
          {data.tab === "outside" && (
            <s-text color="subdued">Sales of this product within 30 days before or after the window.</s-text>
          )}
          {data.lines.length === 0 ? (
            <s-paragraph>No sales here.</s-paragraph>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-header>Order</s-table-header>
                <s-table-header>Checkout (Pacific)</s-table-header>
                <s-table-header format="numeric">Units</s-table-header>
                <s-table-header format="currency">Line price</s-table-header>
                <s-table-header>Flags</s-table-header>
                <s-table-header>Outcome</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {data.lines.map((l: Row) => (
                  <s-table-row key={l.id}>
                    <s-table-cell>
                      <s-link href={l.orderUrl} target="_blank">{l.orderName}</s-link>
                    </s-table-cell>
                    <s-table-cell>{pacific(l.processedAt)}</s-table-cell>
                    <s-table-cell>
                      {l.units}
                      {l.refundedQuantity > 0 ? ` (of ${l.quantity}; ${l.refundedQuantity} refunded)` : ""}
                    </s-table-cell>
                    <s-table-cell>{dollars(l.unitPriceCents)}</s-table-cell>
                    <s-table-cell>{l.flags.length ? l.flags.join("; ") : "—"}</s-table-cell>
                    <s-table-cell>
                      {OUTCOME_LABELS[l.outcome] ?? l.outcome}
                      {l.decision ? ` · ${l.decision}d` : ""}
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
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
              <s-date-field name="since" label="Waiting on organizer since" defaultValue={f.waitingOnOrganizerSince?.slice(0, 10) ?? ""} />
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

      <s-section heading="Assets">
        <s-stack gap="base">
          {data.assets.filter((a) => a.isCurrent).length === 0 && <s-paragraph>No assets yet.</s-paragraph>}
          {data.assets
            .filter((a) => a.isCurrent)
            .map((a) => (
              <s-box key={a.id} padding="base" borderWidth="base" borderRadius="base">
                <s-stack gap="small">
                  <s-paragraph>
                    <s-link href={a.url} target="_blank">{a.title}</s-link> · {KIND_LABELS[a.kind] ?? a.kind} ·{" "}
                    {a.visibility === "organizer" ? <s-badge tone="success">Organizer can see</s-badge> : <s-badge>Internal only</s-badge>}
                    <s-text color="subdued"> · added {pacific(a.createdAt)}{a.createdBy ? ` by ${a.createdBy}` : ""}</s-text>
                  </s-paragraph>
                  <Form method="post">
                    <input type="hidden" name="intent" value="replaceAsset" />
                    <input type="hidden" name="assetId" value={a.id} />
                    <s-stack gap="small">
                      <s-text color="subdued">Replace with a new version:</s-text>
                      <AssetFields defaults={{ title: a.title, kind: a.kind, url: "", visibility: a.visibility }} />
                      <s-button type="submit" variant="tertiary" disabled={busy}>Replace</s-button>
                    </s-stack>
                  </Form>
                </s-stack>
              </s-box>
            ))}
          <Form method="post">
            <input type="hidden" name="intent" value="addAsset" />
            <s-stack gap="small">
              <s-heading>Add an asset</s-heading>
              <AssetFields />
              <s-button type="submit" variant="primary" disabled={busy}>Add asset</s-button>
            </s-stack>
          </Form>
          {data.assets.some((a) => !a.isCurrent) && (
            <s-text color="subdued">
              Replaced: {data.assets.filter((a) => !a.isCurrent).map((a) => `${a.title} → ${a.replacedBy ?? "?"}`).join("; ")}
            </s-text>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Details">
        <Form method="post">
          <input type="hidden" name="intent" value="details" />
          <s-stack gap="base">
            <s-text-field name="publicCode" label="Public code" defaultValue={f.publicCode} required />
            <s-text-field name="seasonLabel" label="Season" defaultValue={f.seasonLabel} />
            <s-email-field name="paypalPayeeEmail" label="PayPal payee email" defaultValue={f.paypalPayeeEmail} />
            <input type="hidden" name="notes" value={f.notes} />
            <s-button type="submit" disabled={busy}>Save details</s-button>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading="Organizers">
        <Form method="post">
          <input type="hidden" name="intent" value="organizers" />
          <s-stack gap="base">
            {allOrganizers.map((o) => (
              <s-checkbox key={o.id} name="organizerIds" value={String(o.id)} label={o.label} defaultChecked={f.organizerIds.includes(o.id)} />
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

      <s-section heading="Communications">
        <s-paragraph>
          <s-text color="subdued">
            Coming in session 4: the launch email, the week 2, week 3 and final-days reminders, the &ldquo;ended&rdquo; and
            &ldquo;paid&rdquo; emails, each with when it was scheduled, when it was sent, and any error.
          </s-text>
        </s-paragraph>
      </s-section>

      <s-section heading="Payout">
        <s-paragraph>
          <s-text color="subdued">
            Coming with settlement: 10 days after the end date, a full re-check against Shopify, then the draft payout (units ×
            rate), adjustments, approval, and the PayPal payment record.
          </s-text>
        </s-paragraph>
      </s-section>

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

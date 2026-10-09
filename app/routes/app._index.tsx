// Admin home (until session 3's work queue): recent order lines, sync health
// and scheduled jobs.
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { ResultBanner } from "../components/ResultBanner";
import { REVIEW_FLAG_LABELS, type ReviewFlag } from "../lib/attribution";
import { pacific , dollars } from "../lib/format";
import { formatCents } from "../lib/money";
import { attempt, formText } from "../services/actions.server";
import { alert, flushAlerts } from "../services/alerts.server";
import { runNightlyRecheck } from "../services/jobs.server";
import { loadNumberStrip, loadWorkQueue } from "../services/dashboard.server";
import { shopifyClientForShop } from "../services/shopify-client.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  const products = await db.product.findMany({ select: { shopifyProductId: true, title: true } });
  const titles = new Map(products.map((p) => [p.shopifyProductId, p.title]));
  const lines = await db.orderLineItem.findMany({
    orderBy: { id: "desc" },
    take: 30,
    include: { order: true, attributedFundraiser: { select: { publicCode: true } } },
  });

  const [strip, queue] = await Promise.all([loadNumberStrip(db), loadWorkQueue(db)]);
  const [lastWebhook, failedWebhooks, recentEvents, lastClock, lastNightly, lastNightlyOk] = await Promise.all([
    db.webhookEvent.findFirst({ orderBy: { receivedAt: "desc" } }),
    db.webhookEvent.count({ where: { status: "failed" } }),
    db.webhookEvent.findMany({ orderBy: { receivedAt: "desc" }, take: 10 }),
    db.jobRun.findFirst({ where: { name: "clock" }, orderBy: { startedAt: "desc" } }),
    db.jobRun.findFirst({ where: { name: "nightly" }, orderBy: { startedAt: "desc" } }),
    db.jobRun.findFirst({ where: { name: "nightly", status: "succeeded" }, orderBy: { startedAt: "desc" } }),
  ]);
  const job = (run: typeof lastClock) =>
    run ? { at: run.startedAt.toISOString(), status: run.status, error: run.error?.split("\n")[0] ?? null, details: run.details ? JSON.stringify(run.details) : "" } : null;

  return {
    strip,
    queue,
    lines: lines.map((l) => ({
      id: l.id,
      orderName: l.order.name,
      shopifyOrderId: l.order.shopifyOrderId,
      processedAt: l.order.processedAt.toISOString(),
      source: l.order.source,
      sourceName: l.order.sourceName,
      product: titles.get(l.shopifyProductId) ?? l.shopifyProductId,
      quantity: l.quantity,
      refundedQuantity: l.refundedQuantity,
      unitPriceCents: l.unitPriceCents,
      unitCostCents: l.unitCostCents,
      costApproximate: l.costApproximate,
      fundraiser: l.attributedFundraiser?.publicCode ?? null,
      qualifyingUnits: l.qualifyingUnits,
      outcome: l.outcome,
      flags: l.reviewFlags,
    })),
    webhooks: {
      lastReceivedAt: lastWebhook?.receivedAt.toISOString() ?? null,
      failed: failedWebhooks,
      recent: recentEvents.map((e) => ({
        id: e.id,
        topic: e.topic,
        resourceId: e.resourceId,
        status: e.status,
        receivedAt: e.receivedAt.toISOString(),
        error: e.error?.split("\n")[0] ?? null,
      })),
    },
    jobs: { clock: job(lastClock), nightly: job(lastNightly), nightlyOkAt: lastNightlyOk?.startedAt.toISOString() ?? null },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  return attempt(async () => {
    if (formText(form, "intent") === "testAlert") {
      if (!process.env.SENTRY_DSN) return { ok: false, message: "SENTRY_DSN isn't set on this service in Render." };
      alert(`Test alert from ${process.env.RENDER_SERVICE_NAME ?? "the app"}. Alerts reach Sentry; no action needed.`);
      await flushAlerts();
      return { ok: true, message: "Test alert sent. It should appear in Sentry → Issues within a minute, and Sentry should email you." };
    }
    const shopify = await shopifyClientForShop(session.shop);
    const result = await runNightlyRecheck(db, shopify);
    if (result.status === "failed") return { ok: false, message: `Nightly re-check failed: ${result.error}` };
    const d = result.details as { ordersChecked: number; ordersSaved: number };
    return { ok: true, message: `Nightly re-check done: ${d.ordersChecked} orders checked, ${d.ordersSaved} with linked products saved.` };
  });
};

const SOURCE_LABELS: Record<string, string> = {
  web: "Online store",
  pos: "POS",
  draft: "Draft order",
};

const OUTCOME_LABELS: Record<string, string> = {
  qualifying: "Qualifying",
  non_fundraiser: "Outside window",
  refunded_cancelled: "Refunded / cancelled",
  excluded: "Excluded",
  not_eligible: "Not paid",
  test_order: "Test order (not counted)",
  pending: "Pending",
};

export default function Index() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";

  return (
    <s-page heading="Home">
      <ResultBanner result={result} />

      <s-section>
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(150px, 1fr))" gap="base">
          {[
            ["Active", String(data.strip.active), "/app/fundraisers?status=active"],
            ["Scheduled", String(data.strip.scheduled), "/app/fundraisers?status=scheduled"],
            ["Settling", String(data.strip.settling), "/app/fundraisers?status=settling"],
            ["Payouts outstanding", dollars(data.strip.payoutsOutstandingCents), "/app/fundraisers?status=payout_pending"],
            [
              "This month (est.)",
              `${data.strip.month.units} units · ${dollars(data.strip.month.estimatedPayoutCents)}`,
              "/app/fundraisers",
            ],
            [
              "Year to date (est.)",
              `${data.strip.year.units} units · ${dollars(data.strip.year.estimatedPayoutCents)}`,
              "/app/fundraisers",
            ],
            ["Sold outside windows, 30 days", `${data.strip.outsideWindowUnits30d} units`, "/app/products"],
          ].map(([label, value, href]) => (
            <s-clickable key={label} href={href} padding="base" border="base" borderRadius="base">
              <s-stack gap="small-200">
                <s-text color="subdued">{label}</s-text>
                <s-heading>{value}</s-heading>
              </s-stack>
            </s-clickable>
          ))}
        </s-grid>
      </s-section>

      <s-section heading="Needs attention">
        {data.queue.length === 0 ? (
          <s-paragraph>Nothing needs you right now.</s-paragraph>
        ) : (
          <s-stack gap="base">
            {data.queue.map((g) => (
              <s-box key={g.key} padding="base" borderWidth="base" borderRadius="base">
                <s-stack gap="small">
                  <s-stack direction="inline" gap="small" alignItems="center">
                    <s-badge tone={g.tone}>{String(g.count)}</s-badge>
                    <s-text type="strong">{g.label}</s-text>
                  </s-stack>
                  <s-unordered-list>
                    {g.items.map((i) => (
                      <s-list-item key={i.href + i.label}>
                        <s-link href={i.href}>{i.label}</s-link>
                        {i.detail ? ` · ${i.detail}` : ""}
                      </s-list-item>
                    ))}
                  </s-unordered-list>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
      </s-section>

      <s-section heading="Recent order lines">
        {data.lines.length === 0 ? (
          <s-paragraph>No order lines saved yet.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Order</s-table-header>
              <s-table-header>Checkout (Pacific)</s-table-header>
              <s-table-header>Source</s-table-header>
              <s-table-header>Product</s-table-header>
              <s-table-header format="numeric">Qty</s-table-header>
              <s-table-header format="numeric">Refunded</s-table-header>
              <s-table-header format="currency">Price</s-table-header>
              <s-table-header format="currency">Unit cost</s-table-header>
              <s-table-header>Attribution</s-table-header>
              <s-table-header>Flags</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.lines.map((l) => (
                <s-table-row key={l.id}>
                  <s-table-cell>
                    <s-link href={`shopify://admin/orders/${l.shopifyOrderId}`} target="_blank">
                      {l.orderName}
                    </s-link>
                  </s-table-cell>
                  <s-table-cell>{pacific(l.processedAt)}</s-table-cell>
                  <s-table-cell>{SOURCE_LABELS[l.source] ?? l.sourceName ?? "—"}</s-table-cell>
                  <s-table-cell>{l.product}</s-table-cell>
                  <s-table-cell>{l.quantity}</s-table-cell>
                  <s-table-cell>{l.refundedQuantity}</s-table-cell>
                  <s-table-cell>{formatCents(l.unitPriceCents)}</s-table-cell>
                  <s-table-cell>
                    {l.unitCostCents === null
                      ? "Not set"
                      : `${formatCents(l.unitCostCents)}${l.costApproximate ? " (approx.)" : ""}`}
                  </s-table-cell>
                  <s-table-cell>
                    {OUTCOME_LABELS[l.outcome] ?? l.outcome}
                    {l.fundraiser ? ` · ${l.fundraiser} · ${l.qualifyingUnits} units (estimated)` : ""}
                  </s-table-cell>
                  <s-table-cell>
                    {l.flags.length === 0
                      ? "—"
                      : l.flags.map((f) => REVIEW_FLAG_LABELS[f as ReviewFlag] ?? f).join("; ")}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <div id="sync" />
      <s-section heading="Sync health">
        <s-paragraph>
          Last webhook: {pacific(data.webhooks.lastReceivedAt)} · Failed webhooks:{" "}
          {data.webhooks.failed}
        </s-paragraph>
        <s-paragraph>
          Status clock (every 15 min): {data.jobs.clock ? `${data.jobs.clock.status} ${pacific(data.jobs.clock.at)}` : "not run yet"}
          {data.jobs.clock?.error ? ` · ${data.jobs.clock.error}` : ""}
        </s-paragraph>
        <s-paragraph>
          Nightly re-check: last success {pacific(data.jobs.nightlyOkAt)}
          {data.jobs.nightly && data.jobs.nightly.status !== "succeeded"
            ? ` · last attempt ${data.jobs.nightly.status} ${pacific(data.jobs.nightly.at)}${data.jobs.nightly.error ? `: ${data.jobs.nightly.error}` : ""}`
            : ""}
        </s-paragraph>
        <s-stack direction="inline" gap="base">
          <Form method="post">
            <input type="hidden" name="intent" value="nightly" />
            <s-button type="submit" disabled={busy}>Run nightly re-check now</s-button>
          </Form>
          <Form method="post">
            <input type="hidden" name="intent" value="testAlert" />
            <s-button type="submit" variant="tertiary" disabled={busy}>Send a test alert</s-button>
          </Form>
        </s-stack>
        {data.webhooks.recent.length > 0 && (
          <s-table>
            <s-table-header-row>
              <s-table-header>Received (Pacific)</s-table-header>
              <s-table-header>Topic</s-table-header>
              <s-table-header>Shopify ID</s-table-header>
              <s-table-header>Status</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.webhooks.recent.map((e) => (
                <s-table-row key={e.id}>
                  <s-table-cell>{pacific(e.receivedAt)}</s-table-cell>
                  <s-table-cell>{e.topic}</s-table-cell>
                  <s-table-cell>{e.resourceId ?? "—"}</s-table-cell>
                  <s-table-cell>
                    {e.status}
                    {e.error ? ` · ${e.error}` : ""}
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

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

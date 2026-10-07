// Session 1 admin home: link products, run backfills, and watch orders and
// webhooks arrive. The full work queue replaces this in a later session.
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { DateTime } from "luxon";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { REVIEW_FLAG_LABELS, type ReviewFlag } from "../lib/attribution";
import { formatCents } from "../lib/money";
import { DEFAULT_TIMEZONE } from "../lib/window";
import {
  backfillProduct,
  hasFundraiserTag,
  lifetimeTotalsForProduct,
  linkProduct,
} from "../services/products.server";
import { shopifyClientForShop } from "../services/shopify-client.server";

interface BackfillAuditResult {
  ordersFound?: number;
  failures?: unknown[];
}

function pacific(date: Date | string | null): string {
  if (!date) return "—";
  return DateTime.fromJSDate(new Date(date))
    .setZone(DEFAULT_TIMEZONE)
    .toFormat("LLL d, yyyy h:mm a ZZZZ");
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const products = await db.product.findMany({ orderBy: { createdAt: "asc" } });
  const productRows = await Promise.all(
    products.map(async (p) => {
      const lastBackfill = await db.auditLog.findFirst({
        where: { entity: "product", entityId: String(p.id), action: { startsWith: "backfill" } },
        orderBy: { id: "desc" },
      });
      return {
        id: p.id,
        shopifyProductId: p.shopifyProductId,
        title: p.title,
        status: p.status,
        tagged: hasFundraiserTag(p.tags),
        backfilledAt: p.backfilledAt?.toISOString() ?? null,
        lastBackfill: lastBackfill
          ? { action: lastBackfill.action, at: lastBackfill.createdAt.toISOString(), result: lastBackfill.after as BackfillAuditResult | null }
          : null,
        totals: await lifetimeTotalsForProduct(db, p.shopifyProductId),
      };
    }),
  );

  const titles = new Map(products.map((p) => [p.shopifyProductId, p.title]));
  const lines = await db.orderLineItem.findMany({
    orderBy: { id: "desc" },
    take: 30,
    include: { order: true, attributedFundraiser: { select: { publicCode: true } } },
  });

  const [lastWebhook, failedWebhooks, recentEvents] = await Promise.all([
    db.webhookEvent.findFirst({ orderBy: { receivedAt: "desc" } }),
    db.webhookEvent.count({ where: { status: "failed" } }),
    db.webhookEvent.findMany({ orderBy: { receivedAt: "desc" }, take: 10 }),
  ]);

  return {
    shop: session.shop,
    products: productRows,
    lines: lines.map((l) => ({
      id: l.id,
      orderName: l.order.name,
      shopifyOrderId: l.order.shopifyOrderId,
      processedAt: l.order.processedAt.toISOString(),
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
      savedAt: l.createdAt.toISOString(),
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
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");
  const shopify = await shopifyClientForShop(session.shop);

  if (intent === "link") {
    try {
      const result = await linkProduct(db, shopify, String(form.get("reference") ?? ""), "admin");
      return {
        ok: true,
        message: result.alreadyLinked
          ? `"${result.title}" was already linked; details refreshed.`
          : `Linked "${result.title}". Run its backfill next.`,
        warnings: result.warnings,
      };
    } catch (error) {
      return { ok: false, message: String((error as Error).message ?? error), warnings: [] };
    }
  }

  if (intent === "backfill") {
    const shopifyProductId = String(form.get("shopifyProductId"));
    // A backfill can take minutes, so it runs after this request returns.
    void backfillProduct(db, shopify, shopifyProductId, "admin").catch((error) =>
      console.error(`Backfill of product ${shopifyProductId} failed`, error),
    );
    return {
      ok: true,
      message: "Backfill started. Refresh this page in a minute or two to see the totals.",
      warnings: [],
    };
  }

  return { ok: false, message: "Unknown action", warnings: [] };
};

const OUTCOME_LABELS: Record<string, string> = {
  qualifying: "Qualifying",
  non_fundraiser: "Outside window",
  refunded_cancelled: "Refunded / cancelled",
  excluded: "Excluded",
  not_eligible: "Not paid",
  pending: "Pending",
};

export default function Index() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  return (
    <s-page heading="Fundraisers">
      {result && (
        <s-banner tone={result.ok ? (result.warnings.length ? "warning" : "success") : "critical"}>
          <s-paragraph>{result.message}</s-paragraph>
          {result.warnings.map((w) => (
            <s-paragraph key={w}>{w}</s-paragraph>
          ))}
        </s-banner>
      )}

      <s-section heading="Linked products">
        {data.products.length === 0 ? (
          <s-paragraph>No products linked yet. Link one below.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Product</s-table-header>
              <s-table-header>Tag</s-table-header>
              <s-table-header format="numeric">Ordered</s-table-header>
              <s-table-header format="numeric">Refunded / cancelled</s-table-header>
              <s-table-header format="numeric">Net units</s-table-header>
              <s-table-header format="numeric">In window</s-table-header>
              <s-table-header format="numeric">Outside window</s-table-header>
              <s-table-header>Backfill</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.products.map((p) => (
                <s-table-row key={p.id}>
                  <s-table-cell>
                    <s-stack gap="small-200">
                      <s-text>{p.title}</s-text>
                      <s-text color="subdued">
                        ID {p.shopifyProductId} · {p.status.toLowerCase()}
                      </s-text>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    {p.tagged ? (
                      <s-badge tone="success">fundraiser</s-badge>
                    ) : (
                      <s-badge tone="warning">Missing tag</s-badge>
                    )}
                  </s-table-cell>
                  <s-table-cell>{p.totals.orderedUnits}</s-table-cell>
                  <s-table-cell>{p.totals.refundedOrCancelledUnits}</s-table-cell>
                  <s-table-cell>{p.totals.netUnits}</s-table-cell>
                  <s-table-cell>{p.totals.inWindowUnits}</s-table-cell>
                  <s-table-cell>{p.totals.outsideWindowUnits}</s-table-cell>
                  <s-table-cell>
                    <s-stack gap="small-200">
                      <s-text color="subdued">
                        {p.lastBackfill
                          ? `${p.lastBackfill.action === "backfill" ? "Done" : "Incomplete"} ${pacific(p.lastBackfill.at)} · ${p.lastBackfill.result?.ordersFound ?? 0} orders` +
                            (p.lastBackfill.result?.failures?.length
                              ? ` · ${p.lastBackfill.result.failures.length} failed`
                              : "")
                          : "Not run"}
                      </s-text>
                      <Form method="post">
                        <input type="hidden" name="intent" value="backfill" />
                        <input type="hidden" name="shopifyProductId" value={p.shopifyProductId} />
                        <s-button type="submit" disabled={busy}>
                          Run backfill
                        </s-button>
                      </Form>
                    </s-stack>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
        <s-paragraph>
          <s-text color="subdued">
            Compare &ldquo;Net units&rdquo; with Shopify Analytics → Reports → Sales by product,
            &ldquo;Net items sold&rdquo;, for all time. Test orders are left out of these totals.
          </s-text>
        </s-paragraph>
      </s-section>

      <s-section heading="Link a product">
        <Form method="post">
          <input type="hidden" name="intent" value="link" />
          <s-stack gap="base">
            <s-text-field
              name="reference"
              label="Shopify product ID or product admin URL"
              placeholder="https://admin.shopify.com/store/…/products/1234567890"
              required
            />
            <s-button type="submit" variant="primary" disabled={busy}>
              Link product
            </s-button>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading="Recent order lines">
        {data.lines.length === 0 ? (
          <s-paragraph>No order lines saved yet.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Order</s-table-header>
              <s-table-header>Checkout (Pacific)</s-table-header>
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

      <s-section heading="Sync health">
        <s-paragraph>
          Last webhook: {pacific(data.webhooks.lastReceivedAt)} · Failed webhooks:{" "}
          {data.webhooks.failed}
        </s-paragraph>
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

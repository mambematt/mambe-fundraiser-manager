// Products: search Shopify by title and link team products; linked products'
// lifetime totals, team and backfill.
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { ResultBanner } from "../components/ResultBanner";
import { dollars, pacific } from "../lib/format";
import { attempt, formInt, formText } from "../services/actions.server";
import { alertError } from "../services/alerts.server";
import {
  backfillProduct,
  hasFundraiserTag,
  lifetimeTotalsForProduct,
  linkProduct,
  updateProductDetails,
} from "../services/products.server";
import { shopifyClientForShop } from "../services/shopify-client.server";
import { staffName } from "../services/staff.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";

  const [products, teams] = await Promise.all([
    db.product.findMany({ orderBy: { title: "asc" } }),
    db.team.findMany({ include: { organization: true }, orderBy: [{ organization: { name: "asc" } }, { name: "asc" }] }),
  ]);
  const linkedIds = new Set(products.map((p) => p.shopifyProductId));

  let results: Array<{ shopifyProductId: string; title: string; status: string; tagged: boolean; linked: boolean }> = [];
  if (q) {
    const shopify = await shopifyClientForShop(session.shop);
    results = (await shopify.searchProducts(q)).map((p) => ({
      shopifyProductId: p.shopifyProductId,
      title: p.title,
      status: p.status,
      tagged: hasFundraiserTag(p.tags),
      linked: linkedIds.has(p.shopifyProductId),
    }));
  }

  const rows = await Promise.all(
    products.map(async (p) => {
      const lastBackfill = await db.auditLog.findFirst({
        where: { entity: "product", entityId: String(p.id), action: { startsWith: "backfill" } },
        orderBy: { id: "desc" },
      });
      const result = lastBackfill?.after as { ordersFound?: number; failures?: unknown[] } | null;
      return {
        id: p.id,
        shopifyProductId: p.shopifyProductId,
        title: p.title,
        status: p.status,
        tagged: hasFundraiserTag(p.tags),
        teamId: p.teamId,
        designNotes: p.designNotes ?? "",
        backfill: lastBackfill
          ? `${lastBackfill.action === "backfill" ? "Done" : "Incomplete"} ${pacific(lastBackfill.createdAt)} · ${result?.ordersFound ?? 0} orders`
          : "Running or not run yet",
        totals: await lifetimeTotalsForProduct(db, p.shopifyProductId),
      };
    }),
  );

  return {
    q,
    results,
    products: rows,
    teams: teams.map((t) => ({ id: t.id, label: `${t.organization.name} – ${t.name}` })),
  };
};

function startBackfill(shop: string, shopifyProductId: string, actor: string) {
  // Can take minutes, so it runs after the response.
  void (async () => {
    const shopify = await shopifyClientForShop(shop);
    await backfillProduct(db, shopify, shopifyProductId, actor);
  })().catch((error) => alertError(error, `Backfill of product ${shopifyProductId} failed`));
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const actor = staffName(session);
  const form = await request.formData();
  const intent = formText(form, "intent");

  return attempt(async () => {
    if (intent === "link") {
      const shopify = await shopifyClientForShop(session.shop);
      const result = await linkProduct(db, shopify, formText(form, "shopifyProductId"), actor);
      if (result.alreadyLinked) {
        return { ok: true, message: `"${result.title}" was already linked; its details were refreshed.`, warnings: result.warnings };
      }
      startBackfill(session.shop, result.shopifyProductId, actor);
      return {
        ok: true,
        message: `Linked "${result.title}". Its order history is loading; refresh in a minute to see the totals.`,
        warnings: result.warnings,
      };
    }
    if (intent === "backfill") {
      startBackfill(session.shop, formText(form, "shopifyProductId"), actor);
      return { ok: true, message: "Backfill started. Refresh in a minute or two to see the totals." };
    }
    if (intent === "edit") {
      await updateProductDetails(
        db,
        Number(formText(form, "id")),
        { teamId: formInt(form, "teamId"), designNotes: formText(form, "designNotes") || null },
        actor,
      );
      return { ok: true, message: "Product saved." };
    }
    return { ok: false, message: "Unknown action." };
  });
};

export default function Products() {
  const { q, results, products, teams } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";

  return (
    <s-page heading="Products">
      <ResultBanner result={result} />

      <s-section heading="Link a team product">
        <Form method="get">
          <s-stack direction="inline" gap="base" alignItems="end">
            <s-search-field name="q" label="Search Shopify products by title" defaultValue={q} placeholder="Central High Lacrosse" />
            <s-button type="submit" disabled={busy}>Search</s-button>
          </s-stack>
        </Form>
        {q && results.length === 0 && <s-paragraph>No products match &ldquo;{q}&rdquo;.</s-paragraph>}
        {results.length > 0 && (
          <s-table>
            <s-table-header-row>
              <s-table-header>Product</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Tag</s-table-header>
              <s-table-header></s-table-header>
            </s-table-header-row>
            <s-table-body>
              {results.map((p) => (
                <s-table-row key={p.shopifyProductId}>
                  <s-table-cell>{p.title}</s-table-cell>
                  <s-table-cell>
                    {p.status === "ACTIVE" ? <s-badge tone="success">Active</s-badge> : <s-badge>{p.status.toLowerCase()}</s-badge>}
                  </s-table-cell>
                  <s-table-cell>
                    {p.tagged ? <s-badge tone="success">fundraiser</s-badge> : <s-badge tone="warning">Missing tag</s-badge>}
                  </s-table-cell>
                  <s-table-cell>
                    {p.linked ? (
                      <s-text color="subdued">Linked</s-text>
                    ) : p.status !== "ACTIVE" ? (
                      <s-text color="subdued">Must be active to link</s-text>
                    ) : (
                      <Form method="post">
                        <input type="hidden" name="intent" value="link" />
                        <input type="hidden" name="shopifyProductId" value={p.shopifyProductId} />
                        <s-button type="submit" variant="primary" disabled={busy}>Link</s-button>
                      </Form>
                    )}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading="Linked products">
        {products.length === 0 ? (
          <s-paragraph>No products linked yet.</s-paragraph>
        ) : (
          <s-stack gap="large">
            {products.map((p) => (
              <s-box key={p.id} padding="base" borderWidth="base" borderRadius="base">
                <s-stack gap="base">
                  <s-stack direction="inline" gap="small" alignItems="center">
                    <s-heading>{p.title}</s-heading>
                    {p.tagged ? <s-badge tone="success">fundraiser</s-badge> : <s-badge tone="warning">Missing tag</s-badge>}
                    <s-badge>{p.status.toLowerCase()}</s-badge>
                  </s-stack>
                  <s-text color="subdued">Shopify ID {p.shopifyProductId} · Backfill: {p.backfill}</s-text>
                  <s-text>
                    <s-text type="strong">Compare with Shopify Analytics (all time, test orders excluded):</s-text>{" "}
                    {p.totals.orderedUnits} items ordered · {p.totals.netUnits} net items sold ·{" "}
                    {dollars(p.totals.grossSalesCents)} gross sales · {dollars(p.totals.discountsCents)} discounts
                  </s-text>
                  <s-text color="subdued">
                    {p.totals.orders} orders ({p.totals.ordersOlderThan60Days} older than 60 days) ·{" "}
                    {p.totals.refundedOrCancelledUnits} units refunded/cancelled · In fundraiser windows{" "}
                    {p.totals.inWindowUnits} units, {dollars(p.totals.inWindowRevenueCents)} · Outside windows{" "}
                    {p.totals.outsideWindowUnits} units, {dollars(p.totals.outsideWindowRevenueCents)}
                  </s-text>
                  <Form method="post">
                    <input type="hidden" name="intent" value="edit" />
                    <input type="hidden" name="id" value={p.id} />
                    <s-stack direction="inline" gap="base" alignItems="end">
                      <s-select name="teamId" label="Team" value={p.teamId ? String(p.teamId) : ""}>
                        <s-option value="">No team yet</s-option>
                        {teams.map((t) => (
                          <s-option key={t.id} value={String(t.id)}>{t.label}</s-option>
                        ))}
                      </s-select>
                      <s-text-field name="designNotes" label="Design notes" defaultValue={p.designNotes} />
                      <s-button type="submit" disabled={busy}>Save</s-button>
                    </s-stack>
                  </Form>
                  <Form method="post">
                    <input type="hidden" name="intent" value="backfill" />
                    <input type="hidden" name="shopifyProductId" value={p.shopifyProductId} />
                    <s-button type="submit" variant="tertiary" disabled={busy}>Run backfill again</s-button>
                  </Form>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

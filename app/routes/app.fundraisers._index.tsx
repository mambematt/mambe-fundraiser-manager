import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { calendarDate, dollars } from "../lib/format";
import { isStatus, STATUS_LABELS, type FundraiserStatus } from "../lib/status";
import { storedTotals } from "../services/fundraisers.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const statusParam = new URL(request.url).searchParams.get("status") ?? "";
  const status = isStatus(statusParam) ? statusParam : null;
  const fundraisers = await db.fundraiser.findMany({
    where: status ? { status } : {},
    orderBy: [{ windowStart: "desc" }],
    include: { team: { include: { organization: true } }, product: true },
  });
  return {
    statusLabel: status ? STATUS_LABELS[status] : null,
    fundraisers: await Promise.all(
      fundraisers.map(async (f) => {
        const totals = await storedTotals(db, f);
        return {
          id: f.id,
          publicCode: f.publicCode,
          team: `${f.team.organization.name} – ${f.team.name}`,
          product: f.product.title,
          dates: `${calendarDate(f.startDate)} – ${calendarDate(f.endDate)}`,
          status: STATUS_LABELS[f.status as FundraiserStatus] ?? f.status,
          units: totals.qualifyingUnits,
          payout: dollars(totals.estimatedPayoutCents),
        };
      }),
    ),
  };
};

export default function Fundraisers() {
  const { fundraisers, statusLabel } = useLoaderData<typeof loader>();
  return (
    <s-page heading={statusLabel ? `Fundraisers: ${statusLabel}` : "Fundraisers"}>
      <s-button slot="primary-action" variant="primary" href="/app/fundraisers/new">
        New fundraiser
      </s-button>
      <s-section>
        {statusLabel && (
          <s-paragraph>
            Showing {statusLabel} only. <s-link href="/app/fundraisers">Show all</s-link>
          </s-paragraph>
        )}
        {fundraisers.length === 0 ? (
          <s-paragraph>No fundraisers yet.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Code</s-table-header>
              <s-table-header>Team</s-table-header>
              <s-table-header>Dates</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header format="numeric">Units (estimated)</s-table-header>
              <s-table-header format="currency">Payout (estimated)</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {fundraisers.map((f) => (
                <s-table-row key={f.id}>
                  <s-table-cell>
                    <s-link href={`/app/fundraisers/${f.id}`}>{f.publicCode}</s-link>
                  </s-table-cell>
                  <s-table-cell>{f.team}</s-table-cell>
                  <s-table-cell>{f.dates}</s-table-cell>
                  <s-table-cell>{f.status}</s-table-cell>
                  <s-table-cell>{f.units}</s-table-cell>
                  <s-table-cell>{f.payout}</s-table-cell>
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

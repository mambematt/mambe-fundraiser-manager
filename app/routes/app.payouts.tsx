// Every payout with its status, and the CSV for the accountant.
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { CsvDownload } from "../components/CsvDownload";
import { calendarDate, dollars } from "../lib/format";
import { accountantCsv, type AccountantRow } from "../lib/payout-files";
import { payoutSummary } from "../services/settlement.server";

async function rows(): Promise<Array<AccountantRow & { fundraiserId: number }>> {
  const payouts = await db.payout.findMany({
    include: { fundraiser: { include: { team: { include: { organization: true } } } } },
    orderBy: { createdAt: "desc" },
  });
  return Promise.all(
    payouts.map(async (p) => {
      const s = await payoutSummary(db, p.id);
      return {
        fundraiserId: p.fundraiserId,
        publicCode: p.fundraiser.publicCode,
        organization: p.fundraiser.team.organization.name,
        team: p.fundraiser.team.name,
        payeeEmail: p.status === "draft" ? p.fundraiser.paypalPayeeEmail : p.payeeEmail,
        units: s.units,
        rateCents: s.rateCents,
        calculatedCents: s.amountCents,
        adjustmentsCents: s.adjustmentsCents,
        finalCents: s.finalCents,
        status: p.status,
        approvedDate: p.approvedAt ? calendarDate(p.approvedAt) : null,
        paidDate: p.paidAt ? calendarDate(p.paidAt) : null,
        paidAmountCents: p.paidAmountCents,
        paypalReference: p.paypalReference,
      };
    }),
  );
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return { payouts: await rows() };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  return { ok: true, message: "", csv: accountantCsv(await rows()) };
};

const STATUS: Record<string, string> = { draft: "Draft (estimated)", approved: "Approved", paid: "Paid" };

export default function Payouts() {
  const { payouts } = useLoaderData<typeof loader>();
  return (
    <s-page heading="Payouts">
      <s-section>
        <s-stack gap="base">
          <CsvDownload intent="export" filename={`mambe-payouts-${new Date().toISOString().slice(0, 10)}.csv`} label="Download CSV for the accountant" />
          {payouts.length === 0 ? (
            <s-paragraph>No payouts yet. Drafts appear 10 days after a fundraiser ends.</s-paragraph>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-header>Fundraiser</s-table-header>
                <s-table-header>Organization</s-table-header>
                <s-table-header>Status</s-table-header>
                <s-table-header format="numeric">Units</s-table-header>
                <s-table-header format="currency">Final</s-table-header>
                <s-table-header>Approved</s-table-header>
                <s-table-header>Paid</s-table-header>
                <s-table-header>PayPal ref</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {payouts.map((p) => (
                  <s-table-row key={p.publicCode}>
                    <s-table-cell>
                      <s-link href={`/app/fundraisers/${p.fundraiserId}#payout`}>{p.publicCode}</s-link>
                    </s-table-cell>
                    <s-table-cell>{p.organization}</s-table-cell>
                    <s-table-cell>{STATUS[p.status] ?? p.status}</s-table-cell>
                    <s-table-cell>{p.units}</s-table-cell>
                    <s-table-cell>{dollars(p.finalCents)}</s-table-cell>
                    <s-table-cell>{p.approvedDate ?? "—"}</s-table-cell>
                    <s-table-cell>{p.paidDate ?? "—"}</s-table-cell>
                    <s-table-cell>{p.paypalReference ?? "—"}</s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

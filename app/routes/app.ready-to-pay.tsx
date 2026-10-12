// Ready to pay: every approved, unpaid payout, the PayPal bulk file, and a
// link to record each payment.
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { CsvDownload } from "../components/CsvDownload";
import { calendarDate, dollars } from "../lib/format";
import { paypalPayoutsCsv } from "../lib/payout-files";
import { writeAudit } from "../services/audit.server";
import { staffName } from "../services/staff.server";

async function approvedPayouts() {
  return db.payout.findMany({
    where: { status: "approved" },
    include: { fundraiser: { include: { team: { include: { organization: true } } } } },
    orderBy: { approvedAt: "asc" },
  });
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const payouts = await approvedPayouts();
  return {
    totalCents: payouts.reduce((sum, p) => sum + (p.finalCents ?? 0), 0),
    payouts: payouts.map((p) => ({
      id: p.id,
      fundraiserId: p.fundraiserId,
      publicCode: p.fundraiser.publicCode,
      organization: `${p.fundraiser.team.organization.name} – ${p.fundraiser.team.name}`,
      payeeEmail: p.payeeEmail ?? "",
      finalCents: p.finalCents ?? 0,
      approvedAt: p.approvedAt?.toISOString() ?? null,
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const selected = new Set(form.getAll("payoutId").map(Number));
  const payouts = (await approvedPayouts()).filter((p) => selected.has(p.id));
  if (payouts.length === 0) return { ok: false, message: "Choose at least one payout." };
  const missing = payouts.filter((p) => !p.payeeEmail);
  if (missing.length) return { ok: false, message: `No payee email on ${missing.map((p) => p.fundraiser.publicCode).join(", ")}.` };
  const csv = paypalPayoutsCsv(payouts.map((p) => ({ payeeEmail: p.payeeEmail!, amountCents: p.finalCents ?? 0, publicCode: p.fundraiser.publicCode })));
  await writeAudit(db, {
    entity: "payouts",
    entityId: payouts.map((p) => p.id).join(","),
    action: "paypal_file",
    after: { payouts: payouts.map((p) => ({ code: p.fundraiser.publicCode, finalCents: p.finalCents })) },
    actor: staffName(session),
  });
  return { ok: true, message: "", csv };
};

export default function ReadyToPay() {
  const { payouts, totalCents } = useLoaderData<typeof loader>();
  return (
    <s-page heading="Ready to pay">
      <s-section>
        <s-stack gap="base">
          <s-heading>
            {payouts.length} approved payout{payouts.length === 1 ? "" : "s"} · {dollars(totalCents)}
          </s-heading>
          {payouts.length === 0 ? (
            <s-paragraph>Nothing to pay. Approved payouts appear here.</s-paragraph>
          ) : (
            <>
              <s-table>
                <s-table-header-row>
                  <s-table-header>Fundraiser</s-table-header>
                  <s-table-header>Organization</s-table-header>
                  <s-table-header>Payee (PayPal)</s-table-header>
                  <s-table-header format="currency">Amount</s-table-header>
                  <s-table-header>Approved</s-table-header>
                  <s-table-header></s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {payouts.map((p) => (
                    <s-table-row key={p.id}>
                      <s-table-cell>{p.publicCode}</s-table-cell>
                      <s-table-cell>{p.organization}</s-table-cell>
                      <s-table-cell>{p.payeeEmail}</s-table-cell>
                      <s-table-cell>{dollars(p.finalCents)}</s-table-cell>
                      <s-table-cell>{calendarDate(p.approvedAt)}</s-table-cell>
                      <s-table-cell>
                        <s-link href={`/app/fundraisers/${p.fundraiserId}#payout`}>Record payment</s-link>
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
              <CsvDownload
                intent="paypal"
                fields={{ payoutId: payouts.map((p) => String(p.id)) }}
                filename={`mambe-paypal-payouts-${new Date().toISOString().slice(0, 10)}.csv`}
                label={`Download PayPal file for all ${payouts.length} (${dollars(totalCents)})`}
              />
            </>
          )}
          <s-paragraph>
            <s-text color="subdued">
              Before paying: take a manual backup in Render (mambe-fundraisers-db → Recovery → Logical backups → Create backup).
              Then upload the file in PayPal: Business Tools → Make Payments → Payouts (needs Payouts access on your PayPal Business
              account). Mambe pays any PayPal fee, so each row is the full amount. After PayPal sends, record each payment with its
              transaction ID on the fundraiser&apos;s page; that marks it Paid.
            </s-text>
          </s-paragraph>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

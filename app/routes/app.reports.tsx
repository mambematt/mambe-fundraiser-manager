// Reports (spec "V1 reports"): fixed tables, each with a CSV, plus the
// weekly payout backup's status.
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { CsvDownload } from "../components/CsvDownload";
import { ResultBanner } from "../components/ResultBanner";
import { dollars, pacific } from "../lib/format";
import { attempt, formText, type ActionResult } from "../services/actions.server";
import { BACKUP_JOB, runPayoutBackup } from "../services/backups.server";
import { createDriveClient, driveOrThrow } from "../services/drive.server";
import { buildReports, ordersByFundraiser, reportCsv, type Cell, type ReportTable } from "../services/reports.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const [tables, lastBackup, lastGoodBackup] = await Promise.all([
    buildReports(db),
    db.jobRun.findFirst({ where: { name: BACKUP_JOB }, orderBy: { startedAt: "desc" } }),
    db.jobRun.findFirst({ where: { name: BACKUP_JOB, status: "succeeded" }, orderBy: { startedAt: "desc" } }),
  ]);
  let driveConfigured = false;
  try {
    driveConfigured = !!createDriveClient();
  } catch {
    driveConfigured = false;
  }
  return {
    tables,
    asOf: new Date().toISOString(),
    backup: {
      driveConfigured,
      last: lastBackup ? { at: lastBackup.startedAt.toISOString(), status: lastBackup.status, error: lastBackup.error } : null,
      lastGood: lastGoodBackup ? { at: lastGoodBackup.startedAt.toISOString(), file: (lastGoodBackup.details as { file?: string } | null)?.file ?? "" } : null,
    },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const form = await request.formData();
  const intent = formText(form, "intent");
  return attempt(async (): Promise<ActionResult & { csv?: string }> => {
    if (intent === "csv" && formText(form, "table") === "orders-by-fundraiser") {
      const shop = (await db.session.findFirst({ where: { isOnline: false } }))?.shop ?? null;
      return { ok: true, message: "", csv: reportCsv(await ordersByFundraiser(db, shop)) };
    }
    if (intent === "csv") {
      const table = (await buildReports(db)).find((t) => t.key === formText(form, "table"));
      if (!table) return { ok: false, message: "Unknown report." };
      return { ok: true, message: "", csv: reportCsv(table) };
    }
    if (intent === "backupNow") {
      const result = await runPayoutBackup(db, driveOrThrow());
      return result.ok
        ? { ok: true, message: `Backed up ${result.payouts} payout${result.payouts === 1 ? "" : "s"} to Drive _Backups as ${result.file}.` }
        : { ok: false, message: `Backup failed: ${result.error}` };
    }
    return { ok: false, message: "Unknown action." };
  });
};

function show(value: Cell, kind: string): string {
  if (value === null) return "";
  return kind === "money" && typeof value === "number" ? dollars(value) : String(value);
}

function Table({ table }: { table: ReportTable }) {
  return (
    <s-section heading={table.title}>
      <s-stack gap="base">
        {table.note && <s-text color="subdued">{table.note}</s-text>}
        {table.rows.length === 0 ? (
          <s-paragraph>Nothing yet.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              {table.columns.map((c) => (
                <s-table-header key={c.label} format={c.kind === "money" ? "currency" : c.kind === "number" ? "numeric" : undefined}>
                  {c.label}
                </s-table-header>
              ))}
            </s-table-header-row>
            <s-table-body>
              {table.rows.map((row, i) => (
                <s-table-row key={i}>
                  {row.map((cell, j) => (
                    <s-table-cell key={j}>{show(cell, table.columns[j]!.kind)}</s-table-cell>
                  ))}
                </s-table-row>
              ))}
              {table.totals && (
                <s-table-row>
                  {table.totals.map((cell, j) => (
                    <s-table-cell key={j}>
                      <s-text type="strong">{show(cell, table.columns[j]!.kind)}</s-text>
                    </s-table-cell>
                  ))}
                </s-table-row>
              )}
            </s-table-body>
          </s-table>
        )}
        <s-stack direction="inline" gap="base">
          <CsvDownload intent="csv" fields={{ table: table.key }} filename={`mambe-${table.key}-${new Date().toISOString().slice(0, 10)}.csv`} label="Download CSV" />
          {table.key === "raised-by-fundraiser" && (
            <CsvDownload
              intent="csv"
              fields={{ table: "orders-by-fundraiser" }}
              filename={`mambe-orders-by-fundraiser-${new Date().toISOString().slice(0, 10)}.csv`}
              label="Download the orders behind it (CSV)"
            />
          )}
        </s-stack>
      </s-stack>
    </s-section>
  );
}

export default function Reports() {
  const { tables, asOf, backup } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  return (
    <s-page heading="Reports">
      <ResultBanner result={result} />
      <s-section heading="Weekly payout backup">
        <s-stack gap="small">
          <s-paragraph>
            Every Monday the accountant payout CSV is saved to Drive in Fundraising/_Backups, named with the date.{" "}
            {!backup.driveConfigured && "Drive isn't set up on this service yet, so it doesn't run."}
          </s-paragraph>
          <s-paragraph>
            Last good backup: {backup.lastGood ? `${pacific(backup.lastGood.at)} (${backup.lastGood.file})` : "none yet"}
            {backup.last?.status === "failed" ? ` · Last try failed ${pacific(backup.last.at)}: ${backup.last.error}` : ""}
          </s-paragraph>
          {backup.driveConfigured && (
            <Form method="post">
              <input type="hidden" name="intent" value="backupNow" />
              <s-button type="submit" disabled={busy}>Back up now</s-button>
            </Form>
          )}
        </s-stack>
      </s-section>
      <s-paragraph>
        <s-text color="subdued">As of {pacific(asOf)}.</s-text>
      </s-paragraph>
      {tables.map((t) => (
        <Table key={t.key} table={t} />
      ))}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

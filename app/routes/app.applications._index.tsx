// Applications from the storefront form, newest first. Spam is hidden unless asked for.
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { pacific } from "../lib/format";
import { applicationEmailsEnabled } from "../services/applications.server";

const TABS = [
  { key: "new", label: "New" },
  { key: "converted", label: "Converted" },
  { key: "declined", label: "Declined" },
  { key: "spam", label: "Spam" },
  { key: "all", label: "All but spam" },
] as const;

const STATUS_TONE: Record<string, "info" | "success" | "critical" | "neutral"> = {
  new: "info",
  converted: "success",
  declined: "neutral",
  spam: "critical",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const param = new URL(request.url).searchParams.get("status") ?? "new";
  const tab = TABS.find((t) => t.key === param)?.key ?? "new";
  const [applications, counts] = await Promise.all([
    db.application.findMany({
      where: tab === "all" ? { status: { not: "spam" } } : { status: tab },
      include: { emails: true, convertedFundraiser: { select: { publicCode: true } } },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    db.application.groupBy({ by: ["status"], _count: true }),
  ]);
  return {
    tab,
    emailsOn: applicationEmailsEnabled(),
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count])) as Record<string, number>,
    applications: applications.map((a) => ({
      id: a.id,
      at: a.createdAt.toISOString(),
      name: a.name ?? "",
      email: a.email ?? "",
      organization: a.organizationName ?? "",
      team: a.teamName ?? "",
      place: [a.city, a.state].filter(Boolean).join(", "),
      timing: a.roughTiming ?? "",
      status: a.status,
      fundraiser: a.convertedFundraiser?.publicCode ?? null,
      emailProblem: a.emails.some((e) => e.status === "failed" || (e.status === "pending" && e.attempts > 0)),
    })),
  };
};

export default function Applications() {
  const { applications, tab, counts, emailsOn } = useLoaderData<typeof loader>();
  return (
    <s-page heading="Applications">
      <s-section>
        <s-stack gap="base">
          <s-stack direction="inline" gap="small">
            {TABS.map((t) => (
              <s-button key={t.key} href={`/app/applications?status=${t.key}`} variant={tab === t.key ? "primary" : "secondary"}>
                {t.label}
                {t.key !== "all" ? ` (${counts[t.key] ?? 0})` : ""}
              </s-button>
            ))}
          </s-stack>
          <s-text color="subdued">
            Application emails (applicant + internal): {emailsOn ? "on" : "off (APPLICATION_EMAILS_ENABLED in Render)"}.
          </s-text>
          {applications.length === 0 ? (
            <s-paragraph>None here.</s-paragraph>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-header>Received (Pacific)</s-table-header>
                <s-table-header>Applicant</s-table-header>
                <s-table-header>Organization · team</s-table-header>
                <s-table-header>Where</s-table-header>
                <s-table-header>Timing</s-table-header>
                <s-table-header>Status</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {applications.map((a) => (
                  <s-table-row key={a.id}>
                    <s-table-cell>
                      <s-link href={`/app/applications/${a.id}`}>{pacific(a.at)}</s-link>
                    </s-table-cell>
                    <s-table-cell>
                      {a.name} · {a.email}
                    </s-table-cell>
                    <s-table-cell>
                      {a.organization} · {a.team}
                    </s-table-cell>
                    <s-table-cell>{a.place}</s-table-cell>
                    <s-table-cell>{a.timing}</s-table-cell>
                    <s-table-cell>
                      <s-badge tone={STATUS_TONE[a.status] ?? "neutral"}>{a.status}</s-badge>
                      {a.fundraiser ? ` → ${a.fundraiser}` : ""}
                      {a.emailProblem ? " · email failed" : ""}
                    </s-table-cell>
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

// The organizer's home: their fundraisers (a single current one opens directly).
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useLoaderData } from "react-router";
import db from "../db.server";
import { PortalLayout } from "../components/PortalLayout";
import { STATUS_LABELS, type FundraiserStatus } from "../lib/status";
import { fundraisersForOrganizer, logVisit, sessionOrganizerId } from "../services/portal.server";
import { readCookie, SESSION_COOKIE } from "../services/portal-http.server";

export const meta: MetaFunction = () => [{ title: "Your fundraisers · Mambe" }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const organizerId = await sessionOrganizerId(db, readCookie(request, SESSION_COOKIE));
  if (!organizerId) throw redirect("/portal/login?reason=signin");
  const list = await fundraisersForOrganizer(db, organizerId);
  const current = list.filter((f) => !["paid", "cancelled"].includes(f.status));
  if (current.length === 1) throw redirect(`/portal/f/${current[0]!.id}`);
  if (list.length === 1) throw redirect(`/portal/f/${list[0]!.id}`);
  await logVisit(db, organizerId, null);
  return {
    fundraisers: list.map((f) => ({
      id: f.id,
      name: `${f.team.organization.name} – ${f.team.name}`,
      season: f.seasonLabel ?? "",
      status: STATUS_LABELS[f.status as FundraiserStatus] ?? f.status,
    })),
  };
};

export default function PortalHome() {
  const { fundraisers } = useLoaderData<typeof loader>();
  return (
    <PortalLayout signedIn>
      <h1>Your fundraisers</h1>
      {fundraisers.length === 0 && <p className="muted">No fundraisers are linked to your email yet.</p>}
      {fundraisers.map((f) => (
        <a key={f.id} href={`/portal/f/${f.id}`} style={{ textDecoration: "none", color: "inherit" }}>
          <div className="card">
            <span className="badge">{f.status}</span>
            <h2 style={{ marginTop: 8 }}>{f.name}</h2>
            <div className="muted">{f.season}</div>
          </div>
        </a>
      ))}
    </PortalLayout>
  );
}

// One fundraiser in the portal. Scoped: only fundraisers linked to the
// signed-in organizer are ever returned (anything else is "not found").
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useLoaderData } from "react-router";
import QRCode from "qrcode";
import db from "../db.server";
import { PortalLayout } from "../components/PortalLayout";
import { PortalFundraiserView } from "../components/PortalFundraiserView";
import { fundraisersForOrganizer, logVisit, portalView } from "../services/portal.server";
import { currentOrganizerId } from "../services/portal-http.server";

export const meta: MetaFunction = () => [{ title: "Your fundraiser · Mambe" }];

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const organizerId = await currentOrganizerId(db, request);
  if (!organizerId) throw redirect("/portal/login?reason=signin");
  const view = await portalView(db, Number(params.id), organizerId);
  if (!view) throw new Response("Not found", { status: 404 });
  await logVisit(db, organizerId, view.id);
  const others = (await fundraisersForOrganizer(db, organizerId)).filter((f) => f.id !== view.id);
  const qrSvg = view.shortLink ? await QRCode.toString(view.shortLink, { type: "svg", margin: 1 }) : null;
  return {
    view,
    qrSvg,
    now: new Date().toISOString(),
    past: others.map((f) => ({ id: f.id, label: `${f.seasonLabel ?? f.publicCode} · ${f.team.name}` })),
  };
};

export default function PortalFundraiser() {
  const { view, qrSvg, now, past } = useLoaderData<typeof loader>();
  return (
    <PortalLayout signedIn>
      <PortalFundraiserView view={view} qrSvg={qrSvg} now={now} />
      {past.length > 0 && (
        <div className="card">
          <h2>Your other fundraisers</h2>
          {past.map((p) => (
            <div key={p.id}>
              <a href={`/portal/f/${p.id}`}>{p.label}</a>
            </div>
          ))}
        </div>
      )}
    </PortalLayout>
  );
}

export function ErrorBoundary() {
  return (
    <PortalLayout>
      <div className="card">
        <h1>Not found</h1>
        <p className="muted">
          That fundraiser isn&apos;t linked to your email. <a href="/portal">Back to your fundraisers</a>
        </p>
      </div>
    </PortalLayout>
  );
}

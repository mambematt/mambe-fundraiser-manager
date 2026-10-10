// "Open portal as organizer": a read-only preview inside admin. No session is created.
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import QRCode from "qrcode";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { PORTAL_CSS } from "../components/PortalLayout";
import { PortalFundraiserView } from "../components/PortalFundraiserView";
import { portalView } from "../services/portal.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const view = await portalView(db, Number(params.id), null);
  if (!view) throw new Response("Not found", { status: 404 });
  const qrSvg = view.shortLink ? await QRCode.toString(view.shortLink, { type: "svg", margin: 1 }) : null;
  return { view, qrSvg, now: new Date().toISOString() };
};

export default function PortalPreview() {
  const { view, qrSvg, now } = useLoaderData<typeof loader>();
  return (
    <s-page heading={`Portal preview · ${view.publicCode}`}>
      <s-link slot="breadcrumb-actions" href={`/app/fundraisers/${view.id}`}>Back to fundraiser</s-link>
      <style>{PORTAL_CSS}</style>
      <div className="wrap">
        <PortalFundraiserView view={view} qrSvg={qrSvg} now={now} preview />
      </div>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

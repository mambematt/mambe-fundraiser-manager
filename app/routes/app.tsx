import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useLocation, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import { APP_TITLE, sectionTitle } from "../lib/page-title";

// The font Shopify admin and the Polaris components use.
const ADMIN_FONT = "var(--p-font-family-sans, Inter, -apple-system, BlinkMacSystemFont, 'San Francisco', 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif)";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

/** Black bar with "Fundraiser Manager - {section}" above every admin page (owner request). */
function TitleBar() {
  const { pathname } = useLocation();
  return (
    <div style={{ padding: "1rem 1rem 0" }}>
      <div
        style={{
          maxWidth: "62.375rem",
          margin: "0 auto",
          background: "#000",
          color: "#fff",
          textAlign: "center",
          textTransform: "uppercase",
          fontFamily: ADMIN_FONT,
          fontWeight: 700,
          fontSize: "1.5rem",
          letterSpacing: "0.02em",
          padding: "0.55rem 1rem",
          borderRadius: "0.25rem",
        }}
      >
        {APP_TITLE} - <span style={{ fontStyle: "italic" }}>{sectionTitle(pathname)}</span>
      </div>
    </div>
  );
}

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Home</s-link>
        <s-link href="/app/fundraisers">Fundraisers</s-link>
        <s-link href="/app/applications">Applications</s-link>
        <s-link href="/app/ready-to-pay">Ready to pay</s-link>
        <s-link href="/app/payouts">Payouts</s-link>
        <s-link href="/app/organizations">Organizations &amp; teams</s-link>
        <s-link href="/app/organizers">Organizers</s-link>
        <s-link href="/app/products">Products</s-link>
        <s-link href="/app/reports">Reports</s-link>
      </s-app-nav>
      <TitleBar />
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

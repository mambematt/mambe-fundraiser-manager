import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

// The app's public front door: Shopify's install flow passes ?shop=…;
// everyone else (organizers on fundraise.mambeblankets.com) goes to the portal.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) throw redirect(`/app?${url.searchParams.toString()}`);
  throw redirect("/portal");
};

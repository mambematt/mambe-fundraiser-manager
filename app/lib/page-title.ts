// The black title bar at the top of every admin page: "Fundraiser Manager -
// {section}", where the section matches the app's left menu. Detail pages show
// their section (a fundraiser's own code is the page heading below the bar).

export const APP_TITLE = "Fundraiser Manager";

const SECTIONS: Array<[prefix: string, title: string]> = [
  ["/app/fundraisers", "Fundraisers"],
  ["/app/applications", "Applications"],
  ["/app/ready-to-pay", "Ready to pay"],
  ["/app/payouts", "Payouts"],
  ["/app/organizations", "Organizations & teams"],
  ["/app/organizers", "Organizers"],
  ["/app/products", "Products"],
  ["/app/reports", "Reports"],
];

export function sectionTitle(pathname: string): string {
  const path = pathname.replace(/\/+$/, "");
  return SECTIONS.find(([prefix]) => path === prefix || path.startsWith(`${prefix}/`))?.[1] ?? "Home";
}

export function pageTitle(pathname: string): string {
  return `${APP_TITLE} - ${sectionTitle(pathname)}`;
}

import { describe, expect, test } from "vitest";
import { pageTitle } from "../../app/lib/page-title";

describe("admin title bar", () => {
  test.each([
    ["/app", "Fundraiser Manager - Home"],
    ["/app/", "Fundraiser Manager - Home"],
    ["/app/fundraisers", "Fundraiser Manager - Fundraisers"],
    ["/app/fundraisers/12", "Fundraiser Manager - Fundraisers"],
    ["/app/fundraisers/12/preview", "Fundraiser Manager - Fundraisers"],
    ["/app/fundraisers/new", "Fundraiser Manager - Fundraisers"],
    ["/app/applications/3", "Fundraiser Manager - Applications"],
    ["/app/ready-to-pay", "Fundraiser Manager - Ready to pay"],
    ["/app/payouts", "Fundraiser Manager - Payouts"],
    ["/app/organizations/4", "Fundraiser Manager - Organizations & teams"],
    ["/app/organizers", "Fundraiser Manager - Organizers"],
    ["/app/products", "Fundraiser Manager - Products"],
    ["/app/reports", "Fundraiser Manager - Reports"],
  ])("%s → %s", (path, title) => {
    expect(pageTitle(path)).toBe(title);
  });
});

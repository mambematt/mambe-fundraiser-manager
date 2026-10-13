# Session 6 summary: application form, Drive folders, reports

Completed Oct 12, 2026. Prompt: `docs/session-6-build-prompt.md`. Spec: `docs/SPEC.md`.

## Done criteria (all met)
1. **Staging form.** The owner submitted the form on the dev store from a phone:
   - the application appeared in the admin
   - "Application Received" and "New Application" arrived at the test inbox, and the admin link in the internal email opened the application
   - a fast, scripted submission (filled and sent in under 3 seconds from the browser console) saw the normal thank-you but was not saved and sent no email
2. **Staging accept.**
   - **Create-new path:** a first application, "School of hard knocks / Triathlons", created the organization, team and fundraiser.
   - **Matching path:** a second application, "Hard Knocks School / Triathlons", same city and state, same email:
     - the accept box suggested the existing organization and team (similar name, same city, same state)
     - the existing organizer (same email) was reused
     - the fundraiser was created in Setup, and Drive reused the organization, team and _Product & Artwork folders and added a second season folder
     - "Drive folders created" ticked itself both times
     - no duplicate records or folders
3. **Production Drive.** "Create Drive folders" on NS-GSB-F26 made Fundraising → Nazareth Softball → Girls Softball → _Product & Artwork and 2026 Fall (Organizer Assets, Internal). The checklist ticked itself.
4. **Production reports.** The Reports page shows NS-GSB-F26's real numbers, and the CSVs download.
5. **Tests.** 215 pass in GitHub Actions; all 24 spec cases are unchanged. Render deploys production only after the Tests check passes.
6. **Live form.**
   - The form is published at **mambeblankets.com/pages/fundraise**.
   - `APPLICATION_EMAILS_ENABLED=true` is set on production.
   - A real test application delivered both emails to matt@mambeblankets.com (after the de-duplication fix below), and the owner marked it as spam.

## Part 0 answers (owner)
- **Google Drive:** the Workspace answer turned out to be wrong. **Mambe has no Google Workspace.**
  - matt@mambeblankets.com is a free Google account that uses the company email address; email runs on Microsoft 365.
  - With no shared drives, the service-account plan can't work.
  - **Owner decision:** the app signs in as matt@mambeblankets.com (OAuth) with the `drive.file` scope only. It can see nothing in Drive except the folders and files it created.
  - Owner question, answered: Workspace is worth considering for company-owned "business brain" storage. But Microsoft 365 already includes SharePoint and OneDrive, so it's a separate decision. Moving this app to Workspace later is about an hour's work plus moving the folder.
- **Form location:** a regular Shopify page at `/pages/fundraise` (not EComposer), using the theme app block "Fundraiser application" on a `fundraise` page template. Live: **https://mambeblankets.com/pages/fundraise**
- **Internal notification address:** matt@mambeblankets.com (`APPLICATION_NOTIFY_EMAIL`).
- **Response time:** within 2 business days. The thank-you reads: "We received your application, and we'll be in touch within 2 business days. Thanks." (wording changed at the owner's request; the intro line hides after submitting).
- **Product and dates on accept (owner decision):** both are optional while in Setup, and launch requires both. Settlement and payout files got type-level guards only; all 24 cases are unchanged.

## What was built
**Product and dates optional in Setup**
- `fundraisers.product_id`, the dates and the window are nullable. A database check keeps dates and window all set or all empty. The overlap constraint ignores fundraisers without a product or window.
- **Launch gate:** "No product is linked yet." / "Start and end dates aren't set."
- **Fundraiser page:**
  - "Link the product" picker (Setup only; live products, unclaimed or this team's)
  - "Set dates and rate" (no reason needed the first time; changing dates still needs one)
- **Behavior without a window:**
  - it never claims a sale, never overlaps, and has no payout section
  - the portal shows "To be set"
  - it can't be cancelled (nothing to settle), so Decline is the way out
- `app/lib/launched.ts` states "a launched fundraiser has product and dates" for the type checker. In settlement (`settlement.server.ts`, `crosscheck.server.ts`, `payout-view.server.ts`) these are the only edits: no logic change.

**Application form and endpoint**
- The theme app block posts to `/apps/fundraise/apply` through Shopify **App Proxy**. `app_proxy` is configured in both app tomls, pointing at `/proxy/apply`.
- **Request checks:**
  - The server checks the App Proxy signature: unsigned, tampered or older than 10 minutes is refused (401).
  - Required fields are checked in the browser and again on the server.
- **Spam handling** (quiet: the sender sees the thank-you, nothing is saved):
  - honeypot field
  - submitted under 3 seconds after the page opened
  - rate limits: 3 per hour per email, 5 per hour per IP, stored as hashes
  - The IP is used only when Shopify forwards the visitor's address.
- **Save first:** the application and its two email rows are saved in one transaction; Klaviyo is tried afterwards.

**Application emails**
- Klaviyo metrics **Application Received** (to the applicant: transactional, not added to the organizer list) and **New Application** (to matt@mambeblankets.com, with an admin link).
- Global switch `APPLICATION_EMAILS_ENABLED`: staging `true` (all mail goes to `KLAVIYO_TEST_RECIPIENT`); production `true` since done item 6.
- **Failures:**
  - A failed send retries every 15 minutes (the clock).
  - After 3 tries it's marked failed, with a Sentry alert and a Retry button.
  - The work queue shows "Application emails failing".

**Applications admin** (new nav item "Applications")
- **List:** newest first, with tabs New / Converted / Declined / Spam / All but spam.
- **Application page:**
  - what they sent, both email statuses, and History
  - **Mark as spam:** no reason; drops unsent emails
  - **Decline:** reason required; no email (reply from Outlook)
  - **Accept and create fundraiser:**
    - one choice covers organization and team: suggestions first, then create new, then every other organization
    - the existing organizer (exact email) is used when ticked; otherwise one is created
    - the type is needed for a new organization
- **What Accept creates:**
  - the fundraiser in **Setup** with no product or dates
  - notes with "From application #N. Timing: … Logo: … Applicant notes: …"
  - the season label from the timing (for example "Spring 2027")
  - the link to the application (`converted_fundraiser_id`), audited throughout
  - the Drive folders
- **Matching:** organizations by shared distinctive words (ignoring "High School", "Boosters", "Club" and similar), ranked up for the same city and state. Teams by similar name within the chosen organization. Organizers by exact email.
- **Application status:** nothing creates it any more, and the new-fundraiser page never offered it. It's kept in `status.ts` (marked legacy) so any old record still shows and can be approved or declined. "Applications to review" on Home links to Applications.

**Google Drive**
- **Tree:** Fundraising/{Organization}/{Team}/(_Product & Artwork, {Year Season}/(Organizer Assets, Internal)), with each folder's ID stored as soon as it's created.
- **No duplicates:** folders are reused by stored ID, never looked up by name. Running it twice does nothing new, and a retry carries on where it stopped.
- **Season folder name:**
  - "2026 Fall": from the season label, else the start date, else today
  - a second fundraiser for the same team and season adds its code
- **When it runs:** on Accept, and from **Create Drive folders** on any fundraiser.
- **On success:** "Drive folders created" ticks itself, and the page shows Open in Drive links.
- **On failure:** a red "Drive folders: failed (Retry)", a Retry button, a Sentry alert and a work-queue item; nothing else is blocked.
- **No sharing.**

**Reports** (new nav item "Reports"; each table has a CSV)
1. Fundraisers by status.
2. Qualifying units and $ raised, by fundraiser, by team and by organization. Uses the frozen payout numbers once approved or paid, estimates before that; declined fundraisers are left out.
   - **Added at the owner's request:** "Download the orders behind it (CSV)", with one row per order line for each fundraiser: counted lines plus that product's sales within 30 days outside the window.
   - Columns: order number, checkout time, quantity, refunded, units counted, outcome, line price, discount codes, flags, your decision, and a link that opens the order in Shopify admin.
   - **No customer names** (the spec's privacy rule). The owner chose this over fetching last names.
3. Payouts: draft, approved, outstanding and paid, with totals (paid uses the amount actually sent).
4. Per product: lifetime net units, in-window units and revenue, outside-window units and revenue.
5. Repeat rate: teams with more than one fundraiser out of all teams with one, with the list.
6. Sales after a team's first fundraiser ended: units and revenue since then, split into later fundraisers and outside any fundraiser.

**Weekly payout backup**
- Every Monday (Pacific) the clock writes the accountant payout CSV to Drive at **Fundraising/_Backups/mambe-payouts-YYYY-MM-DD.csv**.
- **On failure:** a Sentry alert and a red work-queue item, then a retry an hour later until it succeeds that Monday.
- The Reports page shows the last good backup and has a **Back up now** button.
- The backup builds the CSV exactly like the frozen Payouts page, and a test checks they match. The Payouts page should switch to that code after Nov 26.

**Product deleted while its fundraiser is running** (Scheduled, Active, Settling or Payout pending): a Sentry alert, plus a red work-queue item "Product deleted in Shopify while the fundraiser is running". Lines are kept.

**Smaller items**
- The backup reminders next to Approve payout and on Ready to pay now say "Recovery → Export → Create export", Render's new wording. The owner approved this wording-only change to frozen screens.
- The History log covers set product, set dates, Drive, from application, and every application action.

## Drive setup details
- **Google Cloud:**
  - project **Mambe Fundraisers** (no organization), owned by matt@mambeblankets.com, with the Google Drive API on
  - OAuth consent screen: **External**, **In production** (so the sign-in doesn't expire after 7 days)
  - scope `drive.file` only (non-sensitive, no Google review)
- **OAuth clients:** "Desktop app" type. The client file is not kept; Google won't show it again, so a reconnect needs a new client.
- **Connect script:** `node scripts/google-drive-connect.mjs C:\path\google-client.json`. It signs in, creates "Fundraising (staging)" and "Fundraising" in My Drive, and prints the four values, each on its own line. Use `--no-folders` for a new sign-in only.
- **Render** (both services): `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN` (the same three on both) and `DRIVE_ROOT_FOLDER_ID` (staging → "Fundraising (staging)", production → "Fundraising").
  - The app ignores spaces, line breaks and quotes picked up when copying. That happened once: the refresh token was pasted incomplete on staging.
- **Rules:** renaming or moving the two root folders is fine. Deleting them breaks Drive; you'd need to run the script again and update `DRIVE_ROOT_FOLDER_ID`. Folders made by hand are invisible to the app (drive.file).
- **If Drive stops working** with "invalid_grant": the sign-in was revoked, for example by removing the app at myaccount.google.com → Security → Third-party access. Create a new client, run the script with `--no-folders`, and update the three OAuth values on both services.

## Email switch state
- Production: `APPLICATION_EMAILS_ENABLED=true` (set by the owner in Render; `sync: false` in render.yaml so a Blueprint sync never flips it).
- Staging: `true`, to `KLAVIYO_TEST_RECIPIENT` only.
- Klaviyo flows **Application Received** and **New Application** are live in Mambe's single Klaviyo account (staging and production share it).

## Bugs found and fixed this session
- **Shopify rejected the block name:** "Fundraiser application form" is 27 characters and the limit is 25. Renamed "Fundraiser application".
- **Klaviyo de-duplication:**
  - **Problem:** application email IDs were "application-N-…". Staging and production number applications separately and share one Klaviyo account, so production's application #1 to matt@mambeblankets.com (also the staging test inbox) was silently dropped as a duplicate of staging's #1.
  - **Fix:** IDs now start with the Render service name.
  - **Same pattern elsewhere:** organizer emails (`comm-N-organizer-M`) and login links can collide only if a production organizer uses the staging test-inbox address. Not changed, because that code sends Payout Sent and is frozen until Nov 26 (see Next).
- **My own new tests:** one expectation was wrong ("Nazareth Softball Boosters" vs "Nazareth Area High School" share one of two distinctive words, so 0.5, not 1). Corrected; the code was right.

## Assumptions I made (not settled by the spec)
- **Form contents:**
  - Timing is two required choices: a month (or "Not sure yet") and the team's season.
  - The season label on accept is "{Season} {year}": the next time that month comes round, or this year if not sure.
- **Spam limits:** under 3 seconds counts as spam, and so does a form open more than 7 days.
- **Organizer match:** if an organizer with the same email exists, the app won't create a second one; the admin must tick "use existing".
- **Cancel vs Decline:** a fundraiser without product or dates can't be cancelled; use Decline.
- **"$ raised" means the payout amount**, not revenue: frozen once approved, estimated before.
- **The weekly backup runs only once Drive is set up,** retries hourly on Mondays, and the work queue shows the latest failure until a backup succeeds.
- **The deleted-product alert** covers Scheduled through Payout pending. Setup is already covered by the launch gate.

## Housekeeping (npm audit)
- **typescript-eslint 6 → 8:** fixes the minimatch warnings. It works with the existing ESLint 8 setup with no code changes. Warnings went from 35 to 29.
- **Skipped:**
  - Prisma's deepmerge-ts: the only fix downgrades Prisma.
  - GraphQL codegen (lodash, graphql-tools, braces): no fix; version 3 of the preset still has them.
  - All of these are developer tools, not code that runs on Render.
- The non-breaking `npm audit fix` changed nothing useful and was reverted.

## Tests
- **215 pass, 0 to-do.** All 24 spec cases are unchanged. The only edits to existing tests are three type-only `?.` additions; no assertion changed.
- **New this session:**
  - **Optional fields (10 tests):** create without product or dates, half-set dates refused, launch blocked, no sales claimed, set product then dates (audited), launch after, overlap still enforced, Product ready needs a product, cancel refused/decline works, portal view.
  - **App Proxy:** signed accepted; unsigned, tampered, wrong secret and stale refused; applicant IP rule.
  - **Submit:** saved first with both emails queued, server-side field checks, honeypot / too fast / no start time ignored, rate limits with hashes only, emails to applicant and internal without list, failure kept and retried by the clock and shown in the work queue, failed after 3 tries with alert and Retry, switch off, de-duplication IDs per service.
  - **Review:** matching suggestions, accept into an existing organization and team (Setup, notes, season, linked, audited, not twice), create-new path, existing organizer reused, team from another organization refused, decline needs a reason, spam hides and drops emails, work-queue link, season label.
  - **Drive** (fake client): structure, IDs stored, checklist ticks, no duplicates when run twice, reuse across seasons, same-season naming, failure with Retry and work-queue item then a clean retry, folders on accept, season folder names, settings cleanup.
  - **Reports:** every table against known fixtures, the orders CSV, CSV headers and dollars.
  - **Backup:** Mondays only, once, file name and contents equal the accountant CSV, folder reused; failure alerts, work-queue item, hourly retry.
  - **Product deleted:** alert and red work-queue item, lines kept; no alert when nothing is running.

## Deployed state
- **Staging and production:** commit `78e0781`. The production database was backed up (Render export) before the schema change.
- **Shopify app versions released:** staging and production, with App Proxy and the form block.
- **NS-GSB-F26:** unchanged (Active), with Drive folders created. It still settles **Nov 26, 12:00 AM Pacific**.

## Next / V1.5 recommendations
- **Before Nov 26 (unchanged):** confirm PayPal Payouts access; take a Render export before approving; follow the session 5 checklist for NS-GSB-F26.
- **After Nov 26 (unfrozen):**
  - Give organizer email and login-link Klaviyo IDs the service-name prefix, like application emails.
  - Point the Payouts page at the shared accountant-row code (`backups.server.ts`).
- **Still open:** the welcome coupon fix and the live welcome-code test (session 4, done item 4).
- **V1.5 candidates:**
  - "Run it again?" reactivation emails (the repeat-rate report shows who to target)
  - contribution-after-payout report (table 6 is a start)
  - organizer self-serve edits
  - a weekly "applications not answered in 2 business days" work-queue item, to keep the promise on the thank-you screen
- **Owner decision pending (no rush):** Google Workspace vs Microsoft SharePoint for company documents. This app can move to either later.

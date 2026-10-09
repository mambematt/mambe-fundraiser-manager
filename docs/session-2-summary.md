# Session 2 summary: Mambe Fundraiser Manager

Completed Oct 9, 2026. Prompt: `docs/session-2-build-prompt.md`. Spec: `docs/SPEC.md`.

## Done criteria (all met, checked by the owner on the dev store)
1. Created Central High School, Girls Lacrosse, an organizer and fundraiser CHS-GLAX-F26; approved launch; the clock moved it to Active, then Settling, on its own.
2. A test order inside the window counted; one placed after it didn't.
3. An overlapping fundraiser on the same product was refused with a plain message naming CHS-GLAX-F26 and its dates.
4. Changing the start date showed "units from 4 to 1; payout from $100.00 to $25.00", and the saved numbers matched.
5. Cases 16–20 pass in GitHub Actions with everything from session 1.

## What was built
- **Records pages** (embedded admin, Polaris web components):
  - Organizations & teams, Organizers, Products.
  - Products search Shopify by title. Only active products can link. A missing `fundraiser` tag shows a warning. Linking starts the backfill.
  - Changing an organizer's email revokes their portal sessions.
- **Fundraisers:**
  - List, create form and fundraiser page.
  - Create takes team, linked product, season, start/end date pickers, timezone (default Pacific), rate (default $25, copied in), PayPal payee email, one or more organizers with one primary, and an editable generated public code.
- **Statuses** (`app/lib/status.ts`, the one transitions list): Application, Setup, Scheduled, Active, Settling, Payout pending, Paid, Declined, Cancelled.
  - **Admin actions:** Approve, Decline (reason), Approve launch, Back to Setup (before the start date only, reason), Cancel (from Setup, Scheduled or Active; reason; sets `cancelled_at`).
  - **Clock actions:** start (Scheduled → Active), end (Active → Settling).
  - Defined but not wired yet: settle (Settling → Payout pending) and record payment (Payout pending → Paid).
  - All status changes go through `transitionFundraiser` and `autoTransitionDue` in `app/services/fundraisers.server.ts`.
- **Launch gate** (`app/lib/launch-gate.ts`): all six checklist items done, product active and not deleted, dates and rate set, no overlap. TODO(session 4): short link and banner.
- **Setup checklist:** six items, each storing who and when, plus "waiting on organizer since" (set and clear).
- **Date/rate changes:**
  - Allowed until Settling, with a reason required and a preview first.
  - The preview runs the same attribution engine over the product's saved orders.
  - Saving re-attributes the product and is audited with before, after and reason.
  - Also blocked if a payout is approved or paid.
- **Audit log:** gained a `reason` column. Every transition, checklist tick, edit and attribution change is logged with before, after, reason, actor and time.
- **Staff identity:** the app now uses Shopify online tokens, so the audit log and checklist record the staff member's name, not "admin".
- **Scheduled jobs:**
  - Render cron every 15 minutes calls `POST /jobs/clock` with a shared `CRON_SECRET`. Without the secret the call is refused (401).
  - The status clock runs every time. Each run is logged in the new `job_runs` table, and it's safe to run twice or concurrently.
  - The nightly re-check runs in the 3 AM Pacific hour and retries every 15 minutes within that hour if it fails. It re-pulls orders updated since the last successful run minus 2 days, upserts them and re-attributes, and records the run.
  - It alerts if no webhook arrived in 24 hours while any fundraiser is Active.
- **Alerts:** Sentry, via `SENTRY_DSN` on both Render web services. It emails on failed webhooks, failed jobs, backfill misses, webhook silence and unexpected admin errors.
- **Home → Sync health:**
  - last webhook, failed webhooks, last clock run, last successful nightly
  - buttons: "Run nightly re-check now" and "Send a test alert"

## Owner decisions made this session
- **9 statuses** (the prompt's list; the spec said 8). Fundraisers created on the admin page start in **Setup**. **Application** is for fundraisers from the application form (later step). **Decline** works from Application or Setup.
- **The overlap rule now includes cancelled fundraisers, up to their `cancelled_at`.** Declined fundraisers are ignored. Enforced by the database (exclusion constraint, migration `20261007000000_lifecycle`).
- **A cancelled fundraiser with sales stays Cancelled.** Its payout is tracked on the payout record, and its settlement clock starts from `cancelled_at`.
- **The launch gate skips the short link and banner** until session 4.
- **Alerts go through Sentry.**
- **Shopify test orders never count on the live store** (new line outcome `test_order`, shown as "Test order (not counted)"). Staging sets `COUNT_TEST_ORDERS=true` so dev-store test orders still count.
- **From session 1:** the bulk (more than 4) flag uses units after refunds, and review flags only apply to lines inside a fundraiser window.

## Assumptions made (not settled by the spec)
- "Organizer info received" can't be ticked without a PayPal payee email.
- "Product linked and active" can only be ticked when Shopify shows the product active and tagged. Launch re-checks this at launch time.
- **Public code format:** org initials – team abbreviation – season letter and 2-digit year.
  - Seasons: F = Aug–Nov, W = Dec–Feb, S = Mar–May, U = Jun–Jul.
  - December counts toward the next year's winter.
  - Clashes get "-2", "-3".
- Fundraisers use whole calendar days. A "minutes from now" window isn't possible; acceptance used start yesterday, end today.

## Tests
- 100 pass and 5 are to-do. They run on every push against a throwaway Postgres 17.
- **Spec cases passing:** 1–20 and 23.
- **Still to-do:**
  - **21:** settlement re-pull fails.
  - **22:** refund after payout.
  - **24:** portal access.
  - **Part of 11:** payout approval blocked while flags are unresolved.
  - **Second half of 20:** settlement re-pull confirms the order.
- **New this session:** the transitions list (allowed and refused moves), the launch gate, the status clock (repeat-safe, concurrent, late runs), the nightly re-check and health alert, the date/rate preview, the cancellation re-count, public codes, and the test-order rule.
- **Changed with owner approval:** the extra "cancelled fundraisers never block" check inside Case 16 now matches the new overlap rule. The spec's Case 16 itself is unchanged.

## Deployed state
- **Staging and production** both run the same latest commit, and both pass their health checks.
- **Both cron jobs** run every 15 minutes and succeed.
- **Sentry:** a test alert was confirmed from staging. Production can only be tested once it's installed on a store (session 5).
- **Production** is not installed on mambeblankets.com yet.

## Known gaps and notes for later sessions
- **Session 3** (the plan): admin work queue, number strip, the finished fundraiser page (sales list linking to Shopify orders; include/exclude flagged lines with a note), and linking a product to a fundraiser. The current fundraiser page and Home are deliberately plain.
- **Session 4:** add the short link and banner to the launch gate (TODO in `launch-gate.ts`), plus banner on/off and the "Fundraiser ended" event in the clock (TODO in `jobs.server.ts`). A log of organizer portal visits is not built yet.
- **Session 5:**
  - Backfill vs Shopify Analytics check on mambeblankets.com with real history, including orders older than 60 days.
  - "Send a test alert" on production.
  - Link the live products and create the live fundraisers with their real (past) start dates. Backfill captures all their sales.
- **Settlement:**
  - It wires up Settling → Payout pending at end + 10 days after a full re-pull (TODO in `jobs.server.ts`).
  - **Deadline:** the first live fundraiser runs Oct 1–31, so its draft payout is due about **Nov 10**. Settlement must be built and passing on staging by about **Nov 7**. Target: the first session after launch, by end of October.
- **Not built yet:**
  - re-pointing the short link when a product's handle changes (logged only)
  - an alert when a product is deleted while its fundraiser is active
- **Housekeeping:** `npm audit` reports issues only in template developer tools (GraphQL code generation, ESLint 8), not runtime code. Update them in a quiet moment.

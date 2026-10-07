# Fundraiser Management App — V1 Spec

Oct 2, 2026 · @Matt

## Summary

We will build a small web app, separate from Order Printer, that runs Mambe's team fundraisers. Shopify stays the store; the app sits beside it and pays each school or booster club **$25 for every qualifying cape** sold on its team product during its fundraiser window.

The app owns everything Shopify doesn't: organizations, teams, organizers, fundraisers and their dates, the setup checklist, attribution, settlement, payouts and an audit trail. It runs inside Shopify admin for our team, plus a simple mobile portal for organizers that they open with an emailed login link.

It is built the same way as Order Printer: Claude writes the code, we test on the dev store, GitHub holds it, and Render runs it. Because this app moves money, three safeguards apply that Order Printer didn't need: automated tests before every deploy, a staging copy on the dev store, and owner sign-off on the attribution test cases at the end of this doc.

The build ships in two layers. A **money-correct core** comes first and passes a manual acceptance test on the dev store, and the first 3 live payouts are checked against Shopify before payment. The organizer-facing convenience layer follows.

**Per-cape economics** at $195: $80 product cost, $20 shipping (we absorb), $5.85 card processing (3%) leaves about **$89 contribution**, or **about $64 after the $25 payout**. The payout is roughly 28% of contribution.

## Locked business decisions

Every rule below is decided; the build and the tests follow them exactly.

| Topic | Decision |
| --- | --- |
| Payout | $25 per qualifying cape by default, editable per fundraiser before launch. One rate per fundraiser; no boosts. Personalization or price differences never change it. |
| What counts | Units of the fundraiser's linked team product only. The separate coach product never counts. |
| Purchase time | Shopify checkout time (`processed_at`), converted to Pacific Time. |
| Window | Start date 12:00 AM Pacific through the end of the end date (stored as up to, not including, 12:00 AM the next day). |
| Discounts | None on fundraiser products. Every fundraiser team cape carries the product tag "fundraiser"; an automated collection built from that tag is excluded from every discount code and automatic discount. The app alerts if a discount ever appears on a fundraiser order. |
| Bulk orders | Any order with **more than 4 units** of a fundraiser product is flagged for admin approve/exclude before the payout locks. We also tell organizers not to place coach orders on the fundraiser product. |
| Refunds | Refunded or cancelled units before the payout locks don't count. Refunds after payout are accepted as risk: shown on the fundraiser's history, no adjustment workflow. |
| Cancelled fundraiser | Still pays the units sold up to cancellation. |
| Settlement | 10 days after the end date, then a full re-check against Shopify, then a draft payout for admin review. |
| Payment | Manual PayPal payment to the booster club or school account (not an individual). No tax details collected for now. |
| Overlaps | Two fundraisers on the same product can never overlap in time; the database refuses it. |
| Product cost | Taken from Shopify "Cost per item" and saved on each order line when it arrives. |
| Shipping | Absorbed by Mambe; not charged to the customer. |
| Setup hours | Not tracked. |
| Order Printer | Separate app, same toolchain. Nothing shared at runtime. |

## Architecture and stack

The app is one Render web service with Postgres and a few cron jobs; Shopify remains the source of truth for anything the customer touches.

*(Architecture diagram: see the spec doc.)*

Orders flow in from Shopify by webhook and are re-checked nightly; the app writes back only a product-page banner and short-link redirects. Outlook stays for human conversations; n8n is not used.

| Data | Owned by | Others keep |
| --- | --- | --- |
| Products, prices, orders, payments, refunds, customers, cost per item | Shopify | App keeps IDs and a minimal copy of relevant order lines (no customer names, emails or addresses) |
| Organizations, teams, organizers, fundraisers, dates, rates, checklist | App | Shopify gets a display-only banner field |
| Attribution, settlement, payouts, audit history | App | — |
| Email templates and sending | Klaviyo | App decides who and when |
| Files | Google Drive | App stores folder and file IDs |

| Choice | Decision | Why |
| --- | --- | --- |
| Framework | Shopify's current app template (React Router, formerly Remix) on Node, via Shopify CLI | Same toolchain as Order Printer; the team already knows the workflow |
| Admin UI | Embedded in Shopify admin (Apps > Fundraisers), Shopify's Polaris components | Shopify handles admin login and 2FA |
| Organizer portal | Same app, public routes on `fundraise.mambeblankets.com` | Branded; App Proxy can't be used because Shopify strips its cookies |
| Database | Render Postgres, paid tier with daily backups | Payout history can't live in files that a redeploy wipes |
| Background work | Webhooks saved first, then processed in the same request; Render cron jobs for clock-driven work | No separate worker service at this volume; the nightly re-check catches failures |
| Email | Klaviyo, triggered by app events | Already in use; copy is editable without a deploy |
| Error alerts | Email or Sentry free tier on any failed webhook or job | Failures must be visible |
| Hosting cost | Estimate $20–35/month (web service, Postgres, cron) | Confirm against Render's current pricing |

## Data model

Eighteen tables; money in integer cents, every timestamp in UTC, and the database itself blocks double-counting and overlapping windows.

Relationships: an organization has many teams; a team has many products; a product has many fundraisers over time; a fundraiser has one or more organizers through a link table, plus assets, communications, one payout and an audit trail. Order lines belong to orders and point at a product and, when they qualify, at one fundraiser.

| Table | Key fields | Rules that matter |
| --- | --- | --- |
| organizations | name, type (school / club / booster / other), city, state, website, notes, Drive folder ID | — |
| teams | organization, name ("Girls Lacrosse"), sport, level, Drive folder ID | Many teams per organization |
| organizers | name, email, phone, role, notes | Email unique and lowercased; a person, not tied to one fundraiser |
| fundraiser\_organizers | fundraiser, organizer, is\_primary | Supports co-organizers from day one |
| products | Shopify product ID, handle, title, status, team, design notes, Drive folder ID, last synced | Shopify product ID unique and required |
| fundraisers | public code (e.g. CHS-GLAX-F26), team, product, season label, start date, end date, timezone (default Pacific), computed time window, payout rate, status, checklist fields with timestamps, waiting-on-organizer-since, short URL, PayPal payee email (organization's), Drive folder ID, cancel reason, notes | Rate copied in at creation so later default changes never alter it. **No two non-declined, non-cancelled fundraisers on the same product may have overlapping windows** (Postgres exclusion constraint) |
| applications | raw submission, normalized fields, status (new / converted / declined / spam), converted fundraiser | Raw submission kept forever |
| shopify\_orders | Shopify order ID, order name (#1234), processed\_at, financial status, cancelled\_at, source (web / pos / draft), discount codes present, Shopify updated\_at | Shopify order ID unique. No customer personal data |
| order\_line\_items | Shopify line item ID, order, product ID, variant ID, quantity, refunded quantity, current quantity, unit price, discount amount, **unit cost at time of sale**, attributed fundraiser, review flag + reason, admin decision (include / exclude), locked | **Shopify line item ID unique**: the main protection against double-counting. Product ID stored here so a deleted product never loses history |
| payouts | fundraiser, rate, qualifying units, amount, status (draft / approved / paid), calculated / approved / paid dates, method, PayPal reference, payee email | One per fundraiser |
| payout\_lines | payout, line item, units counted | The frozen record of exactly what was paid. Companion table payout\_adjustments (amount ±, reason, date, admin note, required on every manual change before payment) covers the spec's manual-adjustment rule |
| assets | fundraiser, kind (flyer / email copy / social image / other), title, URL or Drive file ID, visibility (internal / organizer), current or replaced | Organizers only ever see "organizer" + current |
| communications | fundraiser, kind (confirmation / launch / week 2 / week 3 / final / ended / paid), scheduled for, sent at, status, error | Doubles as the reminder schedule and the send log |
| audit\_log | entity, entity ID, action, before, after, actor, time | Append-only |
| webhook\_events, portal\_login\_tokens, portal\_sessions | Support tables for sync and portal login | Webhook ID unique; tokens stored only as hashes |

Indexes: line items by product, by attributed fundraiser and by order; orders by processed\_at; fundraisers by status and product.

## Shopify integration

Webhooks keep the numbers current within about a minute; a nightly re-check and a full re-pull before every payout make sure a missed webhook can never change what an organization is paid.

**App setup.** A new app in the existing Partner account, built with Shopify CLI and installed only on mambeblankets.com (tested first on the dev store). Access needed: read orders (plus all-orders history for backfill), read products, read inventory (for cost per item), write products (banner field), write navigation (short-link redirects). Orders access requires Shopify's protected-customer-data approval; check whether Order Printer's approval already covers this pattern.

**Webhooks.** `orders/create`, `orders/updated`, `orders/paid`, `orders/cancelled`, `refunds/create`, `products/update`, `products/delete`.

1. Verify Shopify's signature; reject anything unsigned.
2. Save the event (duplicate webhook IDs are ignored), reply 200 right away.
3. Re-read the order's current state and upsert it by Shopify ID, so arrival order never matters.
4. Keep only lines whose product is linked to a team product; ignore the rest of the order.
5. Re-run attribution for affected lines. Failures retry, then appear as "sync errors" in the work queue.

**Cost per item.** When a line is first saved, the app reads that variant's current Shopify cost and stores it on the line. Later cost changes never rewrite history. Lines loaded by the historical backfill get today's cost and are marked "cost approximate."

**Reconciliation.**

- Nightly: pull every order updated since the last run (with a 2-day overlap) and upsert. Alert if no webhooks arrived in 24 hours while any fundraiser is active.
- At settlement close: full re-pull of every order containing the product, from 1 day before the window to now. The payout is calculated only if this succeeds; otherwise the fundraiser stays in Settling and is flagged.
- Backfill: when a product is first linked, load its lifetime sales so evergreen reporting starts complete.

**Products.** Updates refresh title, handle and status (and re-point the short link if the handle changed). A deleted product is marked deleted; its order lines are kept. Linking a fundraiser to an archived or deleted product is blocked. Linking a product that lacks the "fundraiser" tag shows a warning, so a missing tag can't quietly open a discount leak.

**Written back to Shopify.** A product field holding the active fundraiser's name and end date (for the product-page banner, shown only during the window) and a short-link redirect such as `/go/chs-glax` pointing at the product.

## Attribution rules

One function, used everywhere, decides whether each order line is a qualifying unit; there is no second way to count.

For each saved order line:

1. **Linked product.** The line's product is a linked team product. If not, the line is never saved.
2. **Purchase time.** Take the order's checkout time (`processed_at`).
3. **Window.** Find the fundraiser on that product (not declined; a cancelled fundraiser's window ends at the moment it was cancelled, so its earlier sales still count) whose window contains the purchase time. The window runs from 12:00 AM Pacific on the start date up to, but not including, 12:00 AM Pacific on the day after the end date. Daylight-saving changes are handled by the timezone library, never by hand.
4. **Eligible order.** The order is not cancelled, and its payment status is paid, partially paid or partially refunded.
5. **Units.** Qualifying units = quantity minus refunded or removed quantity. A refund of money only (no quantity) leaves units unchanged and flags the line for a look.
6. **Review flags.** Flag, but still count until an admin decides: any order with more than 4 units of a fundraiser product; any discount on a fundraiser line; any draft or POS order; any money-only refund. Flagged lines must be resolved (include or exclude, with a note) before the payout can be approved.
7. **Payout.** Qualifying units × the fundraiser's rate. Price, personalization, taxes and shipping never change it.

What each line becomes:

| Line outcome | Rule | Counts toward |
| --- | --- | --- |
| Qualifying fundraiser sale | Steps 1–5 pass, not excluded by admin | Fundraiser units, payout, fundraiser revenue, lifetime totals |
| Non-fundraiser sale | Linked product, no window matches | Evergreen and lifetime totals only |
| Refunded or cancelled | Units drop to 0 (or by the refunded quantity) | Refund column; nothing else |
| Excluded by admin | Flagged, admin chose exclude with a note | Lifetime totals only |

The fundraiser a line belongs to is stored on the line for fast reporting, recalculated when anything changes, and locked once the payout is frozen. Until then every screen labels the amount **estimated**.

## Statuses and setup checklist

Eight statuses track where a fundraiser is in its life; a separate checklist tracks the setup work, because several setup items are often open at once.

*(Status diagram: see the spec doc.)*

Only three moves are automatic (Active, Settling, Payout pending); everything else is a deliberate admin click. Statuses are stored as text with an allowed-transitions list in code, so a new status later needs no database redesign.

| Rule | Detail |
| --- | --- |
| Scheduled requires | Every checklist item done, product active in Shopify, dates and rate set, no window overlap, short link and banner field written |
| Scheduled can go back to Setup | Only before the start date, with a reason |
| Dates or rate edits | Allowed until Settling, with a reason; the app shows "qualifying units change from X to Y" before saving. Locked once the payout is frozen |
| Paid | Final. Nothing about a paid fundraiser can be edited |
| Attribution never depends on status | If the job that flips Scheduled to Active runs late, sales in that gap still count, because the window decides |

**Setup checklist** (each item stores who and when):

- [ ] Organizer info received (logo, colors, dates confirmed, PayPal email of the booster club or school)
- [ ] Artwork approved by organizer
- [ ] Shopify product created or linked, in the "Fundraiser" collection, active
- [ ] Promotional assets uploaded and marked organizer-visible
- [ ] Drive folders created
- [ ] Launch package reviewed

"Waiting on organizer since \[date\]" is a flag, not a status, so the work queue can age it.

## Admin screens and organizer portal

The admin's home screen is a work queue built from the checklist and the calendar, so at 20–50 live fundraisers nobody has to remember what needs attention.

| Admin screen | What it does | V1 |
| --- | --- | --- |
| Work queue (home) | Applications to review; items waiting on organizers longer than 5 days; launches in the next 3 days; fundraisers ending this week; settlements ready; payouts to send (count and $); flagged lines (bulk, discount, draft/POS, money-only refund); sync errors | Yes |
| Number strip (top of home) | Active, Scheduled and Settling counts; payouts outstanding ($); qualifying units and $ raised this month and year to date; units sold outside windows, last 30 days | Yes, about 6 numbers |
| Fundraiser page | Overview, setup checklist, sales (qualifying, non-qualifying, refunded; each line links to the Shopify order), flags to resolve, communications log, assets, payout, history | Yes |
| Applications | Review a submission and convert it, matching or creating the organization, team and organizer | Yes |
| Organizations, teams, organizers, products | Records and history across seasons | Yes |
| Ready to pay | Every approved payout in one list with payee email and amount; export a PayPal bulk-payment file; record each payment and reference | Yes |
| Reports | A few fixed tables with CSV export (see Scope) | Yes, minimal |
| Sync health | Last webhook, last nightly re-check, failures | Yes, small |

**Organizer journey.**

1. **Apply** on `mambeblankets.com/pages/fundraise`. The form posts through Shopify's App Proxy so it stays on our domain. It asks only for name, email, phone, organization, team/sport, role, city/state, rough timing and whether they have a logo. Colors, files, exact dates and the PayPal email come after approval.
2. **Confirmation email** from Klaviyo.
3. **Setup.** We trade artwork and details by Outlook. The portal is live from approval and says "We're designing your cape."
4. **Launch.** Admin clicks Approve launch; the launch email goes out with portal link, dates, short link and assets.
5. **Active.** Portal shows status, dates, days left, the short link with a copy button and QR code, **units sold and estimated $ raised** ("final after settlement", updated within minutes), this week's suggested action, downloadable assets, and a help contact.
6. **Reminders** in week 2, week 3 and the final 3 days, each with the current unit count.
7. **Ended.** "Thanks. Your final total will be confirmed by \[date\]."
8. **Paid.** Amount, date and PayPal reference, plus past fundraisers.

No goals or progress bars in V1.

## Automations, emails and Google Drive

The app decides who gets which email and when; Klaviyo only formats and sends it, and every automated step that fails shows up in the work queue instead of failing silently.

| Trigger | Action | System | If it fails |
| --- | --- | --- | --- |
| Application submitted | Save it; send "Application received" event; notify our team | App, Klaviyo | Application is saved first; the email retries and shows in the queue |
| Admin approves application | Create Drive folders; enable portal access | App, Google Drive | Checklist shows "Drive folders: failed" with a retry button |
| Admin approves launch | Write short-link redirect and banner field; send "Launch package" event | App, Shopify, Klaviyo | Launch is blocked until the Shopify writes succeed; email retries |
| Start time (checked every 15 min) | Scheduled → Active; banner shows | App | Safe to repeat; attribution doesn't depend on it |
| Day 7, day 14, start of final 3 days | Reminder event with live unit count | App, Klaviyo | Each reminder is a row with a status; failures appear in the queue |
| End time | Active → Settling; banner off; "Fundraiser ended" event | App, Klaviyo | Safe to repeat |
| Every order webhook | Save order lines; re-run attribution | App | Retries; the nightly re-check is the backstop |
| Nightly | Re-check orders; health check | App | Alert email |
| End + 10 days | Full re-pull, then draft payout; → Payout pending | App | Stays in Settling and flagged; never calculates on stale data |
| Admin records payment | → Paid; freeze; "Payout sent" event | App, Klaviyo | — |

**Klaviyo.** One simple flow per event (`Fundraiser Launched`, `Fundraiser Reminder` with week, units, short link, portal link and end date, and so on); copy is edited in Klaviyo without a deploy. Organizers go on their own list and are **excluded from consumer marketing flows**, which also keeps Klaviyo's welcome and win-back discount codes away from them. Portal login emails go through Klaviyo too; if they arrive slowly, add a transactional sender later.

**Outlook** stays for human conversations: artwork, questions, exceptions. **n8n** is not used.

**Google Drive.** A service account limited to the Fundraising folder creates this structure and stores each folder's ID (lookups by ID, never by name, so renames don't break anything):

```
Fundraising/
  Central High School/            organization folder
    Girls Lacrosse/               team folder
      _Product & Artwork/         logos, master art, product images, reused every season
      2026 Fall/                  fundraiser folder
        Organizer Assets/         final flyers and social images; the only files organizers see
        Internal/                 approvals, notes, drafts
```

Artwork lives with the team, not the season, because it's reused every time. Individual final files are shared by link and registered as assets; whole folders are never shared.

## Security and financial controls

The app stores no customer personal data, organizers can only ever see their own fundraisers, and once a payout is frozen its numbers can't change.

**Security**

| Area | Rule |
| --- | --- |
| Admin login | Through Shopify admin (embedded app), so Shopify's login and 2FA apply |
| Organizer login | Login link authenticates the **person**; they see only fundraisers linked to them. Token: 32+ random bytes, stored only as a hash, single-use, expires in 30 minutes. Using it sets a secure, HttpOnly session cookie for 45 days |
| Lost or forwarded link | "Email me a new link" page always replies "If we have that email, a link is on its way". Single-use + 30-minute expiry makes a forwarded old link useless |
| Revocation | Admin "sign out everywhere" per organizer; changing an organizer's email revokes their sessions |
| Access log | Time and fundraiser of each portal visit; no IP or device fingerprinting |
| Secrets | Shopify credentials, Klaviyo key and Google service-account key live only in Render environment variables, never in GitHub |
| Webhooks | Shopify signature checked on every request |
| Personal data | No customer names, emails or addresses. Organizer contact details and the organization's PayPal email only |
| Backups | Render Postgres daily backups (plus point-in-time recovery if the plan offers it) and a weekly CSV of all payouts saved to Drive. Restore tested once before launch |

**Financial controls**

1. One attribution function, fully tested; no other code counts units.
2. Shopify line item ID is unique in the database, so a line can't be counted twice.
3. Overlapping windows on one product are refused by the database.
4. Every screen says **estimated** until the payout is frozen.
5. A payout is calculated only after a successful full re-pull at settlement close.
6. All review flags must be resolved before a payout can be approved.
7. Approving a payout writes the exact lines paid (`payout_lines`) and locks their attribution.
8. Manual adjustments before payment need amount, reason, date and note, and are audited.
9. Paid is final. Refunds after payout are shown on the fundraiser's history only (accepted risk).
10. PayPal payment stays manual; the app records payee, amount, reference and date.
11. Every change to status, dates, rate, flags and payouts goes into the append-only audit log.

## Edge cases

Every case the spec named has one rule, and all of them are handled in V1 except exchanges.

| Case | Rule |
| --- | --- |
| Purchase seconds before or after the window | Checkout time against the exact window; no grace period |
| Order at 11:30 PM Pacific on the end date | Counts (it's the next day in UTC; the window is computed in Pacific) |
| Window crossing the Nov 1 daylight-saving change | Handled by the timezone library; covered by a test |
| Quantity 2+ on one line | Counts every unit |
| More than 4 units on one order | Counts, flagged for admin include/exclude before payout |
| Partial refund by quantity | Units drop by the refunded quantity |
| Partial refund of money only | Units unchanged; flagged for a look |
| Full refund or cancellation before payout | 0 units; line kept for reporting |
| Refund during settlement | Picked up by webhook and by the settlement re-pull |
| Refund after payout | Shown on history only; accepted risk |
| Discount on a fundraiser line | Counts; flagged so the leaking discount gets fixed |
| Draft or POS order | Counts; flagged for admin review |
| Coach product order | Never counts (different product) |
| Personalization changes the price | No effect; $25 per cape |
| Product archived | History kept; can't schedule a fundraiser on it |
| Product deleted | Lines kept (product ID stored on each); alert if a fundraiser is active |
| Handle or URL changed | Short link re-pointed automatically; flyers keep working |
| Variant added or removed | No effect; attribution is by product |
| Price change | No effect on payout; revenue reports use the actual line price |
| Overlapping windows on one product | Refused by the database |
| Same school, several teams | Separate products, no conflict |
| Same team, new season | New fundraiser on the same product; portal shows past seasons |
| Dates changed after sales | Allowed until Settling with reason and before/after unit preview; locked after payout |
| Rate changed after launch | Allowed until Settling with reason; applies to all units; audited |
| Organizer changes email or loses link | Admin edits email (sessions revoked); self-serve new link |
| Duplicate webhook | Ignored by webhook ID; line upsert is safe to repeat |
| Missed webhook or Shopify outage | Nightly re-check and settlement re-pull |
| Drive or Klaviyo failure | Retry button or failed row in the work queue |
| Fundraiser cancelled after sales | Pays units sold up to the cancellation time |
| Exchange (size swap) | Follows Shopify's resulting quantities; flagged. V1.5 for anything smarter |

## Scope and build sequence

V1 is the money-correct core plus a minimal organizer portal; everything else waits until real fundraisers show what's needed.

| Phase | Includes |
| --- | --- |
| **V1, build now** | Data model; Shopify app, webhooks, nightly re-check, backfill; cost-per-item snapshot; attribution with review flags; statuses and checklist; work queue, number strip, fundraiser page; application form; settlement, frozen payouts, manual adjustments, Ready-to-pay with PayPal bulk file; audit log; organizer portal with login links; Klaviyo events (confirmation, launch, 3 reminders, ended, paid); Drive folders; short links; **product-page fundraiser banner**; health page; fixed reports + CSV |
| **V1.5, next** | **"Run it again?" email to past organizers about 11 months later** (likely the highest-return feature on the list); contribution-after-payout report per fundraiser and per team lifetime (data already captured); organizer self-serve edits; exchange handling; SMS reminders; co-organizer invites from the portal |
| **V2, later** | Goals and progress; leaderboards; rate boosts; several products per fundraiser; automated PayPal payouts; Canva or AI asset generation; school-wide programs; referral program; staff roles and permissions |

**V1 reports** (fixed tables, CSV export): fundraisers by status; qualifying units and $ raised by fundraiser, team and organization; paid vs outstanding; per product, lifetime units and revenue split into in-window and outside-window; repeat rate (teams with more than one fundraiser); sales after a team's first fundraiser ended.

**Hard to change later, so decided now:** organizers as people with a link table; product ID stored on every line; cost saved at time of sale; integer cents and UTC; frozen payout lines; status transitions in code. Kept simple on purpose: one product per fundraiser.

**Build sequence.** Each step is tested on the staging copy before it reaches the live store.

1. **Foundation.** New repo, Shopify CLI app, Render web service and Postgres, staging copy on the dev store, GitHub tests that must pass before deploy, core tables, audit log.
2. **Shopify read path.** Webhook receiver, line upsert, cost snapshot, backfill of 1–2 real products. *Check: lifetime units match Shopify Analytics for those products.*
3. **Attribution plus the test cases below**, before any screen depends on it.
4. **Fundraiser lifecycle.** Create and edit, overlap constraint, statuses, cron clock, nightly re-check.
5. **Settlement and payouts.** Draft, flags resolution, freeze, adjustments, Ready-to-pay, record payment. *The money-correct core is done: pass the dev-store acceptance test; check the first 3 live payouts against a Shopify sales report before paying.*
6. **Admin work queue, number strip, fundraiser page.**
7. **Application form** via App Proxy, and conversion to a fundraiser.
8. **Organizer portal** and login links.
9. **Integrations.** Klaviyo events, Drive folders, short links, product banner.
10. **Reports, health page, weekly payout backup.**
11. **Go-live checks.** Security pass, backup restore drill, switch on for all new fundraisers.

## Attribution and payout test cases

These 24 cases become automated tests that must pass before every deploy; mark each one Approved, or Change needed with a comment, before coding starts.

All cases use one sample fundraiser: **Central High Girls Lacrosse, October 1–31, 2026, $25 per cape**, on its own team product. Daylight saving ends November 1, so the window closes at November 1, 07:00 UTC.

| # | Situation | Expected result | Sign-off |
| --- | --- | --- | --- |
| 1 | 1 cape, checkout Sep 30 at 11:59:59 PM Pacific | 0 units (before window); counts as an evergreen sale | Approved |
| 2 | 1 cape, checkout Oct 1 at 12:00:00 AM Pacific | 1 unit, $25 | Approved |
| 3 | 1 cape, checkout Oct 31 at 11:59:59 PM Pacific (Nov 1 in UTC) | 1 unit, $25 | Approved |
| 4 | 1 cape, checkout Nov 1 at 12:00:00 AM Pacific | 0 units; evergreen sale | Approved |
| 5 | One line, quantity 3 | 3 units, $75 | Approved |
| 6 | Quantity 3, then 1 refunded by quantity before settlement closes | 2 units, $50 | Approved |
| 7 | Quantity 1, then a $20 money-only refund | 1 unit, $25; flagged for a look | Approved |
| 8 | Order cancelled | 0 units; line kept in refund column | Approved |
| 9 | Same order arrives by 3 duplicate webhooks, and its refund webhook arrives before its create webhook | Counted once with the correct final units | Approved |
| 10 | One order with 4 capes | 4 units, $100; no flag | Approved |
| 11 | One order with 5 capes | 5 units counted as estimated and flagged; payout can't be approved until admin includes ($125) or excludes ($0) with a note | Approved |
| 12 | A discount code applied to a fundraiser cape | Counts; flagged so the discount setup gets fixed | Approved |
| 13 | Coach product bought during the window | 0 units | Approved |
| 14 | Cape with personalization, line price $230 | 1 unit, $25 | Approved |
| 15 | Draft order or POS sale of 1 cape | 1 unit, flagged for admin review | Approved |
| 16 | Creating a second fundraiser on the same product for Oct 15–Nov 15 | Refused (overlap) | Approved |
| 17 | Next fundraiser on the same product starts Nov 1; order Nov 1 at 12:00 AM Pacific | Counts for the new fundraiser only | Approved |
| 18 | Fundraiser cancelled Oct 20 at 3:00 PM; 12 capes sold before, 2 after | 12 units, $300 | Approved |
| 19 | Start date changed from Oct 1 to Oct 5 after sales | Preview shows units before and after; saved numbers match the preview; change logged with reason | Approved |
| 20 | A paid order's webhooks never arrive | Nightly re-check adds it; settlement re-pull confirms it | Approved |
| 21 | Settlement re-pull fails (Shopify down) | Stays in Settling, flagged; no payout calculated | Approved |
| 22 | Refund on Dec 1 after the payout was frozen and paid | Paid amount unchanged; refund shown on history | Approved |
| 23 | Cost per item changed in Shopify after an order | That order line keeps the cost from the time of sale | Approved |
| 24 | Organizer A opens a link to organizer B's fundraiser, or reuses an old login link | Refused in both cases | Approved |

After the automated tests pass, we run a **manual acceptance test** on the dev store: real test-gateway orders, refunds and cancellations for each case that can be placed by hand, checked against the expected results above. In place of shadow mode, the **first 3 live payouts are checked against a Shopify sales report** (product + date range) before any money is sent.

## Before the first coding session

Five setup tasks in Shopify and Klaviyo can start today, and none of them need code.

- [ ] Give every team cape the tag "fundraiser" and let an automated collection (condition: tag equals fundraiser) build the **"Fundraiser" collection**
- [ ] Audit every discount code and automatic discount, including the codes Klaviyo flows generate (welcome, abandoned cart, win-back), and exclude the Fundraiser collection from each. Test on the dev store: a welcome code and a sitewide code must both fail on a team cape
- [x] Make it a staff rule that every new discount excludes the Fundraiser collection (the app's discount flag is the backstop, not the control)
- [x] Confirm "Cost per item" is filled on every team cape variant
- [x] Mark each of the 24 test cases above Approved or Change needed

**Guardrails for the build.** Because no human reviews the code, these apply to every change:

1. GitHub runs the test suite on every push; Render deploys only after it passes (confirm this setting on our Render plan).
2. Any change touching attribution, payouts or settlement goes to the staging copy on the dev store first.
3. A failing test is never deleted or edited to pass without the owner's sign-off on the changed case.

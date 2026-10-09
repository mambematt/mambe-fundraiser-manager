# Session 3 summary: Mambe Fundraiser Manager

Completed Oct 9, 2026. Prompt: `docs/session-3-build-prompt.md`. Spec: `docs/SPEC.md` (with the "Decisions made during the build" table).

## Done criteria (all met, checked by the owner)
1. Production is installed on mambeblankets.com. The one linked product's backfill matches Shopify Analytics on every number. The live fundraiser NS-GSB-F26 shows its real estimate.
2. On the fundraiser page, every sale is listed, each order opens in Shopify admin with one click, and flagged lines can be included or excluded with a note. The estimate updates and History records it.
3. Home shows the number strip and a work queue that matches what clicking through shows.
4. An organizer-visible asset link was added to a fundraiser.
5. All tests pass in GitHub Actions (122 passing).

## Part 1: production live in read-only mode
- **Install:**
  - The production app "Mambe Fundraisers" is installed on mambeblankets.com.
  - The app belongs to the store's own organization in the Dev Dashboard, so there's no Distribution tab, just "Install app".
  - No separate approvals were needed: read-all-orders and order data came with the install.
  - `COUNT_TEST_ORDERS` is off on production.
  - Production writes nothing to the store and sends no emails yet.
- **Alerts:** a test alert from production reached Sentry, and the owner gets the email.

### Backfill check, product by product

| Product | Check | App | Shopify Analytics |
|---|---|---|---|
| Custom Nazareth Hooded Blanket (8042548592828) | Items ordered | 66 | 66 |
| | Net items sold | 66 | 66 |
| | Gross sales | $12,890.00 | $12,890.00 |
| | Discounts | $358.20 | $358.20 |
| | Returns | $0.00 | $0.00 |
| | Orders (older than 60 days) | 57 (49) | — |

- **Discounts at first:** the app showed $0.00 against Shopify's $358.20.
- **Traced order by order:** 19 lines on 18 orders used whole-order discount codes (MAMBE10 ×8, BF15 ×5, WELCOME ×2, CYBER14 ×1, one other).
- **Cause:** Shopify leaves `LineItem.totalDiscountSet` at $0 for those codes. The amounts live in `discountAllocations`.
- **Fixed:** the app now reads the allocations, and Case 12 covers the real shape.
- **Why it mattered:** without the fix, discounted fundraiser sales would never have been flagged.

### Live fundraiser created
- **NS-GSB-F26:**
  - Nazareth Softball (booster, Nazareth PA), team Girls Softball
  - product Custom Nazareth Hooded Blanket
  - **Oct 1 – Nov 15, 2026**, $25 per blanket
  - organizer Trissy Laurito (primary)
- **At creation:** 7 qualifying units, $175.00 estimated, from orders #111494 (2), #111495, #111530, #111535, #111536 and #111595.
- **Since then:** launched by the owner, now Active.
- **Payout date:** about **Nov 25** (Nov 15 + 10 days).

### Real flags found on live orders
- **#111494 (Oct 2):** WELCOME-10GHTD on 2 blankets, $39.00 off, inside the window. Both lines were flagged, and the owner resolved them (decision and note are in the fundraiser's History).
- **The leak behind it:** Klaviyo's welcome codes still apply to fundraiser products. #111448 (Sep 28, just before the window) used one too. Action for the owner: exclude the Fundraiser collection from the welcome discount (an open spec setup task).

## Part 2: fundraiser page (finished version)
- **Overview:**
  - status badge, organization and team
  - organizers, primary first, with email and phone
  - dates with "N days left" or "Ended N days ago"
  - rate and PayPal payee (with a note when it's the organizer's own email)
  - product links: Shopify admin and storefront
  - public code and editable internal notes
- **Estimated totals:** qualifying units, estimated payout, fundraiser revenue (line price × qualifying units, before discounts) and open flags, labeled **"Estimated, final after settlement"**.
- **Flags to resolve:**
  - Each flagged line in the window has Include and Exclude, and both require a note.
  - The decision saves to the line, re-runs attribution and writes History with the note.
  - Decisions can change, with a new note, until the payout is frozen. They're locked when the fundraiser is Paid or the payout is approved or paid.
- **Sales:** tabs for Qualifying, Outside window (this product, 30 days either side of the window), Refunded/cancelled, Excluded by admin, Test order (not counted), plus "Not paid yet" when it has any.
  - Each row shows the order (one click to Shopify admin), checkout time in Pacific, units, line price, flags and outcome.
- **Kept from session 2:** status actions, setup checklist, waiting on organizer, date/rate changes with preview, details and organizers.
- **Assets:**
  - Add a link with title, kind, URL and visibility (organizer or internal).
  - "Replace" marks the old asset not current and points it at the new one.
  - `organizerVisibleAssets()` is ready for the portal.
  - Migration `20261009000000_asset_replacement` added `replaced_by_id`, `replaced_at` and `created_by`.
- **History:** plain sentences, newest first. For example: "Matt Weir changed start date Oct 1 → Oct 5. Units 7 → 4. Reason: …"
- **Placeholders:** Communications (session 4) and Payout (settlement session).

## Part 3: Home
- **Number strip** (each tile links to a filtered list):
  - Active, Scheduled and Settling counts
  - payouts outstanding ($0 until settlement)
  - qualifying units and estimated $ this month and year to date (Pacific)
  - units sold outside windows in the last 30 days
- **Work queue** (empty groups hidden):
  - applications to review (hook)
  - **starting within 3 days or already started but not yet Scheduled (red)**
  - waiting on organizer more than 5 days
  - ending in the next 7 days
  - flags to resolve, total and by fundraiser
  - settlements ready (hook)
  - payouts to send (hook)
  - sync problems: failed webhooks, nightly re-check over 26 hours old or never run, webhook silence
- **Sync health** stays below.
  - "Run nightly re-check now" now starts in the background and answers right away. Sync health shows running, succeeded or failed.

## Part 4: product page
For each linked product:
- lifetime units and revenue, split into in-window and outside-window
- the numbers to compare with Shopify Analytics: items ordered, net items sold, gross sales, discounts
- order count and how many orders are older than 60 days
- the fundraisers on the product, with estimated units
- unit-cost coverage: lines with a recorded cost, how many are approximate (from backfill), how many have no cost in Shopify

## Problems found and fixed this session
1. **Whole-order discount codes were invisible to the app.** Fixed by reading `discountAllocations`.
2. **Sentry silently dropped a repeated identical alert.** Its default "Dedupe" feature does this, so a failure repeating with the same wording would only alert once. Fixed by turning Dedupe off; the owner added a Sentry email rule (new issue, reopened issue, or any event in an hour; at most hourly).
3. **The nightly re-check was too slow on the live store.** It re-read every order updated in 2 days, and the manual button gave no feedback. It now looks at each order's products first and only re-reads orders with a linked product (or ones it already keeps). The button runs in the background.

## Decisions the owner made this session
- **Production was installed on mambeblankets.com in session 3**, ahead of session 5, in read-only mode.
- **NS-GSB-F26 dates are Oct 1 – Nov 15, 2026.**
- **NS-GSB-F26's payout goes to Trissy Laurito's personal PayPal for now.** This is an exception to the spec rule "booster club or school account, not an individual", noted on the fundraiser. Replace it with a club account before payout approval if one exists.
- **The #111494 discount flags are resolved** (see History).
- **Shopify test orders never count on the live store** (made at the end of session 2, already in the spec table).

## Assumptions I made (not settled by the spec)
- The red work-queue group also includes fundraisers that **already started** but were never launched. Otherwise a live fundraiser stuck in Setup would never show.
- "Outside window" sales on a fundraiser page cover 30 days either side of the window.
- "Fundraiser revenue" means line price × qualifying units, before discounts. That matches Shopify's "gross sales" basis.
- "Settlements ready" means Settling and at least 10 days past the window end (a hook until settlement exists).
- The storefront link uses the store's myshopify domain, which redirects to mambeblankets.com.
- "Nightly re-check hasn't succeeded yet" counts as a sync problem.

## Tests
- 122 pass and 5 are to-do. They run on every push.
- **Spec cases passing:** 1–20 and 23, plus Case 11's include/exclude half.
- **Still to-do:**
  - **21:** settlement re-pull fails.
  - **22:** refund after payout.
  - **24:** portal access.
  - **Part of 11:** payout approval blocked while flags are unresolved.
  - **Second half of 20:** settlement re-pull confirms the order.
- **New this session:**
  - include/exclude (exclude removes units, include keeps them, changes are audited, locked once frozen)
  - the whole-order discount shape (Case 12)
  - work-queue groups and their Pacific date edges
  - number strip month and year boundaries in Pacific (including DST and New Year's Eve), with test orders left out
  - Shopify admin links
  - assets add and replace
  - plain-English history
  - product totals (gross sales, discounts, 60-day count)
  - the nightly pre-filter

## Deployed state
- **Staging and production** both run the latest commit, and their cron jobs succeed every 15 minutes.
- **Sentry is verified on both.**
- **Production** is installed on mambeblankets.com and has 1 linked product and 1 active fundraiser (NS-GSB-F26).

## Planned for session 4
- **Organizer portal** on `fundraise.mambeblankets.com`:
  - login links (32+ byte token, stored hashed, single use, 30-minute expiry, 45-day session cookie)
  - "email me a new link"
  - sign out everywhere
  - access log
  - test Case 24
- **The portal shows:** status, dates, days left, the short link with copy button and QR code, units and estimated $ ("final after settlement"), this week's suggested action, current organizer-visible assets, and help contact.
- **Klaviyo events:** confirmation, launch package, week 2, week 3, final 3 days, ended, paid. The communications table works as the schedule and send log, and the fundraiser page's Communications placeholder gets filled.
- **Short link** (`/go/…` redirect) and **product-page banner** field written to Shopify:
  - add both to the launch gate (TODO in `app/lib/launch-gate.ts`)
  - banner on and off from the clock (TODO in `app/services/jobs.server.ts`)
  - re-point the short link when a product's handle changes
- **Custom domain:** `fundraise.mambeblankets.com` needs DNS and a Render custom domain (owner steps).

## Then: settlement session (right after session 4)
- **Deadline:** NS-GSB-F26 ends Nov 15, so its draft payout is due about **Nov 25**. Settlement must be built and passing on staging by about **Nov 22**.
- **Scope:**
  - Settling → Payout pending at end + 10 days, after a successful full re-pull (TODO in `jobs.server.ts`)
  - draft payout and adjustments
  - payout approval blocked while flags are unresolved (Case 11's second half)
  - freezing `payout_lines` and locking lines
  - Ready-to-pay with the PayPal bulk file
  - recording the payment
  - Cases 20 (second half), 21 and 22
- **First live payout:** check it against a Shopify sales report before paying (spec).

## Housekeeping
- `npm audit` warnings are only in template developer tools (GraphQL code generation, ESLint 8). Update them in a quiet moment.

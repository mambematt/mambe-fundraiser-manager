# Session 4 summary: Mambe Fundraiser Manager

Completed Oct 11, 2026. Prompt: `docs/session-4-build-prompt.md`. Spec: `docs/SPEC.md` (with the "Decisions made during the build" table).

## Done criteria
1. **Met (staging).** The owner signed in to the portal from an emailed link on an iPhone and saw units, the short link and the QR code. A used link was refused, naming when it was used. The expired-link case is covered by automated tests.
2. **Met (staging).** The banner showed on the dev-store cape during its window and was gone the next day. `/go/chs-test` lands on the product and keeps working after the end.
3. **Met (staging).** A fundraiser's reminder plan appeared in its Communications log. A launch email and a reminder ("Send now") arrived at the test inbox with the right numbers.
4. **Open, by owner decision.** The live welcome-code test hasn't been done (see Decisions).
5. **Met (production, owner watching), for NS-GSB-F26:**
   - Storefront items on: the banner shows on the live Nazareth page, and the `/go/…` link works.
   - Organizer emails on: Reminder 1 (Oct 7) shows "Skipped, past due"; Oct 14 is scheduled.
   - The "Portal ready" email was sent to Trissy.
6. **Met.** All tests pass in GitHub Actions (147 passing).

## Production switch states (Oct 11, 2026)

| Fundraiser | Storefront items | Organizer emails |
|---|---|---|
| NS-GSB-F26 (Nazareth Softball, Oct 1 – Nov 15) | **On** (short link and banner name as set in the app before publishing) | **On** |

**NS-GSB-F26 email plan** (9:00 AM Pacific):

| Email | Date | Status |
|---|---|---|
| Reminder 1 | Oct 7 | Skipped, past due (emails were switched on Oct 11; never sent late) |
| Reminder 2 | Oct 14 | Scheduled |
| Reminder 3 | Oct 28 | Scheduled |
| Final 3 days | Nov 13 | Scheduled |
| Fundraiser Ended | Nov 16, first clock run after the end | Sent automatically |
| Portal ready | Oct 11 | Sent manually |

## What was built
- **Two switches per fundraiser,** both off by default and audited:
  - **Storefront items**
  - **Organizer emails**
  - Nothing reaches the live store or an organizer's inbox unless the matching switch is on. That's enforced in two places and tested.
- **Short link:**
  - A Shopify URL redirect `/go/<slug>` pointing to the product. The slug defaults from the public code and can be edited until it's written; the redirect ID is stored.
  - Re-pointed automatically (and audited) when the product's handle changes.
  - Kept after the fundraiser ends, so old flyers still work.
- **Banner:**
  - The app writes the product metafield `mambe_fundraiser.banner` (JSON with team name, rate, start and end dates).
  - Theme app extension "Fundraiser banner" with two parts:
    - an **app block**, for themes that take app blocks
    - an **app embed**, which fills a placeholder `<div id="mambe-fundraiser-banner"></div>` and is used on the EComposer product template, Shopper Approved style
  - Both show only from the start date through the end date (store time), even if the metafield were never cleared. The clock writes the field while Scheduled/Active and clears it after.
  - Editable text, default *"Through {end date}, ${rate} from every purchase goes to {team name}."*
  - A failed write is retried every 15 minutes and shown in the work queue.
- **Launch gate:** "short link written" and "banner written" are required only when Storefront items is on. Approve launch writes both first, and a Shopify failure blocks the launch. "Publish storefront items now" covers fundraisers already running.
- **Organizer portal** at `fundraise.mambeblankets.com/portal` (DNS through Microsoft 365, HTTPS by Render):
  - **Sign-in:**
    - "Email me a link" always gives the same reply, and is rate-limited per email and per IP
    - login links are 32 random bytes, stored only as a hash, single use, valid 30 minutes
    - a "Continue" press is needed to use a link
    - 45-day HttpOnly, Secure session cookie
    - CSRF double-submit check
    - "Sign out everywhere", and email change revokes sessions
    - an access log of visits (no IP or device)
  - **Content:** school/team, status, dates, days left, the short link with Copy and QR code, units and "Estimated, final after settlement" $, "updated N minutes ago", this week's suggestion, organizer-visible current assets, payout placeholder, past fundraisers and help email.
  - **Counts only:** no order numbers or customer details (tested).
  - Every query is scoped through `fundraiser_organizers`.
- **Admin:**
  - Fundraiser page: storefront section, organizer-emails section (log, Send now, Portal ready), Send portal link per organizer, and "Open portal as organizer" (read-only preview).
  - Organizer page: Send portal link, Sign out everywhere.
  - Work queue: failed emails and failing storefront writes.
  - Home: a "Send sample Klaviyo events" button that creates every metric so flows can be built before real emails fire.
- **Klaviyo:**
  - **Events:** Portal Login Link, Fundraiser Launched, Fundraiser Reminder, Fundraiser Final Days, Fundraiser Ended, Fundraiser Portal Ready, and Payout Sent (defined, fired in the settlement session).
  - **Profiles** are added to the "Fundraiser Organizers" list without marketing consent.
  - **Staging** sends every event to `KLAVIYO_TEST_RECIPIENT`.
  - **Flows:** one per metric, Smart Sending and UTM off, all live.
- **The communications table is both the schedule and the send log:**
  - The plan is created when a fundraiser launches or emails are switched on.
  - Past-due reminders are marked "Skipped, past due", and a reminder missed by more than 2 hours is never sent late.
  - Failed sends retry, then show in the work queue.
  - Date changes re-plan unsent rows; cancelling cancels them.

## Problems found on staging and fixed
1. **The anti-forgery cookie was "Strict".** iPhone browsers withheld it when the page was opened from an email, so every link looked "expired". Now "Lax"; a failed check says "press Continue once more" and doesn't use up the link.
2. **The rate limit counted blocked retries,** extending the lockout. Now only links actually sent count.
3. **My Klaviyo setup instructions put a stray `]` after the link variable,** so every sign-in link failed. Fixed in the template. The app also now ignores stray punctuation around a sign-in code.
4. **The session cookie path `/portal` didn't cover React Router's `/portal.data` request,** so sign-in bounced back to "Please sign in". The cookie path is now `/`.
5. **"Share this link: None"** appeared when no short link was published. The email now falls back to the product page address.
6. **EComposer product templates can't take app blocks.** Added the app-embed plus placeholder version.

## Decisions the owner made this session
- **Reminder schedule:** day 7, day 14, then every 14 days, plus "final 3 days" at the start of the last 3 days. A regular reminder within 5 days of the final one is skipped. All at 9:00 AM Pacific; never sent late.
- **Two switches per fundraiser, off by default.** Login-link emails ignore the emails switch, since they're sent only on request.
- **Welcome-code leak:** the Klaviyo welcome popup is **disabled for now**, so no new welcome codes go out. The welcome coupon is an "Amount off order" discount, which Shopify can't limit to a collection. The owner will fix it later. Until then, done item 4 (the live welcome-code test) stays open, and existing welcome codes may still apply to fundraiser products.
- **Banner on the live store** uses the app embed plus an EComposer custom-code placeholder near the title/price (the same pattern as Shopper Approved).
- **The NS-GSB-F26 short link and banner name** were chosen by the owner before publishing.

## Assumptions I made (not settled by the spec)
- A login link opens a page with a **Continue** button, and only that press uses the link. Email security scanners open links automatically and would otherwise use them up.
- **Rate limits:** 3 sign-in links per email per hour and 10 requests per IP per hour. IP and email are stored only as hashes, and rows are deleted after a day.
- Launch, ended and portal-ready emails may go out up to 24 hours late (for example after an outage). Reminders only up to 2 hours late; after that they're skipped.
- Organizer emails go to **every organizer** on the fundraiser (co-organizers too), not just the primary.
- Fundraisers already running when emails are switched on don't get a "launched" email; "Portal ready" replaces it.
- Turning Storefront items off removes the banner but keeps the short link (flyers keep working).
- The banner name defaults to "Organization Team" and can be edited per fundraiser.
- Portal "updated N minutes ago" means the last time Shopify sent the app anything. On the live store that's every few minutes.
- The portal's settling message gives "end date + 10 days" as the confirmation date.
- Portal wording and the "this week" suggestions live in `app/content/portal-copy.ts`, for easy editing.
- The help email comes from `PORTAL_HELP_EMAIL` on each Render service.

## Tests
- 147 pass and 4 are to-do. They run on every push.
- **Spec cases passing:** 1–20, 23 and **24**, plus Case 11's include/exclude half.
- **Still to-do:**
  - **21:** settlement re-pull fails.
  - **22:** refund after payout.
  - **Part of 11:** payout approval blocked while flags are unresolved.
  - **Second half of 20:** settlement re-pull confirms the order.
- **New this session:**
  - Case 24: another organizer's fundraiser, a used link and an expired link are all refused
  - tokens stored hashed; "email me a link" never reveals whether an email exists; rate limits, including that retries don't extend the wait
  - sessions: 45 days and sign out everywhere
  - cookie settings, CSRF, and stray punctuation around a code
  - both switches: off means no Shopify write and no Klaviyo event
  - a failed storefront write blocks launch and is retried
  - the reminder plan for 31- and 46-day fundraisers, and 9 AM Pacific across the Nov 1 change
  - past-due skipping when emails are switched on mid-campaign; never sending more than 2 hours late
  - re-planning after date changes, and cancelling
  - Fundraiser Ended sent once; Send now audited
  - banner written at launch and cleared at the end; the block's own date check
  - the short link re-pointed when the handle changes
  - the portal never shows order numbers
  - the email link falls back to the product page

## Deployed state
- **Staging and production** both run the latest code. Their cron jobs succeed every 15 minutes, and Sentry is verified on both.
- **Production:**
  - Installed on mambeblankets.com.
  - The portal is live at `https://fundraise.mambeblankets.com/portal`.
  - The banner embed is enabled on the live theme, with the placeholder in the EComposer "products/custom team hooded" template.
  - NS-GSB-F26 has both switches on.

## Next session: settlement (deadline about Nov 22; NS-GSB-F26 draft payout due about Nov 25)
- **Settling → Payout pending:** at end + 10 days, after a successful full re-pull (TODO in `app/services/jobs.server.ts`).
- **Draft payout** and adjustments.
- **Approval blocked while flags are unresolved** (Case 11's second half).
- **Frozen payout lines,** and locking the lines.
- **Ready-to-pay,** with the PayPal bulk-payment file.
- **Recording the payment,** which fires the **Payout Sent** event (its Klaviyo flow already exists).
- **Cases 20 (second half), 21 and 22.**
- **First live payout:** checked against a Shopify sales report before paying (spec). NS-GSB-F26 pays Trissy's personal PayPal (noted exception) unless a club account is provided.
- **Still open for the owner:** fix the welcome "Amount off order" coupon, then run the live welcome-code test (done item 4).

The application form and Drive folder creation come after settlement.

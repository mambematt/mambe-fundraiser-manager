# Session 4 build prompt: Mambe Fundraiser Manager

Before you start:
1. Replace `docs/SPEC.md` with the new SPEC.md I sent with this prompt. It updates the first live fundraiser (NS-GSB-F26, Oct 1 – Nov 15) and the PayPal exception. Commit it.
2. Do the owner setup in Part 0. Parts of it (DNS, Klaviyo) can take time to take effect, so start them first.

Then paste everything below the line into Claude Code.

---

This is session 4 of the Mambe Fundraiser Manager build. Read `docs/SPEC.md` (including the "Decisions made during the build" table) and `docs/session-3-summary.md` before starting.

Work with me the same way as before:
- Exact copy-paste steps.
- Stop whenever I need to click, log in or paste a secret.
- No secrets in chat or GitHub.
- Staging first for anything that touches the store or sends email.
- Never weaken a failing test.

## The big change this session: the app starts writing to the live store and emailing real people
Until now production has been read-only. This session adds the first actions people outside Mambe will see: a banner on the product page, a short link, a portal and emails. Three safety rules apply to everything below:

1. **Two separate switches on each fundraiser, both off by default:**
   - "Storefront items" controls the banner and short link.
   - "Organizer emails" controls Klaviyo events.
   - Nothing reaches the live store or a real inbox until I turn the matching switch on for that fundraiser. Turning one on or off is audited.
   - Login-link emails are the exception. They're sent only when someone asks for one, so they work whatever the emails switch says.
2. **Never send a reminder late.** When emails are switched on mid-fundraiser, any reminder whose time has already passed is marked "Skipped, past due" and never sent. No email should suddenly fire because a switch was flipped or a deploy happened.
3. **Prove it on staging first.** Everything is shown working on staging (dev store and a test inbox) before I flip any switch on production.

## Part 0: owner setup (walk me through each, then confirm it worked)
1. **Portal domain:**
   - Add `fundraise.mambeblankets.com` as a custom domain on the production Render web service.
   - Add the DNS record Render asks for. Find out with me where mambeblankets.com's DNS is managed: Shopify Domains or a registrar.
   - Do the same with a staging subdomain if Render's free URL isn't enough for testing.
   - Confirm HTTPS works.
2. **Klaviyo:**
   - Create a private API key with the minimum scopes needed to send events and create profiles, and store it in Render (staging and production).
   - Create a list called "Fundraiser Organizers". Tell me how to exclude that list from every consumer flow (welcome, abandoned cart, browse, win-back), so organizers never get consumer marketing or the welcome discount code.
   - Organizers must not be marked as subscribed to email marketing.
3. **Welcome-code leak (found in session 3):** confirm with me that the Klaviyo welcome discount, and every other active code, now excludes the Fundraiser collection.
   - Test it on the live store with the welcome code on the Nazareth blanket in a cart, without completing checkout.
   - Report the result. This is costing real money, so don't skip it.

## Part 1: short link and product-page banner
**Short link:**
- Create a Shopify URL redirect `mambeblankets.com/go/<slug>` that points to the fundraiser's product.
- The default slug comes from the public code (for example `/go/ns-gsb`) and can be edited before it's written.
- Store the redirect's ID.
- When a product's handle changes, update the redirect automatically and log it. This replaces the session-2 "logged only" gap.
- The short link stays after the fundraiser ends, so old flyers still reach the product.

**Banner:**
- Build it as a **theme app extension app block**, not by editing theme code, so it survives theme changes. I'll add the block to the product template in the theme editor; tell me exactly where.
- The block reads a product metafield the app writes: fundraiser name, team, rate and end date.
- Default text, which I can edit in the block's settings: **"Through {end date}, ${rate} from every purchase goes to {team name}."**
- **Belt and braces:** the block hides itself if today (store time) is after the end date, even if the app never cleared the metafield. The clock also writes the metafield at start and clears it at end (TODOs in `jobs.server.ts`).
- If the banner write fails, it's retried and shown in the work queue.

**Launch gate:** add "short link written" and "banner field written" (TODO in `launch-gate.ts`). They're required only when Storefront items is on.

**NS-GSB-F26 is already Active.** Add a "Publish storefront items" button for fundraisers that are already running. It writes the short link and banner field and is audited.

## Part 2: organizer portal at `fundraise.mambeblankets.com`
**Login** (spec "Security" section):
- Login links: a token of 32 or more random bytes, stored hashed, single use, 30-minute expiry.
- Using a link sets a secure, HttpOnly session cookie scoped to the portal host, lasting 45 days.
- "Email me a new link" page:
  - always replies "If we have that email, a link is on its way"
  - rate-limited per email and per IP
  - protected against cross-site request forgery
- Admin "Sign out everywhere" button for each organizer. The email-change revocation already exists.
- Access log: time and fundraiser for each visit. No IP or device fingerprinting stored.
- The organizer sees **only** fundraisers linked to them. Every portal query is scoped through `fundraiser_organizers`.

**Portal content** (mobile-first, Mambe branding, fast on a phone):
- School/team, status, dates, days left.
- **Short link**, with a copy button and a QR code generated in the page.
- **Units sold and estimated $ raised**, labelled "Estimated, final after settlement", with "updated N minutes ago".
- Counts only. **Never show order numbers, names or any customer detail.**
- **This week's suggested action**: simple rules from the day of the campaign. For example:
  - first week: "Send the launch email to your team families"
  - middle: "Post the social image in your team group chat"
  - final 3 days: "Last call: send the final reminder"
  - Keep the copy in one editable file.
- Current organizer-visible assets, using `organizerVisibleAssets()`.
- Payout status (placeholder until the settlement session) and past fundraisers.
- Help contact: an email address, which I'll supply.
- Status-specific messages:
  - Setup: "We're designing your item"
  - Settling: "Final total confirmed by {end + 10 days}"

**Admin side:**
- On the fundraiser page, a "Send portal link" button for each organizer.
- An "Open portal as organizer" preview, read-only, that doesn't create a real session.

## Part 3: Klaviyo events and the communications schedule
- **Events** (one Klaviyo metric each, properties included):
  - Portal Login Link
  - Fundraiser Launched
  - Fundraiser Reminder (with reminder number, units so far, short link, portal link, end date and days left)
  - Fundraiser Final Days
  - Fundraiser Ended
  - Payout Sent (defined now, fired in the settlement session)
  - Fundraiser Portal Ready (sent manually, for fundraisers that started before the portal existed)
- **Reminder schedule.** This is a decision I'm making now; record it in the session summary as an owner decision:
  - reminders on **day 7, day 14, then every 14 days**, plus **"final 3 days"** at the start of the last 3 days
  - skip any regular reminder that falls within 5 days of the final one
  - all times are **9:00 AM Pacific**
  - A 4-week fundraiser gets 3 emails, as the spec intended. NS-GSB-F26 (46 days) gets day 7 (past due, so skipped), Oct 14, Oct 28, and Nov 13 (final).
- **The communications table is the schedule and the send log:**
  - Rows are created when the fundraiser launches, or when emails are switched on.
  - The 15-minute clock sends rows that are due.
  - Each row shows scheduled time, sent time, status (scheduled / sent / skipped past due / failed / cancelled) and any error.
  - Failed rows retry, then appear in the work queue.
  - Changing dates re-plans unsent rows. Cancelling the fundraiser cancels its unsent rows.
- **Fill the Communications section** of the fundraiser page with this log, plus a "Send now" button for a single row (audited).
- **Klaviyo setup steps for me:**
  - one flow per metric, sending immediately
  - **Smart Sending off**, or Klaviyo may silently skip reminders
  - the template variables to use
  - a test send to my own email
- **Staging:**
  - every Klaviyo event goes to a test address I choose, never the organizer's real email
  - a `KLAVIYO_TEST_RECIPIENT` override on staging enforces it

## Tests
- **Case 24:**
  - organizer A can't see organizer B's fundraiser, even by guessing the URL
  - a used login link is refused
  - an expired login link is refused
- Login link behaviour:
  - the token is stored hashed
  - "email me a new link" never reveals whether an email exists
  - rate limit
  - "sign out everywhere"
- **Switches:**
  - with Storefront items off, no Shopify write happens
  - with Organizer emails off, no Klaviyo event is sent
- **Reminder plan:**
  - schedules for a 31-day and a 46-day fundraiser
  - past-due rows marked skipped when emails are switched on mid-campaign
  - date change re-plans; cancel cancels
  - the 9 AM Pacific time is correct across the Nov 1 daylight-saving change
- **Banner:** metafield written at start and cleared at end; the block's own end-date check.
- **Short link:** re-pointed when the handle changes.
- **Portal:** never includes order numbers or customer details.
- All existing tests pass. Report spec cases passing and still to-do.

## Done for session 4 when
1. On staging: I can log in to the portal from an emailed link on my phone, see units and the QR code, and a used or expired link is refused.
2. On staging: the banner shows on the dev-store product during the window and disappears after it, and `/go/<slug>` lands on the product.
3. On staging: a fundraiser's reminder plan appears in its Communications log, and a test reminder arrives at my test inbox with the right numbers.
4. The welcome-code test on the live store fails as it should (no discount on the Nazareth blanket).
5. **Only after 1–4,** with me watching, on production for NS-GSB-F26:
   - turn on Storefront items
   - check the banner on the live product page and that `/go/…` works
   - turn on Organizer emails and confirm day 7 shows "Skipped, past due" and Oct 14 is scheduled
   - send Trissy the "Portal Ready" email
6. All tests pass in GitHub Actions.

## End-of-session summary
Save as `docs/session-4-summary.md` in the same format as before. Include:
- the switch states on production
- each reminder's planned date for NS-GSB-F26
- decisions I made
- assumptions you made
- test status

## Next session (settlement, deadline about Nov 22)
- Settling → Payout pending after a full re-pull
- draft payout and adjustments
- approval blocked while flags are unresolved
- frozen payout lines
- Ready-to-pay with the PayPal bulk file
- recording the payment and the Payout Sent event
- Cases 20 (second half), 21 and 22

The application form and Drive folder creation come after settlement.

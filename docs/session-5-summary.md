# Session 5 summary: settlement and payouts

Completed Oct 11, 2026. Prompt: `docs/session-5-build-prompt.md`. Spec: `docs/SPEC.md`.

## Done criteria (all met)
1. **Staging, full lifecycle.** A fundraiser over Oct 1–7, with the dev store's real Oct 7 orders, settled by itself into a draft (3 units, $75). The owner then:
   - resolved the #1004 draft-order flag
   - added a −$5 adjustment
   - did the Shopify cross-check: Shopify showed 2 against the app's 3, explained by Shopify excluding test order #1003, with a note
   - approved $70, downloaded the PayPal file and recorded payment "TEST-123"
   - The fundraiser went **Paid**, the **Payout Sent** email reached the test inbox, and the portal showed "Paid $70.00 … (reference TEST-123)".
2. **Staging, failure path.** A simulated Shopify failure kept a Sep 20–30 fundraiser in **Settling**: no payout, a red "Re-pull failed" box, a work-queue item and a Sentry email. Removing the simulation let it settle on the next run.
3. **Production dry run.** NS-GSB-F26, Oct 1 to Oct 11: **9 units** in the app's dry run (full re-pull from Shopify) and **9 net items sold** in Shopify Analytics. Exact match. Estimate: 9 × $25 = **$225.00**.
4. **Restore drill.** A point-in-time restore of production into a temporary database had 1 fundraiser (NS-GSB-F26, 9 qualifying units), 58 orders, 63 order lines, 0 payouts and 102 audit entries, with the latest entry at the restore point. The temporary database was then deleted.
5. **Tests.** All 24 spec cases pass in GitHub Actions; none are to-do.

## Part 0 decisions (owner)
- **PayPal fees:** Mambe pays any PayPal fee, and the organization receives the full final amount. The PayPal file and payment record use the full amount.
- **Reopening:** an approved but unpaid payout can be reopened to draft with a required reason. Its lines unlock, the frozen snapshot is discarded, and it's audited. A paid payout can never be reopened.
- **Shopify cross-check:** required before approval for the **first 3 payouts** (counted as payouts already approved or paid). After that it's offered but optional. A count different from the app's needs a note. If the payout changes after the check, the check must be redone.

## What was built
- **Settlement clock** (in the 15-minute cron):
  - At **window end + 10 days**, computed in the fundraiser's timezone so daylight saving can't shift it. A cancelled fundraiser settles at **cancelled_at + 10 days**.
  - **The full re-pull runs first:** every order containing the product from 1 day before the window to now, as Shopify lists them, plus any the app already holds in that range. It records when the re-pull ran and how many orders it read.
  - **Only if the re-pull succeeds:** the draft payout is created, and the fundraiser moves to Payout pending. A cancelled fundraiser stays Cancelled; its payout record tracks payment.
  - **If it fails:** the fundraiser stays in Settling with "Re-pull failed: …", a Sentry alert (repeated at most every 6 hours while it keeps failing) and a work-queue item. It retries every 15 minutes, and no payout is calculated (Case 21).
  - **An order Shopify no longer has** (for example, deleted) keeps the app's last copy and is reported. It doesn't block settlement.
  - **Safe to run twice:** one payout per fundraiser.
- **The draft payout stays live until approval:** units from the attribution engine × rate, plus adjustments, gives the final amount. A refund during Payout pending changes the draft.
- **Adjustments** (draft only) need an amount (+ or −), reason, date and note. They're audited and locked after approval.
- **Approval is blocked** until:
  - the settlement re-pull has succeeded
  - every flagged line in the window is resolved (each one named; Case 11)
  - the required cross-check is done and current
  - a payee email is set
  - an individual payee is confirmed with a note
  - the final amount isn't negative
- **Individual payee:** if the payee email is an organizer's own email, approval requires "I confirm paying an individual" with a note. NS-GSB-F26 will hit this.
- **Approve:**
  - writes `payout_lines` (each counted line and its units)
  - locks **every** line attributed to the fundraiser, so nothing moves in or out
  - snapshots units, rate, amount and final, with the time and staff name
- **Reopen:** reason required; deletes the frozen lines, unlocks, re-attributes and refreshes the draft.
- **Record payment** (approved only):
  - date, PayPal transaction ID, and the amount sent (must equal the final amount, or have a note)
  - the payout becomes **Paid**, and the fundraiser moves Payout pending → **Paid**
  - fires **Payout Sent** only when Organizer emails is on, with `payout_amount`, `paypal_reference` and `paid_date`
  - audited; **Paid is final**: no edits, reopen, adjustments or line decisions afterwards
- **Changes after the freeze** (Case 22): if a refund or cancellation reaches a frozen line, the paid amount is unchanged. It's recorded once per change (`payout_changes`).
  - History: *"Refund after payout: order #…, N units ($X at the payout rate). Accepted risk, no action."* (or "after approval", suggesting a reopen)
  - A Sentry alert, and a low-priority work-queue item until marked as seen.
- **Shopify cross-check** (Payout section):
  - the store timezone, and the window in store time
  - step-by-step Analytics instructions with the exact date range
  - a CSV of the qualifying orders, with checkout time in both timezones
  - the orders within 24 hours of either window edge, with which side they fell on and why
- **Dry run** (Active/Settling, admin): a full re-pull, then shows today's units, amount and flags, with no status change and no payout record. (The order re-pull itself is a normal sync.)
- **Ready to pay** (new page): approved, unpaid payouts with total, organization, payee, amount and approval date, plus the **PayPal file**.
- **Payouts** (new page): every payout with its status, plus a **CSV for the accountant**: fundraiser, organization, team, payee, units, rate, calculated, adjustments, final, status, approved date, paid date, amount paid and PayPal reference.
- **Portal:**
  - Settling: "Final total confirmed by {date}"
  - Payout pending: "We're confirming your final total"
  - Approved: "Final: $X, payment on its way"
  - Paid: "Paid $X on {date} by PayPal (reference …)"
  - Shows the final amount and frozen units once approved; still no order details.
- **Home:**
  - "Payouts outstanding" is real (drafts and approved, final amounts)
  - work queue: payouts to review, re-pull failing, approved but not paid (with Ready to pay), refunds after a payout was frozen
- **History** in plain words for every settlement and payout action.
- **Staging-only test switches:** `SETTLEMENT_DELAY_DAYS`, `SIMULATE_REPULL_FAILURE`. They're honored only with `ALLOW_TEST_SWITCHES=true`, which production never has. They were used for done items 1–2 and removed from staging afterwards.
- `scripts/restore-check.mjs` for restore drills: counts only, and the address comes from the terminal.

## PayPal bulk payment
- **Where:** PayPal Business → **Business Tools → Make Payments → Payouts → Get Started**. Upload the CSV. It needs **Payouts access** approved on the PayPal Business account. **Still to confirm with PayPal before Nov 26:** if the Payouts option is missing or asks for approval, apply then (it can take a few business days). The fallback is paying from PayPal's normal "Send" and recording the transaction ID the same way.
- **File format** (PayPal Payouts web upload): **no header row**, one payment per row:
  `recipient email, amount, USD, reference ID, note to recipient, PAYPAL`
  - Reference ID is the fundraiser's public code (no spaces, 30 characters max).
  - The note reads "Mambe fundraiser payout {code}" (400 characters max).
  - One currency per file; up to 5,000 rows.
- **The amount is the full final amount,** because Mambe pays any fee.
- **After PayPal sends,** record each payment's transaction ID on the fundraiser page.

## Backups
- Render Postgres point-in-time recovery: **3 days** on the current (Hobby) workspace plan.
- Manual logical backups are kept 7 days.
- **Restore drill done** (see done criteria).
- **Owner decision (Oct 11):** take a **manual logical backup before each payout run** (Render → mambe-fundraisers-db → Recovery → Logical backups → Create backup; kept 7 days), rather than moving to the Pro plan. The app reminds you next to **Approve payout** and on **Ready to pay**. The spec's weekly payout CSV to Drive comes with the Drive integration.

## Assumptions I made (not settled by the spec)
- **"Window end + 10 days"** is the window end (12:00 AM after the end date) plus 10 days in the fundraiser's timezone. NS-GSB-F26 (ends Nov 15) therefore settles at **Nov 26, 12:00 AM Pacific**, and its draft is ready that morning.
- **"First 3 payouts"** counts payouts already approved or paid. A reopened payout doesn't count until it's approved again.
- **Approval locks all of the fundraiser's attributed lines,** not just the counted ones.
- **A late-arriving order** for a window whose payout is already frozen isn't added to that payout. It shows on the fundraiser's sales, and an admin can reopen the payout to include it.
- **A cancelled fundraiser with no sales** gets no payout record. With sales, it gets a draft like any other, and the fundraiser keeps the Cancelled status.
- **The individual-payee check** compares the payee email with the fundraiser's organizers' emails (case-insensitive).
- **The paid date** is stored as 12:00 PM Pacific on the date entered.

## Tests
- **169 pass, 0 to-do.** All 24 spec cases are real tests.
- **New this session:**
  - Case 11 (approval blocked until flags resolved)
  - Case 20 (settlement re-pull finds a missed order)
  - Case 21 (failed re-pull)
  - Case 22 (refund after Paid)
  - settlement timing (Oct 31 → Nov 11 PST, Nov 15 → Nov 26, cancelled + 10 days)
  - one draft when run twice; cancelled fundraisers
  - live drafts
  - adjustments (all fields required, locked after approval)
  - cross-check (required for the first 3, a note when different, stale after changes, optional for the 4th)
  - individual-payee confirmation
  - frozen lines unaffected by later Shopify changes
  - reopen
  - record payment (reference required, amount mismatch needs a note, Paid final, Payout Sent only with emails on)
  - portal payout messages
  - PayPal file format and totals; accountant CSV
  - outstanding total and work queue
  - cross-check data, including store-timezone edges
  - dry run changes nothing
  - test switches ignored without `ALLOW_TEST_SWITCHES`
- Three tests in my first draft had wrong expectations of my own (a DST time in New York, a row count, an amount format). Each was corrected against the real rule, and the code was right in each case.

## Deployed state
- **Staging and production** run the settlement code. Production's clock will settle NS-GSB-F26 on Nov 26 at 12:00 AM Pacific.
- **Production NS-GSB-F26:** Active, 9 units ($225.00 estimated) as of Oct 11. Storefront items and Organizer emails are on.

## For Nov 26 (NS-GSB-F26 payout), in order
1. **Confirm PayPal Payouts access** beforehand. On the day, start with a **manual logical backup** in Render (owner decision).
2. **Open NS-GSB-F26 → Payout.** Resolve any new flags.
3. **Do the cross-check** with the exact date range shown (first live payout: required). The spec also asks for the first 3 live payouts to be compared with a Shopify sales report; this check is that comparison.
4. **Confirm the individual payee** (Trissy's personal PayPal, the owner's noted exception), unless a club account email has been provided. If so, update the payee email first.
5. **Approve.** Then Ready to pay → PayPal file → upload in PayPal → record the transaction ID. That fires Payout Sent to Trissy.

## Still open from earlier sessions
- **Welcome coupon** ("Amount off order") still to fix; then run the live welcome-code test (session 4, done item 4).

## Next
- The application form via App Proxy, and conversion to a fundraiser.
- Drive folder creation.
- Reports, and the weekly payout CSV to Drive.

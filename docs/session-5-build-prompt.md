# Session 5 build prompt: settlement and payouts

Before you start:
1. Replace `docs/SPEC.md` with the new SPEC.md I sent with this prompt. It adds the session 4 decisions. Commit it.
2. Decide the PayPal fee question in Part 0 before pasting.

Then paste everything below the line into Claude Code.

---

This is session 5 of the Mambe Fundraiser Manager build: **settlement and payouts**. Read `docs/SPEC.md` and `docs/session-4-summary.md` first. The spec sections that matter most are:

- "Attribution rules"
- "Security and financial controls"
- "Edge cases"
- test cases 11, 20, 21 and 22

**This is the most important session of the build.** It decides how much real money each school or club receives. The deadline is real: NS-GSB-F26 ends Nov 15, so its draft payout is due about **Nov 25**. Settlement must be built, tested on staging, and dry-run against the live fundraiser well before then.

Work the same way as before:
- Exact copy-paste steps.
- Stop whenever I need to act.
- No secrets in chat or GitHub.
- Staging first.
- **Never weaken a failing test.** If a money test seems wrong, stop and explain it in plain English.

## Part 0: owner decisions (confirm with me before building)
1. **PayPal fees.** Default: **Mambe pays any PayPal fee, and the organization receives the full payout amount.** Confirm or change this. Record it in the summary.
2. **Reopening an approved payout.** Default: an approved but unpaid payout can be reopened to draft, with a required reason. Reopening unlocks its lines and discards the snapshot (audited). A **paid** payout can never be reopened. Confirm.
3. **Shopify cross-check.** The spec requires the first 3 live payouts to be checked against Shopify before payment. Default: for the **first 3 payouts** the app requires it before approval. Afterwards it's optional but still offered. Confirm. (Part 3 explains how the check works.)

## Part 1: settlement clock (Settling → Payout pending)
- **When:** at window end + 10 days. For a cancelled fundraiser, `cancelled_at` + 10 days.
- **Full re-pull first:**
  - Re-fetch from Shopify every order containing the fundraiser's product, from 1 day before the window start to now.
  - Upsert the orders and re-run attribution.
  - Record when the re-pull happened and how many orders it read.
- **Only if the re-pull succeeds:** create the draft payout and move the fundraiser to Payout pending.
- **If the re-pull fails:**
  - stay in Settling and mark it "Re-pull failed"
  - send a Sentry alert
  - show it in the work queue
  - retry on later clock runs
  - never calculate a payout from stale data (Case 21)
- Safe to run twice. A fundraiser never gets two draft payouts.
- Wire this into the existing clock (the TODO in `app/services/jobs.server.ts`).

## Part 2: draft payout
Use the existing `payouts`, `payout_lines` and `payout_adjustments` tables. Add fields if needed.

- **Draft totals:**
  - qualifying units (from the one attribution function, nothing else)
  - rate
  - calculated amount = units × rate
  - adjustments total
  - final amount
  - payee email
- **Adjustments** (draft only): amount (+ or −), reason, date and admin note are all required. Audited.
- **The draft stays live:** its numbers recompute until approval. A refund arriving during Payout pending changes the draft, not a frozen record.
- **Approval is blocked** while any flagged line in the window is unresolved. Name the lines and link to them (Case 11, second half).
- **Approval is blocked** while the required Shopify cross-check (Part 3) is missing.
- **Payee warning:** if the payee email matches an organizer's own email, show a clear warning that this is an individual, not a club. Approval then requires ticking "I confirm paying an individual" with a note. NS-GSB-F26 is the known case.

## Part 3: Shopify cross-check (before approval)
Shopify reports use the **store's timezone**, and our windows use Pacific time. A date-range report in Shopify can therefore disagree with us at the window edges even when we're both right. So the check is by order list, not by date range:

1. **The app shows:**
   - the store's timezone and the window in that timezone
   - a CSV download of every qualifying order (order name, checkout time in Pacific and store time, units, outcome)
   - a separate list of orders within 24 hours of either window edge, with which side they fell on and why
2. **The app gives me step-by-step instructions** for the Shopify Analytics report to compare against: product, date range in store time, excluding test orders.
3. **I enter the unit count Shopify shows,** then tick "Verified against Shopify". If my number differs from the app's, a note explaining the difference is required. The edge-order list should make that explanation easy.
4. All of this is saved on the payout and audited.

## Part 4: approve, freeze, pay
- **Approve:**
  - writes `payout_lines`: every line counted and its units at that moment
  - locks those lines, so later Shopify changes can't alter them
  - sets the status to approved, with time and staff name
- **Reopen** (if confirmed in Part 0): back to draft, reason required, lines unlocked, snapshot discarded, audited.
- **Ready to pay** (new admin page):
  - every approved, unpaid payout, with fundraiser, organization, payee email, amount and approval date
  - total $ at the top
  - **PayPal bulk payment file:** look up PayPal's current bulk/mass payment upload format (columns, currency, note field) and tell me which page in my PayPal Business account takes it. Generate the file for the selected payouts, with a note such as "Mambe fundraiser payout NS-GSB-F26". Before relying on it, walk me through checking that my account supports bulk payments.
- **Record payment** for each payout:
  - date, method (PayPal), PayPal transaction reference, and the amount sent, which must equal the final amount or need a note
  - moves the fundraiser to **Paid**
  - fires the **Payout Sent** Klaviyo event, only if Organizer emails is on
  - audited
  - **Paid is final:** nothing about the payout or its lines can be edited afterwards
- **After payment** (Case 22): if a refund or cancellation later hits a paid line, the paid amount stays unchanged. The fundraiser's History shows "Refund after payout: order #…, N units ($X at the payout rate). Accepted risk, no action." Also add a low-priority work-queue item so I see it once.

## Part 5: everywhere else the payout shows up
- **Fundraiser page:** fill the Payout section with status, totals, adjustments, flags blocking approval, the cross-check, the frozen line list once approved, and payment details once paid.
- **Portal:**
  - Settling: "Final total confirmed by {date}"
  - Payout pending: "We're confirming your final total"
  - Approved: "Final: $X, payment on its way"
  - Paid: amount and date
  - Show units and the final amount. Never order details.
- **Home:**
  - number strip "payouts outstanding" becomes real (approved + pending drafts)
  - work queue items for: settlements needing review, payouts approved but not paid, re-pull failures, refunds after payout
- **Payouts list:** a page listing every payout with status, plus a **CSV export for my accountant** (fundraiser, organization, payee, units, rate, adjustments, final, approved date, paid date, PayPal reference).

## Part 6: dry run on the live fundraiser, and backups
1. **Dry-run settlement** button, admin only, usable while a fundraiser is Active or Settling:
   - runs the full re-pull and shows what the draft payout would be today: units, amount, flags, edge orders
   - changes **nothing**: no status change, no payout record
   - **Run it on production for NS-GSB-F26 this session** and compare it with a Shopify report for Oct 1 to today, using the cross-check steps above
2. **Backups:**
   - Confirm production Postgres has daily backups and point-in-time recovery on our Render plan, and tell me the retention.
   - Walk me through one **restore drill** into a temporary database. Check that a fundraiser and its lines are there, then delete the temporary database.
   - This is a spec go-live check, and it matters now that money records exist.

## Tests
Turn the to-dos into real passing tests:
- **Case 11 (second half):** approval blocked until every flag in the window is resolved.
- **Case 20 (second half):** an order missing from webhooks appears after the settlement re-pull and is counted.
- **Case 21:** a failed re-pull keeps the fundraiser in Settling, flags it, calculates no payout, and retries later.
- **Case 22:** a refund after Paid leaves the paid amount unchanged, records it in History and adds a work-queue item.

Also test:
- settlement timing at end + 10 days in Pacific time, and from `cancelled_at` for a cancelled fundraiser
- running settlement twice gives one draft
- adjustments require all fields and are locked after approval
- approval blocked without the required cross-check, and blocked for an individual payee without confirmation
- approval freezes lines: a later Shopify change doesn't alter the frozen payout
- reopen behaviour (if confirmed)
- record payment moves to Paid, fires Payout Sent only when emails are on, and nothing is editable afterwards
- the PayPal file format and totals
- the accountant CSV
- dry run changes nothing

All existing tests must pass. **Target: all 24 spec cases passing, none still to-do.**

## Done for session 5 when
1. **On staging**, a fundraiser with past dates (ended 11+ days ago) settles by itself and creates a draft. I can resolve a flag, add an adjustment, do the cross-check, approve, download the PayPal file, record a payment, and see it Paid. The Payout Sent email arrives at the test inbox, and the portal shows the paid amount.
2. **On staging**, a simulated re-pull failure keeps a fundraiser in Settling, with an alert and a work-queue item.
3. **On production**, the NS-GSB-F26 dry run matches a Shopify report for Oct 1 to today, or every difference is explained order by order.
4. The restore drill worked.
5. All 24 spec cases pass in GitHub Actions.

## End-of-session summary
Save as `docs/session-5-summary.md`, same format as before. Include:
- Part 0 decisions
- the NS-GSB-F26 dry-run result
- the restore-drill result
- PayPal bulk-payment details
- test status

## After this session
- Application form via App Proxy, and Drive folder creation.
- On Nov 25: approve and pay NS-GSB-F26 after the cross-check.

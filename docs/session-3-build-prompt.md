# Session 3 build prompt: Mambe Fundraiser Manager

Before you start: replace `docs/SPEC.md` in the repo with the new SPEC.md I sent with this prompt. It adds a "Decisions made during the build" table recording what we settled in sessions 1–2. Commit it as "Update spec with build decisions".

Then paste everything below the line into Claude Code.

---

This is session 3 of the Mambe Fundraiser Manager build. The approved spec is in `docs/SPEC.md`. It has just been updated: the "Decisions made during the build" table now records what we settled in sessions 1–2, and it overrides anything older in the spec. The session 2 summary is in `docs/` too. Read both before starting.

Work with me the same way as before:
- I'm not a developer, so give exact copy-paste steps.
- Stop whenever I need to click, log in or paste a secret.
- Never put secrets in chat or GitHub.
- Changes to attribution, payouts or settlement go to staging first.
- Never weaken a failing test to make it pass.

## Why this session's order changed
Our first live fundraiser runs **Oct 1–31**, and its draft payout is due around **Nov 10**. Real orders will show us problems the dev store can't, and the sooner we see them, the more time we have to fix them before money moves.

So this session **starts by installing production on mambeblankets.com and loading the real fundraisers.** It's safe to do now: production doesn't write anything to the store yet (no banner or short links), and it sends no emails.

## Part 1: Production goes live in read-only mode (do first; stop and report after it)
1. **Install the production app on mambeblankets.com.**
   - Walk me through any Partner Dashboard approvals needed for a non-dev store, including protected customer data and read-all-orders.
   - Confirm production's `COUNT_TEST_ORDERS` is off.
2. **Send a test alert from production** (Home → Sync health) and confirm I receive it.
3. **Link the real team-cape products** for each live or upcoming fundraiser. I'll tell you which products. Let the backfill run for each one.
4. **Check the backfill against Shopify.** For each linked product:
   - Show me lifetime units and revenue from the app.
   - Walk me through getting the same numbers from Shopify Analytics. Use the product, all time, excluding test orders, and check in both units and gross sales.
   - Note any orders older than 60 days.
   - If the numbers differ, find out why before going further. Don't explain the difference away; show me the specific orders that account for it.
5. **Create the real fundraisers** with their real dates, starting with the Oct 1–31 one. I'll give you the organization, team, organizer, PayPal email and dates.
   - Its sales so far should appear as qualifying units.
   - List any lines that got review flags (bulk, discount, draft/POS, money-only refund). Real flags now are the most useful thing we can learn this week.
6. **Report in plain English:** what's installed, whether every product's backfill matches Shopify, the fundraisers created with their estimated units and payout so far, and any flags or surprises.

**Done for Part 1 when** every linked product matches Shopify Analytics (or every difference is explained order by order), and the live fundraiser shows the correct estimated units.

## Part 2: Fundraiser page (finished version)
Build the page I'll use every day for one fundraiser, using Polaris. Sections:

- **Overview:**
  - organization, team, organizers (primary first) and status badge
  - dates, with days left or days since end
  - rate and PayPal payee
  - linked product, with links to the product in Shopify admin and on the storefront
  - the public code
  - internal notes, editable
- **Estimated totals:**
  - qualifying units, estimated payout and fundraiser revenue (sum of line prices)
  - clearly labelled **"Estimated, final after settlement"**
- **Sales:** tabs or filters for Qualifying, Outside window, Refunded/cancelled, Excluded by admin and Test order (not counted).
  - Each row shows: order name linking to the order in Shopify admin, checkout date and time in Pacific, units, line price, any flag, and the outcome.
- **Flags to resolve:** every flagged line in the window, with **Include** or **Exclude** buttons. Both need a note.
  - The decision saves to the line, re-runs attribution and writes to the audit log.
  - Admins can change a decision until the payout is frozen, with a new note each time.
  - This is the include/exclude half of test case 11.
- **Setup checklist and status actions:** keep what session 2 built and move it into this layout.
- **Assets:** the minimum the portal will need in session 4.
  - Add an asset with title, kind (flyer / email copy / social image / other), a URL (Drive link or other), and visibility (internal or organizer).
  - "Replace" marks the old asset not current and links it to the new one.
  - No file uploads.
- **History:** the audit log for this fundraiser, newest first, in plain words. For example: "Matt changed start date Oct 1 → Oct 5. Reason: …"
- **Placeholders** for Communications (session 4) and Payout (settlement session). Each says what will appear there.

## Part 3: Home: work queue and number strip
**Number strip** (about 6 numbers, each linking to a filtered fundraiser list):
- Active, Scheduled and Settling counts
- payouts outstanding ($, shows $0 until settlement exists)
- qualifying units and estimated $ raised this month and year to date
- units sold outside fundraiser windows, last 30 days

**Work queue:** a list of things that need me, each with a count and a link straight to the item. Hide empty groups.
- Applications to review (empty until the form exists; keep the hook)
- Waiting on organizer more than 5 days
- Launching in the next 3 days but not yet Scheduled. Flag these in red: they won't launch without action.
- Ending in the next 7 days
- Flags to resolve, total and by fundraiser
- Settlements ready, and payouts to send (hooks for later)
- Sync problems: failed webhooks, nightly re-check older than 26 hours, webhook silence

Keep the Sync health panel on Home, below the queue.

## Part 4: Product page
For each linked product, show:
- lifetime units and revenue, split into in-window and outside-window
- the list of fundraisers on that product with their units
- unit-cost coverage: how many lines have recorded cost and how many are "cost approximate"

This is the evergreen view from the spec. Keep it simple.

## Tests
- Include/exclude: excluding a flagged line removes its units from the estimate; including it keeps them; changing the decision is audited; decisions are blocked once the payout is frozen (guard on status for now).
- Work-queue rules: each group's include/exclude logic, including the date edges ("next 3 days" and "next 7 days" in Pacific time).
- Number strip: month and year-to-date boundaries in Pacific time, and test orders excluded on production settings.
- Shopify admin order links are built correctly.
- All existing tests still pass. Report the spec case numbers that pass and the ones still to-do.

## Done for session 3 when
1. Production is installed on mambeblankets.com, every linked product's backfill matches Shopify (or each difference is explained), and the Oct 1–31 fundraiser shows its real estimated units.
2. On the fundraiser page I can see every sale, open any order in Shopify with one click, and include or exclude a flagged line with a note. The estimate updates and the history shows it.
3. Home shows the number strip and a work queue that matches what I see when I click through.
4. I can add an organizer-visible asset link to a fundraiser.
5. All tests pass in GitHub Actions.

## End-of-session summary for me
Save it as `docs/session-3-summary.md`, in the same format as the session 2 summary:
- what works and what to click to see it
- the backfill check results product by product
- real flags found on live orders
- decisions I made this session
- assumptions you made
- test status
- what's planned for session 4

Session 4 is the portal, login links, Klaviyo events, short link and banner. The settlement session must follow right after.

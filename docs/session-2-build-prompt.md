# Session 2 build prompt: Mambe Fundraiser Manager

Paste everything below the line into Claude Code, started inside your local `mambe-fundraiser-manager` folder.

---

This is session 2 of the Mambe Fundraiser Manager build. The approved spec is in `docs/SPEC.md` and remains the source of truth. Re-read these sections before writing code:

- "Locked business decisions"
- "Data model"
- "Attribution rules"
- "Statuses and setup checklist"
- "Edge cases"
- "Attribution and payout test cases"

Work with me the same way as session 1: I'm not a developer, so give exact copy-paste steps, stop when I need to click, log in or paste a secret, and never put secrets in chat or in GitHub.

## Step 0: Check where session 1 left off (do this first, then stop and report)
Before building anything new, confirm and report back to me in plain English:

1. All tests pass locally and in GitHub Actions. List which of the 24 numbered cases pass and which are still `test.todo`.
2. The app is installed on the dev store, and a new test order on the "Central High Girls Lacrosse Cape" lands in the database with its unit cost.
3. The staging and production services exist on Render, and deploys wait for GitHub checks.
4. Anything from session 1 that was skipped, stubbed or worked around.

If anything here is broken, fix it before continuing and tell me what you fixed.

## Session 2 scope: fundraiser lifecycle (build step 4)

### A. Records and linking (simple admin pages inside the embedded app, Polaris)
- Create and edit **organizations**, **teams**, **organizers** and **products**.
- Linking a product means choosing a Shopify product by searching titles. The product must be active. Warn if it lacks the `fundraiser` tag.
- Linking a product triggers the backfill job from session 1.
- Keep these pages plain. Session 3 builds the work queue and the polished fundraiser page.

### B. Fundraisers
- Create a fundraiser with:
  - team
  - linked product
  - season label
  - start date and end date (date pickers, no times)
  - timezone, defaulting to `America/Los_Angeles`
  - payout rate, defaulting to $25 and copied onto the fundraiser at creation
  - PayPal payee email (the organization's)
  - one or more organizers, one marked primary
- Generate the public code (for example `CHS-GLAX-F26`) and make it editable.
- If the overlap constraint rejects a save, show a plain message naming the conflicting fundraiser and its dates, not a database error. (Test case 16.)

### C. Statuses and transitions
- Statuses: Application, Setup, Scheduled, Active, Settling, Payout pending, Paid, Declined, Cancelled.
- Keep the allowed-transitions list in one place in code.
- Admin actions:
  - Approve (Application → Setup)
  - Decline (reason required)
  - Approve launch (Setup → Scheduled)
  - Back to Setup (from Scheduled, only before the start date, reason required)
  - Cancel (from Setup, Scheduled or Active; reason required)
- **Approve launch** is blocked until every checklist item is done, the product is active, dates and rate are set, and there's no overlap. Short link and banner aren't built yet, so leave them out of the gate for now and leave a TODO for session 4.
- **Cancel** sets `cancelled_at`. Attribution must treat the window as ending at that moment. (Test case 18.)
- **Attribution must never depend on status.** The window alone decides.
- Every transition writes to `audit_log`, with the before value, after value, reason and time.

### D. Setup checklist
Six items, each storing who completed it and when:
1. Organizer info received
2. Artwork approved
3. Product linked and active, with the `fundraiser` tag
4. Assets uploaded
5. Drive folders created
6. Launch package reviewed

For now, assets and Drive are manual checkboxes. Also add a "waiting on organizer since" date that I can set and clear.

### E. Changing dates or rate
- Allowed until Settling. A reason is required.
- Before saving, show a preview: "Qualifying units change from X to Y; estimated payout from $A to $B." Calculate it with the same attribution function, never a second calculation.
- After saving, re-run attribution for that product. The saved numbers must match the preview, and the change is audited. (Test case 19.)
- Blocked once a payout is frozen. That isn't built yet, so guard it with a status check.

### F. Scheduled jobs (Render cron)
- **Every 15 minutes, the status clock:**
  - Scheduled → Active once the start time has passed.
  - Active → Settling once the end time has passed.
  - It must be safe to run twice. Log each run.
- **Nightly re-check:**
  - Pull every order updated since the last successful run, minus a 2-day overlap. Upsert those orders and re-run attribution.
  - Record the last successful run time.
  - Send an alert email if it fails.
  - Send an alert if no webhook arrived in the past 24 hours while any fundraiser is Active. (Test case 20.)
- Define both jobs in `render.yaml` for staging and production. Tell me what to check in the Render dashboard.

### G. Tests
Turn these `test.todo` cases into real passing tests: **16, 17, 18, 19 and 20**. Also add tests for:
- the transitions list (allowed and refused moves)
- the launch gate
- the status clock being safe to repeat

All earlier tests must still pass.

## Rules (same as session 1)
- Never delete or weaken a failing test to make it pass. If you think a test is wrong, stop and explain why in plain English.
- Changes to attribution, payouts or settlement go to staging (dev store) first.
- Commit in small steps and push to `main` only when tests pass.

## Done for session 2 when
1. On the dev store I can create the Central High organization, team, organizer and fundraiser with dates a few minutes from now, approve launch, and watch it go to Active and then Settling on its own.
2. A test order placed during that window counts toward the fundraiser. One placed after it doesn't.
3. Trying to create an overlapping fundraiser on the same product shows a clear refusal.
4. Changing the start date shows the before/after preview, and the saved numbers match it.
5. Cases 16–20 pass in GitHub Actions along with everything from session 1.

## End-of-session summary for me
In plain English, tell me:
- what works now and what to click to see it
- which test cases pass and which are still todo
- anything you assumed that the spec didn't settle
- what's planned for session 3

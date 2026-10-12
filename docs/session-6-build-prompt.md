# Session 6 build prompt: application form, Drive folders, reports

Before you start:
1. Replace `docs/SPEC.md` with the new SPEC.md I sent with this prompt. It adds the session 5 decisions. Commit it.
2. Answer the Google Drive question in Part 0.

Then paste everything below the line into Claude Code.

---

This is session 6 of the Mambe Fundraiser Manager build. The money core is finished: all 24 spec cases pass, and settlement is live. This session builds the **intake funnel** (how new teams apply), **Drive folder creation**, and **reports**, and closes two small gaps.

Read `docs/SPEC.md` and `docs/session-5-summary.md` first.

Work the same way as before:
- Exact copy-paste steps.
- Stop whenever I need to act.
- No secrets in chat or GitHub.
- Staging first.
- Never weaken a failing test.

**Don't touch settlement or payout code this session** unless a test proves a bug. NS-GSB-F26 settles on Nov 26, and that code is frozen until then. If you find a bug there, stop and tell me before changing anything.

## Part 0: owner questions (confirm before building)
1. **Google Drive account type.** Find out with me whether Mambe's Drive is **Google Workspace** (shared drives available) or a **personal Google account**.
   - **Workspace:** use a service account added as Content manager to a shared drive named "Fundraising". Service accounts can't own files in a personal My Drive.
   - **Personal account:** use a one-time Google sign-in (OAuth) as me, with the refresh token stored in Render.
   - Recommend one and confirm with me.
2. **Where the form lives.** Default: a new Shopify page at `mambeblankets.com/pages/fundraise`. Confirm the URL and whether the page uses EComposer. If it does, use the app-embed-plus-placeholder pattern from the banner.
3. **Internal notification address** for new applications (for example, my email or a shared inbox).

## Part 1: application form (spec "Organizer journey" step 1)
**The form:**
- Built as a **theme app extension block**, with the app-embed fallback for EComposer.
- Fields, and only these:
  - name, email, phone
  - organization, team/sport, role
  - city, state
  - rough timing (month and season)
  - "Do you have a logo?" (yes/no)
  - optional notes
- Mobile-first and fast. Required-field checks in the browser and again on the server.
- Thank-you state: "Thanks. We'll be in touch within 2 business days."
- **I'll supply the response time.** Don't promise one I haven't confirmed.

**Submission path:**
- The form posts through Shopify **App Proxy** (`/apps/fundraise/apply`). The server verifies the App Proxy signature and rejects anything unsigned.
- Spam protection:
  - a honeypot field
  - a minimum time-on-page check
  - rate limits per IP and per email (store hashes only, as in the portal)
- **Save first, then everything else.** The raw submission goes into `applications` (status new) before any email is attempted. If an email fails, the application is never lost: the failure shows in the work queue and retries.

**Emails** (Klaviyo, using the same patterns as session 4):
- **"Application Received"** to the applicant: transactional, no marketing consent.
- **"New Application"** to the internal address from Part 0, with a link to the application in the admin.
- These aren't tied to a fundraiser, so they use one global switch, `APPLICATION_EMAILS_ENABLED`, which is off until I turn it on. Staging still sends only to `KLAVIYO_TEST_RECIPIENT`.

**Admin: applications:**
- The list is newest first, with status (new / converted / declined / spam). The work-queue "Applications to review" item becomes real.
- On the application page:
  - **Mark as spam:** hides it and needs no reason.
  - **Decline:** reason required. No automatic email; I reply personally from Outlook.
  - **Accept and create fundraiser:**
    - Match existing records before creating new ones:
      - suggest organizations by similar name plus city and state
      - suggest teams within that organization
      - suggest organizers by exact email
    - I confirm each match or choose "create new".
    - Create the fundraiser **in Setup** with the timing as a note, not dates. I set real dates later.
    - Link the application to the fundraiser (`converted_fundraiser_id`) and audit everything.
- **Statuses:** the application record now plays the "Application" stage, so new fundraisers start in Setup. Check whether anything still uses the Application status. Keep it working for any existing records, hide it from new-fundraiser choices, and tell me what you did.

## Part 2: Google Drive folders (spec "Google Drive" section)
- **When:** on "Accept and create fundraiser", and through a "Create Drive folders" button on any fundraiser that doesn't have them, including NS-GSB-F26.
- **Structure** (look folders up by stored ID, never by name):
  ```
  Fundraising/
    {Organization}/              → organizations.drive_folder_id
      {Team}/                    → teams.drive_folder_id
        _Product & Artwork/      (created once per team, reused every season)
        {Year Season}/           → fundraisers.drive_folder_id
          Organizer Assets/
          Internal/
  ```
- Reuse existing organization and team folders. Never create duplicates.
- On success, tick the "Drive folders created" checklist item automatically and show "Open in Drive" links on the fundraiser page.
- On failure, the checklist shows "Drive folders: failed" with a **Retry** button, and an item appears in the work queue. Nothing else is blocked.
- **No folder sharing.** Organizers still get individual file links through assets.

## Part 3: reports (spec "V1 reports")
A Reports page with these fixed tables, each with a CSV download:
1. Fundraisers by status, with counts.
2. Qualifying units and $ raised, by fundraiser, by team and by organization.
3. Payouts: paid vs outstanding, with totals.
4. Per product: lifetime units and revenue, split into in-window and outside-window.
5. Repeat rate: teams with more than one fundraiser, out of all teams with one.
6. Sales after a team's first fundraiser ended: units and revenue.

**Weekly payout backup** (spec "Backups"): every Monday, a cron job writes the accountant payout CSV into `Fundraising/_Backups/` in Drive, named with the date. If it fails, send an alert and add a work-queue item.

## Part 4: small gaps from earlier sessions
1. **Product deleted while its fundraiser is active:** send a Sentry alert and add a red work-queue item. Lines are kept, as they already are.
2. **Housekeeping:** update the developer-tool packages behind the `npm audit` warnings (GraphQL codegen, ESLint), but only if every test still passes. If an update needs code changes beyond config, skip it and tell me.

## Tests
- Application submit:
  - a valid signed submission is saved
  - unsigned is rejected
  - honeypot and too-fast submissions are rejected quietly
  - rate limits work
  - an email failure doesn't lose the application and is retried
- Accept and create:
  - matching suggestions
  - "create new" path
  - fundraiser created in Setup
  - application linked
  - audit entries written
- Decline needs a reason; spam hides the application.
- Drive:
  - correct structure
  - reuses organization and team folders
  - no duplicates when run twice
  - checklist auto-ticks
  - failure shows Retry and a work-queue item
  - use a fake Drive client in tests
- Reports: each table's numbers against a known set of fixtures; CSV columns.
- Weekly backup job: runs on schedule, writes the file, alerts on failure.
- Product-deleted alert.
- All existing tests pass, with all 24 spec cases still passing.

## Done for session 6 when
1. On staging, I submit the form from my phone on the dev store. The application appears in the admin, the applicant email and the internal email arrive at the test inbox, and a spam-like fast submission is ignored.
2. I accept an application. It matches an existing organization correctly, creates the fundraiser in Setup, and creates the Drive folders, and the checklist ticks itself.
3. On production, I click "Create Drive folders" for NS-GSB-F26 and see the folders in Drive.
4. The Reports page shows real NS-GSB-F26 numbers, and the CSVs download.
5. All tests pass in GitHub Actions.
6. **Only after 1–5, with me watching:** publish the form on the live `/pages/fundraise` page, turn on `APPLICATION_EMAILS_ENABLED` on production, and submit one real test application, which I'll then mark as spam.

## End-of-session summary
Save as `docs/session-6-summary.md`, same format as before. Include:
- Part 0 answers
- the live form URL
- the email switch state
- Drive setup details
- test status
- anything you'd recommend for V1.5

V1.5 candidates from the spec:
- "Run it again?" reactivation emails
- contribution-after-payout report
- organizer self-serve edits

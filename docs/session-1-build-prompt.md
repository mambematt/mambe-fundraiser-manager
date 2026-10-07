# Session 1 build prompt: Mambe Fundraiser Manager

Paste everything below the line into Claude Code, started inside your local clone of `mambe-fundraiser-manager`.

Before you start:
1. Export the spec doc as Markdown (doc menu → Export → Markdown).
2. Save it in the repo as `docs/SPEC.md`.
3. Have your Shopify Partner login, the dev store and your Render dashboard open.

---

You are building the Mambe Fundraiser Manager, a Shopify app that runs team fundraisers for Mambe Blanket Co. The full, approved spec is in `docs/SPEC.md`. Read the whole spec before writing any code. The spec is the source of truth. If anything in this prompt conflicts with it, stop and ask me.

## Who you're working with
I'm not a developer. Our last app, "Mambe-Order-Printer", was built the same way: you write the code and I run the commands you give me. Treat me that way:
- Give exact, copy-paste commands, one step at a time.
- Tell me what I should see after each command.
- If something needs me to log in, click something in Shopify or Render, or paste a secret, stop and tell me exactly what to do.
- Never ask me to paste secrets into chat or commit them to GitHub. Secrets go in `.env` (git-ignored) locally and in Render environment variables in production.

## This week's plan (5 working sessions)
- **Session 1 (today):** build steps 1–3 from the spec: foundation, Shopify read path, and the attribution engine with all 24 test cases.
- Session 2: fundraiser lifecycle (create/edit, overlap constraint, statuses, checklist, cron clock, nightly re-check).
- Session 3: admin work queue, fundraiser page, linking a product to a fundraiser.
- Session 4: organizer portal with login links, plus the Klaviyo launch and reminder events.
- Session 5: manual acceptance test on the dev store, then install on mambeblankets.com.
- After launch, before the first fundraiser's settlement date: settlement and payouts, Ready-to-pay, application form, Drive folders, product banner, short links, reports.

## Session 1 scope

### Step 1: Foundation
- Scaffold with Shopify CLI using Shopify's current app template (React Router, formerly Remix), Node, Prisma and PostgreSQL. Use Polaris for the embedded admin UI.
- It's a new app in our existing Partner account, installed on the dev store first.
- Database: PostgreSQL only. Never SQLite. Store money as integer cents and every timestamp in UTC.
- Create the full data model from the spec's "Data model" section in one migration, including:
  - a unique constraint on `order_line_items.shopify_line_item_id`
  - a unique constraint on `shopify_orders.shopify_order_id`
  - a unique constraint on webhook event ID
  - a Postgres exclusion constraint (btree_gist) that blocks overlapping windows on the same product for any fundraiser that isn't declined or cancelled. Write this as raw SQL in the migration if Prisma can't express it.
  - an append-only `audit_log`
- Set up a test runner (Vitest) and a GitHub Actions workflow that runs the tests on every push.
- Write `render.yaml` with:
  - a production web service and Postgres (Starter web and Basic-256mb Postgres; check current names)
  - a separate staging web service and Postgres connected to the dev store
  - a cron job definition, stubbed for now
- Tell me how to set Render to deploy only after GitHub checks pass.

### Step 2: Shopify read path
- Access scopes: `read_orders`, `read_all_orders`, `read_products`, `read_inventory`, `write_products`, `write_online_store_navigation`. Tell me if `read_all_orders` or protected customer data needs approval in the Partner Dashboard, and walk me through it.
- Webhooks, declared in `shopify.app.toml`: `orders/create`, `orders/updated`, `orders/paid`, `orders/cancelled`, `refunds/create`, `products/update`, `products/delete`.
- Webhook handling, in this order:
  1. Verify the HMAC.
  2. Insert into `webhook_events`. A duplicate webhook ID is a no-op.
  3. Return 200 quickly.
  4. Re-fetch the order's current state through the Admin GraphQL API.
  5. Upsert the order and its lines by Shopify ID.
  6. Keep only lines whose product is in the `products` table.
  7. Run attribution on the affected lines.
- Save no customer names, emails or addresses.
- On first save of a line, record the variant's current `inventoryItem.unitCost` as the line's unit cost. Never overwrite it later.
- Backfill job: given a product ID, load all of its historical orders through the API. Backfilled lines are marked "cost approximate".
- Products are linked manually for now, by a simple admin form or a seed script. Linking a product without the tag `fundraiser` shows a warning.

### Step 3: Attribution engine
- Write one pure function, in its own module, that decides attribution exactly as described in the spec's "Attribution rules" section. No other code may count units.
- Window rules:
  - Each fundraiser stores `start_date`, `end_date` and `timezone` (default `America/Los_Angeles`).
  - The window is computed in one helper as the half-open interval [start date 00:00 local, day after end date 00:00 local), converted to UTC.
  - Use a real timezone library, never hand-coded offsets.
  - A cancelled fundraiser's window ends at its `cancelled_at`.
- Review flags:
  - more than 4 fundraiser units on one order
  - any discount on a fundraiser line
  - draft or POS source
  - a money-only refund
- Implement all 24 test cases from the spec's "Attribution and payout test cases" table as automated tests, numbered to match. All 24 are owner-approved.
  - Cases that need later steps (settlement, portal, re-pull) can be written now as `test.todo` with the case number. List them for me at the end.
  - Every case that can run today must pass.

## Rules for every session
- Never delete or weaken a failing test to make it pass. If you think a test is wrong, stop and explain it to me in plain English.
- Anything that touches attribution, payouts or settlement is tested on staging (dev store) before production.
- Commit in small steps with clear messages. Push to `main` only when tests pass.
- At the end of the session, give me a plain-English summary:
  - what works now
  - what I should click to see it
  - which test cases pass
  - what's next

## Done for session 1 when
1. The app is installed on the dev store and visible in its admin.
2. A test order for the dev-store "Central High Girls Lacrosse Cape" appears in the database within a minute, with its unit cost recorded.
3. Running the backfill for that product gives a lifetime unit count that matches Shopify Analytics.
4. Every non-todo attribution test passes in GitHub Actions.

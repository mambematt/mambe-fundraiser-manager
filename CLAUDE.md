# Mambe Fundraiser Manager

Shopify app that runs Mambe Blanket Co.'s team fundraisers. The approved spec is
`docs/SPEC.md` and is the source of truth; stop and ask if a request conflicts with it.

The owner is not a developer: give exact copy-paste commands one step at a time,
say what they should see, and never ask for secrets in chat. Secrets live in `.env`
locally (git-ignored) and in Render environment variables.

## Rules
- Never delete or weaken a failing test to make it pass. If a test looks wrong, stop and explain it in plain English.
- `app/lib/attribution.ts` is the only code that decides attribution or counts units.
- `app/lib/window.ts` is the only code that turns fundraiser dates into UTC windows (Luxon; never hand-coded offsets).
- Money is integer cents; timestamps are UTC (`timestamptz`). PostgreSQL only.
- Never store customer names, emails or addresses.
- A line's unit cost is recorded on first save and never overwritten.
- Anything touching attribution, payouts or settlement is tested on staging (dev store) before production.
- Commit in small steps; push to `main` only when `npm test` passes.

## Layout
- `app/lib/` – pure logic (attribution, window, money, Shopify order mapping)
- `app/services/` – database and Shopify work (`*.server.ts`)
- `app/routes/webhooks.shopify.tsx` – all order/product webhooks
- `prisma/migrations/*_init/migration.sql` – ends with hand-written SQL: overlap exclusion constraint, append-only audit log
- `tests/attribution/spec-cases.test.ts` and `tests/db/spec-cases.db.test.ts` – the spec's 24 cases, numbered to match

## Commands
- `npm test` – all tests; starts a throwaway Postgres automatically
- `npm run typecheck`, `npm run lint`, `npm run build`

## Deploys
`main` → Render staging (dev store). `production` branch → Render production
(mambeblankets.com). Both deploy only after the GitHub "Tests" check passes.

## Shopify apps
Two apps, one config file each: `shopify.app.staging.toml` (dev store) and
`shopify.app.production.toml` (mambeblankets.com). Scopes and webhooks must stay
identical in both. On this Windows machine run the CLI as `shopify.cmd`.

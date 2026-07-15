# Marketplace Worker

Cloudflare Worker backing install tracking, ratings, and theme likes for the YouCoded marketplace.

## Local dev

```bash
npm ci
npm run db:migrate:local
npm run dev
```

Worker runs at http://localhost:8787. The D1 `marketplace` DB is miniflare-local; data does NOT hit production.

## Tests

```bash
npm test         # run once
npm run test:watch
```

Tests use `@cloudflare/vitest-pool-workers` against a miniflare D1 with migrations applied fresh per run.

## Deployment

Automatic on push to `master` when `worker/**` changes. Manual: `npm run deploy` with `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` set.

## Secrets

Set via `wrangler secret put <name>`:
- `GH_CLIENT_ID` — GitHub OAuth App client ID
- `GH_CLIENT_SECRET` — GitHub OAuth App client secret
- `ADMIN_USER_IDS` — comma-separated GitHub numeric ids who can use `/admin/*` (matched against the caller's GitHub identity via the `identities` table — see `src/auth/admin.ts`)

## Tail logs

```bash
npx wrangler tail
```

## Reset a single user's sessions (if a token leaks)

`user_id` is the opaque platform account id (`acct_<hex>`), not a `github:<id>`. Look it up from the caller's GitHub numeric id via the `identities` table if needed.

```bash
npx wrangler d1 execute marketplace --remote --command \
  "DELETE FROM sessions WHERE user_id = 'acct_<hex>';"
```

## Moderation workflow

1. Report arrives: `GET /admin/reports` (requires admin bearer token).
2. Inspect review: review_text is shown inline with the report row.
3. Hide: `DELETE /admin/ratings/<user_id>/<plugin_id>` — also resolves matching reports.
4. Dismiss (leave rating visible): update the report row manually:
   ```bash
   npx wrangler d1 execute marketplace --remote --command \
     "UPDATE reports SET resolved_at=strftime('%s','now'), resolution='dismissed' WHERE id='<report_id>';"
   ```

## D1 backups

D1 auto-snapshots on paid plans; on free plan, export weekly:

```bash
npx wrangler d1 export marketplace --remote --output marketplace-$(date +%F).sql
```

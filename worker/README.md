# Marketplace Worker

Cloudflare Worker backing install tracking, ratings, **thumbs + comments**, and theme likes for the YouCoded marketplace.

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

### Comments (marketplace overhaul)

Comments have **no** user-facing Report button in v1 and therefore no report queue, so the
recent-comments list *is* the queue:

- `GET /admin/comments` — the 100 most recent visible comments, newest first. Add `?hidden=1`
  to see what has already been taken down, `?limit=` up to 500.
- `DELETE /admin/comments/<id>` — hides one. Returns `404` if the id is unknown, so a stale
  list reports itself instead of claiming success.

Both need an admin GitHub identity, the same gate as `DELETE /admin/ratings/...`. Hiding sets
`hidden = 1` and **never deletes the row** — a mistaken takedown is reversible and the row is
the only record the comment existed. **This is the only takedown path in v1.**

`POST /comments` runs the same `llama-guard-3-8b` classifier as reviews; flagged text is
stored with `hidden = 1` and never listed by `GET /comments/<id>`. Note the classifier
**fails open** when the AI binding is missing, and it is missing under test — so this path is
only ever exercised in production, which is exactly why the admin routes above exist.

Thumbs (`POST /thumbs`) carry no text and are not classified; they are install-gated instead
(one vote per account per plugin, `value: null` clears it).

### Catalog

- `GET /admin/catalog/health` — is the catalog still being fed? Reports the catalog version
  and, per source, how many listings are live, when its last ingest run finished, and what
  that run retired. Same admin GitHub identity as the takedown routes above. A stalled ingest
  raises no error anywhere — the rows simply stop changing — so a `lastFinishedAt` that is
  hours old is the only tell. (GitHub also disables a repo's `schedule:` triggers after 60
  days of no activity.)
- `POST /admin/catalog/upsert` / `POST /admin/catalog/finish` / `GET /admin/catalog/shas` —
  the hourly ingest job's own routes. Gated by the `CATALOG_INGEST_TOKEN` shared secret in the
  `X-Catalog-Token` header, not by an admin session: the caller is a GitHub Action.

## D1 backups

D1 auto-snapshots on paid plans; on free plan, export weekly:

```bash
npx wrangler d1 export marketplace --remote --output marketplace-$(date +%F).sql
```

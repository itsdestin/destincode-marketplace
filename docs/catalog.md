# The catalog

The catalog is the list of everything the marketplace shows. The app asks the Worker for it,
the Worker keeps it in its database, and a job in GitHub Actions rebuilds it once an hour from
four upstream sources.

Before this existed, the app read a single file (`index.json`) straight from GitHub. That file
is still there and is still the fallback, but it carries only the bare facts about a listing —
its name, description and where to clone it. The catalog adds the block the store actually
renders: what kind of thing it is, who published it, whether we have looked at this version's
files, what it can do once installed, its licence, and the exact commit we checked.

## The four sources

| Source | What it contributes | Licence position |
|---|---|---|
| `wecoded` / `anthropic` | Our own registry — the YouCoded plugins and the mirrored Anthropic official list, each as a bundle **plus one row per skill, specialist and connection inside it** | ours MIT; the 53 local Anthropic plugins are Apache-2.0, the rest are pointers to their own repos |
| `docker` | Docker's MCP catalog — the **Connections** tab | the Docker repo is MIT but the served JSON is unlicensed, so we store **metadata only** and link out |
| `awesome-copilot` | `github/awesome-copilot` — plugins, skills, specialists, instructions | MIT |
| `cursorrules` | `PatrickJS/awesome-cursorrules` — one prompt per rule file | CC0-1.0 |

## Running it

```bash
# Safe: reads everything, writes catalog-dry-run-<source>.json, POSTs nothing.
GITHUB_TOKEN=$(gh auth token) node scripts/catalog/build.mjs --source docker --dry-run

# Tests. Unquoted glob: the shell expands it, so this works on any Node version.
node --test scripts/catalog/test/*.test.mjs
```

Flags: `--source <name>` (one source; default all) · `--dry-run` · `--force-rescan` ·
`--allow-mass-retire`. Env: `GITHUB_TOKEN` (required), `CATALOG_INGEST_TOKEN` (required unless
`--dry-run`), `CATALOG_HOST` (defaults to the production Worker).

## The kill switch — read this first in an emergency

`CATALOG_ENABLED` is a plain variable in `worker/wrangler.toml`. Set it to `"0"`, commit, and
merge: `GET /catalog` starts answering 503, and **both apps treat that exactly like any other
failure and fall back to `index.json`.** No user sees an error.

This exists because a bad ingest run reaches every device within the hour, and without it the
only remedy would be writing and deploying code under pressure.

## Four rules that make an unattended hourly job safe

Each of these exists because of a specific way this could quietly go wrong.

**1. Never downgrade.** If a run arrives without a fact the stored row already has — stars,
licence, commit, publish date — the stored value stays. An incoming "not checked" never
overwrites a real verdict. *Why:* a run that ran out of GitHub budget is not evidence that a
licence vanished, and a run that could not read a repo is not evidence that the repo became
unsafe. Without this, one bad hour would flip "Likely safe" to "Not checked" across the whole
grid and back again the next hour.

**2. Only re-read what changed.** The job asks the Worker which commit it already has for each
listing and re-downloads a plugin's files only when the upstream tip has moved. An unchanged
listing is **not sent at all** — it is reported as *skipped*, which still counts as "seen".
*Why:* re-reading everything is roughly 6,000 file downloads an hour; this makes it dozens.

**3. Never write an unchanged row.** The Worker merges each incoming row onto the stored one
and, if the result is byte-for-byte identical, writes nothing. *Why:* the database allows
100,000 row-writes a day. Rewriting every row hourly just to mark it "seen" would spend most of
that on rows that did not change.

> **The corollary that bites: no row may carry a value that moves on its own.** If one does,
> rows differ every hour, rule 3 never fires, and — worse — the catalog version moves, which
> changes the ETag, which makes **every device re-download the whole multi-megabyte catalog
> every hour**, Android over mobile data.
>
> This has happened **twice**, and the second time is the one to learn from.
>
> **First, a synthetic stamp.** Our own `local` plugins have no upstream commit to compare, so
> their files are re-read every run and stamped with a fresh `scan.checkedAt`. That one field
> made 71 rows differ hourly.
>
> **Then a real one.** `catalog.stars` — a genuine GitHub star count, updated honestly from the
> API. `agent-sdk-dev` went 35664 → 35665 and the row was rewritten. Snapshot-diffing
> `GET /catalog` either side of one run showed **97 rows differing and `catalog.stars` as the
> only field that moved**, on a value **neither the desktop app nor Android ever displays**.
> After the fix the same experiment gave 1 differing row.
>
> **So the rule is not "don't stamp timestamps" — it is "nothing may drift faster than what a
> user can see".** A star count, a download total, a "last pushed" date and a run id all break
> it identically, and the legitimate-looking ones are the dangerous ones, because they survive
> review. When you add a field, ask what moves it and how often. If it can move while nothing
> a person would notice has changed, exclude it from the change comparison in
> `mergeOntoStored`: keep the stored value, and take the incoming one only when the row already
> differs for another reason. Nothing will alert you if you get this wrong — the symptom is a
> bandwidth bill and a slow app, not an error.

**4. Never mass-retire on one bad run.** Retirement is an explicit list of ids computed by the
ingest, and the Worker **refuses** any run trying to delist more than a fifth of a source
(sources under 10 rows are exempt). A refusal is recorded and turns the run red. *Why:* the day
an upstream project renames a folder we would collect 12 rows instead of 257, and without this
the other 245 would silently vanish from everyone's app. A long retire list is evidence of a
broken scraper, not of 245 deletions. Override with `--allow-mass-retire` **only** for a real
bulk removal.

## Changing the scanner

`SCAN_RULES_VERSION` in `scripts/catalog/lib/capabilities.mjs` is half of the key used to
decide whether a listing needs re-reading (`<commit>:<rules>`). **Bump it in the same commit as
any change to the scan rules.** That bump *is* the rescan: the next hourly run finds every
stored verdict stale and re-reads the corpus once. Reach for `--force-rescan` only in an
emergency — a routine rule change should never depend on someone remembering to run it.

## What "Likely safe" means today

It means: we fetched this version's files and a **rule-based** scan found nothing on its list —
no piping a download straight into a shell, no executing decoded text, no hard-coded keys, no
deleting outside its own folder. It is not a guarantee, and it is not a human review. A deeper
second stage (SkillSpector / the Cisco skill scanner) is the next step and is on the roadmap.

Three states, and the difference matters:
- **checked** — files were fetched and scanned, nothing found.
- **caution** — files were scanned and something on the list was found; the finding is shown.
- **unchecked** — the files could **not** be read (rate limit, no repo, a mirrored listing we
  only hold metadata for). Never "checked" without having actually read the files.

4 of the 302 bundles are `unchecked` today. It was 54 until 2026-08-31: 53 of those were
Anthropic plugins recorded with a path inside *Anthropic's own* repository
(`./plugins/agent-sdk-dev`) rather than ours, so there was nothing in our checkout to fetch.
The fetcher now reads them from `anthropics/claude-plugins-official`, which was verified to
hold all 53 of those paths.

> **A subfolder that matches nothing in the tree is now `unchecked`, not `checked`.** This is
> the same trap as the unreadable file list above, one level down: a `sourceSubdir` that is not
> in the tree we fetched yields an *empty* file list, an empty list scans clean, and the
> listing gets a clean bill of health for files nobody read. Found on the 2026-08-31 dry run:
> the three `netsuite-*` plugins live on the branch `ai-plugins-dist`, but the ingest reads a
> repository's **default** branch, where the folder `anthropic/netsuite-suitecloud` does not
> exist — 0 matching paths on `master`, 8 on `ai-plugins-dist` — so all three (13 rows counting
> their members) had been stamped "Likely safe" having read nothing. They now correctly report
> `unchecked`. **The root cause is still open:** index.json records `sourceGitRef:
> "ai-plugins-dist"` and the ingest ignores it, pinning every listing to its repo's default
> branch. 4 entries name a non-default ref today.

## How a human checks it is still alive

A stalled ingest produces **no error anywhere** — the rows simply stop changing. Two things to
look at:

- `GET /admin/catalog/health` (admin sign-in required) reports, per source, how many live rows
  there are and when it last finished. A source whose `lastFinishedAt` is hours old is the
  tell. It also reports `publishedVersion` alongside `version`: if those diverge and stay
  diverged across a run that changed rows, the pre-built copy is failing silently and every
  request is quietly paying the slow price.
- The workflow itself. `build.mjs` exits non-zero when any source errors, is refused by the
  retire guard, or sees zero rows, so a broken scraper turns the run red and GitHub emails the
  repo owner. **That is the only alarm.**

> **The hole neither covers:** GitHub silently disables `schedule:` triggers on a repository
> after 60 days with no activity. A dead cron produces no failures at all — just a catalog
> frozen at its last good hour. `catalog-ingest.yml` is the first scheduled workflow this repo
> has ever had, so this rule has never applied here before.

## Where things live

- `scripts/catalog/lib/` — shared helpers (`http`, `entry`, `capabilities`, `worker`)
- `scripts/catalog/sources/` — one file per source, each exporting a pure `normalise` and a
  `collect`
- `scripts/catalog/build.mjs` — the orchestrator; computes the retire list
- `worker/src/catalog/` — the serve side: `routes.ts`, `publish.ts`, `auth.ts`
- `.github/workflows/catalog-ingest.yml` — hourly at :13

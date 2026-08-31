#!/usr/bin/env node
// Catalog ingest — pulls every source, normalises, upserts to the Worker.
//   node scripts/catalog/build.mjs [--source <name>] [--dry-run] [--force-rescan] [--allow-mass-retire]
// Env: CATALOG_INGEST_TOKEN (required unless --dry-run), GITHUB_TOKEN (required),
//      CATALOG_HOST (default https://wecoded-marketplace-api.destinj101.workers.dev)
import fs from "node:fs";
import { createWorkerClient } from "./lib/worker.mjs";
import { CATALOG_SOURCES } from "./lib/entry.mjs";

const args = new Set(process.argv.slice(2));
const pick = (flag) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : undefined; };
const only = pick("--source");
const dryRun = args.has("--dry-run");
const forceRescan = args.has("--force-rescan");
// Deliberate override for a real bulk removal upstream. Without it the Worker refuses to
// delist more than a fifth of a source in one run — see Task 6, "the retire guard".
const allowMassRetire = args.has("--allow-mass-retire");
const host = process.env.CATALOG_HOST ?? "https://wecoded-marketplace-api.destinj101.workers.dev";

const SOURCES = {
  wecoded: () => import("./sources/wecoded.mjs"),
  docker: () => import("./sources/docker.mjs"),
  "awesome-copilot": () => import("./sources/awesome-copilot.mjs"),
  cursorrules: () => import("./sources/cursorrules.mjs"),
};

const runId = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${process.env.GITHUB_RUN_ID ?? "local"}`;
const client = dryRun ? null : createWorkerClient({ host, token: process.env.CATALOG_INGEST_TOKEN ?? (() => { throw new Error("CATALOG_INGEST_TOKEN missing"); })() });
const report = { runId, sources: {} };
const names = only ? [only] : Object.keys(SOURCES);

for (const name of names) {
  if (!SOURCES[name]) throw new Error(`unknown source ${name}; known: ${CATALOG_SOURCES.join(", ")}`);
  const started = Date.now();
  try {
    const { collect } = await SOURCES[name]();
    // What the catalog already holds: every LIVE id → "<commit>:<rules>", one map per
    // Worker source (wecoded emits under "wecoded" AND "anthropic"). Two jobs: the source
    // compares values to skip re-reading unchanged repos, and this loop uses the KEY SET
    // to work out what to retire. --force-rescan blanks the values but keeps the keys —
    // a full re-read must still know what exists.
    const workerSources = name === "wecoded" ? ["wecoded", "anthropic"] : [name];
    const knownBySrc = {};
    for (const src of workerSources) knownBySrc[src] = client ? await client.shas(src) : {};
    const known = forceRescan ? {} : Object.assign({}, ...Object.values(knownBySrc));
    // `skipped`: ids the source saw but did not emit because nothing about them changed
    // (rule 2). They count as SEEN — never as retired — and cost the Worker nothing.
    const { entries, sources: subSources, skipped = [] } = await collect({ known, log: (m) => console.log(`[${name}] ${m}`) });
    const groups = subSources ?? { [name]: entries };
    const skippedSet = new Set(skipped);
    for (const [src, rows] of Object.entries(groups)) {
      if (dryRun) { fs.writeFileSync(`catalog-dry-run-${src}.json`, JSON.stringify(rows, null, 2)); console.log(`[${src}] dry-run: ${rows.length} rows, ${skipped.length} skipped`); continue; }
      const sent = new Set(rows.map((r) => r.id));
      const skippedHere = Object.keys(knownBySrc[src]).filter((id) => skippedSet.has(id)).length;
      // The retire list: what the catalog holds for this source minus what this run saw.
      // Computed HERE so the Worker never has to write a row to learn it is still alive.
      const retire = Object.keys(knownBySrc[src]).filter((id) => !sent.has(id) && !skippedSet.has(id));
      const { upserted, unchanged } = await client.upsert(src, runId, rows);
      const { retired, refused } = await client.finish(src, runId, retire, undefined, allowMassRetire);
      report.sources[src] = { sent: rows.length, upserted, unchanged, skipped: skippedHere, retired, ...(refused ? { refused } : {}), ms: Date.now() - started };
      console.log(`[${src}] sent ${rows.length} (wrote ${upserted}, unchanged ${unchanged}), skipped ${skippedHere}, retired ${retired}`);
      // A refusal means this run saw a fraction of what the catalog holds — a broken
      // scraper, an upstream rename, a rate limit. Nothing was delisted (that is the guard
      // working), but the run is NOT healthy and must not look green.
      if (refused) {
        console.error(`[${src}] REFUSED: this run saw only ${refused.live - refused.wouldRetire} of ${refused.live} live rows — retiring ${refused.wouldRetire} was blocked. ` +
          `Fix the source, or re-run with allow_mass_retire if the removal is real.`);
        process.exitCode = 1;
      }
    }
  } catch (err) {
    report.sources[name] = { error: String(err && err.message || err) };
    console.error(`[${name}] FAILED: ${err && err.stack || err}`);
    process.exitCode = 1;
  }
}

// A source that ran, threw nothing, and saw nothing is the silent failure this whole job
// is exposed to: the catalog would simply freeze at yesterday's data while the workflow
// stayed green. "Saw" is sent + skipped — a source that was genuinely unchanged reports
// everything as skipped and passes.
for (const [src, r] of Object.entries(report.sources)) {
  if (!r.error && !r.refused && (r.sent ?? 0) + (r.skipped ?? 0) === 0) {
    console.error(`[${src}] saw 0 rows — the source is broken or its upstream moved.`);
    process.exitCode = 1;
  }
}
fs.writeFileSync("catalog-report.json", JSON.stringify(report, null, 2));
if (process.exitCode) console.error(`\ncatalog ingest finished WITH ERRORS — see catalog-report.json`);

#!/usr/bin/env node

// sync.js — Build skills/index.json from two sources:
//   1. Local marketplace.json (YouCoded/community entries)
//   2. Anthropic's marketplace.json (fetched from GitHub or --local path)
//
// Usage:
//   node scripts/sync.js                          # fetch upstream from GitHub
//   node scripts/sync.js --local <repo-path>      # read from local clone
//   node scripts/sync.js --local-hash             # compute content hashes for local plugins
//
// Key behaviors:
//   - Diffs against previous skills/index.json to detect changes
//   - Bumps patch version when entry metadata or SHA changes
//   - Flags removed upstream entries as deprecated (never deletes)
//   - Preserves upstream SHA for url/git-subdir entries
//   - Idempotent: no-change runs produce identical output
//   - Adds top-level version timestamp to generated index

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const https = require("https");

const { normalizeTags } = require("./schema");
const {
  extractLocalComponents,
  extractRemoteComponents,
  RateLimitError,
} = require("./extract-components");

const SKILLS_INDEX_PATH = path.join(__dirname, "..", "skills", "index.json");
const LOCAL_MARKETPLACE_PATH = path.join(__dirname, "..", "marketplace.json");
const OVERRIDES_DIR = path.join(__dirname, "..", "overrides");
const SYNC_REPORT_PATH = path.join(__dirname, "..", "sync-report.json");

const UPSTREAM_RAW_URL =
  "https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/.claude-plugin/marketplace.json";

// Anthropic's `source: "<path>"` strings resolve inside this repo at HEAD.
// Used only by extractForEntry when converting anthropic-local → git-subdir.
const ANTHROPIC_UPSTREAM_REPO = "https://github.com/anthropics/claude-plugins-official.git";
const ANTHROPIC_UPSTREAM_REF = "main";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function titleCase(kebab) {
  const acronyms = new Set(["ai", "api", "aws", "ci", "cd", "cli", "cms", "css", "db", "dba",
    "dns", "gcp", "gpu", "html", "http", "ide", "js", "json", "jwt", "lsp", "mcp", "ml",
    "npm", "pdf", "pr", "qa", "sdk", "sql", "ssh", "ssl", "tls", "ui", "url", "ux", "xml"]);
  return kebab
    .split("-")
    .map((w) => {
      const lower = w.toLowerCase();
      if (acronyms.has(lower)) return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    // Same pattern extract-components.js uses: opt-in auth via GITHUB_TOKEN
    // bumps the per-IP rate limit from 60/hr (anon) to 5000/hr (authenticated)
    // so a full sync doesn't blow the budget on a developer machine.
    const headers = { "User-Agent": "wecoded-marketplace-sync" };
    if (process.env.GITHUB_TOKEN) {
      headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }
    const get = (u) => {
      https
        .get(u, { headers }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            get(res.headers.location);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode} for ${u}`));
            return;
          }
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error(`JSON parse error: ${e.message}`));
            }
          });
        })
        .on("error", reject);
    };
    get(url);
  });
}

function loadOverride(id) {
  const overridePath = path.join(OVERRIDES_DIR, `${id}.json`);
  if (fs.existsSync(overridePath)) {
    try {
      return JSON.parse(fs.readFileSync(overridePath, "utf8"));
    } catch (e) {
      console.warn(`  WARNING: bad override file ${overridePath}: ${e.message}`);
    }
  }
  return null;
}

// Bump patch version: "1.0.0" -> "1.0.1", "1.2.3" -> "1.2.4"
function bumpPatch(version) {
  const parts = (version || "1.0.0").split(".");
  if (parts.length !== 3) return "1.0.1";
  parts[2] = String(parseInt(parts[2], 10) + 1);
  return parts.join(".");
}

// Compute a stable content hash for a directory (for local plugin change detection)
function hashDirectory(dirPath) {
  const hash = crypto.createHash("sha256");
  const entries = [];

  function walk(dir, prefix) {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        // Skip .git and node_modules
        if (name === ".git" || name === "node_modules") continue;
        walk(full, rel);
      } else {
        entries.push(rel);
        hash.update(rel);
        hash.update(fs.readFileSync(full));
      }
    }
  }

  try {
    walk(dirPath, "");
  } catch (e) {
    return null; // Directory doesn't exist or isn't readable
  }
  return hash.digest("hex").slice(0, 12); // Short hash is sufficient
}

// ---------------------------------------------------------------------------
// Source parsing — extracts install info from upstream source field
// ---------------------------------------------------------------------------

function parseSource(upstream) {
  const src = upstream.source;
  if (typeof src === "string") {
    return { sourceType: "local", sourceRef: src };
  }
  if (src && src.source === "local") {
    // In-repo plugin — source lives at <repo>/<path>. Used by plugins bundled
    // into the marketplace repo itself (see decomposition-v3 pattern).
    return { sourceType: "local", sourceRef: src.path };
  }
  if (src && src.source === "url") {
    // Preserve upstream SHA for future update detection
    const result = { sourceType: "url", sourceRef: src.url };
    if (src.sha) result.sourceSha = src.sha;
    return result;
  }
  if (src && src.source === "git-subdir") {
    // Preserve upstream SHA and ref (branch) for future update detection
    const result = {
      sourceType: "git-subdir",
      sourceRef: src.url.startsWith("http") ? src.url : `https://github.com/${src.url}.git`,
      sourceSubdir: src.path,
    };
    if (src.sha) result.sourceSha = src.sha;
    if (src.ref) result.sourceGitRef = src.ref;
    return result;
  }
  if (src && src.source === "github") {
    return { sourceType: "url", sourceRef: `https://github.com/${src.repo}.git` };
  }
  return { sourceType: "unknown", sourceRef: JSON.stringify(src) };
}

// ---------------------------------------------------------------------------
// Entry mapping — converts a catalog entry to an index entry
// ---------------------------------------------------------------------------

function mapEntry(upstream, sourceMarketplace, ownerName, isPrompt) {
  const id = upstream.name;

  const entry = {
    id,
    type: isPrompt ? "prompt" : "plugin",
    displayName: upstream.displayName || titleCase(id),
    description: upstream.description || "",
    category: upstream.category || "other",
    author: upstream.author?.name || ownerName,
    // Tags flow through TAG_ALIASES + enum filter. Unknown values drop silently
    // here; CI is where out-of-enum values hard-fail on PRs.
    tags: normalizeTags(upstream.tags || []),
    version: "1.0.0",
    publishedAt: new Date().toISOString().split("T")[0] + "T00:00:00Z",
    sourceMarketplace,
  };

  if (isPrompt) {
    entry.prompt = upstream.prompt || "";
    if (upstream.authorGithub || upstream.author?.github) {
      entry.authorGithub = upstream.authorGithub || upstream.author.github;
    }
  } else {
    // Plugin — extract source info
    const sourceInfo = parseSource(upstream);
    Object.assign(entry, sourceInfo);
    entry.repoUrl = upstream.homepage || null;
  }

  // Apply overrides (never override structural fields). Overrides are the
  // canonical place to set tagline/longDescription/lifeArea/audience — these
  // are human-curated fields; sync.js never invents them.
  const override = loadOverride(id);
  if (override) {
    Object.assign(entry, override);
    entry.id = id;
    entry.sourceMarketplace = sourceMarketplace;
    // Re-normalize tags if the override supplied any.
    if (override.tags) entry.tags = normalizeTags(override.tags);
  }

  return entry;
}

// Extract components for one entry. Mutates the entry to add `components` or
// `componentsError`. Reuses `cache` keyed by sourceSha for remote entries so
// that re-syncs with unchanged SHAs never re-fetch.
//
// Returns { ok: bool, error?: string } for sync-report aggregation.
async function extractForEntry(entry, cache) {
  if (entry.type === "prompt") {
    // Prompts have no components — skip without marking as an error.
    return { ok: true };
  }
  let result;
  if (entry.sourceType === "local" && entry.sourceMarketplace === "anthropic") {
    // Anthropic "local" entries are paths inside the upstream plugin repo,
    // not our repo. Route through the remote Tree API with a synthesized
    // git-subdir entry. Cache key folds in the upstream ref so a re-sync
    // against a different upstream commit invalidates correctly.
    const subdir = (entry.sourceRef || "").replace(/^\.\//, "").replace(/\/$/, "");
    const synthetic = {
      sourceType: "git-subdir",
      sourceRef: ANTHROPIC_UPSTREAM_REPO,
      sourceSubdir: subdir,
      sourceGitRef: ANTHROPIC_UPSTREAM_REF,
      // No sourceSha — extractRemoteComponents will resolveRef() once and cache.
    };
    result = await extractRemoteComponents(synthetic, cache);
  } else if (entry.sourceType === "local") {
    const dir = path.join(__dirname, "..", entry.sourceRef || "");
    result = extractLocalComponents(dir);
  } else if (entry.sourceType === "url" || entry.sourceType === "git-subdir") {
    result = await extractRemoteComponents(entry, cache);
  } else {
    result = { components: null, componentsError: "unknown-source-type" };
  }
  if (result.components !== undefined) entry.components = result.components;
  if (result.componentsError) entry.componentsError = result.componentsError;
  return { ok: result.components !== null, error: result.componentsError };
}

// Check if two entries have meaningful differences (ignoring version/publishedAt)
function hasChanges(oldEntry, newEntry) {
  // Fields that indicate real content changes
  const compareKeys = [
    "description", "category", "author", "displayName", "type", "authorGithub",
    "sourceType", "sourceRef", "sourceSubdir", "sourceSha", "sourceGitRef",
    "repoUrl", "prompt", "tags",
  ];
  for (const key of compareKeys) {
    const oldVal = JSON.stringify(oldEntry[key] ?? null);
    const newVal = JSON.stringify(newEntry[key] ?? null);
    if (oldVal !== newVal) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Parse args
  let localPath = null;
  let computeLocalHash = false;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--local" && args[i + 1]) {
      localPath = args[++i];
    }
    if (args[i] === "--local-hash") {
      computeLocalHash = true;
    }
  }

  // Ensure skills/ directory exists
  const skillsDir = path.dirname(SKILLS_INDEX_PATH);
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }

  // Load previous index for diffing
  let previousIndex = [];
  if (fs.existsSync(SKILLS_INDEX_PATH)) {
    try {
      const prev = JSON.parse(fs.readFileSync(SKILLS_INDEX_PATH, "utf8"));
      previousIndex = prev.entries || prev; // Handle both wrapped and raw formats
    } catch (e) {
      console.warn(`WARNING: could not read previous index: ${e.message}`);
    }
  }
  const previousById = new Map(previousIndex.map(e => [e.id, e]));
  console.log(`Previous index: ${previousIndex.length} entries`);

  // --- Source 1: Local marketplace.json (YouCoded/community) ---
  let localMarketplace = { plugins: [] };
  if (fs.existsSync(LOCAL_MARKETPLACE_PATH)) {
    localMarketplace = JSON.parse(fs.readFileSync(LOCAL_MARKETPLACE_PATH, "utf8"));
    console.log(`Local marketplace.json: ${(localMarketplace.plugins || []).length} entries`);
  } else {
    console.warn("WARNING: no marketplace.json found — YouCoded entries will come from previous index");
  }

  const localEntries = [];
  for (const upstream of (localMarketplace.plugins || [])) {
    const isPrompt = upstream.type === "prompt";
    const entry = mapEntry(upstream, "youcoded", localMarketplace.owner?.name || "YouCoded", isPrompt);

    // WHY: bundled plugins (and any in-repo plugin with a plugin.json version)
    // must be listed under the SAME version the app reads from plugin.json —
    // the app's "Update available" badge compares the two. Plugins without a
    // manifest version keep the synthetic bump-on-metadata-change below.
    // WHY: entry.sourceRef is undefined for a malformed source (e.g. a
    // community entry shaped {"source": "local"} with no "path" — parseSource
    // returns src.path unchecked). path.join(..., undefined) throws, and that
    // throw would sit outside the manifest read's try/catch below and kill the
    // whole rebuild over one bad entry. Skip manifest-version lookup instead.
    if (!isPrompt && entry.sourceType === "local" && typeof entry.sourceRef === "string" && entry.sourceRef) {
      const pluginDir = path.join(__dirname, "..", entry.sourceRef);
      for (const rel of ["plugin.json", ".claude-plugin/plugin.json"]) {
        try {
          const v = JSON.parse(fs.readFileSync(path.join(pluginDir, rel), "utf8")).version;
          if (typeof v === "string" && v) { entry.version = v; entry.manifestVersion = true; break; }
        } catch { /* no manifest here — try the next layout */ }
      }
    }

    // For local-source plugins, compute content hash if flag is set
    if (computeLocalHash && !isPrompt && entry.sourceType === "local") {
      const pluginDir = path.join(__dirname, "..", entry.sourceRef);
      const hash = hashDirectory(pluginDir);
      if (hash) entry.sourceSha = hash;
    }

    localEntries.push(entry);
  }

  const localIds = new Set(localEntries.map(e => e.id));
  console.log(`YouCoded entries mapped: ${localEntries.length}`);

  // --- Source 2: Upstream Anthropic marketplace.json ---
  let upstreamMarketplace;
  if (localPath) {
    const mpPath = path.join(localPath, ".claude-plugin", "marketplace.json");
    if (!fs.existsSync(mpPath)) {
      console.error(`marketplace.json not found at ${mpPath}`);
      process.exit(1);
    }
    upstreamMarketplace = JSON.parse(fs.readFileSync(mpPath, "utf8"));
    console.log(`Upstream from local path: ${mpPath}`);
  } else {
    console.log(`Fetching upstream marketplace.json from GitHub...`);
    upstreamMarketplace = await fetchJson(UPSTREAM_RAW_URL);
  }

  const upstreamPlugins = upstreamMarketplace.plugins || [];
  const marketplaceName = upstreamMarketplace.name || "claude-plugins-official";
  const ownerName = upstreamMarketplace.owner?.name || "Anthropic";
  console.log(`Upstream plugins found: ${upstreamPlugins.length}`);

  // Validate upstream
  const valid = upstreamPlugins.filter(p => p.name && p.source);
  const invalid = upstreamPlugins.length - valid.length;
  if (invalid > 0) {
    const pct = (invalid / upstreamPlugins.length) * 100;
    console.warn(`  WARNING: ${invalid} entries missing name or source (${pct.toFixed(1)}%)`);
    if (pct > 20) {
      console.error("  ABORT: >20% invalid entries — upstream schema may have changed");
      process.exit(1);
    }
  }

  // Map upstream entries, skipping any that conflict with local IDs
  const upstreamEntries = [];
  const skipped = [];
  for (const upstream of valid) {
    if (localIds.has(upstream.name)) {
      skipped.push(upstream.name);
      continue;
    }
    // Auto-stamp sourceMarketplace for upstream imports
    upstreamEntries.push(mapEntry(upstream, "anthropic", ownerName, false));
  }
  if (skipped.length > 0) {
    console.log(`Skipped (conflicts with local IDs): ${skipped.join(", ")}`);
  }

  // Deduplicate upstream by id
  const seen = new Set();
  const dedupedUpstream = [];
  for (const entry of upstreamEntries) {
    if (seen.has(entry.id)) {
      console.warn(`  Duplicate upstream id "${entry.id}" — keeping first`);
      continue;
    }
    seen.add(entry.id);
    dedupedUpstream.push(entry);
  }

  // --- Diff against previous index ---
  const allNewIds = new Set([...localIds, ...dedupedUpstream.map(e => e.id)]);
  const allNew = [...localEntries, ...dedupedUpstream];
  const newById = new Map(allNew.map(e => [e.id, e]));

  let added = 0, updated = 0, unchanged = 0, deprecated = 0;

  // Process new/updated entries — carry forward version and publishedAt when unchanged
  const finalEntries = [];
  // Hoisted so both the manifest-pinned branch and the synthetic-bump branch
  // below stamp the same instant.
  const today = new Date().toISOString().split("T")[0] + "T00:00:00Z";

  for (const entry of allNew) {
    const prev = previousById.get(entry.id);
    if (entry.manifestVersion) {
      // WHY: manifestVersion means mapEntry already pinned entry.version to
      // plugin.json — never let the synthetic bump-on-metadata-change below
      // overwrite it. publishedAt still moves when the manifest version
      // actually changes, so "last updated" stays meaningful.
      delete entry.manifestVersion;
      if (prev && prev.version !== entry.version) { entry.publishedAt = today; updated++; }
      else if (prev) { entry.publishedAt = prev.publishedAt; if (prev.deprecated) { entry.deprecated = prev.deprecated; entry.deprecatedAt = prev.deprecatedAt; } unchanged++; }
      else added++;
      finalEntries.push(entry); continue;
    }
    if (!prev) {
      // New entry — use defaults (1.0.0, today)
      added++;
      finalEntries.push(entry);
    } else if (hasChanges(prev, entry)) {
      // Changed — bump version, update publishedAt
      entry.version = bumpPatch(prev.version);
      entry.publishedAt = today;
      updated++;
      finalEntries.push(entry);
    } else {
      // Unchanged — preserve version and publishedAt from previous
      entry.version = prev.version;
      entry.publishedAt = prev.publishedAt;
      // Also preserve deprecated flag if it was set
      if (prev.deprecated) {
        entry.deprecated = prev.deprecated;
        entry.deprecatedAt = prev.deprecatedAt;
      }
      unchanged++;
      finalEntries.push(entry);
    }
  }

  // Detect removed entries — keep them but flag as deprecated
  for (const prev of previousIndex) {
    if (!allNewIds.has(prev.id) && !prev.deprecated) {
      // Entry was in previous index but not in either source — mark deprecated
      const deprecatedEntry = { ...prev, deprecated: true, deprecatedAt: new Date().toISOString().split("T")[0] };
      deprecated++;
      finalEntries.push(deprecatedEntry);
      console.log(`  DEPRECATED: ${prev.id} (no longer in upstream)`);
    } else if (!allNewIds.has(prev.id) && prev.deprecated) {
      // Already deprecated — carry forward as-is
      finalEntries.push(prev);
    }
  }

  // --- Component extraction (one pass over non-deprecated entries) ---
  // Deprecated entries aren't re-extracted; they carry forward their last-known
  // `components` value from the previous index (the deprecation branch above
  // spreads prev, which preserves components if present).
  const extractCache = {};
  const extractReport = { extracted: 0, failed: [], truncated: [], startedAt: new Date().toISOString() };
  try {
    for (const entry of finalEntries) {
      if (entry.deprecated) continue;
      // Reuse cached components when sourceSha is unchanged.
      const prev = previousById.get(entry.id);
      if (prev && prev.components !== undefined &&
          prev.sourceSha && prev.sourceSha === entry.sourceSha) {
        entry.components = prev.components;
        if (prev.componentsError) entry.componentsError = prev.componentsError;
        continue;
      }
      const { ok, error } = await extractForEntry(entry, extractCache);
      if (ok) {
        extractReport.extracted++;
      } else {
        if (error === "truncated") extractReport.truncated.push(entry.id);
        else extractReport.failed.push({ id: entry.id, error: error || "unknown" });
      }
    }
  } catch (err) {
    if (err instanceof RateLimitError) {
      console.error(`  ABORT: ${err.message}. Last-good index preserved; re-run when limit resets.`);
      process.exit(2);
    }
    throw err;
  }
  extractReport.finishedAt = new Date().toISOString();
  console.log(`  Extracted components: ${extractReport.extracted} ok, ${extractReport.failed.length} failed, ${extractReport.truncated.length} truncated`);

  // Sort: YouCoded first (alphabetical), then anthropic (alphabetical), then deprecated
  finalEntries.sort((a, b) => {
    // Deprecated always last
    if (a.deprecated && !b.deprecated) return 1;
    if (!a.deprecated && b.deprecated) return -1;
    // YouCoded before anthropic
    const aSource = a.sourceMarketplace || "youcoded";
    const bSource = b.sourceMarketplace || "youcoded";
    if (aSource !== bSource) {
      if (aSource === "youcoded") return -1;
      if (bSource === "youcoded") return 1;
      return aSource.localeCompare(bSource);
    }
    return a.id.localeCompare(b.id);
  });

  // --- Validation ---
  const errors = [];
  const allIds = new Set();
  for (const entry of finalEntries) {
    if (!entry.id) errors.push("Entry missing id");
    if (!entry.type) errors.push(`${entry.id}: missing type`);
    if (!entry.displayName) errors.push(`${entry.id}: missing displayName`);
    if (!entry.description) errors.push(`${entry.id}: missing description`);
    if (allIds.has(entry.id)) errors.push(`${entry.id}: duplicate id`);
    allIds.add(entry.id);
  }
  if (errors.length > 0) {
    console.warn("Validation warnings:");
    errors.forEach(e => console.warn(`  - ${e}`));
  }

  // --- Write index with version wrapper ---
  const output = {
    version: new Date().toISOString(),
    generatedBy: "sync.js",
    entries: finalEntries,
  };

  // Check if output actually changed (idempotency)
  let prevContent = null;
  if (fs.existsSync(SKILLS_INDEX_PATH)) {
    prevContent = fs.readFileSync(SKILLS_INDEX_PATH, "utf8");
  }
  const newContent = JSON.stringify(output, null, 2) + "\n";

  // Compare entries only (ignore version timestamp) for idempotency check
  const prevEntries = prevContent ? JSON.stringify(JSON.parse(prevContent).entries) : null;
  const newEntries = JSON.stringify(output.entries);
  const isIdentical = prevEntries === newEntries;

  if (isIdentical) {
    console.log("\nNo changes detected — index is up to date.");
    // Don't write (preserves the previous version timestamp)
  } else {
    fs.writeFileSync(SKILLS_INDEX_PATH, newContent);
    console.log(`\nWritten ${finalEntries.length} entries to skills/index.json`);
  }

  // Also regenerate root index.json (raw entries array) for backward compat.
  // Both desktop skill-provider.ts and Android MarketplaceFetcher.kt fetch this.
  const rootIndexPath = path.join(__dirname, "..", "index.json");
  const rootContent = JSON.stringify(finalEntries, null, 2) + "\n";
  const prevRoot = fs.existsSync(rootIndexPath) ? fs.readFileSync(rootIndexPath, "utf8") : null;
  if (prevRoot !== rootContent) {
    fs.writeFileSync(rootIndexPath, rootContent);
    console.log(`Written ${finalEntries.length} entries to root index.json`);
  }

  // Write sync-report.json — committed alongside index so drift is visible in diffs.
  // CI can read this to surface a failure count in the workflow summary.
  const report = {
    timestamp: new Date().toISOString(),
    totalEntries: finalEntries.length,
    counts: { added, updated, unchanged, deprecated },
    components: extractReport,
  };
  const reportContent = JSON.stringify(report, null, 2) + "\n";
  // Skip writing if only the timestamp changed (keeps diffs meaningful).
  let prevReport = null;
  if (fs.existsSync(SYNC_REPORT_PATH)) {
    try {
      prevReport = JSON.parse(fs.readFileSync(SYNC_REPORT_PATH, "utf8"));
    } catch {}
  }
  const reportChanged = !prevReport ||
    JSON.stringify(prevReport.counts) !== JSON.stringify(report.counts) ||
    JSON.stringify(prevReport.components?.failed) !== JSON.stringify(report.components.failed) ||
    JSON.stringify(prevReport.components?.truncated) !== JSON.stringify(report.components.truncated) ||
    (prevReport.components?.extracted || 0) !== report.components.extracted;
  if (reportChanged) {
    fs.writeFileSync(SYNC_REPORT_PATH, reportContent);
    console.log(`Written sync-report.json`);
  }

  // Summary
  console.log(`  Added: ${added}, Updated: ${updated}, Unchanged: ${unchanged}, Deprecated: ${deprecated}`);
  const bySource = {};
  for (const e of finalEntries) {
    const src = e.sourceMarketplace || "youcoded";
    bySource[src] = (bySource[src] || 0) + 1;
  }
  console.log("  By source:", JSON.stringify(bySource));
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});

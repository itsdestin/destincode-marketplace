#!/usr/bin/env node
// Mirrors the canonical root marketplace.json to .claude-plugin/marketplace.json.
//
// WHY: Claude Code v2.1+ loads a marketplace from
// <installLocation>/.claude-plugin/marketplace.json and does NOT fall back to a
// root-level marketplace.json. Until this mirror existed, the only copy of that
// file on a user's disk was one the YouCoded app wrote at runtime into
// ~/.claude/plugins/marketplaces/youcoded/. Any CC-side "Update marketplace"
// re-clones this repo over that directory, destroying the app-written manifest
// and leaving CC with an unloadable marketplace ("Marketplace file not found")
// plus orphaned plugin installs. Shipping the manifest in the repo means a
// fresh clone is valid on its own.
//
// Byte-for-byte copy on purpose: the two files must never disagree, and the
// root manifest's `source.path` values are already relative to the repo root,
// which is exactly what CC resolves against <installLocation>.
//
// Run via CI (validate-plugin-pr.yml) after marketplace.json is finalized.
// --check exits non-zero if the mirror is stale, without writing.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SOURCE = path.join(ROOT, "marketplace.json");
const MIRROR = path.join(ROOT, ".claude-plugin", "marketplace.json");

const check = process.argv.includes("--check");

if (!fs.existsSync(SOURCE)) {
  console.error("Fatal: marketplace.json not found at repo root");
  process.exit(1);
}

// Parse before copying so a corrupt root manifest fails here rather than
// shipping a broken marketplace to every user who clones.
const source = fs.readFileSync(SOURCE);
try {
  const parsed = JSON.parse(source);
  if (!Array.isArray(parsed.plugins)) throw new Error("missing `plugins` array");
} catch (err) {
  console.error(`Fatal: marketplace.json is not a valid marketplace manifest: ${err.message}`);
  process.exit(1);
}

const current = fs.existsSync(MIRROR) ? fs.readFileSync(MIRROR) : null;

if (current && current.equals(source)) {
  console.log(".claude-plugin/marketplace.json is up to date");
  process.exit(0);
}

if (check) {
  console.error(
    "::error::.claude-plugin/marketplace.json is out of sync with marketplace.json — " +
      "run `node scripts/mirror-cc-manifest.js` and commit the result"
  );
  process.exit(1);
}

fs.mkdirSync(path.dirname(MIRROR), { recursive: true });
fs.writeFileSync(MIRROR, source);
console.log("Written .claude-plugin/marketplace.json");

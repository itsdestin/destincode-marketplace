#!/usr/bin/env node
/**
 * sync-check.cjs — Verifies theme-preview.css stays in sync with globals.css.
 *
 * theme-preview.css is a declared CONTRACT: it reimplements the app's themed
 * chrome so /theme-builder mockups look like the real thing. When globals.css
 * changes and the preview doesn't, theme authors design against a UI that no
 * longer exists.
 *
 * Usage: node <skill>/scripts/sync-check.cjs [--strict]
 *        THEME_GLOBALS_CSS=/path/to/globals.css node ... (explicit override)
 * Exit code: 0 = in sync, 1 = drift detected
 *
 * HISTORY / WHY THIS FILE IS PARANOID ABOUT PATHS: this guard was silently dead
 * for ~3 months. Both of its globals.css candidates were stale (a legacy
 * mono-repo layout and a pre-rebrand `destincode` sibling), and its PREVIEW path
 * still said `core/skills/`. It exited on "File not found" before running a
 * single check, so the framed-shell chrome refactor landed completely unguarded.
 * Hence: resolution now tries several layouts, and a path miss is a LOUD failure
 * that names every location tried rather than a bare not-found.
 */

const fs = require('fs');
const path = require('path');

const STRICT = process.argv.includes('--strict');

// theme-preview.css sits one level up from scripts/. Resolve relative to THIS
// file rather than a guessed repo root — the script can't be moved without its
// sibling, so this can't drift the way the old ROOT-walk did.
const PREVIEW = path.resolve(__dirname, '..', 'theme-preview.css');

// wecoded-marketplace repo root (scripts → theme-builder → skills → plugin → root)
const ROOT = path.resolve(__dirname, '..', '..', '..', '..');

// Resolve globals.css across known layouts. The workspace one is the real
// answer today; the others are kept so this works from a standalone clone.
const GLOBALS_CANDIDATES = [
  process.env.THEME_GLOBALS_CSS,
  // Workspace layout: youcoded-dev/{wecoded-marketplace,youcoded}/ as siblings
  path.join(ROOT, '..', 'youcoded', 'desktop', 'src', 'renderer', 'styles', 'globals.css'),
  // Standalone: youcoded cloned next to a bare checkout
  path.join(ROOT, '..', '..', 'youcoded', 'desktop', 'src', 'renderer', 'styles', 'globals.css'),
  // Legacy mono-repo
  path.join(ROOT, 'desktop', 'src', 'renderer', 'styles', 'globals.css'),
].filter(Boolean);

const GLOBALS = GLOBALS_CANDIDATES.find((p) => fs.existsSync(p));

if (!GLOBALS) {
  console.error('❌ Could not locate globals.css. Tried:');
  for (const p of GLOBALS_CANDIDATES) console.error(`   - ${p}`);
  console.error('\nSet THEME_GLOBALS_CSS=/path/to/globals.css to override.');
  process.exit(1);
}

function readFile(p) {
  if (!fs.existsSync(p)) {
    console.error(`File not found: ${p}`);
    process.exit(1);
  }
  return fs.readFileSync(p, 'utf8');
}

/**
 * Extract all CSS rule blocks matching a selector pattern from a CSS string.
 * Returns an array of { selector, body } objects.
 */
function extractRules(css, selectorPattern) {
  const results = [];
  const regex = new RegExp(`(${selectorPattern}[^{]*)\\{([^}]+)\\}`, 'g');
  let match;
  while ((match = regex.exec(css)) !== null) {
    results.push({
      selector: match[1].trim(),
      body: match[2].trim().replace(/\s+/g, ' '),
    });
  }
  return results;
}

/** Normalize a CSS property block: strip comments, collapse whitespace, sort. */
function normalizeBody(body) {
  return body
    .replace(/\/\*.*?\*\//g, '')
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
    .sort()
    .join('; ');
}

/** Parse a normalized body into a Map of prop -> value. */
function propMap(body) {
  const map = new Map();
  for (const decl of body.split('; ')) {
    if (!decl) continue;
    const idx = decl.indexOf(':');
    if (idx === -1) continue;
    map.set(decl.slice(0, idx).trim(), decl.slice(idx + 1).trim());
  }
  return map;
}

const globals = readFile(GLOBALS);
const preview = readFile(PREVIEW);

/**
 * `values: true` means the declared VALUES must match, not just the property
 * names. Reserve it for rules whose exact formula is the contract (the glass
 * color-mix expressions, the layout-preset geometry). Structural rules where the
 * preview legitimately simplifies — it's a bounded 16/10 mockup box, not a
 * full-bleed window — stay property-name-only, otherwise every check would cry
 * wolf and the whole guard gets ignored again.
 */
const CHECKS = [
  // Glass selectors are unconditional (no [data-panels-blur] gate) — anchored to
  // a preceding newline so we don't match nested rules like ".layer-surface .bg-inset".
  { name: 'Glassmorphism — header-bar',                pattern: '\\n\\.header-bar' },
  { name: 'Glassmorphism — status-bar',                pattern: '\\n\\.status-bar' },
  { name: 'Glassmorphism — bg-inset (assistant bubbles)', pattern: '\\n\\.bg-inset' },
  { name: 'Glassmorphism — bg-accent (user bubbles)',  pattern: '\\n\\.bg-accent' },

  // Framed shell. These are the blocks whose absence let the chrome refactor
  // land unnoticed — the entire data-chrome-style axis was previously unguarded.
  { name: 'Framed shell — chrome-glass',               pattern: '\\n\\.chrome-glass' },
  { name: 'Framed shell — framed-shell',               pattern: '\\n\\.framed-shell' },
  { name: 'Framed shell — chrome-wrapper',             pattern: '\\n\\.chrome-wrapper' },
  // NB: these three only ever appear as direct children of .framed-shell in
  // globals.css — a newline-anchored '\n\.drawer-pane' matches nothing and the
  // check silently skips. Match the real descendant form.
  { name: 'Framed shell — drawer-pane',                pattern: '\\.framed-shell > \\.drawer-pane' },
  { name: 'Framed shell — chat-pane',                  pattern: '\\.framed-shell > \\.chat-pane' },
  { name: 'Framed shell — frame-divider',              pattern: '\\.framed-shell > \\.frame-divider' },
  { name: 'Layout — floating chrome fork',             pattern: '\\[data-chrome-style=.floating.\\]' },

  { name: 'Layout — floating input',                   pattern: '\\[data-input-style="floating"\\]' },
  { name: 'Layout — minimal input',                    pattern: '\\[data-input-style="minimal"\\]' },
  { name: 'Layout — terminal input',                   pattern: '\\[data-input-style="terminal"\\]' },
  { name: 'Layout — pill bubbles',                     pattern: '\\[data-bubble-style="pill"\\]' },
  { name: 'Layout — flat bubbles',                     pattern: '\\[data-bubble-style="flat"\\]' },
  { name: 'Layout — bordered bubbles',                 pattern: '\\[data-bubble-style="bordered"\\]' },
  { name: 'Layout — minimal header',                   pattern: '\\[data-header-style="minimal"\\]' },
  { name: 'Layout — hidden header',                    pattern: '\\[data-header-style="hidden"\\]' },
  // statusbar-style is default|minimal only — there has never been a "floating"
  // variant in globals.css, the manifest template, or kit-presets.json. The
  // check that used to be here matched nothing and was pure decoration.
  { name: 'Layout — minimal statusbar',                pattern: '\\[data-statusbar-style="minimal"\\]' },
  { name: 'Background layer — #theme-bg',              pattern: '#theme-bg' },
  { name: 'Background layer — #theme-pattern',         pattern: '#theme-pattern' },
];

let driftCount = 0;
let valueWarnCount = 0;

for (const check of CHECKS) {
  const globalsRules = extractRules(globals, check.pattern);
  const previewRules = extractRules(preview, check.pattern);

  if (globalsRules.length === 0) {
    // A pattern that matches nothing in globals.css looks EXACTLY like a
    // passing check, which is how three framed-shell checks silently skipped
    // when they were written against the wrong selector form. Surface it: a
    // stale pattern is itself drift, just of the guard rather than the CSS.
    console.log(`❓ UNMATCHED pattern (check is doing nothing): ${check.name}`);
    console.log(`   No rule in globals.css matches: ${check.pattern}`);
    driftCount++;
    continue;
  }

  if (previewRules.length === 0) {
    console.log(`❌ MISSING in preview: ${check.name}`);
    console.log(`   globals.css has ${globalsRules.length} rule(s) for: ${check.pattern}`);
    driftCount++;
    continue;
  }

  const gMap = propMap(normalizeBody(globalsRules[0].body));
  const pMap = propMap(normalizeBody(previewRules[0].body));

  const missingInPreview = [...gMap.keys()].filter((p) => p && !pMap.has(p));
  if (missingInPreview.length > 0) {
    console.log(`⚠️  DRIFT in ${check.name}:`);
    console.log(`   Missing properties in preview: ${missingInPreview.join(', ')}`);
    driftCount++;
  }

  if (check.values) {
    const mismatched = [];
    for (const [prop, gVal] of gMap) {
      if (!pMap.has(prop)) continue; // already reported as missing
      if (pMap.get(prop) !== gVal) mismatched.push(`${prop}: "${pMap.get(prop)}" ≠ "${gVal}"`);
    }
    if (mismatched.length > 0) {
      const label = STRICT ? '❌ VALUE DRIFT' : '⚠️  value drift';
      console.log(`${label} in ${check.name}:`);
      for (const m of mismatched) console.log(`   ${m}`);
      if (STRICT) driftCount++; else valueWarnCount++;
    }
  }
}

/**
 * Variables the preview must reference. The second group is everything the
 * framed-shell / drawer work introduced that the preview never picked up —
 * each of these appeared ZERO times in theme-preview.css before this change.
 */
const TOKEN_VARS = [
  // 15 theme tokens
  '--canvas', '--panel', '--inset', '--well', '--accent', '--on-accent',
  '--fg', '--fg-2', '--fg-dim', '--fg-muted', '--fg-faint',
  '--edge', '--edge-dim', '--scrollbar-thumb', '--scrollbar-hover',
  // Frame geometry + derived tokens
  '--frame-edge', '--frame-corner', '--right-pane-width',
  '--top-chrome-height', '--bottom-chrome-height',
  '--radius-toggle', '--shadow-strength', '--scrim',
  // Named type scale
  '--text-2xs', '--text-3xs', '--text-4xs',
];

for (const token of TOKEN_VARS) {
  if (!preview.includes(`var(${token}`)) {
    console.log(`❌ Token not used in preview: ${token}`);
    driftCount++;
  }
}

console.log('');
console.log(`   globals: ${GLOBALS}`);
console.log(`   preview: ${PREVIEW}`);
console.log('');

if (driftCount === 0) {
  console.log('✅ theme-preview.css is in sync with globals.css');
  if (valueWarnCount > 0) {
    console.log(`   (${valueWarnCount} value warning(s) — re-run with --strict to fail on these)`);
  }
  process.exit(0);
} else {
  console.log(`${driftCount} sync issue(s) found. Update theme-preview.css to match.`);
  process.exit(1);
}

#!/usr/bin/env node
/**
 * Theme Contrast Validator — CLI
 *
 * Reads a theme manifest.json and checks all contrast/distinction rules.
 * Exit 0 = all hard + surface rules pass, Exit 1 = at least one failed.
 * Soft-rule warnings are printed but don't fail the check.
 *
 * Usage:  node check-contrast.cjs <path-to-manifest.json>
 *         node check-contrast.cjs --tokens-json <path|->
 *
 * The color math and the RULES table live in ./contrast-rules.js so the Kit
 * page can run the IDENTICAL checks live in the browser — see the WHY comment
 * at the top of that file. This file is presentation + exit codes only.
 */

const fs = require('fs');
const path = require('path');
const { evaluate } = require('./contrast-rules.js');

function main() {
  // Accept two input modes:
  //   1. node check-contrast.cjs <path-to-manifest.json>
  //      (legacy — full manifest with a `.tokens` wrapper)
  //   2. node check-contrast.cjs --tokens-json <path-or-dash>
  //      (Phase-1 pre-validation — flat tokens object or full manifest;
  //      `-` reads from stdin so Claude can pipe a concept palette without
  //      writing a tempfile first)
  const args = process.argv.slice(2);
  let manifestPath = null;
  let tokensJsonSrc = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tokens-json') { tokensJsonSrc = args[++i]; }
    else if (!manifestPath) { manifestPath = args[i]; }
  }

  if (!manifestPath && !tokensJsonSrc) {
    console.error('Usage: node check-contrast.cjs <manifest.json>');
    console.error('       node check-contrast.cjs --tokens-json <path|->');
    process.exit(2);
  }

  let raw;
  try {
    if (tokensJsonSrc === '-') {
      raw = fs.readFileSync(0, 'utf-8'); // fd 0 = stdin
    } else {
      raw = fs.readFileSync(path.resolve(tokensJsonSrc || manifestPath), 'utf-8');
    }
  } catch (err) {
    console.error(`Failed to read input: ${err.message}`);
    process.exit(2);
  }

  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    console.error(`Failed to parse JSON: ${err.message}`);
    process.exit(2);
  }

  // --tokens-json accepts either a flat token map or a full manifest.
  // If the top-level object has token keys directly (no .tokens wrapper),
  // treat it as the tokens map.
  const tokens = manifest.tokens || (manifest.canvas && manifest.accent ? manifest : null);
  if (!tokens) {
    console.error('Input has no "tokens" object and is not a flat tokens map');
    process.exit(2);
  }

  const { results, hardFails, surfaceFails, softWarns, unparsed } = evaluate(tokens);

  // Report unparseable tokens before the table, matching prior behaviour.
  for (const key of unparsed) {
    console.error(`  ⚠ Could not parse token "${key}": ${tokens[key]}`);
  }

  // ── Print results ───────────────────────────────────────────────────────

  const themeName = manifest.name || manifest.slug || 'Unknown';
  console.log(`\n  Theme: ${themeName}`);
  console.log(`  ${'─'.repeat(50)}\n`);

  for (const tier of ['HARD', 'SURFACE', 'SOFT']) {
    const tierResults = results[tier];
    if (tierResults.length === 0) continue;

    const tierLabel = tier === 'HARD' ? '✖ HARD RULES (fail = broken UI)'
      : tier === 'SURFACE' ? '◼ SURFACE DISTINCTION (fail = elements disappear)'
      : '◦ SOFT RULES (warn only)';

    console.log(`  ${tierLabel}\n`);

    for (const r of tierResults) {
      if (r.status === 'SKIP') {
        console.log(`    ─ ${r.rule}: SKIPPED (${r.reason})`);
      } else if (r.status === 'PASS') {
        console.log(`    ✓ ${r.rule}: ${r.actual} (need ${r.threshold})`);
      } else {
        const icon = tier === 'SOFT' ? '⚠' : '✗';
        console.log(`    ${icon} ${r.rule}: ${r.actual} (need ${r.threshold}) — ${r.description}`);
      }
    }
    console.log('');
  }

  // ── Summary ─────────────────────────────────────────────────────────────

  const totalFails = hardFails + surfaceFails;
  if (totalFails === 0 && softWarns === 0) {
    console.log('  ✓ All contrast checks passed.\n');
  } else {
    if (totalFails > 0) {
      console.log(`  ✗ ${totalFails} rule(s) failed (${hardFails} hard, ${surfaceFails} surface).`);
    }
    if (softWarns > 0) {
      console.log(`  ⚠ ${softWarns} soft warning(s).`);
    }
    console.log('');
  }

  // Exit 1 if any hard or surface rules failed
  process.exit(totalFails > 0 ? 1 : 0);
}

main();

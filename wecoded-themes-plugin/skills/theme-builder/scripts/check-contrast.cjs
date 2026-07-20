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
const { solveTheme } = require('./solve-ramp.js');

/**
 * Average colour of a wallpaper, as #RRGGBB.
 *
 * Wallpaper themes paint panel/inset/well translucently over the image, so the
 * colour under the text is a composite — not the token. Auditing the flat token
 * is how meadow-mist shipped painting text at a real 1.01 contrast while every
 * audit reported 1.24. The average is computed ONCE here and written to
 * `background.average-color` so the CI audits (which have no image dependency)
 * can be glass-aware too.
 *
 * Downscaled + blurred first so a few saturated pixels don't skew the mean; the
 * app's own blur does much the same thing to what sits behind a panel.
 */
async function computeAverageColor(imagePath) {
  const sharp = require('sharp');
  const { data } = await sharp(imagePath)
    .resize(160, 90, { fit: 'fill' })
    .blur(5)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let r = 0, g = 0, b = 0;
  const px = data.length / 3;
  for (let i = 0; i < data.length; i += 3) { r += data[i]; g += data[i + 1]; b += data[i + 2]; }
  return (
    '#' +
    [r / px, g / px, b / px]
      .map((v) => Math.round(v).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  );
}

/** Glass options for a manifest: what the app will actually paint text on. */
async function glassOptsFor(manifest, manifestPath) {
  const bg = manifest.background || {};
  const panelsOpacity = typeof bg['panels-opacity'] === 'number' ? bg['panels-opacity'] : 1;
  if (panelsOpacity >= 1) return { panelsOpacity: 1, wallpaperAvg: null, computed: null };

  if (bg['average-color']) {
    return { panelsOpacity, wallpaperAvg: bg['average-color'], computed: null };
  }
  // Compute it — and hand it back so the caller can persist it.
  if (bg.type === 'image' && bg.value && manifestPath) {
    const img = path.resolve(path.dirname(manifestPath), bg.value);
    if (fs.existsSync(img)) {
      try {
        const avg = await computeAverageColor(img);
        return { panelsOpacity, wallpaperAvg: avg, computed: avg };
      } catch (err) {
        console.error(`  ⚠ Could not read wallpaper for average-color: ${err.message}`);
      }
    }
  }
  return { panelsOpacity, wallpaperAvg: null, computed: null };
}

async function main() {
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
  // --fix solves the palette instead of only grading it, and writes it back.
  // This is the flow the skill uses: authors pick the creative inputs, the
  // solver places the ramp. Hand-picking every token then grading it afterwards
  // is what shipped unreadable text in all 11 themes.
  let fix = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tokens-json') { tokensJsonSrc = args[++i]; }
    else if (args[i] === '--fix') { fix = true; }
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

  const glass = await glassOptsFor(manifest, manifestPath && path.resolve(manifestPath));

  if (fix) {
    if (!manifestPath) {
      console.error('--fix needs a manifest path (it writes the solved tokens back).');
      process.exit(2);
    }
    const solved = solveTheme(tokens, glass);
    if (solved.unsatisfiable.length) {
      // No lightness works for these tiers — the SURFACES are the problem, not
      // the text colour. Say so instead of writing a ramp that cannot pass.
      console.error(`\n  ✗ Unsatisfiable: ${solved.unsatisfiable.join(', ')}`);
      console.error('    No text lightness clears the target against these surfaces.');
      console.error('    Tighten the surface ladder (canvas/panel/inset/well) and re-run.\n');
      process.exit(1);
    }
    let raw2 = fs.readFileSync(path.resolve(manifestPath), 'utf-8');
    for (const key of solved.changed) {
      const re = new RegExp(`("${key}"\\s*:\\s*)"[^"]*"`);
      raw2 = raw2.replace(re, `$1"${solved.tokens[key]}"`);
    }
    if (glass.computed && !/"average-color"/.test(raw2)) {
      raw2 = raw2.replace(/("background":\s*\{)/, `$1\n    "average-color": "${glass.computed}",`);
    }
    JSON.parse(raw2); // fail loudly rather than writing broken JSON
    fs.writeFileSync(path.resolve(manifestPath), raw2);
    console.log(`\n  ✓ Solved ${solved.changed.length} token(s): ${solved.changed.join(', ')}`);
    if (glass.computed) console.log(`  ✓ Wrote background.average-color: ${glass.computed}`);
    Object.assign(tokens, solved.tokens);
  }

  const { results, hardFails, surfaceFails, softWarns, unparsed, glassAware } = evaluate(tokens, glass);

  // Report unparseable tokens before the table, matching prior behaviour.
  for (const key of unparsed) {
    console.error(`  ⚠ Could not parse token "${key}": ${tokens[key]}`);
  }

  // ── Print results ───────────────────────────────────────────────────────

  const themeName = manifest.name || manifest.slug || 'Unknown';
  console.log(`\n  Theme: ${themeName}`);
  if (glassAware) {
    console.log(`  Glass: panels at ${Math.round(glass.panelsOpacity * 100)}% over ${glass.wallpaperAvg}`);
  } else if (glass.panelsOpacity < 1) {
    console.log('  ⚠ Translucent panels but no wallpaper average — measured FLAT (understates real ratios)');
  }
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

main().catch((err) => {
  console.error(err);
  process.exit(2);
});

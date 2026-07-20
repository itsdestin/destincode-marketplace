#!/usr/bin/env node
/**
 * prep-terminal-bg.cjs — Pre-blur + darken a theme wallpaper for terminal view.
 *
 * TerminalView renders this asset as a static layer behind xterm so text
 * stays readable over high-frequency wallpaper detail. Pre-baking avoids the
 * runtime GPU cost of backdrop-filter on a full-pane surface (especially on
 * low-end Android) and lets us blur harder than we safely could at runtime.
 *
 * Usage:
 *   node prep-terminal-bg.cjs <input-wallpaper> <output-path> [--blur N] [--brightness N]
 *
 * Defaults:
 *   --blur 8           Gaussian blur sigma (pixels). Subtle — softens
 *                      high-frequency detail (fine text, sharp edges) without
 *                      turning the wallpaper into a featureless color field.
 *   --brightness 0.86  Multiplier applied to every pixel. Slight darkening
 *                      preserves contrast against light-fg themes without
 *                      turning every theme into a muddy bruise.
 *
 * Output:
 *   WebP at quality 75, downscaled to max 1440px on the longer side. Subtle
 *   blur still preserves mid-frequency detail, so we keep more resolution
 *   than a heavy blur would need — but we're softer than the original, so
 *   we can still compress harder than the source wallpaper.
 *   Prints JSON: {"ok":true,"path":"...","bytes":N,"input":"..."} or
 *                {"ok":false,"error":"..."}.
 *   Exits 0 on success, 1 on failure.
 */

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const positional = [];
  const flags = { blur: 8, brightness: 0.86 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--blur') flags.blur = parseFloat(argv[++i]);
    else if (a === '--brightness') flags.brightness = parseFloat(argv[++i]);
    else positional.push(a);
  }
  return { positional, flags };
}

async function main() {
  const { positional, flags } = parseArgs(process.argv);
  if (positional.length < 2) {
    console.log(JSON.stringify({
      ok: false,
      error: 'usage: prep-terminal-bg.cjs <input> <output> [--blur N] [--brightness N]',
    }));
    process.exit(1);
  }
  const [input, output] = positional;

  if (!fs.existsSync(input)) {
    console.log(JSON.stringify({ ok: false, error: `input not found: ${input}` }));
    process.exit(1);
  }

  let sharp;
  try {
    sharp = require('sharp');
  } catch (e) {
    console.log(JSON.stringify({
      ok: false,
      error: `sharp not installed. Run: cd ${__dirname} && npm install`,
    }));
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(output), { recursive: true });

  try {
    await sharp(input)
      // Downscale first — a 1440px image costs less to process than a 4K
      // source and still looks crisp when stretched across the terminal pane.
      .resize({ width: 1440, height: 1440, fit: 'inside', withoutEnlargement: true })
      .blur(flags.blur)
      .modulate({ brightness: flags.brightness })
      .webp({ quality: 75 })
      .toFile(output);
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: `sharp failed: ${e.message}` }));
    process.exit(1);
  }

  const bytes = fs.statSync(output).size;
  console.log(JSON.stringify({ ok: true, path: output, bytes, input }));
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: e.message }));
  process.exit(1);
});

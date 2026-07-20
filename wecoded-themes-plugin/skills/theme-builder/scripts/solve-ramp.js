/**
 * solve-ramp.js — derives a theme's TEXT ramp so every tier is legible on every
 * surface the app can actually paint it on.
 *
 * WHY THIS EXISTS
 * ---------------
 * Theme authors used to hand-pick all five text tokens and a checker graded them
 * afterwards. That process shipped themes where secondary text was invisible:
 * measured 2026-07-19, `fg-muted` on a raised surface failed in 9 of 11 shipped
 * themes, and `fg-faint` on a raised surface had NEVER passed in any theme that
 * ever shipped (best ratio anywhere: 2.31). The checker missed it because its
 * rule table only knew three text tiers while the app uses five, and only ever
 * compared against `canvas`.
 *
 * The fix is structural, not a bigger table: the author no longer authors the
 * ramp. They choose the creative inputs (surfaces, accent, hue/chroma character,
 * wallpaper) and this solver places the lightness of each text tier so it clears
 * its contrast target against EVERY surface — including the glass composite and
 * the `bg-inset/50` stack that SettingsRow paints. You cannot author a failing
 * ramp if you do not author the ramp.
 *
 * WHY OKLCH AND NOT HSL
 * ---------------------
 * The first prototype solved in HSL, holding H and S while moving L. That
 * preserves *nominal* saturation but not *perceived* chroma — a mid-lightness
 * colour reads far more chromatic than a pale one at the same S, so darkening a
 * pale token turned it visibly goldier. OKLCH is perceptually uniform, so
 * holding C while moving L keeps the colour recognisably the same hue family.
 *
 * Exports are consumed by check-contrast.cjs, contrast-rules.js and the live Kit
 * page. Keep this file dependency-free — it is loaded raw into the browser.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SolveRamp = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ── sRGB basics ───────────────────────────────────────────────────────────

  function parseHex(hex) {
    let h = String(hex).trim().replace(/^#/, '');
    // Tokens like edge-dim carry an 8-digit form (#RRGGBBAA); alpha is handled
    // by the caller compositing it, so we only take the RGB triplet here.
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    h = h.slice(0, 6);
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }

  function toHex(rgb) {
    return (
      '#' +
      rgb
        .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase()
    );
  }

  const srgbToLinear = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  const linearToSrgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

  /** WCAG relative luminance. Accepts a hex string or an [r,g,b] 0-255 triplet. */
  function luminance(color) {
    const rgb = Array.isArray(color) ? color : parseHex(color);
    if (!rgb) return null;
    const [r, g, b] = rgb.map((v) => srgbToLinear(v / 255));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  /** WCAG contrast ratio between two colours. */
  function contrast(a, b) {
    const la = luminance(a);
    const lb = luminance(b);
    if (la === null || lb === null) return null;
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  /** Composite `fg` at alpha `a` over `bg`. Both hex or triplets. */
  function composite(fg, a, bg) {
    const f = Array.isArray(fg) ? fg : parseHex(fg);
    const b = Array.isArray(bg) ? bg : parseHex(bg);
    if (!f || !b) return null;
    return f.map((v, i) => v * a + b[i] * (1 - a));
  }

  // ── OKLCH ─────────────────────────────────────────────────────────────────
  // Björn Ottosson's Oklab, plus the polar (LCh) form. Perceptually uniform, so
  // holding C constant while moving L keeps perceived colourfulness steady.

  function srgbToOklab(rgb) {
    const [r, g, b] = rgb.map((v) => srgbToLinear(v / 255));
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
  }

  function oklabToSrgb([L, a, b]) {
    const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
    const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
    const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
    const lr = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
    const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
    const lb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
    return [lr, lg, lb].map((v) => linearToSrgb(v) * 255);
  }

  function toOklch(hex) {
    const rgb = parseHex(hex);
    if (!rgb) return null;
    const [L, a, b] = srgbToOklab(rgb);
    return [L, Math.sqrt(a * a + b * b), Math.atan2(b, a)];
  }

  /**
   * Back to sRGB. Chroma is reduced (never hue, never lightness) until the
   * result sits inside the sRGB gamut — the standard gamut-clip for OKLCH. Hue
   * is the theme's identity and lightness is what we are solving for, so chroma
   * is the only safe thing to give up.
   */
  function fromOklch([L, C, h]) {
    for (let i = 0; i <= 40; i++) {
      const c = C * (1 - i / 40);
      const rgb = oklabToSrgb([L, c * Math.cos(h), c * Math.sin(h)]);
      if (rgb.every((v) => v >= -0.5 && v <= 255.5)) return toHex(rgb);
    }
    return toHex(oklabToSrgb([L, 0, 0]));
  }

  // ── Targets ───────────────────────────────────────────────────────────────

  /**
   * Minimum contrast each text tier must reach against the WORST surface it can
   * land on. Validated 2026-07-19 against the Ivory Schematic repalette, which
   * kept a visually distinct five-step ramp at these numbers.
   *
   * `fg-faint` is DECORATIVE ONLY — separators, rules, disabled glyphs. 2.0 makes
   * it visible as ornament, not readable as text. The ~107 places that currently
   * use it AS text must migrate to `fg-muted`; no palette can rescue them,
   * because lifting faint to a readable ratio collapses it into muted.
   */
  const TARGETS = {
    fg: 8.0,
    'fg-2': 5.5,
    'fg-dim': 4.0,
    'fg-muted': 3.0,
    'fg-faint': 2.0,
  };

  const TEXT_ORDER = ['fg', 'fg-2', 'fg-dim', 'fg-muted', 'fg-faint'];

  /**
   * Every surface the app can paint text on.
   *
   * `inset-50` is not a token — it is what SettingsRow.tsx:27 actually paints
   * (`bg-inset/50` over the panel). It slips past the protection cascade at
   * globals.css:887 because that rule matches `.bg-inset` and Tailwind emits
   * `.bg-inset\/50`, a different class. Omitting it from the matrix is how the
   * worst offender in the app went unmeasured.
   */
  function effectiveSurfaces(tokens, opts) {
    const o = opts || {};
    const wallpaper = o.wallpaperAvg || null;
    const panelsOpacity = typeof o.panelsOpacity === 'number' ? o.panelsOpacity : 1;

    const s = { canvas: tokens.canvas };
    for (const k of ['panel', 'inset', 'well']) {
      if (!tokens[k]) continue;
      // Wallpaper themes paint surfaces translucently over the image, so the
      // colour under the text is a composite — NOT the token. Measuring the flat
      // token is optimistic on dark wallpapers and pessimistic on light ones;
      // either way it is measuring a surface that never gets painted.
      s[k] = wallpaper ? toHex(composite(tokens[k], panelsOpacity, wallpaper)) : tokens[k];
    }
    if (s.panel && tokens.inset) {
      s['inset-50'] = toHex(composite(tokens.inset, 0.5, s.panel));
    }
    return s;
  }

  // ── Solver ────────────────────────────────────────────────────────────────

  /**
   * Walk one token's OKLCH lightness until it clears `target` against every
   * surface. Hue and chroma are held. Returns null when no lightness works —
   * which means the surfaces themselves are the problem, not the text colour.
   */
  function solveToken(src, surfaces, target, isDark) {
    const lch = toOklch(src);
    if (!lch) return null;
    const [L0, C, h] = lch;
    const STEPS = 400;
    for (let i = 0; i <= STEPS; i++) {
      // Light themes darken their text, dark themes lighten it.
      const L = isDark ? Math.min(1, L0 + i / STEPS) : Math.max(0, L0 - i / STEPS);
      const cand = fromOklch([L, C, h]);
      let worst = Infinity;
      for (const bg of surfaces) {
        const c = contrast(cand, bg);
        if (c !== null && c < worst) worst = c;
      }
      if (worst >= target) return cand;
    }
    return null;
  }

  /**
   * Solve the whole text ramp.
   *
   * Returns { tokens, report, surfaces, monotonic, dark, unsatisfiable }.
   * `unsatisfiable` lists tiers no lightness can satisfy — the signal that the
   * surface ladder is too wide (e.g. a near-white canvas with a mid-tone inset)
   * and the AUTHOR must tighten the surfaces. Emitting a failing ramp silently
   * is the bug this whole module exists to prevent.
   */
  function solveRamp(tokens, opts) {
    const surfaces = effectiveSurfaces(tokens, opts);
    const list = Object.values(surfaces);
    const isDark = luminance(tokens.canvas) < 0.4;

    const out = {};
    const report = [];
    const unsatisfiable = [];

    for (const tok of TEXT_ORDER) {
      if (!tokens[tok]) continue;
      const target = TARGETS[tok];
      const before = Math.min(...list.map((b) => contrast(tokens[tok], b)));
      const solved = solveToken(tokens[tok], list, target, isDark);
      if (!solved) unsatisfiable.push(tok);
      out[tok] = solved || tokens[tok];
      report.push({
        token: tok,
        target,
        from: tokens[tok],
        to: out[tok],
        before: Math.round(before * 100) / 100,
        after: Math.round(Math.min(...list.map((b) => contrast(out[tok], b))) * 100) / 100,
        changed: out[tok] !== tokens[tok],
        ok: !!solved,
      });
    }

    // The ramp must stay ordered — a "muted" that is darker than "dim" reads as
    // a broken hierarchy even when every individual ratio passes.
    const lums = TEXT_ORDER.filter((t) => out[t]).map((t) => luminance(out[t]));
    const monotonic = lums.every((v, i) => i === 0 || (isDark ? v < lums[i - 1] : v > lums[i - 1]));

    return { tokens: out, report, surfaces, monotonic, dark: isDark, unsatisfiable };
  }

  /**
   * Selected-text legibility. Every shipped theme used
   * `::selection { background: rgba(accent,.3); color: #FFFFFF }`, which only
   * works on dark themes — on a light theme it paints white on a pale tint
   * (measured 1.57-2.41 across the light themes on 2026-07-19). Nothing checked
   * it because custom_css was never validated at all.
   */
  function checkSelection(selectionRgb, alpha, selectionText, tokens, opts) {
    const surfaces = effectiveSurfaces(tokens, opts);
    const results = [];
    for (const [name, surface] of Object.entries(surfaces)) {
      const bg = composite(selectionRgb, alpha, surface);
      results.push({
        surface: name,
        selectionBg: toHex(bg),
        textContrast: Math.round(contrast(selectionText, bg) * 100) / 100,
        // The selection must also be visible AS a selection, not just legible.
        distinction: Math.round(contrast(bg, surface) * 100) / 100,
      });
    }
    return results;
  }

  // ── Surfaces, edges, accent ───────────────────────────────────────────────
  // The text ramp is only half the problem. Measured 2026-07-19, 7 of 11 shipped
  // themes — INCLUDING ALL FOUR BUILT-INS — also failed the surface-distinction
  // rules: borders invisible against their own panels, `inset` indistinguishable
  // from `panel`. Those failures predate the ramp work and were never enforced
  // because CI ran the audit with continue-on-error.

  /**
   * Matches contrast-rules.js::luminanceRatio exactly. Distinction is a raw
   * luminance ratio, not WCAG — two surfaces need to look different, which is a
   * weaker requirement than text needing to be readable. The <0.01 branch keeps
   * near-black surfaces (halftone, golden-sunbreak) from dividing by ~zero.
   */
  function luminanceRatio(l1, l2) {
    if (l1 === 0 && l2 === 0) return 1;
    const a = Math.max(l1, l2);
    const b = Math.min(l1, l2);
    if (a < 0.01) return 1 + Math.abs(l1 - l2) * 100;
    return a / (b || 0.0001);
  }

  const SURFACE_TARGETS = {
    'inset vs panel': 1.2,
    'canvas vs inset': 1.3,
    'well vs panel': 1.15,
  };
  const EDGE_TARGETS = { edge: 1.5, 'edge-dim': 1.3 };

  /**
   * Nudge `inset` and `well` until the surface ladder is visibly stepped.
   *
   * Direction is taken from the theme itself rather than assumed: kuromi-dreamer
   * INVERTS the ladder (its `inset` is lighter than its `canvas`), so hardcoding
   * "raised surfaces are darker on light themes" would push it the wrong way and
   * flatten the very thing we are trying to separate.
   *
   * `canvas` and `panel` are held fixed — they are the theme's dominant colours
   * and moving them changes its identity far more than moving the raised tiers.
   */
  function solveSurfaces(tokens) {
    const out = { ...tokens };
    const lCanvas = luminance(tokens.canvas);
    const lPanel = luminance(tokens.panel);

    // Which way is "away from panel" for this theme's raised surfaces?
    const insetDir = luminance(tokens.inset) <= lPanel ? -1 : 1;
    const wellDir = luminance(tokens.well) <= lPanel ? -1 : 1;

    const step = (src, dir, ok) => {
      const lch = toOklch(src);
      if (!lch) return src;
      const [L0, C, h] = lch;
      for (let i = 0; i <= 400; i++) {
        const L = Math.max(0, Math.min(1, L0 + dir * (i / 400)));
        const cand = fromOklch([L, C, h]);
        if (ok(cand)) return cand;
      }
      return src;
    };

    out.inset = step(tokens.inset, insetDir, (c) => {
      const l = luminance(c);
      return (
        luminanceRatio(l, lPanel) >= SURFACE_TARGETS['inset vs panel'] &&
        luminanceRatio(lCanvas, l) >= SURFACE_TARGETS['canvas vs inset']
      );
    });
    out.well = step(tokens.well, wellDir, (c) =>
      luminanceRatio(luminance(c), lPanel) >= SURFACE_TARGETS['well vs panel'],
    );
    return out;
  }

  /**
   * Borders must be visible against the panel they sit on. `edge-dim` usually
   * carries an 8-digit alpha (e.g. "#A8987A80"); it is composited over the panel
   * before measuring, and the original alpha suffix is preserved on the way out
   * so the token keeps its intended translucency.
   */
  function solveEdges(tokens) {
    const out = { ...tokens };
    const panel = parseHex(tokens.panel);
    for (const key of ['edge', 'edge-dim']) {
      const raw = tokens[key];
      if (!raw) continue;
      const m = String(raw).match(/^#?[0-9a-fA-F]{6}([0-9a-fA-F]{2})$/);
      const alphaHex = m ? m[1] : null;
      const alpha = alphaHex ? parseInt(alphaHex, 16) / 255 : 1;
      const target = EDGE_TARGETS[key];

      const lch = toOklch(raw);
      if (!lch) continue;
      const [L0, C, h] = lch;
      // Borders read best pushed AWAY from the panel; direction follows the
      // theme so dark themes brighten their edges and light themes darken them.
      const dir = luminance(raw) <= luminance(tokens.panel) ? -1 : 1;
      for (let i = 0; i <= 400; i++) {
        const L = Math.max(0, Math.min(1, L0 + dir * (i / 400)));
        const cand = fromOklch([L, C, h]);
        const painted = alpha < 1 ? toHex(composite(cand, alpha, panel)) : cand;
        if (contrast(painted, tokens.panel) >= target) {
          out[key] = alphaHex ? cand + alphaHex.toUpperCase() : cand;
          break;
        }
      }
    }
    return out;
  }

  /**
   * Selected/accent text must be readable. Rather than flipping `on-accent`
   * between white and black — which changes the theme's character — the accent
   * itself is nudged until the author's chosen `on-accent` clears 4.5. Halftone
   * Dimension sat at 4.40 with white on #e8234a: a hair short, and a hue shift
   * would have been a much bigger visual change than a slight darkening.
   */
  function solveAccent(tokens) {
    const out = { ...tokens };
    const onAccent = tokens['on-accent'];
    if (!onAccent || contrast(onAccent, tokens.accent) >= 4.5) return out;
    const lch = toOklch(tokens.accent);
    if (!lch) return out;
    const [L0, C, h] = lch;
    // Move the accent away from on-accent: darken under light text, lighten
    // under dark text.
    const dir = luminance(onAccent) > luminance(tokens.accent) ? -1 : 1;
    for (let i = 0; i <= 400; i++) {
      const L = Math.max(0, Math.min(1, L0 + dir * (i / 400)));
      const cand = fromOklch([L, C, h]);
      if (contrast(onAccent, cand) >= 4.5) {
        out.accent = cand;
        break;
      }
    }
    return out;
  }

  /**
   * Full pipeline. ORDER IS LOAD-BEARING: surfaces and edges settle first,
   * because the text ramp is solved against whatever the surfaces ended up as.
   * Solving text first and then moving surfaces underneath it would invalidate
   * every ratio the ramp solve just guaranteed.
   */
  function solveTheme(tokens, opts) {
    let t = { ...tokens };
    t = solveSurfaces(t);
    t = solveEdges(t);
    t = solveAccent(t);
    const ramp = solveRamp(t, opts);
    const final = { ...t, ...ramp.tokens };
    const changed = Object.keys(final).filter((k) => final[k] !== tokens[k]);
    return { tokens: final, ramp, changed, unsatisfiable: ramp.unsatisfiable, monotonic: ramp.monotonic };
  }

  return {
    parseHex,
    toHex,
    luminance,
    contrast,
    luminanceRatio,
    composite,
    toOklch,
    fromOklch,
    TARGETS,
    TEXT_ORDER,
    SURFACE_TARGETS,
    EDGE_TARGETS,
    effectiveSurfaces,
    solveToken,
    solveRamp,
    solveSurfaces,
    solveEdges,
    solveAccent,
    solveTheme,
    checkSelection,
  };
});

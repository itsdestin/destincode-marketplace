/**
 * Theme Contrast Rules — shared between Node and the browser.
 *
 * WHY this file exists: the Kit page validates palettes live in the browser as
 * the user drags color pickers, and check-contrast.cjs validates them at build
 * time in Node. Those two MUST agree — a palette that reads "passing" in the
 * editor and then fails the build gate is a bug report waiting to happen. So the
 * math and the RULES table live here exactly once, and both consumers import it.
 *
 * Dual export (module.exports for Node, window.themeContrast for the browser)
 * rather than a bundler — the rest of this skill is zero-dependency hand-rolled
 * JS and adding a build step just for one file isn't worth it.
 *
 * Three tiers:
 *   HARD    — UI breaks (text unreadable, elements invisible). Fails the build.
 *   SURFACE — Elements lose visual boundaries. Fails the build.
 *   SOFT    — Degraded but usable. Warns only.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.themeContrast = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ── Color math helpers ────────────────────────────────────────────────────

  /** Parse hex (#RGB, #RGBA, #RRGGBB, #RRGGBBAA) to { r, g, b, a }, rgb 0-255, a 0-1 */
  function parseHex(hex) {
    if (!hex || typeof hex !== 'string') return null;
    hex = hex.replace(/^#/, '');
    // Strip alpha suffix if present (e.g. "#37373780") — edge-dim carries one.
    let a = 255;
    if (hex.length === 4) {
      // #RGBA
      a = parseInt(hex[3] + hex[3], 16);
      hex = hex.slice(0, 3);
    } else if (hex.length === 8) {
      // #RRGGBBAA
      a = parseInt(hex.slice(6, 8), 16);
      hex = hex.slice(0, 6);
    }
    if (hex.length === 3) {
      hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    }
    if (hex.length !== 6) return null;
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      a: a / 255,
    };
  }

  /** WCAG relative luminance (0-1) from sRGB channel 0-255 */
  function luminance(rgb) {
    const [rs, gs, bs] = [rgb.r, rgb.g, rgb.b].map((c) => {
      const s = c / 255;
      return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
  }

  /** WCAG contrast ratio between two luminances (returns >= 1) */
  function contrastRatio(l1, l2) {
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
  }

  /** Luminance ratio (non-WCAG, for surface distinction — just the raw ratio) */
  function luminanceRatio(l1, l2) {
    if (l1 === 0 && l2 === 0) return 1;
    const a = Math.max(l1, l2);
    const b = Math.min(l1, l2);
    // For very dark surfaces, use absolute difference check instead
    if (a < 0.01) return 1 + Math.abs(l1 - l2) * 100;
    return a / (b || 0.0001);
  }

  /**
   * Apply alpha to a foreground color over a background color.
   * Returns composited { r, g, b } with a=1.
   */
  function alphaComposite(fg, bg, alpha) {
    return {
      r: Math.round(fg.r * alpha + bg.r * (1 - alpha)),
      g: Math.round(fg.g * alpha + bg.g * (1 - alpha)),
      b: Math.round(fg.b * alpha + bg.b * (1 - alpha)),
      a: 1,
    };
  }

  // ── Rule definitions ──────────────────────────────────────────────────────

  /**
   * Each rule: { name, tier, threshold, type, fg, bg, [fgAlpha], description }
   *   type: "contrast" = WCAG contrast ratio, "distinction" = luminance ratio
   *   fg/bg: token names from manifest.tokens
   *   fgAlpha: optional multiplier on the fg color's opacity (for timestamp rules)
   */
  const RULES = [
    // ── HARD: UI breaks if these fail ──
    { name: 'fg on canvas',         tier: 'HARD',    type: 'contrast',    fg: 'fg',        bg: 'canvas',  threshold: 4.5,  description: 'Body text must be readable on main background' },
    { name: 'fg on inset',          tier: 'HARD',    type: 'contrast',    fg: 'fg',        bg: 'inset',   threshold: 4.5,  description: 'Text in assistant bubbles must be readable' },
    { name: 'fg on panel',          tier: 'HARD',    type: 'contrast',    fg: 'fg',        bg: 'panel',   threshold: 4.5,  description: 'Text on panels/header/status bar must be readable' },
    { name: 'on-accent on accent',  tier: 'HARD',    type: 'contrast',    fg: 'on-accent', bg: 'accent',  threshold: 4.5,  description: 'User bubble text and active button text must be readable' },
    { name: 'fg-2 on inset',        tier: 'HARD',    type: 'contrast',    fg: 'fg-2',      bg: 'inset',   threshold: 3.5,  description: 'Session pill labels and secondary text in bubbles' },
    { name: 'fg-dim on inset',      tier: 'HARD',    type: 'contrast',    fg: 'fg-dim',    bg: 'inset',   threshold: 2.5,  description: 'Tool card labels and collapsed group text inside bubbles' },

    // ── SURFACE: Elements disappear if these fail ──
    { name: 'inset vs panel',       tier: 'SURFACE', type: 'distinction', fg: 'inset',     bg: 'panel',   threshold: 1.2,  description: 'Session pills and toggle containers must be visible on header bar' },
    { name: 'canvas vs inset',      tier: 'SURFACE', type: 'distinction', fg: 'canvas',    bg: 'inset',   threshold: 1.3,  description: 'Code blocks must be visible inside assistant bubbles' },
    { name: 'well vs panel',        tier: 'SURFACE', type: 'distinction', fg: 'well',      bg: 'panel',   threshold: 1.15, description: 'Search bar must be visible in command drawer' },
    { name: 'edge on panel',        tier: 'SURFACE', type: 'contrast',    fg: 'edge',      bg: 'panel',   threshold: 1.5,  description: 'Borders must be visible on panel surfaces (session strip, tool cards)' },
    { name: 'edge-dim on panel',    tier: 'SURFACE', type: 'contrast',    fg: 'edge-dim',  bg: 'panel',   threshold: 1.3,  description: 'Dim borders must be visible (chips, code blocks rely on these)' },

    // ── SOFT: Degraded but usable, warn only ──
    { name: 'fg-2 on canvas',       tier: 'SOFT',    type: 'contrast',    fg: 'fg-2',      bg: 'canvas',  threshold: 3.5,  description: 'Secondary text should be comfortable to read' },
    { name: 'fg-dim on panel',      tier: 'SOFT',    type: 'contrast',    fg: 'fg-dim',    bg: 'panel',   threshold: 2.0,  description: 'Inactive toggle text and dropdown labels' },
    { name: 'accent vs inset',      tier: 'SOFT',    type: 'contrast',    fg: 'accent',    bg: 'inset',   threshold: 3.0,  description: 'Active toggle button should stand out from its container' },
    { name: 'fg-muted/60 on inset', tier: 'SOFT',    type: 'contrast',    fg: 'fg-muted',  bg: 'inset',   threshold: 2.0,  fgAlpha: 0.6, description: 'Timestamp text in assistant bubbles' },
    { name: 'on-accent/50 on accent', tier: 'SOFT',  type: 'contrast',    fg: 'on-accent', bg: 'accent',  threshold: 2.0,  fgAlpha: 0.5, description: 'Timestamp text in user bubbles' },
  ];

  // ── Evaluation ────────────────────────────────────────────────────────────

  /**
   * Evaluate one rule against a map of already-parsed colors.
   * Exposed separately so the Kit page can re-check a single token cheaply
   * (e.g. while "nudge to pass" walks a color's lightness).
   *
   * @returns {{rule, status:'PASS'|'FAIL'|'SKIP', actual?, threshold, description, tier, reason?}}
   */
  function evaluateRule(rule, parsed) {
    const fgColor = parsed[rule.fg];
    const bgColor = parsed[rule.bg];

    if (!fgColor || !bgColor) {
      return {
        rule: rule.name,
        tier: rule.tier,
        status: 'SKIP',
        reason: `missing token (${!fgColor ? rule.fg : rule.bg})`,
        threshold: rule.threshold,
        description: rule.description,
      };
    }

    let effectiveFg = fgColor;

    // Handle alpha on the fg token itself (e.g. edge-dim with embedded alpha).
    // Without this, "#A8987A80" measures as if fully opaque and reports nonsense.
    if (fgColor.a < 1) {
      effectiveFg = alphaComposite(fgColor, bgColor, fgColor.a);
    }

    // Handle rule-level alpha (e.g. fg-muted rendered at 60% opacity)
    if (rule.fgAlpha) {
      effectiveFg = alphaComposite(effectiveFg, bgColor, rule.fgAlpha);
    }

    const fgLum = luminance(effectiveFg);
    const bgLum = luminance(bgColor);
    const actual = rule.type === 'contrast'
      ? contrastRatio(fgLum, bgLum)
      : luminanceRatio(fgLum, bgLum);
    const pass = actual >= rule.threshold;

    return {
      rule: rule.name,
      tier: rule.tier,
      status: pass ? 'PASS' : 'FAIL',
      actual: actual.toFixed(2),
      threshold: rule.threshold,
      description: rule.description,
    };
  }

  /**
   * Evaluate every rule against a raw token map (hex strings).
   *
   * @param {Object<string,string>} tokens - e.g. { canvas: '#EDE8DD', ... }
   * @returns {{results:{HARD:[],SURFACE:[],SOFT:[]}, hardFails, surfaceFails,
   *            softWarns, unparsed:string[]}}
   */
  function evaluate(tokens) {
    const parsed = {};
    const unparsed = [];
    for (const [key, value] of Object.entries(tokens || {})) {
      const c = parseHex(value);
      if (c) parsed[key] = c;
      else unparsed.push(key);
    }

    const results = { HARD: [], SURFACE: [], SOFT: [] };
    let hardFails = 0, surfaceFails = 0, softWarns = 0;

    for (const rule of RULES) {
      const r = evaluateRule(rule, parsed);
      results[rule.tier].push(r);
      if (r.status === 'FAIL') {
        if (rule.tier === 'HARD') hardFails++;
        else if (rule.tier === 'SURFACE') surfaceFails++;
        else softWarns++;
      }
    }

    return { results, hardFails, surfaceFails, softWarns, unparsed, parsed };
  }

  /**
   * Which rules does a given token participate in? Used by the Kit page to show
   * a per-token badge carrying the WORST ratio that token is involved in.
   */
  function rulesForToken(tokenName) {
    return RULES.filter((r) => r.fg === tokenName || r.bg === tokenName);
  }

  return {
    parseHex,
    luminance,
    contrastRatio,
    luminanceRatio,
    alphaComposite,
    RULES,
    evaluateRule,
    evaluate,
    rulesForToken,
  };
});

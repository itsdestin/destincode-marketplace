/**
 * kit-state.js — the Kit editor's single source of truth, shared Node/browser.
 *
 * WHY THIS SHAPE: kit-state is a theme MANIFEST plus a `_kit` block, not a
 * parallel schema. toManifest() is therefore near-identity — strip `_kit`, force
 * the slug, prefix asset paths. A genuinely different schema would mean two
 * mappings to keep in sync and two places for the slug contract to rot, and the
 * slug contract is this skill's most expensive historical bug.
 *
 * WHY CLAUDE WRITES THIS INSTEAD OF HTML: the Kit page used to be a ~24KB
 * template with ~20 placeholders that Claude refilled on every single tweak.
 * Now the page is copied verbatim and renders itself from this ~1.2KB JSON, so
 * a palette change costs a small JSON write instead of retyping a document —
 * and most changes don't involve Claude at all, because the page applies them
 * live in the browser.
 *
 * Asset paths are stored as BARE BASENAMES because the two consumers need
 * different prefixes: `assets/` for the manifest the app reads, `/files/` for
 * the preview server that serves the staged copies.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.kitState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** The reserved slug. The app hot-switches to a theme directory named
   *  `_preview` but resolves it by the manifest's internal slug — if these
   *  disagree it silently falls back to the default theme. Never parameterize. */
  const PREVIEW_SLUG = '_preview';

  const TOKEN_KEYS = [
    'canvas', 'panel', 'inset', 'well', 'accent', 'on-accent',
    'fg', 'fg-2', 'fg-dim', 'fg-muted', 'fg-faint',
    'edge', 'edge-dim', 'scrollbar-thumb', 'scrollbar-hover',
  ];

  /** What each token visibly drives — shown under the picker so a non-developer
   *  can tell which swatch to reach for. */
  const TOKEN_USES = {
    'canvas': 'app background',
    'panel': 'header · status · frame',
    'inset': 'assistant bubbles · pills',
    'well': 'search · input wells',
    'accent': 'buttons · user bubble',
    'on-accent': 'text on accent',
    'fg': 'primary text',
    'fg-2': 'secondary text',
    'fg-dim': 'dim labels',
    'fg-muted': 'muted labels',
    'fg-faint': 'faint decorative',
    'edge': 'borders',
    'edge-dim': 'subtle borders',
    'scrollbar-thumb': 'scrollbar',
    'scrollbar-hover': 'scrollbar hover',
  };

  const RADIUS_KEYS = ['radius', 'radius-sm', 'radius-md', 'radius-lg', 'radius-full'];

  /** Base scanline opacity. The CSS default is 0.08 and there is no manifest
   *  field for intensity, so the slider stores a multiplier in _kit instead of
   *  inventing a field the app would ignore. See toMockup + SKILL.md. */
  const SCANLINE_BASE = 0.08;

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /** Drop keys whose value is null/undefined/'' or an empty object —
   *  manifest-template.jsonc says omit rather than include empties. */
  function prune(obj) {
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (v === null || v === undefined || v === '') delete obj[k];
      else if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) delete obj[k];
    }
    return obj;
  }

  /**
   * kit-state → a valid theme manifest for `_preview`.
   * Near-identity by design; the only real work is path prefixing.
   */
  function toManifest(state) {
    const m = clone(state);
    delete m._kit;

    // Hard-forced, never copied from _kit.finalSlug. The server rejects
    // anything else, so a mistake here fails loudly instead of silently
    // reverting the user's app to the default theme.
    m.slug = PREVIEW_SLUG;

    const asset = (name) => (name ? 'assets/' + name : undefined);

    if (m.background) {
      if (m.background.type === 'image' && m.background.value) {
        m.background.value = asset(m.background.value);
      }
      if (m.background.pattern) m.background.pattern = asset(m.background.pattern);
      prune(m.background);
    }
    if (m.mascot) {
      for (const k of Object.keys(m.mascot)) m.mascot[k] = asset(m.mascot[k]);
      prune(m.mascot);
    }
    if (m.icons) {
      for (const k of Object.keys(m.icons)) m.icons[k] = asset(m.icons[k]);
      prune(m.icons);
    }

    // A non-default scanline intensity has no manifest home, so express it as
    // custom_css rather than inventing a field the app does not read.
    const intensity = state._kit && state._kit.scanlineIntensity;
    if (m.effects && m.effects['scan-lines'] && typeof intensity === 'number' && intensity !== 1) {
      const val = (SCANLINE_BASE * intensity).toFixed(3);
      const rule = `:root { --scanline-opacity: ${val}; }`;
      m.custom_css = m.custom_css ? m.custom_css + ' ' + rule : rule;
    }

    prune(m);
    return m;
  }

  /**
   * kit-state → everything needed to restyle the live mockup.
   *
   * Returns plain data rather than touching the DOM so it stays testable and so
   * the caller controls when paint happens.
   */
  function toMockup(state) {
    const vars = {};
    const attrs = {};

    for (const k of TOKEN_KEYS) {
      if (state.tokens && state.tokens[k]) vars['--' + k] = state.tokens[k];
    }
    for (const k of RADIUS_KEYS) {
      if (state.shape && state.shape[k]) vars['--' + k] = state.shape[k];
    }
    // radius-toggle is derived in the app (radius-md - 2px); mirror it so a
    // theme's rounding reaches the view toggle too.
    if (state.shape && state.shape['radius-md']) {
      vars['--radius-toggle'] = `calc(${state.shape['radius-md']} - 2px)`;
    }

    if (state.font && state.font.family) {
      // One family drives both, per the manifest contract.
      vars['--font-sans'] = state.font.family;
      vars['--font-mono'] = state.font.family;
    }

    const bg = state.background || {};
    vars['--panels-opacity'] = String(bg['panels-opacity'] ?? 1);
    vars['--bubble-opacity'] = String(bg['bubble-opacity'] ?? 1);
    if (bg['pattern-opacity'] != null) vars['--pattern-opacity'] = String(bg['pattern-opacity']);

    // Blur is gated by a PRESENCE-only attribute; the radius is a separate var.
    // Both must move together — see setGlass in kit-page.js.
    const panelsBlur = Number(bg['panels-blur'] || 0);
    const bubbleBlur = Number(bg['bubble-blur'] || 0);
    if (panelsBlur > 0) { vars['--panels-blur'] = panelsBlur + 'px'; attrs['data-panels-blur'] = ''; }
    else { attrs['data-panels-blur'] = null; }
    if (bubbleBlur > 0) { vars['--bubble-blur'] = bubbleBlur + 'px'; attrs['data-bubble-blur'] = ''; }
    else { attrs['data-bubble-blur'] = null; }

    const fx = state.effects || {};
    vars['--vignette-opacity'] = String(fx.vignette ?? 0);
    vars['--noise-opacity'] = String(fx.noise ?? 0);
    // Explicit 0 when off: the CSS default is 0.08, so simply not setting this
    // leaves faint scanlines on every theme that never asked for them.
    const si = (state._kit && typeof state._kit.scanlineIntensity === 'number')
      ? state._kit.scanlineIntensity : 1;
    vars['--scanline-opacity'] = fx['scan-lines'] ? String(SCANLINE_BASE * si) : '0';

    const layout = state.layout || {};
    attrs['data-chrome-style'] = layout['chrome-style'] || 'default';
    attrs['data-input-style'] = layout['input-style'] || 'default';
    attrs['data-bubble-style'] = layout['bubble-style'] || 'default';
    attrs['data-header-style'] = layout['header-style'] || 'default';
    attrs['data-statusbar-style'] = layout['statusbar-style'] || 'default';

    // [data-wallpaper] gates the glass tone rules, mirroring the app where the
    // attribute lives on <html>.
    const isImage = bg.type === 'image' && bg.value;
    attrs['data-wallpaper'] = isImage ? '' : null;

    return {
      vars,
      attrs,
      wallpaperUrl: isImage ? '/files/' + bg.value : null,
      fontHref: (state.font && state.font['google-font-url']) || null,
    };
  }

  /** Cheap structural validation. Returns an array of human-readable problems. */
  function validate(state) {
    const problems = [];
    if (!state || typeof state !== 'object') return ['state is not an object'];
    if (!state.tokens) problems.push('missing tokens');
    else for (const k of TOKEN_KEYS) if (!state.tokens[k]) problems.push('missing token: ' + k);
    if (state.slug && state.slug !== PREVIEW_SLUG) {
      problems.push(`slug must be "${PREVIEW_SLUG}" while previewing (got "${state.slug}")`);
    }
    if (!state._kit) problems.push('missing _kit block');
    return problems;
  }

  return {
    PREVIEW_SLUG, TOKEN_KEYS, TOKEN_USES, RADIUS_KEYS, SCANLINE_BASE,
    toManifest, toMockup, validate,
  };
});

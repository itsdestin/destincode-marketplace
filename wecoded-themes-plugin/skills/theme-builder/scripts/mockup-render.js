/**
 * mockup-render.js — Client-side expander for theme concept mockups.
 *
 * Problem this solves: before this existed, every concept card had to
 * verbatim-include ~1 KB of canonical chrome HTML (gear SVG, session
 * pill, view toggle, paperclip + compass + send-arrow SVGs, model /
 * permission / usage chips). Three concepts = ~3 KB duplicated. This
 * file centralizes that chrome as a template string and exposes a
 * single `expandMockups()` call that scans the page for `.app-mockup`
 * elements carrying `data-mockup` and injects the chrome, filling
 * placeholders from the element's data-* attributes.
 *
 * Concept authors now write tiny cards: scoping CSS vars, data-*-style
 * layout presets, glass vars inline, and the data attributes below.
 * This file renders the rest.
 *
 * Data attributes read from each `[data-mockup]` element:
 *   data-wallpaper     optional — /files/... URL. Layer is ALWAYS emitted.
 *   data-session       session pill label (default: "main")
 *   data-session-color green | red | blue | gray (default: green)
 *   data-model         model chip label (default: "Opus 1M")
 *   data-permission    permission chip label (default: "NORMAL")
 *   data-usage         5h usage percent number (default: 23)
 *   data-asst1         first assistant bubble text
 *   data-user          user bubble text
 *   data-asst2         second assistant bubble text
 *   data-tool-card     optional tool-card label (inside asst2)
 *   data-fx            space-separated effects: "vignette noise scanlines"
 *                      (all three divs are emitted regardless — see below)
 *   data-drawer        "artifact" | "game" — opens the right pane. Absent = closed.
 *   data-platform      "mac" | "win" (default win) — caption buttons + toggle side
 *
 * All data-* values are escaped before interpolation — safe against any content
 * Claude generates.
 *
 * ── TWO INVARIANTS THAT EXIST FOR THE LIVE EDITOR ──────────────────────────
 * The Kit page mutates a mockup live as the user drags sliders, and it must
 * never re-run expansion to do so (expandMockups is idempotent by design — see
 * the guard below — and renderChrome is deliberately not exported). So:
 *
 *  1. ALL THREE effect divs are always emitted, even when data-fx omits them.
 *     Visibility is driven purely by --vignette/noise/scanline-opacity. If the
 *     divs were conditional, turning an effect ON later would require DOM
 *     surgery instead of setting a variable. NOTE --scanline-opacity defaults
 *     to 0.08, not 0, so "off" must be written as an explicit 0.
 *  2. #theme-bg is always emitted, seeded with a transparent 1x1 GIF when there
 *     is no wallpaper. Swapping wallpapers then means assigning backgroundImage
 *     rather than inserting an element.
 *
 * Both also fix latent bugs in the concept page, where a card that set an
 * effect's opacity but forgot the matching data-fx token silently showed
 * nothing (and vice versa, inheriting the 0.08 scanline default by surprise).
 */
(function () {
  if (typeof document === 'undefined') return;

  const SVG = {
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>',
    chevronDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 5 L20 5 A2 2 0 0 1 22 7 L22 15 A2 2 0 0 1 20 17 L10 17 L6 20 L7 17 L4 17 A2 2 0 0 1 2 15 L2 7 A2 2 0 0 1 4 5 Z" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M8.5 11 L8.5 11.01" stroke-width="2.5" stroke-linecap="round"/><path d="M12 11 L12 11.01" stroke-width="2.5" stroke-linecap="round"/><path d="M15.5 11 L15.5 11.01" stroke-width="2.5" stroke-linecap="round"/></svg>',
    terminal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 4 L20 4 A2 2 0 0 1 22 6 L22 18 A2 2 0 0 1 20 20 L4 20 A2 2 0 0 1 2 18 L2 6 A2 2 0 0 1 4 4 Z" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 9 L10 12 L6 15" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 15 L17 15" stroke-width="2" stroke-linecap="round"/></svg>',
    attach: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M15.5 6 L15.5 15.5 A3.5 3.5 0 0 1 8.5 15.5 L8.5 7 A2 2 0 0 1 12.5 7 L12.5 15.5 A0.5 0.5 0 0 1 11.5 15.5 L11.5 8.5" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    compass: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="10" stroke-width="1.8"/><polygon points="16.24,7.76 14.12,14.12 7.76,16.24 9.88,9.88" stroke-width="1.5" stroke-linejoin="round" fill="currentColor" opacity="0.3"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/></svg>',
    sendArrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 12h14M12 5l7 7-7 7"/></svg>',
    // Header additions that shipped after the 2026-04-12 preview sync.
    // These are transcribed VERBATIM from the app so the preview doesn't invent
    // its own iconography — the first pass guessed at all three and got the
    // artifact and gamepad glyphs visibly wrong (reported 2026-07-19).
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M3 7a2 2 0 0 1 2-2h3.6l2 2.4H19a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
    // Artifact drawer — HeaderBar.tsx:277. A document with TEXT LINES, not a
    // folded-corner page.
    document: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>',
    // Games — Icons.tsx:56. A HANDHELD CONSOLE (body + screen + d-pad + two
    // buttons), not the modern two-grip controller the first pass drew.
    gamepad: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="5" y="3" width="14" height="18" rx="2.5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><rect x="8" y="6" width="8" height="5" rx="1" stroke-width="1.4"/><path d="M9 15.5 L11 15.5" stroke-width="2" stroke-linecap="round"/><path d="M10 14.5 L10 16.5" stroke-width="2" stroke-linecap="round"/><path d="M14.5 15 L14.5 15.01" stroke-width="2.8" stroke-linecap="round"/><path d="M16.5 16.5 L16.5 16.51" stroke-width="2.8" stroke-linecap="round"/></svg>',
    // Caption glyphs — HeaderBar.tsx:43-49, 10x10 viewBox.
    capMin: '<svg viewBox="0 0 10 10"><rect fill="currentColor" y="5" width="10" height="1"/></svg>',
    capMax: '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1" y="1" width="8" height="8"/></svg>',
    capClose: '<svg viewBox="0 0 10 10" stroke="currentColor" stroke-width="1.4"><line x1="1" y1="1" x2="9" y2="9"/><line x1="9" y1="1" x2="1" y2="9"/></svg>',
  };

  /** Transparent 1x1 GIF — keeps #theme-bg in the DOM when a theme has no
   *  wallpaper, so the live editor can swap one in without inserting nodes. */
  const BLANK_PX = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

  /** Escape text for safe insertion into HTML (not strictly needed since
   *  we'll set textContent afterward, but used for placeholder assembly). */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function renderChrome(d) {
    const sessionColor = ['green', 'red', 'blue', 'gray'].includes(d.sessionColor) ? d.sessionColor : 'green';
    const toolCard = d.toolCard ? `<div class="tool-card">● ${esc(d.toolCard)}</div>` : '';

    // Right pane: artifact drawer OR game pane — mutually exclusive in the app
    // (App.tsx closes each when the other opens), so one attribute, not two.
    const drawer = d.drawer === 'artifact' || d.drawer === 'game' ? d.drawer : null;
    const isGame = drawer === 'game';

    // Caption buttons render on Windows AND Linux (the window is frameless on
    // both) — gate on "not macOS", never on Win32. macOS instead has native
    // traffic lights, which is also why the view toggle swaps sides there.
    const isMac = d.platform === 'mac';

    const viewToggle = `
        <div class="view-toggle" data-view="chat">
          <button class="view-toggle-btn active">${SVG.chat}<span>Chat</span></button>
          <button class="view-toggle-btn">${SVG.terminal}</button>
        </div>`;

    const captionButtons = isMac ? '' : `
        <div class="header-pill caption-buttons">
          <button class="header-pill-btn caption-btn" aria-label="Minimize">${SVG.capMin}</button>
          <button class="header-pill-btn caption-btn" aria-label="Maximize">${SVG.capMax}</button>
          <button class="header-pill-btn caption-btn caption-close" aria-label="Close">${SVG.capClose}</button>
        </div>`;

    const rightPane = drawer ? `
          <div class="frame-divider"></div>
          <div class="drawer-pane">
            <div class="drawer-pane-header">${isGame ? 'Connect 4' : 'Artifacts'}</div>
            <div class="drawer-pane-body">
              <div class="drawer-pane-row"></div>
              <div class="drawer-pane-row" style="width:70%"></div>
              <div class="drawer-pane-row" style="width:85%"></div>
            </div>
          </div>` : '';

    return `
      <div id="theme-bg" style="background-image: url('${esc(d.wallpaper || BLANK_PX)}');"></div>
      <div class="chrome-glass${drawer ? ' chrome-glass--drawer-open' : ''}"></div>
      <div class="header-bar">
        <button class="header-btn" aria-label="Settings">${SVG.gear}</button>
        <button class="header-btn" aria-label="Projects">${SVG.folder}</button>
        ${isMac ? '' : viewToggle}
        <div class="header-center">
          <div class="session-strip">
            <button class="session-pill active">
              <span class="session-dot ${sessionColor}"></span>
              <span class="session-name">${esc(d.session || 'main')}</span>
            </button>
            <button class="session-strip-menu" aria-label="All sessions">${SVG.chevronDown}</button>
          </div>
        </div>
        <div class="header-right">
          <div class="header-pill">
            <button class="header-pill-btn" aria-label="Files in this chat">
              ${SVG.document}<span class="header-badge">3</span>
            </button>
          </div>
          <div class="header-pill">
            <button class="header-pill-btn" aria-label="Connect 4">
              ${SVG.gamepad}<span class="header-dot"></span>
            </button>
          </div>
          ${isMac ? viewToggle : ''}
          ${captionButtons}
        </div>
      </div>
      <div class="framed-shell${drawer ? ' drawer-open' : ''}">
        <div class="frame-edge"></div>
        <div class="chat-pane">
          <div class="chat-area">
            <div class="assistant-bubble">${esc(d.asst1 || 'Hello! How can I help you today?')}</div>
            <div class="user-bubble">${esc(d.user || 'Show me what you can do.')}</div>
            <div class="assistant-bubble">${esc(d.asst2 || 'Sure — let me walk you through it.')}${toolCard}</div>
          </div>
        </div>
        ${rightPane}
        <div class="frame-edge"></div>
      </div>
      <div class="chrome-wrapper">
        <div class="input-bar-container">
          <div class="input-form">
            <button class="input-icon-btn" aria-label="Attach">${SVG.attach}</button>
            <button class="input-icon-btn" aria-label="Skills">${SVG.compass}</button>
            <input class="input-field" placeholder="Message Claude…" readonly>
            <button class="send-btn" aria-label="Send">${SVG.sendArrow}</button>
          </div>
        </div>
        <div class="status-bar">
          <button class="status-chip chip-model">${esc(d.model || 'Opus 1M')}</button>
          <button class="status-chip chip-perm">${esc(d.permission || 'NORMAL')}</button>
          <button class="status-chip chip-usage" style="margin-left:auto;"><span>5h:</span><span class="chip-usage-pct">${esc(d.usage || '23')}%</span></button>
        </div>
      </div>
      <div class="effect-vignette"></div>
      <div class="effect-noise"></div>
      <div class="effect-scanlines"></div>
    `;
  }

  /** Default intensity for an effect named in data-fx. */
  const FX_DEFAULTS = { vignette: 0.25, noise: 0.035, scanlines: 0.08 };
  const FX_VARS = { vignette: '--vignette-opacity', noise: '--noise-opacity', scanlines: '--scanline-opacity' };

  /**
   * Translate data-fx into intensity variables.
   *
   * The three effect divs are now always in the DOM, so data-fx no longer
   * controls whether an effect EXISTS — only its default intensity. An author
   * who set the variable explicitly inline wins; we only fill in the ones they
   * left unset. Unlisted effects are zeroed EXPLICITLY, which matters because
   * --scanline-opacity's CSS default is 0.08, not 0 — omitting data-fx entirely
   * would otherwise leave faint scanlines on every mockup.
   */
  function applyFxDefaults(el, fxAttr) {
    const listed = new Set(String(fxAttr || '').split(/\s+/).filter(Boolean));
    for (const [name, varName] of Object.entries(FX_VARS)) {
      // Respect an explicit inline value rather than overwriting it.
      if (el.style.getPropertyValue(varName).trim() !== '') continue;
      el.style.setProperty(varName, listed.has(name) ? String(FX_DEFAULTS[name]) : '0');
    }
  }

  /**
   * Measure the rendered chrome bars and publish their heights as
   * --top-chrome-height / --bottom-chrome-height.
   *
   * The chrome-glass clip-path derives the cutout from these two variables, so
   * they must equal the ACTUAL bar heights. Hardcoding them works until a font
   * swap, a layout preset, or a longer session name changes a bar's height by a
   * pixel — then the hole no longer lines up with the bars and the frame reads
   * as broken. The app has the same problem and solves it the same way (it
   * measures and sets these from JS). Exported so the live editor can re-measure
   * after a change that resizes chrome.
   */
  function measureChromeHeights(el) {
    const header = el.querySelector('.header-bar');
    const bottom = el.querySelector('.chrome-wrapper');
    if (header) el.style.setProperty('--top-chrome-height', header.offsetHeight + 'px');
    if (bottom) el.style.setProperty('--bottom-chrome-height', bottom.offsetHeight + 'px');
  }

  function expandMockups(root) {
    const scope = root || document;
    const targets = scope.querySelectorAll('.app-mockup[data-mockup]');
    targets.forEach((el) => {
      if (el.dataset.mockupExpanded === '1') return; // idempotent
      const d = {
        wallpaper:    el.dataset.wallpaper,
        session:      el.dataset.session,
        sessionColor: el.dataset.sessionColor,
        model:        el.dataset.model,
        permission:   el.dataset.permission,
        usage:        el.dataset.usage,
        asst1:        el.dataset.asst1,
        user:         el.dataset.user,
        asst2:        el.dataset.asst2,
        toolCard:     el.dataset.toolCard,
        fx:           el.dataset.fx,
        drawer:       el.dataset.drawer,
        platform:     el.dataset.platform,
      };
      el.innerHTML = renderChrome(d);
      applyFxDefaults(el, d.fx);
      measureChromeHeights(el);
      el.dataset.mockupExpanded = '1';
    });
  }

  // Expose + auto-run on DOMContentLoaded.
  window.mockupRender = { expandMockups, measureChromeHeights, applyFxDefaults, SVG };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => expandMockups());
  } else {
    expandMockups();
  }
})();

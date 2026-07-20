/**
 * kit-page.js — the Kit editor.
 *
 * Everything here exists so that changing a theme does NOT round-trip through
 * Claude. Preset clicks, colour picks and slider drags mutate state and repaint
 * the mockup synchronously; only asset work (wallpaper, mascots, icons) and the
 * final pack build still need the agent.
 *
 * Structure:
 *   state          — kit-state shaped (manifest + _kit), the single source of truth
 *   applyState()   — the ONLY writer to the mockup; idempotent, order-independent
 *   schedulePreviewWrite() — debounced POST /preview so the real app follows
 */
(function () {
  'use strict';

  const KS = window.kitState;
  const TC = window.themeContrast;

  let state = null;
  let presets = null;
  let stage = null;
  const dirty = new Set();

  // ── Mockup application ────────────────────────────────────────────────────

  /**
   * Blur is gated by a PRESENCE-only attribute while the radius is a separate
   * variable, so the two must always move together. At zero the attribute must
   * be REMOVED, not set to "0": `[data-panels-blur]` still matches an empty-ish
   * value and would apply `blur(0px)`, creating a stacking context for nothing.
   */
  function setAttrs(el, attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null) el.removeAttribute(k);
      else el.setAttribute(k, v);
    }
  }

  function setFont(href, family) {
    if (href) {
      let link = document.getElementById('kit-font-link');
      if (!link) {
        link = document.createElement('link');
        link.id = 'kit-font-link';
        link.rel = 'stylesheet';
        document.head.appendChild(link);
      }
      // Replace href in place rather than remove+add so the browser reuses the
      // cached sheet instead of re-fetching on every keystroke.
      if (link.getAttribute('href') !== href) link.setAttribute('href', href);
    }
    // NEVER write the theme font to documentElement — that would leak the theme
    // into the editor's own chrome. Only the stage gets it (see applyState).
    void family;
  }

  /**
   * Rebuild the mockup's chrome DOM, then re-apply the theme.
   *
   * expandMockups() is idempotent-guarded (mockup-render.js:108) so it skips an
   * already-expanded element; clearing the flag is what lets it run again. Only
   * for structural variants — never call this for a styling change, which
   * applyState handles without touching the DOM.
   */
  function reExpandStage() {
    if (!stage || !window.mockupRender) return;
    delete stage.dataset.mockupExpanded;
    window.mockupRender.expandMockups(stage.parentElement || document);
    applyState(); // innerHTML was replaced: re-apply wallpaper + re-measure
  }

  /** The single writer. Every control mutates `state` then calls this. */
  function applyState() {
    if (!stage) return;
    const { vars, attrs, wallpaperUrl, fontHref } = KS.toMockup(state);

    for (const [k, v] of Object.entries(vars)) stage.style.setProperty(k, v);
    setAttrs(stage, attrs);

    const bg = stage.querySelector('#theme-bg');
    if (bg) {
      // #theme-bg always exists (mockup-render seeds it with a transparent GIF),
      // so a wallpaper swap is an assignment, never DOM surgery.
      bg.style.backgroundImage = wallpaperUrl ? `url('${wallpaperUrl}')` : 'none';
    }
    setFont(fontHref, state.font && state.font.family);

    // Chrome bar heights feed the clip-path cutout; a layout preset can change
    // them, so re-measure or the frame drifts out of alignment.
    if (window.mockupRender && window.mockupRender.measureChromeHeights) {
      window.mockupRender.measureChromeHeights(stage);
    }
    renderContrast();
    persist();
  }

  // ── Live preview writes ───────────────────────────────────────────────────
  //
  // Every theme reload in the app re-rasterises the dock icon, so unthrottled
  // writes during a slider drag genuinely thrash. Trailing debounce with a
  // max-wait keeps the app following without hammering it.

  const WRITE_DEBOUNCE_MS = 250;
  const WRITE_MAXWAIT_MS = 600;

  let liveEnabled = false;
  let writeTimer = null;
  let firstPendingAt = 0;
  let inFlight = false;
  let queuedAfterFlight = false;
  let lastWritten = '';

  function setLiveStatus(stateName, text) {
    const el = document.getElementById('k-live');
    if (!el) return;
    el.dataset.state = stateName;
    el.querySelector('.k-live-text').textContent = text;
  }

  function schedulePreviewWrite(immediate) {
    if (!liveEnabled) return;
    if (!firstPendingAt) firstPendingAt = Date.now();
    if (writeTimer) clearTimeout(writeTimer);
    const waited = Date.now() - firstPendingAt;
    // Max-wait: a long continuous drag should still show SOMETHING in the app
    // rather than staying frozen until the user lets go.
    const delay = immediate ? 0 : Math.min(WRITE_DEBOUNCE_MS, Math.max(0, WRITE_MAXWAIT_MS - waited));
    writeTimer = setTimeout(flushPreviewWrite, delay);
  }

  function flushPreviewWrite() {
    writeTimer = null;
    firstPendingAt = 0;
    if (!liveEnabled) return;
    // At most one request outstanding. Besides sparing the server, this makes
    // response reordering impossible — a slow write can never land after and
    // overwrite a newer one.
    if (inFlight) { queuedAfterFlight = true; return; }

    const manifest = KS.toManifest(state);
    const body = JSON.stringify({ enabled: true, manifest });
    // A slider dragged back to where it started should cost nothing.
    if (body === lastWritten) return;

    inFlight = true;
    fetch('/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
      .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        if (ok && j.ok) {
          lastWritten = body;
          setLiveStatus('on', 'live in app');
        } else {
          // Surface it. A silent failure here is why "the app just ignored it"
          // has historically been so hard to diagnose.
          setLiveStatus('error', j.error || 'write failed');
        }
      })
      .catch((e) => setLiveStatus('error', e.message))
      .finally(() => {
        inFlight = false;
        if (queuedAfterFlight) { queuedAfterFlight = false; flushPreviewWrite(); }
      });
  }

  function setLive(on) {
    liveEnabled = on;
    const btn = document.getElementById('k-live-toggle');
    if (btn) btn.setAttribute('aria-pressed', String(on));
    try { sessionStorage.setItem('kit-live', on ? '1' : '0'); } catch (e) { /* ignore */ }

    if (on) {
      setLiveStatus('on', 'enabling…');
      lastWritten = '';
      schedulePreviewWrite(true);
    } else {
      lastWritten = '';
      setLiveStatus('off', 'preview off');
      fetch('/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      }).catch(() => { /* teardown is best-effort; the server also self-cleans */ });
    }
  }

  // ── Contrast ──────────────────────────────────────────────────────────────

  function renderContrast() {
    if (!TC) return;
    const { results, hardFails, surfaceFails, softWarns } = TC.evaluate(state.tokens);
    const all = [...results.HARD, ...results.SURFACE, ...results.SOFT];

    // Per-token badge shows the WORST ratio that token participates in.
    for (const token of KS.TOKEN_KEYS) {
      const badge = document.querySelector(`[data-badge="${token}"]`);
      const row = document.querySelector(`.k-token-row[data-token="${token}"]`);
      if (!badge) continue;
      const involved = TC.rulesForToken(token).map((r) => all.find((x) => x.rule === r.name)).filter(Boolean);
      const scored = involved.filter((r) => r.status !== 'SKIP');
      if (!scored.length) { badge.textContent = ''; if (row) row.dataset.status = ''; continue; }
      const worst = scored.reduce((a, b) => (Number(a.actual) / a.threshold < Number(b.actual) / b.threshold ? a : b));
      const failed = worst.status === 'FAIL';
      const blocking = failed && worst.tier !== 'SOFT';
      badge.className = 'k-badge ' + (blocking ? 'k-badge--fail' : 'k-badge--pass');
      // Three states, not two. A SOFT failure is still a failure — showing a ✓
      // beside a number that is below its own threshold reads as a bug.
      // Glyph AND number, never colour alone.
      badge.textContent = (blocking ? '✗ ' : failed ? '⚠ ' : '✓ ') + worst.actual;
      badge.title = `${worst.rule}: ${worst.actual} (need ${worst.threshold})`;
      if (row) row.dataset.status = blocking ? 'fail' : '';
    }

    const blocking = hardFails + surfaceFails;
    const sum = document.getElementById('k-contrast');
    if (sum) {
      sum.dataset.state = blocking > 0 ? 'fail' : 'pass';
      sum.querySelector('.k-contrast-text').textContent = blocking > 0
        ? `${blocking} contrast ${blocking === 1 ? 'issue' : 'issues'}${softWarns ? ` · ${softWarns} soft` : ''}`
        : `all checks pass${softWarns ? ` · ${softWarns} soft` : ''}`;
    }

    const list = document.getElementById('k-contrast-list');
    if (list) {
      const bad = all.filter((r) => r.status === 'FAIL' && r.tier !== 'SOFT');
      list.innerHTML = bad.map((r) => `
        <div class="k-contrast-item">
          <span class="k-badge k-badge--fail">✗ ${r.actual}</span>
          <span><strong>${esc(r.rule)}</strong> — needs ${r.threshold}. ${esc(r.description)}</span>
        </div>`).join('') || '';
    }

    const build = document.getElementById('k-build');
    if (build) build.dataset.blocking = String(blocking);
  }

  /**
   * Walk a failing token's lightness until it clears every rule it appears in.
   * Turns the diagnostic into a fix, which is the whole point of showing it.
   */
  function nudgeToPass() {
    if (!TC) return;
    const before = TC.evaluate(state.tokens);
    const failing = [...before.results.HARD, ...before.results.SURFACE]
      .filter((r) => r.status === 'FAIL');
    if (!failing.length) return;

    for (const res of failing) {
      const rule = TC.RULES.find((r) => r.name === res.rule);
      if (!rule) continue;
      // Move the foreground token; backgrounds are structural choices the user
      // made deliberately and are far more disruptive to shift.
      const token = rule.fg;
      const start = TC.parseHex(state.tokens[token]);
      const bg = TC.parseHex(state.tokens[rule.bg]);
      if (!start || !bg) continue;
      // Push away from the background: lighten on dark, darken on light.
      const dir = TC.luminance(bg) > 0.4 ? -1 : 1;
      let best = null;
      for (let step = 1; step <= 40; step++) {
        const amt = dir * step * 6;
        const c = {
          r: clamp(start.r + amt), g: clamp(start.g + amt), b: clamp(start.b + amt), a: start.a,
        };
        const hex = toHex(c, state.tokens[token]);
        const trial = Object.assign({}, state.tokens, { [token]: hex });
        const after = TC.evaluate(trial);
        const still = [...after.results.HARD, ...after.results.SURFACE].find((r) => r.rule === res.rule && r.status === 'FAIL');
        if (!still) { best = hex; break; }
      }
      if (best) {
        state.tokens[token] = best;
        syncTokenInputs(token, best);
        markDirty('palette');
      }
    }
    applyState();
    schedulePreviewWrite(true);
  }

  function clamp(n) { return Math.max(0, Math.min(255, Math.round(n))); }
  function toHex(c, original) {
    const h = '#' + [c.r, c.g, c.b].map((n) => n.toString(16).padStart(2, '0')).join('');
    // Preserve an alpha suffix (edge-dim carries one).
    const m = /^#[0-9a-f]{6}([0-9a-f]{2})$/i.exec(String(original || ''));
    return m ? h + m[1] : h;
  }
  function syncTokenInputs(token, hex) {
    const sw = document.querySelector(`input[data-token="${token}"]`);
    const tx = document.querySelector(`input[data-token-hex="${token}"]`);
    if (sw) sw.value = hex.slice(0, 7);
    if (tx) { tx.value = hex; tx.setAttribute('aria-invalid', 'false'); }
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function presetCard(column, p, isCurrent) {
    const sw = (p.swatches || []).map((c) => `<span style="background:${esc(c)}"></span>`).join('');
    const sample = p.sample
      ? `<span class="k-preset-sample" style="font-family:${esc(p.family || 'inherit')}">${esc(p.sample)}</span>` : '';
    return `
      <button type="button" class="k-preset" role="radio" aria-checked="${isCurrent}"
              tabindex="${isCurrent ? '0' : '-1'}"
              data-preset-id="${esc(p.id)}" data-column="${esc(column)}">
        <span class="k-preset-mark" aria-hidden="true">✓</span>
        <span class="k-preset-name">${esc(p.name)}</span>
        ${sw ? `<span class="k-preset-swatches" aria-hidden="true">${sw}</span>` : ''}
        ${sample}
        <span class="k-preset-blurb">${esc(p.blurb || '')}</span>
      </button>`;
  }

  /**
   * Load every preset font up front so the sample text in each card actually
   * renders in that font.
   *
   * Previously the only <link> injected was the SELECTED font's, so an unloaded
   * family fell back to the page font and the cards all looked identical — the
   * sample only "worked" after you picked it, which is exactly backwards for a
   * chooser. Fonts are cached by the browser, so this is one-time.
   */
  function preloadPresetFonts() {
    for (const p of (presets.font || [])) {
      const href = p['google-font-url'];
      if (!href || document.querySelector(`link[href="${CSS.escape(href)}"]`)) continue;
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      document.head.appendChild(link);
    }
  }

  function renderPresets() {
    document.querySelectorAll('.k-section[data-kind="preset"]').forEach((sec) => {
      const col = sec.dataset.column;
      const row = sec.querySelector('[data-preset-row]');
      const current = (state._kit.selected || {})[col];
      const list = presets[col] || [];
      row.innerHTML = list.map((p) => presetCard(col, p, p.id === current)).join('');
      updateSectionValue(sec);
    });

    const fx = document.querySelector('.k-section[data-column="effects"]');
    if (fx && presets.effects) {
      const cur = (state.effects || {}).particles || 'none';
      fx.querySelector('[data-effects-group="particles"]').innerHTML =
        (presets.effects.particles || []).map((p) => presetCard('effects-particles', p, p.id === cur)).join('');
      updateSectionValue(fx);
    }
  }

  function renderTokens() {
    const wrap = document.getElementById('k-token-list');
    if (!wrap) return;
    wrap.innerHTML = KS.TOKEN_KEYS.map((t) => {
      const v = (state.tokens && state.tokens[t]) || '#000000';
      return `
        <div class="k-token-row" data-token="${t}">
          <label class="k-token-swatch">
            <input type="color" value="${esc(v.slice(0, 7))}" data-token="${t}">
            <span class="k-sr">${t} colour picker</span>
          </label>
          <span class="k-token-meta">
            <span class="k-token-name">${t}</span>
            <span class="k-token-use">${esc(KS.TOKEN_USES[t] || '')}</span>
          </span>
          <input class="k-token-hex" type="text" value="${esc(v)}" spellcheck="false"
                 autocapitalize="off" aria-label="${t} hex value" data-token-hex="${t}">
          <span class="k-badge" data-badge="${t}"></span>
        </div>`;
    }).join('');
  }

  function updateSectionValue(sec) {
    const el = sec.querySelector('[data-value]');
    if (!el) return;
    const col = sec.dataset.column;
    let text = '';
    if (col === 'effects') {
      const p = (state.effects || {}).particles || 'none';
      const on = [];
      if ((state.effects || {}).vignette) on.push('vignette');
      if ((state.effects || {}).noise) on.push('noise');
      if ((state.effects || {})['scan-lines']) on.push('scanlines');
      text = [p === 'none' ? null : p, ...on].filter(Boolean).join(' + ') || 'none';
    } else if (col === 'palette') {
      const id = (state._kit.selected || {}).palette;
      const p = (presets.palette || []).find((x) => x.id === id);
      text = p ? p.name : 'custom';
    } else if (col === 'font') {
      text = (state.font && state.font.family || '').split(',')[0].replace(/['"]/g, '') || 'custom';
    } else {
      const id = (state._kit.selected || {})[col];
      const p = (presets[col] || []).find((x) => x.id === id);
      text = p ? p.name : 'custom';
    }
    el.textContent = text;
  }

  function markDirty(col) {
    dirty.add(col);
    const sec = document.querySelector(`.k-section[data-column="${col}"]`);
    if (sec) {
      const d = sec.querySelector('.k-dirty');
      if (d) d.hidden = false;
      updateSectionValue(sec);
    }
    updateDock();
  }

  function updateDock() {
    const n = dirty.size;
    const st = document.getElementById('k-dock-status');
    if (st) {
      st.innerHTML = n === 0
        ? 'No changes yet<span class="k-dock-sub">Presets and sliders apply instantly</span>'
        : `${n} section${n === 1 ? '' : 's'} changed<span class="k-dock-sub">Applied live · Build when ready</span>`;
    }
  }

  // ── Persistence ───────────────────────────────────────────────────────────
  //
  // The server broadcasts a reload on any content-dir change, so Claude
  // regenerating an asset will reload this page mid-edit. Keep the working
  // state, but let a NEWER kit-state.json from Claude win — otherwise a
  // freshly generated wallpaper would be silently discarded.

  function persist() {
    try { sessionStorage.setItem('kit-state', JSON.stringify(state)); } catch (e) { /* quota */ }
  }

  function restore(fresh) {
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem('kit-state') || 'null'); } catch (e) { saved = null; }
    if (!saved || !saved._kit) return fresh;
    const savedRev = saved._kit.revision || 0;
    const freshRev = (fresh._kit && fresh._kit.revision) || 0;
    return freshRev > savedRev ? fresh : saved;
  }

  // ── Wiring ────────────────────────────────────────────────────────────────

  function applyPreset(col, id) {
    if (col === 'palette') {
      const p = (presets.palette || []).find((x) => x.id === id);
      if (!p) return;
      // Preset palettes in kit-presets.json ship display swatches, not a full
      // 15-token set, so pull the real tokens from the palettes/ starter file.
      fetch(`/files/palette-${id}.json`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data && data.tokens) {
            state.tokens = Object.assign({}, data.tokens);
            if (data.shape) {
              state.shape = state.shape || {};
              if (data.shape['radius-base'] != null) {
                state.shape.radius = data.shape['radius-base'] + 'px';
                state.shape['radius-sm'] = data.shape['radius-base'] + 'px';
                state.shape['radius-md'] = (data.shape['radius-base'] * 2) + 'px';
              }
              if (data.shape['radius-round'] != null) {
                state.shape['radius-lg'] = data.shape['radius-round'] + 'px';
              }
            }
            renderTokens();
            applyState();
            schedulePreviewWrite(true);
          }
        })
        .catch(() => { /* palette file not staged — presets stay display-only */ });
    } else if (col === 'chrome') {
      const p = (presets.chrome || []).find((x) => x.id === id);
      if (p && p.layout) state.layout = Object.assign({}, state.layout, p.layout);
    } else if (col === 'bubble') {
      const p = (presets.bubble || []).find((x) => x.id === id);
      if (p) state.layout = Object.assign({}, state.layout, { 'bubble-style': p.value });
    } else if (col === 'font') {
      const p = (presets.font || []).find((x) => x.id === id);
      if (p) state.font = { family: p.family, 'google-font-url': p['google-font-url'] };
    } else if (col === 'effects-particles') {
      state.effects = Object.assign({}, state.effects, { particles: id });
      col = 'effects';
    }
    state._kit.selected = Object.assign({}, state._kit.selected, { [col]: id });
    markDirty(col);
    applyState();
    schedulePreviewWrite(true);
  }

  function onPresetClick(card) {
    const col = card.dataset.column;
    const id = card.dataset.presetId;
    const group = card.closest('[data-preset-row]');
    group.querySelectorAll('.k-preset').forEach((c) => {
      c.setAttribute('aria-checked', String(c === card));
      c.tabIndex = c === card ? 0 : -1;
    });
    applyPreset(col, id);
  }

  /** Roving tabindex: one tab stop per group, arrows move within it. Without
   *  this, tabbing past eight sections of presets is dozens of stops. */
  function onPresetKeydown(e) {
    const card = e.target.closest('.k-preset');
    if (!card) return;
    const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const group = card.closest('[data-preset-row]');
    const cards = [...group.querySelectorAll('.k-preset')];
    const i = cards.indexOf(card);
    const fwd = e.key === 'ArrowRight' || e.key === 'ArrowDown';
    const next = cards[(i + (fwd ? 1 : -1) + cards.length) % cards.length];
    next.focus();
    onPresetClick(next);
  }

  function setPath(obj, path, value) {
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!cur[parts[i]]) cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
  }

  function wire() {
    if (!stage) stage = document.querySelector('.app-mockup');

    document.addEventListener('click', (e) => {
      const card = e.target.closest('.k-preset');
      if (card) { onPresetClick(card); return; }

      const toggle = e.target.closest('.k-section-toggle');
      if (toggle) {
        toggle.setAttribute('aria-expanded', toggle.getAttribute('aria-expanded') === 'true' ? 'false' : 'true');
        return;
      }
    });
    document.addEventListener('keydown', onPresetKeydown);

    // Colour pickers — `input` fires continuously while dragging.
    document.addEventListener('input', (e) => {
      const t = e.target;
      if (t.matches('input[type="color"][data-token]')) {
        const token = t.dataset.token;
        state.tokens[token] = toHex(TC.parseHex(t.value), state.tokens[token]);
        syncTokenInputs(token, state.tokens[token]);
        markDirty('palette');
        state._kit.selected.palette = 'custom';
        applyState();
        schedulePreviewWrite(false);
        return;
      }
      if (t.matches('input[data-token-hex]')) {
        const token = t.dataset.tokenHex;
        const v = t.value.trim();
        const parsed = /^#?[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(v) ? (v[0] === '#' ? v : '#' + v) : null;
        t.setAttribute('aria-invalid', parsed ? 'false' : 'true');
        if (!parsed) return;
        state.tokens[token] = parsed;
        const sw = document.querySelector(`input[type="color"][data-token="${token}"]`);
        if (sw) sw.value = parsed.slice(0, 7);
        markDirty('palette');
        state._kit.selected.palette = 'custom';
        applyState();
        schedulePreviewWrite(false);
        return;
      }
      if (t.matches('.k-slider')) {
        const path = t.dataset.path;
        const num = t.dataset.int ? parseInt(t.value, 10) : parseFloat(t.value);
        if (t.dataset.radiusScale) {
          // "Corner radius" is one knob over the whole scale. Setting only
          // radius-md would leave sm/lg inconsistent, and the app derives
          // --radius-toggle from md, so the set has to move together.
          state.shape = state.shape || {};
          state.shape.radius = Math.round(num * 0.7) + 'px';
          state.shape['radius-sm'] = Math.round(num * 0.7) + 'px';
          state.shape['radius-md'] = num + 'px';
          state.shape['radius-lg'] = Math.round(num * 1.6) + 'px';
        } else if (t.dataset.storeUnit) {
          // Some manifest fields are unit-bearing strings ("6px") while others
          // are bare numbers (panels-blur). Storing a bare number where a string
          // is expected yields `--radius-md: 6`, which is invalid CSS and is
          // silently dropped.
          setPath(state, path, num + t.dataset.storeUnit);
        } else {
          setPath(state, path, num);
        }
        const out = t.parentElement.querySelector('.k-slider-out');
        if (out) out.textContent = t.value + (t.dataset.unit || '');
        t.setAttribute('aria-valuetext', t.value + ' ' + (t.dataset.unitWord || ''));
        markDirty(t.dataset.section || 'chrome');
        applyState();
        schedulePreviewWrite(false); // debounced: this is the drag path
        return;
      }
    });

    // Discrete commits flush immediately — only drags need the debounce.
    document.addEventListener('change', (e) => {
      if (e.target.matches('.k-slider, input[type="color"], input[data-token-hex]')) {
        schedulePreviewWrite(true);
      }
    });

    // Overlay toggles (vignette / noise / scanlines)
    document.querySelectorAll('[data-overlay]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.overlay;
        state.effects = state.effects || {};
        const on = btn.getAttribute('aria-pressed') === 'true';
        if (key === 'scan-lines') state.effects['scan-lines'] = !on;
        else state.effects[key] = on ? 0 : (key === 'noise' ? 0.035 : 0.25);
        btn.setAttribute('aria-pressed', String(!on));
        markDirty('effects');
        applyState();
        schedulePreviewWrite(true);
      });
    });

    // Free-text Google Font
    const fontInput = document.getElementById('k-font-custom');
    if (fontInput) {
      fontInput.addEventListener('change', () => {
        const name = fontInput.value.trim();
        if (!/^[A-Za-z0-9 ]{1,40}$/.test(name)) {
          fontInput.setAttribute('aria-invalid', 'true');
          return;
        }
        fontInput.setAttribute('aria-invalid', 'false');
        state.font = {
          family: `'${name}', 'Cascadia Mono', monospace`,
          'google-font-url': `https://fonts.googleapis.com/css2?family=${name.replace(/ /g, '+')}:wght@400;600;700&display=swap`,
        };
        state._kit.selected.font = 'custom';
        markDirty('font');
        applyState();
        schedulePreviewWrite(true);
        // A 404'd font silently falls back, which looks like "nothing happened".
        if (document.fonts && document.fonts.ready) {
          document.fonts.ready.then(() => {
            const ok = document.fonts.check(`12px "${name}"`);
            const note = document.getElementById('k-font-note');
            if (note) note.textContent = ok ? '' : `"${name}" did not load — check the name.`;
          });
        }
      });
    }

    // Chrome light/dark for the EDITOR, not the theme.
    const scheme = document.getElementById('k-scheme');
    if (scheme) {
      scheme.addEventListener('click', () => {
        const cur = document.documentElement.dataset.chromeScheme === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset.chromeScheme = cur;
        try { localStorage.setItem('kit-chrome-scheme', cur); } catch (e) { /* ignore */ }
        scheme.textContent = cur === 'dark' ? '☾ dark' : '☀ light';
      });
    }

    const liveBtn = document.getElementById('k-live-toggle');
    if (liveBtn) liveBtn.addEventListener('click', () => setLive(!liveEnabled));

    const nudge = document.getElementById('k-nudge');
    if (nudge) nudge.addEventListener('click', nudgeToPass);

    // Mockup variants — preview-only, not theme state.
    //
    // These two are the ONE case that genuinely needs re-expansion. Everything
    // else the editor changes is a CSS variable or a styling attribute, which
    // restyles live. But data-drawer and data-platform are read by renderChrome
    // at expansion time to decide what DOM to emit at all (whether a drawer pane
    // exists; whether caption buttons exist and which side the toggle sits on).
    // Setting the attribute afterwards changed nothing, so both buttons looked
    // dead. Re-expanding is cheap and only happens on an explicit click.
    document.querySelectorAll('[data-mockup-attr]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const attr = btn.dataset.mockupAttr;
        const val = btn.dataset.mockupValue;
        const on = btn.getAttribute('aria-pressed') === 'true';
        if (on) stage.removeAttribute(attr); else stage.setAttribute(attr, val);
        btn.setAttribute('aria-pressed', String(!on));
        reExpandStage();
      });
    });

    document.querySelectorAll('[data-request]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const kind = btn.dataset.request;
        const note = (document.querySelector(`[data-note="${kind}"]`) || {}).value || '';
        send({ type: 'kit-request', kind, note, state });
        btn.textContent = 'Sent — Claude is on it';
        btn.disabled = true;
      });
    });

    const build = document.getElementById('k-build');
    if (build) {
      build.addEventListener('click', () => {
        const blocking = Number(build.dataset.blocking || 0);
        if (blocking > 0 && build.dataset.confirmed !== '1') {
          build.dataset.confirmed = '1';
          build.textContent = `${blocking} contrast issue${blocking === 1 ? '' : 's'} — build anyway?`;
          return;
        }
        send({ type: 'kit-build', state });
        build.textContent = 'Building — return to the terminal';
        build.disabled = true;
      });
    }

    // Closing the tab should hand the app back to the user's own theme. The
    // server also detects the socket going away, but a beacon makes it instant
    // instead of waiting out the grace period.
    window.addEventListener('pagehide', () => {
      if (!liveEnabled) return;
      try {
        const blob = new Blob([JSON.stringify({ enabled: false })], { type: 'application/json' });
        navigator.sendBeacon('/preview', blob);
      } catch (e) { /* server's disconnect grace timer covers this */ }
    });
  }

  function send(msg) {
    if (window.brainstorm && window.brainstorm.send) window.brainstorm.send(msg);
  }

  // ── Boot ──────────────────────────────────────────────────────────────────

  function boot() {
    Promise.all([
      fetch('/files/kit-state.json').then((r) => r.json()),
      fetch('/files/kit-presets.json').then((r) => r.json()),
    ]).then(([fresh, p]) => {
      presets = p;
      state = restore(fresh);
      // Resolve the stage BEFORE the first applyState. It used to be assigned
      // in wire(), which boot calls afterwards, so applyState hit its
      // `if (!stage) return` guard and the initial paint silently did nothing —
      // no tokens, no layout attrs, no contrast readout.
      stage = document.querySelector('.app-mockup');
      const problems = KS.validate(state);
      if (problems.length) console.warn('kit-state problems:', problems);

      state._kit = state._kit || {};
      state._kit.selected = state._kit.selected || {};

      document.getElementById('k-theme-name').textContent = state._kit.themeName || state.name || 'Untitled';
      document.getElementById('k-theme-slug').textContent = state._kit.finalSlug || '';

      preloadPresetFonts();
      renderPresets();
      renderTokens();
      hydrateControls();
      applyState();
      wire();
      updateDock();

      // NEVER auto-post on load: this page reloads on any content-dir change,
      // so auto-writing would clobber Claude's edits and build a reload loop.
      try {
        const wasLive = sessionStorage.getItem('kit-live') === '1';
        setLiveStatus(wasLive ? 'off' : 'off', wasLive ? 'preview off (re-enable)' : 'preview off');
      } catch (e) { /* ignore */ }
    }).catch((err) => {
      // Surface the REAL error. This catch wraps the whole boot sequence, not
      // just the fetches, so it swallows ordinary code bugs too. It used to say
      // "Failed to load kit-state.json", which sent me chasing a file that had
      // loaded perfectly while a ReferenceError sat three frames down — a
      // hardcoded guess at a cause the code never verified.
      console.error('Kit boot failed:', err);
      const st = document.getElementById('k-dock-status');
      if (st) {
        st.textContent = `Kit failed to start: ${err && err.message ? err.message : String(err)}`;
        const sub = document.createElement('span');
        sub.className = 'k-dock-sub';
        sub.textContent = 'Full stack in the browser console (F12).';
        st.appendChild(sub);
      }
    });
  }

  /** Seed every slider/toggle from state so the UI matches on first paint. */
  function hydrateControls() {
    document.querySelectorAll('.k-slider').forEach((s) => {
      const parts = s.dataset.path.split('.');
      let v = state;
      for (const p of parts) v = (v || {})[p];
      // Values may be unit-bearing strings ("6px"); a range input needs a bare
      // number or it silently falls back to its midpoint.
      if (typeof v === 'string') v = parseFloat(v);
      if (v == null || Number.isNaN(v)) v = Number(s.value);
      s.value = String(v);
      const out = s.parentElement.querySelector('.k-slider-out');
      if (out) out.textContent = s.value + (s.dataset.unit || '');
    });
    document.querySelectorAll('[data-overlay]').forEach((b) => {
      const k = b.dataset.overlay;
      const fx = state.effects || {};
      const on = k === 'scan-lines' ? !!fx['scan-lines'] : !!fx[k];
      b.setAttribute('aria-pressed', String(on));
    });
    const wp = document.getElementById('k-wallpaper-preview');
    if (wp && state.background && state.background.type === 'image' && state.background.value) {
      wp.innerHTML = `<img src="/files/${esc(state.background.value)}" alt="current wallpaper">`;
    } else if (wp) {
      wp.innerHTML = '<span class="k-token-use">No wallpaper — solid or gradient background.</span>';
    }
    try {
      const s = localStorage.getItem('kit-chrome-scheme');
      if (s) {
        document.documentElement.dataset.chromeScheme = s;
        const btn = document.getElementById('k-scheme');
        if (btn) btn.textContent = s === 'dark' ? '☾ dark' : '☀ light';
      }
    } catch (e) { /* ignore */ }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

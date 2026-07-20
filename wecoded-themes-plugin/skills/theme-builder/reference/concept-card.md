# Concept Card Structure

Read this file before generating the 3 concept cards in Phase 1. It documents the `.concept-card` shape, the `.app-mockup` data-attribute contract, and glassmorphism var conventions.

## Per-card structure

**Updated 2026-07-19** — the concept page now shares the Kit editor's chrome, so
cards use `c-`-prefixed classes and `--ui-*` page chrome. The old
`.concept-card` / `.concept-label` markup is gone.

Each concept is a `.c-card` div with `data-choice="A"` (or B, C). Set all the
theme's CSS tokens as inline `style="--canvas: #HEX; …"` on that div — the
`.app-mockup` inside inherits them. **Never write theme tokens to `:root` or
`body`**: three themes share this page, and page chrome reads `--ui-*` and must
stay legible against all of them.

```html
<div class="c-card" data-choice="A"
     style="--canvas:#EDE8DD; --panel:#E3DCCB; --inset:#D2C6AA; --well:#CFC3A8;
            --accent:#7A5A2E; --on-accent:#FFFFFF; --fg:#2B2318; --fg-2:#5A4E3B;
            --fg-dim:#7C7058; --fg-muted:#9C9179; --fg-faint:#C4BCA5;
            --edge:#A8987A; --edge-dim:#A8987A80; --shadow-strength:0.2;
            --font-sans:'Space Grotesk', sans-serif;">
  <div class="c-card-head">
    <span class="c-letter" aria-hidden="true">A</span>
    <div>
      <div class="c-card-title">Ivory Schematic</div>
      <div class="c-card-vibe">Light museum-card minimalism — blueprint on cream paper.</div>
    </div>
  </div>
  <div class="c-swatches" aria-hidden="true">
    <span style="background:#EDE8DD"></span><span style="background:#E3DCCB"></span>
    <span style="background:#D2C6AA"></span><span style="background:#7A5A2E"></span>
    <span style="background:#2B2318"></span>
  </div>
  <div class="c-tags"><span>light</span><span>bordered bubbles</span><span>Space Grotesk</span></div>
  <div class="c-stage">
    <div class="app-mockup" data-mockup …></div>
  </div>
</div>
```

Selection state is handled by the page (`aria-checked` on `.c-card`) — don't
hand-write a selected class.

## App mockup (data-attribute contract)

**Do NOT inline chrome HTML.** The concept-page-template loads `scripts/mockup-render.js`, which scans the page for `[data-mockup]` elements and injects the canonical chrome — settings gear, session pill, chat/terminal toggle, attach/compass/send icons, model/permission/usage chips — from a central template.

Concepts author only the outer div and its data attributes:

```html
<div class="app-mockup"
     data-mockup
     data-wallpaper="/files/wallpaper-a.jpg"
     data-session="main"
     data-session-color="green"
     data-model="Opus 1M"
     data-permission="NORMAL"
     data-usage="23"
     data-asst1="Rumi, Mira, Zoey — ready when you are."
     data-user="Light the Honmoon"
     data-asst2="Barrier holding at 98%."
     data-tool-card="read · honmoon.json"
     data-fx="vignette"
     data-input-style="floating"
     data-bubble-style="pill"
     style="--panels-blur: 14px; --panels-opacity: 0.72; --bubble-blur: 10px; --bubble-opacity: 0.78; --vignette-opacity: 0.28;">
</div>
```

`data-fx` accepts space-separated values: `vignette`, `noise`, `scanlines`. The mockup-render script handles everything inside `.app-mockup` — you never write the chrome HTML directly. This cuts per-concept HTML from ~1 KB to ~300 bytes and guarantees icons/toggles/send-arrow are identical across concepts.

For reference, the full chrome template mockup-render injects lives at `scripts/app-mockup-chrome.html` (structural spec) and inside `scripts/mockup-render.js` (runtime source). You rarely need to open either — just set the data attributes above.

## CSS conventions

Use the exact CSS classes from `theme-preview.css`. All colors from CSS custom properties — never hardcode hex in element styles except on the scoping `.concept-card` div.

## Wallpaper compositing

Mirrors the real app: `#theme-bg` paints the wallpaper across the whole mockup box, `.chat-area` is transparent, and chrome bars (header/input/status) sit on top as `color-mix()` + `backdrop-filter` glass. Don't add a background to `.chat-area` or give chrome bars a fully opaque `--panels-opacity` — either will hide the wallpaper. To preview the wallpaper clearly, keep `--panels-opacity` in the 0.55–0.85 range when a wallpaper is set.

## Identical send arrow

The send button SVG path is `M5 12h14M12 5l7 7-7 7` — used everywhere. Any concept that substitutes ▶ / → / ▲ or a custom shape is wrong and will be rejected at review.

## Glassmorphism vars

Set on the `.app-mockup` wrapper: `style="--panels-blur: Npx; --panels-opacity: N; --bubble-blur: Npx; --bubble-opacity: N;"`. `theme-preview.css` applies glass unconditionally via `color-mix()` + `backdrop-filter`, so you don't need any attribute gate. At defaults (`0px` / `1`) rules are a visual no-op.

---
name: theme-builder
description: Build immersive YouCoded theme packs. Invoke as /theme-builder "your vibe description". Users can start from a general vibe, a specific detailed brief, or by uploading their own wallpaper. Three-phase — concept browser, then Kit refinement (swap palette/layout/bubble/font/effects/wallpaper/mascots/icons per column), then theme pack finalization.
---

# /theme-builder

Build a custom YouCoded theme pack. Three starting modes:

- **General vibe** — short prompt like "cozy autumn", "cyberpunk", "Hello Kitty". Claude designs from scratch.
- **Specific detailed description** — longer brief covering palette, fonts, layout, mood, references. Claude follows precisely.
- **Upload your own wallpaper** — user drops in an image and Claude builds the theme around it.

Three-phase flow:
1. **Concept browser** — Claude generates 3 options in a browser window (no app changes)
2. **Kit refinement** — user picks one; lands on a single-page builder where palette / chrome / bubble / font / effects / wallpaper / mascots / icons are swappable columns
3. **Build** — finalize pack (folder with manifest + assets); app hot-reloads

## Reference files (load on demand)

Stay out of context until needed:

- `reference/concept-card.md` — concept card HTML structure, app-mockup data attributes, glassmorphism vars. **Read before generating Phase 1 concepts.**
- `reference/tokens.md` — contrast rules, palette temperature, effect intensity, layout preset notes. **Read before designing a palette from scratch or writing a palette override.** Skip if applying a Kit preset unmodified.
- `reference/mascots.md` — non-negotiable mascot rendering rules. **Read before generating any mascot SVG.**
- `reference/phase2-finalize.md` — full Phase 2 build steps (folder promote, terminal-bg bake, manifest, custom CSS, contrast validation). **Read when processing `intent: "build"`.**

---

## Wallpaper recommendation (ask early)

Most themes use a wallpaper. **Always recommend the user provide their own** — saves tokens and speeds things up. Ask upfront before generating concepts. Then:

- **User provides one wallpaper** — use as the visual anchor for all 3 concepts. Differentiate concepts through palette, overlay tint, and effects — not by swapping the wallpaper.
- **User wants Claude to find them** — **narrow the direction first.** A prompt like "KPop Demon Hunters" or "Studio Ghibli" branches many ways. Searching blindly wastes a second round course-correcting. Instead:

  **Medium default (tell the user):** Unless the prompt explicitly calls for photography (e.g. "real photo", "photograph", "photorealistic"), default to non-photographic art — illustration, digital painting, sketch, watercolor, or animation stills. Before proposing directions, say something like: *"I'll default to illustrated/artistic styles rather than real photos — let me know if you'd prefer photography instead."*

  1. Sketch the axes that actually vary for this prompt. Typical ones: **Medium** (illustration / digital painting / watercolor / sketch / animation still — default; or realistic photo if user directs), **Tone** (dark / bright / neon), **Subject** (main character / full cast / environment / abstract), **Scene energy** (action / atmospheric / iconic pose).
  2. Propose **3 starting directions** as named bundles (e.g. *"A — main character, dark action; B — full cast, bright promo; C — environment, atmospheric"*). Two axes per bundle is enough. Each bundle should reflect the art-first default in its medium unless overridden.
  3. Wait for user to pick, merge, or override. Only then search.

  After confirm, download **3 separate wallpapers** (one per concept) before rendering concepts.

  **Use `scripts/fetch-wallpaper.cjs`.** Handles CDN hot-link protection (stock-image sites return ~20 KB placeholder without correct Referer + User-Agent) and gallery pages (extracts `og:image` and fetches that). Usage: `node scripts/fetch-wallpaper.cjs <url> <out-path>`.

  **1080p rule:** every wallpaper ≥ 1920×1080 (either orientation). `fetch-wallpaper.cjs` rejects sub-HD with a JSON error; on rejection, search for a higher-res source.

  Skip narrowing if the prompt already pins medium + tone + subject (e.g. "dark noir black-and-white Blade Runner street").

---

## Phase 1 — Concept Browser

### Step 1: Start the Visual Companion Server

```bash
bash "core/skills/theme-builder/scripts/start-server.sh" --project-dir ~/.claude/wecoded-themes
```

Use `run_in_background: true`. Read the `server-info` file after 3 seconds.

### Step 2: Stage Assets for Preview Server

```bash
cp core/skills/theme-builder/theme-preview.css "${screen_dir}/theme-preview.css"
cp core/skills/theme-builder/scripts/helper.js "${screen_dir}/helper.js"
cp core/skills/theme-builder/scripts/layout-gallery.html "${screen_dir}/layout-gallery.html"
```

All HTML links CSS via `<link rel="stylesheet" href="/files/theme-preview.css">` — do NOT embed CSS inline. All asset refs in HTML use the `/files/` prefix (bare filenames 404).

### Step 3: Determine Prompt Mode (automatic — never ask)

- **Brand/IP Mode** — references a recognizable character, brand, franchise, or product. Research-first; brand fidelity paramount.
- **Vibe/Abstract Mode** — aesthetic, mood, setting, abstract concept. Creative-first; freedom to invent.

### Step 4: Generate 3 Theme Concepts

**Before designing, read three files in parallel:**

```
scripts/concept-page-template.html    — page shell to fill in
scripts/app-mockup-chrome.html        — canonical chrome body (icons + layout)
scripts/manifest-template.jsonc       — final manifest schema (read NOW, not deferred to Phase 2 — frame tokens in final shape from the start)
```

Also read `reference/concept-card.md` for card structure and mockup data-attrs.

**Optional but recommended:** browse `scripts/palettes/*.json` for pre-validated 15-token starter kits. If one matches the vibe, start from it and tweak — faster, less likely to fail contrast.

Design **3 genuinely different interpretations** — not 3 tints of the same concept.

**Differentiator rule:** each concept MUST differ from the others on **at least 2** of {palette family, layout preset, font character, bubble shape, primary decorative effect}. Three concepts sharing everything except palette = one concept in three tints — regenerate.

For each concept, decide: palette (15 tokens, see `reference/tokens.md`), shape radius, font (Google or system — set `--font-sans` + `--font-mono`, add `<link>` in `<head>`), background (solid / gradient / image — if wallpapers downloaded, each concept uses its own), layout presets, effects, pattern overlay, icon overrides, mascot crossover plan, custom CSS effects.

### Step 5: Tell the User + Quick-Apply

Tell user the URL. They pick a concept by clicking a card — server logs a `choice` event. On pick, immediately seed a minimal `_preview`:

```bash
mkdir -p ~/.claude/wecoded-themes/_preview
```

Write `manifest.json` with tokens, shape, layout, effects, font from the selected concept — no asset paths yet. App auto-switches to `_preview` and auto-reverts when the folder is deleted, so the user sees the theme live while Kit-refining.

> **Slug invariant (critical — silent failure):** Manifest's internal `"slug"` field MUST be `"_preview"` during Kit phase, matching the directory name. The renderer keys hot-reload auto-switch off the directory name, then looks up the loaded theme by its internal `.slug`. If they don't match (e.g. you used the final slug like `"strawberry-kitty"` while the folder is still `_preview`), auto-switch fires but resolves to the default built-in theme instead — the app appears to silently ignore the preview. Only rename the slug field to its final value in Phase 2 when you move the folder.

Then move to Phase 1.5 (Kit) instead of open-ended chat iteration. Keep the concept browser URL in case the user asks to revisit alternates.

---

## Phase 1.5 — Kit Refinement

User lands on the **Kit** — one page with eight swappable columns. Primary authoring surface; most refinement happens here, not in chat.

| Column | Kind | What it does |
|---|---|---|
| Palette | preset + override | Swap the 15-token color set |
| Chrome & Layout | preset + override | `chrome-style` / `input-style` / `header-style` / `statusbar-style` |
| Bubble Style | preset + override | `bubble-style` preset |
| Font | preset + override | Swap Google Font, auto-linked on rebuild |
| Effects | multi + override | Particles (pick one) + overlay textures (vignette / noise / scanlines) |
| Wallpaper | review + override | Keep hero image, or describe a change |
| Mascots | review + override | Keep 4 mascot variants, or describe changes |
| Icons & Details | review + override | Keep icon overrides / cursor / scrollbar, or describe changes |

### Step 5a: Generate Baseline Assets

Before rendering Kit, generate the assets Kit needs in review columns. Write into `_preview/assets/` (so live app hot-loads them) AND copy to `screen_dir` (so Kit references via `/files/`).

> **Write order matters — manifest LAST.** Assets first, manifest second. The chokidar watcher fires a reload per file; if the manifest exists before all assets, the reload reads it and the app briefly renders with broken asset URLs. Writing manifest last lets the debounce collapse everything to one clean event after all files are present.

1. **Hero wallpaper** — copy chosen concept's wallpaper to `_preview/assets/wallpaper.<ext>` and `${screen_dir}/wallpaper.<ext>`.
2. **Mascots** (4 variants, if theme has them) — **read `reference/mascots.md` before generating.** Write `_preview/assets/mascot-{idle,welcome,shocked,dizzy}.svg` and mirror into `screen_dir`. Skip the rig here — Kit iterates on the flat variants; the rig is authored once in Phase 2 from the settled design.
3. **Icon overrides** — only the slots the concept calls for. `_preview/assets/icon-<slot>.svg` + mirror.
4. **Pattern SVG** — only if concept has a pattern. `_preview/assets/pattern.svg` + mirror.
5. **Manifest LAST** — `_preview/manifest.json` with relative asset paths. Omit mascot / icon / pattern sections if not used — matching Kit columns hide themselves automatically.

### Verify the preview activated

After writing the manifest, tell the user: "The app should auto-switch to the preview. If you don't see it apply within a few seconds, say so." Don't assume success — silent activation failure is the most common way this skill has broken historically.

Fallback if user reports no change: **rename `_preview` → final-slug immediately** (skip Kit refine). Promotes the theme into the picker so they can select manually. Loses auto-hot-reload but gets a working theme. Symptoms:

- Older packaged build (pre-chokidar fix) — `fs.watch` misses new subdirs on Windows
- Manifest slug field ≠ directory name (`_preview`) — renderer falls back to default. Now warned in DevTools console — ask user to check.
- Watcher event fired before renderer mounted its listener — race condition

### Step 5b: Stage the Kit Page

```bash
cp core/skills/theme-builder/scripts/kit-refinement-template.html "${screen_dir}/screen.html"
cp core/skills/theme-builder/scripts/kit-presets.json "${screen_dir}/kit-presets.json"
```

Fill placeholders in `screen.html`:

- `<!-- THEME_NAME -->` — concept's display name
- `<!-- GOOGLE_FONTS -->` — `<link>` tags for the concept's font
- `<!-- CURRENT_MOCKUP -->` — one `<div class="app-mockup" data-mockup …>` with selected concept's data-attrs + glass vars (identical shape to concept card mockups)
- Each preset-kind column: `data-current="<preset-id>"` on the `<section>`, fill `CURRENT_<COL>_NAME` / `CURRENT_<COL>_BLURB`. Preset ids from `kit-presets.json` (e.g. `warm-cozy`, `floating`, `pill`, `nunito`). Use `custom` if concept matches no preset — no card gets green-highlighted.
- `effects` column: `data-current-particles="<id>"` + `data-current-overlays="vignette,noise"` (comma-separated currently-on overlays)
- `<!-- WALLPAPER_PREVIEW -->` — `<img src="/files/wallpaper.<ext>">`
- `<!-- MASCOT_PREVIEW -->` — 4 `.asset-tile` divs wrapping mascot SVGs. Leave empty or set `data-hidden="true"` on the column if no mascots.
- `<!-- ICONS_PREVIEW -->` — icon tiles + cursor + scrollbar strip. Hide column if none.

Everything else renders from `kit-presets.json` at page load — don't inline preset cards.

### Step 5c: Process Kit Submissions

Kit sends a `kit-submit` WebSocket event:

```json
{
  "type": "kit-submit",
  "intent": "rebuild" | "build",
  "changes": {
    "palette":  { "action": "preset"|"override"|"keep", "value": "<preset-id>", "note": "..." },
    "chrome":   { ... },
    "bubble":   { ... },
    "font":     { ... },
    "effects":  { "action": "preset", "particles": "<id>", "overlays": ["vignette","noise"], "note": "..." },
    "wallpaper":{ "action": "keep"|"change", "note": "brighter, wider" },
    "mascots":  { ... },
    "icons":    { ... }
  }
}
```

Events appear in server stdout as `{"source":"user-event", "type":"kit-submit", ...}`. Read the server log to see submissions.

On `intent: "rebuild"`:
1. For each `action === "preset"` — apply matching preset from `kit-presets.json` to `_preview/manifest.json`. Palette preset → copy tokens + shape + suggested font. Chrome preset → copy `layout` sub-object. Bubble → set `layout.bubble-style`. Font → set `font.family` + `font.google-font-url`.
2. For each `action === "override"` (preset kinds) or `action === "change"` (review kinds) — interpret `note` and regenerate that slice. Palette override → new 15-token set (pipe through `check-contrast.cjs --tokens-json -`; see `reference/tokens.md`). Mascot change → regenerate 4 SVGs per `reference/mascots.md`. Wallpaper change → fetch via `fetch-wallpaper.cjs`.
3. Re-copy updated assets to `screen_dir` so `/files/` serves fresh content.
4. Rewrite `screen.html` with updated `data-current` attrs + preview blocks. File-watcher auto-reloads the browser.

On `intent: "build"` → proceed to Phase 2. **Read `reference/phase2-finalize.md`.**

**Escape hatch:** if user explicitly asks to "show me more options," copy `concept-page-template.html` back over `screen.html` and regenerate concepts. Default flow stays on Kit.

---

## Phase 2 — Finalize & Ship

When Kit user clicks **Build Theme Pack** (intent `"build"`), **read `reference/phase2-finalize.md`** and follow its steps: folder promote, terminal-bg bake, manifest write, custom CSS write, contrast validate, confirm to user, delete `_preview`.

Most assets already exist in `_preview/assets/` from Phase 1.5 — Phase 2 is mostly `cp` operations; only regenerate what's missing.

**Mascot rig (if the theme has mascots):** author `assets/mascot-rig.svg` from the settled
flat-mascot design and add `"rig": "assets/mascot-rig.svg"` to the manifest's `mascot`
section — see the "Mascot rig" section of `reference/mascots.md` (mix/match a skin from the
wecoded-themes `mascots/` library, adapt an example, or generate under the README
constraints). Flat variants stay in the manifest — they're what the app renders until the
rig renderer ships.

---

## Phase 3 — In-App Refinement

After the pack is written, refinements go directly to manifest or asset files; app hot-reloads. See "Phase 3" section in `reference/phase2-finalize.md` for common refinement patterns.

---

## Rules

- NEVER modify files in `src/renderer/themes/builtin/` or write to any path inside the app bundle
- All asset paths in manifest.json MUST be relative
- Use `custom_css` for effects the schema doesn't cover
- NEVER set `border-radius` on bubble elements in `custom_css` — use `bubble-style` preset and `shape` values
- Pattern SVGs must tile seamlessly; particle shapes must work at 8–16 px
- When generating mascots, ALWAYS read base templates first for silhouette/proportions AND follow `reference/mascots.md`. The base templates' currentColor-fill + cutout-eye pattern fails on most themes.
- Preview CSS (`theme-preview.css`) and app's `globals.css` are a CONTRACT — if either changes, both must stay in sync
- NEVER write the concepts page HTML from scratch — always read `scripts/concept-page-template.html` first and fill placeholders
- NEVER write the Kit page HTML from scratch — copy `scripts/kit-refinement-template.html` and fill placeholders. The template renders preset cards from `kit-presets.json` at runtime — do NOT inline preset cards.

---

## Phase Checklists

**Before rendering concepts (Phase 1):**
- [ ] `scripts/concept-page-template.html`, `scripts/app-mockup-chrome.html`, `scripts/manifest-template.jsonc`, and `reference/concept-card.md` have been read (manifest in Phase 1, not deferred)
- [ ] Each `.app-mockup` uses `data-mockup` + data-* placeholders — NO inlined chrome HTML, NO hand-drawn icons (`mockup-render.js` injects canonical chrome at runtime)
- [ ] Concepts differ on ≥ 2 of {palette family, layout preset, font character, bubble shape, primary effect}
- [ ] All asset references use `/files/` prefix; CSS linked not inlined
- [ ] Glassmorphism mockups set all four glass vars: `--panels-blur`, `--panels-opacity`, `--bubble-blur`, `--bubble-opacity`
- [ ] Wallpaper concepts: `--panels-opacity` ≤ 0.85 so the wallpaper bleeds through chrome
- [ ] Concept palette piped through `check-contrast.cjs --tokens-json -` — passes HARD rules before HTML is written
- [ ] `on-accent` passes 4.5:1 against `accent`

**Before rendering Kit (Phase 1.5):**
- [ ] Concept pick seeded into `_preview/manifest.json` (tokens + shape + layout + font + effects)
- [ ] Baseline assets generated into BOTH `_preview/assets/` AND `screen_dir`: wallpaper, mascots (if applicable), icons (if applicable), pattern (if applicable)
- [ ] Mascots (if generated) follow `reference/mascots.md`
- [ ] `kit-refinement-template.html` → `screen_dir/screen.html` and `kit-presets.json` → `screen_dir/kit-presets.json`
- [ ] Placeholders filled: THEME_NAME, GOOGLE_FONTS, CURRENT_MOCKUP, every column's `data-current` + current name/blurb, review columns' asset preview tiles
- [ ] Columns with no corresponding assets hidden with `data-hidden="true"`
- [ ] Preset cards NOT inlined — page renders them from kit-presets.json at load time

**When processing kit-submit (Phase 1.5 rebuild):**
- [ ] Only columns with `action !== "keep"` are regenerated
- [ ] Palette overrides piped through `check-contrast.cjs --tokens-json -` before applying (see `reference/tokens.md`)
- [ ] Updated assets mirrored into BOTH `_preview/assets/` AND `screen_dir`
- [ ] `screen.html` rewritten with new `data-current` attrs — file-watcher auto-reloads

**Before finalizing theme pack (Phase 2):**
- [ ] Intent from latest kit-submit is `"build"` — user explicitly asked to ship
- [ ] `reference/phase2-finalize.md` has been read
- [ ] `scripts/manifest-template.jsonc` read before writing manifest.json
- [ ] `scripts/custom-css-reference.md` read before writing custom CSS
- [ ] Assets moved from `_preview/assets/` → `<slug>/assets/`; wallpaper also still in `screen_dir`
- [ ] For image themes: `wallpaper-terminal.webp` baked via `prep-terminal-bg.cjs` AND manifest includes `background.terminal-value`
- [ ] If mascots were regenerated, they follow `reference/mascots.md` (verified distinct at 24 px)
- [ ] If the theme has mascots: `assets/mascot-rig.svg` authored per the "Mascot rig" section of `reference/mascots.md` + manifest `mascot.rig` set (flat variants kept)
- [ ] Manifest uses relative asset paths only
- [ ] Bubble blur/opacity are manifest fields, NOT hardcoded in `custom_css`
- [ ] Wallpaper + pattern come from `background.value` / `background.pattern` — NOT from `body::before`/`body::after` in `custom_css`
- [ ] `check-contrast.cjs` passes with no HARD or SURFACE failures
- [ ] `preview.png` generated via `wecoded-themes/scripts/generate-previews.js <slug>` (Step 7.5) — fallback OK if Playwright unavailable
- [ ] `_preview/` deleted after successful pack creation

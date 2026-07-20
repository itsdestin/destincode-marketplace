# Phase 2 — Finalize & Ship (detail)

Read this file when processing a Kit `kit-build` event. Most assets already exist in `_preview/assets/` from Phase 1.5 — you're mostly moving and packaging, not regenerating.

## Step 0: The kit-state → manifest transform (do this FIRST, in your head)

`kit-build` hands you the Kit's working state. That is **not** a manifest. Three
transforms have to happen, and each one fails silently if you skip it:

| From kit-state | To manifest | If you skip it |
|---|---|---|
| `_kit: { … }` block | **delete it** | junk ships to the registry |
| `slug: "_preview"` | `slug: "<final-slug>"` | **theme silently renders as the default** |
| `background.value: "wallpaper.jpeg"` (bare basename) | `"assets/wallpaper.jpeg"` | broken wallpaper URL |

The same applies to `background.pattern`, every `mascot.*`, and every `icons.*` —
all are stored as bare basenames and all need the `assets/` prefix.

> **The slug rename is the one that has burned this skill most often.** The app
> keys hot-reload off the DIRECTORY name but resolves the theme by the manifest's
> internal `.slug`. While previewing they must both be `_preview`; the moment you
> promote the folder to `<slug>`, the manifest field must move with it. If they
> disagree the app falls back to the built-in default and the user sees a theme
> that looks like it was ignored. The final slug is in `_kit.finalSlug`.

`scripts/kit-state.js` `toManifest()` does exactly this transform for the preview
(strip `_kit`, force the slug, prefix the paths). Phase 2 is the same function
with the *real* slug instead of `_preview` — read it if you want the reference
implementation.

## Step 1: Create the Theme Pack Folder

```bash
mkdir -p ~/.claude/wecoded-themes/<slug>/assets
```

## Step 2: Move the Hero Wallpaper

**Take the filename from the state, never from a guess.** `kit-build`'s
`background.value` holds the exact basename — it is `wallpaper.jpeg` for art
Claude generated, but `wallpaper-user-<id>.<ext>` when the user uploaded their
own image from the Kit (the server names uploads itself, see `POST /wallpaper`).
Hardcoding `wallpaper.<ext>` copies nothing in the upload case and ships a
manifest pointing at a file that does not exist.

```bash
# WALL="$(basename of background.value from the kit-build state)"
cp ~/.claude/wecoded-themes/_preview/assets/"$WALL" \
   ~/.claude/wecoded-themes/<slug>/assets/"$WALL"
```

Keep the filename as-is rather than renaming it to `wallpaper.<ext>` — the
manifest just needs `assets/$WALL` and a rename is one more place to disagree.

Fallback if `background.value` is empty or the file is missing (user started gradient/solid, or Kit never swapped in an image):
- **User-provided wallpaper:** copy directly to `<slug>/assets/wallpaper.<ext>`.
- **Brand/IP Mode:** WebSearch for official/fan art → WebFetch → save.
- **Vibe/Abstract Mode:** WebSearch stock photos (Unsplash, Pexels) → WebFetch → save. Or use CSS gradient if no wallpaper needed.

## Step 2b: Bake the Terminal-View Wallpaper

Only for `type: "image"` themes. TerminalView renders a subtly blurred + darkened version of the wallpaper behind xterm so fine detail doesn't fight the terminal text. Default: 8px sigma blur + brightness 0.86 — a gentle soften that preserves wallpaper character, paired with xterm at 0.6 opacity on top so the wallpaper reads clearly through the terminal. Skip for gradient/solid themes.

```bash
node ${SKILL}/scripts/prep-terminal-bg.cjs \
  ~/.claude/wecoded-themes/<slug>/assets/"$WALL" \
  ~/.claude/wecoded-themes/<slug>/assets/wallpaper-terminal.webp
```

Output is ~15–30 KB. Then add to `manifest.json`:

```json
"background": {
  "type": "image",
  "value": "assets/<the same $WALL filename>",
  "terminal-value": "assets/wallpaper-terminal.webp",
  ...
}
```

If you skip this step, TerminalView falls back to a runtime CSS `filter: blur()` on the sharp wallpaper — visually similar but costs GPU, and is automatically disabled under reduced-effects. Always pre-bake for shipped themes.

## Step 3: Move / Generate SVG Assets

Most SVGs are already in `_preview/assets/`. Copy what's there:

```bash
cp ~/.claude/wecoded-themes/_preview/assets/*.svg \
   ~/.claude/wecoded-themes/<slug>/assets/ 2>/dev/null
```

Only **generate** SVGs that aren't in `_preview` yet (usually cursor, particle shape, scrollbar thumb). Guidelines:
- **Pattern SVG** (`assets/pattern.svg`): Single seamlessly tiling tile, viewBox ~`0 0 40 40`, single fill color
- **Particle Shape SVG** (`assets/<name>.svg`): Single centered shape, simple enough for 8–16px render
- **Icon SVGs** (`assets/icon-<slot>.svg`): 24×24 viewBox, use `currentColor`. Slots: send, new-chat, settings, theme-cycle, close, menu
- **Cursor SVG** (`assets/cursor.svg`): 32×32 viewBox, hotspot at top-left. Only if it genuinely fits.
- **Scrollbar SVG** (`assets/scrollbar-thumb.svg`): Vertical, subtle.

## Step 4: Move / Generate Mascot Crossovers

Mascots usually already exist in `_preview/assets/mascot-{idle,welcome,shocked,dizzy}.svg` (generated in Phase 1.5 Step 5a, regenerated on Kit mascot-change). The `cp *.svg` in Step 3 already moved them.

Only generate here if the theme needs mascots but `_preview` doesn't have them yet. **Read `reference/mascots.md` before generating.**

## Step 5: Write the Manifest

**Read `scripts/manifest-template.jsonc` before writing anything.** Do NOT reconstruct the manifest schema from memory — the template has field documentation, required vs optional markers, and correct structure. Copy it, fill in values, remove unused optional sections. Write to `<slug>/manifest.json`.

Rules:
- All asset paths are **relative** to the theme folder
- Omit optional fields rather than including null/empty
- `on-accent`: `#FFFFFF` if `accent` luminance < 0.179, else `#000000`
- `edge-dim`: edge color with 50% alpha (append `80` to hex)
- `font.family` always includes `'Cascadia Mono', monospace` as fallbacks

## Step 6: Write Custom CSS

**Read `scripts/custom-css-reference.md` before writing any CSS.** Do NOT write custom CSS from memory. Include at minimum:
- `::selection` highlight (always)
- Glassmorphism block (when `panels-blur > 0`)

Wallpaper and pattern are **manifest fields** (`background.value`, `background.pattern`), NOT `custom_css`. The engine renders them via `#theme-bg` and `#theme-pattern` at `z-index: -1` — above the canvas color, behind chat bubbles. Do NOT re-inject them via `body::before`/`body::after` in `custom_css` (old pattern from before the April 8 terminal-opacity fix — now obsolete and actively harmful: the old template prescribed `z-index: 0` which puts pattern in front of bubble text, hurting readability).

Adapt the reference patterns to fit the theme. Do NOT blindly copy — adjust opacity, blur, saturate values. Add decorative effects (glows, animated borders, text shadows) when they fit.

## Step 7: Validate Contrast

```bash
node ${SKILL}/scripts/check-contrast.cjs ~/.claude/wecoded-themes/<slug>/manifest.json
```

If any HARD or SURFACE rules fail, fix the tokens and re-run. Soft warnings can be noted to the user but don't need fixing.

## Step 7.5: Generate preview card image

Run the canonical preview generator from the workspace's wecoded-themes clone — this produces the `preview.png` that the app's Library uses for the local theme card AND that the publisher uploads to the marketplace PR (replacing the publisher's BrowserWindow-based fallback).

```bash
if [ ! -d ~/youcoded-dev/wecoded-themes ]; then
  echo "wecoded-themes not cloned; skipping preview.png. Publisher will generate at publish time."
else
  cd ~/youcoded-dev/wecoded-themes
  [ -d node_modules ] || npm ci
  [ -d node_modules/playwright ] || npx playwright install chromium
  node scripts/generate-previews.js "<slug>" --themes-dir ~/.claude/wecoded-themes
fi
```

Output: `~/.claude/wecoded-themes/<slug>/preview.png` (~150-300 KB at 800×500). The script prints `done: <slug> -> preview.png (<size> KB)` on success.

If preview generation is skipped (wecoded-themes clone missing) or fails (Playwright dependency error, mockup-render failure, etc.), don't block finalization — the publisher's fallback `theme-preview-generator.ts` produces one at publish time, and the Library card falls back to the wallpaper image until that runs. Tell the user the absence of `preview.png` is non-fatal. Confirm Step 7.5 succeeded by checking `ls -la ~/.claude/wecoded-themes/<slug>/preview.png` — if the file exists with reasonable size (~100-300 KB), success.

## Step 8: Confirm to User

Tell the user: "**[Theme Name]** is live in the app. What would you like to change?"

Delete the `_preview` folder if it exists: `rm -rf ~/.claude/wecoded-themes/_preview`

## Phase 3 — In-App Refinement

After the theme pack is written, every refinement goes directly to manifest or asset files. The app hot-reloads automatically.

Common refinements:
- "More glassmorphism" → increase `background.panels-blur`, lower `panels-opacity`. For bubbles: adjust `bubble-blur`/`bubble-opacity`. These are manifest fields — do NOT hardcode in `custom_css`
- "Custom particles" → set `effects.particles: "custom"`, generate shape SVG, update `effects.particle-shape`
- "Different wallpaper" → download new, update `background.value`
- "More glow" → add/enhance `custom_css` effects

After any token change, re-run `check-contrast.cjs` to verify.

# Mascot Rendering Rules

Read this file before generating any mascot SVG. These rules are non-negotiable — the base templates' original `currentColor`-fill + cutout-eye pattern fails on most themes.

## Base templates

Read all 4 before generating:

```
scripts/base-mascot-idle.svg       (>< squinting eyes)
scripts/base-mascot-welcome.svg    (sparkle eyes, waving)
scripts/base-mascot-shocked.svg    (tall oval eyes, O mouth, arms out)
scripts/base-mascot-dizzy.svg      (X-X eyes, zigzag mouth, drooped arms)
```

## What you can / must not do

**Can:** Add accessories on top (hats, bows, capes), held items from arms, surface patterns, appendages (tail, wings), ambient elements (sparkles, flames, leaves), whiskers or brand-specific face details.

**Must not:** Change basic body proportions (squat body, nub arms, stubby legs) or make it unrecognizable.

## Rendering rules (non-negotiable)

The base templates use `currentColor` for the whole body + dark cutouts for eyes. That model breaks on any theme where the text color ends up close to the surface color — body goes dark-on-dark and eye cutouts vanish. Always use this safer pattern instead:

1. **Body: white fill + `currentColor` stroke.** Not a `currentColor` fill. A 0.5–0.8 px stroke keeps the outline theme-aware (matches text color) while the white body guarantees contrast on any surface.
   ```xml
   <path d="..." fill="#FFFFFF" stroke="currentColor" stroke-width="0.6"/>
   ```
2. **Draw eyes and mouth ON TOP of the body, never as cutouts.** Cutouts rely on the body having opposite-luminance to the page background — not true in general themes. Drawn features always render.
   - Squinting `><` → two `<path>` polylines or 3-point lines with `stroke-linecap="round"`
   - Round / sparkle eyes → `<circle>` or `<ellipse>` filled with `currentColor`, small white `<circle>` highlights on top
   - Shocked O mouth → `<ellipse>` filled with `currentColor`
   - X-X eyes → two crossed `<line>` elements per eye, stroked in `currentColor`
   - Zigzag / squiggle mouth → polyline `<path>` with `stroke-linejoin="round"`

   **Do NOT use self-intersecting paths with `fillRule="evenodd"` for eyes.** They render inconsistently across SVG viewers (one eye can disappear, especially the second cutout in a multi-subpath `<path>`).

3. **Legs and arms follow the same pattern** — white fill, `currentColor` stroke — so the whole mascot is a cohesive outline drawing.

4. **Theme-fixed accents are hardcoded hex, not CSS vars.** A pink skull on a Kuromi theme should be `fill="#FF4FB8"`, not `var(--accent)` — SVG doesn't re-evaluate CSS variables against the app's theme tokens when rendered via `<img>` / `background-image`. If you want a color that recolors with the theme, use `currentColor`; otherwise hardcode.

5. **Verify at 24 px.** Mascots most commonly render small. Stage all 4 in a browser preview page at 24 / 48 / 80 / 120 px against canvas / panel / inset backgrounds, and confirm the expressions are distinguishable at 24 px. If any detail disappears, simplify it.

6. **Keep feature positions consistent across variants.** Eyes roughly at `y ≈ 10`, mouth near `y ≈ 13`, hat accessories at `y ≈ 2–4`. Variance between variants should come from shape, not re-positioning.

## Output paths

- Phase 1.5 (baseline): `_preview/assets/mascot-{idle,welcome,shocked,dizzy}.svg` + mirror into `screen_dir`
- Phase 2 (finalize): `<slug>/assets/mascot-{idle,welcome,shocked,dizzy}.svg`

## Mascot rig (the preferred format — ship it alongside the flat variants)

The app is moving mascots to **rigs**: a single SVG whose named groups it animates (poses,
limb-trailing drag physics, blinking, edge-peek grip hands, spring-following scene
companions). Flat variants stay REQUIRED for now — the rig renderer ships in an upcoming
release, and until then the flat art is what users see. Ship both: the four flat SVGs above
plus `assets/mascot-rig.svg`, referenced from the manifest as `"mascot": { ..., "rig":
"assets/mascot-rig.svg" }`.

**The authoring contract lives in the wecoded-themes repo — fetch and follow it:**

```
https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/mascots/README.md
```

Three ways to build the rig, in ascending effort (all detailed in that README):

1. **Mix and match** — fetch one of the six approved skins from
   `https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/mascots/skins/`
   (`2-5d-soft` · `clay` · `comic-pop` · `comic-burst` · `newsprint` · `sticker`), recolor it
   per the substitution table in its header comment, and drop components (hats / eyewear /
   held items) from `mascots/components/` into the slots.
2. **Adapt an example** — `mascots/examples/golden-sunbreak.rig.svg` /
   `halftone-dimension.rig.svg` (solid bodies), `kuromi-dreamer.rig.svg` /
   `strawberry-kitty.rig.svg` (outline/white bodies).
3. **Generate from scratch** under the README's constraints (non-negotiable: the body
   capsule path, canonical limb positions + pivots, all six face groups painted on a solid
   body — never cutouts — slots present, limbs drawn hanging down).

Rig-specific rules that DIFFER from the flat-variant rules above:

- Rigs are **inlined** into the app after sanitizing, so CSS variables DO resolve — tint
  with `var(--rig-accent, <fallback>)` / `var(--rig-on-accent, <fallback>)` /
  `var(--rig-line, <fallback>)`, or hardcode identity colors. Never `currentColor` (that is
  the flat-`<img>`-path rule; in rigs it still resolves to black in previews).
- Six faces, not four: `idle · welcome · curious · shocked · dizzy · blink` — all but idle
  `style="display:none"`.
- No baked scenery (suns, sparkle fields) and no `<animate>`/SMIL — flourishes ship as scene
  companions, and ALL animation is app-side. The sanitizer strips `<script>`, `<style>`,
  `<foreignObject>`, SMIL tags, `on*` attributes, and external URLs.
- Same 24 px quality bar as the flat variants: preview every face group at 24 / 48 / 80 px.

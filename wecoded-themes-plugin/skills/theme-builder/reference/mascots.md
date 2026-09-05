# Mascot Rendering Rules

Read this before generating any mascot. **Do not hand-draw the faces** — run the generator,
then decorate. Everything below is either a rule the app enforces or a mistake that has
already shipped.

## Generate, don't draw

```bash
node ${SKILL}/scripts/build-mascot.mjs --out <theme>/assets --config <palette.json>
node ${SKILL}/scripts/build-mascot.mjs --print-config      # every field with its default
```

One command writes all five files the theme needs:

| File | What it is |
|---|---|
| `mascot-rig.svg` | The rig — eight faces, limb pivots, slots, both grip mittens. What desktop renders. |
| `mascot-idle.svg` · `mascot-welcome.svg` · `mascot-inquisitive.svg` · `mascot-shocked.svg` | The flat variants. What Android and remote browsers render. |

The config is a palette, not artwork:

```json
{
  "skin": "solid",                                    // or "outline" for a light body + line
  "body": "#f0a828", "highlight": "#ffd268", "shade": "#b8760f",
  "face": { "ink": "#2a1004" },                       // + "fill"/"rim" for dark bodies, see below
  "catchlight": "cluster",                            // or "pair"
  "spark": ["#ffc030", "#ffe090", "#ffd060"],
  "accent": "#ffc030",
  "tail": false
}
```

**Why a generator instead of starter drawings.** Four hand-drawn starter SVGs used to live in
`scripts/`. They were copied out of React JSX and kept its attribute spelling (`fillRule`,
`stopColor`), which is not valid SVG — so the eye cutouts never cut, the gradients never
painted, and the whole body fell back to `currentColor`. Rendered the way the app renders
them, all four were black silhouettes; `idle` had one eye and `welcome` had none. Nothing
caught it because nothing ever renders a starter template. Generating from the same source
as the shipped characters is the only arrangement that stays in step.

## Then decorate

**Can:** drop a hat into `#slot-hat`, eyewear into `#slot-eyewear`, a held item into
`#slot-item`; add `#rig-tail` (`"tail": true`); add surface pattern, whiskers, a nose, or
brand face details via the config's `extra` hook; add scene companions.

**Must not:** reshape the body capsule, move or resize the limbs, move the eyes, remove the
grip mittens, or bake in scenery or `<animate>` (all animation is app-side).

**After you decorate, re-derive the flat art.** The flat variants generated from the palette
know nothing about what you later dropped into a slot, so a rig with a hat plus palette-only
flat art means desktop shows the hat and Android does not:

```bash
node ${SKILL}/scripts/build-mascot.mjs --out <theme>/assets --from-rig <theme>/assets/mascot-rig.svg
```

**An accessory must not cover the face.** Halftone Dimension pre-filled a visor across the
eyes and no expression on that character was readable for months. If a signature component
sits over the eyes, ship it as an opt-in component instead of pre-filling the slot.

## Colour rules (each of these has already gone wrong)

1. **Flat variants are hardcoded hex. Never `currentColor`, never CSS variables.** The app
   loads them through `<img>`, where `currentColor` resolves to **black** and CSS variables
   never resolve at all — measured 2026-09-05 by rendering a template on a page with
   `color: #ff0000` and getting pure `#000000`. Rigs are different: they are inlined after
   sanitizing, so `var(--rig-accent, …)` / `var(--rig-on-accent, …)` / `var(--rig-line, …)`
   do work there. The generator hardcodes both, which is always safe.
2. **The face must contrast with the BODY, and nothing checks it for you.** Halftone shipped
   `#1e2636` on `#191327`. At 80 px a near-black face on a near-black body is not subtle,
   it is absent.
3. **On a dark body, do not simply flip the face to white.** A large light shape on a dark
   body reads as a glowing hole. Keep the eye dark and give it a light outline
   (`"face": { "ink": "#dfe8f5", "fill": "#0d1120", "rim": "#dfe8f5" }`), or fill it with a
   mid-tone clearly lighter than the body.
4. **Theme-fixed accents are hardcoded hex** — a pink skull on a Kuromi-style theme is
   `fill="#FF4FB8"`, not a variable.

## Face rules

The generator applies all of these; they are here so you can tell when something is wrong.

| face | eyes | brows | mouth |
|---|---|---|---|
| `welcome` | tall rounded ellipses + catchlight | — | soft filled smile |
| `curious` | same | one flat, one arched | small "o" |
| `shocked` | same, ~12% larger | both arched high | open oval |
| `dizzy` | spirals | — | zigzag; nothing floats beside the head |
| `idle` | closed, curving **up** | — | small dot |
| `blink` | closed, curving **down** | — | soft smile |
| `happy` | closed, curving up hard | — | wide grin |
| `shutdown` | flat lines | — | short flat line |

- **`rig-face-idle` is NOT the face shown at rest.** The resting pose asks for `welcome`.
  `idle` is the pressed/held face and the still frame a reduced-effects user sees. Do not
  put your best work there expecting it to be the default expression.
- **Eyes are ellipses with a catchlight, never a solid disc.** Big black discs were tried
  and rejected as creepy, twice. `"catchlight": "cluster"` is three sparkle dots;
  `"pair"` is one large shine high on the inner edge plus a small one low and outside. The
  pair reads rounder and cuter, the cluster busier and more printed. Per-character choice.
- **Cursor tracking needs `<g class="pupil">` on both eyes of `welcome`, `curious` and
  `shocked`.** It was once documented as a `curious` convention, so every shipped rig
  tracked on exactly one face and stared straight ahead on the rest.
- **`dizzy` is spirals, and nothing floats beside the head.** The loops that used to sit
  either side of the head are gone — debris, and they collide with hats and ears.

## Manifest

```json
"mascot": {
  "rig": "assets/mascot-rig.svg",
  "idle": "assets/mascot-idle.svg",
  "welcome": "assets/mascot-welcome.svg",
  "inquisitive": "assets/mascot-inquisitive.svg",
  "shocked": "assets/mascot-shocked.svg"
}
```

**The flat variants are exactly those four.** `dizzy` is NOT one of them — the app's
`MascotVariant` type is `idle | welcome | inquisitive | shocked`, so a `dizzy` entry is dead
weight the app resolves and never displays. Two shipped themes carry one because an older
version of this file said to. (`dizzy` is a rig FACE — it just has no flat counterpart.)

## Verify before shipping

1. **Run the registry's auditor** — it is the same one that gates PRs to `wecoded-themes`:
   `node scripts/audit-rigs.mjs` from a `wecoded-themes` checkout. It checks the viewBox,
   every group id, the pivots, all eight faces, the pupil groups, the mittens and the slots.
   A generated rig passes it with zero warnings; if yours doesn't, you changed something you
   shouldn't have.
2. **Preview every face at 24 / 48 / 80 px** on canvas, panel and inset backgrounds. At 24 px
   the character must read; at 48 px the expressions must be tellable apart.
3. Confirm the flat variants render on a page whose text colour is something loud like red —
   if any part of the mascot comes out red or black, a `currentColor` slipped in.

## Output paths

- Phase 1.5 (baseline): `_preview/assets/` + mirror into `screen_dir`
- Phase 2 (finalize): `<slug>/assets/`

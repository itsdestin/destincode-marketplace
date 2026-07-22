# Token & Palette Reference

Read this before designing a palette from scratch or writing a palette override.
Skip it if you're applying a Kit preset unmodified — those are pre-validated.

> This file is referenced from three places in `SKILL.md` but did not exist until
> 2026-07-19, so every session that followed those pointers hit a dead end.

## The 15 required tokens

Every theme manifest must define all fifteen. The app derives more at runtime
(`--scrim`, `--shadow-strength`, `--code`, `--link`, `--destructive`) — do NOT
put those in a manifest; `theme-engine.ts` computes them per-theme and a
hardcoded value would silently diverge.

| Token | Drives | Notes |
|---|---|---|
| `canvas` | app background, chat area | the deepest surface on dark themes |
| `panel` | header, status bar, the frame | must stay ≥1.07:1 from `canvas` or the frame vanishes |
| `inset` | assistant bubbles, session pills, control containers | must read as distinct from `panel` |
| `well` | search fields, input wells | deepest recess |
| `accent` | user bubble, active toggle, primary button | |
| `on-accent` | text on `accent` | `#FFFFFF` if accent luminance < 0.179, else `#000000` |
| `fg` | primary text | needs 4.5:1 on canvas, inset AND panel |
| `fg-2` | secondary text | |
| `fg-dim` | tool-card labels, inactive toggles | |
| `fg-muted` | timestamps | rendered at 60% opacity in bubbles |
| `fg-faint` | decorative only | low contrast is fine here |
| `edge` | borders | must be visible on `panel` |
| `edge-dim` | chip/code-block borders | `edge` + `80` alpha suffix |
| `scrollbar-thumb` / `scrollbar-hover` | scrollbar | |

## Validate before you write HTML or a manifest

```bash
# flat token map or a full manifest, file or stdin
node ${SKILL}/scripts/check-contrast.cjs --tokens-json - <<< "$TOKENS_JSON"
node ${SKILL}/scripts/check-contrast.cjs path/to/manifest.json
```

Exit 0 = all HARD and SURFACE rules pass. Exit 1 = at least one failed.

Three tiers, and only the first two block:

- **HARD** — text becomes unreadable. `fg` on canvas/inset/panel ≥ 4.5,
  `on-accent` on `accent` ≥ 4.5, `fg-2` on inset ≥ 3.5, `fg-dim` on inset ≥ 2.5.
- **SURFACE** — elements lose their boundaries. `inset` vs `panel` ≥ 1.2,
  `canvas` vs `inset` ≥ 1.3, `well` vs `panel` ≥ 1.15, `edge` on panel ≥ 1.5,
  `edge-dim` on panel ≥ 1.3.
- **SOFT** — degraded but usable; warns only.

`fg-muted/60 on inset` warns on almost every palette including the shipped
presets. Don't contort a palette to satisfy it.

The exact same rules run live in the Kit editor — both import
`scripts/contrast-rules.js`, so the editor and the build gate can't disagree.

## Practical notes

**Alpha suffixes are real.** `edge-dim` is `#RRGGBB80`. The checker composites it
over the background before measuring; a hex without the suffix measures as fully
opaque and reports numbers that don't match what renders.

**Light themes are harder than dark ones.** `panel` vs `canvas` only needs
1.07:1, but landing near that on a light theme makes the frame nearly invisible.
Crème used to sit *below* it (`canvas #F0E6D6` / `panel #EBE1D1` = 1.051) and the
chrome genuinely did not separate from the content; it was raised to
`canvas #F6EEE1` (1.132) on 2026-07-22. Note which token moved: Crème's ramp is
tightly packed and `panel` is pinned between `canvas` above and `inset`/`edge`
below, so *darkening panel* clears this pair but breaks `inset vs panel` and
`edge on panel`. On a packed light ramp, lighten the canvas.

**Near-black accents break brightness-based hover.** Crème's accent is `#3D3229`;
`filter: brightness()` on it is invisible. Hover states fade the background
*toward the surface* via `color-mix` instead — see the `.btn` block in
`theme-preview.css`.

**Starter palettes** live in `scripts/palettes/*.json` (warm-cozy, neon-cyber,
dark-noir, earth-forest, midnight-space, pastel-soft). All pre-validated. Starting
from one and tweaking is faster and less likely to fail than inventing 15 hexes.

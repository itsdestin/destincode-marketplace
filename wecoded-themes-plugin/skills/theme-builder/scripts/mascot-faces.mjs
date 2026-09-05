// The eight face groups, from one parameterised template. Geometry is fixed: the app's
// poses, blink loop and cursor tracking all assume these positions, and every character
// reading as the same buddy depends on the eye shape not moving between themes.
//
// Only paint, catchlight shape and per-character furniture (whiskers, a nose) vary.
// Full contract: https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/mascots/README.md

const n = (v) => Number(v.toFixed(2));

export const FACE_NAMES = ['idle', 'welcome', 'curious', 'shocked', 'dizzy', 'blink', 'happy', 'shutdown'];

/** @param c {{ink, fill?, rim?, rimW?, spark, sparkOpacity?, catchlight?, accent, accent2?,
 *             lx?, ly?, rx?, ry?, eyeW?, eyeH?, mouthY?, browY?, sparkAt?, extra?}} */
export function faceSet(c) {
  const line = c.ink;                       // strokes: lids, brows, whiskers, dizzy crosses
  const solid = c.fill ?? c.ink;            // filled shapes: eyes, mouths
  const rim = c.rim ? ` stroke="${c.rim}" stroke-width="${c.rimW ?? 0.28}"` : '';
  const sp = c.spark;
  const spo = c.sparkOpacity ?? [1, 0.8, 0.65];
  const ex = c.extra ?? (() => '');
  const E = { lx: c.lx ?? 9.3, ly: c.ly ?? 9.55, rx: c.rx ?? 14.7, ry: c.ry ?? 9.25,
              w: c.eyeW ?? 1.6, h: c.eyeH ?? 2.2 };
  const my = c.mouthY ?? 13.3;
  const by = c.browY ?? 6.6;

  const stroke = (d, w) => `<path d="${d}" fill="none" stroke="${line}" stroke-width="${w}" stroke-linecap="round"/>`;

  // The catchlight IS the pupil — never a dark disc inside a dark eye (tried twice, rejected
  // as creepy both times). `cluster` is three sparkle dots, `pair` one big shine plus one small.
  const cluster = (cx, cy, s) => {
    const dots = c.catchlight === 'pair'
      ? [[cx + 0.38 * s, cy - 0.72 * s, 0.52 * s, sp[0], spo[0]],
         [cx - 0.48 * s, cy + 0.5 * s, 0.21 * s, sp[1], spo[1]]]
      : [[cx + 0.7 * s, cy + 0.7 * s, 0.3 * s, sp[0], spo[0]],
         [cx + 0.05 * s, cy + 1.3 * s, 0.2 * s, sp[1], spo[1]],
         [cx + 1.0 * s, cy + 1.3 * s, 0.14 * s, sp[2] ?? sp[1], spo[2]]];
    return `<g class="pupil">${dots.map(([x, y, r, f, o]) =>
      `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" fill="${f}"${o < 1 ? ` fill-opacity="${o}"` : ''}/>`).join('')}</g>`;
  };

  const ghosts = (cx, cy, s) => (c.ghostRim ?? []).map(([col, dx, dy]) =>
    `<ellipse cx="${n(cx + dx)}" cy="${n(cy + dy)}" rx="${n(E.w * s)}" ry="${n(E.h * s)}" fill="none" stroke="${col}" stroke-width="${c.rimW ?? 0.28}" stroke-opacity="0.85"/>`).join('');

  const eye = (cx, cy, s = 1) =>
    ghosts(cx, cy, s) + `<ellipse cx="${cx}" cy="${cy}" rx="${n(E.w * s)}" ry="${n(E.h * s)}" fill="${solid}"${rim}/>` + cluster(cx, cy, s);
  const eyesOpen = (s = 1) =>
    eye(E.lx, s === 1 ? E.ly : n(E.ly + 0.15), s) + eye(E.rx, s === 1 ? E.ry : n(E.ry + 0.15), s);

  // Closed eyes are strokes, and the curve direction carries the whole mood.
  const lids = (a, b, w) => stroke(`M8 ${n(E.ly + a)} Q9.3 ${n(E.ly + b)} 10.6 ${n(E.ly + a)}`, w)
                          + stroke(`M13.4 ${n(E.ry + a)} Q14.7 ${n(E.ry + b)} 16 ${n(E.ry + a)}`, w);
  const flatLids = (w) => stroke(`M8 ${n(E.ly + 0.45)} L10.6 ${n(E.ly + 0.45)}`, w)
                        + stroke(`M13.4 ${n(E.ry + 0.55)} L16 ${n(E.ry + 0.55)}`, w);

  const filled = (d) => `<path d="${d}" fill="${solid}"${rim}/>`;
  const smile = `<g transform="rotate(-2 12 ${my})">${filled(`M10.8 ${my} Q10.8 ${n(my - 0.3)} 12 ${n(my - 0.3)} Q13.2 ${n(my - 0.3)} 13.2 ${my} A1.1 1 0 0 1 10.8 ${my} Z`)}</g>`;
  const grin = filled(`M10.3 ${n(my - 0.3)} Q10.3 ${n(my - 0.6)} 12 ${n(my - 0.6)} Q13.7 ${n(my - 0.6)} 13.7 ${n(my - 0.3)} A1.7 1.5 0 0 1 10.3 ${n(my - 0.3)} Z`);
  const oSmall = `<ellipse cx="12.05" cy="${n(my + 0.05)}" rx="0.45" ry="0.5" fill="${solid}"${rim}/>`;
  const oBig = `<ellipse cx="12" cy="${n(my + 0.3)}" rx="0.7" ry="0.85" fill="${solid}"${rim}/>`;
  const dot = `<ellipse cx="12" cy="${n(my + 0.05)}" rx="0.5" ry="0.42" fill="${solid}"${rim}/>`;

  // Knocked-out eyes are crossed lines. Spirals were tried and dropped — they turn to mush
  // at 24 px and read as a different character.
  const crosses = `<g stroke="${line}" stroke-width="1" stroke-linecap="round">`
    + `<line x1="8" y1="${n(E.ly - 0.95)}" x2="10.6" y2="${n(E.ly + 1.85)}"/><line x1="10.6" y1="${n(E.ly - 0.95)}" x2="8" y2="${n(E.ly + 1.85)}"/>`
    + `<line x1="13.4" y1="${n(E.ry - 0.95)}" x2="16" y2="${n(E.ry + 1.85)}"/><line x1="16" y1="${n(E.ry - 0.95)}" x2="13.4" y2="${n(E.ry + 1.85)}"/></g>`;
  const spark = (x, y, col) => `<path d="M${x} ${y} Q${x + 1} ${y - 1} ${x + 2} ${y} Q${x + 1} ${y + 1} ${x} ${y} Z" fill="none" stroke="${col}" stroke-width="0.5" stroke-linecap="round"/>`;

  return {
    // The HELD face — NOT what you see at rest. The resting pose asks for `welcome`.
    idle: lids(0.65, -0.45, 0.85) + dot,
    welcome: eyesOpen() + smile,
    curious: eyesOpen()
      + stroke(`M8 ${n(by + 0.5)} L10.6 ${n(by + 0.3)}`, 0.5)
      + stroke(`M13.35 ${by} Q14.7 ${n(by - 0.9)} 16.05 ${n(by - 0.6)}`, 0.5) + oSmall,
    shocked: eyesOpen(1.12)
      + stroke(`M7.95 ${n(by - 0.1)} Q9.3 ${n(by - 0.7)} 10.65 ${n(by - 0.1)}`, 0.5)
      + stroke(`M13.35 ${n(by - 0.4)} Q14.7 ${n(by - 1)} 16.05 ${n(by - 0.4)}`, 0.5) + oBig,
    dizzy: crosses
      + `<path d="M10.4 ${n(my + 0.3)} L11.2 ${n(my - 0.3)} L12 ${n(my + 0.3)} L12.8 ${n(my - 0.3)} L13.6 ${n(my + 0.3)}" fill="none" stroke="${line}" stroke-width="0.8" stroke-linecap="round" stroke-linejoin="round"/>`
      + spark(c.sparkAt?.[0][0] ?? 5, c.sparkAt?.[0][1] ?? 3.6, c.accent)
      + spark(c.sparkAt?.[1][0] ?? 17, c.sparkAt?.[1][1] ?? 3.6, c.accent2 ?? c.accent),
    blink: lids(0.45, 0.95, 0.85) + smile,
    happy: lids(0.85, -0.95, 0.9) + grin,
    shutdown: flatLids(0.8) + stroke(`M11.3 ${my} L12.7 ${my}`, 0.5),
  };
}

/** The eight groups as rig markup: idle visible, everything else hidden. */
export function faceGroups(c) {
  const F = faceSet(c);
  const ex = c.extra ?? (() => '');
  return FACE_NAMES.map((name) =>
    `      <g id="rig-face-${name}"${name === 'idle' ? '' : ' style="display:none"'}>\n` +
    `        ${F[name]}${ex(name)}\n      </g>`).join('\n');
}

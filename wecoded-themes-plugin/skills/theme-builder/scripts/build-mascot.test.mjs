// Every assertion here is a rule that has actually been broken in a shipped mascot.
// Run: node --test build-mascot.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRig, buildFlat, DEFAULTS } from './build-mascot.mjs';

const FACES = ['idle', 'welcome', 'curious', 'shocked', 'dizzy', 'blink', 'happy', 'shutdown'];
const FLAT = ['idle', 'welcome', 'inquisitive', 'shocked'];
const OUTLINE = { skin: 'outline', body: '#FFFFFF', line: '#3A1420', shade: '#f4d4dc',
                  face: { ink: '#3A1420' }, catchlight: 'pair', spark: ['#FFFFFF', '#FFFFFF'],
                  accent: '#E14560', tail: true };
// Comments are stripped first: the generator's own comments explain WHY currentColor is
// banned, and a naive substring check trips on the explanation instead of the code.
const strip = (svg) => svg.replace(/<!--[\s\S]*?-->/g, '');
const all = () => [buildRig({}), buildRig(OUTLINE), ...FLAT.flatMap((v) => [buildFlat({}, v), buildFlat(OUTLINE, v)])].map(strip);

// SVG attribute names are hyphenated; these few are genuinely camelCase in the spec.
const CAMEL_OK = new Set(['viewBox', 'gradientUnits', 'gradientTransform', 'patternUnits',
  'stdDeviation', 'spreadMethod', 'preserveAspectRatio', 'baseFrequency', 'numOctaves']);

test('the rig names all eight faces, with only idle visible', () => {
  const svg = buildRig({});
  for (const f of FACES) {
    const tag = svg.match(new RegExp(`<g id="rig-face-${f}"[^>]*>`));
    assert.ok(tag, `missing #rig-face-${f}`);
    const hidden = /display:\s*none/.test(tag[0]);
    assert.equal(hidden, f !== 'idle', `#rig-face-${f} visibility is wrong`);
  }
});

test('both eyes track the cursor on every open-eyed face', () => {
  for (const svg of [buildRig({}), buildRig(OUTLINE)]) {
    for (const f of ['welcome', 'curious', 'shocked']) {
      const start = svg.indexOf(`<g id="rig-face-${f}"`);
      const body = svg.slice(start, svg.indexOf('\n      </g>', start));
      assert.equal((body.match(/class="pupil"/g) ?? []).length, 2,
        `#rig-face-${f} needs one <g class="pupil"> per eye`);
    }
  }
});

test('the rig carries the parts the app animates, at the geometry it expects', () => {
  const svg = buildRig({ tail: true });
  assert.match(svg, /viewBox="-3 -5 30 30"/);
  for (const [id, pivot] of [['rig-arm-left', '2.5 9'], ['rig-arm-right', '21.5 9'],
                             ['rig-leg-left', '8.95 17'], ['rig-leg-right', '15.05 17'],
                             ['rig-tail', '19 14']]) {
    assert.match(svg, new RegExp(`id="${id}" data-pivot="${pivot}"`), `${id} pivot`);
  }
  for (const id of ['rig-root', 'rig-body', 'slot-hat', 'slot-eyewear', 'slot-item']) {
    assert.ok(svg.includes(`id="${id}"`), `missing #${id}`);
  }
  // Fixed by the app's edge-peek overlay: recolour only. Two shipped themes omitted these
  // and peeked bare-armed for a day before anyone dragged a buddy to a side edge.
  for (const x of ['0.7', '20.7']) {
    assert.match(svg, new RegExp(`<rect x="${x}" y="8.3" width="2.6" height="3.4" rx="1.17"`));
  }
});

test('nothing uses currentColor — it renders black through the app\'s <img> path', () => {
  for (const svg of all()) assert.ok(!svg.includes('currentColor'), 'currentColor found');
});

test('no React attribute spelling — it is invalid SVG and silently does nothing', () => {
  for (const svg of all()) {
    for (const m of svg.matchAll(/\s([a-z]+[A-Z][A-Za-z]*)=/g)) {
      assert.ok(CAMEL_OK.has(m[1]), `camelCase attribute "${m[1]}" is not valid SVG`);
    }
  }
});

test('nothing the app sanitiser strips is present', () => {
  for (const svg of all()) {
    assert.ok(!/<script|<style|<foreignObject|<animate|\son[a-z]+=/.test(svg), 'stripped construct');
  }
});

test('the flat set is the four variants the app can display, and dizzy is not one', () => {
  for (const v of FLAT) assert.ok(buildFlat({}, v).includes('<svg'), v);
  assert.throws(() => buildFlat({}, 'dizzy'), /.*/, 'dizzy is a rig face with no flat counterpart');
});

test('dizzy is crossed lines, never spirals', () => {
  const svg = buildRig({});
  const start = svg.indexOf('<g id="rig-face-dizzy"');
  const body = svg.slice(start, svg.indexOf('\n      </g>', start));
  assert.equal((body.match(/<line /g) ?? []).length, 4, 'two crosses, four lines');
  assert.ok(!/a0\.3 0\.3 0 0 1/.test(body), 'spiral path found');
});

test('a light body drops the highlight, which would be invisible on it', () => {
  assert.ok(!buildRig(OUTLINE).includes('-hi'), 'outline skin should not emit a highlight gradient');
  assert.ok(buildRig({}).includes('-hi'), 'solid skin should emit one');
});

test('the printed defaults are a usable config', () => {
  assert.doesNotThrow(() => buildRig(JSON.parse(JSON.stringify(DEFAULTS))));
});

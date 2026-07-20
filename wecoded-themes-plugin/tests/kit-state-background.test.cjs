/**
 * Pins the ONE property of toMockup()'s background object that is invisible in
 * review: its KEY ORDER.
 *
 * The Kit applies this object with Object.assign onto element.style, so keys
 * land in insertion order. `background` is a shorthand that includes
 * background-image, so:
 *
 *   { backgroundImage: 'url(…)', background: '' }   → image wiped
 *   { background: 'linear-gradient(…)', backgroundImage: '' } → gradient wiped
 *
 * Both shipped in the Kit and blanked every wallpaper and gradient background
 * while looking completely correct in the source. A comment alone would not
 * survive the next refactor that "tidies" the object literal, so these assert
 * against a real CSSOM rather than against the key order itself — the order is
 * the mechanism, the rendered background-image is the thing that matters.
 *
 * Run: node --test wecoded-themes-plugin/tests/
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const KS = require(path.join(__dirname, '..', 'skills', 'theme-builder', 'scripts', 'kit-state.js'));

/** Minimal CSSOM stand-in: models the one behaviour under test — assigning the
 *  `background` shorthand resets background-image, and vice versa. Verified
 *  against jsdom, which agrees with both cases. */
function makeStyle() {
  const s = { _img: '', _color: '' };
  return {
    set background(v) { s._color = v; s._img = ''; },          // shorthand resets longhands
    get background() { return s._color; },
    set backgroundImage(v) { s._img = v; },
    get backgroundImage() { return s._img; },
    set backgroundSize(v) {}, set backgroundPosition(v) {}, set opacity(v) {},
  };
}

function applied(state) {
  const { background } = KS.toMockup(state);
  const style = makeStyle();
  if (background) Object.assign(style, background);
  return style;
}

const TOKENS = { canvas: '#fff', panel: '#eee', accent: '#333', fg: '#111' };

test('an image background survives Object.assign', () => {
  const style = applied({
    tokens: TOKENS,
    background: { type: 'image', value: 'wallpaper.jpeg', opacity: 1 },
  });
  assert.equal(style.backgroundImage, 'url("/files/wallpaper.jpeg")',
    'background shorthand cleared the wallpaper — check key order in toMockup');
});

test('a gradient background survives Object.assign', () => {
  const grad = 'linear-gradient(160deg, #2E241A 0%, #0D0A07 100%)';
  const style = applied({
    tokens: TOKENS,
    background: { type: 'gradient', value: grad },
  });
  assert.equal(style.background, grad,
    'backgroundImage clear wiped the gradient — a gradient IS a background-image');
});

test('a solid background survives Object.assign', () => {
  const style = applied({ tokens: TOKENS, background: { type: 'solid', value: '#101010' } });
  assert.equal(style.background, '#101010');
});

test('switching image → gradient leaves no stale image behind', () => {
  const style = makeStyle();
  Object.assign(style, KS.toMockup({
    tokens: TOKENS, background: { type: 'image', value: 'old.jpeg' },
  }).background);
  Object.assign(style, KS.toMockup({
    tokens: TOKENS, background: { type: 'gradient', value: 'linear-gradient(red, blue)' },
  }).background);
  assert.equal(style.backgroundImage, '', 'previous wallpaper still set after switching to a gradient');
});

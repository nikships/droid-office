import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DIAL_VIEWBOX, EFFORT_COLOR, dialGeometry, effortFraction } from '../src/shared/effort-dial.js';
import { AGENT_EFFORTS } from '../src/shared/protocol.js';
import { EFFORT_LABEL } from '../src/client/ui/effort-label.js';

const lin = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gam = (c: number) => Math.round(255 * Math.min(1, Math.max(0, c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)));
function toOklab(hex: string): number[] {
  const [r, g, b] = [1, 3, 5].map((i) => lin(Number.parseInt(hex.slice(i, i + 2), 16)));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function fromOklab([L, a, b]: number[]): string {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  return `#${rgb.map((c) => gam(c).toString(16).padStart(2, '0')).join('')}`;
}

test('effort colours step evenly in OKLab from white at Low to Factory orange at Max', () => {
  assert.deepEqual(Object.keys(EFFORT_COLOR), [...AGENT_EFFORTS]);
  const white = toOklab('#ffffff');
  const orange = toOklab('#ee6018');
  AGENT_EFFORTS.forEach((e, i) => {
    const t = i / (AGENT_EFFORTS.length - 1);
    assert.equal(EFFORT_COLOR[e], fromOklab(white.map((v, k) => v + (orange[k] - v) * t)), e);
  });
  assert.equal(new Set(Object.values(EFFORT_COLOR)).size, AGENT_EFFORTS.length);
});

test('the dial sweeps a fifth per step and its needle ends inside the arc', () => {
  assert.deepEqual(AGENT_EFFORTS.map(effortFraction), [0.2, 0.4, 0.6, 0.8, 1]);
  const low = dialGeometry('low');
  const max = dialGeometry('max');
  assert.equal(low.color, '#ffffff');
  assert.equal(max.color, '#ee6018');
  assert.equal(low.track, max.track);
  assert.equal(max.arc, max.track, 'Max fills the whole half circle');
  assert.equal(low.ticks.length, 6);
  // Low points up-left, Max points right along the base line; every needle stays in the viewBox.
  assert.ok(low.needle.x2 < low.needle.x1 && low.needle.y2 < low.needle.y1);
  assert.equal(max.needle.y2, max.needle.y1);
  assert.ok(max.needle.x2 > max.needle.x1);
  const [x0, y0, w, h] = DIAL_VIEWBOX;
  for (const e of AGENT_EFFORTS) {
    const { needle, ticks } = dialGeometry(e);
    for (const p of [needle, ...ticks]) {
      for (const x of [p.x1, p.x2]) assert.ok(x >= x0 && x <= x0 + w, `${e} x ${x}`);
      for (const y of [p.y1, p.y2]) assert.ok(y >= y0 && y <= y0 + h, `${e} y ${y}`);
    }
  }
});

test('Android draws the same colours and says the same words', () => {
  const kotlin = readFileSync(new URL('../android/app/src/main/java/ai/factory/droidoffice/core/EffortDial.kt', import.meta.url), 'utf8');
  const enumOf = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max' } as const;
  for (const e of AGENT_EFFORTS) {
    const color = new RegExp(`Effort\\.${enumOf[e]} to 0xFF([0-9A-F]{6})\\b`).exec(kotlin)?.[1];
    assert.equal(`#${color?.toLowerCase()}`, EFFORT_COLOR[e], e);
    assert.match(kotlin, new RegExp(`Effort\\.${enumOf[e]} to "${EFFORT_LABEL[e]}"`), e);
  }
  const ui = readFileSync(new URL('../android/app/src/main/java/ai/factory/droidoffice/ui/components/EffortDial.kt', import.meta.url), 'utf8');
  assert.match(ui, /12\.5f/, 'the Android dial keeps the web viewBox height');
  assert.match(ui, /22f \/ 12\.5f/, 'and its aspect');
  for (const file of ['home/HomeScreen.kt', 'worker/WorkerScreen.kt']) {
    const screen = readFileSync(new URL(`../android/app/src/main/java/ai/factory/droidoffice/ui/${file}`, import.meta.url), 'utf8');
    assert.match(screen, /EffortDialMark\(/, file);
    assert.doesNotMatch(screen, /\.label\.lowercase\(\)|add\(it\.label\)/, `${file} no longer writes the effort as text`);
  }
});

test('model badges name the effort in words for screen readers and tooltips', async () => {
  const { modelBadge, modelBadgeLabel } = await import('../src/client/ui/models.js');
  assert.equal(modelBadgeLabel('custom:droidproxy:opus-5-5', 'xhigh'), 'DroidProxy: Opus 5.5 · Extra high effort');
  assert.equal(modelBadgeLabel('claude-sonnet-5-5', undefined), 'Sonnet 5.5');
  assert.equal(modelBadgeLabel(undefined, 'low'), 'Low effort');
  assert.equal(modelBadgeLabel(undefined, undefined), undefined);
  assert.equal(modelBadge('custom:droidproxy:opus-5-5', 'high'), 'DroidProxy: Opus 5.5 · High', 'canvas labels keep the short text');
});

test('web surfaces draw the badge node rather than effort text', () => {
  for (const file of ['dashboard-roster.ts', 'dashboard-pane.ts']) {
    const src = readFileSync(new URL(`../src/client/${file}`, import.meta.url), 'utf8');
    assert.match(src, /modelBadgeNode\(/, file);
    assert.doesNotMatch(src, /\bmodelBadge\(/, `${file} uses modelBadgeLabel for words`);
  }
});

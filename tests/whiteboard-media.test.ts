// A video on a Whiteboard card plays the way it does in a tab: a click on the picture plays and
// pauses it, and its controls' full-screen button works. Run for real, in a host page on the office's
// own origin that frames the card with the window's own attributes (CARD_FRAME), against the
// office's card route. Without full screen in the frame's allow list, Chromium ignores a click on the
// picture and greys out the full-screen button, which is what this guards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from 'playwright-core';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/server/config.js';
import { startServer } from '../src/server/server.js';
import { CARD_FRAME } from '../src/shared/whiteboard-bridge.js';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';
import type { ServerMsg } from '../src/shared/protocol.js';

const real = browserStatus();
const skip = real.installed ? false : `Chromium isn't downloaded in ${real.path}; run "node bin/droid-office.js browser install" to run this test`;

async function waitFor<T>(read: () => T | undefined | false, what: string, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = read();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await delay(25);
  }
}

/** A second and a half of VP8 recorded in the browser itself: every Chromium build plays it, with or without H.264. A string, so tsx's helpers stay out of the page. */
const RECORD_CLIP = `(async function () {
  var canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 180;
  var g = canvas.getContext('2d');
  var rec = new MediaRecorder(canvas.captureStream(30), { mimeType: 'video/webm;codecs=vp8' });
  var parts = [];
  rec.ondataavailable = function (e) { parts.push(e.data); };
  var done = new Promise(function (r) { rec.onstop = r; });
  rec.start();
  var t0 = performance.now();
  await new Promise(function (r) {
    (function draw() {
      var t = performance.now() - t0;
      g.fillStyle = 'hsl(' + ((t / 5) % 360) + ' 80% 50%)';
      g.fillRect(0, 0, 320, 180);
      if (t < 1500) requestAnimationFrame(draw);
      else r();
    })();
  });
  rec.stop();
  await done;
  var bytes = new Uint8Array(await new Blob(parts, { type: 'video/webm' }).arrayBuffer());
  var s = '';
  for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
})()`;

async function recordClip(page: Page): Promise<Buffer> {
  return Buffer.from((await page.evaluate(RECORD_CLIP)) as string, 'base64');
}
const CARD = `<!doctype html><html><body style="margin:0">
<video id="v" controls playsinline preload="auto" style="display:block;width:800px;height:450px;background:#000"><source src="clip.webm" type="video/webm"></video>
</body></html>`;

function host(cap: string, allow: string): string {
  const attrs = Object.entries({ ...CARD_FRAME, allow })
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ');
  return `<!doctype html><html><body style="margin:0"><iframe ${attrs} style="width:1000px;height:600px;border:0" src="/whiteboard/c/${cap}/#wb=${'n'.repeat(24)}"></iframe></body></html>`;
}

test("a card's video plays from a click on it, and its full-screen control works", { skip, timeout: 90_000 }, async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'droid-office-wb-media-'));
  const project = path.join(root, 'project');
  const home = path.join(root, 'home');
  for (const d of [project, home]) mkdirSync(d, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const cfg = loadConfig([project, '--home', home, '--weather', 'clear', '--host', '127.0.0.1']);
  cfg.port = 0;
  cfg.renders = false;
  const office = await startServer(cfg);
  t.after(async () => {
    const closed = once(office.server, 'close');
    office.shutdown();
    await closed;
    await closeBrowser();
  });
  const base = `http://127.0.0.1:${(office.server.address() as AddressInfo).port}`;

  const browser = await launchBrowser();
  const context = await newIsolatedContext(browser, { viewport: { width: 1100, height: 700 } });
  t.after(() => context.close().catch(() => {}));
  const scratch = await context.newPage();
  await scratch.goto(`${base}/whiteboard/c/none/`);
  const clip = await recordClip(scratch);
  await scratch.close();
  assert.ok(clip.length > 1000, `the recorded clip is ${clip.length} bytes`);

  const msgs: ServerMsg[] = [];
  const ws = new WebSocket(`${base.replace('http:', 'ws:')}/ws?name=Owner`, { headers: { origin: base } });
  t.after(() => ws.terminate());
  ws.on('message', (raw) => msgs.push(JSON.parse(String(raw))));
  const welcome = await waitFor(() => msgs.find((m) => m.t === 'welcome') as Extract<ServerMsg, { t: 'welcome' }> | undefined, 'welcome');
  const floor = welcome.floor!;
  const snap = await waitFor(() => msgs.find((m) => m.t === 'whiteboard' && m.update.kind === 'snapshot') as Extract<ServerMsg, { t: 'whiteboard' }> | undefined, 'the snapshot');
  const epoch = snap.update.kind === 'snapshot' ? snap.update.epoch : '';
  const upload = async (body: string | Buffer, mime: string) =>
    (await (await fetch(`${base}/api/whiteboard/blob?floor=${floor}&mime=${encodeURIComponent(mime)}`, { method: 'POST', headers: { origin: base }, body })).json()) as { hash: string };
  const files = { 'index.html': await upload(CARD, 'text/html; charset=utf-8'), 'clip.webm': await upload(clip, 'video/webm') };
  ws.send(JSON.stringify({ t: 'whiteboard.apply', floor, envelope: { epoch, seq: 1, ops: [{ op: 'card.create', card: 'clip', kind: 'html', title: 'Clip', content: { entry: 'index.html', files } }] } }));
  const patch = await waitFor(() => msgs.find((m) => m.t === 'whiteboard' && m.update.kind === 'patch' && m.caps?.clip) as Extract<ServerMsg, { t: 'whiteboard' }> | undefined, 'the card');
  const cap = patch.caps!.clip;

  /** Opens the card framed with `allow`, clicks the middle of its video, and says what the video did. */
  const clickVideo = async (allow: string) => {
    const page = await context.newPage();
    try {
      await page.route(`${base}/__host`, (route) => route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: host(cap, allow) }));
      await page.goto(`${base}/__host`);
      const frame = await waitFor(() => page.frames().find((f) => f.url().includes('/whiteboard/c/')), 'the card frame');
      await frame.waitForFunction("document.getElementById('v').readyState >= 2", undefined, { timeout: 15_000 });
      const box = (await frame.locator('#v').boundingBox())!;
      // The middle of the picture, clear of the control bar along its bottom edge.
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 3);
      await delay(600);
      return (await frame.evaluate(`(function () {
        var v = document.getElementById('v');
        var policy = document.featurePolicy;
        return { playing: !v.paused, fullscreenEnabled: document.fullscreenEnabled, camera: policy && policy.allowsFeature('camera'), clipboardRead: policy && policy.allowsFeature('clipboard-read'), origin: String(self.origin) };
      })()`)) as { playing: boolean; fullscreenEnabled: boolean; camera?: boolean; clipboardRead?: boolean; origin: string };
    } finally {
      await page.close();
    }
  };

  const framed = await clickVideo(CARD_FRAME.allow);
  assert.equal(framed.origin, 'null', 'the card still runs on an opaque origin');
  assert.equal(framed.fullscreenEnabled, true, "the video's full-screen control is enabled");
  assert.equal(framed.playing, true, 'a click on the picture plays the video');
  assert.notEqual(framed.camera, true, 'the camera stays off');
  assert.notEqual(framed.clipboardRead, true, 'clipboard reads stay off');

  // The frame as it was: Chromium leaves a click on the picture alone, so the test would have caught it.
  const before = await clickVideo('clipboard-write *');
  assert.equal(before.fullscreenEnabled, false);
  assert.equal(before.playing, false);
});

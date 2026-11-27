import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { hostSnapshot } from './oracle/host-snapshot.js';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';

test('OSC 52 writes silently on a live owner mirror and never reads the clipboard', { skip: !browserStatus().installed }, async (t) => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'office-shell-features-'));
  const server = await createServer({
    root: fileURLToPath(new URL('../src/client', import.meta.url)),
    cacheDir,
    configFile: false,
    appType: 'custom',
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, hmr: false },
    optimizeDeps: { noDiscovery: true, include: ['@wterm/dom', '@wterm/ghostty'] },
  });
  t.after(async () => {
    await server.close();
    await rm(cacheDir, { recursive: true, force: true });
  });
  await server.listen();
  const addr = server.httpServer!.address();
  assert.ok(addr && typeof addr === 'object');
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await newIsolatedContext(browser);
  t.after(() => context.close());
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  page.setDefaultTimeout(4000);
  await page.route('**/fixture', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><link rel="stylesheet" href="/style.css"><div id="host" style="width:500px;height:128px"></div>' }));
  await page.addInitScript('window.__name = f => f');
  await page.goto(`http://127.0.0.1:${addr.port}/fixture`);
  await page.evaluate(async () => {
    const mod = '/term-engine/web-terminal.ts';
    const { createWebTerminal } = await import(mod);
    const w = window as any;
    const { term: a } = createWebTerminal({ scrollback: 50, fontSize: 14, macOptionIsMeta: true });
    w.term = a;
    w.sent = [];
    a.onData((s: string) => w.sent.push(s));
    await a.open(document.querySelector('#host'));
    a.resize(24, 8);
    a.focus();
  });
  const write = (s: string) => page.evaluate((s) => (window as any).term.write(s), s);
  await page.evaluate(() => {
    const w = window as any;
    w.writes = [];
    w.reads = 0;
    // Don't change the machine clipboard in CI. The core, callback, and gate are real.
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        readText() {
          w.reads++;
          throw Error('clipboard reads must never run');
        },
        async writeText(text: string) {
          w.writes.push(text);
          if (w.deny) throw Error('denied');
        },
      },
    });
  });
  const request = (value: string, selector = 'c') => write(`\x1b]52;${selector};${Buffer.from(value).toString('base64')}\x07`);
  const writes = () => page.evaluate(() => (window as any).writes);
  const exact = '\uFEFFtwo lines\nwith 🎈 and \u202e';
  await request(exact);
  assert.deepEqual(await writes(), [exact]);
  await request('', '');
  assert.deepEqual(await writes(), [exact, '']);
  await write('\x1b]52;c;Zm9v\x07\x1b]52;c;YmFy\x07');
  // A parser chunk can coalesce writes. The last requested value must win.
  assert.equal((await writes()).at(-1), 'bar');
  await request('é'.repeat(32768));
  assert.equal((await writes()).at(-1), 'é'.repeat(32768));
  const count = (await writes()).length;
  await request(`${'é'.repeat(32768)}x`);
  await request('unsupported selector', 'p');
  for (const payload of ['?', '%%%', '/w==']) await write(`\x1b]52;c;${payload}\x07`);
  assert.equal((await writes()).length, count);
  // No permission bubbles: a fresh, inactive page must check specifically
  // for a pre-existing grant to write WITHOUT user activation.
  await cdp.send('Runtime.evaluate', {
    expression: `Object.defineProperty(navigator, 'userActivation', {configurable:true,value:{isActive:false}});
    window.grant={state:'prompt'};window.queries=[];
    Object.defineProperty(navigator, 'permissions', {value:{async query(desc){window.queries.push(desc);return window.grant;}}});
    window.term.write('\\x1b]52;c;Z2F0ZWQ=\\x07');`,
    userGesture: false,
  });
  assert.equal((await writes()).length, count);
  assert.deepEqual(await page.evaluate(() => (window as any).queries), [{ name: 'clipboard-write', allowWithoutGesture: true }]);
  await page.evaluate(() => {
    (window as any).grant.state = 'granted';
  });
  await request('pre-existing grant');
  assert.equal((await writes()).at(-1), 'pre-existing grant');
  const grantedCount = (await writes()).length;
  await page.evaluate(() => {
    (window as any).deny = true;
  });
  await request('denied once');
  await page.evaluate(() => {
    (window as any).deny = false;
  });
  await page.click('#host');
  assert.equal((await writes()).length, grantedCount + 1);
  await page.evaluate(() => {
    (window as any).term.options.disableStdin = true;
  });
  await request('snapshot or read-only');
  await page.evaluate(() => {
    (window as any).term.options.disableStdin = false;
  });
  await page.evaluate(async () => {
    const mod = '/token.ts';
    (await import(mod)).setGuestAuth('fixture-guest');
  });
  await request('guest even with writable stdin');
  assert.equal((await writes()).length, grantedCount + 1);
  assert.equal(await page.evaluate(() => (window as any).reads), 0);
  assert.deepEqual(await page.evaluate(() => (window as any).sent), []);
  assert.equal(await page.getByRole('button', { name: 'Copy', exact: true }).count(), 0);
  await page.evaluate(() => {
    const a = (window as any).term,
      native = a.native;
    a.dispose();
    if (native.onClipboardWrite !== null) throw Error('leaked clipboard callback');
  });
});

test('PTY host snapshots retain screen text, never an OSC 52 write to reapply', async () => {
  const replay = await hostSnapshot('retained screen\x1b]52;c;Y29weQ==\x07');
  assert.ok(replay.includes('retained screen'));
  assert.ok(!replay.includes('52;c;') && !replay.includes('Y29weQ=='));
});

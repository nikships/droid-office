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
  await t.test('OSC 52 eligibility starts at its introducer, not its terminator', async () => {
    const results = await page.evaluate(() => {
      const w = window as any;
      const check = (replay: string, live: string) => {
        w.term.options.disableStdin = true;
        w.term.write(replay);
        w.term.options.disableStdin = false;
        w.term.write(live);
        return w.writes.splice(0) as string[];
      };
      const next = '\x1b]52;c;bGl2ZQ==\x07'; // "live"
      const checks = [];
      for (const end of ['\x07', '\x1b\\']) {
        const first = `\x1b]52;c;b2xk${end}`; // "old"
        for (let at = 0; at <= first.length; at++) {
          const prefix = first.slice(0, at);
          const suffix = first.slice(at);
          checks.push({ at, output: check(prefix, suffix), expected: at === 0 ? ['old'] : [] });
          // The next live sequence in the same transport chunk is still eligible.
          if (at) checks.push({ at, output: check(prefix, suffix + next), expected: ['live'] });
        }
      }
      return checks;
    });
    for (const { at, output, expected } of results) assert.deepEqual(output, expected, `replay split ${at}`);
  });
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
  // A fresh, inactive page still asks the browser to write; permission UI
  // and the outcome of that first request belong to the browser.
  await cdp.send('Runtime.evaluate', {
    expression: `Object.defineProperty(navigator, 'userActivation', {configurable:true,value:{isActive:false}});
    window.queries=[];
    Object.defineProperty(navigator, 'permissions', {value:{async query(desc){window.queries.push(desc);return {state:'prompt'};}}});
    window.term.write('\\x1b]52;c;Z2F0ZWQ=\\x07');`,
    userGesture: false,
  });
  assert.equal((await writes()).length, count + 1);
  assert.equal((await writes()).at(-1), 'gated');
  assert.deepEqual(await page.evaluate(() => (window as any).queries), []);
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

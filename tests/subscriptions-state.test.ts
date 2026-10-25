import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RawModels, RawStatus, RawUsage } from '../src/server/subscriptions/control.js';
import { mountSubscriptions, type Subscriptions, type SubscriptionsMsg } from '../src/server/subscriptions/index.js';
import type { Runner } from '../src/server/subscriptions/proxy-install.js';
import type { SubscriptionsState } from '../src/shared/subscriptions.js';
import { CODESIGN_DV, CONTROL_FILE, MODELS, NOW, SPCTL, TOKEN, USAGE, fakeApp, json, ok, refused, status, tempDir } from './subscriptions-fixtures.js';

const SOL = 'custom:droidproxy:gpt-6.1-sol';
const LUNA = 'custom:droidproxy:gpt-6-luna';
const ZIP = Buffer.from('DroidProxy 1.8.179');
const RELEASE = {
  tag_name: 'v1.8.179',
  assets: [
    { name: 'DroidProxy-arm64.zip', browser_download_url: 'https://github.com/nikships/droidproxy/releases/download/v1.8.179/DroidProxy-arm64.zip' },
    { name: 'DroidProxy-arm64.zip.sha256', browser_download_url: 'https://github.com/nikships/droidproxy/releases/download/v1.8.179/DroidProxy-arm64.zip.sha256' },
  ],
};

/** DroidProxy as the fakes play it. */
interface World {
  running: boolean;
  /** It has the control API (1.8.180 on); false is the owner's 1.8.177. */
  api: boolean;
  /** `open -g` makes it answer. */
  startsUp: boolean;
  /** It answers nothing in time. */
  slow: boolean;
  status: RawStatus;
  models: RawModels;
  usage: RawUsage;
  posts: [string, unknown][];
}

interface Rig {
  subs: Subscriptions;
  world: World;
  home: string;
  dirs: { system: string; user: string };
  runs: string[][];
  toasts: [string, string | undefined][];
  broadcasts: SubscriptionsState[];
  modelsChanged: number;
  clock: { now: number };
  /** The delays of the timers waiting now, from the current time. */
  pending(): number[];
  /** Moves the clock on, running each timer that comes due, and lets what they started finish. */
  advance(ms: number): Promise<void>;
  send(msg: SubscriptionsMsg): Promise<void>;
  until(pred: () => boolean, what: string): Promise<void>;
}

interface RigOptions {
  platform?: NodeJS.Platform;
  app?: string | null;
  control?: boolean;
  settings?: { id: string; displayName: string }[];
  world?: Partial<World>;
}

const settle = () => new Promise((r) => setTimeout(r, 5));

async function rig(t: { after(fn: () => void): void }, o: RigOptions = {}): Promise<Rig> {
  const home = tempDir(t, 'subscriptions');
  const dirs = { system: path.join(home, 'Applications'), user: path.join(home, 'UserApplications') };
  mkdirSync(dirs.system);
  if (o.app !== null) fakeApp(dirs.system, o.app ?? '1.8.180');
  if (o.control !== false) {
    mkdirSync(path.join(home, '.droidproxy'), { recursive: true });
    writeFileSync(path.join(home, '.droidproxy', 'control.json'), JSON.stringify(CONTROL_FILE));
  }
  if (o.settings) {
    mkdirSync(path.join(home, '.factory'));
    writeFileSync(path.join(home, '.factory', 'settings.json'), JSON.stringify({ customModels: [...o.settings, { id: 'custom:my-key', displayName: 'Mine' }] }));
  }
  const world: World = { running: true, api: true, startsUp: true, slow: false, status: status(), models: MODELS, usage: USAGE, posts: [], ...o.world };
  const runs: string[][] = [];
  const run: Runner = async (cmd, args) => {
    runs.push([cmd, ...args]);
    if (cmd === 'plutil') return ok(readFileSync(args.at(-1) as string, 'utf8'));
    if (cmd === 'open' && args[0] === '-g' && world.startsUp) world.running = true;
    if (cmd === 'ditto' && args[0] === '-x') {
      mkdirSync(args[3], { recursive: true });
      fakeApp(args[3], '1.8.179');
    } else if (cmd === 'ditto') cpSync(args[0], args[1], { recursive: true });
    if (cmd === 'codesign' && args[0] === '-dv') return ok('', CODESIGN_DV);
    if (cmd === 'spctl') return ok('', SPCTL);
    if (cmd === 'osascript') world.running = false;
    return ok();
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://api.github.com/repos/nikships/droidproxy/releases/latest') return json(RELEASE);
    if (url.endsWith('.zip.sha256')) return new Response(`${createHash('sha256').update(ZIP).digest('hex')}  DroidProxy-arm64.zip\n`);
    if (url.endsWith('.zip')) return new Response(ZIP, { headers: { 'content-length': String(ZIP.length) } });
    const u = new URL(url);
    assert.equal(u.host, '127.0.0.1:8317');
    if (world.slow) throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    if (!world.running) throw refused();
    if (u.pathname === '/droidproxy/usage') return json(world.usage);
    if (!world.api) return new Response('404 page not found', { status: 404 });
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${TOKEN}`);
    const route = u.pathname.replace('/droidproxy/control', '');
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      world.posts.push([route, body]);
      if (route === '/connect') {
        const connecting = { started_at: new Date(NOW).toISOString(), user_code: null, verification_uri: null, error: null };
        world.status = { ...world.status, providers: world.status.providers?.map((p) => (p.key === body.provider ? { ...p, connecting } : p)) };
        return json({ connecting }, 202);
      }
      if (route === '/factory-models') {
        world.status = { ...world.status, factory: { installed: 14, available: 14, stale: false } };
        return json({ installed: 14, backup: null });
      }
      return json(route === '/providers' || route === '/accounts/remove' ? world.status : {});
    }
    if (route === '/status') return json(world.status);
    if (route === '/models') return json(world.models);
    return new Response('{"error":"no such call"}', { status: 404 });
  }) as typeof fetch;

  const clock = { now: NOW };
  let seq = 0;
  const queue = new Map<number, { at: number; fn: () => void }>();
  const toasts: [string, string | undefined][] = [];
  const broadcasts: SubscriptionsState[] = [];
  const r: Rig = {
    subs: undefined as unknown as Subscriptions,
    world,
    home,
    dirs,
    runs,
    toasts,
    broadcasts,
    modelsChanged: 0,
    clock,
    pending: () => [...queue.values()].map((q) => q.at - clock.now).sort((a, b) => a - b),
    async advance(ms) {
      const end = clock.now + ms;
      for (;;) {
        await settle();
        const due = [...queue.entries()].filter(([, q]) => q.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        queue.delete(due[0]);
        clock.now = Math.max(clock.now, due[1].at);
        due[1].fn();
      }
      clock.now = end;
      await settle();
    },
    async send(msg) {
      r.subs.message('owner', msg);
      await settle();
    },
    async until(pred, what) {
      for (let i = 0; i < 400 && !pred(); i++) await settle();
      assert.ok(pred(), `timed out waiting for ${what}`);
    },
  };
  r.subs = mountSubscriptions({
    dataDir: home,
    broadcast: (s) => broadcasts.push(structuredClone(s)),
    toast: (text, level) => toasts.push([text, level]),
    modelsChanged: () => r.modelsChanged++,
    fetchImpl,
    home,
    platform: o.platform ?? 'darwin',
    arch: 'arm64',
    run,
    appDirs: dirs,
    tmp: home,
    now: () => clock.now,
    timers: {
      setTimeout: (fn, ms) => {
        const id = ++seq;
        queue.set(id, { at: clock.now + ms, fn });
        return id;
      },
      clearTimeout: (id) => queue.delete(id as number),
    },
  });
  t.after(() => r.subs.stop());
  return r;
}

const opens = (r: Rig) => r.runs.filter((c) => c[0] === 'open');

test('off a Mac with Apple silicon nothing runs and nothing is refused', async (t) => {
  const r = await rig(t, { platform: 'linux', settings: [{ id: SOL, displayName: 'DroidProxy: GPT 6.1 Sol' }] });
  await r.advance(60_000);
  assert.equal(r.subs.state().proxy.phase, 'unsupported');
  assert.deepEqual(r.pending(), []);
  assert.deepEqual(r.runs, []);
  assert.equal(r.subs.gate(SOL), undefined);
});

test("with no DroidProxy, its models in Droid's settings can't run, and it looks again every 30 s", async (t) => {
  const r = await rig(t, {
    app: null,
    settings: [
      { id: SOL, displayName: 'DroidProxy: GPT 6.1 Sol' },
      { id: LUNA, displayName: 'DroidProxy: GPT 6 Luna' },
    ],
  });
  await r.advance(0);
  const s = r.subs.state();
  assert.equal(s.proxy.phase, 'missing');
  assert.equal(s.proxy.latest, '1.8.179');
  assert.deepEqual(s.availability, { [SOL]: { state: 'proxy-down', installed: false }, [LUNA]: { state: 'proxy-down', installed: false } });
  assert.equal(r.subs.gate(SOL), "Can't hire on GPT 6.1 Sol: DroidProxy isn't installed. Pick another model.");
  assert.equal(r.subs.gate('claude-opus-5-5'), undefined);
  assert.equal(r.subs.availability('custom:my-key'), undefined);
  assert.ok(r.pending().includes(30_000));
  assert.ok(r.pending().includes(6 * 60 * 60_000), 'the newest release is read again in 6 h');
  assert.deepEqual(opens(r), []);
});

test("the owner's DroidProxy 1.8.177 has no control API: outdated, its accounts from usage, nothing refused", async (t) => {
  const r = await rig(t, { app: '1.8.177', control: false, world: { api: false }, settings: [{ id: SOL, displayName: 'DroidProxy: GPT 6.1 Sol' }] });
  await r.advance(0);
  const s = r.subs.state();
  assert.equal(s.proxy.phase, 'outdated');
  assert.equal(s.proxy.version, '1.8.177');
  assert.equal(s.proxy.path, path.join(r.dirs.system, 'DroidProxy.app'));
  assert.deepEqual(
    s.providers.map((p) => p.key),
    ['codex', 'grok', 'meta'],
  );
  assert.equal(s.providers[0].accounts[0].windows[0].usedPercent, 100);
  assert.deepEqual(s.availability, {});
  assert.equal(s.models, null);
  assert.equal(s.checkedAt, NOW);
  assert.equal(r.subs.gate(SOL), undefined);
  assert.ok(r.pending().includes(60_000));
  assert.deepEqual(opens(r), [], 'a running DroidProxy is never started again');

  await r.send({ t: 'subscriptions.provider', provider: 'grok', enabled: false });
  assert.deepEqual(r.toasts.at(-1), ["Couldn't switch Grok off: DroidProxy 1.8.177 is too old for the office to drive: update it in Subscriptions", 'warn']);
  assert.deepEqual(r.world.posts, []);
});

test('a running DroidProxy: providers with their windows, models in Droid, and which models can run', async (t) => {
  const r = await rig(t);
  await r.advance(0);
  const s = r.subs.state();
  assert.equal(s.proxy.phase, 'running');
  assert.equal(s.proxy.error, null);
  assert.deepEqual(s.models, { installed: 14, available: 14, stale: false });
  assert.deepEqual(
    s.providers.find((p) => p.key === 'codex')?.accounts[0].windows.map((w) => w.name),
    ['5-hour', 'Weekly'],
  );
  assert.equal(r.subs.availability(SOL)?.state, 'exhausted');
  assert.equal(r.subs.gate(SOL), "Can't hire on GPT 6.1 Sol: out of quota (5-hour) for another 41 min. Pick another model.");
  assert.equal(r.subs.gate('custom:droidproxy:claude-opus-5-5'), "Can't hire on Claude Opus 5.5: no Claude account is connected. Pick another model.");
  assert.equal(r.subs.gate('custom:droidproxy:grok-5'), "Can't hire on Grok 5: Grok is switched off in Subscriptions. Pick another model.");
  assert.equal(r.subs.gate(LUNA), undefined);
  assert.equal(r.subs.gate('custom:droidproxy:kimi-k3'), undefined, 'unknown is never refused');
  assert.equal(r.subs.gate(undefined), undefined);
  assert.deepEqual(r.pending()[0], 60_000);
  assert.deepEqual(r.world.posts, [], 'models in Droid that are up to date are left alone');
});

test('when DroidProxy stops answering, the last state stays, and after 5 minutes it refuses nobody', async (t) => {
  const r = await rig(t);
  await r.advance(0);
  r.world.slow = true;
  await r.advance(60_000);
  let s = r.subs.state();
  assert.equal(s.proxy.phase, 'running');
  assert.equal(s.proxy.error, "DroidProxy didn't answer in 5 s");
  assert.equal(s.checkedAt, NOW);
  assert.ok(r.subs.gate(SOL));
  await r.advance(4 * 60_000 + 1000);
  s = r.subs.state();
  assert.deepEqual(s.availability, {});
  assert.equal(r.subs.gate(SOL), undefined);
  assert.equal(s.providers.length, 4, 'what it last said about accounts stays');
  r.world.slow = false;
  await r.advance(60_000);
  assert.equal(r.subs.state().proxy.error, null);
  assert.ok(r.subs.gate(SOL));
});

test('at office start a stopped DroidProxy is started when Droid has its models, and a hire burst starts it only once', async (t) => {
  const r = await rig(t, { world: { running: false, startsUp: false }, settings: [{ id: SOL, displayName: 'DroidProxy: GPT 6.1 Sol' }] });
  await r.advance(0);
  assert.deepEqual(opens(r), [['open', '-g', '-a', path.join(r.dirs.system, 'DroidProxy.app'), '--args', '--launched-by', 'droid-office']]);
  assert.equal(r.subs.state().proxy.phase, 'starting');
  assert.equal(r.pending()[0], 2000, 'it looks every 2 s while it starts');
  await r.advance(32_000);
  const s = r.subs.state();
  assert.equal(s.proxy.phase, 'stopped');
  assert.equal(s.proxy.error, "DroidProxy didn't start: open it from Applications to see why");
  assert.deepEqual(s.availability, { [SOL]: { state: 'proxy-down', installed: true } });
  assert.ok(r.pending()[0] > 2000, 'a stopped DroidProxy is looked at every 30 s');
  // A stopped DroidProxy lets the hire through and starts it.
  r.world.startsUp = true;
  assert.equal(r.subs.gate(SOL), undefined);
  assert.equal(r.subs.gate(SOL), undefined);
  assert.equal(r.subs.gate(SOL), undefined);
  await r.advance(2000);
  assert.equal(opens(r).length, 2);
  assert.equal(r.subs.state().proxy.phase, 'running');
});

test('connect starts DroidProxy first, polls fast while signing in, and puts the models in Droid after the first account', async (t) => {
  const r = await rig(t, { world: { running: false } });
  await r.advance(0);
  assert.equal(r.subs.state().proxy.phase, 'stopped');
  assert.deepEqual(opens(r), [], 'no DroidProxy models in Droid: nothing starts it');
  await r.send({ t: 'subscriptions.connect', provider: 'claude' });
  await r.until(() => r.world.posts.length > 0, 'the connect');
  assert.equal(opens(r).length, 1);
  assert.deepEqual(r.world.posts, [['/connect', { provider: 'claude' }]]);
  await r.until(() => !!r.subs.state().providers.find((p) => p.key === 'claude')?.connecting, 'the connect in the state');
  assert.equal(r.pending()[0], 2000);
  // The owner signs in in the browser; DroidProxy's /status has the account next time.
  r.world.status = {
    ...r.world.status,
    providers: r.world.status.providers?.map((p) => (p.key === 'claude' ? { ...p, connecting: null, accounts: [{ id: 'claude-owner@example.com.json', label: 'owner@example.com' }] } : p)),
  };
  await r.advance(2000);
  await r.until(() => r.modelsChanged === 1, 'the models in Droid');
  assert.deepEqual(r.world.posts.at(-1), ['/factory-models', {}]);
  assert.equal(r.pending()[0], 60_000);
});

test('stale DroidProxy models in Droid wait for Update models, and missing ones are put back, but not over and over', async (t) => {
  const r = await rig(t, { world: { status: status({ factory: { installed: 12, available: 14, stale: true } }) } });
  await r.advance(0);
  await r.advance(60_000);
  assert.equal(r.modelsChanged, 0, 'the owner may have taken some out on purpose');
  assert.deepEqual(r.subs.state().models, { installed: 12, available: 14, stale: true });
  r.world.status = status({ factory: { installed: 0, available: 14, stale: true } });
  await r.advance(60_000);
  await r.until(() => r.modelsChanged === 1, 'the models in Droid');
  r.world.status = status({ factory: { installed: 0, available: 14, stale: true } });
  await r.advance(60_000);
  assert.equal(r.modelsChanged, 1);
});

test('the Subscriptions buttons drive the control API and say what failed', async (t) => {
  const r = await rig(t);
  await r.advance(0);
  await r.send({ t: 'subscriptions.provider', provider: 'grok', enabled: true });
  await r.send({ t: 'subscriptions.disconnect', provider: 'codex', account: 'codex-83bf45ca-codex-user@example.com-plus.json' });
  await r.send({ t: 'subscriptions.connectCancel', provider: 'claude' });
  await r.send({ t: 'subscriptions.proxy', action: 'open' });
  await r.send({ t: 'subscriptions.models' });
  await r.until(() => r.modelsChanged === 1, 'the models');
  assert.deepEqual(r.world.posts, [
    ['/providers', { provider: 'grok', enabled: true }],
    ['/accounts/remove', { provider: 'codex', account: 'codex-83bf45ca-codex-user@example.com-plus.json' }],
    ['/connect/cancel', { provider: 'claude' }],
    ['/open', {}],
    ['/factory-models', {}],
  ]);
  assert.deepEqual(r.toasts.at(-1), ['DroidProxy put 14 models in Droid', 'info']);
  r.world.api = false;
  await r.send({ t: 'subscriptions.refresh' });
  assert.equal(r.subs.state().proxy.phase, 'outdated');
});

test('install downloads, checks and installs DroidProxy, then starts it', async (t) => {
  const r = await rig(t, { app: null, world: { running: false } });
  await r.advance(0);
  assert.equal(r.subs.state().proxy.phase, 'missing');
  await r.send({ t: 'subscriptions.proxy', action: 'install' });
  await r.until(() => r.subs.state().proxy.phase === 'running', 'DroidProxy to run');
  const s = r.subs.state();
  assert.equal(s.proxy.version, '1.8.179');
  assert.equal(s.proxy.path, path.join(r.dirs.system, 'DroidProxy.app'));
  assert.equal(s.proxy.progress, undefined);
  assert.ok(r.broadcasts.some((b) => b.proxy.phase === 'installing' && b.proxy.progress === 1));
  assert.deepEqual(
    r.runs.filter((c) => c[0] !== 'plutil').map((c) => c[0]),
    ['ditto', 'codesign', 'codesign', 'spctl', 'ditto', 'osascript', 'open'],
  );
  assert.deepEqual(r.toasts[0], ['DroidProxy 1.8.179 is installed', 'info']);
});

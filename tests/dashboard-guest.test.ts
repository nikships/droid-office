import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { WorkerInfo } from '../src/shared/protocol.js';
import { GUEST_PRESETS, GUEST_UNAVAILABLE_TEXT, guestSessionOf, guestWsProtocols, type GuestSession } from '../src/shared/guest-links.js';
import {
  GUEST_ORIGIN_TAB_KEY,
  GUEST_TAB_KEY,
  GUEST_WRITE_ONLY_PATHS,
  OWNER_ABILITIES,
  clearGuestOrigin,
  forgetGuestToken,
  guestMayFetch,
  guestOriginMarked,
  markGuestOrigin,
  mayBeGuestOrigin,
  tokenlessGuestHello,
  guestAbilities,
  guestBadge,
  guestCloseOutcome,
  guestHelloOutcome,
  guestRefusalFinal,
  guestTokenAtBoot,
  guestUnavailableView,
  hashWithoutGuestToken,
  parseGuestSession,
} from '../src/client/dashboard-guest.js';
import { guestApiUrl, guestFetch, guestTokenOn, setBrowserAuth, setGuestAuth, withToken } from '../src/client/token.js';
import { workerMenuItems } from '../src/client/dashboard-worker-menu.js';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789_-AB';
const session = (preset: GuestSession['preset'], extra: Partial<GuestSession> = {}): GuestSession => ({ ...guestSessionOf({ preset, floorId: 'floor-a', workerId: 'pixel' }), ...extra });

class Tab {
  items = new Map<string, string>();
  getItem(k: string) {
    return this.items.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.items.set(k, v);
  }
  removeItem(k: string) {
    this.items.delete(k);
  }
}

test('each preset shows only its scope and offers work only when it writes', () => {
  const office = guestAbilities(session('view-office'));
  assert.deepEqual(office, { guest: true, work: false, missionControl: true, missionWork: false, floorSwitch: true, floorAdmin: false, building: true, roster: true, whiteboard: true, owner: false });
  assert.deepEqual(guestAbilities(session('edit-office')), { ...office, work: true, missionWork: true });
  const floor = guestAbilities(session('view-floor'));
  assert.deepEqual(floor, { guest: true, work: false, missionControl: false, missionWork: false, floorSwitch: false, floorAdmin: false, building: false, roster: true, whiteboard: true, owner: false, floor: 'floor-a' });
  assert.deepEqual(guestAbilities(session('edit-floor')), { ...floor, work: true });
  assert.deepEqual(guestAbilities(session('view-worker')), {
    guest: true,
    work: false,
    missionControl: false,
    missionWork: false,
    floorSwitch: false,
    floorAdmin: false,
    building: false,
    roster: false,
    whiteboard: false,
    owner: false,
    worker: 'pixel',
    floor: 'floor-a',
  });
  for (const preset of GUEST_PRESETS) {
    const a = guestAbilities(session(preset));
    assert.equal(a.owner, false, preset);
    assert.equal(a.floorAdmin, false, preset);
  }
  // A session never grants more than its preset: a view preset that claims to write still can't.
  assert.equal(guestAbilities(session('view-floor', { write: true })).work, false);
  assert.equal(OWNER_ABILITIES.owner && OWNER_ABILITIES.work && OWNER_ABILITIES.floorAdmin, true);
});

test('a session from the office is checked against its preset', () => {
  assert.equal(parseGuestSession(undefined), undefined);
  assert.equal(parseGuestSession({ preset: 'view-everything', write: true }), undefined);
  assert.equal(parseGuestSession({ preset: 'view-floor', write: false, scope: 'floor', missionControl: false }), undefined, 'a floor link needs its floor');
  assert.equal(parseGuestSession({ preset: 'view-worker', floorId: 'f', scope: 'worker' }), undefined, 'a worker link needs its worker');
  assert.deepEqual(parseGuestSession({ preset: 'view-floor', write: true, scope: 'office', floorId: 'f', workerId: 'w', missionControl: true, expiresAt: 'soon', token: TOKEN }), {
    preset: 'view-floor',
    write: false,
    scope: 'floor',
    floorId: 'f',
    missionControl: false,
  });
  assert.deepEqual(parseGuestSession({ preset: 'edit-office', write: true, missionControl: true, expiresAt: '2030-01-01T00:00:00.000Z' }), {
    preset: 'edit-office',
    write: true,
    scope: 'office',
    missionControl: true,
    expiresAt: '2030-01-01T00:00:00.000Z',
  });
});

test('hello: only the guest backend’s own refusal ends a link; anything else retries', () => {
  const s = session('edit-floor');
  assert.deepEqual(guestHelloOutcome(200, { ok: true, session: s }), { kind: 'ok', session: parseGuestSession(s) });
  assert.deepEqual(guestHelloOutcome(200, { ok: true }), { kind: 'offline' });
  for (const [status, reason] of [
    [401, 'unavailable'],
    [410, 'expired'],
    [410, 'revoked'],
    [403, 'disabled'],
  ] as const)
    assert.deepEqual(guestHelloOutcome(status, { ok: false, reason, error: 'x' }), { kind: 'refused', reason });
  assert.deepEqual(guestHelloOutcome(404, { ok: false, reason: 'expired' }), { kind: 'offline' });
  assert.deepEqual(guestHelloOutcome(401, { ok: false, reason: 'because' }), { kind: 'offline' });
  assert.deepEqual(guestHelloOutcome(403, '<html>proxy</html>'), { kind: 'offline' });
  assert.deepEqual(guestHelloOutcome(502, undefined), { kind: 'offline' });
  assert.deepEqual(guestHelloOutcome(429, {}, '30'), { kind: 'throttled', retryMs: 30_000 });
  assert.deepEqual(guestHelloOutcome(429, {}, '1'), { kind: 'throttled', retryMs: 5_000 });
  assert.deepEqual(guestHelloOutcome(429, {}, '3600'), { kind: 'throttled', retryMs: 60_000 });
  assert.deepEqual(guestHelloOutcome(429, {}, null), { kind: 'throttled', retryMs: 10_000 });
});

test('socket closes: an ended link stops at once, anything else reconnects through hello', () => {
  assert.deepEqual(guestCloseOutcome(4411, ''), { kind: 'ended', reason: 'disabled' });
  assert.deepEqual(guestCloseOutcome(4410, 'expired'), { kind: 'ended', reason: 'expired' });
  assert.deepEqual(guestCloseOutcome(4410, 'revoked'), { kind: 'ended', reason: 'revoked' });
  assert.deepEqual(guestCloseOutcome(4410, ''), { kind: 'ended', reason: 'unavailable' });
  for (const code of [1000, 1001, 1006, 1012, 4401, 4403]) assert.deepEqual(guestCloseOutcome(code, ''), { kind: 'reconnect' }, String(code));
  assert.equal(guestRefusalFinal('expired'), true);
  assert.equal(guestRefusalFinal('revoked'), true);
  assert.equal(guestRefusalFinal('unavailable'), true);
  assert.equal(guestRefusalFinal('disabled'), false);
});

test('status screens say why in fixed words, with nothing from the office or the address', () => {
  for (const reason of ['unavailable', 'expired', 'revoked', 'disabled'] as const) {
    const view = guestUnavailableView(reason);
    assert.equal(view.text, GUEST_UNAVAILABLE_TEXT[reason]);
    assert.ok(view.title.length > 0);
    assert.doesNotMatch(`${view.title} ${view.text}`, /\/|\\|https?:|\.ts\.net|token|stack|Error/i);
  }
});

test('the token lives in this tab only and leaves the address bar', () => {
  const tab = new Tab();
  assert.equal(guestTokenAtBoot('', tab), undefined);
  assert.equal(guestTokenAtBoot(`#g=${TOKEN}`, tab), TOKEN);
  assert.equal(tab.getItem(GUEST_TAB_KEY), TOKEN);
  // A refresh, with the token already gone from the address, still opens the link.
  assert.equal(guestTokenAtBoot('', tab), TOKEN);
  assert.equal(guestTokenAtBoot('#g=short', tab), TOKEN, 'a malformed fragment is ignored');
  const next = `${TOKEN.slice(0, -2)}ZZ`;
  assert.equal(guestTokenAtBoot(`#g=${next}`, tab), next, 'a new link replaces the kept one');
  forgetGuestToken(tab);
  assert.equal(guestTokenAtBoot('', tab), undefined);
  tab.setItem(GUEST_TAB_KEY, 'bad token');
  assert.equal(guestTokenAtBoot('', tab), undefined);
  const blocked = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
    removeItem: () => {
      throw new Error('blocked');
    },
  };
  assert.equal(guestTokenAtBoot(`#g=${TOKEN}`, blocked), TOKEN);
  assert.equal(guestTokenAtBoot('', blocked), undefined);
  assert.doesNotThrow(() => forgetGuestToken(blocked));
  assert.equal(hashWithoutGuestToken(`#g=${TOKEN}`), '');
  assert.equal(hashWithoutGuestToken(`#worker=pixel&g=${TOKEN}`), '#worker=pixel');
  assert.equal(hashWithoutGuestToken('#worker=pixel'), '#worker=pixel');
});

test('a page on the share link origin with no token ends on the guest status screen, never pairing', () => {
  // The guest backend answers the owner's hello 404; nothing else that answers 404 there is the office.
  assert.equal(mayBeGuestOrigin(404), true);
  for (const status of [200, 401, 403, 502]) assert.equal(mayBeGuestOrigin(status), false, String(status));
  // Its tokenless hello: the guest backend's own refusal says this is its origin, and why nothing opens.
  assert.equal(tokenlessGuestHello(401, { ok: false, reason: 'unavailable', error: GUEST_UNAVAILABLE_TEXT.unavailable }), 'unavailable');
  assert.equal(tokenlessGuestHello(403, { ok: false, reason: 'disabled', error: GUEST_UNAVAILABLE_TEXT.disabled }), 'disabled');
  // Anything else is not the guest backend (go on as the owner's page) or nothing useful answered (ask later).
  assert.equal(tokenlessGuestHello(404, { error: 'Not found' }), 'other');
  assert.equal(tokenlessGuestHello(401, { error: 'Unauthorized' }), 'other', 'an owner-style 401 is not a guest refusal');
  assert.equal(tokenlessGuestHello(401, { ok: false, reason: 'nope' }), 'other');
  assert.equal(tokenlessGuestHello(200, { ok: true }), 'other');
  assert.equal(tokenlessGuestHello(502, undefined), 'offline');
  assert.equal(tokenlessGuestHello(429, undefined), 'offline');

  // A link that ended in this tab marks it, so a refresh asks the guest backend first; an owner's page can clear it.
  const tab = new Tab();
  assert.equal(guestOriginMarked(tab), false);
  markGuestOrigin(tab);
  assert.equal(tab.getItem(GUEST_ORIGIN_TAB_KEY), '1');
  assert.equal(guestOriginMarked(tab), true);
  clearGuestOrigin(tab);
  assert.equal(guestOriginMarked(tab), false);
  const blocked = {
    getItem: (): string | null => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
    removeItem: () => {
      throw new Error('blocked');
    },
  };
  markGuestOrigin(blocked);
  clearGuestOrigin(blocked);
  assert.equal(guestOriginMarked(blocked), false);
  assert.equal(guestOriginMarked(undefined), false);
});
test('the badge says shared view, view only or can edit, and the expiry when there is one', () => {
  const view = guestBadge(session('view-worker'), () => 'never');
  assert.deepEqual(view, { label: 'Shared view', mode: 'View only', title: 'Shared view of one worker · view only · the link lasts until it is turned off' });
  const edit = guestBadge(session('edit-office', { expiresAt: '2030-01-01T00:00:00.000Z' }), (iso) => `T${iso.slice(0, 4)}`);
  assert.deepEqual(edit, { label: 'Shared view', mode: 'Can edit', expires: 'Until T2030', title: 'Shared view of the office · you can work here · the link ends T2030' });
  assert.match(guestBadge(session('view-floor', { expiresAt: '2030-01-01T00:00:00.000Z' })).expires ?? '', /^Until /);
});

test('a view-only worker menu offers only opening and copying', () => {
  const worker = { id: 'pixel', name: 'Pixel', color: '#a8d354', kind: 'agent', status: 'working', sessionId: 's', worktree: { branch: 'b', path: '/tmp/w' } } as WorkerInfo;
  const base = { worker, floor: 'f', pane: 0, live: true, busy: false, native: false };
  assert.deepEqual(
    workerMenuItems({ ...base, work: false }).map((i) => i.action),
    ['open', 'split', 'close', 'copy-name', 'copy-branch'],
  );
  assert.deepEqual(
    workerMenuItems({ ...base, work: true }).map((i) => i.action),
    workerMenuItems(base).map((i) => i.action),
  );
});

test('the owner’s page keeps its own credentials; a guest page sends only its token, and never in a request line', async () => {
  setBrowserAuth('device-token');
  assert.equal(guestTokenOn(), false);
  assert.equal(withToken('/api/thread/image?worker=pixel'), '/api/thread/image?worker=pixel&d=device-token');

  setGuestAuth(TOKEN);
  assert.equal(guestTokenOn(), true);
  assert.equal(withToken('/api/thread/image?worker=pixel'), `/api/thread/image?worker=pixel&g=${TOKEN}`);
  assert.equal(withToken('/api/thread/file'), `/api/thread/file?g=${TOKEN}`);
  assert.equal(withToken('/whiteboard/c/cap/index.html'), '/whiteboard/c/cap/index.html', 'card capabilities carry no credential');
  assert.equal(withToken('https://elsewhere.example/api/x'), 'https://elsewhere.example/api/x');
  assert.equal(withToken('//elsewhere.example/api/x'), '//elsewhere.example/api/x');

  const base = 'https://office.example/dashboard';
  assert.equal(guestApiUrl(`/api/thread/files?floor=f&g=${TOKEN}`, base), '/api/thread/files?floor=f');
  assert.equal(guestApiUrl('https://office.example/api/guest/hello', base), '/api/guest/hello');
  assert.equal(guestApiUrl('https://elsewhere.example/api/guest/hello', base), undefined);
  assert.equal(guestApiUrl('/assets/app.js', base), undefined);
  assert.equal(guestApiUrl('http://[bad', base), undefined);

  const seen: { url: string; auth: string | null; method: string }[] = [];
  const real = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = typeof input === 'object' && !(input instanceof URL) ? new Request(input, init) : new Request(new URL(input, base), init);
    seen.push({ url: req.url, auth: req.headers.get('authorization'), method: req.method });
    return new Response('{}');
  }) as typeof fetch;
  const f = guestFetch(() => base, real);
  await f(withToken('/api/thread/files?floor=f'), { headers: { accept: 'application/json' } });
  await f(new Request(new URL(withToken('/api/term/paths?worker=pixel'), base), { method: 'POST', body: '{}' }));
  await f(new URL('/assets/app.js', base));
  await f('https://elsewhere.example/api/x');
  assert.deepEqual(seen, [
    { url: 'https://office.example/api/thread/files?floor=f', auth: `Bearer ${TOKEN}`, method: 'GET' },
    { url: 'https://office.example/api/term/paths?worker=pixel', auth: `Bearer ${TOKEN}`, method: 'POST' },
    { url: 'https://office.example/assets/app.js', auth: null, method: 'GET' },
    { url: 'https://elsewhere.example/api/x', auth: null, method: 'GET' },
  ]);
  for (const s of seen.slice(0, 2)) assert.doesNotMatch(s.url, /[?&]g=|[?&][td]=/);
  assert.deepEqual(guestWsProtocols(TOKEN), ['droid-office-guest', TOKEN]);

  // A view-only page answers write-only routes itself, without sending them.
  seen.length = 0;
  const viewOnly = guestFetch(
    () => base,
    real,
    (p) => guestMayFetch(p, false),
  );
  const refused = await viewOnly('/api/agents/droid/models');
  assert.equal(refused.status, 404);
  assert.deepEqual(await refused.json(), { error: 'Not found' });
  await viewOnly(withToken('/api/thread/image?worker=pixel'));
  assert.deepEqual(
    seen.map((s) => s.url),
    ['https://office.example/api/thread/image?worker=pixel'],
  );
});

test('a view-only page never asks for the routes the guest backend opens only to write presets', () => {
  const source = readFileSync(new URL('../src/server/server-runtime/guest-http.ts', import.meta.url), 'utf8');
  const writeOnly = [...source.matchAll(/^\s+'(\/api\/[a-z/]+)': \{ methods: \[\], write:/gm)].map((m) => m[1]);
  assert.ok(writeOnly.length >= 5, 'the server table was read');
  // The model and command lists are answered only to write presets, ahead of that table.
  assert.match(source, /'\/api\/agents\/droid\/models'\) \{\s+if \(method !== 'GET' \|\| !write\)/);
  assert.deepEqual([...GUEST_WRITE_ONLY_PATHS].sort(), [...writeOnly, '/api/agents/droid/models', '/api/agents/droid/commands'].sort());
  for (const p of GUEST_WRITE_ONLY_PATHS) {
    assert.equal(guestMayFetch(p, false), false, p);
    assert.equal(guestMayFetch(p, true), true, p);
  }
  for (const p of ['/api/guest/hello', '/api/thread/image', '/api/changes/file', '/api/whiteboard/render', '/api/gh/pull']) assert.equal(guestMayFetch(p, false), true, p);
});

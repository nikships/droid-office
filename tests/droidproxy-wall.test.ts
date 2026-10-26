import test from 'node:test';
import assert from 'node:assert/strict';
import { QuotaWallTexture, quotaLayout, quotaView, resetWords } from '../src/client/world/droidproxy-wall.js';
import { mapProviders } from '../src/server/subscriptions/map.js';
import { COMPUTE_WALL, DROID_RACK, EXIT_DOOR, WALL_HEIGHT, WINDOWS } from '../src/shared/layout.js';
import { emptySubscriptionsState, type SubscriptionsState } from '../src/shared/subscriptions.js';
import { NOW, USAGE, status } from './subscriptions-fixtures.js';

function state(): SubscriptionsState {
  return { ...emptySubscriptionsState(), proxy: { phase: 'running', version: '1.8.180', latest: null, path: null, error: null }, providers: mapProviders(status(), USAGE, NOW), checkedAt: NOW };
}

test('the quota wall shows every connected account, including providers without usage', () => {
  const s = state();
  const v = quotaView(s, NOW);
  assert.equal(v.accounts, 4);
  assert.equal(v.reporting, 2);
  assert.equal(v.limited, 1);
  assert.deepEqual(
    v.tiles.map((t) => [t.provider, t.status]),
    [
      ['ChatGPT', 'limited'],
      ['Junie', 'unreported'],
      ['Grok', 'reporting'],
      ['Meta', 'low'],
    ],
  );
  assert.deepEqual(
    v.tiles[0].windows.map((w) => [w.name, w.remaining]),
    [
      ['5-hour', 0],
      ['Weekly', 84],
    ],
  );
  assert.match(v.tiles[0].windows[0].reset, /^Resets in 42 min · /);
  assert.match(v.tiles[1].detail, /not reported/);
  assert.equal(v.pages, 1);
});

test('paused, expired and failed accounts never look ready or fully available', () => {
  const s = state();
  s.providers[2].enabled = false;
  s.providers[3].accounts[0].expired = true;
  s.providers[4].accounts[0].usageError = 'Usage API returned 401';
  const v = quotaView(s, NOW);
  assert.deepEqual(
    v.tiles.map((t) => t.status),
    ['limited', 'paused', 'sign-in', 'unavailable'],
  );
  assert.match(v.tiles[2].detail, /Reconnect/);
  assert.match(v.tiles[3].detail, /Could not read/);
  s.providers[3].accounts[0].expired = false;
  s.providers[3].accounts[0].disabled = true;
  assert.equal(quotaView(s, NOW).tiles[2].status, 'paused');
});

test('a fresh control check cannot make old usage look fresh, and an elapsed reset never refills it', () => {
  const s = state();
  const later = NOW + 10 * 60_000;
  s.checkedAt = later;
  const v = quotaView(s, later);
  assert.equal(v.tiles[0].status, 'cached');
  assert.equal(v.tiles[0].windows[0].remaining, 0);
  s.proxy.phase = 'stopped';
  assert.match(quotaView(s, NOW).note, /stopped/);
  assert.equal(quotaView(s, NOW).tiles[2].status, 'cached');
  s.proxy.phase = 'running';
  delete s.providers[3].accounts[0].usageUpdatedAt;
  assert.equal(quotaView(s, NOW).tiles[2].status, 'cached');
  s.providers[1].accounts[0].windows[0].resetsAt = NOW - 60_000;
  assert.equal(quotaView(s, NOW).tiles[0].status, 'cached');
  assert.equal(quotaView(s, NOW).tiles[0].windows[0].due, true);
  assert.equal(resetWords({ name: 'x', usedPercent: 100, resetsAt: NOW - 60_000 }, NOW), 'Reset due · awaiting update');
  assert.equal(resetWords({ name: 'x', usedPercent: 0, resetsAt: null }, NOW), 'Reset time not reported');
});

test('account and quota-window overflow rotates complete pages instead of dropping details', () => {
  const s = state();
  const a = s.providers[3].accounts[0];
  s.providers = [{ ...s.providers[3], accounts: Array.from({ length: 8 }, (_, i) => ({ ...a, id: `account-${i}` })) }];
  const t = Math.floor(NOW / 40_000) * 40_000;
  const first = quotaView(s, t);
  const second = quotaView(s, t + 20_000);
  assert.equal(first.pages, 2);
  assert.equal(first.page, 0);
  assert.equal(first.tiles.length, 4);
  assert.equal(second.page, 1);
  assert.equal(second.tiles.length, 4);
  assert.equal(new Set([...first.tiles, ...second.tiles].map((a) => a.id)).size, 8);
  s.providers[0].accounts = [{ ...a, windows: [...a.windows, ...a.windows, ...a.windows] }];
  const v = quotaView(s, t);
  assert.equal(v.accounts, 1);
  assert.equal(v.tiles.length, 2);
  assert.equal(v.tiles[0].windows.length, 2);
  assert.equal(v.tiles[1].windows.length, 1);
  assert.equal(v.tiles[1].continuation, 'WINDOWS 3–3 OF 3');
  assert.deepEqual(quotaLayout(1), { cols: 1, rows: 1 });
  assert.deepEqual(quotaLayout(6), { cols: 1, rows: 4 });
});

test('empty, installing, unsupported and failed proxy states explain what is missing', () => {
  const s = emptySubscriptionsState();
  assert.match(quotaView(s, NOW).note, /Apple silicon/);
  s.proxy.phase = 'missing';
  assert.match(quotaView(s, NOW).note, /Connect your plans/);
  s.proxy.phase = 'installing';
  assert.match(quotaView(s, NOW).note, /Installing/);
  s.proxy.phase = 'running';
  assert.match(quotaView(s, NOW).note, /Connect an account/);
  s.proxy.error = 'Connection failed';
  assert.match(quotaView(s, NOW).note, /could not refresh/);
});

test('the low wall sits at eye level south of the exit door, clear of the door, windows and ceiling', () => {
  const c = COMPUTE_WALL;
  assert.ok(Math.abs(c.width - (c.machineWidth + c.fleetWidth + c.proxyWidth + c.gap * 2)) < 1e-10);
  assert.ok(c.height <= 1.5 && c.y - c.height / 2 >= 1.2, 'a short strip whose bottom is at standing eye level, not a billboard overhead');
  assert.ok(c.y + c.height / 2 <= 2.8, 'its top is within easy view from the floor');
  const south = c.z + c.width / 2;
  assert.equal(south, 12.55);
  const fleetZ = south - c.machineWidth - c.gap - c.fleetWidth / 2;
  assert.ok(Math.abs((DROID_RACK.minZ + DROID_RACK.maxZ) / 2 - fleetZ) < 1e-10);
  // Clear of the exit door and its sign beside it, not by hanging above them.
  const north = c.z - c.width / 2;
  assert.ok(north > EXIT_DOOR.u + EXIT_DOOR.width / 2, 'the strip starts south of the exit door');
  assert.ok(
    WINDOWS.filter((w) => w.wall === 'west').every((w) => north > w.u + w.width / 2 || south < w.u - w.width / 2),
    'the windows stay clear',
  );
  assert.ok(c.y + c.height / 2 + 0.08 < WALL_HEIGHT);
});

test('the canvas paints real quota states and uploads only changed content, including after font load', (t) => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document');
  t.after(() => (saved ? Object.defineProperty(globalThis, 'document', saved) : Reflect.deleteProperty(globalThis, 'document')));
  const text: string[] = [];
  const rects: number[][] = [];
  const ctx = {
    font: '',
    fillText: (value: string) => text.push(value),
    measureText(value: string) {
      return { width: value.length * Number(this.font.match(/(\d+)px/)?.[1] ?? 20) * 0.6 };
    },
    fillRect: (...r: number[]) => rects.push(r),
    strokeRect: () => {},
  };
  const canvas = { width: 0, height: 0, getContext: () => ctx };
  Object.assign(ctx, { canvas });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => canvas } });
  const wall = new QuotaWallTexture();
  t.after(() => wall.texture.dispose());
  const s = state();
  wall.render(s, NOW);
  assert.ok(text.includes('DROIDPROXY'));
  assert.ok(text.includes('0% left'));
  assert.ok(text.includes('LIMIT REACHED'));
  const version = wall.texture.version;
  const calls = text.length;
  wall.render(s, NOW + 1000);
  assert.equal(wall.texture.version, version);
  assert.equal(text.length, calls);
  wall.render(s, NOW, true);
  assert.equal(wall.texture.version, version + 1);
  assert.ok(rects.every((r) => r.every(Number.isFinite)));
  s.providers[1].accounts[0].windows[0].resetsAt = NOW - 60_000;
  s.providers[3].accounts[0].windows = [];
  s.providers[3].accounts[0].expired = true;
  wall.render(s, NOW);
  assert.ok(text.includes('Reset due · awaiting update'));
  assert.ok(text.includes('Account needs reconnecting'));
  wall.render(emptySubscriptionsState(), NOW);
  assert.ok(text.includes('YOUR PLANS. YOUR QUOTAS.'));
  s.providers[1].enabled = false;
  s.providers[1].accounts[0].windows = [];
  s.providers[3].accounts[0].expired = false;
  s.providers[3].accounts[0].usageError = 'unavailable';
  wall.render(s, NOW);
  assert.ok(text.includes('Provider or account is switched off'));
  const a = s.providers[3].accounts[0];
  s.providers[3].accounts = Array.from({ length: 9 }, (_, i) => ({ ...a, id: String(i), label: 'A long account label '.repeat(10) }));
  wall.render(s, NOW);
  assert.ok(text.some((s) => s.startsWith('PAGE ')));
  assert.ok(text.some((s) => s.endsWith('…')));
});

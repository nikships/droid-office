import test from 'node:test';
import assert from 'node:assert/strict';
import { HUD_DEFAULTS, loadSettings } from '../src/client/state.js';

const mem = new Map<string, string>();
const storage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};

Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });

test('settings show the workers panel by default, and yesterday’s people/chat panels can’t come back', () => {
  mem.clear();
  assert.deepEqual(loadSettings().hud, { workers: true, spend: false, limits: false, floor: false });
  assert.deepEqual(HUD_DEFAULTS, { workers: true, spend: false, limits: false, floor: false });

  // Saved before the people and chat panels went away.
  mem.set('droid-office.settings', JSON.stringify({ hud: { people: true, chat: true, spend: true }, pins: ['people', 'chat', 'search'] }));
  const s = loadSettings();
  assert.deepEqual(s.hud, { workers: true, spend: true, limits: false, floor: false });
  assert.deepEqual(s.pins, ['search']);
});

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

test('settings show the workers panel by default, and yesterday’s spend/limits panels can’t come back', () => {
  mem.clear();
  assert.deepEqual(loadSettings().hud, { workers: true, floor: false });
  assert.deepEqual(HUD_DEFAULTS, { workers: true, floor: false });

  // Saved before the spend and limits panels went away.
  mem.set('droid-office.settings', JSON.stringify({ hud: { people: true, chat: true, spend: true, limits: true, floor: true }, pins: ['people', 'chat', 'search'] }));
  const s = loadSettings();
  assert.deepEqual(s.hud, { workers: true, floor: true });
  assert.deepEqual(s.pins, ['search']);
});

test('7 puts the wand in your hand unless you opted into the Magnum', () => {
  mem.clear();
  assert.equal(loadSettings().sidearm, 'wand');
  mem.set('droid-office.settings', JSON.stringify({ sidearm: 'magnum' }));
  assert.equal(loadSettings().sidearm, 'magnum');
  mem.set('droid-office.settings', JSON.stringify({ sidearm: 'bazooka' }));
  assert.equal(loadSettings().sidearm, 'wand');
});

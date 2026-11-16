import test from 'node:test';
import assert from 'node:assert/strict';
import { savedPrefs } from '../src/client/ui/saved-prefs.js';

interface Prefs {
  size: 'sm' | 'md' | 'lg';
  on: boolean;
}
const DEFAULTS: Readonly<Prefs> = Object.freeze({ size: 'md', on: false });
const OPTIONS = { size: ['sm', 'md', 'lg'], on: [true, false] } as const;

/** A browser's storage and `storage` events, in memory. */
function fakeBrowser(t: { after: (fn: () => void) => void }) {
  const g = globalThis as Record<string, unknown>;
  const before = { localStorage: g.localStorage, window: g.window };
  const items = new Map<string, string>();
  const storageListeners: ((e: { key: string | null }) => void)[] = [];
  g.localStorage = {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    removeItem: (k: string) => void items.delete(k),
  };
  g.window = { addEventListener: (type: string, fn: (e: { key: string | null }) => void) => type === 'storage' && storageListeners.push(fn) };
  t.after(() => Object.assign(g, before));
  return { items, otherTab: (key: string | null) => storageListeners.forEach((fn) => fn({ key })) };
}

test('choices save under one key, only while they differ from the defaults', (t) => {
  const { items } = fakeBrowser(t);
  const prefs = savedPrefs('test.prefs', DEFAULTS, OPTIONS);
  assert.deepEqual(prefs.get(), DEFAULTS);
  const heard: Prefs[] = [];
  const off = prefs.on((p) => heard.push(p));
  prefs.set({ size: 'lg' });
  assert.equal(items.get('test.prefs'), JSON.stringify({ size: 'lg', on: false }));
  prefs.set({ size: 'lg' });
  prefs.set({ size: 'huge' as never });
  assert.equal(heard.length, 1, 'a change to the same or an invalid value is not a change');
  prefs.reset();
  assert.equal(items.has('test.prefs'), false);
  assert.deepEqual(prefs.get(), DEFAULTS);
  prefs.reset();
  assert.equal(heard.length, 2);
  off();
  prefs.set({ on: true });
  assert.equal(heard.length, 2);
});

test('a saved choice is read back, and an unreadable one is the defaults', (t) => {
  const { items } = fakeBrowser(t);
  items.set('test.saved', JSON.stringify({ on: true, size: 'nope' }));
  assert.deepEqual(savedPrefs('test.saved', DEFAULTS, OPTIONS).get(), { size: 'md', on: true });
  items.set('test.broken', '{');
  assert.deepEqual(savedPrefs('test.broken', DEFAULTS, OPTIONS).get(), DEFAULTS);
});

test('another tab’s change to the same key applies here; other keys are left alone', (t) => {
  const { items, otherTab } = fakeBrowser(t);
  const prefs = savedPrefs('test.tabs', DEFAULTS, OPTIONS);
  const heard: Prefs[] = [];
  prefs.on((p) => heard.push(p));
  items.set('test.tabs', JSON.stringify({ size: 'sm', on: true }));
  otherTab('something.else');
  assert.equal(heard.length, 0);
  otherTab('test.tabs');
  assert.deepEqual(heard, [{ size: 'sm', on: true }]);
  assert.deepEqual(prefs.get(), { size: 'sm', on: true });
  otherTab(null);
  assert.equal(heard.length, 1, 'storage cleared to what is already here is no change');
});

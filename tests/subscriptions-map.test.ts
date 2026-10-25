import test from 'node:test';
import assert from 'node:assert/strict';
import { hireRefusal, mapAvailability, mapProviders, modelNames, modelProviders, providersFromUsage, usageWindows } from '../src/server/subscriptions/map.js';
import { MODELS, NOW, USAGE, status } from './subscriptions-fixtures.js';

test("providers come from /status, each account with its windows from DroidProxy's usage", () => {
  const ps = mapProviders(status(), USAGE, NOW);
  assert.deepEqual(
    ps.map((p) => [p.key, p.name, p.enabled, p.connect, p.accounts.length]),
    [
      ['claude', 'Claude', true, 'browser', 0],
      ['codex', 'Codex', true, 'browser', 1],
      ['grok', 'Grok', false, 'device', 1],
      ['kimi', 'Kimi', true, 'app', 0],
    ],
  );
  const codex = ps[1].accounts[0];
  assert.equal(codex.label, 'codex-user@example.com');
  assert.deepEqual(codex.windows, [
    { name: '5-hour', usedPercent: 100, resetsAt: Date.parse('2026-10-25T22:12:45Z') },
    { name: 'Weekly', usedPercent: 16, resetsAt: Date.parse('2026-11-01T08:15:41Z') },
  ]);
  assert.deepEqual(
    ps[2].accounts[0].windows.map((w) => w.usedPercent),
    [66],
  );
});

test('an account is matched to its usage by id, else by its email in any case, and only within its provider', () => {
  const s = status({
    providers: [
      { key: 'grok', name: 'Grok', enabled: true, connect: 'device', accounts: [{ id: 'renamed.json', label: 'grok-user@example.com' }] },
      { key: 'claude', name: 'Claude', enabled: true, connect: 'browser', accounts: [{ id: 'grok-cli.json', label: 'x' }] },
    ],
  });
  const [grok, claude] = mapProviders(s, USAGE, NOW);
  assert.deepEqual(
    grok.accounts[0].windows.map((w) => w.name),
    ['Weekly'],
  );
  assert.deepEqual(claude.accounts[0].windows, []);
  const err = mapProviders(s, { accounts: [{ id: 'renamed.json', provider: 'grok', account: null, error: 'Usage API returned 401', windows: [] }] }, NOW);
  assert.equal(err[0].accounts[0].usageError, 'Usage API returned 401');
});

test('a connect in flight carries its code, its page and why it failed', () => {
  const s = status({
    providers: [
      { key: 'grok', name: 'Grok', enabled: true, connect: 'device', accounts: [], connecting: { started_at: '2026-10-25T21:30:00Z', user_code: 'ABCD-EFGH', verification_uri: 'https://accounts.x.ai/device', error: null } },
      { key: 'claude', name: 'Claude', enabled: true, connect: 'browser', accounts: [], connecting: { started_at: null, user_code: null, verification_uri: null, error: 'The sign-in timed out' } },
      { key: 'nope', name: 'Unknown', enabled: true, connect: 'browser', accounts: [] },
    ],
  });
  const ps = mapProviders(s, undefined, NOW);
  assert.equal(ps.length, 2);
  assert.deepEqual(ps[0].connecting, { since: Date.parse('2026-10-25T21:30:00Z'), code: 'ABCD-EFGH', url: 'https://accounts.x.ai/device' });
  assert.deepEqual(ps[1].connecting, { since: NOW, error: 'The sign-in timed out' });
});

test('an older DroidProxy still shows its accounts and what is left, from its usage alone', () => {
  const ps = providersFromUsage(USAGE);
  assert.deepEqual(
    ps.map((p) => [p.key, p.name, p.connect, p.accounts.map((a) => a.label)]),
    [
      ['codex', 'ChatGPT', 'app', ['codex-user@example.com']],
      ['grok', 'Grok', 'app', ['Grok-User@example.com']],
      ['meta', 'Meta', 'app', ['Meta account 423f1867']],
    ],
  );
  assert.deepEqual(
    ps[2].accounts[0].windows.map((w) => [w.name, w.usedPercent]),
    [
      ['5-hour', 0],
      ['Weekly', 99],
    ],
  );
  assert.deepEqual(providersFromUsage(undefined), []);
});

test('usage windows take remaining when used is missing, clamp, and skip what has neither', () => {
  assert.deepEqual(usageWindows({ windows: [{ name: 'a', remaining_percent: 30 }, { name: 'b', used_percent: 140, resets_at: 'not a date' }, { name: 'c' }] }), [
    { name: 'a', usedPercent: 70, resetsAt: null },
    { name: 'b', usedPercent: 100, resetsAt: null },
  ]);
});

test('/models turns into availability: exhausted until when, signed-out and disabled with their provider, unknown left out', () => {
  assert.deepEqual(mapAvailability(MODELS), {
    'custom:droidproxy:gpt-6.1-sol': { state: 'exhausted', until: Date.parse('2026-10-25T22:12:45Z'), window: '5-hour', account: 'codex-user@example.com' },
    'custom:droidproxy:claude-opus-5-5': { state: 'signed-out', provider: 'claude' },
    'custom:droidproxy:grok-5': { state: 'disabled', provider: 'grok' },
    'custom:droidproxy:gpt-6-luna': { state: 'ok' },
  });
  assert.deepEqual(
    mapAvailability({
      models: [
        { id: 'gpt-5', availability: { state: 'ok' } },
        { id: 'custom:droidproxy:x', provider: 'nope', availability: { state: 'disabled' } },
      ],
    }),
    {},
  );
  assert.equal(modelNames({ models: [{ id: 'custom:droidproxy:a', name: 'DroidProxy: A' }] })['custom:droidproxy:a'], 'A');
  assert.deepEqual(Object.entries(modelProviders(MODELS)), [
    ['custom:droidproxy:gpt-6.1-sol', 'codex'],
    ['custom:droidproxy:claude-opus-5-5', 'claude'],
    ['custom:droidproxy:grok-5', 'grok'],
    ['custom:droidproxy:kimi-k3', 'kimi'],
    ['custom:droidproxy:gpt-6-luna', 'codex'],
  ]);
});

test('a refusal names the model and why', () => {
  const until = NOW + (3 * 60 + 10) * 60_000;
  assert.equal(hireRefusal('GPT 6.1 Sol', { state: 'exhausted', until, window: '5-hour' }, NOW), "Can't hire on GPT 6.1 Sol: out of quota, back in 3 h 10 min (5-hour).");
  assert.equal(hireRefusal('Opus', { state: 'signed-out', provider: 'claude' }, NOW), "Can't hire on Opus: no Claude account is connected.");
  assert.equal(hireRefusal('Grok 5', { state: 'disabled', provider: 'grok' }, NOW), "Can't hire on Grok 5: Grok is switched off in Subscriptions.");
  assert.equal(hireRefusal('X', { state: 'proxy-down', installed: false }, NOW), "Can't hire on X: DroidProxy isn't installed.");
});

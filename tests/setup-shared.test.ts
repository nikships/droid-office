import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareVersions, droidReady, droidUpdateAvailable, emptySetupState, needsWelcome, type SetupState } from '../src/shared/setup.js';
import { availabilityWords, cannotRun, durationWords, emptySubscriptionsState, isSubscriptionModel, modelAvailability, modelUsage, modelUsageWords, type SubscriptionAccount, type SubscriptionsState } from '../src/shared/subscriptions.js';

const ready = (over: Partial<SetupState['droid']> = {}, onboarded = false): SetupState => ({
  onboarded,
  droid: { ...emptySetupState().droid, busy: null, path: '/Users/x/.local/bin/droid', version: '0.249.0', signedIn: true, ...over },
});

test('compareVersions orders dotted numbers, not strings', () => {
  assert.ok(compareVersions('1.8.179', '1.8.18') > 0);
  assert.ok(compareVersions('v0.250.0', '0.249.9') > 0);
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
  assert.ok(compareVersions('1.2.0-beta', '1.2.1') < 0);
});

test('the welcome opens until it is done, once the office knows where Droid stands', () => {
  assert.equal(needsWelcome(emptySetupState()), false, 'not before the server has looked');
  assert.equal(needsWelcome(ready({ path: null, signedIn: null })), true);
  assert.equal(needsWelcome(ready({ signedIn: false })), true);
  assert.equal(needsWelcome(ready()), true, 'a fresh office keeps it after Droid is ready');
  assert.equal(needsWelcome(ready({ signedIn: null })), false, "an unknown sign-in isn't a reason to open it");
  assert.equal(needsWelcome(ready({ path: null }, true)), false, 'never once it is done');
  assert.equal(droidReady(ready()), true);
  assert.equal(droidReady(ready({ signedIn: null })), false);
});

test('an update is available only when the newest release is newer', () => {
  assert.equal(droidUpdateAvailable(ready({ latest: '0.250.0' }).droid), true);
  assert.equal(droidUpdateAvailable(ready({ latest: '0.249.0' }).droid), false);
  assert.equal(droidUpdateAvailable(ready({ latest: null }).droid), false);
});

test('airgapped readiness requires Droid and a custom model, never Factory auth', () => {
  const state = { ...ready({ signedIn: null }), airgapped: true, customModels: ['custom:local:llama'] };
  assert.equal(droidReady(state), true);
  assert.equal(needsWelcome(state), true);
  assert.equal(droidReady({ ...state, customModels: [] }), false);
  assert.equal(droidReady({ ...state, droid: { ...state.droid, path: null } }), false);
  assert.equal(droidReady({ ...state, airgapped: false }), false);
});

test('only models that would fail at once are refused', () => {
  assert.equal(cannotRun(undefined), false);
  assert.equal(cannotRun({ state: 'ok' }), false);
  assert.equal(cannotRun({ state: 'proxy-down', installed: true }), false, 'the office starts a stopped DroidProxy');
  assert.equal(cannotRun({ state: 'proxy-down', installed: false }), true);
  assert.equal(cannotRun({ state: 'exhausted', until: null, window: '5-hour' }), true);
  assert.equal(cannotRun({ state: 'signed-out', provider: 'claude' }), true);
  assert.equal(cannotRun({ state: 'disabled', provider: 'codex' }), true);
});

test('availability is looked up only for subscription models', () => {
  const s = emptySubscriptionsState();
  s.availability['custom:droidproxy:gpt-6.1-sol'] = { state: 'exhausted', until: null, window: '5-hour' };
  assert.equal(isSubscriptionModel('claude-opus-5-5'), false);
  assert.equal(modelAvailability(s, 'claude-opus-5-5'), undefined);
  assert.equal(modelAvailability(s, undefined), undefined);
  assert.deepEqual(modelAvailability(s, 'custom:droidproxy:gpt-6.1-sol'), { state: 'exhausted', until: null, window: '5-hour' });
  assert.equal(modelAvailability(s, 'custom:droidproxy:grok-4.7'), undefined);
});

test('availability reads as one line', () => {
  const now = Date.UTC(2026, 9, 25, 19, 2);
  assert.equal(availabilityWords({ state: 'ok' }, now), '');
  assert.equal(availabilityWords({ state: 'exhausted', until: now + (3 * 60 + 10) * 60_000, window: '5-hour' }, now), 'Out of quota, back in 3 h 10 min (5-hour)');
  assert.equal(availabilityWords({ state: 'exhausted', until: now - 1000, window: 'Weekly' }, now), 'Out of quota (Weekly)');
  assert.equal(availabilityWords({ state: 'signed-out', provider: 'codex' }, now), 'No ChatGPT account is connected');
  assert.equal(availabilityWords({ state: 'disabled', provider: 'claude' }, now), 'Claude is switched off in Subscriptions');
  assert.equal(availabilityWords({ state: 'proxy-down', installed: false }, now), "DroidProxy isn't installed");
  assert.equal(durationWords(30_000), '1 min');
  assert.equal(durationWords(2 * 3600_000), '2 h');
  assert.equal(durationWords(52 * 3600_000), '2 d 4 h');
});

const SOL = 'custom:droidproxy:gpt-6.1-sol';
const USAGE_NOW = Date.UTC(2026, 10, 10, 12, 9);

function account(id: string, over: Partial<SubscriptionAccount> = {}): SubscriptionAccount {
  return { id, label: `${id}@example.com`, expired: false, disabled: false, windows: [], ...over };
}

/** The owner's ChatGPT plan as the Subscriptions panel showed it: 5-hour 100% left, Weekly 61% left. */
const FULL_PLAN = [
  { name: '5-hour', usedPercent: 0, resetsAt: USAGE_NOW + (4 * 60 + 56) * 60_000 },
  { name: 'Weekly', usedPercent: 39, resetsAt: USAGE_NOW + (2 * 24 + 9) * 3_600_000 },
];

function stateWith(accounts: SubscriptionAccount[], over: { enabled?: boolean } = {}): SubscriptionsState {
  const s = emptySubscriptionsState();
  s.providers = [{ key: 'codex', name: 'Codex', enabled: over.enabled ?? true, connect: 'browser', accounts }];
  s.modelProviders = { [SOL]: 'codex' };
  return s;
}

test("usage is derived for a subscription model from its provider's accounts", () => {
  const sampled = USAGE_NOW - 3 * 60_000;
  const u = modelUsage(stateWith([account('a', { windows: FULL_PLAN, usageUpdatedAt: sampled })]), SOL, USAGE_NOW);
  assert.deepEqual(u, {
    provider: 'codex',
    accounts: 1,
    windows: [
      { name: '5-hour', leftPercent: 100, resetsAt: FULL_PLAN[0].resetsAt },
      { name: 'Weekly', leftPercent: 61, resetsAt: FULL_PLAN[1].resetsAt },
    ],
    updatedAt: sampled,
    at: USAGE_NOW,
  });
  assert.equal(modelUsageWords(u!), 'ChatGPT: 5-hour 100% left (resets in 4 h 56 min), Weekly 61% left (resets in 2 d 9 h)');
  assert.equal(modelUsage(stateWith([account('a', { windows: FULL_PLAN })]), 'claude-opus-5-5', USAGE_NOW), undefined, 'not a subscription model');
  assert.equal(modelUsage(stateWith([account('a', { windows: FULL_PLAN })]), 'custom:droidproxy:grok-4.7', USAGE_NOW), undefined, 'no known provider');
});

test('several accounts: the one with the most left shows, as a request runs while any account has quota', () => {
  const low = account('low', {
    windows: [
      { name: '5-hour', usedPercent: 95, resetsAt: null },
      { name: 'Weekly', usedPercent: 10, resetsAt: null },
    ],
  });
  const best = account('best', {
    windows: [
      { name: '5-hour', usedPercent: 40, resetsAt: null },
      { name: 'Weekly', usedPercent: 50, resetsAt: null },
    ],
    usageUpdatedAt: USAGE_NOW,
  });
  const off = account('off', { disabled: true, windows: [{ name: '5-hour', usedPercent: 0, resetsAt: null }] });
  const expired = account('old', { expired: true, windows: [{ name: '5-hour', usedPercent: 0, resetsAt: null }] });
  const unread = account('unread', { usageError: 'timed out' });
  const u = modelUsage(stateWith([low, off, best, expired, unread]), SOL, USAGE_NOW)!;
  assert.equal(u.accounts, 3, 'a switched-off or expired account is not counted');
  assert.deepEqual(
    u.windows.map((w) => [w.name, w.leftPercent]),
    [
      ['5-hour', 60],
      ['Weekly', 50],
    ],
    "one account's windows, never the best of each mixed from two",
  );
  assert.equal(modelUsageWords(u), 'ChatGPT, best of 3 accounts: 5-hour 60% left, Weekly 50% left');
});

test('a window named for another model family is left out', () => {
  const claude = account('c', {
    windows: [
      { name: '5-hour', usedPercent: 10, resetsAt: null },
      { name: 'Weekly (Opus)', usedPercent: 100, resetsAt: null },
      { name: 'Weekly (Sonnet)', usedPercent: 30, resetsAt: null },
    ],
  });
  const s = stateWith([claude]);
  s.providers[0].key = 'claude';
  s.modelProviders = { 'custom:droidproxy:sonnet-5': 'claude', 'custom:droidproxy:opus-5-5': 'claude' };
  assert.deepEqual(
    modelUsage(s, 'custom:droidproxy:sonnet-5', USAGE_NOW)?.windows.map((w) => [w.name, w.leftPercent]),
    [
      ['5-hour', 90],
      ['Weekly (Sonnet)', 70],
    ],
  );
  assert.deepEqual(
    modelUsage(s, 'custom:droidproxy:opus-5-5', USAGE_NOW)?.windows.map((w) => [w.name, w.leftPercent]),
    [
      ['5-hour', 90],
      ['Weekly (Opus)', 0],
    ],
  );
});

test('usage says when it is old, when a reset is due, and when it could not be read', () => {
  const old = modelUsage(stateWith([account('a', { windows: [{ name: '5-hour', usedPercent: 20.4, resetsAt: USAGE_NOW - 1000 }], usageUpdatedAt: USAGE_NOW - 40 * 60_000 })]), SOL, USAGE_NOW)!;
  assert.equal(modelUsageWords(old), 'ChatGPT: 5-hour 80% left (reset due, not yet re-read); read 40 min ago, may be out of date');
  assert.equal(modelUsageWords(modelUsage(stateWith([account('a', { usageError: 'usage endpoint returned 401' })]), SOL, USAGE_NOW)!), "ChatGPT: usage couldn't be read (usage endpoint returned 401)");
  assert.equal(modelUsageWords(modelUsage(stateWith([account('a')]), SOL, USAGE_NOW)!), "ChatGPT: usage couldn't be read (the plan reports no usage)");
});

test('no usage when no account could serve the model', () => {
  assert.equal(modelUsage(stateWith([]), SOL, USAGE_NOW), undefined, 'signed out');
  assert.equal(modelUsage(stateWith([account('a', { expired: true, windows: FULL_PLAN })]), SOL, USAGE_NOW), undefined, 'sign-in expired');
  assert.equal(modelUsage(stateWith([account('a', { windows: FULL_PLAN })], { enabled: false }), SOL, USAGE_NOW), undefined, 'provider switched off');
});

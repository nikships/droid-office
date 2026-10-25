import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareVersions, droidReady, droidUpdateAvailable, emptySetupState, needsWelcome, type SetupState } from '../src/shared/setup.js';
import { availabilityWords, cannotRun, durationWords, emptySubscriptionsState, isSubscriptionModel, modelAvailability } from '../src/shared/subscriptions.js';

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

test('the welcome opens only for an office whose Droid cannot run workers yet', () => {
  assert.equal(needsWelcome(emptySetupState()), false, 'not before the server has looked');
  assert.equal(needsWelcome(ready({ path: null, signedIn: null })), true);
  assert.equal(needsWelcome(ready({ signedIn: false })), true);
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
  assert.equal(availabilityWords({ state: 'exhausted', until: now + (3 * 60 + 10) * 60_000, window: '5-hour' }, now), 'Out of quota (5-hour) for another 3 h 10 min');
  assert.equal(availabilityWords({ state: 'exhausted', until: now - 1000, window: 'Weekly' }, now), 'Out of quota (Weekly)');
  assert.equal(availabilityWords({ state: 'signed-out', provider: 'codex' }, now), 'No ChatGPT account is connected');
  assert.equal(availabilityWords({ state: 'disabled', provider: 'claude' }, now), 'Claude is switched off in Subscriptions');
  assert.equal(availabilityWords({ state: 'proxy-down', installed: false }, now), "DroidProxy isn't installed");
  assert.equal(durationWords(30_000), '1 min');
  assert.equal(durationWords(2 * 3600_000), '2 h');
  assert.equal(durationWords(52 * 3600_000), '2 d 4 h');
});

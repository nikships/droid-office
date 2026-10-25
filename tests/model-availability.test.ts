import assert from 'node:assert/strict';
import test from 'node:test';
import { availabilityOf, canPick, offersSubscriptions, sectionsFor, withAvailability, type PickerModel } from '../src/client/ui/model-search.js';
import { emptySubscriptionsState, type SubscriptionsState } from '../src/shared/subscriptions.js';

const NOW = Date.parse('2026-10-25T12:00:00Z');
const SOL = 'custom:droidproxy:gpt-6.1-sol';
const OPUS = 'custom:droidproxy:claude-opus-5-5';

const model = (id: string, name: string): PickerModel => ({ id, name, scope: 'Yours', group: 'DroidProxy', glyph: true });
const models = [model(SOL, 'GPT 6.1 Sol'), model(OPUS, 'Opus 5.5'), { id: 'claude-opus-5-5', name: 'Opus 5.5', scope: 'Anthropic', group: 'Anthropic' }];

function state(patch: Partial<SubscriptionsState>): SubscriptionsState {
  return { ...emptySubscriptionsState(), proxy: { phase: 'running', version: '1.8.179', latest: null, path: '/Applications/DroidProxy.app', error: null }, ...patch };
}

test('a model that is out of quota is unavailable with its reason, and the picker will not pick it', () => {
  const s = state({ availability: { [SOL]: { state: 'exhausted', until: NOW + 190 * 60_000, window: '5-hour' }, [OPUS]: { state: 'ok' } } });
  const [sol, opus, factory] = withAvailability(models, s, NOW);
  assert.equal(sol.unavailable, true);
  assert.equal(sol.reason, 'Out of quota (5-hour) for another 3 h 10 min');
  assert.equal(canPick(sol), false);
  assert.equal(canPick(opus), true);
  assert.equal(opus.unavailable, undefined);
  assert.equal(factory, models[2], 'a model that is not a subscription model is untouched');
});

test('signed-out, switched-off and not-installed models are refused; a stopped DroidProxy only gets a note', () => {
  const refused = withAvailability(models, state({ availability: { [SOL]: { state: 'signed-out', provider: 'codex' }, [OPUS]: { state: 'disabled', provider: 'claude' } } }), NOW);
  assert.deepEqual(
    refused.map((m) => m.reason),
    ['No ChatGPT account is connected', 'Claude is switched off in Subscriptions', undefined],
  );
  const gone = withAvailability(models, state({ availability: { [SOL]: { state: 'proxy-down', installed: false } } }), NOW);
  assert.equal(gone[0].reason, "DroidProxy isn't installed");
  const stopped = withAvailability(models, state({ availability: { [SOL]: { state: 'proxy-down', installed: true } } }), NOW);
  assert.equal(stopped[0].unavailable, undefined);
  assert.equal(stopped[0].reason, undefined);
  assert.equal(stopped[0].note, "DroidProxy isn't running: the office starts it");
  assert.equal(canPick(stopped[0]), true);
});

test('a model nobody can judge is never refused', () => {
  assert.deepEqual(availabilityOf(SOL, state({}), NOW), {});
  assert.deepEqual(availabilityOf(undefined, state({}), NOW), {});
  assert.deepEqual(availabilityOf('claude-opus-5-5', state({ availability: { 'claude-opus-5-5': { state: 'signed-out', provider: 'claude' } } }), NOW), {}, 'only DroidProxy models are judged');
});

test('a model droid no longer lists stays pickable, since it may be the current choice', () => {
  assert.equal(canPick({ ...models[0], unavailable: true }), true);
  assert.equal(canPick({ ...models[0], unavailable: true, reason: 'Out of quota (5-hour)' }), false);
  assert.equal(canPick(undefined), true);
});

test('a refused model is left out of the recent picks but still searchable', () => {
  const s = state({ availability: { [SOL]: { state: 'exhausted', until: null, window: '5-hour' } } });
  const shown = withAvailability(models, s, NOW);
  const [recent] = sectionsFor(shown, { query: '', scope: '', recents: [SOL, OPUS] });
  assert.deepEqual(
    recent.models.map((m) => m.id),
    [OPUS],
  );
  const [found] = sectionsFor(shown, { query: 'sol', scope: '', recents: [] });
  assert.equal(found.models[0].reason, 'Out of quota (5-hour)');
});

test('the footer offers Subscriptions on a Mac with no account yet', () => {
  assert.equal(offersSubscriptions(emptySubscriptionsState()), false, 'unsupported: nothing to offer');
  assert.equal(offersSubscriptions(state({})), true);
  assert.equal(offersSubscriptions(state({ proxy: { phase: 'missing', version: null, latest: null, path: null, error: null } })), true);
  const account = { id: 'a.json', label: 'a@b.com', expired: false, disabled: false, windows: [] };
  assert.equal(offersSubscriptions(state({ providers: [{ key: 'claude', name: 'Claude', enabled: true, connect: 'browser', accounts: [account] }] })), false);
  assert.equal(offersSubscriptions(state({ providers: [{ key: 'claude', name: 'Claude', enabled: true, connect: 'browser', accounts: [] }] })), true);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { emptyFactoryState } from '../src/shared/factory.js';
import { emptyLimits, FACTORY_CORE_MODELS, factoryLimitsActive, factoryModelAvailability, factoryModelGate, factoryModelTier, factoryOverageWords, factoryWindows, type FactoryLimitsState } from '../src/shared/factory-limits.js';

// Owner's DOFF-930 GET /api/billing/limits capture, without account identifiers or credentials.
export const CAPTURE = {
  usesTokenRateLimitsBilling: true,
  hasActiveSubscription: true,
  limits: {
    standard: {
      fiveHour: { usedPercent: 61, windowEnd: '2026-11-14T06:06:30.724Z', secondsRemaining: 1251 },
      weekly: { usedPercent: 86, windowEnd: '2026-11-14T19:35:51.947Z', secondsRemaining: 49812 },
      monthly: { usedPercent: 56, windowEnd: '2026-12-01T05:59:57.602Z', secondsRemaining: 1469657 },
    },
    core: {
      fiveHour: { usedPercent: 0, windowEnd: null, secondsRemaining: null },
      weekly: { usedPercent: 20, windowEnd: '2026-11-17T03:30:49.318Z', secondsRemaining: 251109 },
      monthly: { usedPercent: 15, windowEnd: '2026-12-10T03:30:49.318Z', secondsRemaining: 2238309 },
    },
  },
  overagePreference: 'droidCore',
  canManageOverage: true,
  extraUsageBalanceCents: 0,
  extraUsageAllowed: true,
} satisfies Omit<FactoryLimitsState, 'fetchedAt' | 'error'>;

const NOW = Date.parse('2026-11-14T05:45:00Z');
function account() {
  const factory = emptyFactoryState();
  factory.connection.connected = true;
  factory.limits = { ...structuredClone(CAPTURE), fetchedAt: NOW, error: null };
  return factory;
}
const standard = { id: 'claude-opus-5-5' };
const core = { id: 'glm-5.3-flash' };

test('limits start unknown; raw windows and null resets remain distinct', () => {
  assert.equal(emptyLimits().usesTokenRateLimitsBilling, null);
  assert.equal(factoryLimitsActive(emptyLimits()), false);
  const factory = account();
  assert.ok(factoryLimitsActive(factory.limits));
  assert.deepEqual(
    factoryWindows(factory.limits, 'core').map((w) => [w.name, w.usedPercent, w.resetsAt]),
    [
      ['5-hour', 0, null],
      ['Weekly', 20, Date.parse(CAPTURE.limits.core.weekly.windowEnd)],
      ['Monthly', 15, Date.parse(CAPTURE.limits.core.monthly.windowEnd)],
    ],
  );
  factory.limits.limits.core!.weekly.windowEnd = null;
  assert.equal(factoryWindows(factory.limits, 'core')[1].resetsAt, NOW + 251109000);
  assert.deepEqual(factoryWindows(emptyLimits(), 'standard'), []);
});

test('the verified catalog, not model name or cost, classifies Core; Router is hosted Standard', () => {
  for (const id of ['glm-5.3-flash', 'kimi-k3', 'qwen3.8-max', 'deepseek-v4.1-flash', 'mistral-large-4', 'minimax-m3', 'inkling', 'nemotron-3-ultra', 'beam-1.0', 'oss-latest-fast']) assert.equal(factoryModelTier({ id }), 'core', id);
  for (const id of ['auto', 'auto-fast', 'gpt-6.1', 'claude-haiku-5-5', 'gemini-3-flash', 'droid-core']) assert.equal(factoryModelTier({ id, displayName: 'Droid Core' }), 'standard', id);
  assert.equal(factoryModelTier({ ...core, custom: true }), undefined);
  assert.equal(factoryModelTier({ id: 'custom:droidproxy:gpt-6.1-sol' }), undefined);
});

test('unknown, disconnected, rejected, failed and Enterprise limits fail open', () => {
  const factory = account();
  factory.limits.limits.standard!.fiveHour.usedPercent = 100;
  factory.connection.connected = false;
  assert.equal(factoryModelAvailability(factory, standard, NOW), undefined);
  factory.connection.connected = true;
  factory.connection.rejected = '401';
  assert.equal(factoryModelAvailability(factory, standard, NOW), undefined);
  delete factory.connection.rejected;
  factory.limits.error = 'Read failed';
  assert.equal(factoryModelAvailability(factory, standard, NOW), undefined);
  factory.limits.error = null;
  factory.limits.usesTokenRateLimitsBilling = false;
  assert.equal(factoryModelAvailability(factory, standard, NOW), undefined);
  factory.limits = emptyLimits();
  assert.equal(factoryModelAvailability(factory, standard, NOW), undefined);
});

test('each Standard window gates at 100%, with the earliest exhausted reset and runnable Core alternatives', () => {
  for (const key of ['fiveHour', 'weekly', 'monthly'] as const) {
    const factory = account();
    factory.limits.limits.standard![key].usedPercent = 99.999;
    assert.equal(factoryModelAvailability(factory, standard, NOW)?.state, 'ok');
    factory.limits.limits.standard![key].usedPercent = 100;
    const availability = factoryModelAvailability(factory, standard, NOW)!;
    assert.equal(availability.state, 'exhausted', key);
    assert.equal(availability.until, Date.parse(factory.limits.limits.standard![key].windowEnd!));
    assert.match(availability.reason, /Droid Core fallback/);
    assert.equal(factoryModelAvailability(factory, core, NOW)?.state, 'ok');
    assert.match(factoryModelGate(factory, standard, [standard, core, { id: 'custom:local' }], NOW)!, /Runnable alternatives: glm-5.3-flash, custom:local/);
  }
  const factory = account();
  factory.limits.limits.standard!.fiveHour.usedPercent = 100;
  factory.limits.limits.standard!.weekly.usedPercent = 103;
  assert.equal(factoryModelAvailability(factory, standard, NOW)?.window, '5-hour');
  const firstReset = Date.parse(CAPTURE.limits.standard.fiveHour.windowEnd);
  assert.equal(factoryModelAvailability(factory, standard, firstReset)?.state, 'exhausted');
  assert.equal(factoryModelAvailability(factory, standard, firstReset + 1)?.window, 'Weekly');
  assert.equal(factoryModelAvailability(factory, standard, Date.parse(CAPTURE.limits.standard.weekly.windowEnd) + 1)?.state, 'ok');
});

test('Extra Usage needs the preference, permission and a positive balance, and does not bypass Core', () => {
  const factory = account();
  factory.limits.limits.standard!.fiveHour.usedPercent = 100;
  factory.limits.overagePreference = 'extraUsage';
  assert.equal(factoryModelAvailability(factory, standard, NOW)?.state, 'exhausted');
  assert.match(factoryOverageWords(factory.limits), /\$0.00/);
  factory.limits.extraUsageBalanceCents = 1;
  assert.equal(factoryModelAvailability(factory, standard, NOW)?.state, 'ok');
  factory.limits.extraUsageAllowed = false;
  assert.equal(factoryModelAvailability(factory, standard, NOW)?.state, 'exhausted');
  factory.limits.extraUsageAllowed = true;
  factory.limits.overagePreference = 'droidCore';
  assert.equal(factoryModelAvailability(factory, standard, NOW)?.state, 'exhausted');
  for (const key of ['fiveHour', 'weekly', 'monthly'] as const) {
    const blocked = account();
    blocked.limits.limits.core![key].usedPercent = 100;
    blocked.limits.extraUsageBalanceCents = 1000;
    blocked.limits.overagePreference = 'extraUsage';
    assert.equal(factoryModelAvailability(blocked, core, NOW)?.state, 'exhausted', key);
  }
});

test('no active subscription blocks only hosted models, and missing Core data is unknown', () => {
  const factory = account();
  factory.limits.hasActiveSubscription = false;
  for (const model of [standard, core, { id: 'auto' }]) assert.equal(factoryModelAvailability(factory, model, NOW)?.state, 'unavailable');
  assert.equal(factoryModelAvailability(factory, { ...standard, custom: true }, NOW), undefined);
  assert.equal(factoryModelAvailability(factory, { id: 'custom:local' }, NOW), undefined);
  factory.limits.hasActiveSubscription = true;
  delete factory.limits.limits.core;
  assert.equal(factoryModelAvailability(factory, core, NOW), undefined);
  assert.equal(factoryModelGate(factory, standard, [], NOW), undefined);
});

test('Android coreModels stays identical to FACTORY_CORE_MODELS and missing ids fail open safely', () => {
  assert.equal(factoryModelTier({ id: undefined as unknown as string }), undefined);
  const kotlin = readFileSync(new URL('../android/app/src/main/java/ai/factory/droidoffice/core/FactoryLimits.kt', import.meta.url), 'utf8');
  const block = kotlin.match(/private val coreModels = setOf\(([\s\S]*?)\)/)?.[1];
  assert.ok(block, 'coreModels set found in FactoryLimits.kt');
  const androidCore = new Set([...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  assert.deepEqual([...androidCore].sort(), [...FACTORY_CORE_MODELS].sort());
});

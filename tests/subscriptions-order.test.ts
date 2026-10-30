import test from 'node:test';
import assert from 'node:assert/strict';
import type { SubscriptionAccount, SubscriptionProvider } from '../src/shared/subscriptions.js';
import { subscriptionsOrder } from '../src/client/ui/subscriptions-order.js';

test('companion subscriptions put active accounts with usage first and preserve order within groups', () => {
  const account = (overrides: Partial<SubscriptionAccount> = {}): SubscriptionAccount => ({
    id: 'account',
    label: 'account',
    expired: false,
    disabled: false,
    windows: [],
    ...overrides,
  });
  const usage = account({ windows: [{ name: 'Weekly', usedPercent: 0, resetsAt: null }] });
  const provider = (key: SubscriptionProvider['key'], enabled: boolean, accounts: SubscriptionAccount[]): SubscriptionProvider => ({
    key,
    name: key,
    enabled,
    connect: 'browser',
    accounts,
  });
  const providers = [
    provider('claude', false, [usage]),
    provider('antigravity', true, [account()]),
    provider('kimi', true, []),
    provider('codex', true, [usage]),
    provider('junie', true, [account({ expired: true, windows: usage.windows })]),
    provider('grok', true, [usage]),
    provider('copilot', true, [account({ disabled: true, windows: usage.windows })]),
    provider('meta', true, [account()]),
  ];
  assert.deepEqual(
    subscriptionsOrder(providers).map((p) => p.key),
    ['codex', 'grok', 'antigravity', 'meta', 'kimi', 'junie', 'copilot', 'claude'],
  );
  assert.equal(providers[0].key, 'claude', 'does not mutate the shared state');
});

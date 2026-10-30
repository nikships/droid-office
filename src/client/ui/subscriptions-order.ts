import type { SubscriptionProvider } from '../../shared/subscriptions';

/** Keep useful, active plans first without changing DroidProxy's order within each group. */
export function subscriptionsOrder(providers: readonly SubscriptionProvider[]): SubscriptionProvider[] {
  const rank = (p: SubscriptionProvider) => {
    if (!p.enabled) return 3;
    const active = p.accounts.filter((a) => !a.disabled && !a.expired);
    if (active.some((a) => a.windows.length > 0)) return 0;
    return active.length ? 1 : 2;
  };
  return [...providers].sort((a, b) => rank(a) - rank(b));
}

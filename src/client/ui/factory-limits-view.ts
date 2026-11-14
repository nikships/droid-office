import type { FactoryState } from '../../shared/factory';
import { factoryLimitsActive, factoryWindows, type FactoryLimitsState, type FactoryOveragePreference } from '../../shared/factory-limits';
import { AIRGAPPED_REASON } from '../../shared/setup';
import { durationWords, type UsageWindow } from '../../shared/subscriptions';
import { h } from './dom';
import { percentLeft, usageTone } from './welcome-steps';

export const FACTORY_TIERS = [
  { key: 'standard', label: 'Standard' },
  { key: 'core', label: 'Droid Core' },
] as const;

export function factoryBalance(s: FactoryLimitsState): string {
  return `$${(s.extraUsageBalanceCents / 100).toFixed(2)}`;
}

/** An elapsed reset is not evidence that Factory refilled a window. */
export function factoryReset(w: UsageWindow, now: number): string {
  if (w.resetsAt === null) return w.usedPercent === 0 ? 'Window not started' : 'Reset time not reported';
  if (w.resetsAt <= now) return 'Reset due · awaiting update';
  return `Resets in ${durationWords(w.resetsAt - now)}`;
}

export function factoryLimitsNote(factory: FactoryState, airgapped = false): string | null {
  const s = factory.limits;
  if (airgapped) return AIRGAPPED_REASON;
  if (!factory.connection.connected) return 'Connect a Factory API key in Settings → Connections to read limits.';
  if (factory.connection.rejected) return 'Factory rejected the office’s key. Check or replace it in Settings → Connections.';
  if (s.error) return `Couldn’t read Factory limits: ${s.error}`;
  if (s.hasActiveSubscription === false) return 'No active Factory subscription. Factory-hosted models are unavailable.';
  if (s.usesTokenRateLimitsBilling === false) return 'Token rate-limit windows do not apply to this Factory organization.';
  if (s.fetchedAt !== null && s.usesTokenRateLimitsBilling !== true) return 'Token rate-limit windows do not apply to this Factory organization.';
  if (s.fetchedAt !== null && !s.limits.standard) return 'Factory did not report Standard token rate-limit windows.';
  if (!factoryLimitsActive(s)) return 'Reading Factory limits…';
  return null;
}

const OVERAGE_LABELS: Record<FactoryOveragePreference, string> = {
  droidCore: 'Droid Core fallback',
  extraUsage: 'Extra Usage',
};

export function factoryLimitsSummary(s: FactoryLimitsState): string {
  const mode = s.overagePreference ? OVERAGE_LABELS[s.overagePreference] : 'Not selected';
  return `Extra Usage ${factoryBalance(s)} · Overage: ${mode}`;
}

function factoryWindowRow(label: string, w: UsageWindow, now: number): HTMLElement {
  const left = percentLeft(w);
  const reset = factoryReset(w, now);
  const bar = h('span.subs-usage-bar', { class: usageTone(w), role: 'meter', 'aria-label': `${label} ${w.name} quota remaining`, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': left }, h('span'));
  bar.style.setProperty('--left', `${left}%`);
  return h('li.stack.tight', {}, h('div.row.between', {}, h('span', {}, w.name), h('span', {}, `${left}% left`)), bar, h('small', { title: w.resetsAt === null ? reset : new Date(w.resetsAt).toLocaleString() }, reset));
}

function factoryTier(key: (typeof FACTORY_TIERS)[number]['key'], label: string, s: FactoryLimitsState, now: number): HTMLElement {
  const windows = factoryWindows(s, key);
  return h(
    'section.stack.tight.factory-limit-tier',
    {},
    h('b', {}, `Factory ${label}`),
    windows.length ? h('ul.factory-limit-windows', {}, ...windows.map((w) => factoryWindowRow(label, w, now))) : h('small', {}, `No ${label} windows reported`),
  );
}

/** Reused in Settings and the native /limits window. No mutations are performed by this renderer. */
export function factoryLimitsView(factory: FactoryState, now: number, airgapped = false): HTMLElement[] {
  const s = factory.limits;
  const note = factoryLimitsNote(factory, airgapped);
  if (airgapped || !factory.connection.connected || factory.connection.rejected) return [h('p.note.info', {}, note)];
  const nodes: HTMLElement[] = [];
  if (note) nodes.push(h('p.note', { class: s.error || s.hasActiveSubscription === false ? 'warn' : 'info' }, note));
  if (!factoryLimitsActive(s)) return nodes;
  nodes.push(h('div.factory-limit-tiers', {}, ...FACTORY_TIERS.map(({ key, label }) => factoryTier(key, label, s, now))), h('p.factory-limit-summary', {}, factoryLimitsSummary(s)));
  if (!s.extraUsageAllowed) nodes.push(h('small', {}, 'Extra Usage is not enabled for this organization.'));
  return nodes;
}

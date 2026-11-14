import type { FactoryState } from './factory.js';

export type FactoryModelTier = 'standard' | 'core';
export type FactoryOveragePreference = 'droidCore' | 'extraUsage';

export interface FactoryLimitWindow {
  usedPercent: number;
  windowEnd: string | null;
  secondsRemaining: number | null;
}

export interface FactoryLimitWindows {
  fiveHour: FactoryLimitWindow;
  weekly: FactoryLimitWindow;
  monthly: FactoryLimitWindow;
}

/** The billing API's raw windows, with the office's read status. Null means not known yet. */
export interface FactoryLimitsState {
  usesTokenRateLimitsBilling: boolean | null;
  hasActiveSubscription: boolean | null;
  limits: { standard?: FactoryLimitWindows; core?: FactoryLimitWindows };
  overagePreference: FactoryOveragePreference | null;
  canManageOverage: boolean;
  extraUsageBalanceCents: number;
  extraUsageAllowed: boolean;
  fetchedAt: number | null;
  error: string | null;
}

export function emptyLimits(): FactoryLimitsState {
  return { usesTokenRateLimitsBilling: null, hasActiveSubscription: null, limits: {}, overagePreference: null, canManageOverage: false, extraUsageBalanceCents: 0, extraUsageAllowed: false, fetchedAt: null, error: null };
}

export function factoryLimitsActive(s: FactoryLimitsState): boolean {
  return s.usesTokenRateLimitsBilling === true && !!s.limits.standard;
}

/** Factory.app 1.11.0 model catalog billingPool=Core, including its OSS aliases. Router is Standard. */
export const FACTORY_CORE_MODELS: ReadonlySet<string> = new Set([
  'glm-4.6',
  'glm-4.7',
  'glm-5',
  'glm-5.1',
  'glm-5.2',
  'glm-5.2-fast',
  'glm-5.3',
  'glm-5.3-flash',
  'kimi-k2.5',
  'kimi-k2.6',
  'kimi-k2.7-code',
  'kimi-k3',
  'kimi-k3.1-pro',
  'qwen3.8-max',
  'deepseek-v4-flash-0731',
  'deepseek-v4.1-flash-1017',
  'deepseek-v4.1-flash',
  'deepseek-v4-pro',
  'minimax-m2.5',
  'minimax-m2.7',
  'minimax-m3',
  'minimax-m3.1-flash',
  'mistral-medium-3.5',
  'mistral-large-4',
  'inkling',
  'nemotron-3-ultra',
  'nemotron-3.5-super',
  'beam-1.0',
  'oss-latest-premium',
  'oss-latest-balanced',
  'oss-latest-fast',
  'glm-5p2-fast',
]);

type Model = { id: string; custom?: boolean; displayName?: string };

export function factoryModelTier(model: Model): FactoryModelTier | undefined {
  if (model.custom || !model.id || model.id.startsWith('custom:')) return undefined;
  return FACTORY_CORE_MODELS.has(model.id) ? 'core' : 'standard';
}

export interface FactoryModelAvailability {
  state: 'ok' | 'exhausted' | 'unavailable';
  tier: FactoryModelTier;
  reason: string;
  overageHint: string;
  until: number | null;
  window: string;
}

export function factoryWindows(s: FactoryLimitsState, tier: FactoryModelTier): { name: string; usedPercent: number; resetsAt: number | null }[] {
  const windows = s.limits[tier];
  if (!windows) return [];
  return (
    [
      ['fiveHour', '5-hour'],
      ['weekly', 'Weekly'],
      ['monthly', 'Monthly'],
    ] as const
  ).map(([key, name]) => {
    const w = windows[key];
    if (w.windowEnd) {
      const end = Date.parse(w.windowEnd);
      if (Number.isFinite(end)) return { name, usedPercent: w.usedPercent, resetsAt: end };
    }
    const resetsAt = s.fetchedAt !== null && w.secondsRemaining !== null ? s.fetchedAt + w.secondsRemaining * 1000 : null;
    return { name, usedPercent: w.usedPercent, resetsAt };
  });
}

export function factoryOverageWords(s: FactoryLimitsState): string {
  const balance = `$${(s.extraUsageBalanceCents / 100).toFixed(2)}`;
  if (s.overagePreference === 'droidCore') return `Droid Core fallback is active; Extra Usage balance ${balance}.`;
  if (s.overagePreference === 'extraUsage') return `Extra Usage ${s.extraUsageAllowed ? 'enabled' : 'not allowed'}, ${balance} remaining.`;
  return `No overage preference selected; Extra Usage balance ${balance}.`;
}

/** Unknown, failed, disconnected and Enterprise reads never deny a hosted model. */
export function factoryModelAvailability(factory: FactoryState, model: Model, now: number): FactoryModelAvailability | undefined {
  const tier = factoryModelTier(model);
  const s = factory.limits;
  if (!tier || !factory.connection.connected || factory.connection.rejected || !s || s.error || s.fetchedAt === null) return undefined;
  const overageHint = factoryOverageWords(s);
  const base = { tier, overageHint, until: null, window: '' };
  if (s.hasActiveSubscription === false) return { ...base, state: 'unavailable', reason: 'Factory has no active subscription. Choose a custom model or renew the Factory subscription.' };
  if (!factoryLimitsActive(s) || !s.limits[tier]) return undefined;
  const exhausted = factoryWindows(s, tier).filter((w) => w.usedPercent >= 100 && (w.resetsAt === null || w.resetsAt > now));
  if (!exhausted.length) return { ...base, state: 'ok', reason: '' };
  if (tier === 'standard' && s.overagePreference === 'extraUsage' && s.extraUsageAllowed && s.extraUsageBalanceCents > 0) return { ...base, state: 'ok', reason: 'Factory Standard limits reached; using Extra Usage.' };
  exhausted.sort((a, b) => (a.resetsAt ?? Infinity) - (b.resetsAt ?? Infinity));
  const first = exhausted[0];
  const label = tier === 'core' ? 'Droid Core' : 'Standard';
  const reset = first.resetsAt === null ? '' : ` Recheck in ${Math.max(1, Math.ceil((first.resetsAt - now) / 60_000))}m.`;
  return { ...base, state: 'exhausted', window: first.name, until: first.resetsAt, reason: `Factory ${label} ${exhausted.map((w) => w.name).join(', ')} limit reached.${reset} ${overageHint}` };
}

/** A spawn refusal that offers only alternatives the same Factory state allows. */
export function factoryModelGate(factory: FactoryState, model: Model, alternatives: readonly Model[], now: number): string | undefined {
  const availability = factoryModelAvailability(factory, model, now);
  if (!availability || availability.state === 'ok') return undefined;
  const runnable = alternatives
    .filter((m) => {
      if (m.id === model.id) return false;
      const alt = factoryModelAvailability(factory, m, now);
      return !alt || alt.state === 'ok';
    })
    .slice(0, 5);
  return `${availability.reason}${runnable.length ? ` Runnable alternatives: ${runnable.map((m) => m.id).join(', ')}.` : ' Choose a custom model or check Factory limits in Settings → Connections.'}`;
}

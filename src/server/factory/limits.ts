import { emptyLimits, type FactoryLimitsState, type FactoryLimitWindows } from '../../shared/factory-limits.js';
import { AIRGAPPED_REASON } from '../../shared/setup.js';
import type { FactoryApi } from './api.js';
import { HttpError, SliceFeature, badRequest, type FactoryRoute, type FeatureHost } from './feature.js';

export const LIMITS_RECHECK_MS = 10_000;

const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Factory returned unreadable billing limits.');
  return v as Record<string, unknown>;
};

function windowsOf(v: unknown): FactoryLimitWindows | undefined {
  if (v === undefined || v === null) return undefined;
  const raw = object(v);
  const window = (key: string) => {
    const w = object(raw[key]);
    if (
      typeof w.usedPercent !== 'number' ||
      !Number.isFinite(w.usedPercent) ||
      w.usedPercent < 0 ||
      !(w.windowEnd === null || (typeof w.windowEnd === 'string' && Number.isFinite(Date.parse(w.windowEnd)))) ||
      !(w.secondsRemaining === null || (typeof w.secondsRemaining === 'number' && Number.isFinite(w.secondsRemaining) && w.secondsRemaining >= 0))
    )
      throw new Error('Factory returned unreadable billing windows.');
    return { usedPercent: w.usedPercent, windowEnd: w.windowEnd, secondsRemaining: w.secondsRemaining };
  };
  return { fiveHour: window('fiveHour'), weekly: window('weekly'), monthly: window('monthly') };
}

/** Preserve the API's window names and nulls, without mistaking malformed usage for zero. */
export function limitsOf(v: unknown, now: number): FactoryLimitsState {
  const raw = object(v);
  if (typeof raw.usesTokenRateLimitsBilling !== 'boolean' || typeof raw.hasActiveSubscription !== 'boolean') throw new Error('Factory returned unreadable billing limits.');
  const limits = raw.limits === undefined || raw.limits === null ? {} : object(raw.limits);
  const standard = windowsOf(limits.standard);
  const core = windowsOf(limits.core);
  const preference = raw.overagePreference;
  if (preference !== undefined && preference !== null && preference !== 'droidCore' && preference !== 'extraUsage') throw new Error('Factory returned an unknown overage preference.');
  return {
    usesTokenRateLimitsBilling: raw.usesTokenRateLimitsBilling,
    hasActiveSubscription: raw.hasActiveSubscription,
    limits: { ...(standard ? { standard } : {}), ...(core ? { core } : {}) },
    overagePreference: preference ?? null,
    canManageOverage: raw.canManageOverage === true,
    extraUsageBalanceCents: typeof raw.extraUsageBalanceCents === 'number' && Number.isFinite(raw.extraUsageBalanceCents) ? Math.max(0, raw.extraUsageBalanceCents) : 0,
    extraUsageAllowed: raw.extraUsageAllowed === true,
    fetchedAt: now,
    error: null,
  };
}

export interface LimitsOptions {
  hostedWorkers?: () => boolean;
  paused?: () => boolean;
  now?: () => number;
}

export class LimitsFeature extends SliceFeature<'limits'> {
  readonly interval = 60_000;
  readonly fastInterval = 20_000;
  private generation = 0;

  readonly routes: readonly FactoryRoute[] = [
    {
      method: 'POST',
      path: '/overage',
      handle: async ({ api, json }) => {
        if (this.opts.paused?.()) throw new HttpError(403, AIRGAPPED_REASON);
        if (this.slice.error || this.slice.fetchedAt === null || !this.slice.canManageOverage) throw new HttpError(403, 'Only a Factory organization owner or manager can change overage preferences.');
        const body = await json<{ overagePreference?: unknown } | null>();
        const preference = body?.overagePreference;
        if (preference !== 'droidCore' && preference !== 'extraUsage') throw badRequest('overagePreference must be droidCore or extraUsage');
        await api.setOveragePreference(preference);
        this.host.pollSoon();
        return { ok: true };
      },
    },
  ];

  constructor(
    host: FeatureHost,
    private opts: LimitsOptions = {},
  ) {
    super('limits', host, emptyLimits);
  }

  busy(): boolean {
    return this.opts.hostedWorkers?.() ?? false;
  }

  async poll(api: FactoryApi): Promise<void> {
    const generation = this.generation;
    const raw = await api.limits();
    if (generation !== this.generation || this.opts.paused?.()) return;
    this.set(limitsOf(raw, (this.opts.now ?? Date.now)()));
  }

  override reset() {
    this.generation++;
    super.reset();
  }
}

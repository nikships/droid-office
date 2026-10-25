import {
  SUBSCRIPTION_MODEL_PREFIX,
  availabilityWords,
  isSubscriptionProvider,
  providerName,
  type ModelAvailability,
  type SubscriptionAccount,
  type SubscriptionConnectKind,
  type SubscriptionProvider,
  type UsageWindow,
} from '../../shared/subscriptions.js';
import type { RawConnecting, RawModels, RawStatus, RawUsage } from './control.js';

/** What DroidProxy's answers say, turned into the office's types (docs/subscriptions.md). Pure. */

type UsageAccount = NonNullable<RawUsage['accounts']>[number];

const time = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
};

const clampPercent = (n: unknown): number | undefined => (typeof n === 'number' && Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : undefined);

export function usageWindows(u: UsageAccount | undefined): UsageWindow[] {
  const out: UsageWindow[] = [];
  for (const w of u?.windows ?? []) {
    if (!w || typeof w.name !== 'string') continue;
    const used = clampPercent(w.used_percent) ?? (clampPercent(w.remaining_percent) !== undefined ? 100 - (clampPercent(w.remaining_percent) as number) : undefined);
    if (used === undefined) continue;
    out.push({ name: w.name, usedPercent: used, resetsAt: time(w.resets_at) });
  }
  return out;
}

/** The usage entry of one account: by DroidProxy's id (its auth file), else by the email it shows. */
function usageOf(usage: RawUsage | undefined, provider: string, id: string, label: string): UsageAccount | undefined {
  const mine = (usage?.accounts ?? []).filter((a) => a?.provider === provider);
  return mine.find((a) => a.id === id) ?? mine.find((a) => !!a.account && !!label && a.account.toLowerCase() === label.toLowerCase());
}

function connecting(c: RawConnecting | null | undefined, now: number): SubscriptionProvider['connecting'] {
  if (!c) return undefined;
  return {
    since: time(c.started_at) ?? now,
    ...(c.user_code ? { code: c.user_code } : {}),
    ...(c.verification_uri ? { url: c.verification_uri } : {}),
    ...(c.error ? { error: c.error } : {}),
  };
}

const CONNECT_KINDS: readonly string[] = ['browser', 'device', 'app'];

/** /status's providers, with each account's windows from /droidproxy/usage. */
export function mapProviders(status: RawStatus, usage: RawUsage | undefined, now: number): SubscriptionProvider[] {
  const out: SubscriptionProvider[] = [];
  for (const p of status.providers ?? []) {
    if (!p || !isSubscriptionProvider(p.key)) continue;
    const accounts: SubscriptionAccount[] = [];
    for (const a of p.accounts ?? []) {
      if (!a || typeof a.id !== 'string') continue;
      const label = typeof a.label === 'string' && a.label ? a.label : a.id;
      const u = usageOf(usage, p.key, a.id, label);
      accounts.push({ id: a.id, label, expired: a.expired === true, disabled: a.disabled === true, windows: usageWindows(u), ...(u?.error ? { usageError: u.error } : {}) });
    }
    const c = connecting(p.connecting, now);
    out.push({
      key: p.key,
      name: typeof p.name === 'string' && p.name ? p.name : p.key,
      enabled: p.enabled !== false,
      connect: (CONNECT_KINDS.includes(String(p.connect)) ? p.connect : 'app') as SubscriptionConnectKind,
      accounts,
      ...(c ? { connecting: c } : {}),
    });
  }
  return out;
}

/**
 * An older DroidProxy has no /status, but may serve /droidproxy/usage: its accounts, grouped by
 * provider, so the owner still sees what is left. They can only be connected in DroidProxy's own
 * window (`connect: 'app'`) until it is updated.
 */
export function providersFromUsage(usage: RawUsage | undefined): SubscriptionProvider[] {
  const by = new Map<string, SubscriptionProvider>();
  for (const a of usage?.accounts ?? []) {
    if (!a || !isSubscriptionProvider(a.provider)) continue;
    let p = by.get(a.provider);
    if (!p) {
      p = { key: a.provider, name: providerName(a.provider), enabled: true, connect: 'app', accounts: [] };
      by.set(a.provider, p);
    }
    const id = a.id ?? a.account ?? `${a.provider}-${p.accounts.length + 1}`;
    p.accounts.push({ id, label: a.account || id, expired: false, disabled: false, windows: usageWindows(a), ...(a.error ? { usageError: a.error } : {}) });
  }
  return [...by.values()];
}

/** /models turned into availability by model id. "unknown" leaves a model out: it is never refused. */
export function mapAvailability(models: RawModels): Record<string, ModelAvailability> {
  const out: Record<string, ModelAvailability> = {};
  for (const m of models.models ?? []) {
    if (!m || typeof m.id !== 'string' || !m.id.startsWith(SUBSCRIPTION_MODEL_PREFIX)) continue;
    const a = m.availability;
    if (!a || typeof a !== 'object') continue;
    switch (a.state) {
      case 'ok':
        out[m.id] = { state: 'ok' };
        break;
      case 'exhausted':
        out[m.id] = { state: 'exhausted', until: time(a.until), window: typeof a.window === 'string' && a.window ? a.window : 'usage', ...(a.account ? { account: a.account } : {}) };
        break;
      case 'signed-out':
      case 'disabled':
        if (isSubscriptionProvider(m.provider)) out[m.id] = { state: a.state, provider: m.provider };
        break;
    }
  }
  return out;
}

/** What each of DroidProxy's models is called, without Droid's "DroidProxy: " prefix. */
export function modelNames(models: RawModels | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of models?.models ?? []) if (m && typeof m.id === 'string' && typeof m.name === 'string' && m.name) out[m.id] = stripPrefix(m.name);
  return out;
}

export function stripPrefix(name: string): string {
  return name.replace(/^DroidProxy:\s*/i, '');
}

/** What a subscription model is called when nobody has named it: its id without the prefix. */
export function fallbackName(id: string): string {
  return id.startsWith(SUBSCRIPTION_MODEL_PREFIX) ? id.slice(SUBSCRIPTION_MODEL_PREFIX.length) : id;
}

/** Why a model can't run, after a colon: lower case unless it starts with a name. */
export function reasonWords(a: ModelAvailability, now: number): string {
  const words = availabilityWords(a, now);
  return a.state === 'exhausted' || a.state === 'signed-out' ? words.charAt(0).toLowerCase() + words.slice(1) : words;
}

/** The refusal of a hire on a model that can't run: "Can't hire on GPT 6.1 Sol: out of quota, back in 3 h 10 min (5-hour). Pick another model." */
export function hireRefusal(name: string, a: ModelAvailability, now: number): string {
  return `Can't hire on ${name}: ${reasonWords(a, now)}.`;
}

/** A provider has a signed-in account requests can use. */
export function usable(p: SubscriptionProvider | undefined): boolean {
  return !!p?.accounts.some((a) => !a.expired && !a.disabled);
}

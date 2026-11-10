/**
 * Subscriptions: the Claude, ChatGPT and other plans the owner already pays for, which workers run
 * on through DroidProxy, a menu-bar app on the office's Mac (docs/subscriptions.md). These types
 * are the office's view of DroidProxy's control API; the server keeps them current and every
 * client reads them from the `subscriptions` message.
 */

/** DroidProxy's providers, by its own keys (DroidProxyModelCatalog.providerKey). */
export type SubscriptionProviderKey = 'claude' | 'codex' | 'antigravity' | 'kimi' | 'junie' | 'grok' | 'copilot' | 'meta';

export const SUBSCRIPTION_PROVIDERS: readonly SubscriptionProviderKey[] = ['claude', 'codex', 'antigravity', 'kimi', 'junie', 'grok', 'copilot', 'meta'];

export function isSubscriptionProvider(v: unknown): v is SubscriptionProviderKey {
  return typeof v === 'string' && (SUBSCRIPTION_PROVIDERS as readonly string[]).includes(v);
}

/** Every model DroidProxy puts in Droid's settings has an id with this prefix. */
export const SUBSCRIPTION_MODEL_PREFIX = 'custom:droidproxy:';

export function isSubscriptionModel(id: string | undefined): boolean {
  return !!id && id.startsWith(SUBSCRIPTION_MODEL_PREFIX);
}

/** One usage window of an account ("5-hour", "Weekly", "Weekly (Opus)"), from DroidProxy's usage endpoint. */
export interface UsageWindow {
  name: string;
  /** 0..100. */
  usedPercent: number;
  /** When it resets, ms since the epoch; null when the provider doesn't say. */
  resetsAt: number | null;
}

/** One signed-in account of a provider. */
export interface SubscriptionAccount {
  /** DroidProxy's id for it (its auth file name). */
  id: string;
  /** The email or name it shows. */
  label: string;
  /** Its sign-in ran out: it needs connecting again. */
  expired: boolean;
  /** Turned off in DroidProxy: requests skip it. */
  disabled: boolean;
  /** Its usage windows; empty when the provider has none or they couldn't be read. */
  windows: UsageWindow[];
  /** When DroidProxy sampled this account's usage, not when its control status was checked. */
  usageUpdatedAt?: number;
  /** Why its usage couldn't be read. */
  usageError?: string;
}

/** How connecting a provider works: a browser sign-in, a device code, or only in DroidProxy's own window (an API key, say). */
export type SubscriptionConnectKind = 'browser' | 'device' | 'app';

export interface SubscriptionProvider {
  key: SubscriptionProviderKey;
  /** As DroidProxy names it ("Claude", "Codex"). */
  name: string;
  /** Its models are served (DroidProxy's provider switch). */
  enabled: boolean;
  connect: SubscriptionConnectKind;
  accounts: SubscriptionAccount[];
  /** A connect in progress: since when, the device code and page when the provider uses one, or why it failed. */
  connecting?: { since: number; code?: string; url?: string; error?: string };
}

/**
 * Where DroidProxy is on the office's machine.
 * - unsupported: not a Mac with Apple silicon (DroidProxy is a macOS arm64 app)
 * - missing: not installed
 * - installing: the office is downloading, checking and installing it
 * - stopped: installed but not running
 * - starting: the office opened it and is waiting for it to answer
 * - outdated: running, but too old for the office to drive (no control API): it needs an update
 * - running: answering on its control API
 */
export type ProxyPhase = 'unsupported' | 'missing' | 'installing' | 'stopped' | 'starting' | 'outdated' | 'running';

export interface ProxyState {
  phase: ProxyPhase;
  /** The installed version, when there is one. */
  version: string | null;
  /** The newest release, once the office has looked. */
  latest: string | null;
  /** Where the app is installed. */
  path: string | null;
  /** 0..1 while downloading. */
  progress?: number;
  /** Why the last install, start or action failed, in words for the owner. */
  error: string | null;
}

/**
 * Whether a subscription model can run right now.
 * - ok: an account has quota left
 * - exhausted: every account is out of quota in a window that covers this model, until `until`
 * - signed-out: no usable account for its provider
 * - disabled: its provider is switched off in DroidProxy
 * - proxy-down: DroidProxy isn't answering; `installed` false means it isn't on this Mac at all
 */
export type ModelAvailability =
  | { state: 'ok' }
  | { state: 'exhausted'; until: number | null; window: string; account?: string }
  | { state: 'signed-out'; provider: SubscriptionProviderKey }
  | { state: 'disabled'; provider: SubscriptionProviderKey }
  | { state: 'proxy-down'; installed: boolean };

export interface SubscriptionsState {
  proxy: ProxyState;
  /** Every provider DroidProxy has, in its order. Empty until it answers. */
  providers: SubscriptionProvider[];
  /** DroidProxy's models in Droid's settings: how many are there, of how many it serves; `stale` when they differ. Null until it answers. */
  models: { installed: number; available: number; stale: boolean } | null;
  /**
   * Whether each subscription model can run now, by model id. A model not here is unknown and is
   * never refused: a model that isn't a subscription model, or one DroidProxy couldn't judge.
   */
  availability: Record<string, ModelAvailability>;
  /**
   * The provider that serves each of DroidProxy's models, by model id, in DroidProxy's order (from
   * `/models`). The welcome picks a just-connected plan's first model with it.
   */
  modelProviders?: Record<string, SubscriptionProviderKey>;
  /** When DroidProxy last answered, ms since the epoch. */
  checkedAt: number | null;
}

export function emptySubscriptionsState(): SubscriptionsState {
  return { proxy: { phase: 'unsupported', version: null, latest: null, path: null, error: null }, providers: [], models: null, availability: {}, checkedAt: null };
}

/** What the office knows about whether `model` can run; undefined when it isn't a subscription model or nobody can tell. */
export function modelAvailability(s: SubscriptionsState, model: string | undefined): ModelAvailability | undefined {
  if (!model || !isSubscriptionModel(model)) return undefined;
  return s.availability[model];
}

/**
 * A worker on this model would fail at once, so nobody may hire one on it: out of quota, nobody
 * signed in, switched off, or DroidProxy isn't on this Mac. A stopped DroidProxy doesn't count:
 * the office starts it.
 */
export function cannotRun(a: ModelAvailability | undefined): boolean {
  if (!a) return false;
  return a.state === 'exhausted' || a.state === 'signed-out' || a.state === 'disabled' || (a.state === 'proxy-down' && !a.installed);
}

const PROVIDER_NAMES: Record<SubscriptionProviderKey, string> = {
  claude: 'Claude',
  codex: 'ChatGPT',
  antigravity: 'Antigravity',
  kimi: 'Kimi',
  junie: 'Junie',
  grok: 'Grok',
  copilot: 'GitHub Copilot',
  meta: 'Meta',
};

/** A provider as the owner knows it: ChatGPT, not Codex. */
export function providerName(key: SubscriptionProviderKey): string {
  return PROVIDER_NAMES[key];
}

/** "3 h 10 min", "45 min", "2 d 4 h": how long until `at`. */
export function durationWords(ms: number): string {
  const min = Math.max(1, Math.ceil(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

/** Usage sampled longer ago than this is shown with its age: DroidProxy reads it every few minutes. */
export const USAGE_STALE_MS = 10 * 60_000;

export interface ModelUsageWindow {
  name: string;
  /** 0..100, whole percent. */
  leftPercent: number;
  /** When it resets, ms since the epoch; null when the provider doesn't say. */
  resetsAt: number | null;
}

/**
 * What a subscription model's plan has left, for whoever picks a model (`team_models`).
 * - `accounts`: the provider's signed-in, switched-on accounts, which requests are served from
 * - `windows`: the account with the most left, since a request runs while any account has quota
 *   (the same rule that marks a model exhausted); empty when no account's usage could be read
 * - `updatedAt`: when DroidProxy sampled that account
 * - `unreadable`: why there are no windows
 * - `at`: when this was worked out; resets and ages are measured from it
 */
export interface ModelUsage {
  provider: SubscriptionProviderKey;
  accounts: number;
  windows: ModelUsageWindow[];
  updatedAt?: number;
  unreadable?: string;
  at: number;
}

const leftPercent = (w: UsageWindow): number => Math.max(0, Math.min(100, Math.round(100 - w.usedPercent)));

/** A window named for a model family ("Weekly (Opus)", "Weekly (Sonnet)") covers only that family's models, as DroidProxy judges availability. */
function covers(window: UsageWindow, model: string): boolean {
  const family = /\((opus|sonnet)\)\s*$/i.exec(window.name)?.[1];
  return !family || model.toLowerCase().includes(family.toLowerCase());
}

/**
 * The usage of the plan that serves `model`: the windows that cover it. Undefined when it isn't a
 * subscription model, nobody can tell which provider serves it, or no account could serve it
 * (availability says why).
 */
export function modelUsage(s: SubscriptionsState, model: string | undefined, now: number): ModelUsage | undefined {
  if (!model || !isSubscriptionModel(model)) return undefined;
  const key = s.modelProviders?.[model];
  const provider = key ? s.providers.find((p) => p.key === key) : undefined;
  if (!key || !provider?.enabled) return undefined;
  const live = provider.accounts.filter((a) => !a.expired && !a.disabled);
  if (!live.length) return undefined;
  const windowsOf = (a: SubscriptionAccount) => a.windows.filter((w) => covers(w, model));
  const readable = live.filter((a) => windowsOf(a).length);
  if (!readable.length) return { provider: key, accounts: live.length, windows: [], unreadable: live.find((a) => a.usageError)?.usageError ?? 'the plan reports no usage', at: now };
  const headroom = (a: SubscriptionAccount) => Math.min(...windowsOf(a).map(leftPercent));
  const best = readable.reduce((b, a) => (headroom(a) > headroom(b) ? a : b));
  return {
    provider: key,
    accounts: live.length,
    windows: windowsOf(best).map((w) => ({ name: w.name, leftPercent: leftPercent(w), resetsAt: w.resetsAt })),
    ...(best.usageUpdatedAt !== undefined ? { updatedAt: best.usageUpdatedAt } : {}),
    at: now,
  };
}

/** "ChatGPT: 5-hour 100% left (resets in 4 h 56 min), Weekly 61% left (resets in 2 d 9 h)". */
export function modelUsageWords(u: ModelUsage): string {
  const name = providerName(u.provider);
  if (!u.windows.length) return `${name}: usage couldn't be read (${u.unreadable ?? 'no usage reported'})`;
  const parts = u.windows.map((w) => {
    const reset = w.resetsAt === null ? '' : w.resetsAt > u.at ? ` (resets in ${durationWords(w.resetsAt - u.at)})` : ' (reset due, not yet re-read)';
    return `${w.name} ${w.leftPercent}% left${reset}`;
  });
  const stale = u.updatedAt !== undefined && u.at - u.updatedAt > USAGE_STALE_MS ? `; read ${durationWords(u.at - u.updatedAt)} ago, may be out of date` : '';
  return `${name}${u.accounts > 1 ? `, best of ${u.accounts} accounts` : ''}: ${parts.join(', ')}${stale}`;
}

/**
 * Why a model can't run, in one line for a picker, a refusal or `team_models`; '' when
 * it can. `now` is ms since the epoch.
 */
export function availabilityWords(a: ModelAvailability | undefined, now: number): string {
  if (!a) return '';
  switch (a.state) {
    case 'ok':
      return '';
    case 'exhausted': {
      // The wait comes before the window's name, so a narrow picker row that cuts the line keeps it.
      if (a.until !== null && a.until > now) return `Out of quota, back in ${durationWords(a.until - now)} (${a.window})`;
      return `Out of quota (${a.window})`;
    }
    case 'signed-out':
      return `No ${providerName(a.provider)} account is connected`;
    case 'disabled':
      return `${providerName(a.provider)} is switched off in Subscriptions`;
    case 'proxy-down':
      return a.installed ? "DroidProxy isn't running: the office starts it" : "DroidProxy isn't installed";
  }
}

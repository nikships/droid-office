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

/**
 * Why a model can't run, in one line for a picker, a refusal or `office-workers models`; '' when
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

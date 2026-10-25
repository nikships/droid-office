import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ClientMsg } from '../../shared/protocol.js';
import {
  cannotRun,
  emptySubscriptionsState,
  isSubscriptionModel,
  isSubscriptionProvider,
  modelAvailability,
  providerName,
  type ModelAvailability,
  type ProxyState,
  type SubscriptionProviderKey,
  type SubscriptionsState,
} from '../../shared/subscriptions.js';
import { ControlError, controlClient, type RawProvider, type RawStatus, type RawUsage } from './control.js';
import { fallbackName, hireRefusal, mapAvailability, mapProviders, modelNames, providersFromUsage, stripPrefix } from './map.js';
import { APP_NAME, DROIDPROXY_BUNDLE_ID, InstallError, installProxy, latestRelease, readBundle, runCommand, type AppDirs, type Runner } from './proxy-install.js';

/** The subscriptions.* messages a client sends (see protocol.ts). */
export type SubscriptionsMsg = Extract<
  ClientMsg,
  { t: 'subscriptions.proxy' | 'subscriptions.connect' | 'subscriptions.connectCancel' | 'subscriptions.disconnect' | 'subscriptions.provider' | 'subscriptions.models' | 'subscriptions.refresh' }
>;

export interface SubscriptionsTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SubscriptionsOptions {
  /** The office's .droid-office. */
  dataDir: string;
  /** Subscriptions changed: to everyone. */
  broadcast(state: SubscriptionsState): void;
  toast(text: string, level?: 'info' | 'warn' | 'error'): void;
  /** DroidProxy rewrote its models in Droid's settings: the office reads Droid's model list again. */
  modelsChanged(): void;
  /** For tests: the network (GitHub and DroidProxy). */
  fetchImpl?: typeof fetch;
  /** For tests: the home folder with .droidproxy/control.json and .factory/settings.json. */
  home?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  /** For tests: open, codesign, ditto, osascript, spctl and plutil. */
  run?: Runner;
  /** For tests: where DroidProxy is looked for and installed. */
  appDirs?: AppDirs;
  /** For tests: where a download is unpacked. */
  tmp?: string;
  now?: () => number;
  timers?: SubscriptionsTimers;
}

export interface Subscriptions {
  state(): SubscriptionsState;
  /** Handles a subscriptions.* message from `who`. */
  message(who: string, msg: SubscriptionsMsg): void;
  /** Whether `model` can run now, as last known; undefined when it isn't a subscription model or nobody can tell. */
  availability(model: string | undefined): ModelAvailability | undefined;
  /**
   * Why a worker on `model` can't start now, in words for whoever hired it; undefined when it can,
   * or when nobody can tell. Synchronous, from the last known state. A stopped DroidProxy doesn't
   * refuse the hire: this starts it.
   */
  gate(model: string | undefined): string | undefined;
  stop(): void;
}

const POLL_RUNNING_MS = 60_000;
const POLL_FAST_MS = 2000;
const POLL_DOWN_MS = 30_000;
const RELEASE_EVERY_MS = 6 * 60 * 60_000;
/** Availability judged longer ago than this is unknown: nobody is refused on it. */
export const STALE_MS = 5 * 60_000;
/** How long DroidProxy gets to answer after the office opens it. */
const START_WAIT_MS = 30_000;
/** The office puts DroidProxy's models into Droid by itself at most this often, when /status says they're stale. */
const AUTO_MODELS_EVERY_MS = 10 * 60_000;

const message = (err: unknown) => (err instanceof ControlError || err instanceof InstallError ? err.message : String((err as Error)?.message ?? err));

/** The DroidProxy models in Droid's settings, by id, with the names Droid shows. */
async function settingsModels(home: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const raw = JSON.parse(await readFile(path.join(home, '.factory', 'settings.json'), 'utf8')) as { customModels?: unknown };
    for (const m of Array.isArray(raw.customModels) ? raw.customModels : []) {
      const id = (m as { id?: unknown })?.id;
      const name = (m as { displayName?: unknown })?.displayName;
      if (typeof id === 'string' && isSubscriptionModel(id)) out.set(id, typeof name === 'string' && name ? stripPrefix(name) : fallbackName(id));
    }
  } catch {
    // no settings, or not JSON: no DroidProxy models
  }
  return out;
}

/**
 * DroidProxy and the subscriptions it serves (docs/subscriptions.md). server.ts calls only this.
 */
export function mountSubscriptions(opts: SubscriptionsOptions): Subscriptions {
  const now = opts.now ?? Date.now;
  const timers: SubscriptionsTimers = opts.timers ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) };
  const home = opts.home ?? homedir();
  const run = opts.run ?? runCommand;
  const dirs: AppDirs = opts.appDirs ?? { system: '/Applications', user: path.join(home, 'Applications') };
  const control = controlClient({ home, fetchImpl: opts.fetchImpl });
  const supported = (opts.platform ?? process.platform) === 'darwin' && (opts.arch ?? process.arch) === 'arm64';

  const state: SubscriptionsState = emptySubscriptionsState();
  if (supported) state.proxy = { phase: 'missing', version: null, latest: null, path: null, error: null };
  /** When `state.availability` was last judged; older than STALE_MS counts as unknown. */
  let judgedAt = 0;
  /** What each subscription model is called, for refusals. */
  let names: Record<string, string> = {};
  /** The models DroidProxy served when it last answered. */
  let served: string[] = [];
  let lastStatus: RawStatus | undefined;
  let lastUsage: RawUsage | undefined;
  /** The error on the proxy came from looking, not from something the owner asked for, so the next good look clears it. */
  let errorFromLook = false;
  let startingSince: number | null = null;
  let lastStartAt = Number.NEGATIVE_INFINITY;
  let installing: Promise<string | undefined> | null = null;
  let applying: Promise<void> | null = null;
  let autoAppliedAt = Number.NEGATIVE_INFINITY;
  const connects = new Set<SubscriptionProviderKey>();
  let inflight: Promise<void> | null = null;
  let pollTimer: unknown;
  let releaseTimer: unknown;
  let stopped = false;

  const sleep = (ms: number) => new Promise<void>((r) => timers.setTimeout(r, ms));
  const fresh = () => now() - judgedAt <= STALE_MS;
  const view = (): SubscriptionsState => (fresh() ? state : { ...state, availability: {} });
  const publish = () => {
    if (!stopped) opts.broadcast(view());
  };
  const setProxy = (patch: Partial<ProxyState>) => {
    const next: ProxyState = { ...state.proxy, ...patch };
    if (patch.progress === undefined && 'progress' in patch) delete next.progress;
    state.proxy = next;
  };
  const setAvailability = (a: Record<string, ModelAvailability>) => {
    state.availability = a;
    judgedAt = now();
  };
  const fail = (text: string, level: 'warn' | 'error' = 'error') => {
    setProxy({ error: text });
    errorFromLook = false;
    publish();
    opts.toast(text, level);
  };

  /** The installed DroidProxy: /Applications first, then ~/Applications. */
  const findApp = async (): Promise<{ path: string; version: string | null } | undefined> => {
    for (const dir of [dirs.system, dirs.user]) {
      const p = path.join(dir, APP_NAME);
      const b = await readBundle(run, p);
      if (b?.id === DROIDPROXY_BUNDLE_ID) return { path: p, version: b.version };
    }
    return undefined;
  };

  const down = (ids: Iterable<string>, installed: boolean) => Object.fromEntries([...new Set(ids)].map((id) => [id, { state: 'proxy-down', installed } as ModelAvailability]));

  const lookOnce = async () => {
    const inSettings = await settingsModels(home);
    names = { ...Object.fromEntries(inSettings), ...names };
    const app = await findApp();
    if (!app) {
      setProxy({ phase: installing ? 'installing' : 'missing', version: null, path: null });
      state.providers = [];
      state.models = null;
      setAvailability(down(inSettings.keys(), false));
      return;
    }
    setProxy({ path: app.path, version: app.version });
    const [status, models, usage] = await Promise.allSettled([control.status(), control.models(), control.usage()]);
    if (usage.status === 'fulfilled') lastUsage = usage.value;
    const keep = (phase: ProxyState['phase']) => (installing ? 'installing' : phase);
    if (status.status === 'fulfilled') {
      const prev = lastStatus;
      lastStatus = status.value;
      startingSince = null;
      setProxy({ phase: keep('running'), ...(errorFromLook ? { error: null } : {}) });
      errorFromLook = false;
      state.providers = mapProviders(status.value, usage.status === 'fulfilled' ? usage.value : lastUsage, now());
      const f = status.value.factory;
      state.models = f ? { installed: Number(f.installed) || 0, available: Number(f.available) || 0, stale: f.stale === true } : null;
      if (models.status === 'fulfilled') {
        setAvailability(mapAvailability(models.value));
        names = { ...names, ...modelNames(models.value) };
        served = (models.value.models ?? []).map((m) => m?.id).filter((id): id is string => typeof id === 'string');
      }
      state.checkedAt = now();
      maybeApplyModels(prev, status.value);
      return;
    }
    const err = status.reason as ControlError;
    const portAnswered = usage.status === 'fulfilled' || (usage.reason instanceof ControlError && usage.reason.kind !== 'refused' && usage.reason.kind !== 'timeout');
    const notRunning = err?.kind === 'refused' || ((err?.kind === 'no-file' || err?.kind === 'no-api') && !portAnswered);
    if (notRunning) {
      const waiting = startingSince !== null && now() - startingSince < START_WAIT_MS;
      if (startingSince !== null && !waiting) {
        startingSince = null;
        setProxy({ error: "DroidProxy didn't start: open it from Applications to see why" });
        errorFromLook = true;
      }
      setProxy({ phase: keep(waiting ? 'starting' : 'stopped') });
      setAvailability(down([...served, ...inSettings.keys()], true));
      return;
    }
    if (err?.kind === 'no-file' || err?.kind === 'no-api') {
      if (startingSince !== null && now() - startingSince < START_WAIT_MS && err.kind === 'no-file') {
        setProxy({ phase: keep('starting') });
        return;
      }
      startingSince = null;
      // An older DroidProxy: running, but nobody can tell whether its models can run.
      lastStatus = undefined;
      setProxy({ phase: keep('outdated'), ...(errorFromLook ? { error: null } : {}) });
      errorFromLook = false;
      state.providers = providersFromUsage(usage.status === 'fulfilled' ? usage.value : undefined);
      state.models = null;
      setAvailability({});
      state.checkedAt = now();
      return;
    }
    // It answered badly or not in time: keep the last good state, which goes stale by itself.
    if (state.proxy.phase !== 'running' && state.proxy.phase !== 'outdated') setProxy({ phase: keep('running') });
    setProxy({ error: message(err) });
    errorFromLook = true;
  };

  const connectInFlight = () => connects.size > 0 || state.providers.some((p) => p.connecting && !p.connecting.error);

  const schedule = () => {
    timers.clearTimeout(pollTimer);
    pollTimer = undefined;
    if (stopped || !supported || installing) return;
    const phase = state.proxy.phase;
    const ms = connectInFlight() || phase === 'starting' ? POLL_FAST_MS : phase === 'running' || phase === 'outdated' ? POLL_RUNNING_MS : POLL_DOWN_MS;
    pollTimer = timers.setTimeout(() => void look(), ms);
  };

  /** Looks at DroidProxy now (after any look already under way), tells everyone, and schedules the next look. */
  const look = async (): Promise<void> => {
    if (!supported || stopped) return;
    while (inflight) await inflight;
    inflight = (async () => {
      try {
        await lookOnce();
      } catch (err) {
        setProxy({ error: message(err) });
        errorFromLook = true;
      }
    })();
    try {
      await inflight;
    } finally {
      inflight = null;
    }
    publish();
    schedule();
  };

  const checkRelease = async () => {
    timers.clearTimeout(releaseTimer);
    if (stopped) return;
    releaseTimer = timers.setTimeout(() => void checkRelease(), RELEASE_EVERY_MS);
    try {
      const r = await latestRelease(opts.fetchImpl);
      if (r.version !== state.proxy.latest) {
        setProxy({ latest: r.version });
        publish();
      }
    } catch {
      // GitHub can't be reached: the newest release stays what it was
    }
  };

  const usableRaw = (p: RawProvider | undefined) => !!p?.accounts?.some((a) => !a.expired && !a.disabled);

  /** After a provider's first account connects, and whenever Droid's DroidProxy models are stale or missing. */
  function maybeApplyModels(prev: RawStatus | undefined, status: RawStatus) {
    if (applying) return;
    const first = !!prev && (status.providers ?? []).some((p) => usableRaw(p) && !usableRaw(prev.providers?.find((q) => q.key === p.key)));
    const f = status.factory;
    const missing = !!f && (Number(f.installed) || 0) === 0 && (Number(f.available) || 0) > 0;
    const stale = f?.stale === true || missing;
    if (first || (stale && now() - autoAppliedAt > AUTO_MODELS_EVERY_MS)) void applyModels(false);
  }

  const applyModels = (asked: boolean): Promise<void> => {
    if (applying) return applying;
    applying = (async () => {
      autoAppliedAt = now();
      try {
        const r = await control.factoryModels();
        opts.modelsChanged();
        if (asked) opts.toast(`DroidProxy put ${typeof r.installed === 'number' ? r.installed : 'its'} models in Droid`, 'info');
      } catch (err) {
        if (asked) fail(`Couldn't put DroidProxy's models in Droid: ${message(err)}`);
      } finally {
        applying = null;
      }
      await look();
    })();
    return applying;
  };

  /** Opens DroidProxy in the background; it opens no window of its own when started this way. */
  const start = async (): Promise<string | undefined> => {
    const app = state.proxy.path;
    if (!app) return "DroidProxy isn't installed";
    lastStartAt = now();
    startingSince = now();
    setProxy({ phase: 'starting', error: null });
    publish();
    const r = await run('open', ['-g', '-a', app, '--args', '--launched-by', 'droid-office'], { timeoutMs: 20_000 });
    if (r.code !== 0) {
      startingSince = null;
      const why = `Couldn't start DroidProxy (${r.stderr.trim().slice(0, 200) || `open exited ${r.code}`})`;
      setProxy({ phase: 'stopped' });
      fail(why);
      return why;
    }
    schedule();
    return undefined;
  };

  /** Starts DroidProxy for a hire, once for a burst of hires rather than once each. */
  const startForHire = () => {
    if (installing || startingSince !== null || now() - lastStartAt < START_WAIT_MS) return;
    void start();
  };

  /** Downloads, checks and installs the newest DroidProxy, then starts it. Resolves to why it failed, if it did. */
  const install = (): Promise<string | undefined> => {
    if (installing) return installing;
    if (!supported) return Promise.resolve('Subscriptions need DroidProxy, which runs only on a Mac with Apple silicon');
    const task = (async (): Promise<string | undefined> => {
      setProxy({ phase: 'installing', progress: 0, error: null });
      publish();
      try {
        const r = await installProxy({
          fetchImpl: opts.fetchImpl,
          run,
          dirs,
          current: state.proxy.path,
          tmp: opts.tmp,
          progress: (p) => {
            setProxy({ progress: p });
            publish();
          },
        });
        setProxy({ path: r.path, version: r.version, latest: state.proxy.latest ?? r.version, progress: undefined });
        opts.toast(`DroidProxy ${r.version} is installed`, 'info');
        installing = null;
        return await start();
      } catch (err) {
        installing = null;
        setProxy({ progress: undefined });
        const why = `Couldn't install DroidProxy: ${message(err)}`;
        fail(why);
        return why;
      } finally {
        installing = null;
        await look();
      }
    })();
    installing = task;
    return task;
  };

  /** Waits for DroidProxy to answer on its control API, looking every second. */
  const untilRunning = async (ms: number): Promise<boolean> => {
    const deadline = now() + ms;
    for (;;) {
      await look();
      if (state.proxy.phase === 'running') return true;
      if (stopped || state.proxy.phase === 'outdated' || state.proxy.phase === 'missing' || now() >= deadline) return false;
      await sleep(1000);
    }
  };

  /** DroidProxy installed (or updated past the control API) and answering, in that order. */
  const ensureRunning = async (): Promise<string | undefined> => {
    await look();
    if (state.proxy.phase === 'running') return undefined;
    if (!state.proxy.path || state.proxy.phase === 'missing' || state.proxy.phase === 'outdated' || state.proxy.phase === 'installing') {
      const err = await install();
      if (err) return err;
    } else if (state.proxy.phase === 'stopped') {
      const err = await start();
      if (err) return err;
    }
    if (await untilRunning(START_WAIT_MS)) return undefined;
    if (state.proxy.phase === 'outdated') return tooOld();
    return "DroidProxy didn't start: open it from Applications to see why";
  };

  const tooOld = () => `DroidProxy${state.proxy.version ? ` ${state.proxy.version}` : ''} is too old for the office to drive: update it in Subscriptions`;

  /** Why an action on the control API can't happen now, if it can't. */
  const notDriveable = (): string | undefined => {
    switch (state.proxy.phase) {
      case 'running':
        return undefined;
      case 'outdated':
        return tooOld();
      case 'missing':
        return "DroidProxy isn't installed";
      case 'unsupported':
        return 'Subscriptions need DroidProxy, which runs only on a Mac with Apple silicon';
      case 'installing':
        return 'DroidProxy is being installed: try again in a moment';
      default:
        return "DroidProxy isn't running: start it first";
    }
  };

  const setConnecting = (key: SubscriptionProviderKey, c: SubscriptionsState['providers'][number]['connecting']) => {
    state.providers = state.providers.map((p) => (p.key === key ? { ...p, ...(c ? { connecting: c } : {}) } : p));
  };

  const connect = async (key: SubscriptionProviderKey) => {
    if (connects.has(key)) return;
    connects.add(key);
    schedule();
    try {
      const err = await ensureRunning();
      if (err) {
        fail(`Couldn't connect ${providerName(key)}: ${err}`);
        return;
      }
      const r = await control.connect(key);
      const c = r.connecting;
      if (c) setConnecting(key, { since: c.started_at ? Date.parse(c.started_at) || now() : now(), ...(c.user_code ? { code: c.user_code } : {}), ...(c.verification_uri ? { url: c.verification_uri } : {}) });
      publish();
    } catch (err) {
      fail(`Couldn't connect ${providerName(key)}: ${message(err)}`);
    } finally {
      connects.delete(key);
      await look();
    }
  };

  /** Runs an action on the control API, says what went wrong, and looks again after. */
  const act = async (what: string, fn: () => Promise<unknown>) => {
    const why = notDriveable();
    if (why) {
      fail(`Couldn't ${what}: ${why}`, 'warn');
      return;
    }
    try {
      await fn();
    } catch (err) {
      fail(`Couldn't ${what}: ${message(err)}`);
    }
    await look();
  };

  const handle = async (msg: SubscriptionsMsg) => {
    if (!supported) return;
    switch (msg.t) {
      case 'subscriptions.proxy':
        if (msg.action === 'install') await install();
        else if (msg.action === 'start') {
          if (state.proxy.phase === 'running' || state.proxy.phase === 'outdated') return;
          const err = await start();
          if (!err) await untilRunning(START_WAIT_MS);
        } else if (state.proxy.phase === 'running') await act('open DroidProxy', () => control.open());
        else if (state.proxy.path) {
          const r = await run('open', ['-a', state.proxy.path], { timeoutMs: 20_000 });
          if (r.code !== 0) fail(`Couldn't open DroidProxy (${r.stderr.trim().slice(0, 200) || `open exited ${r.code}`})`);
          await look();
        } else fail("Couldn't open DroidProxy: it isn't installed", 'warn');
        return;
      case 'subscriptions.connect':
        if (isSubscriptionProvider(msg.provider)) await connect(msg.provider);
        return;
      case 'subscriptions.connectCancel':
        if (isSubscriptionProvider(msg.provider)) await act(`stop connecting ${providerName(msg.provider)}`, () => control.cancelConnect(msg.provider));
        return;
      case 'subscriptions.disconnect':
        if (isSubscriptionProvider(msg.provider) && typeof msg.account === 'string' && msg.account) await act(`remove the ${providerName(msg.provider)} account`, () => control.removeAccount(msg.provider, msg.account));
        return;
      case 'subscriptions.provider':
        if (isSubscriptionProvider(msg.provider) && typeof msg.enabled === 'boolean') await act(`switch ${providerName(msg.provider)} ${msg.enabled ? 'on' : 'off'}`, () => control.setProvider(msg.provider, msg.enabled));
        return;
      case 'subscriptions.models': {
        const why = notDriveable();
        if (why) fail(`Couldn't put DroidProxy's models in Droid: ${why}`, 'warn');
        else await applyModels(true);
        return;
      }
      case 'subscriptions.refresh':
        if (state.proxy.latest === null) void checkRelease();
        await look();
        return;
    }
  };

  const availability = (model: string | undefined): ModelAvailability | undefined => modelAvailability(view(), model);

  if (supported) {
    timers.setTimeout(() => {
      void checkRelease();
      void (async () => {
        await look();
        // Droid's settings already have DroidProxy models: workers will need it running.
        if (state.proxy.phase === 'stopped' && (await settingsModels(home)).size) await start();
      })();
    }, 0);
  }

  return {
    state: view,
    message: (_who, msg) => {
      void handle(msg).catch((err) => fail(message(err)));
    },
    availability,
    gate(model) {
      const a = availability(model);
      if (!a || !model) return undefined;
      if (cannotRun(a)) return `${hireRefusal(names[model] ?? fallbackName(model), a, now())} Pick another model.`;
      if (a.state === 'proxy-down' && a.installed) startForHire();
      return undefined;
    },
    stop() {
      stopped = true;
      timers.clearTimeout(pollTimer);
      timers.clearTimeout(releaseTimer);
    },
  };
}

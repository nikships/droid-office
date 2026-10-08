import os from 'node:os';
import {
  BULK_MAX,
  computerOf,
  DEFAULT_REMOTE_USER,
  emptyComputers,
  hereOf,
  mergeMetrics,
  METRICS_LOOKBACK_HOURS,
  NAME_MAX,
  NAME_PREFIX,
  SECRET_NAME,
  samplesOf,
  type FactoryComputer,
  type FactoryComputerMetrics,
  type FactoryComputersState,
  type FactoryRepoChoice,
} from '../../shared/factory-computers.js';
import { redact } from '../jira.js';
import { FactoryError, type FactoryApi } from './api.js';
import { SliceFeature, badRequest, notFound, str, type FactoryRequest, type FactoryRoute, type FeatureHost } from './feature.js';

/** Metrics are 5-minute samples, so asking more often than this finds nothing new. */
const METRICS_EVERY_MS = 3 * 60_000;
/** While a computer wakes, its metrics are read this often instead, to see it come back. */
const WAKING_METRICS_MS = 60_000;
/** A wake that hasn't shown a sample by now is given up on (the computer's status still says how it is). */
const WAKE_MAX_MS = 12 * 60_000;
/** The provider list hardly ever changes. */
const PROVIDERS_EVERY_MS = 30 * 60_000;
/** The computer secrets' names, read again this often (and straight after a change). */
const SECRETS_EVERY_MS = 5 * 60_000;
/** The repositories Factory's GitHub app sees, kept this long for the new-computer form. */
const REPOS_EVERY_MS = 10 * 60_000;
/** The longest history the metrics route answers with (Factory keeps about four days). */
const MAX_HOURS = 96;
const MAX_REPOS = 200;
const SECRET_VALUE_MAX = 10_000;

/** A repository for a new computer: an https URL, or `owner/name` on GitHub. */
function repoUrl(v: unknown): string {
  const s = str(v, 2048);
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) return `https://github.com/${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw badRequest(`“${s.slice(0, 80)}” isn’t a repository URL`);
  }
  if (u.protocol !== 'https:') throw badRequest('Repository URLs start with https://');
  return u.toString().replace(/\/$/, '');
}

function reposOf(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw badRequest('repos is a list of repository URLs');
  if (v.length > MAX_REPOS) throw badRequest(`At most ${MAX_REPOS} repositories`);
  return [...new Set(v.map(repoUrl))];
}

function nameOf(v: unknown): string {
  const name = str(v, 200);
  if (!name) throw badRequest('Give the computer a name');
  if (name.length > NAME_MAX) throw badRequest(`A computer’s name is at most ${NAME_MAX} characters`);
  return name;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/**
 * Droid Computers: the list every minute (every 15 seconds while the wall or the Computers window
 * is watched, or a computer provisions or wakes), each active managed computer's samples every few
 * minutes as a rolling history, the providers and the organization's computer secret names, and a
 * route for every action on them.
 */
export class ComputersFeature extends SliceFeature<'computers'> {
  readonly interval = 60_000;
  readonly fastInterval = 15_000;
  private providersAt = 0;
  private secretsAt = 0;
  private repos?: { at: number; list: FactoryRepoChoice[] };

  readonly routes: readonly FactoryRoute[] = [
    { method: 'POST', path: '', handle: (req) => this.create(req) },
    { method: 'POST', path: '/bulk', handle: (req) => this.bulk(req) },
    {
      // The repositories Factory's GitHub app sees, for the new-computer form's picker.
      method: 'GET',
      path: '/repositories',
      handle: async ({ api }) => {
        if (this.repos && this.now() - this.repos.at < REPOS_EVERY_MS) return { repositories: this.repos.list };
        const r = await api.get<{ repositories?: unknown[] }>('/automations/ci/repositories');
        const list = (Array.isArray(r?.repositories) ? r.repositories : [])
          .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && typeof (x as { fullName?: unknown }).fullName === 'string')
          .map((x) => ({ fullName: String(x.fullName), url: typeof x.url === 'string' ? x.url : `https://github.com/${x.fullName}`, ...(typeof x.isPrivate === 'boolean' ? { isPrivate: x.isPrivate } : {}) }))
          .sort((a, b) => a.fullName.localeCompare(b.fullName));
        this.repos = { at: this.now(), list };
        return { repositories: list };
      },
    },
    { method: 'GET', path: '/secrets', handle: async ({ api }) => ({ secrets: await this.readSecrets(api) }) },
    { method: 'PATCH', path: '/secrets', handle: (req) => this.patchSecrets(req) },
    {
      // One computer as Factory has it now, with its provisioning steps.
      method: 'GET',
      path: '/:id',
      handle: async ({ api, params }) => {
        const c = computerOf(await api.get(`/computers/${encodeURIComponent(params.id)}`, { includeProvisioningSteps: true }));
        if (!c) throw notFound('No such computer');
        this.replace(c);
        return { computer: c };
      },
    },
    {
      // A managed computer's samples over a longer window than the slice keeps (?hours=, 1-96).
      method: 'GET',
      path: '/:id/metrics',
      handle: async ({ api, params, query }) => {
        const hours = Number(query.get('hours') ?? 24);
        if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_HOURS) throw badRequest(`hours is 1 to ${MAX_HOURS}`);
        return { samples: samplesOf(await api.metrics(params.id, new Date(this.now() - hours * 3600_000))) };
      },
    },
    { method: 'PATCH', path: '/:id', handle: (req) => this.update(req) },
    { method: 'DELETE', path: '/:id', handle: (req) => this.remove(req) },
    {
      // Wakes a computer that's asleep (mode resume, Factory's default), or reboots it.
      method: 'POST',
      path: '/:id/restart',
      handle: async ({ api, params, json, by }) => {
        const body = await json<{ mode?: unknown }>();
        const mode = body.mode === 'reboot' ? 'reboot' : 'resume';
        const c = this.known(params.id);
        const r = await api.post<{ wasRestarted?: boolean }>(`/computers/${encodeURIComponent(params.id)}/restart`, { mode });
        const restarted = r?.wasRestarted === true;
        if (restarted) {
          this.set({ waking: { ...this.slice.waking, [params.id]: this.now() } });
          this.host.toast(`🖥️ ${by} ${mode === 'reboot' ? 'rebooted' : 'woke'} the Droid Computer ${c?.name ?? params.id}`);
        }
        this.host.pollSoon();
        return { wasRestarted: restarted };
      },
    },
    {
      // Configures its git credentials and the organization's computer secrets on it again.
      method: 'POST',
      path: '/:id/refresh',
      handle: async ({ api, params }) => {
        const r = await api.post<{ configured?: number; secretsConfigured?: number }>(`/computers/${encodeURIComponent(params.id)}/refresh`);
        return { configured: Number(r?.configured ?? 0), secretsConfigured: Number(r?.secretsConfigured ?? 0) };
      },
    },
    {
      // Runs the install-dependencies step again, after it failed.
      method: 'POST',
      path: '/:id/install-deps',
      handle: async ({ api, params }) => {
        const c = computerOf(await api.post(`/computers/${encodeURIComponent(params.id)}/install-deps`));
        if (c) this.replace(c);
        this.host.pollSoon();
        return { computer: c ?? null };
      },
    },
    {
      // Counts as use, so Factory doesn't put it to sleep for a while.
      method: 'POST',
      path: '/:id/activity',
      handle: async ({ api, params }) => {
        const r = await api.post<{ lastActiveAt?: number }>(`/computers/${encodeURIComponent(params.id)}/activity`);
        return { lastActiveAt: Number(r?.lastActiveAt ?? this.now()) };
      },
    },
  ];

  /** `hostNames` are this machine's, to find its own BYOM computer (os.hostname() by default). */
  constructor(
    host: FeatureHost,
    private now: () => number = Date.now,
    private hostNames: string[] = [os.hostname()],
  ) {
    super('computers', host, emptyComputers);
  }

  busy(): boolean {
    return this.slice.items.some((c) => c.status === 'provisioning') || Object.keys(this.slice.waking).length > 0;
  }

  reset() {
    this.providersAt = 0;
    this.secretsAt = 0;
    this.repos = undefined;
    super.reset();
  }

  async poll(api: FactoryApi): Promise<void> {
    const now = this.now();
    const wantProviders = now - this.providersAt >= PROVIDERS_EVERY_MS;
    const wantSecrets = now - this.secretsAt >= SECRETS_EVERY_MS;
    const [list, providers, secrets] = await Promise.all([
      api.get<{ computers?: unknown[] }>('/computers', { includeProvisioningSteps: true }),
      wantProviders ? api.providers().catch(() => undefined) : undefined,
      wantSecrets
        ? this.secretNames(api).then(
            (names) => ({ names }),
            (err: Error) => ({ error: err }),
          )
        : undefined,
    ]);
    const items = (Array.isArray(list?.computers) ? list.computers : []).map(computerOf).filter((c): c is FactoryComputer => !!c);
    const metrics = await this.readMetrics(api, items);
    const patch: Partial<FactoryComputersState> = { items, metrics, here: hereOf(items, this.hostNames), waking: this.stillWaking(items, metrics), fetchedAt: now, error: undefined };
    if (providers) {
      this.providersAt = now;
      patch.providers = (providers.providers ?? []).filter((p): p is string => typeof p === 'string');
    }
    if (secrets) {
      this.secretsAt = now;
      if ('names' in secrets) Object.assign(patch, { secrets: secrets.names, secretsError: undefined });
      else {
        if (secrets.error instanceof FactoryError && secrets.error.status === 401) throw secrets.error;
        patch.secretsError = secrets.error.message;
      }
    }
    this.set(patch);
  }

  /**
   * Each active managed computer's samples since the newest it has (the last day, the first time),
   * read again once they're METRICS_EVERY_MS old, or every minute while it wakes. A failed read keeps
   * the last ones with the error. A computer that's gone takes its history with it.
   */
  private async readMetrics(api: FactoryApi, items: FactoryComputer[]): Promise<Record<string, FactoryComputerMetrics>> {
    const out: Record<string, FactoryComputerMetrics> = {};
    const now = this.now();
    await Promise.all(
      items
        .filter((c) => c.managed)
        .map(async (c) => {
          const last = this.slice.metrics[c.id];
          const every = this.slice.waking[c.id] !== undefined ? WAKING_METRICS_MS : METRICS_EVERY_MS;
          if (c.status !== 'active' || (last && now - last.fetchedAt < every)) {
            if (last) out[c.id] = last;
            return;
          }
          const start = last?.latest ? last.latest.at + 1 : now - METRICS_LOOKBACK_HOURS * 3600_000;
          try {
            out[c.id] = mergeMetrics(last, samplesOf(await api.metrics(c.id, new Date(start))), now);
          } catch (err) {
            if (err instanceof FactoryError && err.status === 401) throw err;
            out[c.id] = { ...(last ?? { history: [] }), fetchedAt: now, error: (err as Error).message };
          }
        }),
    );
    return out;
  }

  /** The wakes still under way: the computer is there, hasn't sent a sample since, and it hasn't been too long. */
  private stillWaking(items: FactoryComputer[], metrics: Record<string, FactoryComputerMetrics>): Record<string, number> {
    const now = this.now();
    const out: Record<string, number> = {};
    for (const [id, at] of Object.entries(this.slice.waking)) {
      const c = items.find((x) => x.id === id);
      if (!c || c.status === 'error' || now - at > WAKE_MAX_MS) continue;
      // A sample's time is the start of its 5 minutes, so one taken since the wake may say up to 5 minutes before it.
      const latest = metrics[id]?.latest;
      if (!c.managed || (latest && latest.at >= at - 5 * 60_000)) continue;
      out[id] = at;
    }
    return out;
  }

  private async secretNames(api: FactoryApi): Promise<string[]> {
    const r = await api.get<{ secrets?: unknown[] }>('/organization/computer-secrets');
    return namesOf(r?.secrets);
  }

  private async readSecrets(api: FactoryApi): Promise<string[]> {
    const names = await this.secretNames(api);
    this.secretsAt = this.now();
    this.set({ secrets: names, secretsError: undefined });
    return names;
  }

  /** Sets and removes organization computer secrets. Values go to Factory and nowhere else: not the slice, a log, or an error message. */
  private async patchSecrets({ api, json, by }: FactoryRequest) {
    const body = await json<{ upsert?: unknown; delete?: unknown }>();
    const upsert = Array.isArray(body.upsert) ? body.upsert : [];
    const remove = Array.isArray(body.delete) ? body.delete : [];
    if (!upsert.length && !remove.length) throw badRequest('Nothing to change');
    if (upsert.length > 100 || remove.length > 100) throw badRequest('At most 100 secrets at a time');
    const values: string[] = [];
    const sets = upsert.map((s) => {
      const e = (s ?? {}) as { key?: unknown; value?: unknown };
      const key = str(e.key, 200);
      if (!SECRET_NAME.test(key) || key.length > 128) throw badRequest(`“${key.slice(0, 40)}” isn’t a secret name: capital letters, digits and _, not starting with a digit`);
      if (typeof e.value !== 'string' || !e.value || e.value.length > SECRET_VALUE_MAX) throw badRequest(`${key} needs a value of 1 to ${SECRET_VALUE_MAX} characters`);
      values.push(e.value);
      return { key, value: e.value };
    });
    const deletes = remove.map((k) => {
      const key = str(k, 200);
      if (!SECRET_NAME.test(key)) throw badRequest(`“${key.slice(0, 40)}” isn’t a secret name`);
      return key;
    });
    let r: { secrets?: unknown[] };
    try {
      r = await api.patch('/organization/computer-secrets', { upsert: sets, delete: deletes });
    } catch (err) {
      if (err instanceof FactoryError) throw new FactoryError(redact(err.message, values), err.status, redact(err.title, values), redact(err.detail, values), err.retryAfter, err.timedOut);
      throw err;
    }
    const names = namesOf(r?.secrets);
    this.secretsAt = this.now();
    this.set({ secrets: names, secretsError: undefined });
    const what = [sets.length ? `set ${plural(sets.length, 'computer secret')}` : '', deletes.length ? `removed ${plural(deletes.length, 'computer secret')}` : ''].filter(Boolean).join(' and ');
    console.log(`  ${by} ${what} in Factory`);
    return { secrets: names };
  }

  private async create({ api, json, by }: FactoryRequest) {
    const body = await json<Record<string, unknown>>();
    const name = nameOf(body.name);
    const repos = reposOf(body.repos);
    const provider = str(body.provider, 40);
    const remoteUser = str(body.remoteUser, NAME_MAX) || DEFAULT_REMOTE_USER;
    const c = computerOf(
      await api.post('/computers', {
        name,
        ...(provider ? { provider } : {}),
        remoteUser,
        ...(repos?.length ? { repos } : {}),
        ...(typeof body.autoInstallDeps === 'boolean' ? { autoInstallDeps: body.autoInstallDeps } : {}),
      }),
    );
    if (c) this.replace(c);
    this.host.toast(`🖥️ ${by} made the Droid Computer ${name}`);
    console.log(`  ${by} made the Droid Computer ${name}`);
    this.host.pollSoon();
    return { computer: c ?? null };
  }

  private async bulk({ api, json, by }: FactoryRequest) {
    const body = await json<Record<string, unknown>>();
    const quantity = Number(body.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > BULK_MAX) throw badRequest(`Make 1 to ${BULK_MAX} computers at a time`);
    const namePrefix = str(body.namePrefix, 100);
    if (!NAME_PREFIX.test(namePrefix) || namePrefix.length > 58) throw badRequest('The name prefix is lower-case letters, digits and hyphens, starting with a letter (at most 58)');
    const repos = reposOf(body.repos);
    const provider = str(body.provider, 40);
    const r = await api.post<{ computers?: unknown[]; requestedQuantity?: number; error?: { message?: unknown } }>('/computers/bulk', {
      quantity,
      namePrefix,
      ...(provider ? { provider } : {}),
      ...(repos?.length ? { repos } : {}),
      ...(typeof body.autoInstallDeps === 'boolean' ? { autoInstallDeps: body.autoInstallDeps } : {}),
    });
    const made = (Array.isArray(r?.computers) ? r.computers : []).map(computerOf).filter((c): c is FactoryComputer => !!c);
    for (const c of made) this.replace(c);
    const error = typeof r?.error?.message === 'string' ? r.error.message.slice(0, 400) : undefined;
    if (made.length) {
      this.host.toast(`🖥️ ${by} made ${plural(made.length, 'Droid Computer')} (${namePrefix}-…)`);
      console.log(`  ${by} made ${plural(made.length, 'Droid Computer')} named ${namePrefix}-…`);
    }
    this.host.pollSoon();
    return { computers: made, requested: quantity, ...(error ? { error } : {}) };
  }

  private async update({ api, params, json }: FactoryRequest) {
    const body = await json<Record<string, unknown>>();
    const patch: { name?: string; remoteUser?: string } = {};
    if (body.name !== undefined) patch.name = nameOf(body.name);
    if (body.remoteUser !== undefined) {
      const u = str(body.remoteUser, 200);
      if (!u || u.length > NAME_MAX) throw badRequest(`The remote user is 1 to ${NAME_MAX} characters`);
      patch.remoteUser = u;
    }
    if (!Object.keys(patch).length) throw badRequest('Nothing to change');
    const c = computerOf(await api.patch(`/computers/${encodeURIComponent(params.id)}`, patch));
    if (c) this.replace(c);
    this.host.pollSoon();
    return { computer: c ?? null };
  }

  /** Deletes a computer, only with its name typed out as `confirm` (the body, or ?confirm=). */
  private async remove({ api, params, json, query, by }: FactoryRequest) {
    const body = await json<{ confirm?: unknown }>();
    const confirm = str(body.confirm ?? query.get('confirm'), 200);
    const c = this.known(params.id) ?? computerOf(await api.get(`/computers/${encodeURIComponent(params.id)}`));
    if (!c) throw notFound('No such computer');
    if (confirm !== c.name) throw badRequest(`Type the computer’s name, ${c.name}, to delete it`);
    await api.delete(`/computers/${encodeURIComponent(params.id)}`);
    const { [c.id]: _gone, ...metrics } = this.slice.metrics;
    const { [c.id]: _wake, ...waking } = this.slice.waking;
    this.set({ items: this.slice.items.filter((x) => x.id !== c.id), metrics, waking, here: this.slice.here === c.id ? undefined : this.slice.here });
    this.host.toast(`🗑️ ${by} deleted the Droid Computer ${c.name}`);
    console.log(`  ${by} deleted the Droid Computer ${c.name}`);
    this.host.pollSoon();
    return { deleted: c.id };
  }

  private known(id: string): FactoryComputer | undefined {
    return this.slice.items.find((c) => c.id === id);
  }

  /** Puts an answer's computer into the list (in place, or at the end for a new one). */
  private replace(c: FactoryComputer) {
    const items = this.slice.items.some((x) => x.id === c.id) ? this.slice.items.map((x) => (x.id === c.id ? { ...x, ...c } : x)) : [...this.slice.items, c];
    this.set({ items, here: hereOf(items, this.hostNames) });
  }
}

function namesOf(raw: unknown): string[] {
  return (Array.isArray(raw) ? raw : [])
    .map((s) => (s && typeof s === 'object' ? (s as { key?: unknown }).key : undefined))
    .filter((k): k is string => typeof k === 'string' && !!k)
    .sort();
}

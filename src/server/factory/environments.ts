import { ENV_NAME, ENV_NAME_MAX, ENV_REPOS_MAX, ENV_SCRIPT_MAX, buildRunning, emptyEnvironments, environmentOf, logOf, sourcesOf, type FactoryEnvRepo, type FactoryEnvironment } from '../../shared/factory-environments.js';
import type { FactoryApi } from './api.js';
import { SliceFeature, badRequest, notFound, str, type FactoryRequest, type FactoryRoute, type FeatureHost } from './feature.js';

/** The sources hardly ever change. */
const SOURCES_EVERY_MS = 30 * 60_000;

const enc = encodeURIComponent;

function nameOf(v: unknown): string {
  const name = str(v, 200);
  if (!name) throw badRequest('Give the Environment a name');
  if (name.length > ENV_NAME_MAX || !ENV_NAME.test(name)) throw badRequest(`An Environment’s name is lower-case letters, digits and hyphens, starting with a letter and not ending with a hyphen (at most ${ENV_NAME_MAX})`);
  return name;
}

function scriptOf(v: unknown, what: string): string {
  if (typeof v !== 'string') throw badRequest(`${what} is text`);
  if (v.length > ENV_SCRIPT_MAX) throw badRequest(`${what} is at most ${ENV_SCRIPT_MAX.toLocaleString('en')} characters`);
  return v;
}

/** An Environment's repositories: `{url, script}` each, an https URL or `owner/name` on GitHub. */
function reposOf(v: unknown): FactoryEnvRepo[] {
  if (!Array.isArray(v)) throw badRequest('repositories is a list of { url, script }');
  if (v.length > ENV_REPOS_MAX) throw badRequest(`At most ${ENV_REPOS_MAX} repositories`);
  const seen = new Set<string>();
  const out: FactoryEnvRepo[] = [];
  for (const r of v) {
    const e = (r && typeof r === 'object' ? r : {}) as { url?: unknown; script?: unknown };
    const s = str(e.url, 2048);
    let url = /^[\w.-]+\/[\w.-]+$/.test(s) ? `https://github.com/${s}` : s;
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:') throw new Error();
      url = u.toString().replace(/\/$/, '');
    } catch {
      throw badRequest(`“${s.slice(0, 80)}” isn’t an https repository URL`);
    }
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, script: e.script === undefined ? '' : scriptOf(e.script, `The script for ${url.replace(/^https:\/\/github\.com\//, '')}`) });
  }
  return out;
}

/**
 * Factory Environments: the list every five minutes (every 20 seconds while the Environments tab is
 * open or one builds), the sources a new one can use, and a route for every action. A build's log is
 * read on demand: it's a few thousand characters per Environment, too much to broadcast each poll.
 */
export class EnvironmentsFeature extends SliceFeature<'environments'> {
  readonly interval = 5 * 60_000;
  readonly fastInterval = 20_000;
  private sourcesAt = 0;

  readonly routes: readonly FactoryRoute[] = [
    { method: 'POST', path: '', handle: (req) => this.create(req) },
    {
      // Makes `environmentId` the organization's default Environment.
      method: 'PUT',
      path: '/default',
      handle: async ({ api, json, by }) => {
        const body = await json<{ environmentId?: unknown }>();
        const e = this.known(str(body.environmentId, 128));
        if (!e) throw notFound('No such Environment');
        const r = await api.request<{ defaultEnvironmentId?: unknown }>('PUT', '/environments/default', { body: { environmentId: e.id } });
        const defaultId = typeof r?.defaultEnvironmentId === 'string' ? r.defaultEnvironmentId : e.id;
        this.set({ defaultId, items: this.slice.items.map((x) => ({ ...x, isDefault: x.id === defaultId })) });
        this.host.toast(`🧱 ${by} made ${e.name} the default Environment`);
        this.host.pollSoon();
        return { defaultId };
      },
    },
    { method: 'PATCH', path: '/:id', handle: (req) => this.update(req) },
    { method: 'DELETE', path: '/:id', handle: (req) => this.remove(req) },
    {
      // Builds it again from what's saved: the repositories at their newest commits, and its scripts.
      method: 'POST',
      path: '/:id/rebuild',
      handle: async ({ api, params, by }) => {
        const e = await this.find(api, params.id);
        if (buildRunning(e.latestBuild)) throw badRequest(`${e.name} is building already`);
        const r = await api.post<{ buildId?: unknown }>(`/environments/${enc(e.id)}/builds`);
        this.host.toast(`🧱 ${by} started a new build of ${e.name}`);
        console.log(`  ${by} rebuilt the Factory Environment ${e.name}`);
        this.host.pollSoon();
        return { buildId: typeof r?.buildId === 'string' ? r.buildId : null };
      },
    },
    {
      // Stops its build that's running.
      method: 'POST',
      path: '/:id/cancel',
      handle: async ({ api, params, by }) => {
        const e = await this.find(api, params.id);
        const b = e.latestBuild;
        if (!b || !buildRunning(b)) throw badRequest(`${e.name} isn’t building`);
        await api.post(`/environments/${enc(e.id)}/builds/${enc(b.id)}/cancel`);
        this.host.toast(`🧱 ${by} stopped the build of ${e.name}`);
        this.host.pollSoon();
        return { cancelled: b.id };
      },
    },
    {
      // A build's log (?build=, else the latest): its last few thousand characters.
      method: 'GET',
      path: '/:id/log',
      handle: async ({ api, params, query }) => {
        const build = str(query.get('build'), 128);
        const path = build ? `/environments/${enc(params.id)}/builds/${enc(build)}/diagnostics` : `/environments/${enc(params.id)}/build-diagnostics`;
        return { log: logOf(await api.get(path)) ?? null };
      },
    },
  ];

  constructor(
    host: FeatureHost,
    private now: () => number = Date.now,
  ) {
    super('environments', host, emptyEnvironments);
  }

  busy(): boolean {
    return this.slice.items.some((e) => buildRunning(e.latestBuild));
  }

  reset() {
    this.sourcesAt = 0;
    super.reset();
  }

  async poll(api: FactoryApi): Promise<void> {
    const now = this.now();
    const wantSources = now - this.sourcesAt >= SOURCES_EVERY_MS;
    const [list, sources] = await Promise.all([api.get<{ environments?: unknown[]; defaultEnvironmentId?: unknown }>('/environments'), wantSources ? api.get('/environments/source-options').catch(() => undefined) : undefined]);
    const items = (Array.isArray(list?.environments) ? list.environments : []).map(environmentOf).filter((e): e is FactoryEnvironment => !!e);
    const defaultId = typeof list?.defaultEnvironmentId === 'string' ? list.defaultEnvironmentId : items.find((e) => e.isDefault)?.id;
    const patch: Partial<typeof this.slice> = { items, defaultId, fetchedAt: now, error: undefined };
    if (sources) {
      this.sourcesAt = now;
      patch.sources = sourcesOf(sources);
    }
    this.set(patch);
  }

  /** An Environment as the slice has it, else as Factory has it now. */
  private async find(api: FactoryApi, id: string): Promise<FactoryEnvironment> {
    const e = this.known(id) ?? environmentOf(await api.get(`/environments/${enc(id)}`));
    if (!e) throw notFound('No such Environment');
    return e;
  }

  private known(id: string): FactoryEnvironment | undefined {
    return this.slice.items.find((e) => e.id === id);
  }

  private async create({ api, json, by }: FactoryRequest) {
    const body = await json<Record<string, unknown>>();
    const name = nameOf(body.name);
    const scope = body.scope === 'organization' ? 'organization' : 'user';
    const repositories = reposOf(body.repositories ?? []);
    const setupScript = body.setupScript === undefined ? '' : scriptOf(body.setupScript, 'The setup script');
    const sourceId = str(body.sourceId, 128);
    const r = await api.post<{ id?: unknown; buildId?: unknown }>('/environments', {
      name,
      scope,
      repositories,
      ...(setupScript ? { setupScript } : {}),
      ...(sourceId ? { sourceId } : {}),
      ...(body.makeDefault === true ? { makeOrganizationDefault: true } : {}),
    });
    this.host.toast(`🧱 ${by} made the Environment ${name}. Factory is building it.`);
    console.log(`  ${by} made the Factory Environment ${name}`);
    this.host.pollSoon();
    return { id: typeof r?.id === 'string' ? r.id : null, buildId: typeof r?.buildId === 'string' ? r.buildId : null };
  }

  /** Saves a change. A change to its repositories or setup script starts a build; the last good build serves new computers meanwhile. */
  private async update({ api, params, json, by }: FactoryRequest) {
    const e = await this.find(api, params.id);
    const body = await json<Record<string, unknown>>();
    const patch: { name?: string; repositories?: FactoryEnvRepo[]; setupScript?: string | null; sourceId?: string } = {};
    if (body.name !== undefined && body.name !== e.name) patch.name = nameOf(body.name);
    if (body.repositories !== undefined) patch.repositories = reposOf(body.repositories);
    if (body.setupScript !== undefined) patch.setupScript = body.setupScript === null ? null : scriptOf(body.setupScript, 'The setup script');
    if (body.sourceId !== undefined) patch.sourceId = str(body.sourceId, 128);
    if (!Object.keys(patch).length) throw badRequest('Nothing to change');
    const r = await api.patch<{ buildId?: unknown }>(`/environments/${enc(e.id)}`, patch);
    const building = typeof r?.buildId === 'string';
    this.host.toast(`🧱 ${by} changed the Environment ${patch.name ?? e.name}${building ? '. Factory is building it again.' : ''}`);
    console.log(`  ${by} changed the Factory Environment ${e.name}`);
    this.host.pollSoon();
    return { buildId: building ? r?.buildId : null };
  }

  /** Deletes an Environment, only with its name typed out as `confirm`. Computers started from it stay until they're deleted. */
  private async remove({ api, params, json, by }: FactoryRequest) {
    const e = await this.find(api, params.id);
    const body = await json<{ confirm?: unknown }>();
    if (str(body.confirm, 200) !== e.name) throw badRequest(`Type the Environment’s name, ${e.name}, to delete it`);
    await api.delete(`/environments/${enc(e.id)}`);
    this.set({ items: this.slice.items.filter((x) => x.id !== e.id), defaultId: this.slice.defaultId === e.id ? undefined : this.slice.defaultId });
    this.host.toast(`🗑️ ${by} deleted the Environment ${e.name}`);
    console.log(`  ${by} deleted the Factory Environment ${e.name}`);
    this.host.pollSoon();
    return { deleted: e.id };
  }
}

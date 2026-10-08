import { Readable } from 'node:stream';
import {
  WIKI_DEFAULT_MODEL,
  WIKI_HISTORY_MAX,
  WIKI_PRIVACY,
  WIKI_SEARCH_LIMIT,
  emptyWiki,
  isModelId,
  sameRepo,
  wikiHitOf,
  wikiPageOf,
  wikiRepoOf,
  wikiRunDetailOf,
  wikiRunOf,
  type FactoryWikiFloor,
  type FactoryWikiPage,
  type FactoryWikiRun,
  type FactoryWikiRunDetail,
  type FactoryWikiState,
} from '../../shared/factory-wiki.js';
import { redact } from '../jira.js';
import { FACTORY_API, FactoryError, type FactoryApi } from './api.js';
import { FactoryDownload, HttpError, SliceFeature, badRequest, notFound, str, type FactoryRoute, type FeatureHost } from './feature.js';
import { WikiRunner, type WikiFloorDef, type WikiRunnerOptions } from './wiki-run.js';

// AutoWiki on each floor's bookshelf: the newest run of every repository (GET /wiki), each floor's
// run history (GET /wiki/history/{repoUrl}, the full https URL, URL-encoded), and the office's own
// /wiki runs (wiki-run.ts). Pages, run details and searches are read on demand through the routes;
// a run never changes once uploaded, so its pages are cached.

/** How many pages (and run trees) the cache keeps. */
const PAGE_CACHE = 400;
/** How many floors' histories one poll reads, at most. */
const HISTORY_FLOORS = 12;
/** A job's output reaches browsers at most this often. */
const LINES_MS = 1000;
/** After a run's upload, the poll that looks for it, and one more in case Factory took a moment. */
const AFTER_UPLOAD_MS = 20_000;

export interface WikiOptions {
  /** The office's floors, as the runner needs them. */
  floors?: () => WikiFloorDef[];
  /** The office's Factory key, for the /wiki child's environment and the export download. */
  key?: () => string | undefined;
  /** How the runner finds and starts Droid; without it the office can't generate a wiki. */
  runner?: Omit<WikiRunnerOptions, 'onChange' | 'onEnd'>;
  fetchImpl?: typeof fetch;
  base?: string;
  now?: () => number;
}

/** A Map that forgets its oldest entries past `max`. */
class Lru<V> {
  private map = new Map<string, V>();
  constructor(private max: number) {}
  get(k: string): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k: string, v: V) {
    this.map.delete(k);
    this.map.set(k, v);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }
  dropWhere(fn: (k: string) => boolean) {
    for (const k of [...this.map.keys()]) if (fn(k)) this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
}

const runsOf = (raw: unknown): FactoryWikiRun[] => {
  const list = raw && typeof raw === 'object' ? (raw as { wikiRuns?: unknown }).wikiRuns : undefined;
  return (Array.isArray(list) ? list : [])
    .map(wikiRunOf)
    .filter((w): w is FactoryWikiRun => !!w)
    .sort((a, b) => b.createdAt - a.createdAt);
};

export class WikiFeature extends SliceFeature<'wiki'> {
  readonly interval = 5 * 60_000;
  readonly fastInterval = 60_000;
  readonly runner?: WikiRunner;
  private now: () => number;
  private pages = new Lru<FactoryWikiPage>(PAGE_CACHE);
  private trees = new Lru<FactoryWikiRunDetail>(64);
  /** Each floor's history as last read. */
  private histories = new Map<string, { repoUrl: string; runs: FactoryWikiRun[]; fetchedAt: number; noAccess?: string }>();
  private linesTimer?: ReturnType<typeof setTimeout>;
  private afterUpload?: ReturnType<typeof setTimeout>;

  readonly routes: readonly FactoryRoute[] = [
    {
      // Whether the key may upload a wiki for a repository (?repoUrl=). Factory says yes to any
      // URL it's asked about, so the shelf decides what can have one from the remote itself.
      method: 'GET',
      path: '/upload-access',
      handle: async ({ api, query }) => {
        const repoUrl = query.get('repoUrl')?.trim();
        if (!repoUrl) throw badRequest('Say which repository: ?repoUrl=https://github.com/owner/repo');
        const r = await api.get<{ allowed?: unknown }>('/wiki/upload-access', { repoUrl });
        return { allowed: r?.allowed === true };
      },
    },
    {
      // A floor's AutoWiki now: its newest run and its history, read again.
      method: 'GET',
      path: '/floor',
      handle: async ({ api, query }) => {
        const floor = this.floor(query.get('floor') ?? '');
        await this.readHistory(api, floor, true);
        this.host.changed();
        return this.floorState(floor);
      },
    },
    {
      method: 'GET',
      path: '/runs/:id',
      handle: ({ api, params }) => this.run(api, params.id),
    },
    {
      method: 'GET',
      path: '/runs/:id/pages/:page',
      handle: async ({ api, params }) => {
        const key = `${params.id}/${params.page}`;
        const cached = this.pages.get(key);
        if (cached) return cached;
        const page = wikiPageOf(await api.get(`/wiki/${encodeURIComponent(params.id)}/pages/${encodeURIComponent(params.page)}`));
        if (!page) throw notFound('Factory sent no page');
        this.pages.set(key, page);
        return page;
      },
    },
    {
      method: 'GET',
      path: '/runs/:id/search',
      handle: async ({ api, params, query }) => {
        const q = (query.get('q') ?? '').trim().slice(0, 200);
        if (!q) throw badRequest('Say what to look for: ?q=');
        const limit = Math.max(1, Math.min(WIKI_SEARCH_LIMIT, Number(query.get('limit')) || WIKI_SEARCH_LIMIT));
        const r = await api.get<{ results?: unknown[] }>(`/wiki/${encodeURIComponent(params.id)}/search`, { q, limit });
        return { results: (Array.isArray(r?.results) ? r.results : []).map(wikiHitOf).filter((x) => !!x) };
      },
    },
    {
      // The run's pages as a .zip, piped through to the browser as a download.
      method: 'GET',
      path: '/runs/:id/export',
      handle: ({ params }) => this.export(params.id),
    },
    {
      method: 'POST',
      path: '/runs/:id/privacy',
      handle: async ({ api, params, json, by }) => {
        const body = await json<{ privacyLevel?: unknown }>();
        const level = WIKI_PRIVACY.find((p) => p === body.privacyLevel);
        if (!level) throw badRequest(`privacyLevel is one of ${WIKI_PRIVACY.join(', ')}`);
        await api.post(`/wiki/${encodeURIComponent(params.id)}/privacy`, { privacyLevel: level });
        this.trees.dropWhere((k) => k === params.id);
        this.patchRun(params.id, { privacyLevel: level });
        this.host.toast(`📚 ${by} made the AutoWiki ${level === 'private' ? 'private' : 'visible to the organization'}`);
        this.host.pollSoon();
        return { privacyLevel: level };
      },
    },
    {
      method: 'DELETE',
      path: '/runs/:id',
      handle: async ({ api, params, by }) => {
        await api.delete(`/wiki/${encodeURIComponent(params.id)}`);
        this.forgetRun(params.id);
        this.host.toast(`📚 ${by} deleted an AutoWiki run`);
        this.host.pollSoon();
        return { deleted: true };
      },
    },
    {
      // Runs /wiki for a floor (wiki-run.ts): one at a time per floor.
      method: 'POST',
      path: '/generate',
      handle: async ({ json, by }) => {
        const body = await json<{ floor?: unknown; model?: unknown }>();
        const floor = this.floor(str(body.floor, 64));
        const where = wikiRepoOf(floor.repo);
        if ('why' in where) throw new HttpError(409, where.why);
        if (!this.runner) throw new HttpError(409, 'This office can’t run /wiki.');
        const key = this.opts.key?.();
        if (!key) throw new HttpError(409, 'The office’s Factory key isn’t usable now. Check it in ⚙️ Settings → Factory.');
        const id = body.model === undefined || body.model === '' ? WIKI_DEFAULT_MODEL : body.model;
        if (!isModelId(id)) throw badRequest('model is a Droid model id, like glm-5.3-flash');
        const models = await this.runner.models();
        // An empty list: this Droid didn't say which it has, so it's left to say no itself.
        const model = models.length ? models.find((m) => m.id === id) : { id, name: id };
        if (!model) throw badRequest(`The office’s Droid has no model ${id}`);
        const job = this.runner.start(floor, by, key, model);
        this.host.toast(`📚 ${by} started writing ${floor.name}’s AutoWiki with ${model.name}`);
        return { job };
      },
    },
    {
      // The models Generate can run /wiki on, and the one it picks unless told.
      method: 'GET',
      path: '/models',
      handle: async () => {
        const models = (await this.runner?.models()) ?? [];
        return { models, default: models.length && !models.some((m) => m.id === WIKI_DEFAULT_MODEL) ? models[0].id : WIKI_DEFAULT_MODEL };
      },
    },
    {
      method: 'POST',
      path: '/cancel',
      handle: async ({ json, by }) => {
        const body = await json<{ floor?: unknown }>();
        const floor = this.floor(str(body.floor, 64));
        if (!this.runner?.cancel(floor.id, by)) throw new HttpError(409, 'No /wiki run to stop on this floor.');
        return { cancelled: true };
      },
    },
  ];

  constructor(
    host: FeatureHost,
    private opts: WikiOptions = {},
  ) {
    super('wiki', host, emptyWiki);
    this.now = opts.now ?? Date.now;
    if (opts.runner) {
      this.runner = new WikiRunner({
        ...opts.runner,
        onChange: (_floor, what) => this.jobChanged(what),
        onEnd: (_floor, job) => {
          if (job.state !== 'done') return;
          // The upload was its last step: look for the new run now, and once more shortly.
          this.host.pollSoon();
          if (this.afterUpload) clearTimeout(this.afterUpload);
          this.afterUpload = setTimeout(() => this.host.pollSoon(), AFTER_UPLOAD_MS);
          this.afterUpload.unref?.();
        },
      });
    }
  }

  private floors(): WikiFloorDef[] {
    const list = this.opts.floors?.() ?? [];
    for (const f of list) this.runner?.adopt(f);
    return list;
  }

  private floor(id: string): WikiFloorDef {
    const f = id ? this.floors().find((x) => x.id === id) : undefined;
    if (!f) throw notFound('No such floor');
    return f;
  }

  busy(): boolean {
    return !!this.runner?.busy();
  }

  /** The slice with every floor's AutoWiki as it is now (their jobs move between polls). */
  state(): FactoryWikiState {
    const floors: Record<string, FactoryWikiFloor> = {};
    for (const f of this.floors()) floors[f.id] = this.floorState(f);
    return { ...this.slice, floors };
  }

  private floorState(f: WikiFloorDef): FactoryWikiFloor {
    const where = wikiRepoOf(f.repo);
    const job = this.runner?.job(f.id);
    const out: FactoryWikiFloor = { history: [], fetchedAt: 0, ...(job ? { job } : {}) };
    if ('why' in where) return { ...out, why: where.why };
    const latest = this.slice.runs.find((r) => sameRepo(r.repoUrl, where.repoUrl));
    const h = this.histories.get(f.id);
    const history = h && sameRepo(h.repoUrl, where.repoUrl) ? h : undefined;
    const newest = [latest, history?.runs[0]].filter((r): r is FactoryWikiRun => !!r).sort((a, b) => b.createdAt - a.createdAt)[0];
    return {
      ...out,
      repoUrl: latest?.repoUrl ?? where.repoUrl,
      ...(newest ? { latest: newest } : {}),
      history: history?.runs ?? [],
      fetchedAt: history?.fetchedAt ?? 0,
      ...(history?.noAccess ? { noAccess: history.noAccess } : {}),
    };
  }

  /** Reads a floor's history: on every poll for the floors that have a run, and when asked. */
  private async readHistory(api: FactoryApi, f: WikiFloorDef, force: boolean) {
    const where = wikiRepoOf(f.repo);
    if ('why' in where) return;
    const latest = this.slice.runs.find((r) => sameRepo(r.repoUrl, where.repoUrl));
    const known = this.histories.get(f.id);
    // Nothing on Factory for it, and nothing before: there's no history to read.
    if (!force && !latest && !known?.runs.length) return;
    const repoUrl = latest?.repoUrl ?? where.repoUrl;
    let r: unknown;
    try {
      r = await api.get(`/wiki/history/${encodeURIComponent(repoUrl)}`);
    } catch (err) {
      // A repository Factory's integration doesn't cover: not a failed read, a fact about the floor.
      if (!(err instanceof FactoryError) || err.status !== 403) throw err;
      this.histories.set(f.id, { repoUrl, runs: [], fetchedAt: this.now(), noAccess: err.detail || err.message });
      return;
    }
    this.histories.set(f.id, { repoUrl, runs: runsOf(r).slice(0, WIKI_HISTORY_MAX), fetchedAt: this.now() });
  }

  async poll(api: FactoryApi): Promise<void> {
    const runs = runsOf(await api.wikiRuns());
    this.slice = { ...this.slice, runs };
    const floors = this.floors().slice(0, HISTORY_FLOORS);
    const failed: string[] = [];
    await Promise.all(
      floors.map((f) =>
        this.readHistory(api, f, false).catch((err: Error) => {
          if (err instanceof FactoryError && err.status === 401) throw err;
          failed.push(`${f.name}: ${err.message}`);
        }),
      ),
    );
    this.set({ runs, fetchedAt: this.now(), error: failed.length ? `Couldn’t read the history of ${failed.join('; ')}` : undefined });
  }

  reset() {
    this.histories.clear();
    this.pages.clear();
    this.trees.clear();
    super.reset();
  }

  private async run(api: FactoryApi, id: string): Promise<FactoryWikiRunDetail> {
    const cached = this.trees.get(id);
    if (cached) return cached;
    const run = wikiRunDetailOf(await api.get(`/wiki/${encodeURIComponent(id)}`));
    if (!run) throw notFound('Factory sent no run');
    this.trees.set(id, run);
    return run;
  }

  /**
   * GET /wiki/{id}/export, as a download. Factory may answer with the .zip itself or with a link
   * to it (`{url}`, a short-lived signed URL, fetched without the key).
   */
  private async export(id: string): Promise<FactoryDownload> {
    const key = this.opts.key?.();
    if (!key) throw new HttpError(409, 'The office’s Factory key isn’t usable now.');
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const url = new URL(`/api/v0/wiki/${encodeURIComponent(id)}/export`, this.opts.base ?? FACTORY_API);
    const scrub = (s: string) => redact(s, [key]);
    const get = async (u: URL | string, auth: boolean) => {
      try {
        return await fetchImpl(u, {
          headers: auth ? { authorization: `Bearer ${key}`, accept: 'application/zip, application/json' } : {},
          redirect: auth ? 'manual' : 'follow',
          signal: AbortSignal.timeout(120_000),
        });
      } catch (err) {
        throw new FactoryError(scrub(`Couldn’t reach Factory for the export (${(err as Error).message}).`), 0);
      }
    };
    let res = await get(url, true);
    // A redirect to storage: follow it without the key.
    const to = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && to) res = await get(new URL(to, url), false);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let said = '';
      try {
        const b = JSON.parse(text) as { detail?: unknown; title?: unknown };
        said = typeof b.detail === 'string' ? b.detail : typeof b.title === 'string' ? b.title : '';
      } catch {
        said = '';
      }
      throw new FactoryError(scrub(said ? `${said} (${res.status})` : `Factory answered ${res.status} for the export.`), res.status);
    }
    if (/json/i.test(res.headers.get('content-type') ?? '')) {
      const b = (await res.json().catch(() => null)) as { url?: unknown } | null;
      if (typeof b?.url !== 'string' || !/^https:\/\//.test(b.url)) throw new HttpError(502, 'Factory sent no export to download.');
      res = await get(b.url, false);
      if (!res.ok) throw new HttpError(502, `The export’s download answered ${res.status}.`);
    }
    if (!res.body) throw new HttpError(502, 'Factory sent an empty export.');
    const size = Number(res.headers.get('content-length'));
    const run = this.slice.runs.find((r) => r.id === id) ?? [...this.histories.values()].flatMap((h) => h.runs).find((r) => r.id === id);
    const name = `${(run?.repo ?? 'autowiki').replace(/\//g, '-')}-wiki${run?.commitHash ? `-${run.commitHash.slice(0, 7)}` : ''}.zip`;
    return new FactoryDownload(name, 'application/zip', Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>), Number.isFinite(size) && size > 0 ? size : undefined);
  }

  private patchRun(id: string, patch: Partial<FactoryWikiRun>) {
    const fix = (list: FactoryWikiRun[]) => list.map((r) => (r.id === id ? { ...r, ...patch } : r));
    for (const [k, h] of this.histories) this.histories.set(k, { ...h, runs: fix(h.runs) });
    this.set({ runs: fix(this.slice.runs) });
  }

  private forgetRun(id: string) {
    for (const [k, h] of this.histories) this.histories.set(k, { ...h, runs: h.runs.filter((r) => r.id !== id) });
    this.pages.dropWhere((k) => k.startsWith(`${id}/`));
    this.trees.dropWhere((k) => k === id);
    this.set({ runs: this.slice.runs.filter((r) => r.id !== id) });
  }

  /** A job moved on: its state goes out now, its output lines at most once a second. */
  private jobChanged(what: 'state' | 'lines') {
    if (what === 'state') {
      if (this.linesTimer) clearTimeout(this.linesTimer);
      this.linesTimer = undefined;
      this.host.changed();
      return;
    }
    if (this.linesTimer) return;
    this.linesTimer = setTimeout(() => {
      this.linesTimer = undefined;
      this.host.changed();
    }, LINES_MS);
    this.linesTimer.unref?.();
  }

  /** The office is stopping. */
  stop() {
    this.runner?.stopAll();
    if (this.linesTimer) clearTimeout(this.linesTimer);
    if (this.afterUpload) clearTimeout(this.afterUpload);
  }
}

import { randomUUID } from 'node:crypto';
import {
  CI_RUNS_MAX,
  ciEditBody,
  ciEditProblem,
  ciEditResultOf,
  ciJobOf,
  ciRepositoryOf,
  ciRunOf,
  emptyCi,
  runTime,
  workflowOf,
  type CiEditRequest,
  type CiEditResult,
  type CiRepository,
  type FactoryCiJob,
  type FactoryCiRun,
  type FactoryCiState,
  type FactoryCiWorkflow,
} from '../../shared/factory-ci.js';
import { FactoryError, type FactoryApi } from './api.js';
import { HttpError, SliceFeature, badRequest, str, type FactoryRoute, type FeatureHost } from './feature.js';

/** How long the repositories list (about a hundred) is kept before it's asked for again. */
export const REPOSITORIES_TTL_MS = 10 * 60_000;
/** After an edit, the jobs are read every fastInterval for this long, to see its pull request land. */
export const AFTER_EDIT_MS = 3 * 60_000;
/** The scan's own cache, when it doesn't say (it says 30 minutes). */
const SCAN_TTL_MS = 30 * 60_000;
/** Opening a pull request takes Factory a few seconds; this is for a slow one. */
const EDIT_TIMEOUT_MS = 60_000;

/**
 * CI automations: whether Factory's GitHub integration is connected and the accounts it sees, the
 * Droid workflows its scan found, their recent runs, and the workflow pull requests opened through
 * Factory. Owners, runs and jobs are read every poll; the scan only once its own cache
 * (`cacheTtlMs`) has run out, or on Rescan. Its routes list the repositories a workflow can go to,
 * and add, change or remove one with a pull request.
 */
export class CiFeature extends SliceFeature<'ci'> {
  readonly interval = 5 * 60_000;
  readonly fastInterval = 60_000;
  /** When the scan may be read again (ms), from its cacheTtlMs. */
  private scanDue = 0;
  private editedAt = 0;
  private repositories?: { at: number; items: CiRepository[]; owner: string };

  readonly routes: readonly FactoryRoute[] = [
    {
      // The repositories Factory's GitHub app can see, for picking where a workflow goes. Kept a
      // while: it's big, and the window asks again each time it opens.
      method: 'GET',
      path: '/repositories',
      handle: async ({ api, query }) => {
        const owner = str(query.get('owner'), 100);
        const fresh = query.get('fresh') === '1';
        const now = this.now();
        const cached = this.repositories;
        if (!fresh && cached && cached.owner === owner && now - cached.at < REPOSITORIES_TTL_MS) return { repositories: cached.items, fetchedAt: cached.at };
        const r = await api.get<{ repositories?: unknown[] }>('/automations/ci/repositories', owner ? { owner } : undefined);
        const items = (Array.isArray(r?.repositories) ? r.repositories : [])
          .map(ciRepositoryOf)
          .filter((x): x is CiRepository => !!x)
          .sort((a, b) => a.fullName.localeCompare(b.fullName));
        this.repositories = { at: now, items, owner };
        return { repositories: items, fetchedAt: now };
      },
    },
    {
      // Scans the repositories again now, past the scan's cache: after a workflow PR merged, say.
      method: 'POST',
      path: '/rescan',
      handle: async ({ api }) => {
        const scan = await api.get<ScanAnswer>('/automations/ci/scan', { forceRefresh: true });
        this.applyScan(scan);
        this.set({ fetchedAt: this.now() });
        return { workflows: this.slice.workflows.length, scannedAt: this.slice.scannedAt };
      },
    },
    {
      // Adds, changes or removes a Droid workflow: Factory opens the pull request and says where.
      method: 'POST',
      path: '/edit',
      handle: async ({ api, json, by }) => {
        const req = editRequestOf(await json());
        const problem = ciEditProblem(req);
        if (problem) throw badRequest(problem);
        const body = ciEditBody(req, randomUUID());
        const path = (body.repos as { filePath: string }[])[0].filePath;
        const raw = await api.post<unknown>('/automations/ci/edit', body, { timeoutMs: EDIT_TIMEOUT_MS });
        let result: CiEditResult;
        try {
          result = ciEditResultOf(raw, req, path);
        } catch (err) {
          throw new HttpError(422, (err as Error).message);
        }
        this.editedAt = this.now();
        this.host.pollSoon();
        const verb = req.action === 'create' ? 'add' : req.action === 'edit' ? 'change' : 'remove';
        if (result.prUrl) this.host.toast(`🤖 ${by} opened a PR to ${verb} ${path.split('/').pop()} in ${req.repo}`);
        return result;
      },
    },
  ];

  constructor(
    host: FeatureHost,
    private now: () => number = Date.now,
  ) {
    super('ci', host, emptyCi);
  }

  /** Right after an edit, until its pull request shows up in the jobs. */
  busy(): boolean {
    return this.editedAt > 0 && this.now() - this.editedAt < AFTER_EDIT_MS;
  }

  reset() {
    this.scanDue = 0;
    this.editedAt = 0;
    this.repositories = undefined;
    super.reset();
  }

  /**
   * The reads go out together. One that fails keeps its part of the last good data and says why;
   * only when all of them fail (or the key is rejected) does the poll fail.
   */
  async poll(api: FactoryApi): Promise<void> {
    const now = this.now();
    const scanning = now >= this.scanDue;
    const none = Promise.resolve(undefined);
    const [owners, scan, runs, jobs] = await Promise.allSettled([api.ciOwners(), scanning ? api.ciScan() : none, api.ciRuns(), api.get<{ jobs?: unknown[] }>('/automations/ci/jobs')] as const);
    const reads = scanning ? [owners, scan, runs, jobs] : [owners, runs, jobs];
    const failures = reads.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => r.reason as Error);
    const rejected = failures.find((e) => e instanceof FactoryError && e.status === 401);
    if (rejected) throw rejected;
    if (failures.length === reads.length) throw failures[0];
    const patch: Partial<FactoryCiState> = { fetchedAt: now, error: failures.length ? failures[0].message : undefined };
    const connected = [owners, scan, runs].map((r) => (r.status === 'fulfilled' ? r.value?.integration?.connected : undefined)).find((c) => typeof c === 'boolean');
    if (typeof connected === 'boolean') patch.github = connected;
    if (owners.status === 'fulfilled') {
      patch.owners = (Array.isArray(owners.value?.owners) ? owners.value.owners : [])
        .filter((o): o is { login: string; type?: unknown } => !!o && typeof (o as { login?: unknown }).login === 'string')
        .map((o) => ({ login: o.login, type: typeof o.type === 'string' ? o.type : 'user' }));
    }
    if (scan.status === 'fulfilled' && scan.value) this.applyScan(scan.value, patch);
    if (runs.status === 'fulfilled') {
      patch.runs = (Array.isArray(runs.value?.runs) ? runs.value.runs : [])
        .map(ciRunOf)
        .filter((r): r is FactoryCiRun => !!r)
        .sort((a, b) => runTime(b) - runTime(a))
        .slice(0, CI_RUNS_MAX);
    }
    if (jobs.status === 'fulfilled') {
      patch.jobs = (Array.isArray(jobs.value?.jobs) ? jobs.value.jobs : [])
        .map(ciJobOf)
        .filter((j): j is FactoryCiJob => !!j)
        .sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0));
    }
    this.set(patch);
  }

  /** Takes in a scan's workflows, and waits out its cache before reading it again. */
  private applyScan(scan: ScanAnswer, patch?: Partial<FactoryCiState>) {
    const workflows = (Array.isArray(scan?.workflows) ? scan.workflows : []).map(workflowOf).filter((w): w is FactoryCiWorkflow => !!w);
    const ttl = typeof scan?.cacheTtlMs === 'number' && scan.cacheTtlMs > 0 ? scan.cacheTtlMs : SCAN_TTL_MS;
    // Never sooner than a normal poll, and never later than an hour.
    this.scanDue = this.now() + Math.min(60 * 60_000, Math.max(this.interval, ttl));
    const into: Partial<FactoryCiState> = patch ?? {};
    into.workflows = workflows;
    if (typeof scan?.scannedAt === 'number') into.scannedAt = scan.scannedAt;
    if (!patch) this.set(into);
  }
}

type ScanAnswer = Awaited<ReturnType<FactoryApi['ciScan']>> & { cacheTtlMs?: number };

/** The window's request, from its JSON body: only the fields it may send, trimmed and capped. */
export function editRequestOf(body: unknown): CiEditRequest {
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const action = str(b.action, 10) as CiEditRequest['action'];
  const req: CiEditRequest = { action, repo: str(b.repo, 200) };
  const path = str(b.path, 200);
  if (path) req.path = path;
  const template = str(b.template, 20);
  if (template) req.template = template as CiEditRequest['template'];
  const name = str(b.name, 80);
  if (name) req.name = name;
  if (Array.isArray(b.events)) req.events = [...new Set(b.events.filter((e): e is string => typeof e === 'string').slice(0, 10))] as CiEditRequest['events'];
  const cron = str(b.cron, 100);
  if (cron) req.cron = cron;
  const model = str(b.model, 100);
  if (model) req.model = model;
  const effort = str(b.effort, 20);
  if (effort) req.effort = effort;
  const prompt = str(b.prompt, 4000);
  if (prompt) req.prompt = prompt;
  const depth = str(b.depth, 10);
  if (depth) req.depth = depth as CiEditRequest['depth'];
  if (b.security === true) req.security = true;
  return req;
}

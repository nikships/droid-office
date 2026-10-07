import { ciRunOf, emptyCi, workflowOf, type FactoryCiRun, type FactoryCiState, type FactoryCiWorkflow } from '../../shared/factory-ci.js';
import { FactoryError, type FactoryApi } from './api.js';
import { SliceFeature, type FactoryRoute, type FeatureHost } from './feature.js';

/** CI automations: the GitHub accounts Factory sees, the Droid workflows its scan found, and their recent runs. */
export class CiFeature extends SliceFeature<'ci'> {
  readonly interval = 5 * 60_000;
  readonly fastInterval = 60_000;

  readonly routes: readonly FactoryRoute[] = [
    {
      // The repositories Factory's GitHub app can see, for picking where a workflow goes.
      method: 'GET',
      path: '/repositories',
      handle: async ({ api }) => {
        const r = await api.get<{ repositories?: unknown[] }>('/automations/ci/repositories');
        return { repositories: Array.isArray(r?.repositories) ? r.repositories : [] };
      },
    },
  ];

  constructor(
    host: FeatureHost,
    private now: () => number = Date.now,
  ) {
    super('ci', host, emptyCi);
  }

  /**
   * The three reads go out together. One that fails keeps its part of the last good data and says
   * why; only when all three fail (or the key is rejected) does the poll fail.
   */
  async poll(api: FactoryApi): Promise<void> {
    const [owners, scan, runs] = await Promise.allSettled([api.ciOwners(), api.ciScan(), api.ciRuns()]);
    const failures = [owners, scan, runs].filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => r.reason as Error);
    const rejected = failures.find((e) => e instanceof FactoryError && e.status === 401);
    if (rejected) throw rejected;
    if (failures.length === 3) throw failures[0];
    const patch: Partial<FactoryCiState> = { fetchedAt: this.now(), error: failures.length ? failures[0].message : undefined };
    const connected = [owners, scan, runs].map((r) => (r.status === 'fulfilled' ? r.value?.integration?.connected : undefined)).find((c) => typeof c === 'boolean');
    if (typeof connected === 'boolean') patch.github = connected;
    if (owners.status === 'fulfilled') {
      patch.owners = (Array.isArray(owners.value?.owners) ? owners.value.owners : [])
        .filter((o): o is { login: string; type?: unknown } => !!o && typeof (o as { login?: unknown }).login === 'string')
        .map((o) => ({ login: o.login, type: typeof o.type === 'string' ? o.type : 'user' }));
    }
    if (scan.status === 'fulfilled') {
      patch.workflows = (Array.isArray(scan.value?.workflows) ? scan.value.workflows : []).map(workflowOf).filter((w): w is FactoryCiWorkflow => !!w);
      if (typeof scan.value?.scannedAt === 'number') patch.scannedAt = scan.value.scannedAt;
    }
    if (runs.status === 'fulfilled') patch.runs = (Array.isArray(runs.value?.runs) ? runs.value.runs : []).map(ciRunOf).filter((r): r is FactoryCiRun => !!r);
    this.set(patch);
  }
}

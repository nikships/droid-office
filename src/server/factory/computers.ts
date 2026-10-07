import { computerOf, emptyComputers, metricsOf, type FactoryComputer, type FactoryComputerMetrics, type FactoryComputersState } from '../../shared/factory-computers.js';
import type { FactoryApi } from './api.js';
import { SliceFeature, badRequest, type FactoryRoute, type FeatureHost } from './feature.js';

/** Metrics are 5-minute samples, so asking more often than this finds nothing new. */
const METRICS_EVERY_MS = 3 * 60_000;
/** The window each metrics read asks for, enough for the slice's history. */
const METRICS_WINDOW_MS = 2 * 60 * 60_000;
/** The provider list hardly ever changes. */
const PROVIDERS_EVERY_MS = 30 * 60_000;
/** The longest history the metrics route answers with (Factory keeps about four days). */
const MAX_HOURS = 96;

/** Droid Computers: the list every minute, and each managed computer's load every few. */
export class ComputersFeature extends SliceFeature<'computers'> {
  readonly interval = 60_000;
  readonly fastInterval = 15_000;
  private providersAt = 0;

  readonly routes: readonly FactoryRoute[] = [
    {
      // A managed computer's samples over a longer window than the slice keeps (?hours=, 1-96).
      method: 'GET',
      path: '/:id/metrics',
      handle: async ({ api, params, query }) => {
        const hours = Number(query.get('hours') ?? 24);
        if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_HOURS) throw badRequest(`hours is 1 to ${MAX_HOURS}`);
        const raw = await api.metrics(params.id, new Date(this.now() - hours * 3600_000));
        return { samples: metricsOf(raw, this.now(), Number.POSITIVE_INFINITY).history };
      },
    },
  ];

  constructor(
    host: FeatureHost,
    private now: () => number = Date.now,
  ) {
    super('computers', host, emptyComputers);
  }

  busy(): boolean {
    return this.slice.items.some((c) => c.status === 'provisioning');
  }

  async poll(api: FactoryApi): Promise<void> {
    const wantProviders = this.now() - this.providersAt >= PROVIDERS_EVERY_MS;
    const [list, providers] = await Promise.all([api.computers(), wantProviders ? api.providers().catch(() => undefined) : undefined]);
    const items = (Array.isArray(list?.computers) ? list.computers : []).map(computerOf).filter((c): c is FactoryComputer => !!c);
    const metrics = await this.readMetrics(api, items);
    const patch: Partial<FactoryComputersState> = { items, metrics, fetchedAt: this.now(), error: undefined };
    if (providers) {
      this.providersAt = this.now();
      patch.providers = (providers.providers ?? []).filter((p): p is string => typeof p === 'string');
    }
    this.set(patch);
  }

  /** Each managed computer's samples, read again once they're METRICS_EVERY_MS old; a failed read keeps the last ones with the error. */
  private async readMetrics(api: FactoryApi, items: FactoryComputer[]): Promise<Record<string, FactoryComputerMetrics>> {
    const out: Record<string, FactoryComputerMetrics> = {};
    const now = this.now();
    await Promise.all(
      items
        .filter((c) => c.managed)
        .map(async (c) => {
          const last = this.slice.metrics[c.id];
          if (last && now - last.fetchedAt < METRICS_EVERY_MS) {
            out[c.id] = last;
            return;
          }
          try {
            out[c.id] = metricsOf(await api.metrics(c.id, new Date(now - METRICS_WINDOW_MS)), now);
          } catch (err) {
            out[c.id] = { ...(last ?? { history: [] }), fetchedAt: now, error: (err as Error).message };
          }
        }),
    );
    return out;
  }
}

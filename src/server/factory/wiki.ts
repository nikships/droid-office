import { emptyWiki, wikiRunOf, type FactoryWikiRun } from '../../shared/factory-wiki.js';
import type { FactoryApi } from './api.js';
import { SliceFeature, badRequest, type FactoryRoute, type FeatureHost } from './feature.js';

/** AutoWiki: the latest wiki run of each repository. */
export class WikiFeature extends SliceFeature<'wiki'> {
  readonly interval = 5 * 60_000;
  readonly fastInterval = 60_000;

  readonly routes: readonly FactoryRoute[] = [
    {
      // Whether the key may upload a wiki for a repository (?repoUrl=).
      method: 'GET',
      path: '/upload-access',
      handle: async ({ api, query }) => {
        const repoUrl = query.get('repoUrl')?.trim();
        if (!repoUrl) throw badRequest('Say which repository: ?repoUrl=https://github.com/owner/repo');
        const r = await api.get<{ allowed?: unknown }>('/wiki/upload-access', { repoUrl });
        return { allowed: r?.allowed === true };
      },
    },
  ];

  constructor(
    host: FeatureHost,
    private now: () => number = Date.now,
  ) {
    super('wiki', host, emptyWiki);
  }

  async poll(api: FactoryApi): Promise<void> {
    const r = await api.wikiRuns();
    const runs = (Array.isArray(r?.wikiRuns) ? r.wikiRuns : []).map(wikiRunOf).filter((w): w is FactoryWikiRun => !!w);
    this.set({ runs, fetchedAt: this.now(), error: undefined });
  }
}

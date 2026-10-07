import { SESSIONS_LIMIT, emptySessions, sessionOf, type FactorySession } from '../../shared/factory-sessions.js';
import type { FactoryApi } from './api.js';
import { SliceFeature, notFound, type FactoryRoute, type FeatureHost } from './feature.js';

/** Droid sessions: the newest page of the account's sessions. */
export class SessionsFeature extends SliceFeature<'sessions'> {
  readonly interval = 90_000;
  readonly fastInterval = 20_000;

  readonly routes: readonly FactoryRoute[] = [
    {
      // One session as GET /sessions/{id} has it, with its `factoryCredits`.
      method: 'GET',
      path: '/:id',
      handle: async ({ api, params }) => {
        const raw = await api.get<Record<string, unknown>>(`/sessions/${encodeURIComponent(params.id)}`);
        const session = sessionOf(raw);
        if (!session) throw notFound('No such session');
        return { session, ...(typeof raw?.factoryCredits === 'number' ? { credits: raw.factoryCredits } : {}) };
      },
    },
  ];

  constructor(
    host: FeatureHost,
    private now: () => number = Date.now,
  ) {
    super('sessions', host, emptySessions);
  }

  /** A session on a Factory computer is running: its window and board want it fresh. */
  busy(): boolean {
    return this.slice.items.some((s) => s.status === 'running' && !!s.computerId);
  }

  async poll(api: FactoryApi): Promise<void> {
    const r = await api.sessions(SESSIONS_LIMIT);
    const items = (Array.isArray(r?.sessions) ? r.sessions : []).map(sessionOf).filter((s): s is FactorySession => !!s);
    this.set({ items, hasMore: !!r?.pagination?.hasMore, fetchedAt: this.now(), error: undefined });
  }
}

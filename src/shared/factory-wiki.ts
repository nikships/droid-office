// AutoWiki: the latest wiki run of each repository the account has one for. Read by
// src/server/factory/wiki.ts. The API's schema for these is empty and the account had no runs when
// this was written, so a run keeps the fields droid itself reads (wikiRunId, repoUrl) plus the ones
// it most likely has, and `raw` for whatever else is there.

export interface FactoryWikiRun {
  id: string;
  repoUrl: string;
  status?: string;
  createdAt?: number;
  updatedAt?: number;
  /** The run as the API sent it, for whoever needs more than the fields above. */
  raw: Record<string, unknown>;
}

export interface FactoryWikiState {
  runs: FactoryWikiRun[];
  fetchedAt: number;
  error?: string;
}

export function emptyWiki(): FactoryWikiState {
  return { runs: [], fetchedAt: 0 };
}

/** ms from a number or an ISO string. */
const timeOf = (v: unknown) => {
  const t = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : undefined;
};

/** A run from GET /wiki's `wikiRuns`. */
export function wikiRunOf(raw: unknown): FactoryWikiRun | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const id = typeof r.wikiRunId === 'string' ? r.wikiRunId : typeof r.id === 'string' ? r.id : '';
  if (!id) return undefined;
  const createdAt = timeOf(r.createdAt);
  const updatedAt = timeOf(r.updatedAt ?? r.completedAt);
  return {
    id,
    repoUrl: typeof r.repoUrl === 'string' ? r.repoUrl : '',
    ...(typeof r.status === 'string' ? { status: r.status } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    raw: r,
  };
}

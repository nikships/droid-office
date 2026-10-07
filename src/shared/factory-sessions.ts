// Droid sessions: the account's recent sessions, the office's own workers' among them
// (WorkerInfo.sessionId matches FactorySession.id). Read by src/server/factory/sessions.ts.
// Credits (`factoryCredits`) are only on GET /sessions/{id}, so they aren't in this first slice.

export type FactorySessionStatus = 'idle' | 'pending' | 'running';

/** Something a session made: a pull request, mostly. */
export interface FactorySessionArtifact {
  id: string;
  kind: string;
  url?: string;
  /** What the session did with it (`create`, `merge`…). */
  action?: string;
  /** Like `owner/repo#72`. */
  externalId?: string;
}

export interface FactorySession {
  id: string;
  title: string;
  status: FactorySessionStatus | string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  /** The Factory computer it runs on; none for a session on a machine of the owner's. */
  computerId?: string;
  /** The session that started it, for a Task subagent. */
  parentId?: string;
  model?: string;
  effort?: string;
  artifacts: FactorySessionArtifact[];
}

/** How many sessions the slice keeps (one page of GET /sessions). */
export const SESSIONS_LIMIT = 50;
/** The longest title the slice keeps; Factory titles a session with its first prompt, which can be long. */
export const SESSION_TITLE_MAX = 200;

export interface FactorySessionsState {
  items: FactorySession[];
  /** Factory has more than `items`. */
  hasMore: boolean;
  fetchedAt: number;
  error?: string;
}

export function emptySessions(): FactorySessionsState {
  return { items: [], hasMore: false, fetchedAt: 0 };
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const optStr = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

function artifactOf(raw: unknown): FactorySessionArtifact | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const id = optStr(r.id) ?? optStr(r.externalId) ?? optStr(r.url);
  if (!id) return undefined;
  return {
    id,
    kind: optStr(r.kind) ?? 'artifact',
    ...(optStr(r.url) ? { url: optStr(r.url) } : {}),
    ...(optStr(r.action) ? { action: optStr(r.action) } : {}),
    ...(optStr(r.externalId) ? { externalId: optStr(r.externalId) } : {}),
  };
}

/** A session from GET /sessions (or GET /sessions/{id}). */
export function sessionOf(raw: unknown): FactorySession | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const id = optStr(r.sessionId);
  if (!id) return undefined;
  const title = typeof r.title === 'string' ? r.title : '';
  const settings = r.sessionSettings && typeof r.sessionSettings === 'object' ? (r.sessionSettings as Record<string, unknown>) : {};
  const completedAt = num(r.completedAt);
  return {
    id,
    title: title.length > SESSION_TITLE_MAX ? `${title.slice(0, SESSION_TITLE_MAX - 1)}…` : title,
    status: optStr(r.status) ?? 'idle',
    messageCount: num(r.messageCount),
    createdAt: num(r.createdAt),
    updatedAt: num(r.updatedAt),
    ...(completedAt ? { completedAt } : {}),
    ...(optStr(r.computerId) ? { computerId: optStr(r.computerId) } : {}),
    ...(optStr(r.parent_session_id) ? { parentId: optStr(r.parent_session_id) } : {}),
    ...(optStr(settings.model) ? { model: optStr(settings.model) } : {}),
    ...(optStr(settings.reasoningEffort) ? { effort: optStr(settings.reasoningEffort) } : {}),
    artifacts: (Array.isArray(r.artifacts) ? r.artifacts : []).map(artifactOf).filter((a): a is FactorySessionArtifact => !!a),
  };
}

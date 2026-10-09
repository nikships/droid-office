import path from 'node:path';
import {
  SESSIONS_KEPT,
  SESSIONS_LIMIT,
  SESSION_AUTONOMY,
  SESSION_EFFORTS,
  SESSION_IMAGE_TYPES,
  SESSION_MODES,
  emptySessions,
  messageOf,
  sessionOf,
  type FactoryMessage,
  type FactoryOfficeSession,
  type FactorySession,
} from '../../shared/factory-sessions.js';
import { FactoryError, type FactoryApi } from './api.js';
import { CreditLedger } from './credits.js';
import { HttpError, SliceFeature, badRequest, notFound, str, type FactoryRoute, type FeatureHost } from './feature.js';
import { NEW_SESSION_MS, alreadyGone, isMissing, whileNew, type NewSessionOptions } from './new-session.js';

/** One of the office's own droids with a Droid session, on any floor (server.ts lists them). */
export interface OfficeSessionRef {
  sessionId: string;
  workerId: string;
  name: string;
  floor?: string;
  color?: string;
  /** It's working right now, so its credits are worth reading again sooner. */
  working?: boolean;
  /** When the droid was made (ms): a cloud droid's session was made just before it. */
  createdAt?: number;
}

export interface SessionsOptions {
  /** The office's .droid-office, where the credits ledger is kept; none keeps it in memory. */
  dataDir?: string;
  officeSessions?: () => OfficeSessionRef[];
  now?: () => number;
  /** How a write to a just-made session tries again after a 404 (new-session.ts); for tests. */
  retry?: Omit<NewSessionOptions, 'now'>;
}

/** Reads of GET /sessions/{id} at once, at most. */
const DETAIL_CONCURRENCY = 3;
/** Reads of GET /sessions/{id} in one poll, at most: the rest wait for the next one. */
const DETAIL_BUDGET = 24;
/** A running session's credits and status are read again after this long. */
const RUNNING_STALE_MS = 15_000;
/** A working office droid's, after this long. */
const WORKING_STALE_MS = 60_000;
/** The second page of the list is read again after this long (the first, every poll). */
const PAGE2_MS = 10 * 60_000;
/** After a failed read of a session, wait this long before asking again (a 404, longer). */
const FAILED_MS = 2 * 60_000;
const MISSING_MS = 15 * 60_000;
/** The biggest message body: a few pictures as base64. */
const MESSAGE_BODY_MAX = 16 * 1024 * 1024;
const IMAGES_MAX = 6;
const TEXT_MAX = 100_000;
const NOT_YET = 'Factory can’t find that session yet: it was only just made. Try again in a few seconds.';

interface Detail {
  session: FactorySession;
  /** When the office read it (ms). */
  at: number;
}

const enc = encodeURIComponent;
const listOf = (r: { sessions?: unknown[] } | undefined) => (Array.isArray(r?.sessions) ? r.sessions : []).map(sessionOf).filter((s): s is FactorySession => !!s);
const live = (s: { status: string }) => s.status === 'running' || s.status === 'pending';

/** `v` when it's one of `allowed`, undefined when it's missing or '', a 400 otherwise. */
function oneOf<T extends string>(v: unknown, allowed: readonly T[], what: string): T | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T;
  throw badRequest(`${what} is one of ${allowed.join(', ')}`);
}

/** The session settings a request may set: model, reasoning effort, interaction mode and autonomy. */
function settingsOf(body: Record<string, unknown>): Record<string, string> {
  const model = str(body.model, 200);
  if (model && /[\s\p{Cc}]/u.test(model)) throw badRequest('That isn’t a model id');
  const out: Record<string, string | undefined> = {
    model: model || undefined,
    reasoningEffort: oneOf(body.reasoningEffort, SESSION_EFFORTS, 'reasoningEffort'),
    interactionMode: oneOf(body.interactionMode, SESSION_MODES, 'interactionMode'),
    autonomyLevel: oneOf(body.autonomyLevel, SESSION_AUTONOMY, 'autonomyLevel'),
  };
  return Object.fromEntries(Object.entries(out).filter((e): e is [string, string] => !!e[1]));
}

/** A message to send, as POST /sessions/{id}/messages takes it: text and, optionally, base64 pictures. */
function messageBody(body: Record<string, unknown>, field = 'text'): { text: string; images?: { type: 'base64'; data: string; mediaType: string }[] } | undefined {
  const text = typeof body[field] === 'string' ? (body[field] as string).slice(0, TEXT_MAX) : '';
  const raw = Array.isArray(body.images) ? body.images : [];
  if (raw.length > IMAGES_MAX) throw badRequest(`At most ${IMAGES_MAX} pictures`);
  const images = raw.map((i) => {
    const o = (i && typeof i === 'object' ? i : {}) as { data?: unknown; mediaType?: unknown };
    const mediaType = oneOf(o.mediaType, SESSION_IMAGE_TYPES, 'mediaType');
    if (!mediaType || typeof o.data !== 'string' || !o.data || !/^[A-Za-z0-9+/=\s]+$/.test(o.data)) throw badRequest('A picture is {data: base64, mediaType}');
    return { type: 'base64' as const, data: o.data.replace(/\s+/g, ''), mediaType };
  });
  if (!text.trim() && !images.length) return undefined;
  return { text: text.trim() ? text : '(see the picture)', ...(images.length ? { images } : {}) };
}

/**
 * Droid sessions: the account's last ~100 sessions (two pages of GET /sessions), each one's
 * credits and fresh status from GET /sessions/{id} (cached by its updatedAt, read a few at a time,
 * running ones and the office's own droids' first), the credits ledger (credits.ts), and the
 * routes the Sessions window and cloud droids drive a session with (docs/factory.md).
 */
export class SessionsFeature extends SliceFeature<'sessions'> {
  readonly interval = 90_000;
  readonly fastInterval = 20_000;
  private now: () => number;
  private details = new Map<string, Detail>();
  private failedUntil = new Map<string, number>();
  private page2?: { at: number; items: FactorySession[]; hasMore: boolean };
  private listed: FactorySession[] = [];
  private deleted = new Set<string>();
  /** The sessions the office made itself, and when (by its own clock): Factory's createdAt is when it started making one, which takes a while. */
  private madeHere = new Map<string, number>();
  readonly ledger: CreditLedger;

  readonly routes: readonly FactoryRoute[] = [
    {
      // Older sessions than the slice has: ?cursor= from the last answer, ?limit= (1-100).
      method: 'GET',
      path: '',
      handle: async ({ api, query }) => {
        const limit = Number(query.get('limit') ?? SESSIONS_LIMIT);
        const r = await api.sessions(Number.isFinite(limit) ? limit : SESSIONS_LIMIT, query.get('cursor') || undefined);
        return { sessions: listOf(r).map((s) => this.merged(s)), hasMore: !!r?.pagination?.hasMore, nextCursor: r?.pagination?.nextCursor ?? undefined };
      },
    },
    {
      // Starts a session on a Factory computer and, with `prompt`, sends it its first message.
      method: 'POST',
      path: '',
      bodyMax: MESSAGE_BODY_MAX,
      handle: async ({ api, json, by }) => {
        const body = (await json<Record<string, unknown>>()) ?? {};
        const computerId = str(body.computerId, 200);
        if (!computerId) throw badRequest('Say which computer (computerId)');
        const cwd = str(body.cwd, 4096);
        const settings = settingsOf(body);
        const first = messageBody(body, 'prompt');
        const raw = await api.post<unknown>('/sessions', { computerId, ...(cwd ? { cwd } : {}), ...(Object.keys(settings).length ? { sessionSettings: settings } : {}) });
        const session = sessionOf(raw);
        if (!session) throw new FactoryError('Factory started a session but didn’t say which.', 502);
        this.made(session.id);
        this.remember(session);
        this.host.toast(`🛰️ ${by} started a Droid session on ${str(body.computerName, 80) || 'a Factory computer'}`);
        let sent: { messageId?: string; status?: string; error?: string } = {};
        if (first) {
          try {
            const r = await this.whileNew(session.id, () => api.post<{ messageId?: string; status?: string }>(`/sessions/${enc(session.id)}/messages`, first));
            sent = { messageId: r?.messageId, status: r?.status };
          } catch (err) {
            // The session is there either way: answer with it, and say the prompt didn't go.
            sent = { error: (err as Error).message };
          }
        }
        this.host.pollSoon();
        return { session: this.merged(session), ...sent };
      },
    },
    {
      // One session as GET /sessions/{id} has it, with its credits.
      method: 'GET',
      path: '/:id',
      handle: async ({ api, params }) => {
        const session = await this.readDetail(api, params.id, true);
        if (!session) throw notFound('No such session');
        this.publish();
        this.ledger.save();
        return { session: this.merged(session), ...(session.credits !== undefined ? { credits: session.credits } : {}) };
      },
    },
    {
      // Changes its settings: model, reasoningEffort, interactionMode, autonomyLevel.
      method: 'PATCH',
      path: '/:id',
      handle: async ({ api, params, json }) => {
        const settings = settingsOf((await json<Record<string, unknown>>()) ?? {});
        if (!Object.keys(settings).length) throw badRequest('Nothing to change');
        const session = sessionOf(await this.whileNew(params.id, () => api.patch(`/sessions/${enc(params.id)}`, { sessionSettings: settings })));
        if (!session) throw notFound('No such session');
        this.remember(session);
        return { session: this.merged(session) };
      },
    },
    {
      // Deletes it (Factory keeps it out of every list from then on). One Factory can't find is gone
      // already, unless it was only just made: then it may still turn up, and the answer says so.
      method: 'DELETE',
      path: '/:id',
      handle: async ({ api, params, by }) => {
        const asked = this.now();
        try {
          await this.whileNew(params.id, () => api.delete(`/sessions/${enc(params.id)}`));
        } catch (err) {
          if (!alreadyGone(err, this.madeAt(params.id), asked)) throw isMissing(err) ? new HttpError(409, NOT_YET) : err;
        }
        const title = this.titleOf(params.id);
        this.forget(params.id);
        this.host.toast(`🗑️ ${by} deleted the Droid session ${title ? `“${title.slice(0, 60)}”` : params.id.slice(0, 8)}`);
        return { ok: true };
      },
    },
    {
      // A page of its messages, oldest first: ?limit= (1-100, 30 by default), ?cursor= for the page
      // before (`nextCursor` of the last answer), ?role=user|assistant|tool.
      method: 'GET',
      path: '/:id/messages',
      handle: async ({ api, params, query }) => {
        const limit = Math.max(1, Math.min(100, Math.round(Number(query.get('limit') ?? 30)) || 30));
        const role = oneOf(query.get('role') ?? undefined, ['user', 'assistant', 'tool'] as const, 'role');
        const r = await api.get<{ messages?: unknown[]; pagination?: { hasMore?: boolean; nextCursor?: string | null } }>(`/sessions/${enc(params.id)}/messages`, { limit, cursor: query.get('cursor') || undefined, role });
        const messages = (Array.isArray(r?.messages) ? r.messages : []).map(messageOf).filter((m): m is FactoryMessage => !!m);
        messages.sort((a, b) => (a.seq !== undefined && b.seq !== undefined ? a.seq - b.seq : a.createdAt - b.createdAt));
        const more = !!r?.pagination?.hasMore && !!r.pagination.nextCursor;
        return { messages, hasMore: more, ...(more ? { nextCursor: r.pagination!.nextCursor } : {}) };
      },
    },
    {
      // Sends it a message: {text, images?: [{data (base64), mediaType}]}. Queued behind its turn if it's running.
      method: 'POST',
      path: '/:id/messages',
      bodyMax: MESSAGE_BODY_MAX,
      handle: async ({ api, params, json }) => {
        const msg = messageBody((await json<Record<string, unknown>>()) ?? {});
        if (!msg) throw badRequest('Say something (text) or attach a picture');
        const r = await this.whileNew(params.id, () => api.post<{ messageId?: string; status?: string; recipientDroidStatus?: string }>(`/sessions/${enc(params.id)}/messages`, msg));
        this.markLive(params.id);
        this.host.pollSoon();
        return { messageId: r?.messageId, status: r?.status, ...(r?.recipientDroidStatus ? { queued: r.recipientDroidStatus === 'running' } : {}) };
      },
    },
    {
      // Stops what it's doing.
      method: 'POST',
      path: '/:id/interrupt',
      handle: async ({ api, params }) => {
        const r = await this.whileNew(params.id, () => api.post<{ status?: string }>(`/sessions/${enc(params.id)}/interrupt`, {}));
        const d = this.details.get(params.id);
        if (d && r?.status) d.session = { ...d.session, status: r.status };
        this.publish();
        this.host.pollSoon();
        return { status: r?.status ?? 'idle' };
      },
    },
    {
      // Its Task subagents' sessions.
      method: 'GET',
      path: '/:id/children',
      handle: async ({ api, params }) => {
        const r = await api.get<{ sessions?: unknown[] }>(`/sessions/${enc(params.id)}/children`, { includeArtifacts: true });
        return { sessions: listOf(r).map((s) => this.merged(s)) };
      },
    },
  ];

  constructor(
    host: FeatureHost,
    private opts: SessionsOptions = {},
  ) {
    super('sessions', host, emptySessions);
    this.now = opts.now ?? Date.now;
    this.ledger = new CreditLedger(opts.dataDir ? path.join(opts.dataDir, 'factory-credits.json') : undefined, this.now);
    this.slice = { ...this.slice, credits: this.ledger.summary() };
  }

  /** A session on a Factory computer is running: its window and board want it fresh. */
  busy(): boolean {
    return this.slice.items.some((s) => live(s) && !!s.computerId);
  }

  async poll(api: FactoryApi): Promise<void> {
    // A cold list can take a minute: the office's droids show the credits the ledger kept meanwhile.
    if (!this.slice.fetchedAt) this.publish();
    const r1 = await api.sessions(SESSIONS_LIMIT);
    const now = this.now();
    let items = listOf(r1);
    let hasMore = !!r1?.pagination?.hasMore;
    const cursor = r1?.pagination?.nextCursor;
    if (hasMore && cursor) {
      if (!this.page2 || now - this.page2.at > PAGE2_MS) {
        try {
          const r2 = await api.sessions(SESSIONS_LIMIT, cursor);
          this.page2 = { at: now, items: listOf(r2), hasMore: !!r2?.pagination?.hasMore };
        } catch (err) {
          if (err instanceof FactoryError && err.status === 401) throw err;
          // The first page is what matters: keep the last second page, if any.
        }
      }
      if (this.page2) {
        const ids = new Set(items.map((s) => s.id));
        items = [...items, ...this.page2.items.filter((s) => !ids.has(s.id))].slice(0, SESSIONS_KEPT);
        hasMore = this.page2.hasMore;
      }
    } else this.page2 = undefined;
    this.listed = items;
    this.publish({ fetchedAt: now, error: undefined, hasMore });
    await this.readDetails(api);
    this.ledger.save();
  }

  reset() {
    this.details.clear();
    this.failedUntil.clear();
    this.page2 = undefined;
    this.listed = [];
    this.deleted.clear();
    this.madeHere.clear();
    this.ledger.reset();
    super.reset();
  }

  /** The sessions whose detail is due, most wanted first, at most DETAIL_BUDGET. */
  due(): string[] {
    const now = this.now();
    const office = new Map((this.opts.officeSessions?.() ?? []).map((o) => [o.sessionId, o]));
    const wanted: { id: string; rank: number; updatedAt: number }[] = [];
    const consider = (id: string, listedAt: number | undefined, listedLive: boolean) => {
      if (this.deleted.has(id) || (this.failedUntil.get(id) ?? 0) > now) return;
      const d = this.details.get(id);
      const ours = office.get(id);
      const running = listedLive || (!!d && live(d.session));
      let stale = !d || (listedAt !== undefined && listedAt > d.session.updatedAt);
      if (d && running && now - d.at >= RUNNING_STALE_MS) stale = true;
      if (d && ours?.working && now - d.at >= WORKING_STALE_MS) stale = true;
      if (!stale) return;
      wanted.push({ id, rank: running ? 0 : ours ? 1 : 2, updatedAt: listedAt ?? d?.session.updatedAt ?? 0 });
    };
    const listed = new Set<string>();
    for (const s of this.listed) {
      listed.add(s.id);
      consider(s.id, s.updatedAt, live(s));
    }
    for (const id of office.keys()) if (!listed.has(id)) consider(id, undefined, false);
    wanted.sort((a, b) => a.rank - b.rank || b.updatedAt - a.updatedAt);
    return wanted.slice(0, DETAIL_BUDGET).map((w) => w.id);
  }

  private async readDetails(api: FactoryApi) {
    const queue = this.due();
    let rejected: FactoryError | undefined;
    const worker = async () => {
      for (let id = queue.shift(); id && !rejected; id = queue.shift()) {
        try {
          await this.readDetail(api, id);
        } catch (err) {
          if (err instanceof FactoryError && err.status === 401) rejected = err;
          // Anything else is that one session's: it's tried again after a while.
        }
        this.publish();
      }
    };
    await Promise.all(Array.from({ length: DETAIL_CONCURRENCY }, worker));
    if (rejected) throw rejected;
  }

  /**
   * Session `id` was deleted (here, or as a cloud droid went home): Factory goes on listing a deleted
   * session for a while, so it's kept out of the slice from now on.
   */
  forget(id: string) {
    this.deleted.add(id);
    this.details.delete(id);
    this.madeHere.delete(id);
    this.publish();
  }

  /** Notes that the office just made session `id`. */
  private made(id: string) {
    const now = this.now();
    for (const [k, at] of this.madeHere) if (now - at >= NEW_SESSION_MS) this.madeHere.delete(k);
    this.madeHere.set(id, now);
  }

  /** When session `id` was made, as best the office knows (ms), or undefined. */
  madeAt(id: string): number | undefined {
    const at = this.madeHere.get(id) ?? this.opts.officeSessions?.().find((o) => o.sessionId === id)?.createdAt ?? this.details.get(id)?.session.createdAt ?? this.listed.find((s) => s.id === id)?.createdAt;
    return at || undefined;
  }

  /** `call` on session `id`, tried again for a while when it 404s because the session was only just made. */
  private whileNew<T>(id: string, call: () => Promise<T>): Promise<T> {
    return whileNew(this.madeAt(id), call, { now: this.now, ...this.opts.retry });
  }

  /**
   * Reads one session by itself; `strict` (a route) lets a failure through instead of noting it for
   * later, and waits out the 404s of one that was only just made.
   */
  private async readDetail(api: FactoryApi, id: string, strict = false): Promise<FactorySession | undefined> {
    try {
      const read = () => api.get(`/sessions/${enc(id)}`);
      const session = sessionOf(await (strict ? this.whileNew(id, read) : read()));
      if (!session) {
        this.failedUntil.set(id, this.now() + MISSING_MS);
        return undefined;
      }
      this.remember(session);
      return session;
    } catch (err) {
      const missing = err instanceof FactoryError && err.status === 404;
      this.failedUntil.set(id, this.now() + (missing ? MISSING_MS : FAILED_MS));
      if (strict && !missing) throw err;
      if (missing) return undefined;
      throw err;
    }
  }

  /** Keeps what a read of one session said, and counts its credits. */
  private remember(session: FactorySession) {
    const now = this.now();
    const had = this.details.get(session.id)?.session;
    // A PATCH or a POST may not carry the credits: keep the last ones.
    const merged = { ...had, ...session, ...(session.credits === undefined && had?.credits !== undefined ? { credits: had.credits } : {}) };
    this.details.set(session.id, { session: merged, at: now });
    this.failedUntil.delete(session.id);
    this.deleted.delete(session.id);
    if (session.credits !== undefined) this.ledger.observe(session.id, session.credits, session.updatedAt, session.title || undefined);
  }

  /** A message just went to it: it's running until a read says otherwise. */
  private markLive(id: string) {
    const d = this.details.get(id);
    if (d) d.session = { ...d.session, status: 'running' };
    else {
      const s = this.listed.find((x) => x.id === id);
      if (s) this.listed = this.listed.map((x) => (x.id === id ? { ...x, status: 'running' } : x));
    }
    this.publish();
  }

  private titleOf(id: string): string | undefined {
    return (this.details.get(id)?.session.title || this.listed.find((s) => s.id === id)?.title) ?? undefined;
  }

  /** A list item with what its own read said: credits, settings, and its status when that read is as new. */
  merged(s: FactorySession): FactorySession {
    const d = this.details.get(s.id);
    if (!d) {
      // Not read since the office started: the ledger has the total it last read.
      const credits = s.credits ?? this.ledger.last(s.id);
      return credits !== undefined ? { ...s, credits } : s;
    }
    const fresh = d.session.updatedAt >= s.updatedAt;
    return {
      ...d.session,
      ...s,
      status: fresh ? d.session.status : s.status,
      updatedAt: Math.max(s.updatedAt, d.session.updatedAt),
      messageCount: fresh ? d.session.messageCount : s.messageCount,
      model: s.model ?? d.session.model,
      effort: s.effort ?? d.session.effort,
      interactionMode: s.interactionMode ?? d.session.interactionMode,
      autonomyLevel: s.autonomyLevel ?? d.session.autonomyLevel,
      artifacts: s.artifacts.length ? s.artifacts : d.session.artifacts,
      ...(d.session.credits !== undefined ? { credits: d.session.credits } : {}),
      fetchedAt: d.at,
    };
  }

  /** Puts the slice together from the list, the reads of single sessions, the office's droids and the ledger. */
  private publish(patch: Partial<ReturnType<SessionsFeature['state']>> = {}) {
    const items = this.listed.filter((s) => !this.deleted.has(s.id)).map((s) => this.merged(s));
    // A session started from the office shows before the next list has it.
    const listed = new Set(items.map((s) => s.id));
    for (const [id, d] of this.details) if (!listed.has(id) && !this.deleted.has(id) && d.session.createdAt > (items.at(-1)?.createdAt ?? 0) && d.session.computerId) items.unshift(this.merged(d.session));
    items.sort((a, b) => b.updatedAt - a.updatedAt);
    const office: Record<string, FactoryOfficeSession> = {};
    for (const o of this.opts.officeSessions?.() ?? []) {
      const credits = this.details.get(o.sessionId)?.session.credits ?? this.ledger.last(o.sessionId);
      office[o.sessionId] = { workerId: o.workerId, name: o.name, ...(o.floor ? { floor: o.floor } : {}), ...(o.color ? { color: o.color } : {}), ...(credits !== undefined ? { credits } : {}) };
    }
    this.set({ ...patch, items, office, credits: this.ledger.summary((id) => this.titleOf(id)) });
  }
}

import { cloudEntries } from '../../shared/cloud-thread.js';
import { NEW_SESSION_GRACE_MS, mergeMessages, messageOf, type FactoryMessage } from '../../shared/factory-sessions.js';
import { pageRows, presentThread, THREAD_MODEL_VERSION, type ThreadRow } from '../../shared/thread-presentation.js';
import type { ThreadEntry } from '../../shared/worker-thread.js';
import type { ThreadPage } from '../worker-thread.js';
import { FactoryError, type FactoryApi } from './api.js';

// A cloud worker's Thread (docs/factory.md, "Cloud workers"): its Factory session's messages, read
// through the Sessions API and kept here, turned into the ThreadEntry list and presentation rows a
// local worker's session file gives (src/shared/cloud-thread.ts). The clients ask for it with
// `thread.read` about once a second while it's open; Factory is read far less often than that.

/** Entries per page, as for a local thread. */
const PAGE_SIZE = 100;
const RESPONSE_BYTES = 900_000;
/** Messages read when a session is first opened, or after a gap. */
const FIRST_PAGE = 100;
/** Messages read to catch up: what's new since the last read, with some overlap. */
const TAIL_PAGE = 30;
/** Sessions kept, least recently read dropped first. */
const SESSIONS = 8;
/** Messages kept per session; older ones are dropped and read again if someone pages back to them. */
const MESSAGES_MAX = 1500;

export interface CloudThreadSource {
  sessionId: string;
  /** When its worker was hired (ms): Factory 404s a session for a little while after it was made. */
  createdAt: number;
  /** In a turn: its newest activity can still be working, and its messages are read often. */
  busy: boolean;
}

export interface CloudThreadOptions {
  now?: () => number;
  /** How often Factory is read while the worker works, and while it rests (someone may type to it in Factory's web app). */
  busyEveryMs?: number;
  idleEveryMs?: number;
  /** How long a read waits for Factory before answering with what's held (the clients give up on a read after 8 s). */
  waitMs?: number;
}

interface Held {
  messages: FactoryMessage[];
  /** The cursor for the page before the oldest message held, while Factory has one. */
  older?: string;
  readAt: number;
  refresh?: Promise<void>;
  /** Built from `messages` and `busy`; cleared when either changes. */
  view?: { busy: boolean; entries: ThreadEntry[]; rows: ThreadRow[] };
}

type Answer = { messages?: unknown[]; pagination?: { hasMore?: boolean; nextCursor?: string | null } };

const unavailable = (error: string): ThreadPage => ({ entries: [], hasMore: false, error });
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

export class CloudThreadReader {
  private sessions = new Map<string, Held>();
  private now: () => number;
  private busyEveryMs: number;
  private idleEveryMs: number;
  private waitMs: number;

  constructor(
    private api: () => FactoryApi | undefined,
    opts: CloudThreadOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.busyEveryMs = opts.busyEveryMs ?? 2500;
    this.idleEveryMs = opts.idleEveryMs ?? 15_000;
    this.waitMs = opts.waitMs ?? 5000;
  }

  /** One page of the thread: the newest, or with `before` the entries before that position. */
  async read(source: CloudThreadSource, before?: number): Promise<ThreadPage> {
    const { sessionId } = source;
    const api = this.api();
    if (!api) return unavailable("The office isn't connected to Factory: connect it in ⚙️ Settings → Connections to read this worker's session.");
    const held = this.hold(sessionId);
    try {
      if (before === undefined) {
        const every = source.busy ? this.busyEveryMs : this.idleEveryMs;
        // A slow answer from Factory doesn't hold the page up: what's held goes now, the rest next read.
        if (!held.readAt || this.now() - held.readAt >= every) await Promise.race([this.refresh(api, sessionId, held), this.wait()]);
      } else await this.backfill(api, sessionId, held, before);
    } catch (err) {
      // A session Factory has only just made 404s for a few seconds: that's an empty thread, not an error.
      if (err instanceof FactoryError && err.status === 404 && !held.messages.length && this.now() - source.createdAt < NEW_SESSION_GRACE_MS) return { sessionId, entries: [], hasMore: false };
      // With messages held, the last good thread stays up and the next read tries again.
      if (!held.messages.length) return unavailable(`Couldn't read its session on Factory: ${(err as Error).message}`);
    }
    return { sessionId, ...this.page(held, source.busy, before) };
  }

  /** Messages the cloud poller read anyway (its newest few): merged in when they join on to what's held. */
  absorb(sessionId: string, raw: readonly unknown[]): void {
    const held = this.sessions.get(sessionId);
    if (!held?.messages.length) return;
    const page = raw.map(messageOf).filter((m): m is FactoryMessage => !!m);
    const known = new Set(held.messages.map((m) => m.id));
    if (!page.some((m) => known.has(m.id))) return;
    this.merge(held, page);
    held.readAt = this.now();
  }

  /** Forgets a session (its worker went home). */
  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private wait(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, this.waitMs).unref?.());
  }

  private hold(sessionId: string): Held {
    let held = this.sessions.get(sessionId);
    if (held) this.sessions.delete(sessionId);
    else {
      held = { messages: [], readAt: 0 };
      while (this.sessions.size >= SESSIONS) {
        const idle = [...this.sessions].find(([, h]) => !h.refresh);
        if (!idle) break;
        this.sessions.delete(idle[0]);
      }
    }
    // Map order is the LRU.
    this.sessions.set(sessionId, held);
    return held;
  }

  private async get(api: FactoryApi, sessionId: string, limit: number, cursor?: string) {
    const r = await api.get<Answer>(`/sessions/${encodeURIComponent(sessionId)}/messages`, { limit, ...(cursor ? { cursor } : {}) });
    const messages = (Array.isArray(r?.messages) ? r.messages : []).map(messageOf).filter((m): m is FactoryMessage => !!m);
    const next = r?.pagination?.hasMore && r.pagination.nextCursor ? r.pagination.nextCursor : undefined;
    return { messages, next };
  }

  /** The newest messages. Reads that overlap one another share one call to Factory. */
  private refresh(api: FactoryApi, sessionId: string, held: Held): Promise<void> {
    held.refresh ??= (async () => {
      const first = !held.messages.length;
      const page = await this.get(api, sessionId, first ? FIRST_PAGE : TAIL_PAGE);
      const known = new Set(held.messages.map((m) => m.id));
      // More came than one tail page holds: start again from a full first page.
      if (!first && page.next && !page.messages.some((m) => known.has(m.id))) {
        const full = await this.get(api, sessionId, FIRST_PAGE);
        held.messages = [];
        held.older = full.next;
        this.merge(held, full.messages);
      } else {
        if (first) held.older = page.next;
        this.merge(held, page.messages);
      }
      held.readAt = this.now();
    })().finally(() => {
      held.refresh = undefined;
    });
    return held.refresh;
  }

  /** Reads older pages from Factory until there are a page's worth of entries before `before`, or no more. */
  private async backfill(api: FactoryApi, sessionId: string, held: Held, before: number): Promise<void> {
    if (!held.messages.length) await this.refresh(api, sessionId, held);
    for (let tries = 0; tries < 3 && held.older; tries++) {
      const shown = this.view(held, false).entries.filter((e) => e.seq < before).length;
      if (shown >= PAGE_SIZE) return;
      const page = await this.get(api, sessionId, FIRST_PAGE, held.older);
      held.older = page.next;
      this.merge(held, page.messages, true);
    }
  }

  private merge(held: Held, page: readonly FactoryMessage[], older = false): void {
    held.messages = mergeMessages(held.messages, page);
    if (held.messages.length > MESSAGES_MAX) {
      // Dropping the oldest leaves no cursor to read them again from; the newest are what's watched.
      if (!older) {
        held.messages = held.messages.slice(-MESSAGES_MAX);
        held.older = undefined;
      } else held.messages = held.messages.slice(0, MESSAGES_MAX);
    }
    held.view = undefined;
  }

  private view(held: Held, busy: boolean): NonNullable<Held['view']> {
    if (held.view?.busy !== busy) {
      const entries = cloudEntries(held.messages);
      held.view = { busy, entries, rows: presentThread(entries, busy) };
    }
    return held.view;
  }

  private page(held: Held, busy: boolean, before = Infinity): Omit<ThreadPage, 'sessionId'> {
    const view = this.view(held, before === Infinity && busy);
    const candidates = view.entries.filter((e) => e.seq < before);
    const entries = candidates.slice(-PAGE_SIZE).map((e) => ({ ...e }));
    let size = bytes(entries);
    while (size > RESPONSE_BYTES && entries.length > 1) {
      const removed = entries.shift();
      if (removed) size -= bytes(removed) + 1;
    }
    return {
      entries,
      hasMore: candidates.length > entries.length || !!held.older,
      presentation: { version: THREAD_MODEL_VERSION, rows: pageRows(view.rows, entries, before) },
    };
  }
}

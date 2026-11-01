import { cloudEntries } from '../../shared/cloud-thread.js';
import { NEW_SESSION_GRACE_MS, mergeMessages, messageOf, type FactoryMessage } from '../../shared/factory-sessions.js';
import { pageRows, presentThread, THREAD_MODEL_VERSION, type ThreadRow } from '../../shared/thread-presentation.js';
import type { ThreadEntry } from '../../shared/worker-thread.js';
import type { ThreadPage } from '../worker-thread.js';
import { FactoryError, type FactoryApi } from './api.js';
import { CloudStreamMessages } from './cloud-stream-messages.js';

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
/** Sessions kept, least recently read dropped first. Ones the live stream fills are never dropped. */
const SESSIONS = 8;
/** Messages kept per session; older ones are dropped and read again if someone pages back to them. */
const MESSAGES_MAX = 1500;
/**
 * Messages kept once someone paged back, so new ones don't push out what they paged back to. Paging
 * back past it drops the newest instead, and the next read of the tail starts again from the newest.
 */
const HISTORY_MAX = 3000;
/** Pages walked from the newest to find the cursor past the oldest held message again (HISTORY_MAX / FIRST_PAGE, and some). */
const WALK_PAGES = 35;

export interface CloudThreadSource {
  sessionId: string;
  /** When its worker was hired (ms): Factory 404s a session for a little while after it was made. */
  createdAt: number;
  /** In a turn: its newest activity can still be working, and its messages are read often. */
  busy: boolean;
}

export interface CloudThreadOptions {
  streaming?: (sessionId: string) => boolean;
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
  live?: CloudStreamMessages;
  history?: boolean;
  /** The oldest messages were dropped for newer ones, with them the cursor past what's held. */
  trimmed?: boolean;
  /** How many messages are kept before new ones push the oldest out: MESSAGES_MAX, or HISTORY_MAX once someone paged back. */
  cap: number;
}

type Answer = { messages?: unknown[]; pagination?: { hasMore?: boolean; nextCursor?: string | null } };

const unavailable = (error: string): ThreadPage => ({ entries: [], hasMore: false, error });
const empty = (sessionId: string): ThreadPage => ({ sessionId, entries: [], hasMore: false, presentation: { version: THREAD_MODEL_VERSION, rows: [] } });
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

export class CloudThreadReader {
  private sessions = new Map<string, Held>();
  private now: () => number;
  private busyEveryMs: number;
  private idleEveryMs: number;
  private waitMs: number;

  constructor(
    private api: () => FactoryApi | undefined,
    private opts: CloudThreadOptions = {},
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
        if (held.history) void this.refresh(api, sessionId, held).catch(() => {});
        const streaming = this.opts.streaming?.(sessionId) === true;
        const every = streaming ? 60_000 : source.busy ? this.busyEveryMs : this.idleEveryMs;
        // A slow answer from Factory doesn't hold the page up: what's held goes now, the rest next read.
        if (!held.readAt || this.now() - held.readAt >= every) {
          const refresh = this.refresh(api, sessionId, held);
          // Reconciliation must not stall a healthy live thread while more tokens arrive.
          if (streaming) void refresh.catch(() => {});
          else await Promise.race([refresh, this.wait()]);
        }
      } else await this.backfill(api, sessionId, held, before);
    } catch (err) {
      // A session Factory has only just made 404s for a few seconds: that's an empty thread, not an error.
      if (err instanceof FactoryError && err.status === 404 && !held.messages.length && this.now() - source.createdAt < NEW_SESSION_GRACE_MS) return empty(sessionId);
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

  /** A daemon snapshot hydrates a thread even before someone opens it. Only safe messages are held. */
  streamSnapshot(sessionId: string, raw: readonly unknown[], hasOlderMessages = false): void {
    const held = this.hold(sessionId);
    held.messages = this.live(held).snapshot(raw);
    this.trimmed(held);
    held.readAt = this.now();
    held.history = hasOlderMessages && !held.older;
    held.view = undefined;
  }

  streamEvent(sessionId: string, notification: unknown): void {
    const held = this.hold(sessionId);
    held.messages = this.live(held).event(notification);
    this.trimmed(held);
    held.view = undefined;
  }

  private live(held: Held): CloudStreamMessages {
    held.live ??= new CloudStreamMessages(held.messages, this.now, (older) => (older ? HISTORY_MAX : held.cap));
    return held.live;
  }

  /** The live messages dropped their oldest for newer ones: the cursor past them went too. */
  private trimmed(held: Held): void {
    if (!held.live?.takeTrimmed()) return;
    held.older = undefined;
    held.trimmed = true;
  }

  messages(sessionId: string): readonly FactoryMessage[] {
    return this.sessions.get(sessionId)?.messages ?? [];
  }

  clear(): void {
    this.sessions.clear();
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
      held = { messages: [], readAt: 0, cap: MESSAGES_MAX };
      while (this.sessions.size >= SESSIONS) {
        // A streamed session's held text is the base its deltas build on, and the stream sends no
        // second snapshot; it goes only when its worker does (forget) or the stream resets (clear).
        const idle = [...this.sessions].find(([, h]) => !h.refresh && !h.live);
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
      const first = !held.messages.length || held.history;
      const page = await this.get(api, sessionId, first ? FIRST_PAGE : TAIL_PAGE);
      const known = new Set(held.messages.map((m) => m.id));
      // More came than one tail page holds: start again from a full first page.
      if (!first && page.next && !page.messages.some((m) => known.has(m.id))) {
        const full = await this.get(api, sessionId, FIRST_PAGE);
        if (!held.live) {
          held.messages = [];
          held.cap = MESSAGES_MAX;
        }
        held.older = full.next;
        this.merge(held, full.messages);
      } else {
        if (first) held.older = page.next;
        this.merge(held, page.messages);
      }
      held.readAt = this.now();
      held.history = false;
    })().finally(() => {
      held.refresh = undefined;
    });
    return held.refresh;
  }

  /** Reads older pages from Factory until there are a page's worth of entries before `before`, or no more. */
  private async backfill(api: FactoryApi, sessionId: string, held: Held, before: number): Promise<void> {
    if (!held.messages.length || held.history) await this.refresh(api, sessionId, held);
    if (held.trimmed && !held.older && this.view(held, false).entries.filter((e) => e.seq < before).length < PAGE_SIZE) await this.findOlder(api, sessionId, held);
    for (let tries = 0; tries < 3 && held.older; tries++) {
      const shown = this.view(held, false).entries.filter((e) => e.seq < before).length;
      if (shown >= PAGE_SIZE) return;
      const page = await this.get(api, sessionId, FIRST_PAGE, held.older);
      held.older = page.next;
      this.merge(held, page.messages, true);
    }
  }

  /**
   * Factory's cursors only run from the newest page back, so after the oldest held messages were
   * dropped, the cursor past what's held is found again by walking back to the page that has the
   * oldest one still held.
   */
  private async findOlder(api: FactoryApi, sessionId: string, held: Held): Promise<void> {
    const oldest = held.messages[0]?.id;
    let cursor: string | undefined;
    for (let pages = 0; pages < WALK_PAGES; pages++) {
      const page = await this.get(api, sessionId, FIRST_PAGE, cursor);
      if (page.messages.some((m) => m.id === oldest)) {
        held.trimmed = false;
        held.older = page.next;
        this.merge(held, page.messages, true);
        return;
      }
      if (!page.next) break;
      cursor = page.next;
    }
    // It's gone from Factory, or further back than the walk goes: there's nothing to page back to.
    held.trimmed = false;
  }

  private merge(held: Held, page: readonly FactoryMessage[], older = false): void {
    if (held.live) {
      held.messages = held.live.merge(page, older);
      this.trimmed(held);
    } else {
      held.messages = mergeMessages(held.messages, page);
      const max = older ? HISTORY_MAX : held.cap;
      if (held.messages.length > max) {
        if (older) held.messages = held.messages.slice(0, max);
        else {
          // Dropping the oldest drops the cursor past them too; findOlder finds it again when someone pages back.
          held.messages = held.messages.slice(-max);
          held.older = undefined;
          held.trimmed = true;
        }
      }
    }
    if (older) held.cap = HISTORY_MAX;
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
      hasMore: candidates.length > entries.length || !!held.older || !!held.trimmed,
      presentation: { version: THREAD_MODEL_VERSION, rows: pageRows(view.rows, entries, before) },
    };
  }
}

import type { ClientMsg, ServerMsg, WorkerInfo } from '../shared/protocol';
import { ThreadQueue } from '../shared/thread-queue';
import { ThreadHistory } from '../client/thread-history';
import { TeamThread, teamThreadBudget, threadReadInterval } from '../client/team-thread';

export const READ_TIMEOUT_MS = 8000;
export const UNRETURNED = 'The office did not return this conversation. Retry, or open Raw TTY.';

type Send = (msg: ClientMsg) => boolean;
type RequestId = () => string;

let serial = 0;
export function requestId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${(++serial).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** One pane's conversation: paging, polling and request correlation. Never sends anything but reads. */
export class ThreadFeed {
  readonly history = new ThreadHistory();
  received = false;
  error = '';
  pending?: { request: string; before?: number; at: number };
  lastReadAt = 0;
  revision = 0;
  private sessionId?: string;

  constructor(
    readonly workerId: string,
    sessionId?: string,
  ) {
    this.sessionId = sessionId;
    this.history.clear(sessionId);
  }

  /** A new session (a fork, /new, a resume onto another) starts the history over. */
  worker(w: WorkerInfo): void {
    if (w.sessionId === this.sessionId) return;
    this.sessionId = w.sessionId;
    this.history.clear(w.sessionId);
    this.received = false;
    this.pending = undefined;
    this.error = '';
    this.lastReadAt = 0;
    this.revision++;
  }

  tick(now: number, state: { connected: boolean; visible: boolean; focused: boolean }, send: Send, id: RequestId): void {
    if (this.pending && now - this.pending.at >= READ_TIMEOUT_MS) {
      this.pending = undefined;
      this.error = UNRETURNED;
      this.revision++;
    }
    if (!state.connected || !state.visible || this.error || this.pending || this.history.historical) return;
    if (now - this.lastReadAt < threadReadInterval(state.focused)) return;
    this.read(now, send, id);
  }

  read(now: number, send: Send, id: RequestId, before?: number): boolean {
    if (this.pending) return false;
    const request = id();
    if (!send({ t: 'thread.read', workerId: this.workerId, request, ...(before !== undefined ? { before } : {}) })) return false;
    this.pending = { request, before, at: now };
    this.lastReadAt = now;
    this.revision++;
    return true;
  }

  earlier(now: number, send: Send, id: RequestId): boolean {
    const first = this.history.entries[0]?.seq;
    return this.history.hasMore && first !== undefined && this.read(now, send, id, first);
  }

  /** Back from paged-back history to the newest page. */
  latest(): void {
    this.history.clear(this.sessionId);
    this.received = false;
    this.lastReadAt = 0;
    this.revision++;
  }

  retry(): void {
    this.error = '';
    this.lastReadAt = 0;
    this.revision++;
  }

  receive(msg: ServerMsg): boolean {
    if (msg.t !== 'thread.snapshot' || msg.workerId !== this.workerId || !this.pending || msg.request !== this.pending.request) return false;
    this.pending = undefined;
    this.error = msg.error ?? '';
    if (!this.error && !(this.sessionId && msg.sessionId !== this.sessionId)) {
      this.history.apply(msg);
      this.received = true;
    }
    this.revision++;
    return true;
  }

  /** The socket went: an unanswered read will never be answered. */
  disconnected(): void {
    if (!this.pending && !this.error) return;
    this.pending = undefined;
    this.error = '';
    this.revision++;
  }
}

/**
 * Every open pane's feed, the focused lead's team rollup, and the queue receipts, under one clock and
 * one message listener. Feeds for workers no longer in a Thread pane are dropped, not kept polling.
 */
export class FeedPool {
  readonly feeds = new Map<string, ThreadFeed>();
  readonly team = new TeamThread();
  teamLead = '';
  teamOn = false;
  /** How many of the focused lead's children the rollup reads, under the office reader's room left by the panes. */
  teamLimit = 0;
  private queues = new Map<string, ThreadQueue>();
  private listeners = new Set<() => void>();
  version = 0;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private changed(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  feed(workerId: string): ThreadFeed | undefined {
    return this.feeds.get(workerId);
  }

  /** Receipts for messages queued behind a turn, per floor and worker, kept while panes come and go. */
  queue(floor: string, workerId: string): ThreadQueue {
    const key = JSON.stringify([floor, workerId]);
    let queue = this.queues.get(key);
    if (!queue) this.queues.set(key, (queue = new ThreadQueue()));
    return queue;
  }

  /** The workers shown in a Thread pane now, and the focused one, whose team may roll up. */
  sync(threadWorkers: readonly WorkerInfo[], focused: string | undefined, floorWorkers: readonly WorkerInfo[], scope: string): void {
    const keep = new Set(threadWorkers.map((w) => w.id));
    let touched = false;
    for (const id of [...this.feeds.keys()])
      if (!keep.has(id)) {
        this.feeds.delete(id);
        touched = true;
      }
    for (const w of threadWorkers) {
      const had = this.feeds.get(w.id);
      if (had) had.worker(w);
      else {
        this.feeds.set(w.id, new ThreadFeed(w.id, w.sessionId));
        touched = true;
      }
    }
    const lead = focused && keep.has(focused) ? focused : '';
    const focusedWorker = threadWorkers.find((w) => w.id === lead);
    this.teamLead = lead;
    this.teamLimit = teamThreadBudget(threadWorkers.length);
    this.teamOn = !!lead && this.teamLimit > 0;
    this.team.sync(`${scope}:${lead}:${focusedWorker?.sessionId ?? ''}`, lead, this.teamOn ? floorWorkers : [], this.teamLimit);
    if (touched) this.changed();
  }

  tick(now: number, state: { connected: boolean; visible: boolean; focused?: string; teamOpen: boolean }, send: Send): void {
    const before = this.revisions();
    for (const feed of this.feeds.values()) feed.tick(now, { connected: state.connected, visible: state.visible, focused: feed.workerId === state.focused }, send, () => requestId('thread'));
    this.team.enable(this.teamOn && state.connected && state.visible && state.teamOpen);
    this.team.read(now, send, () => requestId('team'));
    if (this.revisions() !== before) this.changed();
  }

  receive(msg: ServerMsg): void {
    if (msg.t === 'welcome' || msg.t === 'floor.enter') {
      this.team.clear();
      this.changed();
      return;
    }
    if (msg.t !== 'thread.snapshot') return;
    const feed = this.feeds.get(msg.workerId);
    if (feed?.receive(msg) || this.team.receive(msg)) this.changed();
  }

  disconnected(): void {
    for (const feed of this.feeds.values()) feed.disconnected();
    this.team.enable(false);
    this.changed();
  }

  private revisions(): string {
    return `${[...this.feeds.values()].map((f) => f.revision).join(',')}|${this.team.revision}`;
  }
}

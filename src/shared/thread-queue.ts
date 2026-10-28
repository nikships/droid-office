import { type DroidQueued, showsAs } from './droid-queue.js';
import type { ThreadEntry } from './worker-thread.js';

export interface QueuedPrompt {
  id: number;
  text: string;
  hasImage: boolean;
  after: number;
  /** When this client sent it, in ms. */
  at: number;
  /** When Droid's queue last showed it on the screen, in ms. */
  seen?: number;
}

/** One message waiting in the conversation for its turn, as the thread shows it. */
export interface QueuedView {
  key: string;
  text: string;
  hasImage: boolean;
  /** Only Droid's preview is known: its first line, maybe cut short, and how many lines it didn't show. */
  preview: boolean;
  more: number;
}

/**
 * How long a message sent to the queue is shown without Droid's screen showing it: long enough for
 * Droid to draw it, or, once drained, for the conversation to pick it up.
 */
export const QUEUE_GRACE_MS = 4000;

/**
 * The messages this client sent to Droid's queue, held until the conversation shows them. Droid's
 * own queue, read off its screen (droid-queue.ts), is what the thread shows: these only fill in the
 * whole text of a row Droid cut short, and stand in for it while the screen can't be read.
 */
export class ThreadQueue {
  private session?: string;
  private serial = 0;
  private consumed = new Set<string>();
  private items: QueuedPrompt[] = [];
  sequence = -1;

  constructor(saved?: unknown) {
    if (!saved || typeof saved !== 'object') return;
    const state = saved as Record<string, unknown>;
    if (typeof state.session !== 'string' || !Number.isSafeInteger(state.sequence) || !Array.isArray(state.items) || !Array.isArray(state.consumed)) return;
    this.session = state.session;
    this.sequence = state.sequence as number;
    this.items = state.items.slice(0, 32).flatMap((value: unknown) => {
      if (!value || typeof value !== 'object') return [];
      const item = value as Record<string, unknown>;
      return Number.isSafeInteger(item.id) && typeof item.text === 'string' && item.text.length <= 20000 && typeof item.hasImage === 'boolean' && Number.isSafeInteger(item.after)
        ? [{ id: item.id as number, text: item.text, hasImage: item.hasImage, after: item.after as number, at: Number.isSafeInteger(item.at) ? (item.at as number) : 0 }]
        : [];
    });
    this.serial = Math.max(0, ...this.items.map((item) => item.id));
    this.consumed = new Set(state.consumed.filter((id): id is string => typeof id === 'string').slice(0, 2000));
  }

  toJSON() {
    return { session: this.session, sequence: this.sequence, items: this.items.map(({ seen: _, ...item }) => item), consumed: [...this.consumed] };
  }

  /** Forgets every message here, after Droid's queue was cleared. */
  clear(): void {
    this.items = [];
    this.consumed.clear();
  }

  get pending(): readonly QueuedPrompt[] {
    return this.items;
  }

  sent(text: string, hasImage: boolean, after = this.sequence, at = Date.now()): void {
    this.items.push({ id: ++this.serial, text, hasImage, after, at });
    this.items = this.items.slice(-32);
  }

  sync(session: string | undefined, entries: readonly ThreadEntry[]): readonly QueuedPrompt[] {
    if (session && this.session && session !== this.session) {
      this.items = [];
      this.consumed.clear();
      this.sequence = -1;
    }
    if (session) this.session = session;
    for (const entry of entries) this.sequence = Math.max(this.sequence, entry.seq);
    for (const entry of [...entries].sort((a, b) => a.seq - b.seq)) {
      if (entry.role !== 'user' || this.consumed.has(entry.id)) continue;
      let matched = false;
      for (let start = 0; start < this.items.length && !matched; start++) {
        let joined = '';
        for (let end = start; end < this.items.length; end++) {
          const item = this.items[end];
          if (entry.seq <= item.after) break;
          // Droid can drain consecutive queued text sends as one user message, without a separator.
          joined += item.text;
          const match = item.text ? entry.kind === 'text' && entry.text?.trim() === joined : start === end && item.hasImage && entry.kind === 'notice' && entry.text === '[Image attachment]';
          if (match) {
            this.items.splice(start, end - start + 1);
            this.consumed.add(entry.id);
            matched = true;
            break;
          }
          if (!item.text) break;
        }
      }
    }
    if (!this.items.length) this.consumed.clear();
    return this.items;
  }

  /**
   * What waits in the queue now, oldest first. With Droid's queue read off the screen, its rows, each
   * with the whole text of the message here it previews, then messages sent too recently for Droid to
   * have drawn them. A message here that Droid hasn't shown for [QUEUE_GRACE_MS] has left the queue,
   * drained or cleared, and is forgotten. Without the screen ([droid] undefined), every message here.
   */
  shown(droid: readonly DroidQueued[] | undefined, now = Date.now()): QueuedView[] {
    const own = (item: QueuedPrompt): QueuedView => ({ key: `sent:${item.id}`, text: item.text, hasImage: item.hasImage, preview: false, more: 0 });
    if (!droid) return this.items.map(own);
    const used = new Set<QueuedPrompt>();
    const out: QueuedView[] = droid.map((row, i) => {
      const item = this.items.find((it) => !used.has(it) && showsAs(row, it.text));
      if (!item) return { key: `droid:${i}:${row.text}`, text: row.text, hasImage: false, preview: row.cut || row.more > 0, more: row.more };
      used.add(item);
      item.seen = now;
      return own(item);
    });
    this.items = this.items.filter((item) => used.has(item) || now - Math.max(item.at, item.seen ?? 0) < QUEUE_GRACE_MS);
    for (const item of this.items) if (!used.has(item)) out.push(own(item));
    if (!this.items.length) this.consumed.clear();
    return out;
  }
}

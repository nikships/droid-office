import type { ThreadEntry } from './worker-thread.js';

export interface QueuedPrompt {
  id: number;
  text: string;
  hasImage: boolean;
  after: number;
}

/** Only this client's acknowledged queue sends, not a claim about another window's Droid queue. */
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
        ? [{ id: item.id as number, text: item.text, hasImage: item.hasImage, after: item.after as number }]
        : [];
    });
    this.serial = Math.max(0, ...this.items.map((item) => item.id));
    this.consumed = new Set(state.consumed.filter((id): id is string => typeof id === 'string').slice(0, 2000));
  }

  toJSON() {
    return { session: this.session, sequence: this.sequence, items: this.items, consumed: [...this.consumed] };
  }

  /** Dismiss receipts here only. This does not change Droid's queue. */
  clear(): void {
    this.items = [];
    this.consumed.clear();
  }

  get pending(): readonly QueuedPrompt[] {
    return this.items;
  }

  sent(text: string, hasImage: boolean, after = this.sequence): void {
    this.items.push({ id: ++this.serial, text, hasImage, after });
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
          // Droid concatenates consecutive queued text sends into one user message, without a separator.
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
}

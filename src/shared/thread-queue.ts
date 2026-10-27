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

  get pending(): readonly QueuedPrompt[] {
    return this.items;
  }

  sent(text: string, hasImage: boolean, after = this.sequence): void {
    this.items.push({ id: ++this.serial, text, hasImage, after });
  }

  sync(session: string | undefined, entries: readonly ThreadEntry[]): readonly QueuedPrompt[] {
    if (session && this.session && session !== this.session) {
      this.items = [];
      this.consumed.clear();
      this.sequence = -1;
    }
    if (session) this.session = session;
    for (const entry of entries) this.sequence = Math.max(this.sequence, entry.seq);
    this.items = this.items.filter((item) => {
      const match = entries.find(
        (entry) =>
          entry.role === 'user' &&
          entry.seq > item.after &&
          !this.consumed.has(entry.id) &&
          (item.text ? entry.kind === 'text' && entry.text?.trim() === item.text : item.hasImage && entry.kind === 'notice' && entry.text === '[Image attachment]'),
      );
      if (!match) return true;
      this.consumed.add(match.id);
      return false;
    });
    if (!this.items.length) this.consumed.clear();
    return this.items;
  }
}

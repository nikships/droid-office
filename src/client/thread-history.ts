import type { ThreadEntry } from '../shared/worker-thread';

/** Loaded history belongs to one session. A latest page updates tools without dropping older pages. */
export class ThreadHistory {
  entries: ThreadEntry[] = [];
  sessionId?: string;
  hasMore = false;
  historical = false;

  clear(sessionId?: string) {
    this.entries = [];
    this.sessionId = sessionId;
    this.hasMore = false;
    this.historical = false;
  }

  apply(page: { sessionId?: string; entries: ThreadEntry[]; hasMore: boolean; before?: number }) {
    if (page.sessionId !== this.sessionId) this.clear(page.sessionId);
    const latest = page.before === undefined;
    if (latest && this.historical) return;
    const first = page.entries[0]?.seq;
    const last = page.entries.at(-1)?.seq;
    const previous = this.entries.at(-1)?.seq;
    // A rewritten conversation can retain its session id. Don't keep the abandoned branch.
    const rewritten = latest && last !== undefined && previous !== undefined && (last < previous || page.entries.some((entry) => this.entries.some((old) => old.seq === entry.seq && old.id !== entry.id)));
    const gap = latest && page.hasMore && first !== undefined && previous !== undefined && first > previous && !page.entries.some((e) => this.entries.some((old) => old.id === e.id));
    if (rewritten || gap || (latest && !page.hasMore)) this.clear(page.sessionId);
    const old = latest && first !== undefined ? this.entries.filter((e) => e.seq < first) : this.entries;
    const merged = new Map(old.map((e) => [e.id, e]));
    for (const entry of page.entries) merged.set(entry.id, entry);
    this.entries = [...merged.values()].sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
    if (latest && !page.entries.length) this.entries = [];
    if (page.before !== undefined || !old.length) this.hasMore = page.hasMore;
    // Bound the DOM even after hours of paging. The dropped history remains loadable.
    if (this.entries.length > 2000) {
      if (latest) {
        this.entries = this.entries.slice(-2000);
        this.hasMore = true;
      } else {
        this.entries = this.entries.slice(0, 2000);
        this.historical = true;
      }
    }
  }
}

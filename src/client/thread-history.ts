import { THREAD_MODEL_VERSION, type ThreadPresentation, type ThreadRow } from '../shared/thread-presentation';
import type { ThreadEntry } from '../shared/worker-thread';

/** The rows that stand for at least one of these entries, which are in seq order. */
export function rowsWithin(rows: readonly ThreadRow[], entries: readonly ThreadEntry[]): ThreadRow[] {
  const from = entries[0]?.seq;
  const to = entries.at(-1)?.seq;
  if (from === undefined || to === undefined) return [];
  return rows.filter((row) => row.to >= from && row.from <= to);
}

/**
 * Loaded history belongs to one session. A latest page updates tools without dropping older pages.
 * The office builds the rows (src/shared/thread-presentation.ts); this only joins its pages: a latest
 * page's rows replace those from its first row on, and an earlier page's rows are added only where
 * they end before the first row already held.
 */
export class ThreadHistory {
  entries: ThreadEntry[] = [];
  rows: ThreadRow[] = [];
  sessionId?: string;
  hasMore = false;
  historical = false;
  /** The office sent no presentation this client can read. */
  unsupported = false;

  clear(sessionId?: string) {
    this.entries = [];
    this.rows = [];
    this.sessionId = sessionId;
    this.hasMore = false;
    this.historical = false;
  }

  apply(page: { sessionId?: string; entries: ThreadEntry[]; hasMore: boolean; before?: number; presentation?: ThreadPresentation }) {
    if (page.sessionId !== this.sessionId) this.clear(page.sessionId);
    const latest = page.before === undefined;
    if (latest && this.historical) return;
    this.unsupported = page.presentation?.version !== THREAD_MODEL_VERSION;
    const incoming = this.unsupported ? [] : (page.presentation?.rows ?? []);
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
    if (latest) {
      const cut = Math.min(incoming[0]?.from ?? Infinity, first ?? Infinity);
      this.rows = [...this.rows.filter((row) => row.to < cut), ...incoming];
    } else {
      const held = this.rows[0]?.from ?? Infinity;
      this.rows = [...incoming.filter((row) => row.to < held), ...this.rows];
    }
    if (latest && !page.entries.length) {
      this.entries = [];
      this.rows = [];
    }
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
      this.rows = rowsWithin(this.rows, this.entries);
    }
  }
}

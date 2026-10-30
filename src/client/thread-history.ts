import { activityState, THREAD_MODEL_VERSION, type ThreadBlock, type ThreadPresentation, type ThreadRow } from '../shared/thread-presentation';
import type { ThreadEntry } from '../shared/worker-thread';

const EARLIER_ACTIVITY = 'Earlier activity';

/**
 * The rows that still stand for one of these entries. Judged by id, not by seq range: a cache that
 * drops entries for size leaves gaps, and a message row without its text would render empty.
 */
export function rowsWithin(rows: readonly ThreadRow[], entries: readonly ThreadEntry[]): ThreadRow[] {
  const kept = new Set(entries.map((entry) => entry.id));
  return rows.filter((row) => (row.kind === 'activity' ? row.sourceIds.some((id) => kept.has(id)) : kept.has(row.id)));
}

/**
 * The part of an Activity row that stands for the entries loaded, up to [to]. The office's
 * read window can slide past a row's start while this client still holds those entries; clipping
 * keeps that prefix, with its failures, instead of dropping it. Null when nothing of it is left.
 * Its summary is rebuilt from the actions it holds: the office's label, status and state describe the
 * whole run, which the office's own row now carries for the part this one no longer covers.
 */
export function rowPrefix(row: ThreadRow, to: number, loaded: ReadonlyMap<string, ThreadEntry>): ThreadRow | undefined {
  if (row.kind !== 'activity' || row.from > to || row.to <= to) return undefined;
  const held = (id: string) => (loaded.get(id)?.seq ?? Number.POSITIVE_INFINITY) <= to;
  const sourceIds = row.sourceIds.filter(held);
  const blocks: ThreadBlock[] = [];
  for (const block of row.blocks) {
    if (block.kind === 'thought') {
      if (held(block.id)) blocks.push(block);
      continue;
    }
    const actions = block.actions.filter((item) => held(item.id));
    if (actions.length) blocks.push(actions.length === block.actions.length ? block : { ...block, label: 'Earlier tools', state: activityState(actions), live: false, actions });
  }
  if (!sourceIds.length || !blocks.length) return undefined;
  const actions = blocks.flatMap((block) => (block.kind === 'tools' ? block.actions : []));
  return {
    kind: 'activity',
    id: row.id,
    from: row.from,
    to,
    sourceIds,
    label: EARLIER_ACTIVITY,
    state: activityState(actions),
    live: false,
    open: row.open,
    failed: row.failed.filter((failure) => held(failure.id)),
    blocks,
  };
}

/**
 * Loaded history belongs to one session. A latest page updates tools without dropping older pages.
 * The office builds the rows (src/shared/thread-presentation.ts); this only joins its pages: a latest
 * page's rows replace those from its first row on, and an earlier page adds the rows and Activity
 * prefixes before the first row already held.
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
    const loaded = new Map(this.entries.map((entry) => [entry.id, entry]));
    if (latest) {
      const cut = Math.min(incoming[0]?.from ?? Infinity, first ?? Infinity);
      const held: ThreadRow[] = [];
      for (const row of this.rows) {
        if (row.to < cut) held.push(row);
        else if (row.from < cut) {
          const prefix = rowPrefix(row, cut - 1, loaded);
          if (prefix) held.push(prefix);
        }
      }
      this.rows = [...held, ...incoming];
    } else {
      const held = this.rows[0]?.from ?? Infinity;
      const earlier = incoming.flatMap((row) => {
        if (row.to < held) return [row];
        const prefix = rowPrefix(row, held - 1, loaded);
        return prefix ? [prefix] : [];
      });
      this.rows = [...earlier, ...this.rows];
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

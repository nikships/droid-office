import type { ClientMsg, ServerMsg, WorkerInfo } from '../shared/protocol';
import type { ThreadEntry } from '../shared/worker-thread';
import { ThreadHistory } from './thread-history';

// Leave the server reader's other two cache slots for the lead and history/drilldown.
export const TEAM_THREAD_WORKERS = 6;
export const TEAM_THREAD_ENTRIES = 40;
export const TEAM_THREAD_CHARACTERS = 96_000;
const FIELD_CHARACTERS = 16_000;
const READ_INTERVAL = 1000;
const READ_TIMEOUT = 8000;

export interface TeamThreadMember {
  worker: WorkerInfo;
  history: ThreadHistory;
  received: boolean;
  error: string;
  pending?: { request: string; at: number };
  nextReadAt: number;
}

/** The server's conversation reader caches 8 sessions; one stays free for history paging. */
export const THREAD_READER_SESSIONS = 8;

/** How many team children the focused view may read while `polling` thread views read their own session. */
export function teamThreadBudget(polling: number): number {
  return Math.max(0, Math.min(TEAM_THREAD_WORKERS, THREAD_READER_SESSIONS - 1 - polling));
}

/** How often a mounted thread view reads its own conversation: the focused one every second, others less. */
export function threadReadInterval(focused: boolean): number {
  return focused ? READ_INTERVAL : 3 * READ_INTERVAL;
}

export function teamThreadVisible(active: boolean, connected: boolean, visible: boolean, expanded: boolean): boolean {
  return active && connected && visible && expanded;
}

/** Hidden views keep their last paint key so becoming visible catches up once, not every tick. */
export class TeamThreadPaint {
  private key = '';

  changed(revision: number, connected: boolean, expanded: boolean, visible: boolean, force = false): boolean {
    if (!visible) return false;
    const key = `${revision}:${connected}:${expanded}`;
    if (!force && key === this.key) return false;
    this.key = key;
    return true;
  }
}

/** Only office-owned local Droid children have JSONL threads. Team badges aren't ownership. */
export function teamThreadChildren(lead: string, workers: readonly WorkerInfo[]): WorkerInfo[] {
  return workers.filter((worker) => worker.id !== lead && worker.lead === lead && worker.kind === 'agent' && !worker.guest && !worker.cloud).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

function boundedEntries(entries: readonly ThreadEntry[]): ThreadEntry[] {
  let remaining = TEAM_THREAD_CHARACTERS - 2;
  const kept: ThreadEntry[] = [];
  for (const entry of entries.slice(-TEAM_THREAD_ENTRIES).reverse()) {
    const bounded = { ...entry };
    for (const field of ['text', 'input', 'output'] as const) {
      const value = bounded[field];
      if (value && value.length > FIELD_CHARACTERS) bounded[field] = `${value.slice(0, FIELD_CHARACTERS - 40)}\n[…truncated; open the worker thread]`;
    }
    const size = JSON.stringify(bounded).length + 1;
    if (size > remaining) break;
    kept.push(bounded);
    remaining -= size;
  }
  return kept.reverse();
}

/** Pure request routing/cache policy. The mounted view owns the clock and the one listener. */
export class TeamThread {
  readonly members = new Map<string, TeamThreadMember>();
  total = 0;
  revision = 0;
  private scope = '';
  private lead = '';
  private enabled = false;
  private disposed = false;
  private nextWorker = 0;
  private nextReadAt = 0;

  /** `limit`: at most this many children are read, under the server reader's cache budget. */
  sync(scope: string, lead: string, workers: readonly WorkerInfo[], limit = TEAM_THREAD_WORKERS) {
    if (this.disposed) return;
    if (scope !== this.scope || lead !== this.lead) {
      this.clear();
      this.scope = scope;
      this.lead = lead;
    }
    const children = teamThreadChildren(lead, workers);
    if (this.total !== children.length) this.revision++;
    this.total = children.length;
    const keep = new Set<string>();
    for (const worker of children.slice(0, Math.max(0, Math.min(TEAM_THREAD_WORKERS, limit)))) {
      keep.add(worker.id);
      let member = this.members.get(worker.id);
      if (!member || member.worker.sessionId !== worker.sessionId) {
        member = { worker, history: new ThreadHistory(), received: false, error: '', nextReadAt: member?.nextReadAt ?? 0 };
        this.members.set(worker.id, member);
        this.revision++;
      } else if (JSON.stringify([member.worker.name, member.worker.status, member.worker.activity, member.worker.title, !!member.worker.lost]) !== JSON.stringify([worker.name, worker.status, worker.activity, worker.title, !!worker.lost])) {
        this.revision++;
      }
      member.worker = worker;
    }
    for (const id of this.members.keys()) {
      if (!keep.has(id)) {
        this.members.delete(id);
        this.revision++;
      }
    }
  }

  enable(on: boolean) {
    this.enabled = on && !this.disposed;
    if (!this.enabled) for (const member of this.members.values()) member.pending = undefined;
  }

  read(now: number, send: (msg: Extract<ClientMsg, { t: 'thread.read' }>) => boolean, request: () => string) {
    if (!this.enabled) return;
    const members = [...this.members.values()];
    for (const member of members) {
      if (member.pending && now - member.pending.at >= READ_TIMEOUT) {
        member.pending = undefined;
        if (member.error !== 'The office did not return this conversation.') this.revision++;
        member.error = 'The office did not return this conversation.';
        member.nextReadAt = now + READ_INTERVAL;
      }
    }
    if (now < this.nextReadAt) return;
    for (let offset = 0; offset < members.length; offset++) {
      const index = (this.nextWorker + offset) % members.length;
      const member = members[index];
      if (member.pending || now < member.nextReadAt || member.worker.lost || !member.worker.sessionId) continue;
      const id = request();
      this.nextReadAt = now + READ_INTERVAL;
      this.nextWorker = (index + 1) % members.length;
      member.nextReadAt = now + READ_INTERVAL;
      if (send({ t: 'thread.read', workerId: member.worker.id, request: id })) member.pending = { request: id, at: now };
      return;
    }
  }

  receive(msg: ServerMsg): boolean {
    if (!this.enabled || msg.t !== 'thread.snapshot') return false;
    const member = this.members.get(msg.workerId);
    if (!member?.pending || member.pending.request !== msg.request || msg.before !== undefined) return false;
    member.pending = undefined;
    if (!msg.error && member.worker.sessionId && msg.sessionId !== member.worker.sessionId) return false;
    if (member.error !== (msg.error ?? '')) this.revision++;
    member.error = msg.error ?? '';
    if (!member.error) {
      const previous = JSON.stringify([member.history.sessionId, member.history.entries, member.history.hasMore]);
      member.history.apply(msg);
      const entries = boundedEntries(member.history.entries);
      member.history.hasMore = msg.hasMore || entries.length < member.history.entries.length;
      member.history.entries = entries;
      if (!member.received || previous !== JSON.stringify([member.history.sessionId, member.history.entries, member.history.hasMore])) this.revision++;
      member.received = true;
    }
    return true;
  }

  clear() {
    if (this.members.size || this.total) this.revision++;
    this.members.clear();
    this.total = 0;
    this.nextWorker = 0;
  }

  dispose() {
    this.enable(false);
    this.clear();
    this.disposed = true;
  }
}

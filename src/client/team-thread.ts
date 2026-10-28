import type { ClientMsg, ServerMsg, WorkerInfo } from '../shared/protocol';
import type { ThreadEntry } from '../shared/worker-thread';
import { ThreadHistory } from './thread-history';

export const TEAM_THREAD_WORKERS = 16;
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

export function teamThreadVisible(active: boolean, connected: boolean, visible: boolean, expanded: boolean): boolean {
  return active && connected && visible && expanded;
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
  private scope = '';
  private lead = '';
  private enabled = false;
  private disposed = false;

  sync(scope: string, lead: string, workers: readonly WorkerInfo[]) {
    if (this.disposed) return;
    if (scope !== this.scope || lead !== this.lead) {
      this.clear();
      this.scope = scope;
      this.lead = lead;
    }
    const children = teamThreadChildren(lead, workers);
    this.total = children.length;
    const keep = new Set<string>();
    for (const worker of children.slice(0, TEAM_THREAD_WORKERS)) {
      keep.add(worker.id);
      let member = this.members.get(worker.id);
      if (!member || member.worker.sessionId !== worker.sessionId) {
        member = { worker, history: new ThreadHistory(), received: false, error: '', nextReadAt: member?.nextReadAt ?? 0 };
        this.members.set(worker.id, member);
      }
      member.worker = worker;
    }
    for (const id of this.members.keys()) if (!keep.has(id)) this.members.delete(id);
  }

  enable(on: boolean) {
    this.enabled = on && !this.disposed;
    if (!this.enabled) for (const member of this.members.values()) member.pending = undefined;
  }

  read(now: number, send: (msg: Extract<ClientMsg, { t: 'thread.read' }>) => boolean, request: () => string) {
    if (!this.enabled) return;
    for (const member of this.members.values()) {
      if (member.pending && now - member.pending.at >= READ_TIMEOUT) {
        member.pending = undefined;
        member.error = 'The office did not return this conversation.';
        member.nextReadAt = now + READ_INTERVAL;
      }
      if (member.pending || now < member.nextReadAt || member.worker.lost || !member.worker.sessionId) continue;
      const id = request();
      member.nextReadAt = now + READ_INTERVAL;
      if (send({ t: 'thread.read', workerId: member.worker.id, request: id })) member.pending = { request: id, at: now };
    }
  }

  receive(msg: ServerMsg): boolean {
    if (!this.enabled || msg.t !== 'thread.snapshot') return false;
    const member = this.members.get(msg.workerId);
    if (!member?.pending || member.pending.request !== msg.request || msg.before !== undefined) return false;
    member.pending = undefined;
    if (!msg.error && member.worker.sessionId && msg.sessionId !== member.worker.sessionId) return false;
    member.error = msg.error ?? '';
    if (!member.error) {
      member.history.apply(msg);
      const entries = boundedEntries(member.history.entries);
      member.history.hasMore = msg.hasMore || entries.length < member.history.entries.length;
      member.history.entries = entries;
      member.received = true;
    }
    return true;
  }

  clear() {
    this.members.clear();
    this.total = 0;
  }

  dispose() {
    this.enable(false);
    this.clear();
    this.disposed = true;
  }
}

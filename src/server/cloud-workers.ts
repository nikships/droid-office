import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CloudTurn, CloudWorker } from '../shared/factory-cloud.js';
import type { AgentEffort, WorkerInfo, WorkerStatus } from '../shared/protocol.js';
import { isAgentEffort } from '../shared/protocol.js';
import { DESK_BY_ID } from '../shared/layout.js';
import { DropStore } from './drops.js';
import { clockWork } from './workers.js';

// A floor's cloud workers (see factory/cloud.ts, which drives their sessions on Factory): who sits
// where, what they're doing, and what the office remembers of their turns, kept in the floor's
// .droid-office/cloud-workers.json so they're back at their desks after a restart. They are sent
// with the same worker.update and worker.remove messages as the office's own workers, but never
// reach the WorkerManager: nothing there (PTYs, hooks, worktrees, the queue, the team, meetings,
// the worker limit) ever sees one.

const FILE = 'cloud-workers.json';
/** Fields of a WorkerInfo that only mean something while the office runs. */
const LIVE: readonly (keyof WorkerInfo)[] = ['open'];

/** What else on the floor takes desks and names: its own workers and guests. */
export interface CloudSeating {
  deskTaken(deskId: string): boolean;
  names(): Iterable<string>;
  pool: { names: readonly string[]; colors: readonly string[] };
}

export interface CloudEvents {
  update(info: WorkerInfo): void;
  remove(workerId: string): void;
}

interface Cloudie {
  info: WorkerInfo;
  turn: CloudTurn;
  /** The session's message count and update time as of the last poll, to read its transcript only when it moved. */
  seen?: { count: number; updatedAt: number };
  /** When its session was last read (ms). */
  polledAt: number;
  /** What was last sent, to tell whether anything changed. */
  sent: string;
}

interface Saved {
  info: WorkerInfo;
  turn?: CloudTurn;
}

export interface NewCloudWorker {
  deskId: string;
  by: string;
  sessionId: string;
  cloud: CloudWorker;
  prompt?: string;
  model?: string;
  effort?: AgentEffort;
}

export class CloudWorkers {
  private workers = new Map<string, Cloudie>();
  /** Desks held while a session is being made for them, so a second hire doesn't take the same one. */
  private held = new Set<string>();
  private subscribers = new Map<string, Set<string>>();
  private file: string;
  private savedJson = '';
  readonly drops: DropStore;

  constructor(
    readonly dataDir: string,
    private seating: CloudSeating,
    private events: CloudEvents,
  ) {
    this.file = path.join(dataDir, FILE);
    this.drops = new DropStore(dataDir);
    this.restore();
  }

  list(): WorkerInfo[] {
    return [...this.workers.values()].map((w) => w.info);
  }

  get(id: string): WorkerInfo | undefined {
    return this.workers.get(id)?.info;
  }

  /** The turn the office is following for a worker (see cloudStatus). */
  turn(id: string): CloudTurn | undefined {
    return this.workers.get(id)?.turn;
  }

  deskTaken(deskId: string): boolean {
    if (this.held.has(deskId)) return true;
    for (const w of this.workers.values()) if (w.info.deskId === deskId) return true;
    return false;
  }

  names(): string[] {
    return [...this.workers.values()].map((w) => w.info.name);
  }

  /** Why nobody can be hired at `deskId` now, or undefined when they can. */
  seatRefusal(deskId: string): string | undefined {
    const seat = DESK_BY_ID.get(deskId);
    if (!seat) return 'Unknown desk';
    if (seat.station) return 'A board agent always works on this machine';
    if (seat.room) return 'Only a meeting seats workers at the meeting table';
    if (this.deskTaken(deskId) || this.seating.deskTaken(deskId)) return `That ${seat.beanbag ? 'bean bag' : 'desk'} is taken`;
    return undefined;
  }

  /** Holds a desk while its session is made; `release` gives it back. */
  hold(deskId: string): string | undefined {
    const why = this.seatRefusal(deskId);
    if (why) return why;
    this.held.add(deskId);
    return undefined;
  }

  release(deskId: string) {
    this.held.delete(deskId);
  }

  /** Seats a cloud worker whose session was just made (at a desk `hold` kept for it). */
  add(n: NewCloudWorker): WorkerInfo {
    this.held.delete(n.deskId);
    const used = new Set([...this.seating.names(), ...this.names()].map((x) => x.replace(/ 🐚$/, '')));
    const { names, colors } = this.seating.pool;
    const name = names.find((x) => !used.has(x)) ?? `Worker ${used.size + 1}`;
    const prompt = n.prompt?.trim() || undefined;
    const info: WorkerInfo = {
      id: randomBytes(6).toString('hex'),
      kind: 'cloud',
      model: n.model,
      effort: n.effort,
      activeModel: n.model,
      activeEffort: n.effort,
      deskId: n.deskId,
      name,
      color: colors[Math.floor(Math.random() * colors.length)],
      status: prompt ? 'starting' : 'idle',
      acked: true,
      createdBy: n.by,
      createdAt: Date.now(),
      prompt,
      sessionId: n.sessionId,
      cols: 100,
      rows: 30,
      open: false,
      activity: prompt ? (prompt.length > 80 ? `${prompt.slice(0, 79)}…` : prompt) : 'Ready for a first prompt',
      cloud: n.cloud,
    };
    const w: Cloudie = { info, turn: {}, polledAt: 0, sent: '' };
    this.workers.set(info.id, w);
    this.emit(w);
    return info;
  }

  /** Changes a worker with `fn` and tells everyone, when something changed. Status changes go through setStatus. */
  update(id: string, fn: (info: WorkerInfo, w: { turn: CloudTurn; seen?: { count: number; updatedAt: number } }) => void): WorkerInfo | undefined {
    const w = this.workers.get(id);
    if (!w) return undefined;
    fn(w.info, w);
    this.emit(w);
    return w.info;
  }

  /** Remembers what the last poll saw of a worker's session, and when. */
  polled(id: string, seen: { count: number; updatedAt: number } | undefined, turn: CloudTurn, at: number) {
    const w = this.workers.get(id);
    if (!w) return;
    w.polledAt = at;
    if (seen) w.seen = seen;
    w.turn = turn;
  }

  polledAt(id: string): number {
    return this.workers.get(id)?.polledAt ?? 0;
  }

  seen(id: string): { count: number; updatedAt: number } | undefined {
    return this.workers.get(id)?.seen;
  }

  /**
   * The same rules as a local worker's status (WorkerManager.setStatus): done or needs input raises
   * the flag unless its window is open, and anything else lowers it.
   */
  setStatus(id: string, status: WorkerStatus) {
    const w = this.workers.get(id);
    if (!w || w.info.status === status) return;
    clockWork(w.info, status);
    w.info.status = status;
    if (status !== 'working' && status !== 'needs_input') w.info.action = undefined;
    if (status === 'done' || status === 'needs_input') {
      w.info.acked = status === 'done' && w.info.open;
      w.info.waitingSince = Date.now();
    } else w.info.acked = true;
    this.emit(w);
  }

  /** Sends a worker home: it leaves its desk now. */
  remove(id: string): WorkerInfo | undefined {
    const w = this.workers.get(id);
    if (!w) return undefined;
    this.workers.delete(id);
    this.subscribers.delete(id);
    this.drops.remove(id);
    this.events.remove(id);
    this.persist();
    return w.info;
  }

  /** Someone opened a worker's window: a finished turn counts as seen. */
  attach(id: string, clientId: string): boolean {
    const w = this.workers.get(id);
    if (!w) return false;
    let subs = this.subscribers.get(id);
    if (!subs) this.subscribers.set(id, (subs = new Set()));
    subs.add(clientId);
    if (!w.info.open || !w.info.acked) {
      w.info.open = true;
      w.info.acked = true;
      this.emit(w);
    }
    return true;
  }

  detach(id: string, clientId: string) {
    const subs = this.subscribers.get(id);
    if (!subs?.delete(clientId) || subs.size) return;
    this.subscribers.delete(id);
    const w = this.workers.get(id);
    if (!w) return;
    w.info.open = false;
    this.emit(w);
  }

  detachAll(clientId: string) {
    for (const id of [...this.subscribers.keys()]) this.detach(id, clientId);
  }

  private emit(w: Cloudie) {
    const json = JSON.stringify(w.info);
    if (json !== w.sent) {
      w.sent = json;
      this.events.update({ ...w.info });
    }
    this.persist();
  }

  private persist() {
    const saved: Saved[] = [...this.workers.values()].map((w) => {
      const info: Partial<WorkerInfo> = { ...w.info };
      for (const k of LIVE) delete info[k];
      return { info: info as WorkerInfo, ...(w.turn.sentAt !== undefined || w.turn.seenBusy ? { turn: w.turn } : {}) };
    });
    const json = JSON.stringify(saved, null, 2);
    if (json === this.savedJson) return;
    this.savedJson = json;
    try {
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, json, { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch {
      // disk trouble: they're still here until the office stops
    }
  }

  private restore() {
    if (!existsSync(this.file)) return;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      return;
    }
    if (!Array.isArray(raw)) return;
    for (const s of raw as Saved[]) {
      const info = validInfo(s?.info);
      if (!info || this.workers.has(info.id) || this.deskTaken(info.deskId)) continue;
      // Its first message may never have gone: it's at rest until its session says otherwise.
      if (info.status === 'starting') info.status = 'idle';
      const turn: CloudTurn = s.turn && typeof s.turn === 'object' ? s.turn : {};
      const w: Cloudie = { info, turn, polledAt: 0, sent: JSON.stringify(info) };
      this.workers.set(info.id, w);
    }
    this.savedJson = JSON.stringify(
      [...this.workers.values()].map((w) => ({ info: w.info, ...(w.turn.sentAt !== undefined || w.turn.seenBusy ? { turn: w.turn } : {}) })),
      null,
      2,
    );
  }
}

const STATUSES = new Set<unknown>(['starting', 'idle', 'working', 'needs_input', 'done', 'exited', 'offline']);

/** A saved cloud worker that still makes sense, or undefined. */
function validInfo(raw: unknown): WorkerInfo | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as WorkerInfo;
  const c = r.cloud as CloudWorker | undefined;
  if (r.kind !== 'cloud' || typeof r.id !== 'string' || !/^[\w-]{1,64}$/.test(r.id) || typeof r.deskId !== 'string' || !DESK_BY_ID.has(r.deskId)) return undefined;
  if (typeof r.name !== 'string' || typeof r.sessionId !== 'string' || !r.sessionId) return undefined;
  if (!c || typeof c.computerId !== 'string' || typeof c.computerName !== 'string') return undefined;
  return {
    ...r,
    color: typeof r.color === 'string' ? r.color : '#5bc0eb',
    status: STATUSES.has(r.status) ? r.status : 'idle',
    effort: isAgentEffort(r.effort) ? r.effort : undefined,
    acked: r.acked !== false,
    open: false,
    cols: 100,
    rows: 30,
    cloud: { computerId: c.computerId, computerName: c.computerName, provider: c.provider, cwd: c.cwd, autonomy: c.autonomy ?? 'high', ...(c.error ? { error: c.error } : {}) },
  };
}

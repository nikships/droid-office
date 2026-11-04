import type { WorkerInfo } from '../shared/protocol.js';
import type { Team, TeamReply, TeamViews } from './team.js';
import type { Visits, VisitReply } from './visits.js';
import type { RemoteWorkers } from './remote-workers.js';
import type { WorkerManager } from './workers.js';
import type { WhiteboardStore } from './whiteboard.js';

export interface RemoteFloor {
  id: string;
  def: { name: string };
  dir: string;
  workers: Pick<WorkerManager, 'get' | 'list' | 'authenticate' | 'remoteSeat' | 'attachRemote' | 'detachRemote' | 'releaseRemoteLead' | 'remoteStatus'> & Partial<Pick<WorkerManager, 'screenLines' | 'screenMenu' | 'write'>>;
  team: Pick<Team, 'handle' | 'inbox' | 'onWorkerGone' | 'cannotHire' | 'hasNews' | TeamViews>;
  visits: Pick<Visits, 'handle' | 'onWorkerGone' | 'cannotVisit'>;
  whiteboard: WhiteboardStore;
}

/** Remote ownership is building-wide. Only its physical desk and default tool workspace move. */
export class RemoteOffice {
  constructor(
    readonly store: RemoteWorkers,
    private readonly floors: () => RemoteFloor[],
  ) {}

  floor(id: string): RemoteFloor | undefined {
    return this.floors().find((f) => f.workers.get(id)?.remote);
  }

  /** Every open floor, where a remote lead's teams may be. */
  teamFloors(): RemoteFloor[] {
    return this.floors();
  }

  list(id: string) {
    return this.floors().map((f) => ({
      id: f.id,
      name: f.def.name,
      cwd: f.dir,
      current: !!f.workers.get(id)?.remote,
      subagents: f.workers.list().filter((w) => w.lead === id).length,
      unreadTeam: f.team.inbox(id).length,
    }));
  }

  add(name: string, floorId: string) {
    const floor = this.floors().find((f) => f.id === floorId);
    if (!floor) throw new Error('Choose an open floor');
    const desk = floor.workers.remoteSeat(name);
    const result = this.store.add(name, floor.id, desk);
    floor.workers.attachRemote(result.worker);
    return result;
  }

  move(id: string, floorId: string) {
    const old = this.floor(id);
    const next = this.floors().find((f) => f.id === floorId);
    if (!next) throw new Error('Choose an open floor from office_floors');
    const worker = old?.workers.get(id) ?? this.store.identity(id);
    if (!worker) throw new Error('This remote identity was revoked');
    if (old === next) return this.list(id);
    const deskId = next.workers.remoteSeat(worker.name, true);
    // Persist the only authoritative seat before emitting the change. No await splits this move.
    this.store.move(id, next.id, deskId);
    old?.workers.detachRemote(id);
    next.workers.attachRemote({ ...worker, deskId, open: false });
    return this.list(id);
  }

  /** Seats a remote worker on the first other open floor with a free desk, when its own closed. */
  rehome(id: string, leaving?: string): boolean {
    for (const f of this.floors()) {
      if (f.id === leaving) continue;
      try {
        this.move(id, f.id);
        return true;
      } catch {
        // no free desk there, or its name is taken: the next floor
      }
    }
    return false;
  }

  revoke(id: string) {
    this.store.remove(id);
    for (const floor of this.floors()) {
      floor.workers.detachRemote(id);
      floor.workers.releaseRemoteLead(id);
      floor.team.onWorkerGone(id);
      floor.visits.onWorkerGone(id);
      floor.whiteboard.forgetReader(id);
    }
  }

  inbox(id: string, ack: readonly string[] = [], limit = 50) {
    const messages = this.store.inbox(id, ack, 500).messages.map((m) => ({ ...m, kind: 'message' }));
    for (const floor of this.floors()) {
      const prefix = `team:${floor.id}:`;
      const heard = ack
        .filter((s) => s.startsWith(prefix))
        .map((s) => Number(s.slice(prefix.length)))
        .filter(Number.isSafeInteger);
      for (const e of floor.team.inbox(id, heard)) messages.push({ id: `${prefix}${e.seq}`, floor: floor.id, at: e.at, kind: e.kind, text: `${e.name}: ${e.kind}${e.text ? `\n${e.text}` : ''}` });
    }
    messages.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    return { messages: messages.slice(0, limit), remaining: Math.max(0, messages.length - limit), floors: this.list(id) };
  }

  /** `since` holds a status cursor per floor; a floor it leaves out reports everything it keeps. */
  async team(worker: WorkerInfo, args: { action: string; worker?: string; lines?: number; text?: string; floor?: string; since?: Record<string, number>; kinds?: string[] }): Promise<TeamReply> {
    const floors = this.floors().filter((f) => !args.floor || f.id === args.floor);
    if (!floors.length) return { status: 404, body: { error: 'No such open floor' } };
    if (args.worker) {
      const wanted = args.worker.toLowerCase();
      const matches = floors.flatMap((f) =>
        f.workers
          .list()
          .filter((w) => w.lead === worker.id && (w.id === wanted || w.name.toLowerCase() === wanted))
          .map((w) => ({ f, w })),
      );
      if (matches.length !== 1) return { status: 409, body: { error: matches.length ? 'That name occurs on several floors; use the worker id or specify floor' : 'No such subagent in your teams' } };
      const { f, w } = matches[0];
      const result = await f.team.handle(worker, { ...args, worker: w.id, since: args.since ? (args.since[f.id] ?? 0) : undefined });
      return args.action === 'status' && result.status < 400 ? { status: 200, body: { ...result.body, ...merged([{ floor: f.id, result }]) } } : result;
    }
    if (args.action !== 'status') return { status: 400, body: { error: 'Name a subagent' } };
    const snapshots = await Promise.all(floors.map(async (f) => ({ floor: f.id, result: await f.team.handle(worker, { ...args, since: args.since ? (args.since[f.id] ?? 0) : undefined }) })));
    return { status: 200, body: merged(snapshots) };
  }

  reply(worker: WorkerInfo, visit: string, text: string): VisitReply {
    for (const floor of this.floors()) {
      const result = floor.visits.handle(worker, { action: 'reply', visit, text });
      if (result.status !== 404) return result;
    }
    return { status: 404, body: { error: 'No live question with that id is addressed to you. Questions expire after 30 minutes and on office restart; use visit_message for a follow-up.' } };
  }
}

/** Floor snapshots as one status, each subagent and event tagged with its floor, and each floor's latest event seq. */
function merged(snapshots: { floor: string; result: TeamReply }[]): Record<string, unknown> {
  return {
    team: snapshots.flatMap(({ floor, result }) => (result.body.team as Record<string, unknown>[]).map((w) => ({ ...w, floor }))),
    events: snapshots.flatMap(({ floor, result }) => (result.body.events as Record<string, unknown>[]).map((e) => ({ ...e, floor }))),
    latest: Object.fromEntries(snapshots.map(({ floor, result }) => [floor, result.body.latest])),
  };
}

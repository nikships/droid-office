import path from 'node:path';
import type { WorkerInfo } from '../shared/protocol.js';
import type { Team, TeamReply, TeamViews } from './team.js';
import type { Visits } from './visits.js';
import type { RemoteWorkers } from './remote-workers.js';
import type { WorkerManager } from './workers.js';
import type { WhiteboardStore } from './whiteboard.js';

export interface RemoteFloor {
  id: string;
  def: { name: string };
  dir: string;
  workers: Pick<WorkerManager, 'get' | 'list' | 'authenticate' | 'releaseLead'> & Partial<Pick<WorkerManager, 'screenLines' | 'screenMenu' | 'write'>>;
  team: Pick<Team, 'handle' | 'inbox' | 'onWorkerGone' | 'cannotHire' | 'hasNews' | 'leadRested' | TeamViews>;
  visits: Pick<Visits, 'handle' | 'onWorkerGone' | 'cannotVisit'>;
  whiteboard: WhiteboardStore;
}

/** The open floor a reference names: its id, its name (any case) or its checkout's path. */
export function floorNamed<F extends { id: string; def: { name: string }; dir: string }>(floors: readonly F[], ref: string): F | undefined {
  const want = ref.trim();
  const lower = want.toLowerCase();
  return floors.find((f) => f.id === want) ?? floors.find((f) => path.isAbsolute(want) && path.resolve(f.dir) === path.resolve(want)) ?? floors.find((f) => f.def.name.toLowerCase() === lower);
}

/**
 * The building agents' side of every floor: Mission Control has no desks, so a building agent's teams,
 * inbox and hires span every open floor, and each hire names its floor.
 */
export class RemoteOffice {
  constructor(
    readonly store: RemoteWorkers,
    /** Every open floor, where a building agent's teams may be. */
    readonly floors: () => RemoteFloor[],
  ) {}

  list(id: string) {
    return this.floors().map((f) => ({
      id: f.id,
      name: f.def.name,
      cwd: f.dir,
      subagents: f.workers.list().filter((w) => w.lead === id).length,
      unreadTeam: f.team.inbox(id).length,
    }));
  }

  add(name: string) {
    return this.store.add(name);
  }

  /** The bot's key stops working, and its subagents carry on as independent workers. */
  revoke(id: string) {
    this.store.remove(id);
    for (const floor of this.floors()) {
      floor.workers.releaseLead(id);
      floor.team.onWorkerGone(id);
      floor.visits.onWorkerGone(id);
      floor.whiteboard.forgetReader(id);
    }
  }

  inbox(id: string, ack: readonly string[] = [], limit = 50, own = true) {
    const messages = own ? this.store.inbox(id, ack, 500).messages.map((m) => ({ ...m, kind: 'message' })) : [];
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
  async team(worker: WorkerInfo, args: { action: string; worker?: string; lines?: number; text?: string; floor?: string; since?: Record<string, number>; kinds?: string[]; [key: string]: unknown }): Promise<TeamReply> {
    const all = this.floors();
    if (args.action === 'hire') {
      const ref = typeof args.repo === 'string' ? args.repo : args.floor;
      if (!ref) return { status: 400, body: { error: 'Name the floor to hire on: task.repo takes an open floor’s path, id or name (office_floors lists them).' } };
      const target = floorNamed(all, ref);
      if (!target) return { status: 404, body: { error: `No open floor ${ref}. office_floors lists them: ${all.map((f) => `${f.def.name} (${f.id})`).join(', ') || 'none open'}.` } };
      return target.team.handle(worker, { ...args, ...(typeof args.repo === 'string' ? { repo: target.dir } : {}) });
    }
    const floors = all.filter((f) => !args.floor || f.id === args.floor);
    if (!floors.length) return { status: 404, body: { error: 'No such open floor' } };
    if (args.worker) {
      const wanted = args.worker.toLowerCase();
      const matches = floors.flatMap((f) =>
        f.workers
          .list()
          .filter((w) => w.lead === worker.id && (w.id === wanted || w.name.toLowerCase() === wanted))
          .map((w) => ({ f, w })),
      );
      if (matches.length !== 1) return { status: matches.length ? 409 : 404, body: { error: matches.length ? 'That name occurs on several floors; use the worker id or specify floor' : 'No such subagent in your teams' } };
      const { f, w } = matches[0];
      const result = await f.team.handle(worker, { ...args, worker: w.id, since: args.since ? (args.since[f.id] ?? 0) : undefined });
      if (args.action !== 'status' || result.status >= 400) return result;
      // Every floor's position, so this cursor also serves a later status of the whole building.
      const latest = Object.fromEntries(floors.map((x) => [x.id, x === f ? result.body.latest : x.team.latest()]));
      return { status: 200, body: { ...result.body, ...merged([{ floor: f.id, result }]), latest } };
    }
    if (args.action !== 'status') return { status: 400, body: { error: 'Name a subagent' } };
    const snapshots = await Promise.all(floors.map(async (f) => ({ floor: f.id, result: await f.team.handle(worker, { ...args, since: args.since ? (args.since[f.id] ?? 0) : undefined }) })));
    return { status: 200, body: merged(snapshots) };
  }
}

/** Floor snapshots as one status, each subagent and event tagged with its floor, and each floor's latest event seq. */
function merged(snapshots: { floor: string; result: TeamReply }[]): Record<string, unknown> {
  return {
    team: snapshots.flatMap(({ floor, result }) => ((result.body.team as Record<string, unknown>[] | undefined) ?? []).map((w) => ({ ...w, floor }))),
    events: snapshots.flatMap(({ floor, result }) => ((result.body.events as Record<string, unknown>[] | undefined) ?? []).map((e) => ({ ...e, floor }))),
    latest: Object.fromEntries(snapshots.map(({ floor, result }) => [floor, result.body.latest])),
  };
}

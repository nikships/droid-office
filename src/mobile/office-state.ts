import type { FloorInfo, GhPull, ProjectInfo, ServerMsg, SubagentsState, WorkerInfo, WorktreeState } from '../shared/protocol';
import type { SubscriptionsState } from '../shared/subscriptions';

/** What the app knows of the office it is connected to, read only from ServerMsg. */
export interface OfficeState {
  /** Set by `welcome`; false until the first one, and after a socket change until the next. */
  synced: boolean;
  floors: FloorInfo[];
  /** The floor the server put this connection on: only `welcome` and `floor.enter` change it. */
  floor: string | null;
  project: ProjectInfo | null;
  workers: Record<string, WorkerInfo>;
  pulls: GhPull[];
  subagents?: SubagentsState;
  subscriptions?: SubscriptionsState;
  hiddenModels: string[];
  /** Answers to `worker.worktree`, by worker, for the send-home check. */
  worktrees: Record<string, WorktreeState>;
  /** Grows on every `welcome` and `floor.enter`: panes and feeds started before it are stale. */
  arrival: number;
  toasts: OfficeToast[];
}

export interface OfficeToast {
  id: number;
  text: string;
  level: 'info' | 'warn' | 'error';
  at: number;
}

export const TOAST_MS = 6000;

export const TOASTS_KEPT = 4;

export function emptyOffice(): OfficeState {
  return { synced: false, floors: [], floor: null, project: null, workers: {}, pulls: [], hiddenModels: [], worktrees: {}, arrival: 0, toasts: [] };
}

let toastSerial = 0;
export function withToast(state: OfficeState, text: string, level: OfficeToast['level'] = 'info', at = Date.now()): OfficeState {
  return { ...state, toasts: [...state.toasts, { id: ++toastSerial, text, level, at }].slice(-TOASTS_KEPT) };
}

export function expireToasts(state: OfficeState, now: number): OfficeState {
  const toasts = state.toasts.filter((t) => now - t.at < TOAST_MS);
  return toasts.length === state.toasts.length ? state : { ...state, toasts };
}

export function dropToast(state: OfficeState, id: number): OfficeState {
  return { ...state, toasts: state.toasts.filter((t) => t.id !== id) };
}

const byId = (workers: readonly WorkerInfo[]) => Object.fromEntries(workers.map((w) => [w.id, w]));

/** Pure: the next state for one ServerMsg. Messages the app doesn't show leave the state as it is. */
export function reduceOffice(state: OfficeState, msg: ServerMsg): OfficeState {
  switch (msg.t) {
    case 'welcome':
      return {
        ...state,
        synced: true,
        floors: msg.floors,
        floor: msg.floor,
        project: msg.project,
        workers: byId(msg.workers),
        pulls: msg.pulls.items,
        subagents: msg.subagents,
        subscriptions: msg.subscriptions,
        hiddenModels: msg.hiddenModels ?? [],
        worktrees: {},
        arrival: state.arrival + 1,
      };
    case 'floor.enter':
      return { ...state, floor: msg.floor, project: msg.project, workers: byId(msg.workers), pulls: msg.pulls.items, worktrees: {}, arrival: state.arrival + 1 };
    case 'floors':
      return { ...state, floors: msg.floors };
    case 'worker.update':
      return { ...state, workers: { ...state.workers, [msg.worker.id]: msg.worker } };
    case 'worker.remove': {
      if (!state.workers[msg.workerId]) return state;
      const { [msg.workerId]: _gone, ...workers } = state.workers;
      const { [msg.workerId]: _state, ...worktrees } = state.worktrees;
      return { ...state, workers, worktrees };
    }
    case 'worker.worktree':
      return { ...state, worktrees: { ...state.worktrees, [msg.workerId]: msg.state } };
    case 'gh.pulls':
      return { ...state, pulls: msg.state.items };
    case 'subagents':
      return { ...state, subagents: msg.state };
    case 'subscriptions':
      return { ...state, subscriptions: msg.state };
    case 'models.hidden':
      return { ...state, hiddenModels: msg.ids };
    case 'toast':
      return withToast(state, msg.text, msg.level);
    default:
      return state;
  }
}

/** The connection went: nothing it said is current until the next `welcome`. */
export function officeDisconnected(state: OfficeState): OfficeState {
  return { ...state, synced: false };
}

export function currentFloor(state: OfficeState): FloorInfo | undefined {
  return state.floors.find((f) => f.id === state.floor);
}

/** Hiring with a worktree is offered only where the office could cut one. */
export function canWorktree(floor: FloorInfo | undefined): boolean {
  return !!floor && !floor.home && !floor.plain && !!floor.branch;
}

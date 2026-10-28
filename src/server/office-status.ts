import type { WorkerInfo } from '../shared/protocol.js';

/** How many waiting workers the status names: the menu bar shows fewer, and says how many more there are. */
export const STATUS_WAITING_MAX = 20;

/** A worker waiting on the owner: a question or permission, or a finished turn nobody has looked at. */
export interface StatusWaiting {
  id: string;
  name: string;
  status: 'needs_input' | 'done';
  floor: string;
  floorName: string;
  /** The task it is on (its card's title), when it has one. */
  task?: string;
  /** When it started to wait (ms), so whoever waited longest comes first. */
  since: number;
}

/** What the Mac app's menu bar icon shows of a running office (`GET /api/status`). */
export interface OfficeStatus {
  workers: number;
  working: number;
  needsInput: number;
  /** Finished their turn and nobody has opened their terminal since. */
  done: number;
  /** Paired phones with a connection open, each counted once however many sockets it holds. */
  phones: number;
  /** Open office pages and web companions that didn't come in on a phone's token. */
  browsers: number;
  /** Floors in the building: the menu names a worker's floor only when there is more than one. */
  floors: number;
  /** The workers waiting on the owner, questions first and then whoever waited longest, at most STATUS_WAITING_MAX. */
  waiting: StatusWaiting[];
}

export interface StatusConnection {
  device?: string;
  /** Set only for a phone's connection (a paired browser has none; see PhoneSizes). */
  phone: boolean;
}

export interface StatusFloor {
  id: string;
  name: string;
  workers: Iterable<Pick<WorkerInfo, 'id' | 'name' | 'kind' | 'status' | 'acked' | 'waitingSince' | 'createdAt'> & { task?: { name: string } }>;
}

/** Waiting on someone, as the elevator counts it (src/server/floor.ts): a shell never is. */
function waitingStatus(w: Pick<WorkerInfo, 'kind' | 'status' | 'acked'>): 'needs_input' | 'done' | undefined {
  if (w.kind === 'shell') return undefined;
  if (w.status === 'needs_input') return 'needs_input';
  if (w.status === 'done' && !w.acked) return 'done';
  return undefined;
}

export function officeStatus(floors: Iterable<StatusFloor>, connections: Iterable<StatusConnection>): OfficeStatus {
  const out: OfficeStatus = { workers: 0, working: 0, needsInput: 0, done: 0, phones: 0, browsers: 0, floors: 0, waiting: [] };
  for (const f of floors) {
    out.floors++;
    for (const w of f.workers) {
      out.workers++;
      if (w.status === 'working') out.working++;
      const waiting = waitingStatus(w);
      if (waiting === 'needs_input') out.needsInput++;
      if (waiting === 'done') out.done++;
      if (!waiting) continue;
      const task = w.task?.name.trim();
      out.waiting.push({ id: w.id, name: w.name, status: waiting, floor: f.id, floorName: f.name, ...(task ? { task } : {}), since: w.waitingSince ?? w.createdAt });
    }
  }
  // A question blocks its worker and a finished turn doesn't, so questions come first.
  out.waiting.sort((a, b) => Number(a.status === 'done') - Number(b.status === 'done') || a.since - b.since || a.id.localeCompare(b.id));
  out.waiting.length = Math.min(out.waiting.length, STATUS_WAITING_MAX);
  const phones = new Set<string>();
  for (const c of connections) {
    if (c.phone && c.device) phones.add(c.device);
    else out.browsers++;
  }
  out.phones = phones.size;
  return out;
}

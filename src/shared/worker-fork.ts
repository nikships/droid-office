import { DESKS, SEATS, type DeskDef } from './layout.js';
import type { WorkerInfo } from './protocol.js';

/** Shared eligibility for the dialog and the server; capacity and filesystem checks stay server-side. */
export function forkRefusal(w: WorkerInfo): string | undefined {
  if (w.kind !== 'agent' || w.guest) return 'Only local Droid workers can be forked';
  if (w.lost) return 'Restore its missing worktree before forking';
  if (!w.sessionId) return 'Wait for its Droid session to start before forking';
  if (w.status !== 'idle' && w.status !== 'done') return 'Wait until its turn ends before forking';
  if (w.prOpening) return 'Wait for its pull request to finish opening';
  return undefined;
}

/** Prefer desks over overflow bean bags, then distance from the source, with stable ties. */
export function nearestForkSeat(source: DeskDef, taken: (id: string) => boolean): DeskDef | undefined {
  const free = DESKS.filter((d) => !taken(d.id));
  return (free.length ? free : SEATS.filter((d) => !taken(d.id))).sort((a, b) => Math.hypot(a.x - source.x, a.z - source.z) - Math.hypot(b.x - source.x, b.z - source.z))[0];
}

/** Fork links don't make the twin a subagent or give it someone to report to. */
export function forkLinks(workers: Iterable<WorkerInfo>): { source: WorkerInfo; twin: WorkerInfo }[] {
  const all = new Map([...workers].map((w) => [w.id, w]));
  return [...all.values()].flatMap((twin) => {
    const source = twin.forkedFrom && all.get(twin.forkedFrom.workerId);
    return source ? [{ source, twin }] : [];
  });
}

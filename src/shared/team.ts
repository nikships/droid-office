import type { WorkerInfo } from './protocol.js';

/** A lead's subagents (see WorkerInfo.lead), oldest first. */
export function teamOf(workers: Iterable<WorkerInfo>, leadId: string): WorkerInfo[] {
  return [...workers].filter((w) => w.lead === leadId).sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Every worker by when it was hired, each lead's subagents right under it, so a team reads as one
 * block. A subagent whose lead has gone stands on its own.
 */
export function workersByTeam(workers: Iterable<WorkerInfo>): WorkerInfo[] {
  const all = [...workers].sort((a, b) => a.createdAt - b.createdAt);
  const ids = new Set(all.map((w) => w.id));
  return all.filter((w) => !w.lead || !ids.has(w.lead)).flatMap((w) => [w, ...all.filter((s) => s.lead === w.id)]);
}

/** "🧭 3 subagents · 2 working · 1 needs input" for a lead's team; nothing for an empty one. */
export function teamSummary(team: readonly WorkerInfo[]): string | undefined {
  if (!team.length) return undefined;
  const busy = team.filter((s) => s.status === 'working').length;
  const waiting = team.filter((s) => s.status === 'needs_input').length;
  return [`🧭 ${team.length} subagent${team.length === 1 ? '' : 's'}`, busy && `${busy} working`, waiting && `${waiting} need${waiting === 1 ? 's' : ''} input`].filter(Boolean).join(' · ');
}

// What a worker's status means, for the checks the server and the browser both make.

import type { GhPull, WorkerInfo, WorkerStatus } from './protocol.js';

/** Its process isn't running: it exited, or came back asleep after a restart. R wakes it. */
export function isAsleep(status: WorkerStatus): boolean {
  return status === 'exited' || status === 'offline';
}

/** In the middle of a turn: booting, working, or waiting on an answer. */
export function isBusy(status: WorkerStatus): boolean {
  return status === 'starting' || status === 'working' || status === 'needs_input';
}

/** Subagents wait on their orchestrator, never on the owner. Keep the underlying CLI state intact. */
export function needsOwnerInput(w: Pick<WorkerInfo, 'status' | 'lead'>): boolean {
  return !w.lead && w.status === 'needs_input';
}

export function needsOwnerAttention(w: Pick<WorkerInfo, 'status' | 'lead' | 'acked'>): boolean {
  return !w.lead && (w.status === 'needs_input' || (w.status === 'done' && !w.acked));
}

/** A neutral visual treatment for delegated input requests, not a change to the worker's status. */
export function statusTone(w: Pick<WorkerInfo, 'status' | 'lead'>): WorkerStatus | 'waiting' {
  return w.lead && w.status === 'needs_input' ? 'waiting' : w.status;
}

/**
 * One line for a notification about a worker: what it's asking for when it needs input, or what it
 * was on when it's done (its last activity may be a permission prompt it has long got past).
 */
export function alertDetail(w: WorkerInfo): string | undefined {
  return w.status === 'needs_input' ? (w.activity ?? w.task?.summary) : (w.task?.summary ?? w.prompt);
}

/** Generated current work wins over ordinary tool activity, but never over a live blocker. */
export function workerActivity(w: WorkerInfo): string | undefined {
  if (w.lost) return 'Worktree missing';
  if (w.cloud?.error) return w.cloud.error;
  return w.status === 'needs_input' || !w.task?.generated ? (w.activity ?? w.task?.summary) : (w.task.summary ?? w.activity);
}

/** A worker's pull request: still open, or merged (time to send it home). */
export interface WorkerPr {
  state: 'open' | 'merged';
  number: number;
}

/**
 * Where its work stands on the forge: a pull request from its desk or its worktree branch is open
 * (one still open wins, e.g. a follow-up on the same branch), or merged, so it can be sent home.
 * Undefined when it has none, or only closed ones.
 */
export function workerPr(w: WorkerInfo, pulls: GhPull[]): WorkerPr | undefined {
  const seen = pulls.filter((p) => w.pr?.number === p.number || (w.worktree && w.worktree.branch === p.headRefName)).map((p) => ({ number: p.number, state: p.state }));
  // Opened from its desk but not on the list yet (still loading, or no CLI to ask): it's open.
  if (w.pr && !seen.some((p) => p.number === w.pr?.number)) seen.push({ number: w.pr.number, state: 'OPEN' });
  const open = seen.find((p) => p.state === 'OPEN' || p.state === 'DRAFT');
  if (open) return { state: 'open', number: open.number };
  const merged = seen.find((p) => p.state === 'MERGED');
  return merged && { state: 'merged', number: merged.number };
}

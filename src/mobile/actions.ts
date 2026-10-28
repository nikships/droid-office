import { companionCapabilities } from '../shared/companion-roster';
import type { AgentEffort, ClientMsg, WorkerInfo, WorktreeCleanup, WorktreeState } from '../shared/protocol';
import { AUTO_DESK } from '../shared/protocol';
import { isAsleep, isBusy } from '../shared/status';
import { forkRefusal } from '../shared/worker-fork';

/** One thing the owner can do to a worker from the companion, and why it's off when it is. */
export interface WorkerAction {
  id: 'resume' | 'pr' | 'fork' | 'rebuild' | 'bringIn' | 'sendHome' | 'stop' | 'thread' | 'terminal';
  label: string;
  /** Unset when it can run now. */
  refusal?: string;
  /** Asks the owner first (send home, rebuild everything). */
  confirm?: boolean;
  danger?: boolean;
}

const local = (w: WorkerInfo) => !w.guest && !w.cloud && w.kind !== 'cloud';

/**
 * The actions a worker offers, with the same rules as the web companion and the office: a guest is
 * only watched, a cloud worker has no terminal or worktree here, a lost worker must be rebuilt or sent
 * home first. No bulk, broadcast or reparent action exists here.
 */
export function workerActions(w: WorkerInfo, connected: boolean): WorkerAction[] {
  const caps = companionCapabilities(w);
  const off = (why?: string) => (!connected ? 'Disconnected. Nothing can be sent.' : why);
  const out: WorkerAction[] = [];
  if (caps.thread) out.push({ id: 'thread', label: 'Thread' });
  if (local(w)) out.push({ id: 'terminal', label: 'Raw TTY', refusal: caps.terminal ? undefined : w.lost ? 'Its worktree is missing.' : 'Resume it to open its terminal.' });
  if (w.guest) {
    out.push({ id: 'bringIn', label: 'Bring in', refusal: off(w.guest.cantBringIn) });
    return out;
  }
  if (isAsleep(w.status)) out.push({ id: 'resume', label: w.kind === 'shell' ? 'Restart' : 'Resume', refusal: off(w.lost ? 'Rebuild its worktree first.' : undefined) });
  if (w.kind === 'agent' && local(w) && (isBusy(w.status) || w.status === 'needs_input')) out.push({ id: 'stop', label: 'Stop turn', refusal: off() });
  if (local(w) && w.worktree && !w.pr) out.push({ id: 'pr', label: 'Open PR', refusal: off(w.lost ? 'Its worktree is missing.' : w.prOpening ? 'Opening its pull request…' : isBusy(w.status) ? 'Wait until its turn ends.' : undefined) });
  if (w.kind === 'agent' && local(w)) out.push({ id: 'fork', label: 'Fork', refusal: off(forkRefusal(w)) });
  if (w.lost && local(w)) out.push({ id: 'rebuild', label: 'Rebuild worktree', refusal: off(), confirm: true });
  out.push({ id: 'sendHome', label: 'Send home', refusal: off(), confirm: true, danger: true });
  return out;
}

export function resumeMsg(w: WorkerInfo): ClientMsg {
  return { t: 'worker.resume', workerId: w.id };
}
export function prMsg(w: WorkerInfo): ClientMsg {
  return { t: 'worker.pr', workerId: w.id };
}
export function forkMsg(w: WorkerInfo, prompt: string): ClientMsg {
  const text = prompt.trim();
  return { t: 'worker.fork', workerId: w.id, ...(text ? { prompt: text } : {}) };
}
/** Only this worker: "every lost worker on the floor" is a bulk action the companion does not offer. */
export function rebuildMsg(w: WorkerInfo): ClientMsg {
  return { t: 'worker.rebuild', workerId: w.id };
}
export function bringInMsg(w: WorkerInfo): ClientMsg {
  return { t: 'guest.bringIn', workerId: w.id };
}
/** A cloud worker's Factory session is never deleted from here; sending a lead home leaves its subagents. */
export function sendHomeMsg(w: WorkerInfo, cleanup: WorktreeCleanup): ClientMsg {
  return { t: 'worker.kill', workerId: w.id, cleanup: w.worktree && local(w) ? cleanup : 'keep', deleteSession: false };
}
/** Escape is the CLI's own cancel path; it needs the worker attached, like Raw TTY. */
export function stopMsg(w: WorkerInfo): ClientMsg {
  return { t: 'term.input', workerId: w.id, data: '\u001b' };
}

/** Send home asks what becomes of a worktree first; a worker without one only confirms. */
export function sendHomeNeedsWorktreeCheck(w: WorkerInfo): boolean {
  return !!w.worktree && local(w);
}

export function sendHomeText(w: WorkerInfo, where: string, subagents: number): string {
  const base = w.cloud
    ? 'This frees its desk. Its Factory session stays archived; a computer this worker made is deleted, as in the office.'
    : w.worktree
      ? `This stops the session at ${where} for everyone and frees the desk. ${w.name} worked in its own worktree on ${w.worktree.branch}.`
      : 'This stops its terminal for every window and frees its desk. Work in the checkout is kept.';
  return subagents ? `${base} Its ${subagents === 1 ? 'subagent stays' : `${subagents} subagents stay`} on the floor.` : base;
}

export const CLEANUP_LABEL: Record<WorktreeCleanup, string> = {
  all: 'Send home & delete both',
  worktree: 'Send home & delete worktree',
  keep: 'Send home',
};

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** What deleting a worktree (and its branch) would lose; the same words as the office's send-home dialog. */
export function describeWorktree(s: WorktreeState, branch: string): { lines: string[]; risky: boolean; checked: boolean } {
  const parts = s.repos?.length ? s.repos.map((r) => ({ state: r.state, prefix: `${r.name}: ` })) : [{ state: s, prefix: '' }];
  const lines: string[] = [];
  let risky = false;
  let checked = !s.error || !!s.repos?.length;
  for (const { state, prefix } of parts) {
    if (state.error) {
      lines.push(`${prefix}Couldn't check the worktree: ${state.error}.`);
      risky = true;
      checked = false;
      continue;
    }
    const before = lines.length;
    if (!state.exists) lines.push(`${prefix}The worktree folder is already gone.`);
    if (state.dirty) {
      lines.push(`${prefix}${plural(state.dirty, 'uncommitted change')} in the worktree: deleting it loses them.`);
      risky = true;
    }
    if (state.unpushed) {
      lines.push(`${prefix}${plural(state.unpushed, 'commit')} on ${branch} that no remote has: deleting the branch loses them.`);
      risky = true;
    } else if (state.ahead) lines.push(`${prefix}${plural(state.ahead, 'commit')} on ${branch}, all pushed or merged.`);
    if (lines.length === before) lines.push(`${prefix}Nothing on the branch yet and a clean worktree: safe to delete.`);
  }
  return { lines, risky, checked };
}

/** Deleting is allowed only once the office answered with what the worktree holds. */
export function cleanupAllowed(cleanup: WorktreeCleanup, check: { checked: boolean } | undefined): boolean {
  return cleanup === 'keep' || !!check?.checked;
}

export interface HireRequest {
  kind: 'agent' | 'shell';
  prompt: string;
  worktree: boolean;
  model?: string;
  effort?: AgentEffort;
  images: string[];
}

/** A hire takes the first free seat on the floor, as the Android app always has (AUTO_DESK). */
export function hireMsg(r: HireRequest): ClientMsg {
  const prompt = r.prompt.trim();
  return {
    t: 'worker.spawn',
    deskId: AUTO_DESK,
    kind: r.kind,
    ...(prompt ? { prompt } : {}),
    worktree: r.worktree,
    ...(r.kind === 'agent' && r.model ? { model: r.model } : {}),
    ...(r.kind === 'agent' && r.effort ? { effort: r.effort } : {}),
    ...(r.kind === 'agent' && r.images.length ? { images: r.images } : {}),
  };
}

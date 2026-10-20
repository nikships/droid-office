// Ping a worker (docs/whiteboard.md, "Ping a worker"): whether the office can type the Whiteboard
// line into a worker's terminal now, and how. The server checks it when the ping arrives; the window's
// picker computes it from the live worker list, so both always agree.

import type { WorkerInfo } from './protocol.js';
import { wantsCsiEnter } from './csi-enter.js';

/** How the line goes in: typed now, typed into a sleeping worker as it's resumed, or queued behind its turn. */
export type PingHow = 'type' | 'resume' | 'queue';

export type PingEligibility =
  | { ok: true; how: PingHow }
  /** `busy`: it can take the line once it's free, so the picker shows it as busy rather than refused. */
  | { ok: false; reason: string; busy?: true };

/** What the office does when the owner pings `w` now, or why it can't. */
export function pingEligibility(w: WorkerInfo): PingEligibility {
  if (w.guest) return { ok: false, reason: `${w.name} is a guest the office only watches: it has no terminal the office can type into. Bring it in first.` };
  if (w.kind === 'cloud') return { ok: false, reason: `${w.name} runs on a Factory computer, which can't reach this office's Whiteboard yet.` };
  if (w.kind === 'shell') return { ok: false, reason: `${w.name} is a plain shell, not an agent.` };
  if (w.lost) return { ok: false, reason: `${w.name}'s worktree is gone, so it can't start. Rebuild it first.` };
  switch (w.status) {
    case 'idle':
    case 'done':
      return { ok: true, how: 'type' };
    case 'exited':
    case 'offline':
      return { ok: true, how: 'resume' };
    case 'working':
      return wantsCsiEnter(w.kind) ? { ok: true, how: 'queue' } : { ok: false, busy: true, reason: `${w.name} is busy and can't queue a message. Ping it when it's free.` };
    case 'starting':
      return { ok: false, reason: `${w.name} is still starting.` };
    case 'needs_input':
      return { ok: false, reason: `${w.name} is waiting on an answer in its terminal. Answer it there first.` };
  }
}

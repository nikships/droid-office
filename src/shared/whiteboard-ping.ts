// Ping a worker (docs/whiteboard.md, "Ping a worker"): whether the office can type the Whiteboard
// line into a worker's terminal now, and how. The server checks it when the ping arrives; the window's
// picker computes it from the live worker list, so both always agree.

import type { WorkerInfo } from './protocol.js';
import type { Card } from './whiteboard.js';
import { wantsCsiEnter } from './csi-enter.js';

/** How the line goes in: typed now, typed into a sleeping worker as it's resumed, or queued behind its turn. */
export type PingHow = 'type' | 'resume' | 'queue';

export type PingEligibility =
  | { ok: true; how: PingHow }
  /** `busy`: it can take the line once it's free, so the picker shows it as busy rather than refused. */
  | { ok: false; reason: string; busy?: true };

/** What the office does when the owner pings `w` now, or why it can't. */
export function pingEligibility(w: WorkerInfo): PingEligibility {
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

/**
 * Who a card's `data-wb-ping` buttons tell (docs/whiteboard.md, "Buttons that tell a worker"): the
 * worker who last edited its page, while it's still on this floor. The frame disables the buttons
 * otherwise, with the reason, and the server checks again when a press arrives.
 */
export type ButtonTarget = { ok: true; id: string; name: string } | { ok: false; reason: string };

export function buttonTarget(card: Pick<Card, 'stamps'>, workers: Iterable<WorkerInfo>): ButtonTarget {
  const by = card.stamps.content?.author;
  if (by?.kind !== 'worker') return { ok: false, reason: 'You made this page, so its buttons have no worker to tell.' };
  let w: WorkerInfo | undefined;
  for (const x of workers) if (x.id === by.id) w = x;
  if (!w) return { ok: false, reason: `${by.name} is no longer on this floor.` };
  if (w.kind !== 'agent') return { ok: false, reason: `${w.name} can't take messages from the Whiteboard.` };
  if (w.lost) return { ok: false, reason: `${w.name}'s worktree is gone. Rebuild it first.` };
  return { ok: true, id: w.id, name: w.name };
}

/**
 * How a button's message goes in: typed now (steering a turn that's running, like a team message),
 * typed as a sleeping worker wakes, or held until it has started or the question in its terminal is
 * answered, since typing then would answer the question.
 */
export type ButtonDelivery = 'tell' | 'resume' | 'hold';

export function buttonDelivery(w: WorkerInfo): ButtonDelivery {
  if (w.remote) return 'tell';
  switch (w.status) {
    case 'exited':
    case 'offline':
      return 'resume';
    case 'starting':
    case 'needs_input':
      return 'hold';
    default:
      return 'tell';
  }
}

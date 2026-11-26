// The WebSocket half of guest enforcement (share links, see guest-links.ts and shared/guest-policy.ts):
// every message a guest connection sends passes admit() before the message switch, and every accepted
// write is written to the guest audit with its target and a one-line detail. Refusals are silent, or one
// generic error to that guest, and are never audited.

import type { GuestAudit } from '../guest-audit.js';
import type { GuestGrant, GuestLinks } from '../guest-links.js';
import type { Floor } from '../floor.js';
import { GUEST_CLOSE_DISABLED, GUEST_CLOSE_ENDED, type GuestAuditAction, type GuestAuditTarget } from '../../shared/guest-links.js';
import { GUEST_REFUSED, guestAdmit, type GuestAdmitted, type GuestWorld } from '../../shared/guest-policy.js';
import type { ClientMsg, WorkerInfo } from '../../shared/protocol.js';
import type { Client, SendTo } from './client.js';

/** Scope checks' view of the building: which open floor each desk or cloud worker sits on. */
export function guestWorld(floors: Map<string, Floor>): GuestWorld {
  return {
    floorOf(workerId) {
      for (const f of floors.values()) if (f.workers.get(workerId) || f.cloud.get(workerId)) return f.id;
      return undefined;
    },
    isOpen: (floorId) => floors.has(floorId),
  };
}

/** How a guest's toasts, created-by and score names read: its link's label. */
export function guestName(grant: Pick<GuestGrant, 'label'>): string {
  return `${grant.label} (guest)`;
}

interface GuestGateContext {
  floors: Map<string, Floor>;
  guestLinks: Pick<GuestLinks, 'check'>;
  guestAudit: Pick<GuestAudit, 'record' | 'tty'>;
  sendTo: SendTo;
  /** A worker's card, the Orchestrator's included (for its name and pending ask). */
  workerInfo(workerId: string): WorkerInfo | undefined;
}

const clip = (s: unknown, n = 160): string => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : '');
/** A Droid permission prompt's "no" choices; anything else picked on one approves it. */
const DENY = /^\s*(no\b|deny|reject|cancel|don['’]?t|skip|abort)/i;

/** One audit line for an accepted guest write: what it did, readable by the owner. */
export function guestAuditDetail(msg: ClientMsg, worker: WorkerInfo | undefined): { action?: GuestAuditAction; detail?: string } {
  switch (msg.t) {
    case 'worker.prompt':
    case 'orchestrator.prompt':
      return { detail: clip(msg.prompt) || undefined };
    case 'worker.answer': {
      const labels =
        typeof msg.choice === 'number'
          ? [msg.menu?.choices?.find((c) => c?.number === msg.choice)?.label ?? `#${msg.choice}`]
          : Array.isArray(msg.choices)
            ? msg.choices.map((n) => msg.menu?.choices?.find((c) => c?.number === n)?.label ?? `#${n}`)
            : [];
      const typed = clip(msg.text);
      const answer = typed || labels.map((l) => clip(l, 80)).join(', ');
      if (worker?.ask?.kind === 'permission') {
        const deny = typed !== '' || labels.some((l) => DENY.test(l));
        const about = clip(worker.ask.command ?? worker.ask.file ?? worker.ask.tool, 80);
        return { action: deny ? 'permission.deny' : 'permission.approve', detail: [about, answer].filter(Boolean).join(': ') || undefined };
      }
      const question = clip(msg.menu?.question, 80);
      return { detail: [question, answer].filter(Boolean).join(' → ') || undefined };
    }
    case 'worker.spawn':
      return { detail: [msg.kind === 'shell' ? 'Shell' : msg.cloud ? 'Cloud worker' : 'Worker', clip(msg.prompt, 140)].filter(Boolean).join(': ') };
    case 'worker.fork':
      return { detail: ['Forked', clip(msg.prompt, 140)].filter(Boolean).join(': ') };
    case 'worker.kill':
      return { detail: msg.cleanup ? `Sent home (worktree: ${clip(msg.cleanup, 20)})` : 'Sent home' };
    case 'worker.shoot':
      return { detail: msg.superShot ? 'Sent home with a super shot' : 'Shot' };
    case 'worker.resume':
      return { detail: 'Resumed' };
    case 'worker.rebuild':
      return { detail: msg.all ? 'Rebuilt every lost worktree on the floor' : 'Rebuilt its worktree' };
    case 'worker.queue':
      return { detail: `Queued message: ${clip(msg.action, 20)}${msg.text ? ` (${clip(msg.text, 100)})` : ''}` };
    case 'worker.rewind':
      return { detail: `Rewound the conversation${msg.restore ? ` (${clip(msg.restore, 20)})` : ''}` };
    case 'worker.setting':
      return { detail: `${msg.setting === 'model' ? 'Model' : 'Reasoning effort'} → ${clip(msg.value, 80)}` };
    case 'worker.side':
      return { detail: 'Closed the side chat' };
    case 'worker.pr':
      return { detail: 'Opened a pull request' };
    case 'gh.merge':
      return { detail: `Merged #${msg.number}${msg.method ? ` (${clip(msg.method, 10)})` : ''}${msg.auto ? ' when ready' : ''}` };
    case 'gh.comment':
      return { detail: `Commented on #${msg.number}: ${clip(msg.body, 140)}` };
    case 'gh.close':
      return { detail: `Closed ${msg.kind === 'pull' ? 'pull request' : 'issue'} #${msg.number}` };
    case 'gh.labels':
      return { detail: `Labels on #${msg.number}: ${[...(Array.isArray(msg.add) ? msg.add.map((l) => `+${clip(l, 40)}`) : []), ...(Array.isArray(msg.remove) ? msg.remove.map((l) => `-${clip(l, 40)}`) : [])].join(' ')}` };
    case 'pipelines.rerun':
      return { detail: `Re-ran ${msg.failed ? 'the failed jobs of ' : ''}run ${msg.id}` };
    case 'pipelines.cancel':
      return { detail: `Cancelled run ${msg.id}` };
    case 'pipelines.run':
      return { detail: `Started ${clip(msg.workflow, 80)} on ${clip(msg.ref, 80)}` };
    case 'changes.commit':
      return { detail: `Committed: ${clip(msg.message, 140)}` };
    case 'changes.discard':
      return { detail: msg.path ? `Discarded changes to ${clip(msg.path, 140)}` : 'Discarded every uncommitted change' };
    case 'changes.pr':
      return { detail: `Opened a pull request: ${clip(msg.title, 140)}` };
    case 'whiteboard.apply':
      return { detail: `${Array.isArray(msg.envelope?.ops) ? msg.envelope.ops.length : 0} Whiteboard change(s)` };
    case 'whiteboard.ping':
      return { detail: 'Pointed the worker at the Whiteboard' };
    case 'orchestrator.reset':
      return { detail: 'Started a new conversation with the Orchestrator' };
    default:
      return {};
  }
}

export function createGuestGate({ floors, guestLinks, guestAudit, sendTo, workerInfo }: GuestGateContext) {
  const world = guestWorld(floors);

  const targetOf = (admitted: GuestAdmitted): GuestAuditTarget => {
    const t = admitted.target;
    if (t.kind === 'missionControl' || t.kind === 'none') return { kind: 'missionControl' };
    const floor = floors.get(t.floorId);
    const floorPart = { floorId: t.floorId, ...(floor ? { floorName: floor.def.name } : {}) };
    if (t.kind === 'floor') return { kind: 'floor', ...floorPart };
    const name = workerInfo(t.workerId)?.name;
    return { kind: 'worker', ...floorPart, workerId: t.workerId, ...(name ? { workerName: name } : {}) };
  };

  return {
    world,
    /**
     * Whether guest connection `c` may send `msg`: its link still open, then the policy. A refused
     * message gets the generic error when it asked for a receipt, and nothing else.
     */
    admit(c: Client & { guest: GuestGrant }, msg: ClientMsg): GuestAdmitted | undefined {
      const ended = guestLinks.check(c.guest.linkId);
      if (ended) {
        c.ws.close(ended === 'disabled' ? GUEST_CLOSE_DISABLED : GUEST_CLOSE_ENDED, ended);
        return undefined;
      }
      const admitted = guestAdmit(c.guest, msg, c.floor, world);
      if (!admitted) {
        const requestId = typeof msg?.requestId === 'string' ? msg.requestId.slice(0, 64) : '';
        if (requestId) sendTo(c, { t: 'action.result', requestId, ok: false, error: GUEST_REFUSED });
      }
      return admitted;
    },
    /** Writes an accepted guest write to the audit (terminal input coalesced into bursts). */
    record(c: Client & { guest: GuestGrant }, msg: ClientMsg, admitted: GuestAdmitted) {
      if (!admitted.write || !admitted.audit) return;
      const target = targetOf(admitted);
      const workerId = admitted.target.kind === 'worker' ? admitted.target.workerId : admitted.target.kind === 'missionControl' && 'workerId' in msg ? msg.workerId : undefined;
      if (msg.t === 'term.input') {
        // Only an open terminal takes input; the switch refuses the rest.
        if (typeof msg.workerId === 'string' && c.attached.has(msg.workerId) && typeof msg.data === 'string') guestAudit.tty({ grant: c.guest, target }, msg.data);
        return;
      }
      const { action, detail } = guestAuditDetail(msg, typeof workerId === 'string' ? workerInfo(workerId) : undefined);
      guestAudit.record({ grant: c.guest, target, action: action ?? admitted.audit, ...(detail ? { detail } : {}) });
    },
  };
}

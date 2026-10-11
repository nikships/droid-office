import type { ClientMsg, WorkerInfo } from '../shared/protocol';
import { isAsleep, isBusy } from '../shared/status';

/** Ship it must pop on a worker close enough to make the recipient unmistakable. */
export const WAND_SHIP_REACH = 2.5;
export const PROTEGO_RADIUS = 6;
export const WAND_SHIP_COOLDOWN = 3000;

export interface WandAim {
  workerId: string | null;
  distance: number;
}

/** A body under the crosshair, not its laptop, a name tag, or a nearest-worker fallback. */
export function wandWorker(aim: WandAim | null, reach = Infinity): string | null {
  return aim && aim.distance <= reach ? aim.workerId : null;
}

/** Shipping is an intent sent to one agent, never shell input or a direct Git operation. */
export function wandShipRequest(worker: WorkerInfo | undefined, prompt: string): Extract<ClientMsg, { t: 'worker.prompt' }> | string {
  if (!worker) return 'That worker has gone home';
  if (worker.guest || worker.kind === 'shell') return 'Ship it needs an office agent';
  if (worker.downedUntil !== undefined) return `Revive ${worker.name} before asking it to ship`;
  if (worker.lost) return `Restore ${worker.name}'s worktree before asking it to ship`;
  if (isAsleep(worker.status) || worker.status === 'starting' || worker.cloud?.error) return `${worker.name} is not ready for a shipping prompt`;
  if (!prompt.trim()) return 'The Ship it prompt is empty';
  return { t: 'worker.prompt', workerId: worker.id, prompt, ...(!worker.cloud && isBusy(worker.status) ? { queue: true } : {}) };
}

export interface WandWorkerPosition {
  worker: WorkerInfo;
  pos: { x: number; y: number; z: number };
}

/** Only downed workers whose server-owned revival window is still open, in a six-metre sphere. */
export function protegoWorkers(workers: Iterable<WandWorkerPosition>, center: WandWorkerPosition['pos'], now: number): string[] {
  const ids: string[] = [];
  for (const { worker, pos } of workers) {
    if (worker.guest || worker.cloud || worker.downedUntil === undefined || worker.downedUntil <= now) continue;
    if (Math.hypot(pos.x - center.x, pos.y - center.y, pos.z - center.z) <= PROTEGO_RADIUS) ids.push(worker.id);
  }
  return ids;
}

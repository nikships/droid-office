import { WebSocket } from 'ws';
import type { Floor } from '../floor.js';
import type { DevicesStore } from '../devices.js';
import type { WorkerManager } from '../workers.js';
import type { ServerMsg } from '../../shared/protocol.js';
import { guestOutbound, guestSeesWorker, type GuestNamed, type GuestSendContext } from '../../shared/guest-policy.js';
import type { Client } from './client.js';
import { guestWorld } from './guest-gate.js';

const SLOW_CLIENT_BYTES = 8 * 1024 * 1024;

interface TransportContext {
  clients: Map<string, Client>;
  floors: Map<string, Floor>;
}

/** Outbound socket delivery, terminal backpressure, and off-floor screen coalescing. */
export function createClientTransport({ clients, floors }: TransportContext) {
  const world = guestWorld(floors);
  /**
   * The frame `c` gets for `msg`: the owner's shared JSON, or for a guest connection (a share link)
   * only what its scope allows, redacted (see shared/guest-policy.ts). Undefined sends nothing.
   */
  const frameFor = (c: Client, msg: ServerMsg, ctx: Omit<GuestSendContext, 'here'>, shared: () => string): string | undefined => {
    if (!c.guest) return shared();
    const out = guestOutbound(c.guest, msg, { ...ctx, here: c.floor }, world);
    return out && JSON.stringify(out);
  };
  const sendTo = (c: Client, msg: ServerMsg) => {
    if (c.ws.readyState !== WebSocket.OPEN) return;
    const json = frameFor(c, msg, { via: 'direct' }, () => JSON.stringify(msg));
    if (json) c.ws.send(json);
  };
  /** To every connection. `about`: workers the message names that may have left, for guests' scope. */
  const broadcast = (msg: ServerMsg, except?: string, droppable = false, about?: readonly GuestNamed[]): boolean => {
    let json: string | undefined;
    const shared = () => (json ??= JSON.stringify(msg));
    let dropped = false;
    for (const c of clients.values()) {
      if (c.id === except || c.ws.readyState !== WebSocket.OPEN) continue;
      if (droppable && c.ws.bufferedAmount > 4 * 1024 * 1024) {
        dropped = true;
        continue;
      }
      const frame = frameFor(c, msg, { via: 'all', ...(about ? { about } : {}) }, shared);
      if (frame) c.ws.send(frame);
    }
    return dropped;
  };
  /** To everyone on one floor. `about`: workers the message names besides its own subject, for guests' scope. */
  const toFloor = (floor: Floor, msg: ServerMsg, droppable = false, about?: readonly GuestNamed[]): boolean => {
    let json: string | undefined;
    const shared = () => (json ??= JSON.stringify(msg));
    let dropped = false;
    for (const c of clients.values()) {
      if (c.floor !== floor.id || c.ws.readyState !== WebSocket.OPEN) continue;
      if (droppable && c.ws.bufferedAmount > 4 * 1024 * 1024) {
        dropped = true;
        continue;
      }
      const frame = frameFor(c, msg, { via: 'floor', floor: floor.id, ...(about ? { about } : {}) }, shared);
      if (frame) c.ws.send(frame);
    }
    return dropped;
  };
  const termData = (workerId: string, data: string, connectionIds: string[]) => {
    const json = JSON.stringify({ t: 'term.data', workerId, data } satisfies ServerMsg);
    let floorId: string | undefined | null = null;
    for (const id of connectionIds) {
      const c = clients.get(id);
      if (!c || c.ws.readyState !== WebSocket.OPEN) continue;
      if (c.guest) {
        if (floorId === null) floorId = world.floorOf(workerId);
        if (!guestSeesWorker(c.guest, workerId, floorId, world.reposOf(workerId))) continue;
      }
      // A connection on a slow link skips output and gets a fresh snapshot once it catches up,
      // instead of queueing unbounded data in server memory.
      if (c.stale.has(workerId) || c.ws.bufferedAmount > SLOW_CLIENT_BYTES) c.stale.add(workerId);
      else c.ws.send(json);
    }
  };
  const offFloorThrottle = new Map<string, { lastAt: number; timer?: ReturnType<typeof setTimeout> }>();
  const clearOffFloorThrottle = (workerId: string) => {
    const entry = offFloorThrottle.get(workerId);
    if (entry?.timer) clearTimeout(entry.timer);
    offFloorThrottle.delete(workerId);
  };
  const flushOffFloorScreen = (floor: Floor, workerId: string) => {
    if (floors.get(floor.id) !== floor) return;
    if (floor.workers.get(workerId)?.status !== 'needs_input') return;
    const frame = floor.workers.fullScreen(workerId);
    if (!frame) return;
    const msg = { t: 'screen', workerId, ...frame, full: true } satisfies ServerMsg;
    let json: string | undefined;
    const shared = () => (json ??= JSON.stringify(msg));
    for (const c of clients.values()) {
      if (c.floor === floor.id || c.ws.readyState !== WebSocket.OPEN) continue;
      if (c.ws.bufferedAmount > 4 * 1024 * 1024) continue;
      const out = frameFor(c, msg, { via: 'floor', floor: floor.id }, shared);
      if (out) c.ws.send(out);
    }
  };
  /** Sends a worker's full screen to connections not on `floor`, coalescing rapid TUI redraws. */
  const broadcastOffFloorScreen = (floor: Floor, workerId: string) => {
    const now = Date.now();
    const entry = offFloorThrottle.get(workerId);
    const elapsed = entry ? now - entry.lastAt : Infinity;
    if (elapsed >= 50) {
      if (entry?.timer) clearTimeout(entry.timer);
      offFloorThrottle.set(workerId, { lastAt: now });
      flushOffFloorScreen(floor, workerId);
      return;
    }
    if (entry?.timer) return;
    const timer = setTimeout(() => {
      const cur = offFloorThrottle.get(workerId);
      if (cur) cur.timer = undefined;
      if (cur) cur.lastAt = Date.now();
      flushOffFloorScreen(floor, workerId);
    }, 50 - elapsed);
    timer.unref();
    offFloorThrottle.set(workerId, { lastAt: entry?.lastAt ?? now, timer });
  };

  return {
    sendTo,
    broadcast,
    toFloor,
    termData,
    clearOffFloorThrottle,
    broadcastOffFloorScreen,
    clearOffFloorScreens() {
      for (const e of offFloorThrottle.values()) if (e.timer) clearTimeout(e.timer);
      offFloorThrottle.clear();
    },
    startTimers(attachTerminal: (wid: string, c: Client) => ReturnType<WorkerManager['attach']>, devices: DevicesStore) {
      const resync = setInterval(() => {
        for (const c of clients.values()) {
          if (!c.stale.size || c.ws.bufferedAmount > SLOW_CLIENT_BYTES / 8) continue;
          for (const wid of c.stale) {
            const snap = c.attached.has(wid) ? attachTerminal(wid, c) : undefined;
            if (snap) sendTo(c, { t: 'term.snapshot', workerId: wid, ...snap });
          }
          c.stale.clear();
        }
      }, 1000);

      // Drop dead connections so ghosts don't linger in the office.
      const heartbeat = setInterval(() => {
        for (const c of clients.values()) {
          if (!c.isAlive) {
            c.ws.terminate();
            continue;
          }
          c.isAlive = false;
          c.ws.ping();
          // A phone that stays connected is still being seen (written down once a minute at most).
          if (c.device) devices.seen(c.device);
        }
      }, 20_000);

      return () => {
        clearInterval(heartbeat);
        clearInterval(resync);
      };
    },
  };
}

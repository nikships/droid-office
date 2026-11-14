import { WebSocket } from 'ws';
import type { Floor } from '../floor.js';
import type { DevicesStore } from '../devices.js';
import type { WorkerManager } from '../workers.js';
import type { ServerMsg } from '../../shared/protocol.js';
import type { Client } from './client.js';

const SLOW_CLIENT_BYTES = 8 * 1024 * 1024;

interface TransportContext {
  clients: Map<string, Client>;
  floors: Map<string, Floor>;
}

/** Outbound socket delivery, terminal backpressure, and off-floor screen coalescing. */
export function createClientTransport({ clients, floors }: TransportContext) {
  const sendTo = (c: Client, msg: ServerMsg) => {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
  };
  const broadcast = (msg: ServerMsg, except?: string, droppable = false): boolean => {
    let json: string | undefined;
    let dropped = false;
    for (const c of clients.values()) {
      if (c.id === except || c.ws.readyState !== WebSocket.OPEN) continue;
      if (droppable && c.ws.bufferedAmount > 4 * 1024 * 1024) {
        dropped = true;
        continue;
      }
      json ??= JSON.stringify(msg);
      c.ws.send(json);
    }
    return dropped;
  };
  /** To everyone on one floor. */
  const toFloor = (floor: Floor, msg: ServerMsg, droppable = false): boolean => {
    let json: string | undefined;
    let dropped = false;
    for (const c of clients.values()) {
      if (c.floor !== floor.id || c.ws.readyState !== WebSocket.OPEN) continue;
      if (droppable && c.ws.bufferedAmount > 4 * 1024 * 1024) {
        dropped = true;
        continue;
      }
      json ??= JSON.stringify(msg);
      c.ws.send(json);
    }
    return dropped;
  };
  const termData = (workerId: string, data: string, connectionIds: string[]) => {
    const json = JSON.stringify({ t: 'term.data', workerId, data } satisfies ServerMsg);
    for (const id of connectionIds) {
      const c = clients.get(id);
      if (!c || c.ws.readyState !== WebSocket.OPEN) continue;
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
    const json = JSON.stringify({ t: 'screen', workerId, ...frame, full: true } satisfies ServerMsg);
    for (const c of clients.values()) {
      if (c.floor === floor.id || c.ws.readyState !== WebSocket.OPEN) continue;
      if (c.ws.bufferedAmount > 4 * 1024 * 1024) continue;
      c.ws.send(json);
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

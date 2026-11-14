import type { WebSocket } from 'ws';
import type { ServerMsg } from '../../shared/protocol.js';
import type { PhoneSizes } from '../phone-sizes.js';

export type ToastLevel = Extract<ServerMsg, { t: 'toast' }>['level'];
export interface Client {
  id: string;
  /** An external MCP worker's owner action runs on a socket of its own that is never in `clients` (see ownerOffice). */
  ws: Pick<WebSocket, 'readyState' | 'bufferedAmount' | 'send' | 'close' | 'ping' | 'terminate'>;
  /** The floor this connection is on (ROOF, or null out in the empty lobby); routing reads this. */
  floor: string | null;
  /**
   * Display provenance only: the name (?name=, or the `profile` message) and color this
   * connection's toasts, createdBy and score names are written with. Nothing routes or filters
   * by it; every connection is the owner.
   */
  peer: { name: string; color: string };
  attached: Set<string>;
  /** Terminals whose output was skipped because this client fell behind; re-snapshotted later. */
  stale: Set<string>;
  lastGongAt: number;
  /** Cleared at each heartbeat ping and set again by the pong; still clear at the next one means gone. */
  isAlive: boolean;
  /** The paired phone this connection came in with (its device token), if it did. */
  device?: string;
  /** Terminals this phone resized, put back when it disconnects (see phone-sizes.ts). */
  phoneSizes?: PhoneSizes;
  /** A non-scene browser must never receive window.office automation commands. */
  dashboard: boolean;
  requests: Set<string>;
  /** The Whiteboard epoch this connection numbers its batches in, per floor (see WhiteboardStore.issueEpoch). */
  boards: Map<string, string>;
  /** An external worker's owner action: `refused` is the first warning it was given, its outcome when nothing else says. */
  owner?: { refused?: string; unconfirmed?: boolean };
}

export type SendTo = (c: Client, msg: ServerMsg) => void;

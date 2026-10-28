import type { ClientMsg, ServerMsg } from '../shared/protocol';
import type { NetTransport } from './net';

/**
 * What a sealed host page and its native side say over one message channel (an Android WebMessagePort).
 * The page never sees the office's address or credential: native owns the socket and sends it
 * `status` and `message`; the page asks it to `connect`, `close` or `send`.
 */
export type BridgeToPage = { kind: 'status'; up: boolean } | { kind: 'message'; msg: ServerMsg };
export type BridgeToNative = { kind: 'connect' } | { kind: 'close' } | { kind: 'send'; msg: ClientMsg };

/** The slice of MessagePort this needs, so tests and other hosts can supply their own. */
export interface BridgePort {
  postMessage(data: string): void;
  addEventListener(type: 'message', fn: (event: { data: unknown }) => void): void;
  start?(): void;
}

function parse(data: unknown): BridgeToPage | undefined {
  if (typeof data !== 'string') return undefined;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const v = value as { kind?: unknown; up?: unknown; msg?: unknown };
  if (v.kind === 'status' && typeof v.up === 'boolean') return { kind: 'status', up: v.up };
  if (v.kind === 'message' && v.msg && typeof v.msg === 'object' && typeof (v.msg as { t?: unknown }).t === 'string') return { kind: 'message', msg: v.msg as ServerMsg };
  return undefined;
}

/**
 * A NetTransport over a native message port. `send` answers false while native last said the socket
 * is down; native reports `status: false` before it drops anything, so nothing is queued on either side
 * and a request still waiting is reported uncertain, never replayed.
 */
export function bridgeTransport(port: BridgePort): NetTransport {
  let up = false;
  const messages = new Set<(msg: ServerMsg) => void>();
  const statuses = new Set<(up: boolean) => void>();
  const post = (msg: BridgeToNative) => port.postMessage(JSON.stringify(msg));
  port.addEventListener('message', (event) => {
    const msg = parse(event.data);
    if (!msg) return;
    if (msg.kind === 'status') {
      if (msg.up === up) return;
      up = msg.up;
      for (const fn of statuses) fn(up);
    } else if (up) for (const fn of messages) fn(msg.msg);
  });
  port.start?.();
  return {
    connect: () => post({ kind: 'connect' }),
    close: () => post({ kind: 'close' }),
    send(msg) {
      if (!up) return false;
      post({ kind: 'send', msg });
      return true;
    },
    onMessage(fn) {
      messages.add(fn);
      return () => messages.delete(fn);
    },
    onStatus(fn) {
      statuses.add(fn);
      return () => statuses.delete(fn);
    },
  };
}

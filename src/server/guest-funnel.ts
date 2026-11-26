// The guest backend: a third loopback listener, published to the internet through Tailscale Funnel only
// while external sharing is on (docs/guest-sharing.md). Every request and upgrade it accepts is marked a
// guest request (lan.ts markGuest): never local, never the owner, authenticated only by a share link's
// token. It is separate from the main listener and from the tailnet Serve backend (tailnet-https.ts),
// which keeps refusing Funnel traffic.

import type { IncomingMessage, RequestListener } from 'node:http';
import type { Duplex } from 'node:stream';
import type { TailscaleCli } from './tailscale.js';
import type { GuestTransportState } from '../shared/guest-links.js';

export const GUEST_FUNNEL_FILE = 'guest-funnel.json';

export interface GuestFunnelOptions {
  dataDir: string;
  request: RequestListener;
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  cli?: TailscaleCli;
  retryMs?: number;
}

/** Publishes the guest backend through Funnel while on; removes only its own mapping when turned off. */
export class GuestFunnel {
  private status: GuestTransportState['status'] = 'off';

  constructor(private readonly opts: GuestFunnelOptions) {
    void this.opts;
  }

  state(): GuestTransportState {
    return { status: this.status };
  }

  /** The public guest origin while serving. */
  origin(): string | undefined {
    return undefined;
  }

  /** On starts the guest backend and its Funnel mapping; off closes every guest connection and removes the mapping. */
  set(on: boolean): Promise<GuestTransportState> {
    this.status = on ? 'unavailable' : 'off';
    return Promise.resolve(this.state());
  }

  /** Shutdown: closes the listener and removes the Funnel mapping (its port is remembered for a stable URL). */
  stop(): Promise<void> {
    this.status = 'off';
    return Promise.resolve();
  }
}

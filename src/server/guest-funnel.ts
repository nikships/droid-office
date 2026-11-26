// The guest backend: a third loopback listener, published to the internet through Tailscale Funnel only
// while external sharing is on (docs/guest-sharing.md). Every request and upgrade it accepts is marked a
// guest request (lan.ts markGuest): never local, never the owner, authenticated only by a share link's
// token. It is separate from the main listener and from the tailnet Serve backend (tailnet-https.ts),
// which keeps refusing Funnel traffic, and it maps only Funnel ports nothing else uses.

import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import path from 'node:path';
import { isLoopback, markGuest } from './lan.js';
import { FUNNEL_PORTS, planFunnel, TailscaleCli, withServeLock } from './tailscale.js';
import type { GuestTransportState } from '../shared/guest-links.js';

export const GUEST_FUNNEL_FILE = 'guest-funnel.json';

interface Saved {
  backendPort?: number;
  httpsPort?: number;
}

export interface GuestFunnelOptions {
  dataDir: string;
  request: RequestListener;
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  cli?: TailscaleCli;
  retryMs?: number;
  /** Called after each start, retry or stop settles, so owner pages can show the new state. */
  onState?: () => void;
}

/**
 * The guest backend's HTTP server. It answers only loopback connections (tailscaled's Funnel proxy)
 * addressed to its own public origin; with or without `Tailscale-Funnel-Request`, every one is a guest.
 */
export function guestBackendListener(opts: Pick<GuestFunnelOptions, 'request' | 'upgrade'> & { origin(): string | undefined }) {
  const accepts = (req: IncomingMessage) => {
    const origin = opts.origin();
    if (!origin || !isLoopback(req.socket.remoteAddress)) return false;
    if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) return false;
    markGuest(req);
    // Never let trustProxy turn a forwarded host into an alternate same-origin authority.
    delete req.headers['x-forwarded-host'];
    return true;
  };
  const server = createServer((req, res) => {
    if (!accepts(req)) return void res.writeHead(403, { 'cache-control': 'no-store' }).end();
    opts.request(req, res);
  });
  server.on('upgrade', (req, socket, head) => {
    if (!accepts(req)) return socket.destroy();
    opts.upgrade(req, socket, head);
  });
  const sockets = new Set<Duplex>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.headersTimeout = 10_000;
  return {
    server,
    close() {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

/** Publishes the guest backend through Funnel while on; removes only its own mapping when turned off. */
export class GuestFunnel {
  private saved: Saved = {};
  private on = false;
  private listener?: ReturnType<typeof guestBackendListener>;
  private publicOrigin?: string;
  private status: GuestTransportState['status'] = 'off';
  private reason?: string;
  private fixUrl?: string;
  private retry?: NodeJS.Timeout;
  private work: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly cli: TailscaleCli;
  private readonly file: string;

  constructor(private readonly opts: GuestFunnelOptions) {
    this.file = path.join(opts.dataDir, GUEST_FUNNEL_FILE);
    this.cli = opts.cli ?? new TailscaleCli();
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Saved;
      const port = (p?: number) => (p !== undefined && Number.isInteger(p) && p > 0 && p < 65536 ? p : undefined);
      const https = port(raw.httpsPort);
      this.saved = { backendPort: port(raw.backendPort), httpsPort: https && FUNNEL_PORTS.includes(https) ? https : undefined };
    } catch {
      // Never published yet.
    }
  }

  state(): GuestTransportState {
    return {
      status: this.status,
      ...(this.publicOrigin ? { origin: this.publicOrigin } : {}),
      ...(this.reason ? { reason: this.reason } : {}),
      ...(this.fixUrl ? { fixUrl: this.fixUrl } : {}),
    };
  }

  /** The public guest origin while serving. */
  origin(): string | undefined {
    return this.publicOrigin;
  }

  /** On starts the guest backend and its Funnel mapping; off closes every guest connection at once and removes the mapping. */
  set(on: boolean): Promise<GuestTransportState> {
    this.on = on;
    if (!on) this.disconnect();
    return this.queue(() => (on ? this.enable() : this.unpublish()));
  }

  /** Shutdown: closes the listener and removes the Funnel mapping. Its port is remembered, so the URL is the same next start. */
  async stop(): Promise<void> {
    this.closed = true;
    this.disconnect();
    await this.queue(() => this.unpublish());
  }

  private queue(task: () => Promise<void>): Promise<GuestTransportState> {
    const run = this.work
      .then(() => withServeLock(task))
      .catch((err: Error) => {
        if (this.active()) {
          this.publicOrigin = undefined;
          this.status = 'unavailable';
          this.reason = err.message;
        }
      });
    this.work = run;
    return run.then(() => {
      this.opts.onState?.();
      return this.state();
    });
  }

  private active(): boolean {
    return !this.closed && this.on;
  }

  private async enable() {
    clearTimeout(this.retry);
    if (!this.active()) return;
    if (!this.publicOrigin) this.status = 'starting';
    this.reason = this.fixUrl = undefined;
    try {
      const self = await this.cli.self();
      if (!this.active()) return;
      if (!self?.dnsName) throw new Error('Start Tailscale and enable MagicDNS on this computer. Sharing will retry automatically.');
      const routes = await this.cli.routes(self.dnsName);
      if (!this.active()) return;
      if (!routes) throw new Error('Could not read Tailscale Serve settings. Update Tailscale and retry.');
      if (!this.listener) {
        const listener = guestBackendListener({ ...this.opts, origin: () => this.publicOrigin });
        const first = this.saved.backendPort ?? 0;
        try {
          for (const port of first ? [first, 0] : [0]) {
            try {
              await new Promise<void>((resolve, reject) => {
                listener.server.once('error', reject);
                listener.server.listen(port, '127.0.0.1', () => {
                  listener.server.off('error', reject);
                  resolve();
                });
              });
              break;
            } catch (err) {
              if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || port === 0) throw err;
            }
          }
        } catch (err) {
          listener.close();
          throw err;
        }
        if (!this.active()) return listener.close();
        this.listener = listener;
      }
      const backendPort = (this.listener.server.address() as AddressInfo).port;
      const target = `http://127.0.0.1:${backendPort}`;
      const previous = this.saved.backendPort ? `http://127.0.0.1:${this.saved.backendPort}` : undefined;
      const plan = planFunnel(routes, target, this.saved.httpsPort, previous);
      if (!plan) throw new Error('No free Tailscale Funnel port. Funnel can only use ports 443, 8443 and 10000; free one of them and retry.');
      // Remember ownership before the CLI runs, so turning sharing off also cleans up an interrupted enable.
      this.save({ backendPort, httpsPort: plan.port });
      if (!plan.existing) {
        const done = await this.cli.funnel(plan.port, target);
        if (!done.ok) {
          this.fixUrl = done.fixUrl;
          throw new Error(done.message);
        }
      }
      if (!this.active()) return;
      this.publicOrigin = `https://${self.dnsName}${plan.port === 443 ? '' : `:${plan.port}`}`;
      this.status = 'serving';
    } finally {
      if (this.active() && this.status !== 'serving') this.retry = setTimeout(() => void this.set(true), (this.opts.retryMs ?? 30_000) * (this.fixUrl ? 10 : 1)).unref();
    }
  }

  /** Removes the Funnel mapping on the saved port, only while it still points at this office's backend. */
  private async unpublish() {
    if (this.saved.backendPort === undefined || this.saved.httpsPort === undefined) return;
    const self = await this.cli.self();
    if (!self?.dnsName) return;
    const target = `http://127.0.0.1:${this.saved.backendPort}`;
    for (const r of (await this.cli.routes(self.dnsName)) ?? []) {
      if (r.port === this.saved.httpsPort && r.proxy === target) await this.cli.unfunnel(r.port);
    }
  }

  private disconnect() {
    clearTimeout(this.retry);
    this.publicOrigin = this.reason = this.fixUrl = undefined;
    this.status = 'off';
    this.listener?.close();
    this.listener = undefined;
  }

  private save(next: Saved) {
    this.saved = next;
    // Fail closed if ownership cannot be persisted; never create an untracked public mapping.
    writeFileSync(this.file, `${JSON.stringify(next)}\n`, { mode: 0o600 });
  }
}

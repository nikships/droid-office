import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import path from 'node:path';
import { isLoopback, markProxied } from './lan.js';
import { planServe, TailscaleCli, withServeLock } from './tailscale.js';
import type { TailnetHttpsState } from '../shared/devices.js';

export const TAILNET_HTTPS_FILE = 'tailnet-https.json';
interface Saved {
  on: boolean;
  backendPort?: number;
  httpsPort?: number;
}

interface Options {
  dataDir: string;
  request: RequestListener;
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  cli?: TailscaleCli;
  retryMs?: number;
}

/** Dedicated Serve backend. A loopback proxy connection is never an owner connection. */
export function tailnetHttpsListener(opts: Pick<Options, 'request' | 'upgrade'> & { origin(): string | undefined; owner(): string | undefined }) {
  const accepts = (req: IncomingMessage) => {
    const origin = opts.origin();
    const owner = opts.owner()?.toLowerCase();
    const login = req.headers['tailscale-user-login'];
    if (!origin || !isLoopback(req.socket.remoteAddress) || 'tailscale-funnel-request' in req.headers) return false;
    if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) return false;
    if (owner && login && (typeof login !== 'string' || login.trim().toLowerCase() !== owner)) return false;
    markProxied(req);
    // Do not let trustProxy turn a caller's forwarded host into an alternate same-origin authority.
    delete req.headers['x-forwarded-host'];
    return true;
  };
  const server = createServer((req, res) => {
    if (!accepts(req)) return void res.writeHead(403).end();
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

/** The sole remote access path, independent of remote MCP. Never enables Funnel. */
export class TailnetHttps {
  private saved: Saved = { on: true };
  private listener?: ReturnType<typeof tailnetHttpsListener>;
  private origin?: string;
  private owner?: string;
  private status: TailnetHttpsState['status'] = 'off';
  private reason?: string;
  private fixUrl?: string;
  private retry?: NodeJS.Timeout;
  private work: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly cli: TailscaleCli;
  private readonly file: string;

  constructor(private readonly opts: Options) {
    this.file = path.join(opts.dataDir, TAILNET_HTTPS_FILE);
    this.cli = opts.cli ?? new TailscaleCli();
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Saved;
      const port = (p?: number) => (p !== undefined && Number.isInteger(p) && p > 0 && p < 65536 ? p : undefined);
      this.saved = { on: raw.on === true, backendPort: port(raw.backendPort), httpsPort: port(raw.httpsPort) };
    } catch {
      // A new office enables private HTTPS; an unreadable file keeps the same default.
    }
  }

  state(): TailnetHttpsState {
    return { on: this.saved.on, status: this.status, ...(this.origin ? { origin: this.origin } : {}), ...(this.reason ? { reason: this.reason } : {}), ...(this.fixUrl ? { fixUrl: this.fixUrl } : {}) };
  }

  start(): Promise<TailnetHttpsState> {
    return this.queue(() => this.enable());
  }

  set(on: boolean): Promise<TailnetHttpsState> {
    if (!on) this.disconnect();
    this.save({ ...this.saved, on });
    return this.queue(() => (on ? this.enable() : this.disable()));
  }

  stop(): void {
    this.closed = true;
    this.disconnect();
  }

  private queue(task: () => Promise<void>): Promise<TailnetHttpsState> {
    const run = this.work
      .then(() => withServeLock(task))
      .catch((err: Error) => {
        if (!this.closed && this.saved.on) {
          this.origin = undefined;
          this.status = 'unavailable';
          this.reason = err.message;
        }
      });
    this.work = run;
    return run.then(() => this.state());
  }

  private active(): boolean {
    return !this.closed && this.saved.on;
  }

  private async enable() {
    clearTimeout(this.retry);
    if (!this.active()) return;
    if (!this.origin) this.status = 'starting';
    this.reason = this.fixUrl = undefined;
    try {
      const self = await this.cli.self();
      if (!this.active()) return;
      if (!self?.dnsName) throw new Error('Start Tailscale and enable MagicDNS on this computer. HTTPS will retry automatically.');
      const routes = await this.cli.routes(self.dnsName);
      if (!this.active()) return;
      if (!routes) throw new Error('Could not read Tailscale Serve settings. Update Tailscale and retry.');
      if (!this.listener) {
        const listener = tailnetHttpsListener({ ...this.opts, origin: () => this.origin, owner: () => this.owner });
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
      if (!this.active()) return this.disconnect();
      const backendPort = (this.listener.server.address() as AddressInfo).port;
      const target = `http://127.0.0.1:${backendPort}`;
      const previous = this.saved.backendPort ? `http://127.0.0.1:${this.saved.backendPort}` : undefined;
      const plan = planServe(routes, target, this.saved.httpsPort, previous);
      if (!plan) throw new Error('No free Tailscale HTTPS port. Free one of ports 8443–8449 or 10443 and retry.');
      if (routes.find((r) => r.port === plan.port)?.funnel) throw new Error('Funnel is enabled on this HTTPS port. Turn Funnel off before using the office.');
      // Remember ownership before the CLI runs, so disabling also cleans up an interrupted enable.
      this.save({ ...this.saved, backendPort, httpsPort: plan.port });
      if (!plan.existing) {
        const done = await this.cli.serve(plan.port, target);
        if (!done.ok) {
          this.fixUrl = done.fixUrl;
          throw new Error(done.message);
        }
      }
      if (!this.active()) return;
      this.owner = self.login;
      this.origin = `https://${self.dnsName}${plan.port === 443 ? '' : `:${plan.port}`}`;
      this.status = 'serving';
    } finally {
      if (this.active()) this.retry = setTimeout(() => void this.start(), (this.opts.retryMs ?? 30_000) * (this.fixUrl ? 10 : 1)).unref();
    }
  }

  private async disable() {
    this.disconnect();
    if (this.saved.backendPort === undefined || this.saved.httpsPort === undefined) return;
    const self = await this.cli.self();
    if (!self?.dnsName) return;
    const target = `http://127.0.0.1:${this.saved.backendPort}`;
    for (const r of (await this.cli.routes(self.dnsName)) ?? []) {
      if (r.port === this.saved.httpsPort && r.proxy === target) await this.cli.unserve(r.port);
    }
  }

  private disconnect() {
    clearTimeout(this.retry);
    this.origin = this.owner = this.reason = this.fixUrl = undefined;
    this.status = 'off';
    this.listener?.close();
    this.listener = undefined;
  }

  private save(next: Saved) {
    this.saved = next;
    // Fail closed if ownership cannot be persisted; do not silently create an untracked Serve mapping.
    writeFileSync(this.file, `${JSON.stringify(next)}\n`, { mode: 0o600 });
  }
}

// Tailscale, when this machine is signed in to a tailnet: its MagicDNS name and 100.x address
// reach the office from a phone on the same tailnet anywhere, not just on the same Wi-Fi. The
// office only asks the local `tailscale` CLI; nothing goes over the network.

import { execFile } from 'node:child_process';
import { isTailscaleIPv4 } from './lan.js';

export interface TailscaleSelf {
  /** The MagicDNS name, trailing dot stripped (`my-mac.tailnet-name.ts.net`), when MagicDNS is on. */
  dnsName?: string;
  /** Its tailnet IPv4 addresses (100.64.0.0/10). */
  ips: string[];
  /** The login of the user this machine is signed in as; a tagged machine has none. */
  login?: string;
}

/** Where the CLI is: on PATH, inside the Mac app, or Homebrew's (an app's PATH often lacks it). */
export const TAILSCALE_BINARIES = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale'];

/** What `tailscale status --json` says about this machine, or undefined when it isn't up on a tailnet. */
export function parseTailscaleStatus(json: unknown): TailscaleSelf | undefined {
  if (!json || typeof json !== 'object') return undefined;
  const status = json as {
    BackendState?: unknown;
    Self?: { DNSName?: unknown; TailscaleIPs?: unknown; UserID?: unknown; Tags?: unknown };
    User?: Record<string, { LoginName?: unknown } | undefined> | null;
    CurrentTailnet?: { MagicDNSEnabled?: unknown } | null;
  };
  if (status.BackendState !== undefined && status.BackendState !== 'Running') return undefined;
  const self = status.Self;
  if (!self || typeof self !== 'object') return undefined;
  const ips = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs.filter((ip): ip is string => typeof ip === 'string' && isTailscaleIPv4(ip)) : [];
  const magic = status.CurrentTailnet?.MagicDNSEnabled !== false;
  const name = typeof self.DNSName === 'string' ? self.DNSName.trim().replace(/\.$/, '').toLowerCase() : '';
  const dnsName = magic && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(name) ? name : undefined;
  if (!dnsName && !ips.length) return undefined;
  const tagged = Array.isArray(self.Tags) && self.Tags.length > 0;
  const login = !tagged && self.UserID !== undefined ? status.User?.[String(self.UserID)]?.LoginName : undefined;
  return { ...(dnsName ? { dnsName } : {}), ips, ...(typeof login === 'string' && login ? { login } : {}) };
}

/** One port this machine serves on its tailnet, from `tailscale serve status --json`. */
export interface ServeRoute {
  port: number;
  /** Where its root path is proxied, as `http://127.0.0.1:4611`. */
  proxy?: string;
  funnel: boolean;
}

export function parseServeStatus(json: unknown, dnsName: string): ServeRoute[] {
  if (!json || typeof json !== 'object') return [];
  const status = json as { TCP?: Record<string, unknown> | null; Web?: Record<string, { Handlers?: Record<string, { Proxy?: unknown } | undefined> } | undefined> | null; AllowFunnel?: Record<string, unknown> | null };
  const ports = new Set<number>();
  for (const key of Object.keys(status.TCP ?? {})) if (/^\d+$/.test(key)) ports.add(Number(key));
  for (const key of Object.keys(status.Web ?? {})) if (key.startsWith(`${dnsName}:`) && /:\d+$/.test(key)) ports.add(Number(key.slice(dnsName.length + 1)));
  return [...ports]
    .sort((a, b) => a - b)
    .map((port) => {
      const proxy = status.Web?.[`${dnsName}:${port}`]?.Handlers?.['/']?.Proxy;
      return { port, ...(typeof proxy === 'string' ? { proxy } : {}), funnel: status.AllowFunnel?.[`${dnsName}:${port}`] === true };
    });
}

/** HTTPS ports the office tries for its own Serve mapping, in order. Never 443, which is the first one people use for their own services. */
export const SERVE_PORTS = [8443, 8444, 8445, 8446, 8447, 8448, 8449, 10443];

/**
 * The port to serve `target` on: the one already proxying to it, else the office's previous port when
 * it still points at the office's previous backend, else the first port nothing else uses.
 */
export function planServe(routes: readonly ServeRoute[], target: string, preferred?: number, previousTarget?: string): { port: number; existing: boolean } | undefined {
  const ours = routes.find((r) => r.proxy === target);
  if (ours) return { port: ours.port, existing: true };
  const taken = new Map(routes.map((r) => [r.port, r]));
  if (preferred !== undefined && previousTarget && taken.get(preferred)?.proxy === previousTarget) return { port: preferred, existing: false };
  const port = [preferred, ...SERVE_PORTS].find((p) => p !== undefined && !taken.has(p));
  return port === undefined ? undefined : { port, existing: false };
}

export type CliRun = (bin: string, args: string[], timeoutMs: number) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

const runCli: CliRun = (bin, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) }));
  });

/** What a failed `tailscale serve` said, without the CLI's version-skew warning, and the admin link it gave if any. */
export function serveFailure(output: string): { message: string; fixUrl?: string } {
  const fixUrl = /https:\/\/login\.tailscale\.com\/\S+/.exec(output)?.[0];
  const lines = output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^Warning: client version/.test(l) && !l.startsWith('https://'));
  const message = lines.slice(0, 2).join(' ') || 'Tailscale Serve refused the mapping.';
  return fixUrl ? { message, fixUrl } : { message };
}

/** The local `tailscale` CLI, for this machine's identity and its Serve mappings. */
export class TailscaleCli {
  private bin?: string;

  constructor(
    private readonly bins: readonly string[] = TAILSCALE_BINARIES,
    private readonly run: CliRun = runCli,
  ) {}

  async self(): Promise<TailscaleSelf | undefined> {
    for (const bin of this.bin ? [this.bin, ...this.bins.filter((b) => b !== this.bin)] : this.bins) {
      const r = await this.run(bin, ['status', '--json'], 3000);
      if (!r.ok) continue;
      try {
        const self = parseTailscaleStatus(JSON.parse(r.stdout));
        if (self) {
          this.bin = bin;
          return self;
        }
      } catch {
        // not this one
      }
    }
    return undefined;
  }

  /** Undefined when the CLI can't say. An office that serves nothing gets an empty list. */
  async routes(dnsName: string): Promise<ServeRoute[] | undefined> {
    if (!this.bin) return undefined;
    const r = await this.run(this.bin, ['serve', 'status', '--json'], 5000);
    if (!r.ok) return undefined;
    try {
      return parseServeStatus(JSON.parse(r.stdout.trim() || '{}'), dnsName);
    } catch {
      return undefined;
    }
  }

  /** Serves `target` at https://<this machine>:<port> on the tailnet only, kept across restarts by tailscaled. */
  async serve(port: number, target: string): Promise<{ ok: true } | { ok: false; message: string; fixUrl?: string }> {
    if (!this.bin) return { ok: false, message: 'Tailscale isn’t running on this computer.' };
    // A tailnet without HTTPS certificates makes the CLI print an admin link and wait for it, hence the timeout.
    const r = await this.run(this.bin, ['serve', '--bg', '--yes', `--https=${port}`, target], 20_000);
    return r.ok ? { ok: true } : { ok: false, ...serveFailure(`${r.stdout}\n${r.stderr}`) };
  }

  async unserve(port: number): Promise<boolean> {
    if (!this.bin) return false;
    return (await this.run(this.bin, ['serve', '--yes', `--https=${port}`, 'off'], 10_000)).ok;
  }
}

function statusFrom(bin: string, timeoutMs: number): Promise<TailscaleSelf | undefined> {
  return new Promise((resolve) => {
    execFile(bin, ['status', '--json'], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(undefined);
      try {
        resolve(parseTailscaleStatus(JSON.parse(stdout)));
      } catch {
        resolve(undefined);
      }
    });
  });
}

/** This machine on its tailnet, from the first CLI that answers; undefined without Tailscale, signed out or stopped. */
export async function tailscaleSelf(bins: readonly string[] = TAILSCALE_BINARIES, timeoutMs = 2000): Promise<TailscaleSelf | undefined> {
  for (const bin of bins) {
    const self = await statusFrom(bin, timeoutMs);
    if (self) return self;
  }
  return undefined;
}

/** tailscaleSelf, asked at most once every `ttlMs`: the Phone window polls, and a CLI that hangs shouldn't run each time. */
export class TailscaleWatch {
  private last?: { at: number; self: TailscaleSelf | undefined };
  private pending?: Promise<TailscaleSelf | undefined>;

  constructor(
    private readonly ask: () => Promise<TailscaleSelf | undefined> = () => tailscaleSelf(),
    private readonly ttlMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  get(): Promise<TailscaleSelf | undefined> {
    if (this.last && this.now() - this.last.at < this.ttlMs) return Promise.resolve(this.last.self);
    this.pending ??= this.ask()
      .catch(() => undefined)
      .then((self) => {
        this.last = { at: this.now(), self };
        this.pending = undefined;
        return self;
      });
    return this.pending;
  }
}

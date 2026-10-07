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
}

/** Where the CLI is: on PATH, inside the Mac app, or Homebrew's (an app's PATH often lacks it). */
export const TAILSCALE_BINARIES = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale'];

/** What `tailscale status --json` says about this machine, or undefined when it isn't up on a tailnet. */
export function parseTailscaleStatus(json: unknown): TailscaleSelf | undefined {
  if (!json || typeof json !== 'object') return undefined;
  const status = json as { BackendState?: unknown; Self?: { DNSName?: unknown; TailscaleIPs?: unknown }; CurrentTailnet?: { MagicDNSEnabled?: unknown } | null };
  if (status.BackendState !== undefined && status.BackendState !== 'Running') return undefined;
  const self = status.Self;
  if (!self || typeof self !== 'object') return undefined;
  const ips = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs.filter((ip): ip is string => typeof ip === 'string' && isTailscaleIPv4(ip)) : [];
  const magic = status.CurrentTailnet?.MagicDNSEnabled !== false;
  const name = typeof self.DNSName === 'string' ? self.DNSName.trim().replace(/\.$/, '').toLowerCase() : '';
  const dnsName = magic && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(name) ? name : undefined;
  if (!dnsName && !ips.length) return undefined;
  return dnsName ? { dnsName, ips } : { ips };
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

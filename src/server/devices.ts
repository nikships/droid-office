// Paired phones (Droid Office for Android). A phone that scanned the pairing QR code, and so has this
// start's LAN token, POSTs /api/mobile/pair once and gets a long random device token back. That token
// opens the office like the LAN token does, but across restarts, until the owner forgets the phone in
// ⚙️ Settings → Phone or the phone unpairs itself. Only the token's SHA-256 is kept, in the office's
// own `.droid-office/devices.json` (mode 0600, written atomically).

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEVICE_NAME_MAX, DEVICES_MAX, type PairedDevice, type PairingAddress } from '../shared/devices.js';
import { isTailscaleIPv4 } from './lan.js';
import type { TailscaleSelf } from './tailscale.js';

interface DeviceRecord extends PairedDevice {
  /** SHA-256 of the device token, hex. The token itself is never written down. */
  hash: string;
}

/** How often a device's lastSeenAt is written back at most: being seen isn't worth a write per request. */
export const SEEN_EVERY_MS = 60_000;

const sha256 = (text: string) => createHash('sha256').update(text).digest();

/** A phone's name as it gave it: one line, no control characters, at most DEVICE_NAME_MAX long. */
export function cleanDeviceName(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : '';
  const name = Array.from(text.replace(/\s+/g, ' ').trim())
    .filter((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      return c >= 0x20 && (c < 0x7f || c > 0x9f);
    })
    .join('');
  return Array.from(name).slice(0, DEVICE_NAME_MAX).join('').trim() || 'Android phone';
}

export class DevicesStore {
  private readonly file: string;
  private devices: DeviceRecord[] = [];

  constructor(
    dataDir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.file = path.join(dataDir, 'devices.json');
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { devices?: unknown };
      if (Array.isArray(raw.devices)) {
        for (const d of raw.devices as Partial<DeviceRecord>[]) {
          if (typeof d?.id !== 'string' || typeof d.hash !== 'string' || !/^[0-9a-f]{64}$/.test(d.hash)) continue;
          const pairedAt = typeof d.pairedAt === 'string' ? d.pairedAt : new Date(0).toISOString();
          this.devices.push({ id: d.id, name: cleanDeviceName(d.name), hash: d.hash, pairedAt, lastSeenAt: typeof d.lastSeenAt === 'string' ? d.lastSeenAt : pairedAt });
        }
      }
    } catch {
      // No phones paired yet, or a file someone mangled: start empty, and the next pairing writes a good one.
    }
  }

  /** Pairs a new phone; the token is returned this once and never again. Undefined when DEVICES_MAX are paired already. */
  pair(rawName: unknown): { device: PairedDevice; token: string } | undefined {
    if (this.devices.length >= DEVICES_MAX) return undefined;
    const token = randomBytes(32).toString('base64url');
    const at = new Date(this.now()).toISOString();
    let id: string;
    do id = randomBytes(6).toString('hex');
    while (this.devices.some((d) => d.id === id));
    const record: DeviceRecord = { id, name: cleanDeviceName(rawName), hash: sha256(token).toString('hex'), pairedAt: at, lastSeenAt: at };
    this.devices.push(record);
    this.save();
    return { device: view(record), token };
  }

  /** The phone this token belongs to, if it's still paired. Compares every stored hash in constant time. */
  verify(token: string | null | undefined): PairedDevice | undefined {
    if (!token) return undefined;
    const candidate = sha256(token);
    let found: DeviceRecord | undefined;
    // No early exit: how long this takes says nothing about which phone (if any) matched.
    for (const d of this.devices) if (timingSafeEqual(candidate, Buffer.from(d.hash, 'hex')) && !found) found = d;
    return found && view(found);
  }

  /** The phone was just heard from: lastSeenAt moves on, written down at most once every SEEN_EVERY_MS. */
  seen(id: string): void {
    const d = this.devices.find((x) => x.id === id);
    if (!d) return;
    const now = this.now();
    if (now - Date.parse(d.lastSeenAt) < SEEN_EVERY_MS) return;
    d.lastSeenAt = new Date(now).toISOString();
    this.save();
  }

  /** Unpairs a phone: its token stops working at once. False when there was no such phone. */
  forget(id: string): boolean {
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.id !== id);
    if (this.devices.length === before) return false;
    this.save();
    return true;
  }

  /** Every paired phone, most recently seen first. */
  list(): PairedDevice[] {
    return this.devices.map(view).sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
  }

  private save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify({ devices: this.devices }, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      console.error(`droid-office: couldn't save paired phones to ${this.file}: ${(err as Error).message}`);
    }
  }
}

const view = ({ id, name, pairedAt, lastSeenAt }: DeviceRecord): PairedDevice => ({ id, name, pairedAt, lastSeenAt });

let cachedMachineName: string | undefined;
/** What this machine is called, for the phone's list of offices: the Mac's Computer Name, else its host name. */
export function machineName(): string {
  if (cachedMachineName) return cachedMachineName;
  let name = '';
  if (process.platform === 'darwin') {
    try {
      name = execFileSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      // Not there (a minimal macOS image): the host name below.
    }
  }
  cachedMachineName = name || os.hostname().replace(/\.local$/i, '') || 'Droid Office';
  return cachedMachineName;
}

/**
 * The base URLs a phone can reach the office at, Wi-Fi first, then Tailscale (the MagicDNS name, then
 * the 100.x address). Bound to every interface, that's all of them; bound to one address, only that
 * one; bound to loopback, none.
 */
export function pairingAddresses(opts: { scheme: 'http' | 'https'; host: string; port: number; lan: readonly string[]; tailscale?: TailscaleSelf; tailscaleIps?: readonly string[] }): PairingAddress[] {
  const { scheme, host, port } = opts;
  const base = (h: string) => `${scheme}://${h.includes(':') ? `[${h}]` : h}:${port}`;
  const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost' || host.startsWith('127.');
  if (loopback) return [];
  const wildcard = host === '0.0.0.0' || host === '::' || host === '';
  if (!wildcard) return [isTailscaleIPv4(host) ? { url: base(host), kind: 'tailscale' } : { url: base(host), kind: 'wifi' }];
  const out: PairingAddress[] = opts.lan.filter((ip) => !isTailscaleIPv4(ip)).map((ip) => ({ url: base(ip), kind: 'wifi' }));
  if (opts.tailscale?.dnsName) out.push({ url: base(opts.tailscale.dnsName), kind: 'tailscale', dns: true });
  for (const ip of new Set([...(opts.tailscale?.ips ?? []), ...(opts.tailscaleIps ?? [])])) if (isTailscaleIPv4(ip)) out.push({ url: base(ip), kind: 'tailscale' });
  return out;
}

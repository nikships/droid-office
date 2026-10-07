// The office's LAN gate: one random token per start, kept in memory and never written to disk.
// The laptop's own browser connects over loopback and needs nothing; every other HTTP request and
// WebSocket upgrade must carry ?t=<token>. Startup prints the join URL and its QR code (see
// cli.ts). One timing-safe compare per connection, zero per-message overhead.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import os from 'node:os';

/** Fresh on every start: whoever has it was shown this start's QR code. */
export function mintLanToken(): string {
  return randomBytes(24).toString('base64url');
}

/** Loopback senders are the office's own machine and connect freely. */
export function isLoopback(ip: string | undefined): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/** Timing-safe compare that also hides the length: both sides go through SHA-256 first. */
export function lanTokenOk(candidate: string | null | undefined, token: string): boolean {
  if (!candidate) return false;
  const a = createHash('sha256').update(candidate).digest();
  const b = createHash('sha256').update(token).digest();
  return timingSafeEqual(a, b);
}

/**
 * Whether this request may reach the office. The socket's own address decides loopback (headers
 * can be spoofed; the peer address can't), so a trusted proxy in front of the office still gates
 * its own clients.
 */
export function lanAllowed(req: IncomingMessage, url: URL, token: string): boolean {
  if (isLoopback(req.socket.remoteAddress)) return true;
  return lanTokenOk(url.searchParams.get('t'), token);
}

/** The token in `Authorization: Bearer <token>`, if the request carries one. */
export function bearerToken(req: IncomingMessage): string | undefined {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '');
  return m?.[1];
}

/** Tailscale's CGNAT range, 100.64.0.0/10: a tailnet address, not the Wi-Fi. */
export function isTailscaleIPv4(ip: string): boolean {
  const m = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(ip);
  return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}

function externalIPv4s(): { name: string; address: string }[] {
  const out: { name: string; address: string }[] = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const ni of list ?? []) if (ni.family === 'IPv4' && !ni.internal) out.push({ name, address: ni.address });
  }
  return out;
}

/** This machine's LAN IPv4 addresses, Wi-Fi first, for the join URL and its QR code. Tailscale's are left out (see tailscaleIPv4s). */
export function lanIPv4s(): string[] {
  return externalIPv4s()
    .filter((i) => !isTailscaleIPv4(i.address))
    .sort((a, b) => Number(b.name === 'en0') - Number(a.name === 'en0'))
    .map((i) => i.address);
}

/** This machine's tailnet IPv4 addresses, as its network interfaces show them. */
export function tailscaleIPv4s(): string[] {
  return externalIPv4s()
    .filter((i) => isTailscaleIPv4(i.address))
    .map((i) => i.address);
}

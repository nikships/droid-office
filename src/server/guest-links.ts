// Share links for external guests (docs/guest-sharing.md). The owner creates a link with a label, one
// of five presets and an optional expiry; the office returns its secret token once and keeps only the
// token's SHA-256 in the office-wide `.droid-office/guest-links.json` (mode 0600, written atomically),
// together with the global external-sharing toggle (off until the owner turns it on).
//
// Every guest request and WebSocket upgrade is checked here: the toggle, then the token in constant
// time across every stored hash, then revocation and expiry. Open guest sockets register with a close
// callback, so revoking a link, its expiry, or turning sharing off disconnects them at once.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { bearerToken } from './lan.js';
import { cleanDeviceName } from './devices.js';
import {
  GUEST_CLOSE_DISABLED,
  GUEST_CLOSE_ENDED,
  GUEST_ENDED_KEEP_MS,
  GUEST_LABEL_MAX,
  GUEST_LINKS_MAX,
  GUEST_QUERY_KEY,
  GUEST_WS_PROTOCOL,
  guestExpiryMs,
  guestScope,
  guestSessionOf,
  isGuestExpiry,
  isGuestPreset,
  type GuestLinkItem,
  type GuestLinkStatus,
  type GuestPreset,
  type GuestSession,
  type GuestUnavailableReason,
} from '../shared/guest-links.js';

export const GUEST_LINKS_FILE = 'guest-links.json';

/** Wrong tokens allowed per source per window, and how many sources are remembered at most. */
export const GUEST_FAILS_PER_SOURCE = 20;
export const GUEST_FAIL_WINDOW_MS = 60_000;
const GUEST_FAIL_SOURCES_MAX = 4096;

/** The longest a timer may wait (setTimeout overflows past 2^31 - 1 ms). */
const MAX_TIMER_MS = 2 ** 31 - 1;

interface LinkRecord {
  id: string;
  label: string;
  preset: GuestPreset;
  floorId?: string;
  workerId?: string;
  /** SHA-256 of the token, hex. The token itself is never written down. */
  hash: string;
  createdAt: number;
  expiresAt?: number;
  revokedAt?: number;
}

/** What a valid token grants a guest request or connection. */
export interface GuestGrant {
  linkId: string;
  /** For audit attribution only; never sent to guests. */
  label: string;
  preset: GuestPreset;
  floorId?: string;
  workerId?: string;
  /** Epoch ms, when the link expires. */
  expiresAt?: number;
  session: GuestSession;
}

export type GuestVerify = { ok: true; grant: GuestGrant } | { ok: false; reason: GuestUnavailableReason; retryAfterMs?: number };

/** Current display names of a link's floor and worker; a name is absent when its floor or worker is gone. */
export type GuestNames = (target: { floorId?: string; workerId?: string }) => { floorName?: string; workerName?: string };

export interface GuestLinkInput {
  label: unknown;
  preset: unknown;
  floorId?: unknown;
  workerId?: unknown;
  expiry: unknown;
}

export type GuestCreateResult = { ok: true; link: GuestLinkItem; token: string } | { ok: false; status: 400 | 409; error: string };

export interface GuestLinksOptions {
  dataDir: string;
  names?: GuestNames;
  now?: () => number;
  /** Disable the expiry timer (tests call sweep() with a fake clock). */
  timers?: boolean;
}

interface Session {
  close(code: number, reason: string): void;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest();
const TOKEN_RE = /^[A-Za-z0-9_-]{20,128}$/;

/** A link label as the owner typed it: one line, no control characters, at most GUEST_LABEL_MAX long. */
export function cleanGuestLabel(raw: unknown): string {
  return Array.from(cleanDeviceName(raw, '')).slice(0, GUEST_LABEL_MAX).join('').trim();
}

/**
 * The guest token a request carries: `Authorization: Bearer`, the WebSocket subprotocol pair
 * (`droid-office-guest`, token), or with `query` the `?g=` of an embedded read-only GET.
 */
export function guestTokenOf(req: IncomingMessage, url?: URL, query = false): string | undefined {
  const header = bearerToken(req);
  if (header) return header;
  const offered = req.headers['sec-websocket-protocol'];
  if (typeof offered === 'string') {
    const [first, second] = offered.split(',').map((s) => s.trim());
    if (first === GUEST_WS_PROTOCOL && second) return second;
  }
  if (query && url) return url.searchParams.get(GUEST_QUERY_KEY) ?? undefined;
  return undefined;
}

/**
 * Where failed attempts are counted from. tailscaled's Funnel proxy replaces X-Forwarded-For with the client
 * address the Funnel ingress reports (ipn/ipnlocal/serve.go, addProxyForwardedHeaders), so a value the client
 * sent never arrives; only a process on this machine can send another. Without one, one shared bucket.
 */
function sourceOf(req: IncomingMessage): string {
  const xff = req.headers['x-forwarded-for'];
  const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
  return first ? first.slice(0, 64) : 'unknown';
}

export class GuestLinks {
  private readonly file: string;
  private readonly now: () => number;
  private readonly names: GuestNames;
  private sharing = false;
  private links: LinkRecord[] = [];
  private readonly sessions = new Map<string, Set<Session>>();
  /** Links whose expiry sweep() has already announced. */
  private readonly expired = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly fails = new Map<string, { count: number; since: number }>();
  private timer?: NodeJS.Timeout;
  private readonly timers: boolean;
  private stopped = false;

  constructor(opts: GuestLinksOptions) {
    this.file = path.join(opts.dataDir, GUEST_LINKS_FILE);
    this.now = opts.now ?? Date.now;
    this.names = opts.names ?? (() => ({}));
    this.timers = opts.timers ?? true;
    this.load();
    this.prune();
    this.schedule();
  }

  /** The global external-sharing toggle. */
  get on(): boolean {
    return this.sharing;
  }

  /** Turns external sharing on or off. Off disconnects every guest at once and blocks every link. */
  setOn(on: boolean): void {
    if (this.sharing === on) return;
    this.sharing = on;
    this.save();
    if (!on) this.closeAll(GUEST_CLOSE_DISABLED, 'disabled');
    this.emit();
  }

  /** Checks a token: sharing on, a known hash (constant time across all links), not revoked, not expired. */
  verify(token: string | null | undefined): GuestVerify {
    if (!this.sharing) return { ok: false, reason: 'disabled' };
    if (!token || !TOKEN_RE.test(token)) return { ok: false, reason: 'unavailable' };
    const candidate = sha256(token);
    let found: LinkRecord | undefined;
    // No early exit: how long this takes says nothing about which link (if any) matched.
    for (const l of this.links) if (timingSafeEqual(candidate, Buffer.from(l.hash, 'hex')) && !found) found = l;
    if (!found) return { ok: false, reason: 'unavailable' };
    const reason = this.ended(found);
    return reason ? { ok: false, reason } : { ok: true, grant: grantOf(found) };
  }

  /**
   * verify() for a request or upgrade on the guest backend. A valid token always passes; the limit is only
   * on answers to wrong tokens, so nobody can lock real guests out by spending a source's budget. Past
   * GUEST_FAILS_PER_SOURCE wrong tokens from one source in a window, a wrong token gets a Retry-After.
   * A request without a token is refused but not counted (the bootstrap page and card assets carry none).
   */
  authenticate(req: IncomingMessage, url?: URL, query = false): GuestVerify {
    if (!this.sharing) return { ok: false, reason: 'disabled' };
    const token = guestTokenOf(req, url, query);
    if (!token) return { ok: false, reason: 'unavailable' };
    const result = this.verify(token);
    if (result.ok || result.reason !== 'unavailable') return result;
    const source = sourceOf(req);
    const now = this.now();
    const bucket = this.fails.get(source);
    if (bucket && now - bucket.since < GUEST_FAIL_WINDOW_MS) {
      if (bucket.count >= GUEST_FAILS_PER_SOURCE) return { ...result, retryAfterMs: Math.max(1000, GUEST_FAIL_WINDOW_MS - (now - bucket.since)) };
      bucket.count++;
    } else this.fails.set(source, { count: 1, since: now });
    if (this.fails.size > GUEST_FAIL_SOURCES_MAX) for (const [k, b] of this.fails) if (now - b.since >= GUEST_FAIL_WINDOW_MS || this.fails.size > GUEST_FAIL_SOURCES_MAX) this.fails.delete(k);
    return result;
  }

  /** Why a granted link no longer opens anything (revoked, expired, sharing off), or undefined while it does. */
  check(linkId: string): GuestUnavailableReason | undefined {
    if (!this.sharing) return 'disabled';
    const link = this.links.find((l) => l.id === linkId);
    return link ? this.ended(link) : 'unavailable';
  }

  /** Creates a link. The token is returned this once and never again. */
  create(input: GuestLinkInput): GuestCreateResult {
    const label = cleanGuestLabel(input.label);
    if (!label) return { ok: false, status: 400, error: 'Give the link a label, like “Alex - PR review”.' };
    if (!isGuestPreset(input.preset)) return { ok: false, status: 400, error: 'Pick one of the five access presets.' };
    if (!isGuestExpiry(input.expiry)) return { ok: false, status: 400, error: 'Pick an expiry: until revoked, 1 hour, 24 hours or 7 days.' };
    const preset = input.preset;
    const scope = guestScope(preset);
    const floorId = scope !== 'office' && typeof input.floorId === 'string' ? input.floorId.slice(0, 64) : undefined;
    const workerId = scope === 'worker' && typeof input.workerId === 'string' ? input.workerId.slice(0, 32) : undefined;
    if (scope !== 'office') {
      const names = floorId ? this.names({ floorId, workerId }) : {};
      if (!floorId || names.floorName === undefined) return { ok: false, status: 400, error: 'Pick an open floor for this link.' };
      if (scope === 'worker' && (!workerId || names.workerName === undefined)) return { ok: false, status: 400, error: 'Pick a worker on that floor for this link.' };
    }
    this.prune();
    if (!this.sharing) return { ok: false, status: 409, error: 'Turn on external sharing first.' };
    if (this.links.filter((l) => !this.ended(l)).length >= GUEST_LINKS_MAX) return { ok: false, status: 409, error: `${GUEST_LINKS_MAX} share links are active already. Revoke one first.` };
    const token = randomBytes(32).toString('base64url');
    let id: string;
    do id = randomBytes(6).toString('hex');
    while (this.links.some((l) => l.id === id));
    const now = this.now();
    const ms = guestExpiryMs(input.expiry);
    const record: LinkRecord = {
      id,
      label,
      preset,
      ...(floorId ? { floorId } : {}),
      ...(workerId ? { workerId } : {}),
      hash: sha256(token).toString('hex'),
      createdAt: now,
      ...(ms ? { expiresAt: now + ms } : {}),
    };
    this.links.push(record);
    if (!this.save()) {
      this.links = this.links.filter((l) => l !== record);
      return { ok: false, status: 409, error: 'The office couldn’t save the link. Check the disk and try again.' };
    }
    this.schedule();
    this.emit();
    return { ok: true, link: this.item(record), token };
  }

  /** Revokes a link for good: its token stops working and its guests disconnect at once. False when there's no such active link. */
  revoke(id: string): boolean {
    const link = this.links.find((l) => l.id === id);
    if (!link || link.revokedAt !== undefined) return false;
    link.revokedAt = this.now();
    // Revoked in memory even if the disk refuses; save() logs the failure.
    this.save();
    this.closeLink(id, GUEST_CLOSE_ENDED, 'revoked');
    this.schedule();
    this.emit();
    return true;
  }

  /** Every remembered link, newest first, with its status and live guest count. */
  list(): GuestLinkItem[] {
    this.prune();
    return this.links.map((l) => this.item(l)).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
  }

  get(id: string): GuestLinkItem | undefined {
    const link = this.links.find((l) => l.id === id);
    return link && this.item(link);
  }

  /**
   * An open guest connection on a granted link. `close` runs when the link is revoked or expires, or
   * sharing is turned off; the returned function unregisters it (call it when the socket closes).
   */
  register(grant: Pick<GuestGrant, 'linkId'>, close: (code: number, reason: string) => void): () => void {
    const session: Session = { close };
    const reason = this.check(grant.linkId);
    if (reason) {
      close(reason === 'disabled' ? GUEST_CLOSE_DISABLED : GUEST_CLOSE_ENDED, reason);
      return () => undefined;
    }
    let set = this.sessions.get(grant.linkId);
    if (!set) this.sessions.set(grant.linkId, (set = new Set()));
    set.add(session);
    this.emit();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const current = this.sessions.get(grant.linkId);
      if (!current?.delete(session)) return;
      if (!current.size) this.sessions.delete(grant.linkId);
      this.emit();
    };
  }

  /** Open guest connections on one link, or on every link. */
  liveCount(linkId?: string): number {
    if (linkId !== undefined) return this.sessions.get(linkId)?.size ?? 0;
    let n = 0;
    for (const set of this.sessions.values()) n += set.size;
    return n;
  }

  /** Called after any change the owner's Share list shows: links, toggle, expiry or live counts. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Ends sessions on links that expired by now and tells listeners; runs on a timer at each expiry. */
  sweep(): void {
    let changed = this.prune();
    for (const l of this.links) {
      if (this.ended(l) !== 'expired' || this.expired.has(l.id)) continue;
      this.expired.add(l.id);
      this.closeLink(l.id, GUEST_CLOSE_ENDED, 'expired');
      changed = true;
    }
    if (changed) this.emit();
    this.schedule();
  }

  /** Stops the expiry timer. Open guest sockets are closed by the server's own shutdown. */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private ended(link: LinkRecord): 'revoked' | 'expired' | undefined {
    if (link.revokedAt !== undefined) return 'revoked';
    if (link.expiresAt !== undefined && link.expiresAt <= this.now()) return 'expired';
    return undefined;
  }

  private status(link: LinkRecord): GuestLinkStatus {
    return this.ended(link) ?? 'active';
  }

  private item(l: LinkRecord): GuestLinkItem {
    const names = l.floorId ? this.names({ floorId: l.floorId, workerId: l.workerId }) : {};
    return {
      id: l.id,
      label: l.label,
      preset: l.preset,
      ...(l.floorId ? { floorId: l.floorId } : {}),
      ...(l.floorId && names.floorName !== undefined ? { floorName: names.floorName } : {}),
      ...(l.workerId ? { workerId: l.workerId } : {}),
      ...(l.workerId && names.workerName !== undefined ? { workerName: names.workerName } : {}),
      createdAt: new Date(l.createdAt).toISOString(),
      ...(l.expiresAt !== undefined ? { expiresAt: new Date(l.expiresAt).toISOString() } : {}),
      ...(l.revokedAt !== undefined ? { revokedAt: new Date(l.revokedAt).toISOString() } : {}),
      status: this.status(l),
      guests: this.liveCount(l.id),
    };
  }

  private closeLink(id: string, code: number, reason: string) {
    const set = this.sessions.get(id);
    if (!set) return;
    this.sessions.delete(id);
    for (const s of set) s.close(code, reason);
  }

  private closeAll(code: number, reason: string) {
    for (const id of [...this.sessions.keys()]) this.closeLink(id, code, reason);
  }

  private emit() {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (err) {
        console.error('droid-office: guest link listener failed:', err);
      }
    }
  }

  /** Forgets links that ended more than GUEST_ENDED_KEEP_MS ago. True when any were dropped. */
  private prune(): boolean {
    const cutoff = this.now() - GUEST_ENDED_KEEP_MS;
    const before = this.links.length;
    this.links = this.links.filter((l) => {
      const endedAt = l.revokedAt ?? (l.expiresAt !== undefined && l.expiresAt <= this.now() ? l.expiresAt : undefined);
      return endedAt === undefined || endedAt > cutoff;
    });
    if (this.links.length === before) return false;
    this.save();
    return true;
  }

  private schedule() {
    clearTimeout(this.timer);
    if (!this.timers || this.stopped) return;
    const now = this.now();
    const next = Math.min(...this.links.filter((l) => l.revokedAt === undefined && l.expiresAt !== undefined && l.expiresAt > now).map((l) => l.expiresAt!));
    if (!Number.isFinite(next)) return;
    this.timer = setTimeout(() => this.sweep(), Math.min(MAX_TIMER_MS, next - now + 50)).unref();
  }

  private load() {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { on?: unknown; links?: unknown };
      this.sharing = raw.on === true;
      if (!Array.isArray(raw.links)) return;
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
      for (const r of raw.links as Partial<LinkRecord>[]) {
        if (typeof r?.id !== 'string' || !/^[0-9a-f]{12}$/.test(r.id) || typeof r.hash !== 'string' || !/^[0-9a-f]{64}$/.test(r.hash) || !isGuestPreset(r.preset)) continue;
        const scope = guestScope(r.preset);
        const floorId = typeof r.floorId === 'string' ? r.floorId : undefined;
        const workerId = typeof r.workerId === 'string' ? r.workerId : undefined;
        if ((scope !== 'office' && !floorId) || (scope === 'worker' && !workerId)) continue;
        const createdAt = num(r.createdAt) ?? 0;
        const expiresAt = num(r.expiresAt);
        const revokedAt = num(r.revokedAt);
        this.links.push({
          id: r.id,
          label: cleanGuestLabel(r.label) || 'Share link',
          preset: r.preset,
          ...(scope !== 'office' ? { floorId } : {}),
          ...(scope === 'worker' ? { workerId } : {}),
          hash: r.hash,
          createdAt,
          ...(expiresAt !== undefined ? { expiresAt } : {}),
          ...(revokedAt !== undefined ? { revokedAt } : {}),
        });
      }
    } catch {
      // No links yet, or a mangled file: sharing stays off and the next change writes a good one.
    }
  }

  private save(): boolean {
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify({ on: this.sharing, links: this.links }, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, this.file);
      return true;
    } catch (err) {
      console.error(`droid-office: couldn't save share links to ${this.file}: ${(err as Error).message}`);
      return false;
    }
  }
}

function grantOf(l: LinkRecord): GuestGrant {
  return {
    linkId: l.id,
    label: l.label,
    preset: l.preset,
    ...(l.floorId ? { floorId: l.floorId } : {}),
    ...(l.workerId ? { workerId: l.workerId } : {}),
    ...(l.expiresAt !== undefined ? { expiresAt: l.expiresAt } : {}),
    session: guestSessionOf({ preset: l.preset, floorId: l.floorId, workerId: l.workerId, ...(l.expiresAt !== undefined ? { expiresAt: new Date(l.expiresAt).toISOString() } : {}) }),
  };
}

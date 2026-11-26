// The guest write audit (docs/guest-sharing.md): every guest mutation the office accepts, appended to the
// office-wide `.droid-office/guest-audit.jsonl` (mode 0600). The file rotates to `guest-audit.1.jsonl`
// past a size bound, so at most two files are kept. Terminal input is coalesced into one entry per burst
// per link and worker instead of one per keystroke. Refused attempts are never recorded here.

import { randomBytes } from 'node:crypto';
import { appendFileSync, readFileSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { GUEST_AUDIT_DETAIL_MAX, GUEST_AUDIT_PAGE_MAX, type GuestAuditAction, type GuestAuditEntry, type GuestAuditPage, type GuestAuditTarget } from '../shared/guest-links.js';
import type { GuestGrant } from './guest-links.js';

export const GUEST_AUDIT_FILE = 'guest-audit.jsonl';
export const GUEST_AUDIT_OLD_FILE = 'guest-audit.1.jsonl';
/** Rotate once the live file passes this many bytes. */
export const GUEST_AUDIT_MAX_BYTES = 2 * 1024 * 1024;
/** A terminal burst ends after this long without input, or this long after it started. */
export const GUEST_TTY_QUIET_MS = 5_000;
export const GUEST_TTY_BURST_MS = 60_000;
const TTY_PREVIEW_MAX = 120;

export interface GuestAuditInput {
  grant: Pick<GuestGrant, 'linkId' | 'label' | 'preset'>;
  target: GuestAuditTarget;
  action: GuestAuditAction;
  detail?: string;
}

export interface GuestAuditOptions {
  dataDir: string;
  now?: () => number;
  maxBytes?: number;
  /** Called after an entry is written (owner pages refresh their audit list). */
  onAppend?: () => void;
  /** Disable burst timers (tests call flush()). */
  timers?: boolean;
}

/** One line, no control characters, at most GUEST_AUDIT_DETAIL_MAX characters. */
export function auditDetail(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const chars = Array.from(raw.replace(/\s+/g, ' ').trim()).filter((ch) => {
    const c = ch.codePointAt(0) ?? 0;
    return c >= 0x20 && (c < 0x7f || c > 0x9f);
  });
  if (!chars.length) return undefined;
  return chars.length > GUEST_AUDIT_DETAIL_MAX ? `${chars.slice(0, GUEST_AUDIT_DETAIL_MAX - 1).join('')}…` : chars.join('');
}

/** What a guest typed into a terminal, readable: escape sequences dropped, Enter as ⏎, other controls as ·. */
export function ttyPreview(data: string): string {
  return data
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b./g, '')
    .replace(/\r\n?|\n/g, '⏎')
    .replace(/\t/g, ' ')
    .replace(/[\x00-\x1f\x7f]/g, '·');
}

interface Burst {
  entry: GuestAuditEntry;
  preview: string;
  startedAt: number;
  timer?: NodeJS.Timeout;
}

export class GuestAudit {
  private readonly file: string;
  private readonly oldFile: string;
  private readonly now: () => number;
  private readonly maxBytes: number;
  private readonly timers: boolean;
  private readonly bursts = new Map<string, Burst>();

  constructor(private readonly opts: GuestAuditOptions) {
    this.file = path.join(opts.dataDir, GUEST_AUDIT_FILE);
    this.oldFile = path.join(opts.dataDir, GUEST_AUDIT_OLD_FILE);
    this.now = opts.now ?? Date.now;
    this.maxBytes = opts.maxBytes ?? GUEST_AUDIT_MAX_BYTES;
    this.timers = opts.timers ?? true;
  }

  /** Appends one accepted guest action. */
  record(input: GuestAuditInput): GuestAuditEntry {
    const entry = this.entry(input, this.now());
    this.append(entry);
    return entry;
  }

  /** Terminal input from a guest: one entry per burst per link and worker, written when the burst ends. */
  tty(input: Omit<GuestAuditInput, 'action' | 'detail'>, data: string): void {
    const now = this.now();
    const key = `${input.grant.linkId}\0${input.target.kind}\0${input.target.workerId ?? ''}`;
    let burst = this.bursts.get(key);
    if (burst && now - burst.startedAt >= GUEST_TTY_BURST_MS) {
      this.end(key);
      burst = undefined;
    }
    if (!burst) {
      burst = { entry: { ...this.entry({ ...input, action: 'tty' }, now), count: 0 }, preview: '', startedAt: now };
      this.bursts.set(key, burst);
    }
    burst.entry.count = (burst.entry.count ?? 0) + 1;
    burst.entry.until = new Date(now).toISOString();
    if (burst.preview.length < TTY_PREVIEW_MAX) burst.preview = (burst.preview + ttyPreview(data)).slice(0, TTY_PREVIEW_MAX);
    const detail = auditDetail(burst.preview);
    if (detail) burst.entry.detail = detail;
    else delete burst.entry.detail;
    clearTimeout(burst.timer);
    if (this.timers) burst.timer = setTimeout(() => this.end(key), GUEST_TTY_QUIET_MS).unref();
  }

  /** Writes every open terminal burst now (shutdown, tests). */
  flush(): void {
    for (const key of [...this.bursts.keys()]) this.end(key);
  }

  /** Entries newest first: open bursts, the live file, then the rotated one. `before` is the previous page's `next`. */
  read(opts: { before?: string; limit?: number } = {}): GuestAuditPage {
    const limit = Math.max(1, Math.min(GUEST_AUDIT_PAGE_MAX, Math.floor(opts.limit ?? 50) || 50));
    const open = [...this.bursts.values()].map((b) => ({ ...b.entry })).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    const all = [...open, ...this.lines(this.file).reverse(), ...this.lines(this.oldFile).reverse()];
    let start = 0;
    if (opts.before) {
      const i = all.findIndex((e) => e.id === opts.before);
      start = i < 0 ? all.length : i + 1;
    }
    const entries = all.slice(start, start + limit);
    const last = entries.at(-1);
    return { entries, ...(start + limit < all.length && last ? { next: last.id } : {}) };
  }

  stop(): void {
    this.flush();
  }

  private entry(input: GuestAuditInput, at: number): GuestAuditEntry {
    const detail = auditDetail(input.detail);
    const target: GuestAuditTarget = { kind: input.target.kind };
    for (const k of ['floorId', 'floorName', 'workerId', 'workerName'] as const) {
      const v = input.target[k];
      if (typeof v === 'string' && v) target[k] = v.slice(0, 120);
    }
    return {
      id: `${at.toString(36)}-${randomBytes(4).toString('hex')}`,
      at: new Date(at).toISOString(),
      linkId: input.grant.linkId,
      linkLabel: input.grant.label,
      preset: input.grant.preset,
      target,
      action: input.action,
      ...(detail ? { detail } : {}),
    };
  }

  private end(key: string) {
    const burst = this.bursts.get(key);
    if (!burst) return;
    this.bursts.delete(key);
    clearTimeout(burst.timer);
    this.append(burst.entry);
  }

  private append(entry: GuestAuditEntry) {
    try {
      let size = 0;
      try {
        size = statSync(this.file).size;
      } catch {
        // not written yet
      }
      if (size >= this.maxBytes) renameSync(this.file, this.oldFile);
      appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch (err) {
      console.error(`droid-office: couldn't write the guest audit to ${this.file}: ${(err as Error).message}`);
      return;
    }
    this.opts.onAppend?.();
  }

  private lines(file: string): GuestAuditEntry[] {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    const out: GuestAuditEntry[] = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as GuestAuditEntry;
        if (e && typeof e.id === 'string' && typeof e.at === 'string' && typeof e.linkId === 'string') out.push(e);
      } catch {
        // a torn last line from a crash
      }
    }
    return out;
  }
}

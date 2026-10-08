import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { CREDIT_DAYS, type FactoryCredits } from '../../shared/factory-sessions.js';

// What Droid sessions cost over time. Factory only says how many credits a session has used in
// total, so the office keeps a small ledger (the office's .droid-office/factory-credits.json) of
// each session's total as it saw it at each read: the increase since the last read is what the
// session spent that day. A session it sees for the first time has all its credits put on the day
// it was last active, which is a guess for the days before the office started counting.

const DAY_MS = 86_400_000;
/** Days of history the ledger keeps. */
export const LEDGER_DAYS = 31;
/** A session nobody has seen for this long is forgotten (seeing it again counts it afresh). */
const SEEN_MS = 90 * DAY_MS;
const TOP = 5;

/** `YYYY-MM-DD` in the office's local time. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

interface Seen {
  credits: number;
  /** When the office read it (ms). */
  at: number;
  title?: string;
}

export interface LedgerData {
  v: 1;
  /** When the office started counting (ms). */
  since: number;
  /** Credits spent per day, per session. */
  days: Record<string, Record<string, number>>;
  /** Per day, how much of it came from first sightings (whole totals, a guess at when they were spent). */
  guessed: Record<string, number>;
  seen: Record<string, Seen>;
}

const empty = (): LedgerData => ({ v: 1, since: 0, days: {}, guessed: {}, seen: {} });

function parse(text: string): LedgerData {
  const raw = JSON.parse(text) as Partial<LedgerData>;
  if (raw?.v !== 1 || typeof raw.days !== 'object' || typeof raw.seen !== 'object') return empty();
  const guessed = raw.guessed && typeof raw.guessed === 'object' ? raw.guessed : {};
  return { v: 1, since: typeof raw.since === 'number' ? raw.since : 0, days: raw.days ?? {}, guessed, seen: raw.seen ?? {} };
}

export class CreditLedger {
  private data: LedgerData;
  private dirty = false;

  constructor(
    /** Undefined: kept in memory only. */
    private file?: string,
    private now: () => number = Date.now,
  ) {
    let data = empty();
    if (file) {
      try {
        data = parse(readFileSync(file, 'utf8'));
      } catch {
        // none yet, or unreadable: start counting afresh
      }
    }
    this.data = data;
  }

  /** The ledger as it is, for tests. */
  snapshot(): LedgerData {
    return structuredClone(this.data);
  }

  /** A session's total `credits` as read now; `updatedAt` is when it was last active. True when the ledger changed. */
  observe(id: string, credits: number, updatedAt: number, title?: string): boolean {
    if (!Number.isFinite(credits) || credits < 0) return false;
    const now = this.now();
    const d = this.data;
    if (!d.since) d.since = now;
    const prev = d.seen[id];
    let spent = 0;
    let day = '';
    if (!prev) {
      spent = credits;
      day = dayKey(updatedAt > 0 ? Math.min(updatedAt, now) : now);
    } else if (credits > prev.credits) {
      spent = credits - prev.credits;
      // Spent between the last read and now: on the day it was last active, if that's since the last read.
      day = dayKey(updatedAt > prev.at && updatedAt <= now ? updatedAt : now);
    }
    if (spent > 0) {
      const per = (d.days[day] ??= {});
      per[id] = (per[id] ?? 0) + spent;
      if (!prev) d.guessed[day] = (d.guessed[day] ?? 0) + spent;
    }
    const titleChanged = !!title && prev?.title !== title;
    d.seen[id] = { credits: Math.max(credits, prev?.credits ?? 0), at: now, ...(title ? { title } : prev?.title ? { title: prev.title } : {}) };
    // A read that changed nothing but when it was seen isn't worth a write on its own.
    if (spent > 0 || !prev || titleChanged) this.dirty = true;
    return spent > 0;
  }

  /** The last total the office read for session `id`, or undefined. */
  last(id: string): number | undefined {
    return this.data.seen[id]?.credits;
  }

  /** Drops the days and sessions too old to keep. */
  prune() {
    const now = this.now();
    const oldest = dayKey(now - (LEDGER_DAYS - 1) * DAY_MS);
    for (const day of Object.keys(this.data.days)) {
      if (day < oldest) {
        delete this.data.days[day];
        this.dirty = true;
      }
    }
    for (const day of Object.keys(this.data.guessed)) if (day < oldest) delete this.data.guessed[day];
    for (const [id, s] of Object.entries(this.data.seen)) {
      if (now - s.at > SEEN_MS) {
        delete this.data.seen[id];
        this.dirty = true;
      }
    }
  }

  /** The last CREDIT_DAYS days, today, the week and the top sessions over it. */
  summary(titleOf: (id: string) => string | undefined = () => undefined): FactoryCredits {
    const now = this.now();
    const d = this.data;
    const sinceDay = d.since ? dayKey(d.since) : '';
    const per = new Map<string, number>();
    const days = [];
    for (let i = CREDIT_DAYS - 1; i >= 0; i--) {
      // Noon of each day, so a daylight-saving hour never skips or repeats one.
      const t = new Date(now);
      t.setHours(12, 0, 0, 0);
      t.setDate(t.getDate() - i);
      const day = dayKey(t.getTime());
      let credits = 0;
      for (const [id, n] of Object.entries(d.days[day] ?? {})) {
        credits += n;
        per.set(id, (per.get(id) ?? 0) + n);
      }
      const guessed = Math.min(credits, d.guessed[day] ?? 0);
      days.push({ day, credits, guessed, estimated: !sinceDay || day < sinceDay || guessed > 0 });
    }
    const top = [...per.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP)
      .map(([id, credits]) => ({ id, title: titleOf(id) ?? d.seen[id]?.title ?? '', credits }));
    return { days, today: days[days.length - 1].credits, week: days.reduce((n, x) => n + x.credits, 0), since: d.since, top };
  }

  /** Writes the ledger if it changed: a temp file renamed into place. */
  save() {
    if (!this.dirty || !this.file) return;
    this.prune();
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
      renameSync(tmp, this.file);
      this.dirty = false;
    } catch (err) {
      console.error(`droid-office: couldn't save ${this.file}: ${(err as Error).message}`);
    }
  }

  /** Disconnected, or another account's key: what it counted belongs to the old one. */
  reset() {
    this.data = empty();
    this.dirty = false;
    if (this.file) rmSync(this.file, { force: true });
  }
}

/**
 * The terminal key report (Settings → Workers → Terminal key report): a short recording of what happened to each key on its
 * way from the keyboard to a worker's PTY, saved for an agent to read when a key such as Ctrl+Enter does nothing. Pure: the
 * page's listeners, the Mac app's trace and the office's file feed it.
 */

/** How long a recording runs when nobody stops it. */
export const KEY_REPORT_MS = 60_000;
/** Steps kept per recording; a held key can't grow it past this. */
export const KEY_REPORT_MAX_EVENTS = 4000;
/** The largest report the office takes. */
export const KEY_REPORT_MAX_BYTES = 2 * 1024 * 1024;
/** What the Mac app keeps of its own key trace while recording. */
export const KEY_TRACE_MAX_LINES = 5000;
/** Recent writes to a worker's PTY the office remembers, for the report. */
export const PTY_INPUT_LOG = 64;

/** Control characters spelled out, so a report shows `\e[13;5u` rather than an invisible escape. */
export function visibleBytes(data: string): string {
  let out = '';
  for (const ch of data) {
    const c = ch.codePointAt(0)!;
    if (ch === '\x1b') out += '\\e';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\\') out += '\\\\';
    else if (c < 0x20 || c === 0x7f) out += `\\x${c.toString(16).padStart(2, '0')}`;
    else out += ch;
  }
  return out;
}

export interface KeyReportEvent {
  /** Milliseconds since the recording started. */
  ms: number;
  /** Which step saw it: `dom.capture`, `xterm.key`, `xterm.data`, `screen`, … */
  step: string;
  [field: string]: unknown;
}

/** The steps of one recording, in order, with times relative to its start. */
export class KeyRecorder {
  private events: KeyReportEvent[] = [];
  private t0 = 0;
  private dropped = 0;
  active = false;

  start(now: number): void {
    this.events = [];
    this.dropped = 0;
    this.t0 = now;
    this.active = true;
  }

  add(step: string, fields: Record<string, unknown>, now: number): void {
    if (!this.active) return;
    if (this.events.length >= KEY_REPORT_MAX_EVENTS) {
      this.dropped++;
      return;
    }
    this.events.push({ ms: Math.round(now - this.t0), step, ...fields });
  }

  stop(now: number): { events: KeyReportEvent[]; ms: number; dropped: number } {
    this.active = false;
    const done = { events: this.events, ms: Math.round(now - this.t0), dropped: this.dropped };
    this.events = [];
    return done;
  }
}

/** The report's file name for a recording that ended at `at`. */
export function keyReportName(at: Date): string {
  return `terminal-keys-${at.toISOString().replace(/[:.]/g, '-')}.json`;
}

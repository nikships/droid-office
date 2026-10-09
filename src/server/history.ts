import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type headless from '@xterm/headless';
import type serialize from '@xterm/addon-serialize';
import { logicalLines, searchKey, snippet } from '../shared/search.js';

type HeadlessTerminal = InstanceType<typeof headless.Terminal>;
type Serializer = InstanceType<typeof serialize.SerializeAddon>;

/** Each droid's latest terminal output, kept in .droid-office/scrollback/<droid id>.ansi across restarts. */
export class ScrollbackStore {
  private dir: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'scrollback');
  }

  save(workerId: string, data: string) {
    const file = this.file(workerId);
    if (!file) return;
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      if (data) writeFileSync(file, data, { mode: 0o600 });
      else rmSync(file, { force: true });
    } catch {
      // disk issues shouldn't take the office down
    }
  }

  load(workerId: string): string | undefined {
    const file = this.file(workerId);
    try {
      return file && existsSync(file) ? readFileSync(file, 'utf8') : undefined;
    } catch {
      return undefined;
    }
  }

  remove(workerId: string) {
    const file = this.file(workerId);
    try {
      if (file) rmSync(file, { force: true });
    } catch {
      // already gone
    }
  }

  /** Deletes what's kept for droids that are no longer at a desk. */
  prune(keep: Set<string>) {
    try {
      for (const f of readdirSync(this.dir)) {
        if (f.endsWith('.ansi') && !keep.has(f.slice(0, -'.ansi'.length))) rmSync(path.join(this.dir, f), { force: true });
      }
    } catch {
      // no folder yet
    }
  }

  private file(workerId: string): string | undefined {
    return /^[\w-]{1,64}$/.test(workerId) ? path.join(this.dir, `${workerId}.ansi`) : undefined;
  }
}

/**
 * A terminal's last `maxLines` lines as escape codes that redraw them, colors and all, ending with
 * the cursor just after the last one. A full-screen program's screen (the alternate buffer) is
 * added as plain text, since it is not part of the scrollback.
 */
export function terminalTail(term: HeadlessTerminal, ser: Serializer, maxLines: number): string {
  const buf = term.buffer.normal;
  let last = buf.length - 1;
  while (last >= 0 && !buf.getLine(last)?.translateToString(true)) last--;
  let out = '';
  if (last >= 0) {
    let start = Math.max(0, last - maxLines + 1);
    // Don't start halfway through a line the terminal wrapped.
    while (start > 0 && buf.getLine(start)?.isWrapped) start--;
    out = `${ser.serialize({ range: { start, end: last }, excludeAltBuffer: true, excludeModes: true })}\x1b[0m`;
  }
  if (term.buffer.active.type === 'alternate') {
    const screen = logicalLines(term.buffer.alternate).map((l) => l.text.trimEnd());
    while (screen.length && !screen[screen.length - 1]) screen.pop();
    if (screen.length) out += `${out ? '\r\n' : ''}${screen.join('\r\n')}`;
  }
  return out;
}

/**
 * The lines of a droid's terminal holding `needle` (a searchKey), newest first, one per distinct
 * line: a full-screen program's screen first, then the scrollback.
 */
export function searchTerminal(term: HeadlessTerminal, needle: string, limit: number): { hits: { text: string; row: number; rows: number }[]; more: boolean } {
  const buffers = term.buffer.active.type === 'alternate' ? [term.buffer.alternate, term.buffer.normal] : [term.buffer.normal];
  const seen = new Set<string>();
  const hits: { text: string; row: number; rows: number }[] = [];
  for (const buf of buffers) {
    const lines = logicalLines(buf);
    for (let i = lines.length - 1; i >= 0; i--) {
      const key = searchKey(lines[i].text);
      // A TUI redraws the same line over and over (a status bar, a prompt box): show it once.
      if (!key.includes(needle) || seen.has(key)) continue;
      if (hits.length === limit) return { hits, more: true };
      seen.add(key);
      hits.push({ text: snippet(lines[i].text, needle), row: lines[i].row, rows: buf.length });
    }
  }
  return { hits, more: false };
}

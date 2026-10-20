import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import unicode11 from '@xterm/addon-unicode11';
import { OFFICE_SHELL_ID } from '../shared/office-shell.js';
import { DropStore } from './drops.js';
import { terminalTail } from './history.js';
import { type PtyHost, SCROLLBACK, type Pty } from './ptys.js';
import { screenSnapshot } from './screen.js';
import { snapshotScreen, type ScreenFrame } from './screen-frame.js';
import { childEnv, defaultShell } from './workers.js';

type HeadlessTerminal = InstanceType<typeof headless.Terminal>;
type Serializer = InstanceType<typeof serialize.SerializeAddon>;

const COLS = 100;
const ROWS = 30;
const SCREEN_INTERVAL_MS = 250;
const KEYFRAME_MS = 8000;
const SAVE_SCROLLBACK_MS = 15_000;
/** A shell that dies this soon was not a person typing `exit`: wait before starting another. */
const FAST_EXIT_MS = 1000;

export type ShellFrame = ScreenFrame;

/** What the office does with the boss shell's output. `screen` is the monitor; `data` is an open terminal. */
export interface ShellEvents {
  screen(frame: ShellFrame): void;
  data(data: string, connectionIds: string[]): void;
}

/**
 * The login shell on the boss's monitor. It is not a worker: nobody sits there, it is not in the
 * worker list and it does not count toward the worker limit. It runs in the floor's checkout for as
 * long as the floor does, and starts another shell when this one exits. An office restart picks the
 * same process back up from the terminal host, the way a shell worker's terminal is.
 */
export class OfficeShell {
  private pty?: Pty;
  private term?: HeadlessTerminal;
  private ser?: Serializer;
  private snapshot?: () => string;
  private cols = COLS;
  private rows = ROWS;
  private readonly subscribers = new Set<string>();
  private screenDirty = false;
  private lastLines: string[] = [];
  private keyframeAt = 0;
  private unsaved = false;
  private closing = false;
  private started = false;
  private spawnedAt = 0;
  private fails = 0;
  private restartTimer?: NodeJS.Timeout;
  private readonly screenTimer: NodeJS.Timeout;
  private readonly saveTimer: NodeJS.Timeout;
  private readonly statePath: string;
  private readonly scrollPath: string;
  private readonly drops: DropStore;

  constructor(
    private readonly dir: string,
    dataDir: string,
    private readonly host: PtyHost,
    private readonly events: ShellEvents,
  ) {
    this.statePath = path.join(dataDir, 'shell.json');
    this.scrollPath = path.join(dataDir, 'shell.ansi');
    this.drops = new DropStore(dataDir);
    this.screenTimer = setInterval(() => this.flush(), SCREEN_INTERVAL_MS);
    this.saveTimer = setInterval(() => {
      if (this.unsaved) this.saveScrollback();
    }, SAVE_SCROLLBACK_MS);
  }

  /** Claims a shell the host kept, or starts one. Call once the host is connected, before it drops unclaimed sessions. */
  async start() {
    if (this.started || this.closing) return;
    this.started = true;
    const saved = this.loadState();
    if (saved?.ptyId) {
      const adopted = await this.host.attach(saved.ptyId);
      if (adopted && !this.closing) {
        this.cols = adopted.cols || this.cols;
        this.rows = adopted.rows || this.rows;
        this.openTerm(adopted.snapshot);
        this.follow(adopted.pty);
        this.saveState();
        return;
      }
    }
    const before = this.loadScroll();
    this.spawn(before ? `${before}\r\n` : undefined);
  }

  /**
   * With `keep`, the process stays in the host for the next office. Otherwise it is ended.
   * Safe to call before start(), and more than once.
   */
  shutdown(keep: boolean) {
    if (this.closing) return;
    this.closing = true;
    clearInterval(this.screenTimer);
    clearInterval(this.saveTimer);
    clearTimeout(this.restartTimer);
    this.saveScrollback();
    if (keep && this.pty?.id) {
      this.saveState();
      this.pty = undefined;
      this.term?.dispose();
      return;
    }
    try {
      this.pty?.kill();
    } catch {
      // already gone
    }
    this.pty = undefined;
    this.term?.dispose();
    this.saveState();
  }

  /** The whole screen, for someone walking onto the floor. */
  fullScreen(): ShellFrame | null {
    if (!this.term) return null;
    const frame = snapshotScreen(this.term, []);
    return frame ? { ...frame, full: true } : null;
  }

  /** Subscribes one connection. `shared` means someone already had it open, so this window should take that size. */
  attach(clientId: string): { data: string; cols: number; rows: number; shared: boolean } | undefined {
    if (!this.snapshot || !this.term) return undefined;
    const shared = this.subscribers.size > 0;
    this.subscribers.add(clientId);
    return { data: this.snapshot(), cols: this.cols, rows: this.rows, shared };
  }

  detach(clientId: string) {
    this.subscribers.delete(clientId);
  }

  write(data: string) {
    this.pty?.write(data);
  }

  resize(cols: number, rows: number) {
    if (!this.pty || !this.term) return;
    cols = clamp(Math.floor(cols), 20, 400);
    rows = clamp(Math.floor(rows), 5, 200);
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    try {
      this.pty.resize(cols, rows);
      this.term.resize(cols, rows);
    } catch {
      // it may have exited between the checks
    }
    this.screenDirty = true;
    this.lastLines = [];
    this.saveState();
  }

  /** A file dropped or pasted into the open shell, kept for the shell to open by path. */
  drop(name: string, type: string, body: Buffer): string | undefined {
    return this.drops.save(OFFICE_SHELL_ID, name, type, body);
  }

  private spawn(prelude?: string) {
    if (this.closing) return;
    this.openTerm(prelude);
    const shell = defaultShell();
    const args = process.platform === 'win32' && !process.env.SHELL ? [] : ['-l'];
    const env = childEnv();
    env.TERM = 'xterm-256color';
    env.COLORTERM = 'truecolor';
    let proc: Pty;
    try {
      proc = this.host.spawn({ file: shell, args, cwd: this.dir, env, cols: this.cols, rows: this.rows, prelude });
    } catch (err) {
      this.fails++;
      this.note(`\r\n\x1b[31mFailed to start the shell: ${(err as Error).message}\x1b[0m\r\n`);
      this.restartTimer = setTimeout(() => this.respawn(), this.fails > 4 ? 10_000 : 2000);
      this.restartTimer.unref?.();
      return;
    }
    this.follow(proc);
    this.saveState();
  }

  private respawn() {
    if (this.closing) return;
    const before = this.term && this.ser ? terminalTail(this.term, this.ser, SCROLLBACK) : this.loadScroll();
    this.spawn(before ? `${before}\r\n` : undefined);
  }

  private openTerm(prelude?: string) {
    const term = new headless.Terminal({ cols: this.cols, rows: this.rows, scrollback: SCROLLBACK, allowProposedApi: true });
    const ser = new serialize.SerializeAddon();
    term.loadAddon(ser as any);
    term.loadAddon(new unicode11.Unicode11Addon() as any);
    term.unicode.activeVersion = '11';
    this.term?.dispose();
    this.term = term;
    this.ser = ser;
    this.snapshot = screenSnapshot(term, ser);
    this.lastLines = [];
    this.screenDirty = true;
    if (prelude) term.write(prelude);
  }

  private follow(proc: Pty) {
    this.pty = proc;
    this.spawnedAt = Date.now();
    proc.onData((data) => {
      this.term?.write(data);
      this.screenDirty = true;
      this.unsaved = true;
      this.fails = 0;
      if (this.subscribers.size) this.events.data(data, [...this.subscribers]);
    });
    proc.onExit(({ exitCode }) => {
      if (this.pty !== proc || this.closing) return;
      this.pty = undefined;
      const fast = Date.now() - this.spawnedAt < FAST_EXIT_MS;
      this.fails = fast ? this.fails + 1 : 0;
      this.note(`\r\n\x1b[2m[shell exited with code ${exitCode} — starting another]\x1b[0m\r\n`);
      const wait = this.fails > 4 ? 10_000 : fast ? FAST_EXIT_MS : 200;
      this.restartTimer = setTimeout(() => this.respawn(), wait);
      this.restartTimer.unref?.();
    });
  }

  /** Writes into the screen and, when someone has the terminal open, to them. */
  private note(text: string) {
    this.term?.write(text);
    this.screenDirty = true;
    this.unsaved = true;
    if (this.subscribers.size) this.events.data(text, [...this.subscribers]);
  }

  private flush() {
    if (!this.term) return;
    const now = Date.now();
    if (now - this.keyframeAt > KEYFRAME_MS) {
      this.keyframeAt = now;
      this.lastLines = [];
      this.screenDirty = true;
    }
    if (!this.screenDirty) return;
    this.screenDirty = false;
    const frame = snapshotScreen(this.term, this.lastLines);
    if (frame) this.events.screen(frame);
  }

  private saveState() {
    try {
      writeFileSync(this.statePath, JSON.stringify({ ptyId: this.pty?.id, cols: this.cols, rows: this.rows }), { mode: 0o600 });
    } catch {
      // disk trouble shouldn't take the floor down
    }
  }

  private loadState(): { ptyId?: string; cols?: number; rows?: number } | undefined {
    try {
      if (!existsSync(this.statePath)) return undefined;
      const saved = JSON.parse(readFileSync(this.statePath, 'utf8')) as { ptyId?: unknown; cols?: unknown; rows?: unknown };
      if (typeof saved.cols === 'number') this.cols = clamp(Math.floor(saved.cols), 20, 400);
      if (typeof saved.rows === 'number') this.rows = clamp(Math.floor(saved.rows), 5, 200);
      return { ptyId: typeof saved.ptyId === 'string' ? saved.ptyId : undefined, cols: this.cols, rows: this.rows };
    } catch {
      return undefined;
    }
  }

  private saveScrollback() {
    if (!this.term || !this.ser) return;
    this.unsaved = false;
    try {
      const data = terminalTail(this.term, this.ser, SCROLLBACK);
      if (data) writeFileSync(this.scrollPath, data, { mode: 0o600 });
      else rmSync(this.scrollPath, { force: true });
    } catch {
      // disk trouble shouldn't take the floor down
    }
  }

  private loadScroll(): string | undefined {
    try {
      return existsSync(this.scrollPath) ? readFileSync(this.scrollPath, 'utf8') : undefined;
    } catch {
      return undefined;
    }
  }
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

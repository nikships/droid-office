import type { ClientTerminal } from './term-engine/types';

interface Snapshot {
  data: string;
  cols: number;
  rows: number;
  shared?: boolean;
}
type Sink = Pick<ClientTerminal, 'reset' | 'resize' | 'write'>;

/** Async xterm writes stay ordered across snapshots, reconnects and disposal. Never retain an
 * unbounded stream while a snapshot is parsing; request a newer snapshot instead. */
export class TerminalMirror {
  ready = false;
  private generation = 0;
  private waiting = true;
  private pending: string[] = [];
  private bytes = 0;
  private visible = true;

  constructor(
    private term: Sink,
    private onReady: (snapshot: Snapshot) => void,
    private resnapshot: () => void,
  ) {}

  disconnect() {
    this.generation++;
    this.ready = false;
    this.waiting = true;
    this.pending = [];
    this.bytes = 0;
  }

  /** Hidden following terminals discard live parsing, then hydrate once from the authoritative PTY. */
  setVisible(visible: boolean) {
    if (visible === this.visible) return false;
    this.visible = visible;
    this.disconnect();
    if (visible) this.resnapshot();
    return true;
  }

  snapshot(snapshot: Snapshot) {
    if (!this.visible) return;
    this.disconnect();
    this.waiting = false;
    const generation = this.generation;
    // Drain old async writes *before* clearing them. Live data arriving meanwhile waits below.
    this.term.write('', () => {
      if (generation !== this.generation) return;
      this.term.reset();
      this.term.resize(snapshot.cols, snapshot.rows);
      this.term.write(snapshot.data, () => {
        if (generation !== this.generation) return;
        const flush = () => {
          if (generation !== this.generation) return;
          if (this.pending.length) {
            const data = this.pending.join('');
            this.pending = [];
            this.bytes = 0;
            this.term.write(data, flush);
            return;
          }
          this.ready = true;
          this.onReady(snapshot);
        };
        flush();
      });
    });
  }

  data(data: string) {
    if (this.waiting) return;
    if (this.ready) return this.term.write(data);
    this.pending.push(data);
    this.bytes += data.length;
    if (this.bytes > 1024 * 1024) {
      this.disconnect();
      this.resnapshot();
    }
  }
}

const FOCUS_IN = '\x1b[I';
const FOCUS_OUT = '\x1b[O';

/**
 * Sorts what xterm sends into typing, a focus report to forward, or a repeat to drop. xterm also
 * reports focus each time a program turns focus reporting on (DECSET 1004), and Droid turns it on
 * again whenever it regains focus. With several windows open, the focused one answers focus-in and
 * the others focus-out, which can bounce through the PTY without end, and each answer used to take
 * the PTY's size. Only a change in this window's own focus goes through; a window that never had
 * focus stays silent.
 */
export function focusReports() {
  let focused = false;
  return {
    classify(data: string): 'input' | 'focus' | 'repeat' {
      if (data !== FOCUS_IN && data !== FOCUS_OUT) return 'input';
      const now = data === FOCUS_IN;
      if (now === focused) return 'repeat';
      focused = now;
      return 'focus';
    },
    /**
     * A fresh snapshot: reports dropped while disconnected or loading never reached the program, so
     * start again from this window's own focus. Returns the focus-in to send when this window has
     * focus and the program asks for reports; an unfocused window stays silent.
     */
    reset(hasFocus = false, reporting = false): string | undefined {
      // Tracked as focused only once the program has heard so; with reporting off, the focus-in
      // xterm sends when it is turned on is the first the program hears.
      focused = hasFocus && reporting;
      return focused ? FOCUS_IN : undefined;
    },
  };
}

/** The server's headless terminal already answers TUI queries. A passive mirror must not send
 * duplicate replies through onData or seize PTY sizing merely by rendering a query. */
export function suppressMirrorQueries(term: Pick<ClientTerminal, 'parser'>) {
  const handlers = [
    ...['', '?', '>'].flatMap((prefix) => ['n', 'c'].map((final) => term.parser.registerCsiHandler({ ...(prefix ? { prefix } : {}), final }, () => true))),
    term.parser.registerCsiHandler({ prefix: '?', final: 'u' }, () => true),
    term.parser.registerCsiHandler({ prefix: '>', final: 'q' }, () => true),
    term.parser.registerCsiHandler({ intermediates: '$', final: 'p' }, () => true),
    term.parser.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, () => true),
    term.parser.registerCsiHandler({ final: 't' }, (params) => typeof params[0] === 'number' && params[0] >= 14),
    term.parser.registerDcsHandler({ intermediates: '$', final: 'q' }, () => true),
    ...[4, 10, 11, 12].map((n) => term.parser.registerOscHandler(n, (data) => data.includes('?'))),
  ];
  return () => handlers.forEach((handler) => handler.dispose());
}

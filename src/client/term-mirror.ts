import type { WTermAdapter } from './term-engine/wterm';

interface Snapshot {
  data: string;
  cols: number;
  rows: number;
  shared?: boolean;
}
type Sink = Pick<WTermAdapter, 'reset' | 'resize' | 'write'> & Partial<Pick<WTermAdapter, 'holdSnapshot'>>;

/** Terminal writes stay ordered across snapshots, reconnects and disposal. Never retain an
 * unbounded stream while a snapshot is parsing; request a newer snapshot instead. */
export class TerminalMirror {
  ready = false;
  private generation = 0;
  private cancelHold?: () => void;
  private waiting = true;
  private pending: string[] = [];
  private bytes = 0;
  private visible = true;

  constructor(
    private term: Sink,
    private onReady: (snapshot: Snapshot) => void,
    private resnapshot: () => void,
    private inputReady?: (ready: boolean) => void,
  ) {}

  disconnect() {
    this.generation++;
    this.cancelHold?.();
    this.cancelHold = undefined;
    this.ready = false;
    this.inputReady?.(false);
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
    this.cancelHold = this.term.holdSnapshot?.();
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
          this.cancelHold = undefined;
          this.inputReady?.(true);
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

/** Real focus transitions are not keystrokes and never take ownership of the PTY size. */
export function isFocusReport(data: string): boolean {
  return data === FOCUS_IN || data === FOCUS_OUT;
}

/** Replay lost any live focus transition: reassert focus only if the program requested it. */
export function snapshotFocusReport(hasFocus: boolean, reporting: boolean): string | undefined {
  return hasFocus && reporting ? FOCUS_IN : undefined;
}

/** The server's headless terminal already answers TUI queries. A passive mirror must not send
 * duplicate replies through onData or seize PTY sizing merely by rendering a query. */
export function suppressMirrorQueries(term: Pick<WTermAdapter, 'parser'>) {
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

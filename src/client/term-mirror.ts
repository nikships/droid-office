import type { Terminal } from '@xterm/xterm';

interface Snapshot {
  data: string;
  cols: number;
  rows: number;
  shared?: boolean;
}
type Sink = Pick<Terminal, 'reset' | 'resize' | 'write'>;

/** Async xterm writes stay ordered across snapshots, reconnects and disposal. Never retain an
 * unbounded stream while a snapshot is parsing; request a newer snapshot instead. */
export class TerminalMirror {
  ready = false;
  private generation = 0;
  private waiting = true;
  private pending: string[] = [];
  private bytes = 0;

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

  snapshot(snapshot: Snapshot) {
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
        this.ready = true;
        for (const data of this.pending) this.term.write(data);
        this.pending = [];
        this.bytes = 0;
        this.onReady(snapshot);
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

/** The server's headless terminal already answers TUI queries. A passive mirror must not send
 * duplicate replies through onData or seize PTY sizing merely by rendering a query. */
export function suppressMirrorQueries(term: Pick<Terminal, 'parser'>) {
  const handlers = [
    ...['', '?', '>'].flatMap((prefix) => ['n', 'c'].map((final) => term.parser.registerCsiHandler({ ...(prefix ? { prefix } : {}), final }, () => true))),
    term.parser.registerCsiHandler({ intermediates: '$', final: 'p' }, () => true),
    term.parser.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, () => true),
    term.parser.registerCsiHandler({ final: 't' }, (params) => typeof params[0] === 'number' && params[0] >= 14),
    term.parser.registerDcsHandler({ intermediates: '$', final: 'q' }, () => true),
    ...[4, 10, 11, 12].map((n) => term.parser.registerOscHandler(n, (data) => data.includes('?'))),
  ];
  return () => handlers.forEach((handler) => handler.dispose());
}

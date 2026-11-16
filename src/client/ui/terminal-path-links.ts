import type { IBuffer, ILink, ILinkHandler, ITerminalAddon, Terminal } from '@xterm/xterm';
import { parseTerminalPathRefs, terminalPathRef, type WorkspacePathMatch, type WorkspacePathRef } from '../../shared/path-links';
import { withToken } from '../token';
import { toast } from './dom';
import { openFilePreviewModal } from './file-preview';

interface Position {
  x: number;
  y: number;
}

interface LookupResult {
  paths: (WorkspacePathRef | null)[];
  local: boolean;
}

/** Read a soft-wrapped logical line, mapping UTF-16 offsets back to xterm's actual cell widths. */
export function terminalLogicalLine(buffer: IBuffer, row: number, cols: number): { text: string; cells: Position[] } {
  let first = row - 1;
  while (first > 0 && row - first < 16 && buffer.getLine(first)?.isWrapped) first--;
  let text = '';
  const cells: Position[] = [];
  for (let y = first; y < buffer.length && y < first + 16; y++) {
    if (y > first && !buffer.getLine(y)?.isWrapped) break;
    const line = buffer.getLine(y);
    if (!line) break;
    const wrappedNext = buffer.getLine(y + 1)?.isWrapped;
    const length = wrappedNext ? Number.POSITIVE_INFINITY : line.translateToString(true).length;
    let offset = 0;
    for (let x = 0; x < cols && offset < length; x++) {
      const cell = line.getCell(x);
      if (!cell || cell.getWidth() === 0) continue;
      const chars = cell.getChars() || ' ';
      text += chars;
      for (let i = 0; i < chars.length; i++) cells.push({ x: x + 1, y: y + 1 });
      offset += chars.length;
    }
  }
  return { text, cells };
}

export class TerminalPathLinksAddon implements ITerminalAddon {
  private readonly controller = new AbortController();
  private provider?: { dispose(): void };
  private readonly cache = new Map<string, { at: number; value?: LookupResult; pending: Promise<LookupResult> }>();

  /** Unifies OSC 8 hyperlinks (`file://` and `http(s)://`) with modifier-gated terminal links. */
  readonly linkHandler: ILinkHandler = {
    allowNonHttpProtocols: true,
    activate: (event, text) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (/^https?:\/\//i.test(text)) {
        event.preventDefault();
        window.open(text, '_blank', 'noopener,noreferrer');
        return;
      }
      if (!terminalPathRef(text)) return;
      event.preventDefault();
      void this.lookup(`${this.floor()}\0osc8\0${text}`, [text])
        .then(({ paths, local }) => {
          const resolved = paths[0];
          if (resolved) this.openResolved(text, resolved, local);
        })
        .catch((error: unknown) => {
          if (!this.controller.signal.aborted) toast(error instanceof Error ? error.message : 'Could not open file.', 'error');
        });
    },
  };

  constructor(private readonly context: { floor: string | (() => string); workerId: string; workerName?: string }) {}

  private floor(): string {
    return typeof this.context.floor === 'function' ? this.context.floor() : this.context.floor;
  }

  private url(route: string): string {
    return withToken(`${route}?${new URLSearchParams({ floor: this.floor(), worker: this.context.workerId })}`);
  }

  private openResolved(raw: string, resolved: WorkspacePathRef, local: boolean): void {
    if (!local) {
      openFilePreviewModal({
        floor: this.floor(),
        workerId: this.context.workerId,
        workerName: this.context.workerName,
        source: 'terminal',
        path: resolved.displayPath ?? resolved.path,
        requestPath: raw,
        line: resolved.line,
        endLine: resolved.endLine,
      });
      return;
    }
    void fetch(this.url('/api/term/path/open'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: [raw] }),
      signal: this.controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error ?? 'Could not open file.');
      })
      .catch((error: unknown) => {
        if (!this.controller.signal.aborted) toast(error instanceof Error ? error.message : 'Could not open file.', 'error');
      });
  }

  private lookup(key: string, paths: string[]): Promise<LookupResult> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 5000) return hit.pending;
    const entry: { at: number; value?: LookupResult; pending: Promise<LookupResult> } = {
      at: Date.now(),
      pending: Promise.resolve({ paths: [], local: false }),
    };
    entry.pending = fetch(this.url('/api/term/paths'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths }),
      signal: this.controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error('Could not resolve terminal paths.');
      const value = (await response.json()) as LookupResult;
      entry.value = value;
      return value;
    });
    if (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, entry);
    return entry.pending;
  }

  private buildLinks(row: number, line: { cells: Position[] }, candidates: WorkspacePathMatch[], { paths, local }: LookupResult): ILink[] {
    const links: ILink[] = [];
    candidates.forEach((candidate, index) => {
      const resolved = paths[index];
      const start = line.cells[candidate.start];
      const end = line.cells[candidate.end - 1];
      if (!resolved || !start || !end || row < start.y || row > end.y) return;
      links.push({
        text: candidate.raw,
        range: { start, end },
        activate: (event) => {
          if (!(event.metaKey || event.ctrlKey)) return;
          event.preventDefault();
          this.openResolved(candidate.raw, resolved, local);
        },
      });
    });
    return links;
  }

  activate(term: Terminal): void {
    this.provider = term.registerLinkProvider({
      provideLinks: (row, callback) => {
        const buffer = term.buffer.active;
        const line = terminalLogicalLine(buffer, row, term.cols);
        const candidates = parseTerminalPathRefs(line.text).slice(0, 64);
        if (!candidates.length) return callback(undefined);
        const key = `${this.floor()}\n${line.text}`;
        const hit = this.cache.get(key);
        if (hit && Date.now() - hit.at < 5000 && hit.value) {
          return callback(this.buildLinks(row, line, candidates, hit.value));
        }
        void this.lookup(
          key,
          candidates.map((candidate) => candidate.raw),
        )
          .then((result) => {
            if (this.controller.signal.aborted || buffer !== term.buffer.active || terminalLogicalLine(buffer, row, term.cols).text !== line.text) return callback(undefined);
            callback(this.buildLinks(row, line, candidates, result));
          })
          .catch(() => callback(undefined));
      },
    });
  }

  dispose(): void {
    this.controller.abort();
    this.provider?.dispose();
    this.cache.clear();
  }
}

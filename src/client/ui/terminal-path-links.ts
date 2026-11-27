import { terminalPathRef, type WorkspacePathRef } from '../../shared/path-links';
import { guestTokenOn, withToken } from '../token';
import { toast } from './dom';
import { openFilePreviewModal } from './file-preview';

interface LookupResult {
  paths: (WorkspacePathRef | null)[];
  local: boolean;
}

export class TerminalPaths {
  private readonly controller = new AbortController();
  private readonly cache = new Map<string, { at: number; pending: Promise<LookupResult> }>();

  constructor(private readonly context: { floor: string | (() => string); workerId: string; workerName?: string; inert?: boolean }) {}

  private floor(): string {
    return typeof this.context.floor === 'function' ? this.context.floor() : this.context.floor;
  }

  /** A cell-based client already knows the candidate under the pointer. Confirm just
   * that target, so unrelated text changes do not invalidate its pending activation. */
  async resolveTarget(raw: string, osc8: boolean): Promise<(() => void) | undefined> {
    if (this.context.inert || !terminalPathRef(raw)) return;
    const key = `${this.floor()}\0${osc8 ? 'osc8' : 'path'}\0${raw}`;
    const { paths, local } = await this.lookup(key, [raw]);
    const resolved = paths[0];
    if (resolved && !this.controller.signal.aborted) return () => this.openResolved(raw, resolved, local);
  }

  private url(route: string): string {
    return withToken(`${route}?${new URLSearchParams({ floor: this.floor(), worker: this.context.workerId })}`);
  }

  private openResolved(raw: string, resolved: WorkspacePathRef, local: boolean): void {
    // A share link's guest is never on the office's computer: its files open as a preview.
    if (!local || guestTokenOn()) {
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
        const body = (await response.json().catch(() => ({}))) as { error?: string; revealed?: boolean };
        if (!response.ok) throw new Error(body.error ?? 'Could not open file.');
        if (body.revealed) toast('Revealed in Finder');
      })
      .catch((error: unknown) => {
        if (!this.controller.signal.aborted) toast(error instanceof Error ? error.message : 'Could not open file.', 'error');
      });
  }

  private lookup(key: string, paths: string[]): Promise<LookupResult> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 5000) return hit.pending;
    const entry: { at: number; pending: Promise<LookupResult> } = {
      at: Date.now(),
      pending: fetch(this.url('/api/term/paths'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paths }),
        signal: this.controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) throw new Error('Could not resolve terminal paths.');
          const value = (await response.json()) as LookupResult;
          if (!value || !Array.isArray(value.paths) || value.paths.length !== paths.length) throw new Error('Could not resolve terminal paths.');
          return value;
        })
        .catch((error: unknown) => {
          this.cache.delete(key);
          throw error;
        }),
    };
    if (this.cache.size >= 128) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, entry);
    return entry.pending;
  }

  dispose(): void {
    this.controller.abort();
    this.cache.clear();
  }
}

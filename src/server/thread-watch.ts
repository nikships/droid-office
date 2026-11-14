import { existsSync, watch as fsWatch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { ORCHESTRATOR_ID } from '../shared/mission-control.js';
import type { ServerMsg } from '../shared/protocol.js';
import type { ThreadPage, ThreadSession, WorkerThreadReader } from './worker-thread.js';

export type ThreadPushMsg = Extract<ServerMsg, { t: 'thread.snapshot' }>;

export interface WatchedThreadTarget {
  kind: 'local' | 'cloud';
  floorId: string | null;
  busy: boolean;
  local?: ThreadSession;
}

export interface ThreadWatchOptions {
  workerThreads: Pick<WorkerThreadReader, 'read' | 'sessionPaths' | 'sessionPathsSync'>;
  resolveWorker(workerId: string): WatchedThreadTarget | undefined;
  readCloud?(workerId: string): Promise<ThreadPage> | undefined;
  send(clientId: string, msg: ThreadPushMsg): void;
  localCoalesceMs?: number;
  cloudCoalesceMs?: number;
  maxWatchesPerClient?: number;
}

interface WorkerWatch {
  workerId: string;
  clients: Set<string>;
  kind?: 'local' | 'cloud';
  sessionKey?: string;
  targetFileName?: string;
  filePath?: string;
  fileWatcher?: FSWatcher;
  dirPath?: string;
  dirWatcher?: FSWatcher;
  timer?: NodeJS.Timeout;
  reading: boolean;
  again: boolean;
  closed: boolean;
  lastDigest?: string;
}

function sessionKeyOf(target: WatchedThreadTarget): string {
  if (target.kind === 'cloud') return 'cloud';
  const s = target.local;
  if (!s) return 'local:none';
  return `local:${s.sessionId}\0${s.cwd}\0${s.since ?? 0}\0${s.transcript ?? ''}`;
}

export function threadPageDigest(page: ThreadPage, busy: boolean): string {
  const parts = [page.sessionId ?? '', busy ? '1' : '0', page.hasMore ? '1' : '0', page.error ?? '', String(page.entries.length)];
  for (const e of page.entries) {
    const tail = (e.output ?? e.text ?? '').slice(-24);
    parts.push(`${e.id}:${e.seq}:${e.text?.length ?? -1}:${e.input?.length ?? -1}:${e.output?.length ?? -1}:${e.error ? 1 : 0}:${e.resultSeq ?? -1}:${e.images?.length ?? 0}:${tail}`);
  }
  return parts.join('|');
}

export class ThreadWatchHub {
  private byWorker = new Map<string, WorkerWatch>();
  private byClient = new Map<string, Set<string>>();
  private readonly localCoalesceMs: number;
  private readonly cloudCoalesceMs: number;
  private readonly maxPerClient: number;
  private stopped = false;

  constructor(private readonly opts: ThreadWatchOptions) {
    this.localCoalesceMs = opts.localCoalesceMs ?? 60;
    this.cloudCoalesceMs = opts.cloudCoalesceMs ?? 50;
    this.maxPerClient = opts.maxWatchesPerClient ?? 16;
  }

  watch(clientId: string, workerId: string, on: boolean): boolean {
    if (this.stopped || !clientId || !workerId) return false;
    if (!on) {
      this.removeSubscription(clientId, workerId);
      return true;
    }
    const target = this.opts.resolveWorker(workerId);
    if (!target) {
      this.removeSubscription(clientId, workerId);
      return false;
    }

    let clientSet = this.byClient.get(clientId);
    if (!clientSet) {
      clientSet = new Set();
      this.byClient.set(clientId, clientSet);
    }
    if (clientSet.has(workerId)) {
      clientSet.delete(workerId);
      clientSet.add(workerId);
    } else {
      while (clientSet.size >= this.maxPerClient) {
        const oldest = clientSet.values().next().value;
        if (!oldest) break;
        this.removeSubscription(clientId, oldest);
      }
      clientSet.add(workerId);
    }

    let entry = this.byWorker.get(workerId);
    if (!entry) {
      entry = {
        workerId,
        clients: new Set(),
        reading: false,
        again: false,
        closed: false,
      };
      this.byWorker.set(workerId, entry);
    }
    entry.clients.add(clientId);
    this.refreshBinding(entry, target, false);
    return true;
  }

  /** Records the latest hydrated page from `thread.read` so an unchanged wake never pushes a duplicate snapshot. */
  seed(workerId: string, page: ThreadPage, busy: boolean): void {
    const entry = this.byWorker.get(workerId);
    if (!entry || entry.closed || page.error) return;
    entry.lastDigest ??= threadPageDigest(page, busy);
  }

  /** Wakes watchers on worker status/turn/session transitions or CloudStream deltas. */
  notifyWorker(workerId: string): void {
    if (this.stopped) return;
    const entry = this.byWorker.get(workerId);
    if (!entry || entry.closed || !entry.clients.size) return;
    const target = this.opts.resolveWorker(workerId);
    if (!target) {
      this.unwatchWorker(workerId);
      return;
    }
    this.refreshBinding(entry, target, true);
    this.schedule(entry, target.kind === 'cloud' ? this.cloudCoalesceMs : this.localCoalesceMs);
  }

  unwatchClient(clientId: string, keepOrchestrator = false): void {
    const set = this.byClient.get(clientId);
    if (!set) return;
    for (const workerId of [...set]) {
      if (keepOrchestrator && workerId === ORCHESTRATOR_ID) continue;
      this.removeSubscription(clientId, workerId);
    }
  }

  unwatchWorker(workerId: string): void {
    const entry = this.byWorker.get(workerId);
    if (!entry) return;
    for (const clientId of entry.clients) {
      const set = this.byClient.get(clientId);
      if (set) {
        set.delete(workerId);
        if (!set.size) this.byClient.delete(clientId);
      }
    }
    this.teardown(entry);
    this.byWorker.delete(workerId);
  }

  watchedCount(clientId?: string): number {
    if (clientId !== undefined) return this.byClient.get(clientId)?.size ?? 0;
    return this.byWorker.size;
  }

  close(): void {
    this.stopped = true;
    for (const entry of this.byWorker.values()) this.teardown(entry);
    this.byWorker.clear();
    this.byClient.clear();
  }

  private removeSubscription(clientId: string, workerId: string): void {
    const set = this.byClient.get(clientId);
    if (set) {
      set.delete(workerId);
      if (!set.size) this.byClient.delete(clientId);
    }
    const entry = this.byWorker.get(workerId);
    if (!entry) return;
    entry.clients.delete(clientId);
    if (!entry.clients.size) {
      this.teardown(entry);
      this.byWorker.delete(workerId);
    }
  }

  private refreshBinding(entry: WorkerWatch, target: WatchedThreadTarget, wakeOnRebind: boolean): void {
    const key = sessionKeyOf(target);
    const changedSession = entry.sessionKey !== undefined && entry.sessionKey !== key;
    if (changedSession) {
      this.closeWatchers(entry);
      entry.lastDigest = undefined;
    }
    entry.kind = target.kind;
    entry.sessionKey = key;

    if (target.kind !== 'local' || !target.local) {
      this.closeWatchers(entry);
      return;
    }

    entry.targetFileName = `${target.local.sessionId}.jsonl`;
    const syncPaths = this.opts.workerThreads.sessionPathsSync(target.local);
    if (syncPaths) this.applyPaths(entry, syncPaths);

    const expectedKey = key;
    void this.opts.workerThreads.sessionPaths(target.local).then((resolved) => {
      if (entry.closed || !entry.clients.size || entry.sessionKey !== expectedKey || !resolved) return;
      const rebound = this.applyPaths(entry, resolved);
      if (rebound && wakeOnRebind) this.schedule(entry, this.localCoalesceMs);
    });
  }

  private applyPaths(entry: WorkerWatch, paths: { file?: string; dir: string; root: string }): boolean {
    let changed = false;
    const wantDir = existsSync(paths.dir) ? paths.dir : existsSync(paths.root) ? paths.root : existsSync(path.dirname(paths.root)) ? path.dirname(paths.root) : undefined;
    if (entry.dirPath !== wantDir) {
      this.closeDirWatcher(entry);
      if (wantDir) {
        try {
          const w = fsWatch(wantDir, (_event, filename) => {
            if (entry.closed) return;
            const name = typeof filename === 'string' ? filename : undefined;
            if (wantDir === paths.dir && name && entry.targetFileName && name !== entry.targetFileName) return;
            this.schedule(entry, this.localCoalesceMs);
          });
          w.on('error', () => {
            this.closeDirWatcher(entry);
            this.schedule(entry, this.localCoalesceMs);
          });
          w.unref?.();
          entry.dirWatcher = w;
          entry.dirPath = wantDir;
          changed = true;
        } catch {
          // Directory disappeared mid-bind; next notification or parent wake retries.
        }
      }
    }

    const wantFile = paths.file && existsSync(paths.file) ? paths.file : undefined;
    if (entry.filePath !== wantFile) {
      this.closeFileWatcher(entry);
      if (wantFile) {
        try {
          const w = fsWatch(wantFile, (event) => {
            if (entry.closed) return;
            if (event === 'rename') this.closeFileWatcher(entry);
            this.schedule(entry, this.localCoalesceMs);
          });
          w.on('error', () => {
            this.closeFileWatcher(entry);
            this.schedule(entry, this.localCoalesceMs);
          });
          w.unref?.();
          entry.fileWatcher = w;
          entry.filePath = wantFile;
          changed = true;
        } catch {
          // File disappeared mid-bind; directory watcher will catch recreation.
        }
      }
    }

    return changed;
  }

  private schedule(entry: WorkerWatch, delayMs: number): void {
    if (this.stopped || entry.closed || !entry.clients.size) return;
    if (entry.timer) return;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void this.flush(entry);
    }, delayMs);
    entry.timer.unref?.();
  }

  private async flush(entry: WorkerWatch): Promise<void> {
    if (this.stopped || entry.closed || !entry.clients.size) return;
    if (entry.reading) {
      entry.again = true;
      return;
    }
    entry.reading = true;
    let nextDelay = this.localCoalesceMs;
    try {
      const target = this.opts.resolveWorker(entry.workerId);
      if (!target) {
        this.unwatchWorker(entry.workerId);
        return;
      }
      nextDelay = target.kind === 'cloud' ? this.cloudCoalesceMs : this.localCoalesceMs;
      const key = sessionKeyOf(target);
      if (entry.sessionKey !== key) {
        this.closeWatchers(entry);
        entry.lastDigest = undefined;
        entry.sessionKey = key;
        entry.kind = target.kind;
      }

      if (target.kind === 'local') {
        if (!target.local) {
          this.closeWatchers(entry);
          return;
        }
        entry.targetFileName = `${target.local.sessionId}.jsonl`;
        const paths = await this.opts.workerThreads.sessionPaths(target.local);
        if (this.stopped || entry.closed || !entry.clients.size) return;
        if (paths) this.applyPaths(entry, paths);
        const page = await this.opts.workerThreads.read(target.local, undefined, target.busy);
        if (this.stopped || entry.closed || !entry.clients.size) return;
        const after = this.opts.resolveWorker(entry.workerId);
        if (!after || sessionKeyOf(after) !== key) {
          entry.again = true;
          return;
        }
        if (page.error && entry.lastDigest === undefined) return;
        const digest = threadPageDigest(page, after.busy);
        if (digest === entry.lastDigest) return;
        entry.lastDigest = digest;
        this.push(entry, page);
        return;
      }

      const page = await this.opts.readCloud?.(entry.workerId);
      if (!page || this.stopped || entry.closed || !entry.clients.size) return;
      const after = this.opts.resolveWorker(entry.workerId);
      if (after?.kind !== 'cloud') return;
      if (page.error && entry.lastDigest === undefined) return;
      const digest = threadPageDigest(page, after.busy);
      if (digest === entry.lastDigest) return;
      entry.lastDigest = digest;
      this.push(entry, page);
    } finally {
      entry.reading = false;
      if (entry.again && !this.stopped && !entry.closed && entry.clients.size) {
        entry.again = false;
        this.schedule(entry, nextDelay);
      }
    }
  }

  private push(entry: WorkerWatch, page: ThreadPage): void {
    const msg: ThreadPushMsg = {
      t: 'thread.snapshot',
      workerId: entry.workerId,
      request: 'push',
      push: true,
      ...page,
    };
    for (const clientId of entry.clients) {
      this.opts.send(clientId, msg);
    }
  }

  private closeFileWatcher(entry: WorkerWatch): void {
    if (entry.fileWatcher) {
      try {
        entry.fileWatcher.close();
      } catch {
        // already closed
      }
      entry.fileWatcher = undefined;
    }
    entry.filePath = undefined;
  }

  private closeDirWatcher(entry: WorkerWatch): void {
    if (entry.dirWatcher) {
      try {
        entry.dirWatcher.close();
      } catch {
        // already closed
      }
      entry.dirWatcher = undefined;
    }
    entry.dirPath = undefined;
  }

  private closeWatchers(entry: WorkerWatch): void {
    this.closeFileWatcher(entry);
    this.closeDirWatcher(entry);
  }

  private teardown(entry: WorkerWatch): void {
    entry.closed = true;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    this.closeWatchers(entry);
    entry.clients.clear();
  }
}

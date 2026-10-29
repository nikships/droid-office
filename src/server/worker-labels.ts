import { createHash } from 'node:crypto';
import type { WorkerStatus, WorkerTask } from '../shared/protocol.js';
import { isBusy } from '../shared/status.js';
import type { WorkerLabelSettings, WorkerLabelState } from '../shared/worker-labels.js';
import { LabelModelError, type LabelInput } from './worker-label-model.js';
import type { ThreadSession } from './worker-thread.js';

export interface LabelWorker extends ThreadSession {
  id: string;
  epoch: number;
  status: WorkerStatus;
  task?: WorkerTask;
  apply: (task: WorkerTask) => void;
}

interface Tracked {
  identity: string;
  status: WorkerStatus;
  hash?: string;
  attemptedAt: number;
  retryAt: number;
  failures: number;
  finalUntil: number;
}

interface Job {
  worker: LabelWorker;
  tracked: Tracked;
  text: string;
  hash: string;
}

interface LabelOptions {
  settings: () => WorkerLabelSettings;
  workers: () => LabelWorker[];
  read: (source: ThreadSession) => Promise<string | undefined>;
  generate: (input: LabelInput, settings: WorkerLabelSettings, signal: AbortSignal) => Promise<WorkerTask>;
  changed: (state: WorkerLabelState) => void;
  now?: () => number;
}

const identity = (w: LabelWorker) => JSON.stringify([w.sessionId, w.cwd, w.epoch, w.since ?? 0]);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

/** One fair queue and two calls at most across every floor, not two per WorkerManager. */
export class WorkerLabels {
  private tracked = new Map<string, Tracked>();
  private queue = new Map<string, Job>();
  private running = new Map<string, AbortController>();
  private jobs = new Set<Promise<void>>();
  private timer?: NodeJS.Timeout;
  private scanning = false;
  private stopped = false;
  private revision = 0;
  private error?: string;
  private updatedAt?: number;

  constructor(private options: LabelOptions) {}

  state(): WorkerLabelState {
    return { settings: this.options.settings(), running: this.running.size, queued: this.queue.size, error: this.error, updatedAt: this.updatedAt };
  }

  start() {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.tick(), 2000);
    this.timer.unref();
    void this.tick();
  }

  settingsChanged() {
    this.revision++;
    this.queue.clear();
    this.tracked.clear();
    for (const call of this.running.values()) call.abort();
    this.error = undefined;
    this.publish();
    void this.tick();
  }

  stop(): Promise<void> {
    this.stopped = true;
    this.revision++;
    clearInterval(this.timer);
    this.queue.clear();
    this.tracked.clear();
    for (const call of this.running.values()) call.abort();
    return Promise.allSettled([...this.jobs]).then(() => {});
  }

  async tick(): Promise<void> {
    if (this.scanning || this.stopped || !this.options.settings().on) return;
    this.scanning = true;
    const revision = this.revision;
    try {
      const workers = this.options.workers();
      const present = new Set(workers.map((w) => w.id));
      for (const id of this.tracked.keys()) {
        if (present.has(id)) continue;
        this.tracked.delete(id);
        this.queue.delete(id);
        this.running.get(id)?.abort();
      }
      for (const worker of workers) {
        if (this.stopped || revision !== this.revision) return;
        const now = this.now();
        let tracked = this.tracked.get(worker.id);
        if (!tracked || tracked.identity !== identity(worker)) {
          this.running.get(worker.id)?.abort();
          this.queue.delete(worker.id);
          tracked = { identity: identity(worker), status: worker.status, hash: worker.task?.generated ? worker.task.textHash : undefined, attemptedAt: -Infinity, retryAt: 0, failures: 0, finalUntil: 0 };
          this.tracked.set(worker.id, tracked);
        }
        if (isBusy(tracked.status) && !isBusy(worker.status)) tracked.finalUntil = now + 15_000;
        tracked.status = worker.status;
        if (this.running.has(worker.id) || now < tracked.retryAt) continue;
        const text = await this.options.read(worker);
        if (!text || this.stopped || revision !== this.revision) continue;
        const digest = hash(text);
        if (digest === tracked.hash) {
          this.queue.delete(worker.id);
          continue;
        }
        if (now - tracked.attemptedAt < this.options.settings().intervalSeconds * 1000 && now > tracked.finalUntil) continue;
        this.queue.set(worker.id, { worker, tracked, text, hash: digest });
      }
    } catch {
      this.error = 'The local conversation could not be read. Worker labels will retry.';
    } finally {
      this.scanning = false;
      this.pump();
      this.publish();
    }
  }

  private pump() {
    if (this.stopped || !this.options.settings().on) return;
    for (const [id, job] of this.queue) {
      if (this.running.size >= 2) break;
      if (this.running.has(id)) continue;
      this.queue.delete(id);
      const current = this.options.workers().find((w) => w.id === id);
      if (!current || identity(current) !== job.tracked.identity) continue;
      const controller = new AbortController();
      this.running.set(id, controller);
      job.tracked.attemptedAt = this.now();
      const revision = this.revision;
      const work = this.run(job, controller, revision).finally(() => {
        this.running.delete(id);
        this.jobs.delete(work);
        this.pump();
        this.publish();
      });
      this.jobs.add(work);
    }
  }

  private async run(job: Job, controller: AbortController, revision: number) {
    try {
      const task = await this.options.generate({ text: job.text, previousSubject: job.worker.task?.generated ? job.worker.task.name : undefined }, this.options.settings(), controller.signal);
      if (this.stopped || controller.signal.aborted || revision !== this.revision) return;
      const current = this.options.workers().find((w) => w.id === job.worker.id);
      if (!current || identity(current) !== job.tracked.identity) return;
      const latest = await this.options.read(current);
      if (this.stopped || controller.signal.aborted || revision !== this.revision || latest === undefined) return;
      // Resolve again after the async read: a worker may have been removed, cleared or replaced.
      const target = this.options.workers().find((w) => w.id === job.worker.id);
      if (!target || identity(target) !== job.tracked.identity) return;
      target.apply({ ...task, generated: true, textHash: job.hash });
      // New text during inference waits for the next refresh. Discarding every such result
      // would starve a chatty worker of labels while still charging for every call.
      job.tracked.hash = job.hash;
      job.tracked.failures = 0;
      job.tracked.retryAt = 0;
      this.updatedAt = this.now();
      this.error = undefined;
    } catch (error) {
      if (this.stopped || controller.signal.aborted || revision !== this.revision) return;
      job.tracked.failures++;
      job.tracked.retryAt = this.now() + Math.min(10 * 60_000, 60_000 * 2 ** Math.min(4, job.tracked.failures - 1));
      this.error = error instanceof LabelModelError ? error.message : 'Worker label generation failed. Keeping the last successful labels.';
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private publish() {
    if (!this.stopped) this.options.changed(this.state());
  }
}

import { withImages } from '../../shared/drops.js';
import { CTRL_ENTER, wantsCsiEnter } from '../../shared/csi-enter.js';
import { readDroidPending, showsAs } from '../../shared/droid-queue.js';
import { withoutReminders } from '../../shared/prompts.js';
import { clearDroidPendingAll, driveDroidQueueItem, resolveWorkerQueue, type QueuedMessageItem, type ResolvedQueueItem, type WorkerQueueState } from '../worker-queue.js';
import type { DropStore } from '../drops.js';
import { readDroidScreen, type DroidScreen } from '../droid-screen.js';
import { screenRows, type Worker } from './state.js';
import { HOOK_VERSION } from './hook-transport.js';
import { truncate } from './activity.js';

interface DeliveryContext {
  get(id: string): Worker | undefined;
  closing(): boolean;
  persist(): void;
  update(worker: Worker): void;
  notePrompt(worker: Worker, text: string): void;
  resume(id: string, text: string): string | undefined;
  drops: Pick<DropStore, 'adopt'>;
}

/** How long the owner's typing holds back office notices typed in once a worker comes to rest. */
const NOTICE_TYPING_MS = 5000;

/** Owns prompt submission, queue edits and notice delivery, including partial-delivery rollback. */
export class WorkerDelivery {
  constructor(private context: DeliveryContext) {}

  cancelTurn(id: string): boolean {
    const w = this.context.get(id);
    if (!w?.pty || !w.term || w.info.kind !== 'agent' || w.info.status !== 'working') return false;
    if (readDroidScreen(screenRows(w.term)) !== 'busy') return false;
    w.pty.write('\x1b');
    w.cancelAt = Date.now();
    return true;
  }

  /** What a Droid agent's screen shows now: busy on a turn, asking, or at rest (see droid-screen.ts). */
  turnScreen(id: string): DroidScreen | undefined {
    const w = this.context.get(id);
    return w?.term && w.info.kind === 'agent' ? readDroidScreen(screenRows(w.term)) : undefined;
  }

  prompt(id: string, text: string, images?: readonly string[], queue = false): string | undefined {
    const w = this.context.get(id);
    if (!w) return 'No such worker';
    if (!w.pty) return 'Worker is not running';
    const typed = text.replace(/\r\n?/g, '\n').trim();
    const clean = images?.length ? withImages(typed, this.context.drops.adopt(id, images)) : typed;
    if (!clean) return 'Empty prompt';
    const ctrlEnter = queue && wantsCsiEnter(w.info.kind);
    const queuedTurn = ctrlEnter && w.info.status === 'working';
    if (queuedTurn) w.queued++;
    this.typeIn(w, clean, ctrlEnter ? CTRL_ENTER : '\r', queuedTurn);
    const shown = withoutReminders(typed) || 'See the attached images';
    w.info.activity = truncate(shown, 80);
    this.context.notePrompt(w, shown);
    w.info.lastInputAt = Date.now();
    this.context.update(w);
    return undefined;
  }

  /** Types a message into the agent's input box and submits it with `submit`. */
  private typeIn(w: Worker, text: string, submit = '\r', queued = false) {
    // Bracketed paste keeps multi-line prompts in one message, then Enter submits.
    w.pty?.write(`\x1b[200~${text}\x1b[201~`);
    const entry = {
      text,
      submit,
      queued,
      timer: setTimeout(() => {
        w.inFlight.delete(entry);
        if (entry.queued && w.info.status === 'working') {
          w.sentQueue.push({ id: ++w.sentQueueSeq, text: entry.text, group: 'queued', at: Date.now() });
          if (w.sentQueue.length > 32) w.sentQueue.splice(0, w.sentQueue.length - 32);
        }
        w.pty?.write(entry.submit);
      }, 120),
    };
    w.inFlight.add(entry);
  }

  private cancelInFlightQueued(w: Worker): boolean {
    let any = false;
    for (const entry of [...w.inFlight]) {
      if (!entry.queued) continue;
      clearTimeout(entry.timer);
      w.inFlight.delete(entry);
      if (w.queued > 0) w.queued--;
      any = true;
    }
    if (any) w.pty?.write('\x15');
    return any;
  }

  private resolvedQueue(w: Worker, now = Date.now()) {
    const res = resolveWorkerQueue({
      outbox: w.outbox,
      sent: w.sentQueue,
      inFlight: [...w.inFlight].filter((f) => f.queued).map((f) => ({ text: f.text, queued: true })),
      rows: w.term ? screenRows(w.term) : undefined,
      now,
    });
    w.sentQueue = res.keptSent;
    return res;
  }

  /** Pending messages waiting on `id` across the office hook outbox and Droid's TUI queue. */
  queueState(id: string, now = Date.now()): WorkerQueueState | undefined {
    const w = this.context.get(id);
    if (w?.info.kind !== 'agent' || w.info.cloud || w.info.remote) return undefined;
    const { count, items, moreSteering, moreQueued } = this.resolvedQueue(w, now);
    return { count, items, moreSteering, moreQueued };
  }

  /**
   * Interrupts a running turn or blocking command via Escape (never answering a permission/question
   * prompt) and delivers `text` immediately once Droid stops or settles.
   */
  async urgentPrompt(id: string, text: string, images?: readonly string[]): Promise<{ error?: string; interrupted?: boolean }> {
    const w = this.context.get(id);
    if (!w) return { error: 'No such worker' };
    if (w.info.status === 'starting') return { error: `${w.info.name} is still starting up: try again in a few seconds` };
    if (w.info.status === 'needs_input') {
      return { error: `${w.info.name} is waiting on an answer in its own terminal (${w.info.activity ?? 'a prompt'}): someone has to answer it there` };
    }
    if (!w.pty) {
      const typed = text.replace(/\r\n?/g, '\n').trim();
      const clean = images?.length ? withImages(typed, this.context.drops.adopt(id, images)) : typed;
      if (!clean) return { error: 'Empty prompt' };
      return { error: this.context.resume(id, clean) };
    }
    let interrupted = false;
    if (w.info.kind === 'agent' && w.info.status === 'working') {
      this.cancelInFlightQueued(w);
      interrupted = this.cancelTurn(id);
      if (!interrupted && w.activeTool.size > 0 && this.context.get(id)?.info.status !== 'needs_input') {
        const screen = w.term ? readDroidScreen(screenRows(w.term)) : undefined;
        if (screen !== 'idle' && screen !== 'asking' && this.turnScreen(id) !== 'asking') {
          w.pty.write('\x1b');
          w.cancelAt = Date.now();
          interrupted = true;
        }
      }
      if (interrupted) {
        const deadline = Date.now() + 1200;
        while (Date.now() < deadline) {
          if (!w.pty || w.info.status !== 'working') break;
          const screen = this.turnScreen(id);
          if (screen === 'idle' || screen === 'asking') break;
          await new Promise<void>((resolve) => setTimeout(resolve, 40));
        }
      }
      if (this.turnScreen(id) === 'asking' || this.context.get(id)?.info.status === 'needs_input') {
        return { error: `${w.info.name} opened an interactive prompt while stopping; check its terminal before sending` };
      }
    }
    const error = this.prompt(id, text, images, false);
    return { ...(error ? { error } : {}), ...(interrupted ? { interrupted: true } : {}) };
  }

  /** Clears all pending messages on `id`, or the single 1-based item `index`. */
  async clearQueue(id: string, index?: number): Promise<{ error?: string; cleared: QueuedMessageItem[]; remaining: WorkerQueueState }> {
    const empty: WorkerQueueState = { count: 0, items: [], moreSteering: 0, moreQueued: 0 };
    const w = this.context.get(id);
    if (!w) return { error: 'No such worker', cleared: [], remaining: empty };
    if (w.info.kind === 'shell') return { error: `${w.info.name} is a shell: shells have no Droid message queue`, cleared: [], remaining: empty };
    if (w.info.cloud || w.info.remote) return { error: `${w.info.name} runs remotely and has no local message queue`, cleared: [], remaining: empty };
    const current = this.resolvedQueue(w);
    if (index !== undefined) {
      if (!current.resolved.length) return { error: `${w.info.name} has no queued messages to clear`, cleared: [], remaining: this.queueState(id) ?? empty };
      const target = current.resolved[index - 1];
      if (!target) return { error: `No queued message #${index} on ${w.info.name} (queue has ${current.resolved.length})`, cleared: [], remaining: this.queueState(id) ?? empty };
      const delErr = await this.deleteSingleQueueItem(w, target, current.droid?.items.length ?? 0);
      if (delErr) return { error: delErr, cleared: [], remaining: this.queueState(id) ?? empty };
      const { index: i, text, preview, moreLines, source, delivery } = target;
      return { cleared: [{ index: i, text, preview, moreLines, source, delivery }], remaining: this.queueState(id) ?? empty };
    }
    const cleared = [...current.items];
    this.cancelInFlightQueued(w);
    if (w.outbox.length) {
      w.outbox = [];
      clearTimeout(w.outboxTimer);
      w.outboxTimer = undefined;
      this.context.persist();
    }
    if (w.pty && w.term) {
      await clearDroidPendingAll({ write: (d) => w.pty?.write(d), rows: () => (w.term ? screenRows(w.term) : undefined) });
    }
    w.queued = 0;
    w.sentQueue = [];
    return { cleared, remaining: this.queueState(id) ?? empty };
  }

  private async deleteSingleQueueItem(w: Worker, item: ResolvedQueueItem, droidTotal: number): Promise<string | undefined> {
    if (item.outboxIndex !== undefined) {
      w.outbox.splice(item.outboxIndex, 1);
      if (!w.outbox.length) {
        clearTimeout(w.outboxTimer);
        w.outboxTimer = undefined;
      }
      this.context.persist();
      return undefined;
    }
    if (item.inFlightIndex !== undefined) {
      const queuedEntries = [...w.inFlight].filter((f) => f.queued);
      const entry = queuedEntries[item.inFlightIndex];
      if (entry) {
        clearTimeout(entry.timer);
        w.inFlight.delete(entry);
        if (w.queued > 0) w.queued--;
        w.pty?.write('\x15');
      }
      return undefined;
    }
    if (item.droidIndex !== undefined && w.pty && w.term) {
      const ok = await driveDroidQueueItem({ write: (d) => w.pty?.write(d), rows: () => (w.term ? screenRows(w.term) : undefined) }, item.droidIndex, droidTotal, 'delete', {
        group: item.delivery === 'after_turn' ? 'queued' : 'steering',
        text: item.text,
      });
      if (!ok) return `Droid queue review did not open on ${w.info.name}; check its terminal before retrying`;
    }
    if (item.delivery === 'after_turn' && w.queued > 0) w.queued--;
    if (item.sentId !== undefined) {
      const pos = w.sentQueue.findIndex((s) => s.id === item.sentId);
      if (pos >= 0) w.sentQueue.splice(pos, 1);
      if (item.droidIndex === undefined && !w.sentQueue.length && !droidTotal && w.pty && w.term) {
        await clearDroidPendingAll({ write: (d) => w.pty?.write(d), rows: () => (w.term ? screenRows(w.term) : undefined) });
      }
    }
    return undefined;
  }

  /**
   * Promotes queued message(s) on `id` forward to steer now (or with `urgent: true`, interrupts the
   * running turn/blocking command via Escape and delivers immediately).
   */
  async promoteQueue(
    id: string,
    opts: { index?: number; all?: boolean; urgent?: boolean } = {},
  ): Promise<{
    error?: string;
    promoted: QueuedMessageItem[];
    delivery?: 'steering' | 'next_step' | 'interrupted' | 'sent' | 'already_delivered';
    stillPending?: boolean;
    remaining: WorkerQueueState;
  }> {
    const empty: WorkerQueueState = { count: 0, items: [], moreSteering: 0, moreQueued: 0 };
    const w = this.context.get(id);
    if (!w) return { error: 'No such worker', promoted: [], stillPending: false, remaining: empty };
    if (w.info.kind === 'shell') return { error: `${w.info.name} is a shell: shells have no Droid message queue`, promoted: [], stillPending: false, remaining: empty };
    if (w.info.cloud || w.info.remote) return { error: `${w.info.name} runs remotely and has no local message queue`, promoted: [], stillPending: false, remaining: empty };

    const slotLabel = (d: QueuedMessageItem['delivery']) => (d === 'after_turn' ? 'after turn' : d === 'steering' ? 'mid-turn steer' : 'next step');
    const failWithPending = (baseError: string, targetTexts?: readonly string[]) => {
      const remaining = this.queueState(id) ?? empty;
      const matched = targetTexts?.length ? remaining.items.filter((it) => targetTexts.some((t) => it.text === t || showsAs({ text: it.text, cut: it.preview, more: it.moreLines }, t))) : remaining.items;
      const stillPending = targetTexts?.length ? matched.length > 0 || (remaining.moreQueued + remaining.moreSteering > 0 && w.queued > 0) : remaining.count > 0;
      let suffix: string;
      if (stillPending) {
        if (matched.length === 1) {
          suffix = `Message is still pending in queue (#${matched[0].index} [${slotLabel(matched[0].delivery)}]; ${remaining.count} pending).`;
        } else if (matched.length > 1) {
          suffix = `${matched.length} targeted messages are still pending in queue (${remaining.count} pending).`;
        } else {
          suffix = `Queue still has ${remaining.count} pending message${remaining.count === 1 ? '' : 's'}.`;
        }
      } else if (remaining.count > 0) {
        suffix = `Targeted message is no longer pending in queue (${remaining.count} other message${remaining.count === 1 ? '' : 's'} pending).`;
      } else {
        suffix = 'No messages are pending in the queue.';
      }
      return { error: `${baseError.replace(/\.$/, '')}. ${suffix}`, promoted: [], stillPending, remaining };
    };

    if (w.info.status === 'starting') {
      return failWithPending(`${w.info.name} is still starting up: try again in a few seconds`);
    }
    if (w.info.status === 'needs_input') {
      return failWithPending(`${w.info.name} is waiting on an answer in its own terminal (${w.info.activity ?? 'a prompt'}): someone has to answer it there`);
    }
    const current = this.resolvedQueue(w);
    if (!current.resolved.length) return failWithPending(`${w.info.name} has no queued messages to promote`, []);

    let targets: ResolvedQueueItem[];
    if (opts.index !== undefined) {
      const picked = current.resolved[opts.index - 1];
      if (!picked) return failWithPending(`No queued message #${opts.index} on ${w.info.name} (queue has ${current.resolved.length})`, []);
      targets = [picked];
    } else if (opts.all) {
      targets = opts.urgent ? [...current.resolved] : current.resolved.filter((it) => it.delivery === 'after_turn' || (it.source === 'outbox' && w.info.status !== 'working'));
      if (!targets.length) targets = [...current.resolved];
    } else {
      const firstAfterTurn = current.resolved.find((it) => it.delivery === 'after_turn');
      targets = [firstAfterTurn ?? current.resolved[0]];
    }

    const plainItems = targets.map(({ index: i, text, preview, moreLines, source, delivery }) => ({ index: i, text, preview, moreLines, source, delivery }));
    const targetTexts = targets.map((t) => t.text);

    if (opts.urgent) {
      const previewTarget = targets.find((t) => t.preview);
      if (previewTarget) {
        return failWithPending(`Queued message #${previewTarget.index} was typed directly in the terminal and only its truncated preview is visible; promote without urgent first or re-send full text with urgent: true`, targetTexts);
      }
      const joined = targetTexts.join('\n\n');
      if (!joined.trim()) return failWithPending('Empty prompt', targetTexts);
      // Delete in reverse order before Escape so Droid does not auto-fire queued items on turn stop;
      // if urgent delivery fails afterwards, restore removed texts to the worker's outbox.
      let droidCount = current.droid?.items.length ?? 0;
      const removedTexts: string[] = [];
      for (const item of [...targets].reverse()) {
        const delErr = await this.deleteSingleQueueItem(w, item, droidCount);
        if (delErr) {
          if (removedTexts.length) {
            w.outbox.push(...removedTexts.reverse());
            this.context.persist();
          }
          return failWithPending(delErr, targetTexts);
        }
        removedTexts.push(item.text);
        if (item.droidIndex !== undefined) droidCount = Math.max(0, droidCount - 1);
      }
      const sent = await this.urgentPrompt(id, joined);
      if (sent.error) {
        w.outbox.push(...targetTexts);
        this.context.persist();
        return failWithPending(sent.error, targetTexts);
      }
      return { promoted: plainItems, delivery: sent.interrupted ? 'interrupted' : 'sent', stillPending: false, remaining: this.queueState(id) ?? empty };
    }

    const initialInFlight = [...w.inFlight].filter((f) => f.queued);
    let delivery: 'steering' | 'next_step' | 'sent' | 'already_delivered' = 'steering';
    for (const item of targets) {
      if (item.source === 'outbox') {
        if (w.info.status === 'done' || w.info.status === 'idle') {
          const outIdx = item.outboxIndex !== undefined && item.outboxIndex >= 0 && item.outboxIndex < w.outbox.length && w.outbox[item.outboxIndex] === item.text ? item.outboxIndex : w.outbox.indexOf(item.text);
          if (outIdx >= 0) w.outbox.splice(outIdx, 1);
          if (!w.outbox.length) {
            clearTimeout(w.outboxTimer);
            w.outboxTimer = undefined;
          }
          this.context.persist();
          const err = this.prompt(id, item.text, undefined, false);
          if (err) {
            const restoreIdx = outIdx >= 0 && outIdx <= w.outbox.length ? outIdx : w.outbox.length;
            w.outbox.splice(restoreIdx, 0, item.text);
            this.context.persist();
            return failWithPending(err, targetTexts);
          }
          delivery = 'sent';
        } else {
          delivery = 'next_step';
        }
        continue;
      }
      if (item.inFlightIndex !== undefined) {
        const entry = initialInFlight[item.inFlightIndex];
        if (entry && w.inFlight.has(entry)) {
          clearTimeout(entry.timer);
          w.inFlight.delete(entry);
          if (w.queued > 0) w.queued--;
          w.pty?.write('\r');
        }
        delivery = 'steering';
        continue;
      }
      if (item.delivery === 'after_turn') {
        if (item.droidIndex !== undefined && w.pty && w.term) {
          const queuedBefore = w.queued;
          const statusBefore = w.info.status;
          const ok = await driveDroidQueueItem({ write: (d) => w.pty?.write(d), rows: () => (w.term ? screenRows(w.term) : undefined) }, item.droidIndex, current.droid?.items.length ?? 1, 'promote', { group: 'queued', text: item.text });
          if (!ok) {
            const drainedByHook = w.queued < queuedBefore;
            const afterRows = w.term ? screenRows(w.term) : undefined;
            const afterPending = afterRows ? readDroidPending(afterRows) : undefined;
            const afterScreen = afterRows ? readDroidScreen(afterRows) : undefined;
            const turnEndedCleanly = statusBefore === 'working' && (w.info.status === 'done' || w.info.status === 'idle' || afterScreen === 'idle');
            const goneFromScreen = afterPending !== undefined && !afterPending.reviewActive && !afterPending.items.some((r) => showsAs(r, item.text)) && afterPending.moreQueued === 0;
            if ((drainedByHook || turnEndedCleanly) && goneFromScreen && !w.outbox.includes(item.text)) {
              if (turnEndedCleanly && !drainedByHook && w.queued > 0) w.queued--;
              if (item.sentId !== undefined) {
                const pos = w.sentQueue.findIndex((s) => s.id === item.sentId);
                if (pos >= 0) w.sentQueue.splice(pos, 1);
              }
              delivery = 'already_delivered';
              continue;
            }
            if (item.sentId !== undefined) {
              const sentEntry = w.sentQueue.find((s) => s.id === item.sentId);
              if (sentEntry && w.info.status === 'working' && w.queued >= queuedBefore) {
                sentEntry.seen = undefined;
                sentEntry.at = Date.now();
              }
            } else if (!item.preview && afterPending === undefined && w.info.status === 'working') {
              w.sentQueue.push({ id: ++w.sentQueueSeq, text: item.text, group: 'queued', at: Date.now() });
            }
            return failWithPending(`Droid queue review did not open on ${w.info.name}; check its terminal before retrying`, targetTexts);
          }
          if (w.queued > 0) w.queued--;
          if (item.sentId !== undefined) {
            const sentEntry = w.sentQueue.find((s) => s.id === item.sentId);
            if (sentEntry) sentEntry.group = 'steering';
          }
        } else {
          if (this.notice(id, item.text)) {
            delivery = 'next_step';
          } else {
            const err = this.prompt(id, item.text, undefined, false);
            if (err) return failWithPending(err, targetTexts);
            delivery = w.info.status === 'working' ? 'steering' : 'sent';
          }
          if (w.queued > 0) w.queued--;
          if (item.sentId !== undefined) {
            const pos = w.sentQueue.findIndex((s) => s.id === item.sentId);
            if (pos >= 0) w.sentQueue.splice(pos, 1);
            if (!w.sentQueue.length && !(current.droid?.items.length ?? 0) && w.pty && w.term) {
              await clearDroidPendingAll({ write: (d) => w.pty?.write(d), rows: () => (w.term ? screenRows(w.term) : undefined) });
            }
          }
        }
      }
    }
    return { promoted: plainItems, delivery, stillPending: false, remaining: this.queueState(id) ?? empty };
  }

  /** Types in the message this run of its droid was started for, if it hasn't been yet. */
  sendLaunchPrompt(w: Worker) {
    const pending = w.launchPrompt;
    w.launchPrompt = undefined;
    if (!pending) return;
    if (w.pty) {
      w.info.lastInputAt = Date.now();
      this.typeIn(w, pending.text);
    }
    // Saved at once, so an office restarting now doesn't type it in a second time.
    this.context.persist();
  }

  notice(id: string, text: string, images?: readonly string[]): boolean {
    const w = this.context.get(id);
    const typed = text.replace(/\r\n?/g, '\n').trim();
    if (!w?.pty || (!typed && !images?.length) || w.info.kind !== 'agent' || w.info.status !== 'working' || w.bootBlocked || w.hookVersion < HOOK_VERSION) return false;
    const clean = images?.length ? withImages(typed, this.context.drops.adopt(id, images)) : typed;
    if (!clean) return false;
    w.outbox.push(clean);
    // Promised to whoever sent it: it outlives an office restart that keeps the terminal.
    this.context.persist();
    return true;
  }

  /**
   * An office message for a worker that mustn't be typed into now (it's starting, or asking in its
   * terminal, where Enter would answer): its hooks hand it over once its turn goes on, or it's typed
   * in once it comes to rest (see flushOutbox).
   */
  hold(id: string, text: string): string | undefined {
    const w = this.context.get(id);
    if (!w) return 'No such worker';
    if (!w.pty) return 'Worker is not running';
    const clean = text.replace(/\r\n?/g, '\n').trim();
    if (!clean) return 'Empty prompt';
    w.outbox.push(clean);
    this.context.persist();
    return undefined;
  }

  /**
   * Types in the notices its hooks didn't get to hand over before it came to rest, once nobody has
   * typed into its terminal for NOTICE_TYPING_MS. One that's busy again by then gets them through its hooks.
   */
  flushOutbox(w: Worker) {
    clearTimeout(w.outboxTimer);
    w.outboxTimer = undefined;
    if (!w.outbox.length || this.context.closing() || this.context.get(w.info.id) !== w || !w.pty) return;
    if (w.info.status !== 'done' && w.info.status !== 'idle') return;
    const wait = (w.info.lastInputAt ?? 0) + NOTICE_TYPING_MS - Date.now();
    if (wait > 0) {
      w.outboxTimer = setTimeout(() => this.flushOutbox(w), wait);
      w.outboxTimer.unref();
      return;
    }
    const text = w.outbox.join('\n\n');
    w.outbox = [];
    this.prompt(w.info.id, text);
    this.context.persist();
  }
}

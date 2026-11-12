import { CLEAR_DROID_QUEUE, DELETE_DROID_QUEUE_ITEM, DROID_QUEUE_DOWN, DROID_QUEUE_UP, REVIEW_DROID_QUEUE, readDroidPending, showsAs, type DroidPendingGroup, type DroidPendingSnapshot } from '../shared/droid-queue.js';
import { QUEUE_GRACE_MS } from '../shared/thread-queue.js';
import type { WorkerStatus } from '../shared/protocol.js';

export type QueuedMessageDelivery = 'next_step' | 'steering' | 'after_turn';
export type QueuedMessageSource = 'outbox' | 'droid';

export interface QueuedMessageItem {
  /** 1-based position across all pending messages on this worker. */
  index: number;
  text: string;
  /** True when only Droid's single-line screen preview is known. */
  preview: boolean;
  moreLines: number;
  source: QueuedMessageSource;
  /** next_step: office hook outbox; steering: Droid Enter-steer; after_turn: Droid Ctrl+Enter queue. */
  delivery: QueuedMessageDelivery;
}

export interface WorkerQueueState {
  count: number;
  items: QueuedMessageItem[];
  moreSteering: number;
  moreQueued: number;
}

export interface BlockingToolState {
  tool: string;
  command?: string;
  runningForMs: number;
  reason: 'watch_command' | 'long_running';
}

export interface ActiveToolCall {
  tool: string;
  input: unknown;
  startedAt: number;
}

export interface SentPendingMessage {
  id: number;
  text: string;
  group: DroidPendingGroup;
  at: number;
  seen?: number;
}

/** Running tool calls at or past this threshold are surfaced as blocking steers. */
export const BLOCKING_TOOL_MS = 15_000;

/** Known watch/follow/sleep shell commands that block tool completion until interrupted or finished. */
const WATCH_COMMAND_RE =
  /\bgh\s+(?:run\s+watch\b|pr\s+checks\b[^\n;|&]*--watch\b)|\bglab\s+ci\s+(?:status|trace)\b[^\n;|&]*--(?:wait|live)\b|\bkubectl\s+(?:wait\b|logs\b[^\n;|&]*-f\b|rollout\s+status\b)|\bdocker\s+(?:compose\s+)?logs\b[^\n;|&]*-f\b|\btail\s+(?:-[^\n;|&]*f\b|--follow\b)|(?:^|[;&|]\s*)watch\s+\S|(?:^|[;&|]\s*)sleep\s+(?:[5-9]|\d{2,})(?:\.\d+)?\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|watch)\b/;

function clipOneLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function extractToolCommand(tool: string, input: unknown): string | undefined {
  if (tool !== 'Execute' && tool !== 'Bash') return undefined;
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;
  const raw = typeof obj.command === 'string' ? obj.command : typeof obj.cmd === 'string' ? obj.cmd : undefined;
  if (!raw?.trim()) return undefined;
  return clipOneLine(raw, 120);
}

export function isWatchCommand(command: string | undefined): boolean {
  return !!command && WATCH_COMMAND_RE.test(command);
}

/**
 * Returns the worker's active blocking tool call when it is mid-turn inside a known watch command
 * (such as `gh run watch`) or a tool call that has run for at least BLOCKING_TOOL_MS.
 */
export function detectBlockingTool(status: WorkerStatus, activeTools: ReadonlyMap<string, ActiveToolCall>, now = Date.now()): BlockingToolState | undefined {
  if (status !== 'working' || !activeTools.size) return undefined;
  let picked: BlockingToolState | undefined;
  for (const call of activeTools.values()) {
    const runningForMs = Math.max(0, now - call.startedAt);
    const command = extractToolCommand(call.tool, call.input);
    const watch = (call.tool === 'Execute' || call.tool === 'Bash') && isWatchCommand(command);
    if (!watch && runningForMs < BLOCKING_TOOL_MS) continue;
    const candidate: BlockingToolState = {
      tool: call.tool,
      ...(command ? { command } : {}),
      runningForMs,
      reason: watch ? 'watch_command' : 'long_running',
    };
    if (!picked || (candidate.reason === 'watch_command' && picked.reason !== 'watch_command') || candidate.runningForMs > picked.runningForMs) {
      picked = candidate;
    }
  }
  return picked;
}

export function formatDurationShort(ms: number): string {
  const secs = Math.max(1, Math.round(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return rem ? `${mins}m ${rem}s` : `${mins}m`;
}

export function formatBlockingSummary(b: BlockingToolState): string {
  const what = b.command ? `${b.tool}: \`${b.command}\`` : b.tool;
  return `${what} (${formatDurationShort(b.runningForMs)})`;
}

export function formatBlockingSteerWarning(name: string, b: BlockingToolState): string {
  return `${name} is inside a blocking command (${formatBlockingSummary(b)}) — steers wait until this tool call finishes. Pass urgent: true (or call office_worker_interrupt) to interrupt it now.`;
}

export function formatQueueBrief(queue: WorkerQueueState): string | undefined {
  if (!queue.count) return undefined;
  const previews = queue.items.slice(0, 3).map((item) => {
    const tag = item.delivery === 'after_turn' ? 'after turn' : item.delivery === 'steering' ? 'steering' : 'next step';
    return `#${item.index} [${tag}] "${clipOneLine(item.text, 60)}"`;
  });
  const extra = queue.count - previews.length;
  return `Queued (${queue.count}): ${previews.join('; ')}${extra > 0 ? ` (+${extra} more)` : ''}`;
}

export interface BuildQueueInput {
  outbox: readonly string[];
  sent: readonly SentPendingMessage[];
  inFlight: readonly { text: string; queued: boolean }[];
  rows?: readonly string[];
  now?: number;
}

export interface ResolvedQueueItem extends QueuedMessageItem {
  /** Position in `outbox` when `source === 'outbox'`. */
  outboxIndex?: number;
  /** Position in Droid's reviewable pending list (`0`-based) when on screen. */
  droidIndex?: number;
  /** Sent-cache id when backed by `sent`. */
  sentId?: number;
  /** True when paste was written and its submit key timer is still pending. */
  inFlightIndex?: number;
}

export interface ResolvedWorkerQueue extends WorkerQueueState {
  items: QueuedMessageItem[];
  resolved: ResolvedQueueItem[];
  keptSent: SentPendingMessage[];
  droid?: DroidPendingSnapshot;
}

/**
 * Combines the office's hook outbox, Droid's on-screen Steering/Queued blocks (enriched with full
 * texts sent through the office), and any paste whose 120ms submit timer is still in flight.
 */
export function resolveWorkerQueue(input: BuildQueueInput): ResolvedWorkerQueue {
  const now = input.now ?? Date.now();
  const droid = input.rows ? readDroidPending(input.rows) : undefined;
  const resolved: ResolvedQueueItem[] = [];
  const clonedSent: SentPendingMessage[] = input.sent.map((it) => ({ ...it }));

  for (let i = 0; i < input.outbox.length; i++) {
    resolved.push({
      index: resolved.length + 1,
      text: input.outbox[i],
      preview: false,
      moreLines: 0,
      source: 'outbox',
      delivery: 'next_step',
      outboxIndex: i,
    });
  }

  const inFlightTexts = new Set(input.inFlight.map((f) => f.text));
  let keptSent = clonedSent;
  if (droid) {
    const used = new Set<SentPendingMessage>();
    for (let d = 0; d < droid.items.length; d++) {
      const row = droid.items[d];
      const exactGroup = clonedSent.find((it) => !used.has(it) && it.group === row.group && showsAs(row, it.text));
      const matched = exactGroup ?? clonedSent.find((it) => !used.has(it) && showsAs(row, it.text));
      if (matched) {
        used.add(matched);
        matched.seen = now;
        matched.group = row.group;
      }
      resolved.push({
        index: resolved.length + 1,
        text: matched ? matched.text : row.text,
        preview: matched ? false : row.cut || row.more > 0,
        moreLines: matched ? 0 : row.more,
        source: 'droid',
        delivery: row.group === 'queued' ? 'after_turn' : 'steering',
        droidIndex: d,
        ...(matched ? { sentId: matched.id } : {}),
      });
    }
    keptSent = clonedSent.filter((it) => used.has(it) || inFlightTexts.has(it.text) || (it.seen === undefined && now - it.at < QUEUE_GRACE_MS));
    for (const it of keptSent) {
      if (used.has(it) || inFlightTexts.has(it.text)) continue;
      resolved.push({
        index: resolved.length + 1,
        text: it.text,
        preview: false,
        moreLines: 0,
        source: 'droid',
        delivery: it.group === 'queued' ? 'after_turn' : 'steering',
        sentId: it.id,
      });
    }
  } else {
    for (const it of keptSent) {
      if (inFlightTexts.has(it.text)) continue;
      resolved.push({
        index: resolved.length + 1,
        text: it.text,
        preview: false,
        moreLines: 0,
        source: 'droid',
        delivery: it.group === 'queued' ? 'after_turn' : 'steering',
        sentId: it.id,
      });
    }
  }

  for (let f = 0; f < input.inFlight.length; f++) {
    const item = input.inFlight[f];
    resolved.push({
      index: resolved.length + 1,
      text: item.text,
      preview: false,
      moreLines: 0,
      source: 'droid',
      delivery: item.queued ? 'after_turn' : 'steering',
      inFlightIndex: f,
    });
  }

  const moreSteering = droid?.moreSteering ?? 0;
  const moreQueued = droid?.moreQueued ?? 0;
  const items: QueuedMessageItem[] = resolved.map(({ index, text, preview, moreLines, source, delivery }) => ({
    index,
    text,
    preview,
    moreLines,
    source,
    delivery,
  }));
  return {
    count: items.length + moreSteering + moreQueued,
    items,
    moreSteering,
    moreQueued,
    resolved,
    keptSent,
    droid,
  };
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface QueueDriveTarget {
  group: DroidPendingGroup;
  text: string;
}

/**
 * Drives Droid's Ctrl+R review mode to promote (`action === 'promote'`) or delete (`action === 'delete'`)
 * the item at `droidIndex` in Droid's reviewable pending list, using Ctrl+R (never Esc) to exit.
 * Returns `false` without sending navigation/action keys if Droid's queue review never became active,
 * and closes review mode before returning `false` if the item disappeared or failed to promote.
 */
export async function driveDroidQueueItem(io: { write(data: string): void; rows(): readonly string[] | undefined }, droidIndex: number, totalOnScreen: number, action: 'promote' | 'delete', target?: QueueDriveTarget): Promise<boolean> {
  const before = io.rows();
  const snap = before ? readDroidPending(before) : undefined;
  const wasActive = snap?.reviewActive === true;
  let reviewSnap = wasActive ? snap : undefined;
  if (!reviewSnap) {
    io.write(REVIEW_DROID_QUEUE);
    for (let attempt = 0; attempt < 20 && !reviewSnap; attempt++) {
      await pause(20);
      const cur = io.rows();
      const parsed = cur ? readDroidPending(cur) : undefined;
      if (parsed?.reviewActive) reviewSnap = parsed;
    }
    if (!reviewSnap) return false;
  }

  // Droid resets selection to index 0 only when opening review mode; rewind first if it was already open.
  if (wasActive) {
    const rewind = Math.max(reviewSnap.items.length, totalOnScreen) - 1;
    for (let step = 0; step < rewind; step++) {
      io.write(DROID_QUEUE_UP);
      await pause(10);
    }
  }

  // Review mode expands "+N more steering/queued items" rows, which can shift the target item's index.
  let navIndex = droidIndex;
  if (target) {
    const atIndex = reviewSnap.items[navIndex];
    if (!atIndex || atIndex.group !== target.group || !showsAs(atIndex, target.text)) {
      const found = reviewSnap.items.findIndex((it) => it.group === target.group && showsAs(it, target.text));
      if (found < 0) {
        io.write(REVIEW_DROID_QUEUE);
        await pause(20);
        return false;
      }
      navIndex = found;
    }
  } else if (navIndex >= reviewSnap.items.length) {
    io.write(REVIEW_DROID_QUEUE);
    await pause(20);
    return false;
  }

  for (let step = 0; step < navIndex; step++) {
    io.write(DROID_QUEUE_DOWN);
    await pause(15);
  }
  if (action === 'promote') {
    // Enter in Ctrl+R review mode calls update_queue -> end_of_turn (steering) and closes review mode asynchronously.
    io.write('\r');
    for (let attempt = 0; attempt < 15; attempt++) {
      await pause(20);
      const cur = io.rows();
      const after = cur ? readDroidPending(cur) : undefined;
      if (!after?.reviewActive) return true;
    }
    io.write(REVIEW_DROID_QUEUE);
    await pause(20);
    return false;
  }
  const effectiveTotal = Math.max(totalOnScreen, reviewSnap.items.length);
  io.write(DELETE_DROID_QUEUE_ITEM);
  await pause(25);
  // Deleting one item when >1 existed leaves review mode open; Ctrl+R toggles it closed without risking Esc.
  if (effectiveTotal > 1) {
    const after = io.rows();
    if (!after || readDroidPending(after)?.reviewActive !== false) {
      io.write(REVIEW_DROID_QUEUE);
      await pause(15);
    }
  }
  return true;
}

/** Clears Droid's entire pending queue via Ctrl+X when Droid shows pending items. */
export async function clearDroidPendingAll(io: { write(data: string): void; rows(): readonly string[] | undefined }): Promise<boolean> {
  const rows = io.rows();
  const snap = rows ? readDroidPending(rows) : undefined;
  if (!snap || (!snap.items.length && !snap.moreQueued && !snap.moreSteering)) return false;
  if (snap.reviewActive) {
    io.write(REVIEW_DROID_QUEUE);
    await pause(20);
  }
  // Ctrl+U clears any stray input draft (`g2` in Droid) that would otherwise block Ctrl+X.
  io.write('\x15');
  await pause(15);
  io.write(CLEAR_DROID_QUEUE);
  await pause(25);
  return true;
}

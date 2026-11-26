import { readDroidPending } from '../../shared/droid-queue';
import { ORCHESTRATOR_ID } from '../../shared/mission-control';
import { PROMPT_MAX } from '../../shared/prompts';
import type { ClientMsg, ServerMsg, WorkerInfo } from '../../shared/protocol';
import { nativeCopy, nativeLimits, slashOf, slashRefusal } from '../../shared/slash-commands';
import { isAsleep, isBusy, needsOwnerInput } from '../../shared/status';
import { latestThreadPlan, type ActivePlan, type ThreadBlock, type ThreadRow } from '../../shared/thread-presentation';
import { statusMode, thinkingSeconds, thoughtLabel } from '../../shared/thread-status';
import { ThreadQueue } from '../../shared/thread-queue';
import { rewindFilesSince } from '../../shared/thread-rewind';
import { threadPrompts } from '../../shared/thread-turns';
import { todosFinished } from '../../shared/todos';
import type { ThreadEntry } from '../../shared/worker-thread';
import type { Net } from '../net';
import { recallPrompt } from '../prompt-recall';
import { store } from '../state';
import { TeamThread, TeamThreadPaint, teamThreadVisible } from '../team-thread';
import { ThreadHistory } from '../thread-history';
import { cloudStarting, threadSnapshotError, threadStarting } from '../thread-startup';
import { withToken } from '../token';
import { applyHorizontalScrollCue, measureHorizontalScrollCue, type HorizontalScrollCueMeasurement } from './code-highlight';
import { h, STATUS_LABEL } from './dom';
import { openFactoryLimits } from './factory-limits';
import { liveFrom, entryAt, entryTook, type LiveTool, type LiveView } from './thread-live-view';
import { openThreadCopy } from './thread-copy';
import { mountThreadSettings } from './thread-settings';
import { refreshMessageTimes, threadMessageActions } from './thread-message-actions';
import { openThreadRewind, type ThreadRewindRestore } from './thread-rewind';
import { ThreadScrollMotion } from './thread-scroll-motion';
import { mountThreadSearch } from './thread-search';
import { mountThreadStatusRow } from './thread-status-row';
import { openFilePreviewModal, threadFileImageUrl } from './file-preview';
import { icon } from './icons';
import { promptImages } from './images';
import { attachComposerAssist } from './composer-assist';
import { insertQuote } from './thread-compose';
import { renderTurnChanges, setDisclosureOpen, type ThreadCardRenderContext } from './thread-diff-view';
import { refreshLiveOutput, renderThreadActivity } from './thread-tool-activity';
import { onThreadViewPrefs, threadViewPrefs, threadViewRowKey, threadViewVars } from './thread-view-prefs';
import { openImageLightbox } from './thread-md-lightbox';
import { attachQuoteReply } from './thread-md-quote';
import { threadMarkdown, threadUserMarkdown, type WorkspacePathRef } from './thread-markdown';

export interface WorkerThread {
  element: HTMLElement;
  entries(): readonly ThreadEntry[];
  update(worker: WorkerInfo, connected: boolean): void;
  activate(active: boolean): void;
  /** Takes pictures dropped on `zone` too, marking `mark` while they're over it. */
  dropZone(zone: HTMLElement, mark?: HTMLElement): void;
  dispose(): void;
}

export interface ThreadOptions {
  worker: WorkerInfo;
  question: HTMLElement;
  queueKey: string;
  draft: string;
  onDraft(text: string): void;
  send(msg: ClientMsg): Promise<string | undefined>;
  /** Opens the worker's terminal. A cloud worker has none. */
  raw?(): void;
  /** The window around the thread already shows a cloud worker's `cloud.error`. */
  cloudErrorShown?: boolean;
  /** The worker's terminal as text, one string per row, or undefined before it has drawn one. */
  screen?(): readonly string[] | undefined;
  onEntries?(): void;
  /** Current floor only; return no workers once the mounted floor is no longer current. */
  team?(): readonly WorkerInfo[];
  /** Open this child's Thread view, without starting or resuming a worker. */
  openWorker?(id: string): void;
  /** Opens a worker's Changes window. Absent where there is none. */
  openChanges?(id: string): void;
  /** Puts a file from a worker's workspace on the floor's Whiteboard. */
  sendToWhiteboard?(workerId: string, path: string): void;
  /** The floor the worker is on: its pictures and workspace files are fetched from there. */
  floor?: string;
  /** Shown in place of an empty conversation while it returns a node. With no session yet, nothing is read. */
  intro?(): HTMLElement | undefined;
  /** Why the worker can't take a message now, shown in place of the composer with `blockedAction` beside it. */
  blocked?(): string | undefined;
  blockedAction?: HTMLElement;
  /** Stop asks the office to stop the turn (`worker.interrupt`) instead of typing Esc into the terminal. */
  interrupt?: boolean;
  /** A prompt starts the worker from rest: the composer stays open while it's asleep, with no Resume. */
  promptWakes?: boolean;
  /** Watch only: no composer, queue, model settings, Stop, Resume, rewind or picture drops; the conversation still updates live. */
  readOnly?: boolean;
}

const RECONCILE_INTERVAL_MS = 15_000;
const STARTUP_RETRY_MS = 1_500;

/**
 * A digest of the fields a row renders from, cached per entry. The office re-sends a page's entries as
 * new objects every poll, and an entry a session rewrote in place keeps its id, so the paint key needs
 * the contents; digesting each new entry once keeps a long run's outputs off every paint.
 */
const digests = new WeakMap<ThreadEntry, string>();
function entryDigest(entry: ThreadEntry | undefined): string {
  if (!entry) return '';
  let digest = digests.get(entry);
  if (digest === undefined) {
    let hash = 2166136261;
    for (const field of [entry.text, entry.input, entry.output, entry.images?.map((image) => image.id).join()]) {
      if (field === undefined) continue;
      for (let at = 0; at < field.length; at++) hash = Math.imul(hash ^ field.charCodeAt(at), 16777619);
    }
    digest = `${hash}:${entry.error ? 1 : 0}`;
    digests.set(entry, digest);
  }
  return digest;
}

/** What a row renders from, for its paint key. */
const rowContent = (row: ThreadRow, loaded: ReadonlyMap<string, ThreadEntry>) =>
  (row.kind === 'activity' ? row.blocks.flatMap((block) => (block.kind === 'thought' ? [block.id] : block.actions.map((item) => item.id))) : [row.id]).map((id) => entryDigest(loaded.get(id)));

const hasDelegateCard = (row: ThreadRow) => row.kind === 'activity' && row.blocks.some((b) => b.kind === 'tools' && b.card === 'delegate');

const localQueues = new Map<string, ThreadQueue>();

const shortcut = (key: string, label: string) => h('span.wt-shortcut', {}, h('span.key', {}, key), label);

/**
 * A worker's conversation: a local session's JSONL, or a cloud worker's Factory session, which the
 * office projects into the same entries. It uses the existing worker actions, never a second Droid.
 * A cloud worker has no terminal here: no Raw TTY, slash commands or screen to read its queue from,
 * Stop interrupts its session, and Factory holds a message sent during a turn until the turn is over.
 */
export function mountWorkerThread(net: Net, opts: ThreadOptions): WorkerThread {
  let worker = opts.worker;
  const cloud = !!worker.cloud;
  const readOnly = !!opts.readOnly;
  const screen = cloud ? undefined : opts.screen;
  const fallback = cloud ? 'open it in Factory' : 'open Raw TTY';
  let connected = false;
  let active = false;
  let disposed = false;
  let sending = false;
  let resuming = false;
  let stopping = false;
  let received = false;
  let watchedWorkerId = '';
  let attachedWorkerId = '';
  let hasPushed = false;
  let liveView: LiveView | undefined;
  const liveTools = new Map<string, LiveTool>();
  let paintedOnce = false;
  const floorDirs = new Map<string, string>();
  // Start the grace clock on the first read, not during potentially long worktree setup.
  let startupReadUntil = threadStarting(worker) ? Infinity : 0;
  let error = '';
  /** Why the last thing the owner tried wasn't sent: shown until they change the draft. */
  let told = '';
  let pending: { request: string; before?: number; at: number } | undefined;
  let lastReadAt = 0;
  const history = new ThreadHistory();
  let savedQueue: unknown;
  try {
    savedQueue = JSON.parse(sessionStorage.getItem(opts.queueKey) ?? 'null');
  } catch {}
  const queued = localQueues.get(opts.queueKey) ?? new ThreadQueue(savedQueue);

  const resolveFloorDir = (): string | undefined => {
    if (!opts.floor) return undefined;
    return floorDirs.get(opts.floor) ?? store.floors.find((f) => f.id === opts.floor)?.dir;
  };

  // Watching only, the worker's files aren't readable: their paths stay plain text and their pictures aren't fetched.
  const canOpenFiles = (author: WorkerInfo): boolean => !readOnly && !author.cloud && (Boolean(opts.floor) || author.id === ORCHESTRATOR_ID);

  const onOpenPathFor = (author: WorkerInfo): ((ref: WorkspacePathRef) => void) | undefined =>
    canOpenFiles(author)
      ? (ref) => {
          openFilePreviewModal({
            floor: opts.floor ?? '',
            workerId: author.id,
            workerName: author.name,
            ...ref,
          });
        }
      : undefined;

  const earlier = h('button.btn.sm.wt-earlier.hidden', { type: 'button', onclick: () => read(history.entries[0]?.seq, 0) }, 'Load previous messages');
  const list = h('div.wt-list');
  const empty = h('div.wt-empty', { role: 'status' }, 'Reading the conversation…');
  const queuedBox = h('div.wt-queued', { hidden: true });
  const team = new TeamThread();
  const teamPaint = new TeamThreadPaint();
  const teamTitle = h('span', {}, 'Team activity');
  const teamBody = h('div.wt-team-body');
  const teamLimit = h('p.wt-team-note', { hidden: true });
  const teamSection = h('details.wt-team', { hidden: true }, h('summary', {}, teamTitle, h('span.wt-chevron', { 'aria-hidden': true }, icon('chevron', 14))), teamBody, teamLimit);
  const streamNode = h('article.wt-stream', { 'data-entry': 'live:stream', hidden: true });
  const scroll = h('div.wt-scroll', { tabindex: 0, 'aria-label': 'Conversation history' }, earlier, list, streamNode, empty, opts.question);
  const motion = new ThreadScrollMotion(scroll, () => {
    updateLatest();
    updatePin();
  });
  const search = mountThreadSearch(
    () => [list],
    (range) => {
      followingLayout = false;
      const el = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
      el?.scrollIntoView({ block: 'center' });
      updateLatest();
    },
  );
  const pinText = h('span.wt-pin-text');
  let pinnedRow: HTMLElement | undefined;
  const pin = h(
    'button.wt-pin.hidden',
    {
      type: 'button',
      title: 'Scroll to pinned message',
      'aria-label': 'Scroll to pinned message',
      onclick: () => {
        if (!pinnedRow) return;
        followingLayout = false;
        const top = scroll.getBoundingClientRect().top;
        scroll.scrollTop += pinnedRow.getBoundingClientRect().top - top - 8;
        updateLatest();
        updatePin();
      },
    },
    pinText,
  );
  const latest = h(
    'button.btn.icon.wt-latest.hidden',
    {
      type: 'button',
      'aria-label': 'Scroll to bottom',
      title: 'Scroll to bottom',
      onclick: () => {
        if (history.historical) {
          history.clear(worker.sessionId);
          lastReadAt = 0;
          read(undefined, 0);
        } else follow(true);
      },
    },
    icon('arrowDown', 16),
  );
  // No height of its own: the arrow floats over the transcript at the composer's top-right corner.
  const latestAnchor = h('div.wt-latest-anchor', {}, latest);
  const labelLatest = (label: string) => {
    latest.setAttribute('aria-label', label);
    latest.title = label;
  };
  let queueKey = '';
  // Keys go straight to the attached terminal, as Raw TTY types them: an office before term.input
  // confirmations would answer a confirmed send with a refusal after typing the keys anyway.
  const typeKeys = (data: string) => net.send({ t: 'term.input', workerId: worker.id, data });
  let queueActionBusy = false;
  const queueAction = async (action: 'promote' | 'delete' | 'clear', item?: { index: number; group: 'steering' | 'queued'; text?: string }) => {
    if (queueActionBusy || !connected || cloud) return '';
    queueActionBusy = true;
    updateControls();
    const msg = {
      t: 'worker.queue',
      id: worker.id,
      workerId: worker.id,
      action,
      ...(item ? { index: item.index, group: item.group, ...(item.text ? { text: item.text } : {}) } : {}),
    } as unknown as ClientMsg;
    const why = await opts.send(msg);
    queueActionBusy = false;
    if (!why && action === 'clear') queued.clear();
    told = why ?? '';
    queueKey = '';
    updateControls();
    return why;
  };
  const clearQueue = () => void queueAction('clear');
  // Droid's steering and queued lists are the truth; our receipts fill in text the narrow TUI cut short.
  const paintQueue = () => {
    queued.sync(worker.sessionId, history.entries);
    const rows = screen?.();
    const pending = rows ? readDroidPending(rows) : undefined;
    const steering = (pending?.items.filter((row) => row.group === 'steering') ?? []).map((row, i) => ({
      message: { key: `steer:${i}:${row.text}`, text: row.text, hasImage: false, preview: row.cut || row.more > 0, more: row.more },
      group: 'steering' as const,
      index: i + 1,
    }));
    const shownQueued = queued.shown(pending ? pending.items.filter((row) => row.group === 'queued') : undefined).map((message, i) => ({
      message,
      group: 'queued' as const,
      index: i + 1,
    }));
    if (queued.pending.length) localQueues.set(opts.queueKey, queued);
    else localQueues.delete(opts.queueKey);
    try {
      if (queued.pending.length) sessionStorage.setItem(opts.queueKey, JSON.stringify(queued));
      else sessionStorage.removeItem(opts.queueKey);
    } catch {}
    const items = [...steering, ...shownQueued];
    const canClear = connected && !cloud && items.length > 0;
    const key = JSON.stringify([items, canClear, queueActionBusy]);
    if (key === queueKey) return;
    queueKey = key;
    queuedBox.hidden = !items.length;
    const section = (group: 'steering' | 'queued', title: string, clear: boolean) => {
      const rowsInGroup = items.filter((item) => item.group === group);
      if (!rowsInGroup.length) return null;
      return h(
        'section.wt-queue-group',
        { 'aria-label': title },
        h('div.wt-queue-heading', {}, h('span', {}, title), clear && canClear ? h('button.wt-queue-clear', { type: 'button', title: 'Clear all pending messages', disabled: queueActionBusy, onclick: clearQueue }, 'Clear all') : null),
        ...rowsInGroup.map(({ message, index }) => {
          const more = message.more > 0 ? `${message.more} more line${message.more === 1 ? '' : 's'}` : message.preview ? 'Shortened' : message.hasImage && message.text ? 'Image attached' : '';
          const target = { index, group, ...(message.preview ? {} : { text: message.text }) };
          const action = (label: string, glyph: 'arrowUp' | 'x' | 'file', onclick: () => void) => h('button.wt-queue-action', { type: 'button', 'aria-label': label, title: label, disabled: queueActionBusy, onclick }, icon(glyph, 12));
          const actions = cloud
            ? null
            : h(
                'div.wt-queue-actions',
                {},
                group === 'queued' ? action('Send now', 'arrowUp', () => void queueAction('promote', target)) : null,
                !message.preview
                  ? action('Edit message', 'file', () => {
                      void queueAction('delete', target).then((why) => {
                        if (why) return;
                        input.value = message.text;
                        edited();
                        input.focus();
                      });
                    })
                  : null,
                action('Remove from queue', 'x', () => void queueAction('delete', target)),
              );
          return h('div.wt-entry.user.wt-queued-message', { 'data-queued': message.key }, h('div.wt-queue-line', {}, h('div.wt-user-text', {}, message.text || 'Image attached'), actions), more ? h('div.wt-queued-more', {}, more) : null);
        }),
      );
    };
    queuedBox.replaceChildren(
      ...[
        section('steering', 'Steering messages', true),
        section('queued', 'Queued messages', !items.some((item) => item.group === 'steering')),
        h('div.wt-queued-foot', {}, h('span', {}, `${items.length} message${items.length === 1 ? '' : 's'} queued`)),
      ].filter((node): node is HTMLElement => !!node),
    );
  };
  const notice = h('p.wt-notice', { role: 'status' });
  const limitsBar = h('div.wt-limits.row', { hidden: true }, h('button.btn.sm.ghost', { type: 'button', onclick: () => openFactoryLimits() }, 'Factory limits'));
  const retry = h(
    'button.btn.sm.hidden',
    {
      type: 'button',
      onclick: () => {
        error = '';
        read(undefined, 0);
      },
    },
    'Retry',
  );
  const raw = opts.raw && !cloud ? h('button.btn.sm', { type: 'button', onclick: opts.raw }, 'Open Raw TTY') : null;
  const resume = h(
    'button.btn.wt-resume',
    {
      type: 'button',
      onclick: async () => {
        if (resume.disabled) return;
        resuming = true;
        updateControls();
        error = (await opts.send({ t: 'worker.resume', workerId: worker.id })) ?? '';
        resuming = false;
        updateControls();
      },
    },
    'Resume',
  );

  // ---- Sticky Todo / Plan Progress Bar -----------------------------------------------------------
  let planExpanded = false;
  let planPaintKey = '';
  const planCountEl = h('span.wt-plan-count');
  const planCurrentEl = h('span.wt-plan-current');
  const planFillEl = h('div.wt-plan-fill');
  const planTrackEl = h('div.wt-plan-track', { 'aria-hidden': 'true' }, planFillEl);
  const planChevronEl = h('span.wt-chevron.wt-plan-chevron', { 'aria-hidden': 'true' }, icon('chevron', 14));
  const planStepsEl = h('ol.wt-plan-steps', { hidden: true });
  const planHeadBtn = h(
    'button.wt-plan-head',
    {
      type: 'button',
      'aria-expanded': 'false',
      onclick: () => {
        if (planHeadBtn.disabled) return;
        planExpanded = !planExpanded;
        paintPlan();
      },
    },
    planCountEl,
    planCurrentEl,
    planTrackEl,
    planChevronEl,
  );
  const planBar = h('div.wt-plan-bar', { hidden: true }, planHeadBtn, planStepsEl);

  const currentPlan = (): ActivePlan | undefined => {
    const busy = isBusy(worker.status);
    const fromEntries = latestThreadPlan(history.entries, busy);
    if (fromEntries) return fromEntries;
    if (worker.todos && !todosFinished(worker.todos)) {
      return {
        steps: [],
        done: worker.todos.done,
        total: worker.todos.total,
        ...(worker.todos.current ? { current: worker.todos.current } : {}),
        allDone: false,
        stale: false,
      };
    }
    return undefined;
  };

  const paintPlan = () => {
    const plan = worker.lost ? undefined : currentPlan();
    const visible = Boolean(plan && !plan.stale);
    const hasSteps = Boolean(plan?.steps.length);
    const expanded = visible && hasSteps && planExpanded;
    const key = JSON.stringify([visible, expanded, plan]);
    if (key === planPaintKey) return;
    planPaintKey = key;

    planBar.hidden = !visible;
    if (!visible || !plan) return;

    planBar.classList.toggle('is-open', expanded);
    planBar.classList.toggle('is-done', plan.allDone);
    planHeadBtn.disabled = !hasSteps;
    planHeadBtn.setAttribute('aria-expanded', String(expanded));
    planChevronEl.hidden = !hasSteps;

    planCountEl.textContent = `${plan.done}/${plan.total} completed`;
    const summaryText = plan.allDone ? 'All steps completed' : (plan.current ?? `${Math.max(0, plan.total - plan.done)} remaining`);
    planCurrentEl.textContent = summaryText;
    planCurrentEl.title = summaryText;

    const pct = plan.total > 0 ? Math.min(100, Math.max(0, (plan.done / plan.total) * 100)) : 0;
    planFillEl.style.setProperty('--pct', `${pct.toFixed(1)}%`);

    planStepsEl.hidden = !expanded;
    if (expanded) {
      planStepsEl.replaceChildren(
        ...plan.steps.map((step) => {
          const stateCls = step.done ? 'is-done' : step.active ? 'is-active' : 'is-pending';
          const glyph = step.done ? '✓' : step.active ? '●' : '○';
          return h(`li.wt-plan-step.${stateCls}` as `li.${string}`, {}, h('span.wt-plan-glyph', { 'aria-hidden': 'true' }, glyph), h('span.wt-plan-step-text', {}, step.text));
        }),
      );
    }
  };

  // ---- Composer, Slash Commands, and @file Workspace Mention Autocomplete ------------------------
  const input = h('textarea.wt-input', { rows: 1, maxlength: 20000, placeholder: `Reply to ${worker.name}…`, 'aria-label': `Message to ${worker.name}` });
  input.value = opts.draft;

  // Up and Down walk this conversation's prompts in the input, as Droid's prompt history does.
  let recallAt = -1;
  let recallDraft = '';
  const assist = attachComposerAssist({
    input,
    scope: () => ({
      floor: opts.floor,
      workerId: worker.id,
      slash: !cloud && worker.kind === 'agent',
      mentions: !cloud && worker.kind === 'agent' && !worker.lost,
    }),
    factoryConnected: () => store.factory.connection.connected && !store.factory.connection.rejected,
    onChange: (draft) => {
      recallAt = -1;
      opts.onDraft(draft);
      told = '';
      updateControls();
    },
  });
  const { mentionMenu, slashMenu, pasteChips } = assist;
  const draftText = () => assist.expand();

  const recall = (event: KeyboardEvent): boolean => {
    if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false;
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return false;
    if (input.selectionStart !== input.selectionEnd) return false;
    const caret = input.selectionStart ?? input.value.length;
    // Right after a recall the caret sits at the end and the arrows keep walking; inside the text they move it.
    const browsing = recallAt >= 0 && caret === input.value.length;
    if (!browsing) {
      if (event.key === 'ArrowUp' && input.value.slice(0, caret).includes('\n')) return false;
      if (event.key === 'ArrowDown' && (recallAt < 0 || input.value.slice(caret).includes('\n'))) return false;
    }
    const prompts = threadPrompts(history.entries);
    if (!prompts.length) return false;
    if (recallAt < 0) recallDraft = input.value;
    const next = recallPrompt(prompts, recallAt, event.key === 'ArrowUp' ? 'up' : 'down', recallDraft);
    input.value = next.text;
    edited();
    recallAt = next.index;
    input.setSelectionRange(next.text.length, next.text.length);
    return true;
  };

  const edited = () => {
    recallAt = -1;
    told = '';
    assist.onInput();
    opts.onDraft(draftText());
    updateControls();
  };
  input.addEventListener('input', edited);

  const images = promptImages(input, worker.id);
  const file = h('input.hidden', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', multiple: true, 'aria-label': 'Choose pictures' });
  file.addEventListener('change', () => {
    images.add([...(file.files ?? [])]);
    file.value = '';
  });
  const attach = h('button.btn.icon.sm.ghost.wt-attach', { type: 'button', 'aria-label': 'Add files and images', title: 'Add files and images', onclick: () => file.click() }, icon('plus', 15));
  const settingsUi = mountThreadSettings({
    workerId: () => worker.id,
    send: (msg) => opts.send(msg),
    told: (text) => {
      told = text;
      updateControls();
    },
  });
  const paintSettings = () => settingsUi.paint(liveView?.settings, !cloud && connected && worker.kind === 'agent');
  // Droid's side chat (/btw): its question and answer, over the composer until it is closed.
  const sideText = h('div.wt-side-text');
  const sideClose = h('button.btn.icon.sm.ghost', { type: 'button', 'aria-label': 'Close side chat', title: 'Close side chat  Esc', onclick: () => void closeSide() }, icon('x', 14));
  const sidePanel = h(
    'section.wt-side',
    { 'aria-label': 'Side chat', hidden: true },
    h('header.wt-side-head', {}, h('b', {}, 'Side chat'), h('span.wt-side-hint', {}, 'Ask a follow-up with /btw. It stays out of the conversation.'), sideClose),
    sideText,
  );
  const paintSide = () => {
    const side = liveView?.side;
    sidePanel.hidden = !side;
    if (side && sideText.textContent !== side.text) sideText.textContent = side.text || 'Thinking…';
  };
  const closeSide = async () => {
    const why = await opts.send({ t: 'worker.side', workerId: worker.id, close: true });
    if (why) {
      told = why;
      updateControls();
    }
  };
  // While a turn runs, Send steers it (Droid reads the message now) and Queue holds it for after the turn.
  const queue = h('button.btn.sm.wt-queue', { type: 'button', title: 'Send once this turn is over', onclick: () => void submit(true) }, 'Queue');
  const sendLabel = h('span', {}, 'Send');
  const send = h('button.btn.sm.primary.wt-send', { type: 'submit' }, sendLabel, icon('arrowUp', 14));
  const stop = h('button.btn.sm.wt-stop', { type: 'button', 'aria-label': 'Stop turn', title: 'Cancel  Esc', onclick: () => stopTurn() }, h('span.wt-stop-symbol', { 'aria-hidden': true }), h('span.wt-stop-label', {}, 'Stop'));
  const hint = h('span.wt-send-hint');
  const box = h('div.wt-compose-box', {}, images.element, pasteChips, input, h('div.wt-compose-bar', {}, attach, ...settingsUi.chips, hint, h('div.wt-send-buttons', {}, stop, queue, send)));
  box.addEventListener('click', (event) => {
    if (!input.disabled && event.target instanceof Element && !event.target.closest('button, .pimgs, textarea')) input.focus();
  });
  const form = h('form.wt-composer', {}, mentionMenu, slashMenu, settingsUi.menu, sidePanel, file, queuedBox, box);
  const progress = mountThreadStatusRow();
  const blockedText = h('p.wt-blocked-text');
  const blockedNote = h('div.wt-blocked.note.warn', { role: 'status', hidden: true }, icon('lock', 15), blockedText, opts.blockedAction ?? null);
  const element = h(
    'section.worker-thread',
    { 'aria-label': `${worker.name} thread` },
    teamSection,
    pin,
    search.element,
    scroll,
    latestAnchor,
    progress.element,
    h('div.wt-feedback', {}, notice, retry, raw, resume),
    limitsBar,
    blockedNote,
    planBar,
    form,
  );
  const applyViewPrefs = () => {
    for (const [name, value] of Object.entries(threadViewVars(threadViewPrefs()))) element.style.setProperty(name, value);
  };
  applyViewPrefs();
  element.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      search.open();
    }
  });
  if (!readOnly) images.dropZone(form);
  const detachQuote = attachQuoteReply(
    element,
    (_quote, text) => {
      const next = insertQuote(input.value, input.selectionStart ?? input.value.length, input.selectionEnd ?? input.value.length, text);
      if (!next) return;
      input.value = next.value;
      input.focus();
      input.setSelectionRange(next.cursor, next.cursor);
      edited();
    },
    () => active && !input.disabled && form.checkVisibility(),
  );

  const nodes = new Map<string, { key: string; node: HTMLElement; sourceIds: string[] }>();
  const expandedMessages = new Set<string>();
  const userToggles = new Map<string, boolean>();
  const expandedDiffs = new Set<string>();

  // Rows `content-visibility: auto` has rendered. Measuring inside a skipped one would lay it out
  // again, so a row's clamps and scroll cues are measured once the browser renders it instead.
  const tracksRows = 'oncontentvisibilityautostatechange' in list;
  const renderedRows = new WeakSet<Element>();
  const skipped = (el: Element) => {
    const row = el.closest('.wt-list > .wt-entry');
    return tracksRows && !!row && !renderedRows.has(row);
  };
  const updateClamps = (within: HTMLElement = element) => {
    const clamps: [HTMLButtonElement, boolean][] = [];
    for (const text of within.querySelectorAll<HTMLElement>('.wt-user-content')) {
      const button = text.parentElement?.nextElementSibling?.querySelector<HTMLButtonElement>('.wt-message-more');
      if (button instanceof HTMLButtonElement && !skipped(text)) clamps.push([button, text.classList.contains('clamped') && text.scrollHeight <= text.clientHeight + 1]);
    }
    const scrollCues: HorizontalScrollCueMeasurement[] = [];
    for (const frame of within.querySelectorAll<HTMLElement>('.wt-code-scroll')) {
      if (!skipped(frame)) {
        const measured = measureHorizontalScrollCue(frame);
        if (measured) scrollCues.push(measured);
      }
    }
    // Measure every row before changing any: a write between reads forces another layout per row.
    for (const [button, hidden] of clamps) if (button.hidden !== hidden) button.hidden = hidden;
    for (const cue of scrollCues) applyHorizontalScrollCue(cue);
  };
  list.addEventListener(
    'contentvisibilityautostatechange',
    (event) => {
      const row = event.target;
      if (!(row instanceof HTMLElement) || !row.matches('.wt-entry')) return;
      if ('skipped' in event && event.skipped === true) renderedRows.delete(row);
      else {
        renderedRows.add(row);
        updateClamps(row);
      }
    },
    true,
  );

  const showingIntro = () => !empty.hidden && empty.classList.contains('wt-intro') && streamNode.hidden && opts.question.hidden;
  let followingLayout = true;
  let viewportWidth = scroll.clientWidth;
  let viewportHeight = scroll.clientHeight;
  const resize = new ResizeObserver(() => {
    updateClamps();
    if (followingLayout && !inspecting && !history.historical && !showingIntro()) follow();
    viewportWidth = scroll.clientWidth;
    viewportHeight = scroll.clientHeight;
    updateLatest();
  });
  resize.observe(scroll);
  // Off-screen rows hold estimated heights until they render, so the transcript grows after a jump
  // to the bottom: keep following it.
  resize.observe(list);
  let inspecting = false;
  // While the pane shows the raw terminal the transcript is detached and measures 0×0, which reads as
  // "at the bottom": answer from where the reader was until it is back and laid out, and put a scrolled-up
  // reader back on the row they were reading. Detaching also drops the sizes `content-visibility: auto`
  // remembered, so every row would come back at its 160px estimate: pin each row's measured height first.
  let parked: { following: boolean; entry?: string; offset: number } | undefined;
  const atBottom = () => (parked ? parked.following : scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80);
  const readingSpot = (): NonNullable<typeof parked> => {
    if (followingLayout) return { following: true, offset: 0 };
    const top = scroll.getBoundingClientRect().top;
    for (const node of list.children) {
      const box = node.getBoundingClientRect();
      if (node instanceof HTMLElement && box.bottom > top) return { following: false, entry: node.dataset.entry, offset: box.top - top };
    }
    return { following: false, offset: 0 };
  };
  const holdRowHeights = () => {
    const rows = [...list.children].filter((el): el is HTMLElement => el instanceof HTMLElement);
    const heights = rows.map((row) => row.getBoundingClientRect().height);
    rows.forEach((row, index) => {
      if (heights[index]) row.style.setProperty('contain-intrinsic-block-size', `auto ${heights[index]}px`);
    });
  };
  /** False when the row is gone (a new session or reload while away). */
  const returnTo = (spot: NonNullable<typeof parked>) => {
    if (!spot.entry) return false;
    const top = scroll.getBoundingClientRect().top;
    for (const el of list.children) {
      if (el instanceof HTMLElement && el.dataset.entry === spot.entry) {
        scroll.scrollTop += el.getBoundingClientRect().top - top - spot.offset;
        return true;
      }
    }
    return false;
  };
  const follow = (quick = false) => {
    inspecting = false;
    followingLayout = true;
    if (showingIntro()) return;
    if (quick) motion.quick();
    else motion.snap();
    latest.classList.add('hidden');
  };
  const updateLatest = () => {
    if (showingIntro()) {
      latest.classList.add('hidden');
      return;
    }
    const distance = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
    latest.classList.toggle('hidden', !history.historical && !inspecting && distance <= 120);
    labelLatest(history.historical ? 'Back to the latest' : inspecting && atBottom() ? 'Follow latest' : 'Scroll to bottom');
  };
  const updatePin = () => {
    pinnedRow = undefined;
    pin.classList.add('hidden');
    if (history.historical || !received || scroll.scrollTop < 4) return;
    const top = scroll.getBoundingClientRect().top;
    let candidate: HTMLElement | undefined;
    for (const el of list.children) {
      if (!(el instanceof HTMLElement) || !el.matches('.wt-entry.user.text')) continue;
      if (el.getBoundingClientRect().top < top + 8) candidate = el;
      else break;
    }
    if (!candidate?.nextElementSibling) return;
    const text = candidate.querySelector('.wt-user-content')?.textContent?.trim() ?? '';
    if (!text) return;
    pinnedRow = candidate;
    pinText.textContent = text;
    pin.classList.remove('hidden');
  };
  let questionContent = '';
  const questionChanges = new MutationObserver(() => {
    const content = opts.question.textContent ?? '';
    if (content === questionContent) return;
    questionContent = content;
    if (active && needsOwnerInput(worker) && !opts.question.hidden) requestAnimationFrame(() => opts.question.scrollIntoView({ block: 'nearest' }));
  });
  questionChanges.observe(opts.question, { childList: true, subtree: true });
  let lastScrollTop = scroll.scrollTop;
  scroll.addEventListener('scroll', () => {
    const top = scroll.scrollTop;
    const delta = top - lastScrollTop;
    lastScrollTop = top;
    if (!showingIntro() && viewportWidth === scroll.clientWidth && viewportHeight === scroll.clientHeight) {
      const distance = scroll.scrollHeight - top - scroll.clientHeight;
      if ((delta < -1 && distance > 1) || distance > 80) followingLayout = false;
      else if (distance <= 16 && !inspecting) followingLayout = true;
    }
    updateLatest();
    updatePin();
  });
  scroll.addEventListener('click', (event) => {
    const toolTrigger = event.target instanceof Element ? event.target.closest('.wt-tr-trigger, .wt-sg-trigger') : null;
    if (toolTrigger?.getAttribute('aria-expanded') === 'true') {
      inspecting = true;
      followingLayout = false;
      updateLatest();
    }
    const summary = event.target instanceof Element ? event.target.closest('summary') : null;
    const details = summary?.parentElement;
    if (details instanceof HTMLDetailsElement && !details.open)
      requestAnimationFrame(() => {
        if (details.open) details.scrollIntoView({ block: 'nearest' });
      });
  });
  scroll.addEventListener(
    'toggle',
    (event) => {
      if (!(event.target instanceof HTMLDetailsElement)) return;
      const details = event.target;
      const expected = details.dataset.expectedOpen;
      if (expected !== undefined && String(details.open) === expected) return;
      details.dataset.expectedOpen = String(details.open);
      const key = details.dataset.disclosure;
      if (key) userToggles.set(key, details.open);
      if (details.open) {
        inspecting = true;
        followingLayout = false;
        latest.classList.remove('hidden');
        labelLatest(atBottom() ? 'Follow latest' : 'Scroll to bottom');
      }
      updateClamps(details);
    },
    true,
  );

  const chevron = () => h('span.wt-chevron', { 'aria-hidden': true }, icon('chevron', 14));
  const thought = (block: Extract<ThreadBlock, { kind: 'thought' }>, entry: ThreadEntry | undefined, toggles: ReadonlyMap<string, boolean>) => {
    const { thinking } = threadViewPrefs();
    if (thinking === 'hidden') return null;
    const label = thoughtLabel(entryTook(entry));
    const summary = h('summary', { 'aria-label': `Expand ${label}` }, h('span.wt-thought-label', {}, label), chevron());
    const details = h('details.wt-thinking', { 'data-disclosure': block.id }, summary, h('div.wt-thinking-text', {}, entry?.text ?? block.preview));
    details.addEventListener('toggle', () => summary.setAttribute('aria-label', `${details.open ? 'Collapse' : 'Expand'} ${label}`));
    return setDisclosureOpen(details, toggles.get(block.id) ?? (block.open || thinking === 'open'));
  };

  /** An entry's pictures, each opening at full size, read from `owner`'s session. A cloud worker's session has none here. */
  const pictures = (entry: ThreadEntry | undefined, title: string, about?: string, owner: WorkerInfo = worker) => {
    const imgs = !owner.cloud && opts.floor ? (entry?.images ?? []) : [];
    if (!imgs.length) return null;
    const gallery = imgs.map((image, i) => ({
      src: withToken(`/api/thread/image?${new URLSearchParams({ floor: opts.floor ?? '', worker: owner.id, image: image.id })}`),
      alt: imgs.length > 1 ? `${title} · ${i + 1} of ${imgs.length}` : title,
      description: [about, image.width && image.height ? `${image.width} × ${image.height}` : undefined].filter(Boolean).join(' · '),
      filename: `image.${image.type.substring('image/'.length).replace('jpeg', 'jpg')}`,
    }));
    return h(
      'div.wt-images',
      {},
      ...imgs.map((image, i) => {
        const { src, alt: name } = gallery[i];
        return h(
          'button.wt-image',
          { type: 'button', title: 'Open the picture', 'aria-label': `Open ${name}`, onclick: () => openImageLightbox(gallery, i) },
          h('img', { src, alt: name, loading: 'lazy', decoding: 'async', width: image.width, height: image.height, draggable: 'false' }),
        );
      }),
    );
  };

  interface RenderOptions {
    author?: WorkerInfo;
    expanded?: Set<string>;
    toggles?: Map<string, boolean>;
    diffs?: Set<string>;
    isLastRow?: boolean;
    turnEnd?: boolean;
  }

  const changesOf = (author: WorkerInfo) => (opts.openChanges && !author.cloud ? () => opts.openChanges?.(author.id) : undefined);

  /** A row, and below it what its turn changed when it is the turn's last. */
  const render = (row: ThreadRow, loaded: ReadonlyMap<string, ThreadEntry>, asking: boolean, renderOpts: RenderOptions = {}) => {
    const node = renderRow(row, loaded, asking, renderOpts);
    if (row.kind !== 'notice' && row.turnChanges) {
      const author = renderOpts.author ?? worker;
      node.append(renderTurnChanges(row.turnChanges, { floorDir: resolveFloorDir(), onOpenPath: onOpenPathFor(author), openChanges: changesOf(author) }));
      node.hidden = false;
    }
    return node;
  };

  /** A finished stretch of work as one disclosure: its summary line, and the steps inside. */
  const foldActivity = (node: HTMLElement, row: Extract<ThreadRow, { kind: 'activity' }>, toggles: ReadonlyMap<string, boolean>) => {
    const label = row.label;
    const summary = h('summary', { 'aria-label': `Expand ${label}` }, h('span.wt-fold-label', {}, label), chevron());
    const details = h('details.wt-activity', { 'data-disclosure': `fold:${row.id}` }, summary, h('div.wt-activity-body', {}, ...node.childNodes));
    details.addEventListener('toggle', () => summary.setAttribute('aria-label', `${details.open ? 'Collapse' : 'Expand'} ${label}`));
    node.append(setDisclosureOpen(details, toggles.get(`fold:${row.id}`) ?? false));
    return node;
  };

  // While the worker waits on the owner, its run isn't working: the question card says what it's on.
  const renderRow = (row: ThreadRow, loaded: ReadonlyMap<string, ThreadEntry>, asking: boolean, renderOpts: RenderOptions = {}) => {
    const author = renderOpts.author ?? worker;
    const expanded = renderOpts.expanded ?? expandedMessages;
    const toggles = renderOpts.toggles ?? userToggles;
    const diffs = renderOpts.diffs ?? expandedDiffs;

    const node = h('article.wt-entry', { 'data-entry': row.id });
    const openChanges = changesOf(author);
    if (row.kind === 'activity') {
      node.setAttribute('data-response-message-id', row.id);
      const cardCtx: ThreadCardRenderContext = {
        owner: author,
        floorDir: resolveFloorDir(),
        userToggles: toggles,
        expandedDiffs: diffs,
        onOpenPath: onOpenPathFor(author),
        team: opts.team?.(),
        openWorker: opts.openWorker,
        pictures,
        onLayoutChange: () => updateLatest(),
        openChanges,
        ...(opts.sendToWhiteboard && canOpenFiles(author) ? { sendToWhiteboard: (path: string) => opts.sendToWhiteboard?.(author.id, path) } : {}),
      };
      const { work, tools } = threadViewPrefs();
      renderThreadActivity(node, row, loaded, asking, { ...cardCtx, thought: (block, entry) => thought(block, entry, toggles), live: (id) => liveTools.get(id), toolsOpen: tools === 'open' });
      // Hidden thinking can leave a stretch of nothing but thoughts with nothing to show: no fold, and no row to take a gap in the list.
      if (!node.childElementCount) {
        node.hidden = true;
        return node;
      }
      // The live stretch and one the worker is asking in stay as steps; the fold is for work that is done.
      return work === 'fold' && !row.live && !asking ? foldActivity(node, row, toggles) : node;
    }

    node.classList.add(row.role, row.kind === 'message' ? 'text' : 'notice');
    if (row.kind === 'notice') {
      const compaction = loaded.get(row.id)?.name === 'compaction' || row.id.startsWith('compaction:');
      if (compaction) {
        node.append(h('div.wt-compact-divider', { role: 'separator' }, h('span', {}, 'Compacted')));
        return node;
      }
      const imgs = row.tone === 'attachment' ? pictures(loaded.get(row.id), row.role === 'user' ? 'Picture you sent' : `Picture from ${author.name}`, undefined, author) : null;
      node.append(imgs ?? h('p.wt-turn', { class: row.tone }, row.text));
      return node;
    }

    const entry = loaded.get(row.id);
    const text = entry?.text ?? '';
    if (row.role === 'assistant') {
      if (row.startsTurn) {
        const dot = h('span.wt-who-dot', { 'aria-hidden': 'true' });
        dot.style.setProperty('--who', author.color);
        node.append(h('div.wt-who', {}, dot, author.name));
      }
      const streaming = isBusy(author.status) && Boolean(renderOpts.isLastRow);
      const body = threadMarkdown(text, {
        key: row.id,
        streaming,
        onOpenPath: onOpenPathFor(author),
        ...(canOpenFiles(author) ? { imageUrl: (path: string) => threadFileImageUrl({ floor: opts.floor ?? '', workerId: author.id, path }) } : {}),
      });
      node.append(body);
      if (renderOpts.turnEnd) node.append(threadMessageActions({ text: () => text, at: entryAt(entry) }));
      return node;
    }

    // The pictures sent with the prompt, above its text, in place of where the office kept them.
    node.setAttribute('data-response-message-id', row.id);
    const sent = pictures(entry, 'Picture you sent', undefined, author);
    if (sent) node.append(sent);
    if (sent && !text.trim()) return node;
    const userMd = threadUserMarkdown(text);
    while (userMd.lastChild?.nodeType === Node.TEXT_NODE && !userMd.lastChild.textContent?.trim()) {
      userMd.lastChild.remove();
    }
    const content = h('div.wt-user-content', { id: `wt-message-${author.id}-${row.id}`, class: expanded.has(row.id) ? '' : 'clamped' }, userMd);
    const more = h(
      'button.btn.sm.ghost.wt-message-more',
      {
        type: 'button',
        'aria-expanded': String(expanded.has(row.id)),
        'aria-controls': content.id,
        onclick: () => {
          const on = !expanded.has(row.id);
          if (on) expanded.add(row.id);
          else expanded.delete(row.id);
          content.classList.toggle('clamped', !on);
          more.setAttribute('aria-expanded', String(on));
          more.textContent = on ? 'Show less' : 'Show all';
          updateClamps();
        },
      },
      expanded.has(row.id) ? 'Show less' : 'Show all',
    );
    node.append(h('div.wt-user-text', {}, content));
    node.append(
      threadMessageActions({
        text: () => text,
        at: entryAt(entry),
        more,
        ...(author.id === worker.id && !cloud && !readOnly ? { rewind: () => rewindConversation(row.id) } : {}),
      }),
    );
    return node;
  };

  const teamNodes = new Map<
    string,
    {
      sessionId?: string;
      element: HTMLDetailsElement;
      name: HTMLElement;
      status: HTMLElement;
      activity: HTMLElement;
      body: HTMLElement;
      note: HTMLElement;
      open: HTMLButtonElement;
      expanded: Set<string>;
      toggles: Map<string, boolean>;
      diffs: Set<string>;
      rows: Map<string, { key: string; node: HTMLElement }>;
    }
  >();
  teamBody.addEventListener(
    'toggle',
    (event) => {
      if (!(event.target instanceof HTMLDetailsElement)) return;
      const details = event.target;
      const expected = details.dataset.expectedOpen;
      if (expected !== undefined && String(details.open) === expected) return;
      details.dataset.expectedOpen = String(details.open);
      const key = details.dataset.disclosure;
      if (!key) return;
      for (const card of teamNodes.values()) {
        if (card.element.contains(details)) {
          card.toggles.set(key, details.open);
          break;
        }
      }
      updateClamps(details);
    },
    true,
  );

  const paintTeam = (force = false) => {
    if (disposed || !teamPaint.changed(team.revision, connected, teamSection.open, active && !document.hidden && element.isConnected, force)) return;
    // The rollup is a sibling of the conversation. Only a size change can affect its viewport.
    const height = teamSection.offsetHeight;
    const top = scroll.scrollTop;
    const teamTop = teamBody.scrollTop;
    teamSection.hidden = team.total === 0;
    teamTitle.textContent = `Team activity · ${team.total}`;
    teamLimit.hidden = team.total <= team.members.size;
    teamLimit.textContent = `Showing ${team.members.size} of ${team.total} workers. Open other threads from the worker list.`;
    for (const [id, card] of teamNodes) {
      const member = team.members.get(id);
      if (!member || member.worker.sessionId !== card.sessionId) {
        const focused = card.element.contains(document.activeElement);
        card.element.remove();
        teamNodes.delete(id);
        if (focused) teamSection.querySelector('summary')?.focus({ preventScroll: true });
      }
    }
    const rosterKey = (opts.team?.() ?? []).map((w) => `${w.id}:${w.name}:${w.lead ?? ''}`).join(',');
    const viewKey = threadViewRowKey(threadViewPrefs());
    for (const [id, member] of team.members) {
      const child = member.worker;
      let card = teamNodes.get(id);
      if (!card) {
        const name = h('span.wt-team-name');
        const status = h('span.pill');
        const activity = h('span.wt-team-latest');
        const body = h('div.wt-team-entries');
        const note = h('p.wt-team-note');
        const open = h('button.btn.sm', { type: 'button', onclick: () => opts.openWorker?.(id) }, 'Open thread');
        const memberEl = h(
          'details.wt-team-member',
          {},
          h('summary', {}, h('span.wt-team-who', {}, name, activity), status, h('span.wt-chevron', { 'aria-hidden': true }, icon('chevron', 14))),
          h('div.wt-team-content', {}, h('div.wt-team-actions', {}, open), body, note),
        );
        card = { sessionId: child.sessionId, element: memberEl, name, status, activity, body, note, open, expanded: new Set(), toggles: new Map(), diffs: new Set(), rows: new Map() };
        teamNodes.set(id, card);
        teamBody.append(memberEl);
      }
      card.name.textContent = child.name;
      card.name.title = child.name;
      card.status.className = `pill ${child.status}`;
      card.status.hidden = !connected;
      card.status.textContent = isAsleep(child.status) ? 'Asleep' : (STATUS_LABEL[child.status] ?? child.status);
      card.open.disabled = !connected || !opts.openWorker;
      const rows = member.history.rows.slice(-4);
      const loaded = new Map(member.history.entries.map((entry) => [entry.id, entry]));
      const last = rows.at(-1);
      const activity = child.activity || (last?.kind === 'activity' ? last.label : last?.kind === 'message' ? loaded.get(last.id)?.text : last?.text) || child.title || 'No recent activity';
      card.activity.textContent = activity.split('\n')[0].slice(0, 200);
      card.activity.title = card.activity.textContent;
      if (member.error) card.note.textContent = `Conversation unavailable: ${member.error}`;
      else if (child.lost) card.note.textContent = 'This worker’s checkout is unavailable.';
      else if (!child.sessionId) card.note.textContent = 'Waiting for a local session…';
      else if (!member.received) card.note.textContent = teamSection.open ? 'Reading the conversation…' : 'Expand Team activity to read recent messages and tools.';
      else card.note.textContent = rows.length ? 'Recent activity only. Open the worker thread for more messages and recorded patches.' : 'No conversation recorded yet.';
      const keep = new Set(rows.map((row) => row.id));
      const selection = document.getSelection();
      const pinned = new Set<string>();
      for (const [rowId, item] of card.rows) {
        if (!keep.has(rowId)) {
          if (item.node.contains(document.activeElement) || (selection?.isCollapsed === false && item.node.contains(selection.anchorNode))) {
            pinned.add(rowId);
            continue;
          }
          item.node.remove();
          card.rows.delete(rowId);
        }
      }
      const messageIds = new Set(member.history.entries.map((entry) => entry.id));
      for (const entryId of card.expanded) if (!messageIds.has(entryId)) card.expanded.delete(entryId);
      let at = card.body.firstElementChild;
      // At most one focused and one selected old row stay above the four newest rows.
      while (at && pinned.has(at.getAttribute('data-entry') ?? '')) at = at.nextElementSibling;
      for (const row of rows) {
        const isLastRow = row === last;
        const streamFlag = isLastRow && row.kind === 'message' && row.role === 'assistant' && isBusy(child.status);
        const key = JSON.stringify([row, child.status === 'needs_input', child.name, streamFlag, hasDelegateCard(row) ? rosterKey : '', rowContent(row, loaded), viewKey]);
        let had = card.rows.get(row.id);
        // Don't discard text while the owner is selecting a command or patch to copy.
        if (!had || (had.key !== key && (selection?.isCollapsed !== false || !had.node.contains(selection.anchorNode)))) {
          const focused = document.activeElement;
          const focus = focused instanceof HTMLElement && had?.node.contains(focused) ? focused : undefined;
          const disclosure = focus?.closest<HTMLDetailsElement>('details[data-disclosure]')?.dataset.disclosure;
          const control = focus?.matches('.wt-message-more') ? '.wt-message-more' : undefined;
          const node = render(row, loaded, child.status === 'needs_input', {
            author: child,
            expanded: card.expanded,
            toggles: card.toggles,
            diffs: card.diffs,
            isLastRow,
          });
          const positions = [...(had?.node.querySelectorAll<HTMLElement>('pre, .wt-horizontal-content') ?? [])].map((content) => [content.scrollTop, content.scrollLeft]);
          had?.node.replaceWith(node);
          if (focus && !focus.isConnected) {
            const target = control
              ? node.querySelector<HTMLElement>(control)
              : [...node.querySelectorAll<HTMLDetailsElement>('details[data-disclosure]')].find((details) => details.dataset.disclosure === disclosure)?.querySelector('summary');
            target?.focus({ preventScroll: true });
          }
          [...node.querySelectorAll<HTMLElement>('pre, .wt-horizontal-content')].forEach((content, index) => {
            content.scrollTop = positions[index]?.[0] ?? 0;
            content.scrollLeft = positions[index]?.[1] ?? 0;
          });
          had = { key, node };
          card.rows.set(row.id, had);
          if (at?.getAttribute('data-entry') === row.id) at = node;
        }
        if (had.node === at) at = at.nextElementSibling;
        else card.body.insertBefore(had.node, at);
      }
    }
    if (teamSection.open) updateClamps(teamSection);
    if (teamBody.scrollTop !== teamTop) teamBody.scrollTop = teamTop;
    if (teamSection.offsetHeight !== height && scroll.scrollTop !== top) scroll.scrollTop = top;
  };

  const syncWatch = () => {
    if (!connected) {
      watchedWorkerId = '';
      hasPushed = false;
      return;
    }
    const wantWatch = active && !disposed && !document.hidden && (Boolean(worker.sessionId) || !opts.intro?.());
    if (!wantWatch) {
      if (watchedWorkerId) {
        net.send({ t: 'thread.watch', workerId: watchedWorkerId, on: false });
        watchedWorkerId = '';
      }
      return;
    }
    if (watchedWorkerId && watchedWorkerId !== worker.id) {
      net.send({ t: 'thread.watch', workerId: watchedWorkerId, on: false });
      watchedWorkerId = '';
    }
    if (watchedWorkerId !== worker.id && net.send({ t: 'thread.watch', workerId: worker.id, on: true })) {
      watchedWorkerId = worker.id;
    }
  };

  const syncAttach = () => {
    if (!connected && !net.up) {
      attachedWorkerId = '';
      return;
    }
    const wantAttach = active && !disposed && !document.hidden;
    if (!wantAttach) {
      if (attachedWorkerId) {
        net.send({ t: 'worker.detach', workerId: attachedWorkerId });
        attachedWorkerId = '';
      }
      return;
    }
    if (attachedWorkerId && attachedWorkerId !== worker.id) {
      net.send({ t: 'worker.detach', workerId: attachedWorkerId });
      attachedWorkerId = '';
    }
    if (attachedWorkerId !== worker.id && net.send({ t: 'worker.attach', workerId: worker.id, stream: false })) {
      attachedWorkerId = worker.id;
    }
  };

  const syncTeam = () => {
    team.sync(`${opts.queueKey}:${worker.id}:${worker.sessionId ?? ''}`, worker.id, opts.team?.() ?? []);
    team.enable(teamThreadVisible(active && !disposed, connected, !document.hidden && element.isConnected, teamSection.open));
    if (connected) team.syncWatches((msg) => net.send(msg));
    else team.resetWatches();
  };
  const readTeam = () => {
    if (!opts.team || disposed) return;
    syncTeam();
    team.read(
      Date.now(),
      (msg) => net.send(msg),
      () => `team-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    );
    paintTeam();
  };
  const teamDisclosure = (event: Event) => {
    if (event.target === teamSection) readTeam();
    else paintTeam(true);
  };
  const teamFocus = () => queueMicrotask(() => paintTeam(true));
  let teamSelected = false;
  const teamSelection = () => {
    const selection = document.getSelection();
    const selected = selection?.isCollapsed === false && teamSection.contains(selection.anchorNode);
    if (selected || teamSelected) paintTeam(true);
    teamSelected = selected;
  };
  teamSection.addEventListener('toggle', teamDisclosure, true);
  teamSection.addEventListener('focusout', teamFocus);
  document.addEventListener('selectionchange', teamSelection);
  let emptyKey = '';
  const introNow = () => (history.entries.length ? undefined : opts.intro?.());
  const paintEmpty = () => {
    const starting = threadStarting(worker);
    const cloudWaiting = received && cloudStarting(worker, Date.now());
    const intro = introNow();
    const key = JSON.stringify([error, received, starting, cloudWaiting, connected, !!intro]);
    if (key === emptyKey) return;
    emptyKey = key;
    const enteringIntro = !!intro && !empty.classList.contains('wt-intro');
    empty.classList.toggle('wt-intro', !!intro);
    if (intro) empty.removeAttribute('role');
    else empty.setAttribute('role', 'status');
    empty.setAttribute('aria-busy', String(!intro && connected && !error && !received));
    if (intro) empty.replaceChildren(intro);
    else if (error) empty.textContent = `Conversation unavailable. Retry below, or ${fallback}.`;
    else if (!connected) empty.textContent = 'Waiting for the office to reconnect…';
    else if (!received)
      empty.replaceChildren(
        h('span.spinner.wt-loading-spinner', { 'aria-hidden': true }),
        h('b', {}, starting ? 'Starting worker…' : 'Reading the conversation…'),
        h('p', {}, starting ? 'Preparing the workspace and starting Droid. This can take a moment.' : 'Messages will appear here as soon as they’re ready.'),
      );
    else if (cloudWaiting)
      empty.replaceChildren(h('span.spinner.wt-loading-spinner', { 'aria-hidden': true }), h('b', {}, `Starting on ${worker.cloud?.computerName}…`), h('p', {}, 'Its messages appear here as Factory lists them, a few seconds behind.'));
    else empty.replaceChildren(h('span.wt-empty-mark', { 'aria-hidden': true }), h('b', {}, 'No messages yet. Start a conversation!'));
    if (enteringIntro) {
      motion.cancel();
      inspecting = false;
      followingLayout = true;
      scroll.scrollTop = 0;
    }
  };

  const paintLive = () => {
    const stream = liveView?.stream;
    const current = !!liveView && liveView.after !== undefined && liveView.after === history.entries.at(-1)?.id && !history.historical;
    const showStream = active && connected && current && liveView?.status !== 'idle' && !!stream;
    const pendingTools = active && connected && current ? (liveView?.tools.filter((tool) => !tool.id) ?? []) : [];
    streamNode.hidden = !showStream && !pendingTools.length;
    streamNode.className = streamNode.hidden ? 'wt-stream' : 'wt-entry assistant text wt-stream';
    if (streamNode.hidden) return;
    const thinkingHidden = threadViewPrefs().thinking === 'hidden';
    const structureKey = JSON.stringify([showStream ? [stream?.kind, stream?.since] : undefined, pendingTools.map((tool) => [tool.name, tool.output, tool.more]), thinkingHidden]);
    const textKey = showStream && stream ? stream.text : '';
    if (streamNode.dataset.liveStructure !== structureKey) {
      streamNode.dataset.liveStructure = structureKey;
      streamNode.dataset.liveText = textKey;
      const children: HTMLElement[] = [];
      if (showStream && stream) {
        if (stream.kind === 'thinking') {
          const time = h('span.wt-live-time.wt-thought-duration', { 'data-since': stream.since }, `for ${thinkingSeconds(Date.now() - (liveView?.skew ?? 0) - stream.since)}`);
          children.push(
            h(
              'details.wt-thinking.wt-live-thinking',
              { open: !thinkingHidden, class: thinkingHidden ? 'is-textless' : '' },
              h('summary', {}, h('span.wt-thought-label.wt-shimmer', {}, 'Thinking'), time, chevron()),
              thinkingHidden ? null : h('div.wt-thinking-text', {}, stream.text),
            ),
          );
        } else {
          children.push(h('div.wt-stream-copy', {}, ...stream.text.split(/\n{2,}/).map((paragraph) => h('p', {}, paragraph))));
        }
      }
      for (const tool of pendingTools) {
        children.push(
          h(
            'div.wt-live-tool',
            {},
            h('span.spinner', { 'aria-hidden': 'true' }),
            h('span.wt-live-tool-name', {}, tool.name),
            h('span.wt-live-time', { 'data-since': tool.startedAt }, thinkingSeconds(Date.now() - (liveView?.skew ?? 0) - tool.startedAt)),
            tool.output ? h('pre.wt-live-tool-output', {}, tool.output) : null,
            tool.more ? h('span.wt-live-tool-more', {}, `... ${tool.more} more`) : null,
          ),
        );
      }
      streamNode.replaceChildren(...children);
    } else if (streamNode.dataset.liveText !== textKey && showStream && stream) {
      streamNode.dataset.liveText = textKey;
      if (stream.kind === 'thinking') {
        const body = streamNode.querySelector<HTMLElement>('.wt-thinking-text');
        if (body) body.textContent = stream.text;
      } else {
        const copy = streamNode.querySelector<HTMLElement>('.wt-stream-copy');
        copy?.replaceChildren(...stream.text.split(/\n{2,}/).map((paragraph) => h('p', {}, paragraph)));
      }
    }
    for (const el of streamNode.querySelectorAll<HTMLElement>('.wt-live-time[data-since]')) {
      const since = Number(el.dataset.since);
      const elapsed = thinkingSeconds(Date.now() - (liveView?.skew ?? 0) - since);
      const text = el.classList.contains('wt-thought-duration') ? `for ${elapsed}` : elapsed;
      if (el.textContent !== text) el.textContent = text;
    }
  };

  const rowJson = new WeakMap<object, string>();
  const paintEntries = (older: boolean) => {
    const stick = !received || (!older && (showingIntro() || (!inspecting && atBottom())));
    const top = scroll.scrollTop;
    const height = scroll.scrollHeight;
    const want: HTMLElement[] = [];
    const changedNodes: HTMLElement[] = [];
    const keep = new Set<string>();
    const focused = document.activeElement;
    const focusedDisclosure = focused instanceof HTMLElement && focused.matches('summary') && list.contains(focused) ? focused.parentElement?.dataset.disclosure : undefined;
    const rows = history.rows;
    const lastRow = rows.at(-1);
    const loaded = new Map(history.entries.map((entry) => [entry.id, entry]));
    const asking = worker.status === 'needs_input';
    const rosterKey = (opts.team?.() ?? []).map((w) => `${w.id}:${w.name}:${w.lead ?? ''}`).join(',');
    const viewKey = threadViewRowKey(threadViewPrefs());

    for (const [rowIndex, row] of rows.entries()) {
      const isLastRow = row === lastRow;
      const nextRow = rows[rowIndex + 1];
      const nextRole = nextRow && 'role' in nextRow ? nextRow.role : 'assistant';
      const turnEnd = row.kind === 'message' && row.role === 'assistant' && nextRole !== 'assistant';
      const streamFlag = isLastRow && row.kind === 'message' && row.role === 'assistant' && isBusy(worker.status);
      let rowSerialized = rowJson.get(row);
      if (rowSerialized === undefined) {
        rowSerialized = JSON.stringify(row);
        rowJson.set(row, rowSerialized);
      }
      const key = `${rowSerialized}|${asking}|${streamFlag}|${turnEnd}|${hasDelegateCard(row) ? rosterKey : ''}|${JSON.stringify(rowContent(row, loaded))}|${viewKey}`;
      let had = nodes.get(row.id);
      if (!had || had.key !== key) {
        const groupPositions = new Map(
          [...(had?.node.querySelectorAll<HTMLElement>('.wt-sg-scroll') ?? [])].map((content) => [content.closest<HTMLElement>('[data-disclosure]')?.dataset.disclosure, { top: content.scrollTop, touched: content.dataset.touched }]),
        );
        const positions = [...(had?.node.querySelectorAll<HTMLElement>('pre, .wt-horizontal-content') ?? [])].map((content) => [content.scrollTop, content.scrollLeft]);
        const node = render(row, loaded, asking, { isLastRow, turnEnd });
        for (const content of node.querySelectorAll<HTMLElement>('.wt-sg-scroll')) {
          const position = groupPositions.get(content.closest<HTMLElement>('[data-disclosure]')?.dataset.disclosure);
          if (position) {
            if (position.touched) content.dataset.touched = position.touched;
            if (position.touched || !content.closest('.wt-sg.is-live'))
              requestAnimationFrame(() => {
                if (content.isConnected) content.scrollTop = position.top;
              });
          }
        }
        if (!had && paintedOnce && !older) {
          node.classList.add('wt-enter');
          node.addEventListener('animationend', () => node.classList.remove('wt-enter'), { once: true });
        }
        [...node.querySelectorAll<HTMLElement>('pre, .wt-horizontal-content')].forEach((content, index) => {
          content.scrollTop = positions[index]?.[0] ?? 0;
          content.scrollLeft = positions[index]?.[1] ?? 0;
        });
        had = { key, node, sourceIds: row.kind === 'activity' ? row.sourceIds : [] };
        nodes.set(row.id, had);
        changedNodes.push(node);
      }
      keep.add(row.id);
      want.push(had.node);
    }
    for (const id of nodes.keys()) if (!keep.has(id)) nodes.delete(id);
    for (const id of expandedMessages) if (!keep.has(id)) expandedMessages.delete(id);
    let at = list.firstElementChild;
    for (const node of want) {
      if (node === at) at = at.nextElementSibling;
      else list.insertBefore(node, at);
    }
    while (at) {
      const next = at.nextElementSibling;
      at.remove();
      at = next;
    }
    for (const node of changedNodes) updateClamps(node);
    if (focusedDisclosure && focused && !focused.isConnected) {
      [...list.querySelectorAll<HTMLDetailsElement>('details[data-disclosure]')]
        .find((el) => el.dataset.disclosure === focusedDisclosure)
        ?.querySelector('summary')
        ?.focus({ preventScroll: true });
    }
    earlier.classList.toggle('hidden', !history.hasMore);
    labelLatest(history.historical ? 'Back to the latest' : 'Scroll to bottom');
    empty.hidden = rows.length > 0;
    paintEmpty();
    paintPlan();
    if (showingIntro()) updateLatest();
    else if (stick) {
      if (paintedOnce && !older && followingLayout) motion.follow();
      else follow();
    } else if (older) scroll.scrollTop = top + scroll.scrollHeight - height;
    else updateLatest();
    if (history.historical) latest.classList.remove('hidden');
    paintedOnce = true;
    paintLive();
    updatePin();
    search.refresh();
    refreshMessageTimes(element);
  };

  let waitingShown = false;
  // One stable signal outside the scrolling transcript, including gaps between recorded messages.
  // The JSONL isn't a token stream: don't infer "Thinking" or "Generating" from its last entry.
  const paintProgress = () => {
    const show = active && connected && !disposed && !document.hidden && !worker.lost && !error && isBusy(worker.status);
    const label = !show ? '' : worker.status === 'starting' ? 'Starting worker…' : worker.status === 'needs_input' ? 'Waiting for you' : 'Working…';
    const last = history.rows.at(-1);
    const detail = show && worker.status === 'working' && !history.historical && history.sessionId === worker.sessionId && last?.kind === 'activity' && last.live ? (last.running ?? '') : '';
    progress.paint({ show, running: show && worker.status !== 'needs_input', label, mode: statusMode(liveView?.status, worker.status), detail: liveView?.label || detail });
  };

  const updateControls = () => {
    const broken = worker.cloud?.error;
    const blocked = opts.blocked?.();
    const allowed = !readOnly && active && connected && !disposed && (opts.promptWakes || !isAsleep(worker.status)) && !worker.lost && !broken && !blocked;
    const waiting = worker.status === 'needs_input';
    const factoryOnline = store.factory.connection.connected && !store.factory.connection.rejected;
    limitsBar.hidden = readOnly || !waiting || !active || disposed || !connected || !!worker.lost || !!broken || !!blocked || !factoryOnline;
    form.hidden = readOnly || waiting || !!blocked;
    blockedNote.hidden = !blocked;
    blockedText.textContent = blocked ?? '';
    if (needsOwnerInput(worker) && !waitingShown) requestAnimationFrame(() => opts.question.scrollIntoView({ block: 'nearest' }));
    waitingShown = waiting;
    input.disabled = !allowed || sending || waiting;
    if (input.disabled) {
      assist.paintSlash();
      assist.closeMention();
      settingsUi.close();
    }
    attach.disabled = input.disabled;
    const busy = isBusy(worker.status);
    send.disabled = input.disabled;
    send.hidden = (busy || waiting) && !input.value.trim() && !images.ids().length;
    // Factory holds a cloud worker's message until its turn is over: there's nothing to steer with.
    queue.hidden = !busy || cloud;
    queue.disabled = input.disabled || !received || !!slashOf(input.value) || queueActionBusy;
    stop.hidden = !busy && !waiting;
    stop.disabled = !allowed || sending || stopping;
    const label = sending ? 'Sending…' : busy ? (cloud ? 'Queue' : 'Send now') : 'Send';
    sendLabel.textContent = label;
    send.classList.toggle('icon', !sending && !busy);
    send.setAttribute('aria-label', busy || sending ? label : 'Send message');
    send.title = busy ? (cloud ? `Sent to ${worker.name} once this turn is over` : `Steer ${worker.name}: it reads this now, during the turn`) : 'Send ⏎';
    const placeholder = () => {
      if (broken) return `${worker.name} can’t take messages`;
      if (waiting) return 'Respond to the questionnaire above...';
      if (!worker.sessionId && !opts.promptWakes) return 'Waiting for session...';
      if (introNow()) return `Tell ${worker.name} what you want done…`;
      if (busy) return 'Send follow-up  ·  Ctrl+Enter to queue for later';
      return 'Type your message...';
    };
    input.placeholder = placeholder();
    if (cloud) hint.replaceChildren(shortcut('Enter', busy ? 'queue' : 'send'), shortcut('⇧ Enter', 'new line'));
    else if (busy) hint.replaceChildren(shortcut('Enter', 'steer'), shortcut('Ctrl Enter', 'queue'), shortcut('⇧ Enter', 'new line'));
    else if (worker.kind === 'agent') hint.replaceChildren(shortcut('Enter', 'send'), shortcut('⇧ Enter', 'new line'), shortcut('@', 'files'), shortcut('/', 'commands'));
    else hint.replaceChildren(shortcut('Enter', 'send'), shortcut('⇧ Enter', 'new line'), shortcut('/', 'commands'));
    earlier.disabled = !!pending || !connected;
    retry.classList.toggle('hidden', !error);
    retry.disabled = !connected || !!pending;
    empty.classList.toggle('error', !!error && !history.entries.length);
    if (!history.entries.length) paintEmpty();
    notice.textContent = connected
      ? error || told || (broken && !opts.cloudErrorShown ? `${worker.name} can’t work: ${broken}` : '') || (isAsleep(worker.status) && !opts.promptWakes && !readOnly ? 'Resume this worker to send another message.' : '')
      : '';
    raw?.classList.toggle('hidden', !connected || !error);
    // A cloud worker's Resume reads its Factory session again, which is also how one that broke is checked.
    resume.hidden = readOnly || ((!isAsleep(worker.status) || !!opts.promptWakes) && !broken);
    resume.disabled = !active || !connected || !!worker.lost || resuming;
    resume.textContent = broken ? (resuming ? 'Checking…' : 'Check again') : resuming ? 'Resuming…' : 'Resume';
    element.classList.toggle('has-feedback', !!notice.textContent);
    paintPlan();
    paintQueue();
    paintSettings();
    paintProgress();
  };

  const read = (before?: number, minIntervalMs = 1000) => {
    if (!active || !connected || disposed || document.hidden || pending) return;
    if (threadStarting(worker) && !worker.sessionId) return;
    if (!worker.sessionId && opts.intro?.()) return;
    if (before === undefined && history.historical) return;
    if (before === undefined && minIntervalMs > 0 && Date.now() - lastReadAt < minIntervalMs) return;
    const request = `thread-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    if (net.send({ t: 'thread.read', workerId: worker.id, request, ...(before !== undefined ? { before } : {}) })) {
      lastReadAt = Date.now();
      if (startupReadUntil === Infinity) startupReadUntil = lastReadAt + 8000;
      pending = { request, before, at: lastReadAt };
    }
    updateControls();
  };

  const receive = (msg: ServerMsg) => {
    if (disposed) return;
    if (msg.t === 'welcome' || msg.t === 'floors') {
      floorDirs.clear();
      for (const f of msg.floors) floorDirs.set(f.id, f.dir);
    }
    const nextLive = liveFrom(msg, worker.id, worker.sessionId, liveView);
    if (nextLive) {
      const stick = received && !inspecting && atBottom();
      liveView = nextLive;
      liveTools.clear();
      for (const tool of nextLive.tools) if (tool.id) liveTools.set(tool.id, tool);
      refreshLiveOutput(element, (id) => liveTools.get(id));
      paintLive();
      paintSettings();
      paintSide();
      paintProgress();
      if (stick) motion.follow();
      return;
    }
    const rewound = msg;
    if (rewound.t === 'worker.rewound' && rewound.workerId === worker.id) {
      if (rewound.ok) {
        history.clear(worker.sessionId);
        nodes.clear();
        list.replaceChildren();
        received = false;
        liveView = undefined;
        liveTools.clear();
        if (rewound.text) {
          input.value = rewound.text;
          edited();
        }
        if (rewound.note) told = rewound.note;
        read(undefined, 0);
      } else {
        told = rewound.error ?? 'Failed to rewind conversation';
        updateControls();
      }
      return;
    }
    if (msg.t === 'thread.snapshot' && msg.child) return;
    if (msg.t === 'floor.enter' || msg.t === 'welcome') {
      if (msg.t === 'welcome' || watchedWorkerId !== ORCHESTRATOR_ID) {
        watchedWorkerId = '';
        hasPushed = false;
      }
      if (msg.t === 'welcome' || attachedWorkerId !== ORCHESTRATOR_ID) attachedWorkerId = '';
      team.resetWatches();
      team.clear();
      team.enable(false);
      syncAttach();
      syncWatch();
      paintTeam();
      return;
    }
    if (msg.t === 'thread.snapshot' && msg.workerId !== worker.id) {
      syncTeam();
      if (team.receive(msg, Date.now())) paintTeam();
      return;
    }
    if (msg.t !== 'thread.snapshot' || !active || msg.workerId !== worker.id) return;
    const isPush = msg.push === true && msg.before === undefined && !history.historical;
    const isReply = Boolean(pending && msg.request === pending.request);
    if (!isPush && !isReply) return;

    if (!msg.error && worker.sessionId && msg.sessionId !== worker.sessionId) {
      if (isReply) {
        pending = undefined;
        updateControls();
      }
      return;
    }

    const older = Boolean(isReply && pending?.before !== undefined);
    if (isReply || (isPush && pending && pending.before === undefined)) {
      pending = undefined;
    }
    if (isPush) {
      hasPushed = true;
      lastReadAt = Date.now();
    }

    error = threadSnapshotError(worker, msg.error, !received && Date.now() < startupReadUntil);
    if (!msg.error) {
      history.apply(msg);
      if (history.unsupported) error = `This office sent a Thread this page can’t read. Reload the page, or ${fallback}.`;
      opts.onEntries?.();
      received = true;
      paintEntries(older);
    }
    updateControls();
  };

  const clearDraft = () => {
    input.value = '';
    recallAt = -1;
    opts.onDraft('');
    told = '';
    assist.reset();
  };
  const submit = async (queueSend = false) => {
    if ((queueSend ? queue.disabled || queue.hidden : send.disabled) || sending) return;
    const text = draftText().trim();
    const live = active && !disposed && !queueSend;
    if (live && nativeLimits(text, store.factory.connection.connected && !store.factory.connection.rejected)) {
      openFactoryLimits();
      clearDraft();
      updateControls();
      return;
    }
    if (live && !cloud && nativeCopy(text)) {
      openThreadCopy({ entries: history.entries, sessionId: worker.sessionId });
      clearDraft();
      updateControls();
      return;
    }
    const refused = cloud ? undefined : slashRefusal(text, worker.name, isBusy(worker.status), assist.slashList());
    if (refused) {
      told = refused;
      updateControls();
      return;
    }
    if (!text && !images.ids().length && !images.busy()) return input.focus();
    if (text.length > PROMPT_MAX) {
      told = `This message is ${text.length.toLocaleString('en-US')} characters, over the ${PROMPT_MAX.toLocaleString('en-US')}-character limit. Remove some pasted text.`;
      updateControls();
      return;
    }
    sending = true;
    updateControls();
    await images.settled();
    if (disposed || !active || !connected || worker.status === 'needs_input' || opts.blocked?.()) {
      sending = false;
      updateControls();
      return;
    }
    const queueReceipt = (queueSend || cloud) && isBusy(worker.status);
    const after = queued.sequence;
    const hasImage = images.ids().length > 0;
    const result = await opts.send({ t: 'worker.prompt', workerId: worker.id, prompt: text, images: images.ids(), queue: queueSend });
    sending = false;
    if (!result) {
      if (queueReceipt) queued.sent(text, hasImage, after);
      images.take();
      clearDraft();
      if (history.historical) history.clear(worker.sessionId);
      follow();
      read(undefined, 0);
    }
    error = result ?? '';
    updateControls();
    // Droid answers most of its slash commands with a dialog, which only its terminal shows.
    if (!result && !cloud && slashOf(text)?.command?.kind === 'tty') opts.raw?.();
  };

  const rewindConversation = (entryId: string) => {
    openThreadRewind({
      busy: isBusy(worker.status),
      text: history.entries.find((entry) => entry.id === entryId)?.text,
      files: rewindFilesSince(history.entries, entryId),
      send: async (restore: ThreadRewindRestore, files?: string[]) => {
        const msg: ClientMsg = { t: 'worker.rewind', workerId: worker.id, entryId, restore, ...(files ? { files } : {}) };
        return (await opts.send(msg)) || undefined;
      },
    });
  };

  const stopTurn = () => {
    if (stop.disabled) return;
    if (cloud || opts.interrupt) {
      stopping = true;
      updateControls();
      void opts.send({ t: 'worker.interrupt', workerId: worker.id }).then((why) => {
        stopping = false;
        told = why ?? '';
        updateControls();
      });
      return;
    }
    // Escape is the CLI's own cancel path, and requires the normal worker attachment.
    told = typeKeys('\u001b') ? '' : 'Disconnected. Nothing was sent.';
    updateControls();
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void submit();
  });

  input.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (assist.handleKeydown(event)) return;
    if (recall(event)) {
      event.preventDefault();
      return;
    }
    if (event.key === 'Escape' && !event.shiftKey && (!sidePanel.hidden || isBusy(worker.status))) {
      event.preventDefault();
      event.stopPropagation();
      // An open side chat takes Escape first, as it does in Droid.
      if (!sidePanel.hidden) void closeSide();
      else stopTurn();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit(!cloud && (event.ctrlKey || event.metaKey) && isBusy(worker.status));
    }
  });

  const off = net.onMessage(receive);
  const offFactory = store.on('factory', () => {
    assist.paintSlash();
    updateControls();
  });
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastTimeRefreshAt = 0;
  const syncTimer = () => {
    const want = active && !disposed && !document.hidden;
    if (want && !timer) {
      timer = setInterval(() => {
        if (!active || !connected || document.hidden) return;
        const now = Date.now();
        readTeam();
        paintQueue();
        paintLive();
        if (now - lastTimeRefreshAt >= 15_000) {
          lastTimeRefreshAt = now;
          refreshMessageTimes(element);
        }
        // A cloud worker's conversation is a read of its Factory session, which can take a while.
        if (pending && now - pending.at > (cloud ? 20_000 : 8000)) {
          pending = undefined;
          error = cloud ? 'The office did not return this conversation. Retry, or open it in Factory.' : 'The office did not return this conversation. Retry, or use Raw TTY on an older office.';
          updateControls();
        }
        if (!error) read(undefined, received ? RECONCILE_INTERVAL_MS : STARTUP_RETRY_MS);
      }, 1000);
    } else if (!want && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  const visibility = () => {
    syncTimer();
    syncAttach();
    syncWatch();
    paintProgress();
    readTeam();
    if (!document.hidden && active) {
      lastTimeRefreshAt = Date.now();
      refreshMessageTimes(element);
      read(undefined, 0);
    }
  };
  document.addEventListener('visibilitychange', visibility);
  // Text, font, spacing and width are CSS variables. Fold, tool and thinking choices change how rows are built, and each row's paint key carries them.
  const offViewPrefs = onThreadViewPrefs(() => {
    if (disposed) return;
    applyViewPrefs();
    if (received) paintEntries(false);
    paintLive();
    paintTeam(true);
  });

  return {
    element,
    entries: () => history.entries,
    update(next, online) {
      const reconnected = online && !connected;
      const workerChanged = next.id !== worker.id;
      const sessionChanged = next.sessionId !== worker.sessionId || workerChanged;
      if (sessionChanged) {
        startupReadUntil = threadStarting(worker) || threadStarting(next) ? Infinity : 0;
        history.clear(next.sessionId);
        received = false;
        hasPushed = false;
        pending = undefined;
        lastReadAt = 0;
        error = '';
        nodes.clear();
        liveView = undefined;
        liveTools.clear();
        streamNode.hidden = true;
        paintedOnce = false;
        expandedMessages.clear();
        userToggles.clear();
        expandedDiffs.clear();
        list.replaceChildren();
        paintEntries(false);
      }
      worker = next;
      if (workerChanged) assist.syncScope();
      connected = online;
      if (!online) {
        watchedWorkerId = '';
        attachedWorkerId = '';
        hasPushed = false;
        pending = undefined;
        error = '';
        team.resetWatches();
      }
      syncAttach();
      syncWatch();
      if (received) paintEntries(false);
      updateControls();
      if (reconnected || sessionChanged) read(undefined, 0);
      else read(undefined, received && hasPushed ? RECONCILE_INTERVAL_MS : 1000);
      readTeam();
    },
    dropZone: (zone, mark) => {
      if (!readOnly) images.dropZone(zone, mark);
    },
    activate(on) {
      if (active === on) return;
      if (!on && scroll.isConnected) {
        parked = readingSpot();
        holdRowHeights();
      }
      active = on;
      pending = undefined;
      syncTimer();
      syncAttach();
      syncWatch();
      if (on) {
        const spot = parked;
        if (spot) {
          returnTo(spot);
          requestAnimationFrame(() => {
            if (parked !== spot || !active) return;
            parked = undefined;
            if (spot.following || !returnTo(spot)) follow();
            updateLatest();
          });
        }
        read(undefined, 0);
        assist.loadSlash();
      }
      updateControls();
      readTeam();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      active = false;
      syncTimer();
      syncAttach();
      syncWatch();
      assist.dispose();
      paintProgress();
      progress.dispose();
      motion.dispose();
      search.dispose();
      settingsUi.dispose();
      document.removeEventListener('visibilitychange', visibility);
      teamSection.removeEventListener('toggle', teamDisclosure, true);
      teamSection.removeEventListener('focusout', teamFocus);
      document.removeEventListener('selectionchange', teamSelection);
      detachQuote();
      off();
      offFactory();
      offViewPrefs();
      resize.disconnect();
      questionChanges.disconnect();
      images.discard();
      team.dispose(connected ? (msg) => net.send(msg) : undefined);
      teamNodes.clear();
    },
  };
}

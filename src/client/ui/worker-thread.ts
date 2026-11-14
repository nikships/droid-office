import { CLEAR_DROID_QUEUE, readDroidQueue } from '../../shared/droid-queue';
import { ORCHESTRATOR_ID } from '../../shared/mission-control';
import type { ClientMsg, ServerMsg, WorkerInfo } from '../../shared/protocol';
import { slashCommands, slashOf, slashRefusal, slashSuggestions, type DroidSlashCommand, type SlashCommand } from '../../shared/slash-commands';
import { isAsleep, isBusy, needsOwnerInput } from '../../shared/status';
import { latestThreadPlan, type ActivePlan, type ThreadBlock, type ThreadRow } from '../../shared/thread-presentation';
import { ThreadQueue } from '../../shared/thread-queue';
import { todosFinished } from '../../shared/todos';
import type { ThreadEntry } from '../../shared/worker-thread';
import type { Net } from '../net';
import { store } from '../state';
import { TeamThread, TeamThreadPaint, teamThreadVisible } from '../team-thread';
import { ThreadHistory } from '../thread-history';
import { cloudStarting, threadSnapshotError, threadStarting } from '../thread-startup';
import { withToken } from '../token';
import { syncHorizontalScrollCue } from './code-highlight';
import { h, STATUS_LABEL } from './dom';
import { openFilePreviewModal } from './file-preview';
import { icon } from './icons';
import { promptImages } from './images';
import { viewPicture } from './picture-viewer';
import { renderCommandCard, renderDelegationCard, renderFileChangeCard, renderToolDisclosure, setDisclosureOpen, summarizeExplorationBlocks, type ThreadCardRenderContext } from './thread-diff-view';
import { threadMarkdown, threadUserMarkdown, type WorkspacePathRef } from './thread-markdown';
import { applyMention, findMentionQuery, rankWorkspacePaths, type MentionQuery, type WorkspaceMentionItem } from './thread-mention';

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
}

const RECONCILE_INTERVAL_MS = 15_000;
const STARTUP_RETRY_MS = 1_500;
const FILES_CACHE_TTL_MS = 10_000;

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

interface WorkspaceFilesCache {
  key: string;
  at: number;
  files: string[];
  dirs: string[];
  truncated: boolean;
}

/**
 * A worker's conversation: a local session's JSONL, or a cloud worker's Factory session, which the
 * office projects into the same entries. It uses the existing worker actions, never a second Droid.
 * A cloud worker has no terminal here: no Raw TTY, slash commands or screen to read its queue from,
 * Stop interrupts its session, and Factory holds a message sent during a turn until the turn is over.
 */
export function mountWorkerThread(net: Net, opts: ThreadOptions): WorkerThread {
  let worker = opts.worker;
  const cloud = !!worker.cloud;
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
  let hasPushed = false;
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

  const canOpenFiles = (author: WorkerInfo): boolean => !author.cloud && (Boolean(opts.floor) || author.id === ORCHESTRATOR_ID);

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

  const earlier = h('button.btn.sm.wt-earlier.hidden', { type: 'button', onclick: () => read(history.entries[0]?.seq, 0) }, 'Load earlier messages');
  const list = h('div.wt-list');
  const empty = h('div.wt-empty', { role: 'status' }, 'Reading the conversation…');
  const queuedBox = h('div.wt-queued', { hidden: true });
  const team = new TeamThread();
  const teamPaint = new TeamThreadPaint();
  const teamTitle = h('span', {}, 'Team activity');
  const teamBody = h('div.wt-team-body');
  const teamLimit = h('p.wt-team-note', { hidden: true });
  const teamSection = h('details.wt-team', { hidden: true }, h('summary', {}, teamTitle, h('span.wt-chevron', { 'aria-hidden': true }, icon('chevron', 14))), teamBody, teamLimit);
  const scroll = h('div.wt-scroll', { tabindex: 0, 'aria-label': 'Conversation history' }, earlier, list, empty, queuedBox, opts.question);
  const latest = h(
    'button.btn.icon.wt-latest.hidden',
    {
      type: 'button',
      'aria-label': 'Jump to latest',
      title: 'Jump to latest',
      onclick: () => {
        if (history.historical) {
          history.clear(worker.sessionId);
          lastReadAt = 0;
          read(undefined, 0);
        } else follow();
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
  const clearQueue = () => {
    const rows = screen?.();
    if (!rows || !readDroidQueue(rows)?.length) {
      paintQueue();
      return;
    }
    if (!typeKeys(CLEAR_DROID_QUEUE)) told = 'Disconnected. Nothing was sent.';
    updateControls();
  };
  // Droid's own queue, read off its screen, is what waits: messages sent from here fill in the rows it cut short.
  const paintQueue = () => {
    queued.sync(worker.sessionId, history.entries);
    const rows = screen?.();
    const droid = rows ? readDroidQueue(rows) : undefined;
    const shown = queued.shown(droid);
    if (queued.pending.length) localQueues.set(opts.queueKey, queued);
    else localQueues.delete(opts.queueKey);
    try {
      if (queued.pending.length) sessionStorage.setItem(opts.queueKey, JSON.stringify(queued));
      else sessionStorage.removeItem(opts.queueKey);
    } catch {}
    const canClear = connected && !!droid?.length;
    const key = JSON.stringify([shown, canClear]);
    if (key === queueKey) return;
    queueKey = key;
    const stick = received && !inspecting && atBottom();
    queuedBox.hidden = !shown.length;
    queuedBox.replaceChildren(
      ...(shown.length
        ? [
            h('div.wt-queued-title', { 'aria-live': 'polite' }, h('span', {}, `Queued · ${shown.length}`)),
            ...shown.map((message) => {
              const more = message.more > 0 ? `${message.more} more line${message.more === 1 ? '' : 's'}` : message.preview ? 'Shortened' : message.hasImage && message.text ? 'Image attached' : '';
              return h('div.wt-entry.user.wt-queued-message', { 'data-queued': message.key }, h('div.wt-user-text', {}, message.text || 'Image attached'), more ? h('div.wt-queued-more', {}, more) : null);
            }),
            h(
              'div.wt-queued-foot',
              {},
              h('span', {}, shown.length === 1 ? 'Sent once this turn is over.' : 'Sent in order once this turn is over.'),
              canClear ? h('button.btn.sm.ghost', { type: 'button', onclick: clearQueue }, 'Clear queue') : null,
            ),
          ]
        : []),
    );
    if (stick) follow();
  };
  const notice = h('p.wt-notice', { role: 'status' });
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

  // @file mention listbox
  const mentionMenu = h('div.wt-mention', { role: 'listbox', 'aria-label': 'Workspace files', hidden: true });
  let mentionShown: WorkspaceMentionItem[] = [];
  let mentionCursor = 0;
  let activeMention: MentionQuery | null = null;
  let mentionDismissedKey = '';
  let filesCache: WorkspaceFilesCache | undefined;
  let filesAbort: AbortController | undefined;
  let filesQueryKey = '';
  let latestFilteredFiles: { query: string; key: string; files: string[]; dirs: string[] } | undefined;

  const canMentionFiles = () => !cloud && worker.kind === 'agent' && !input.disabled && !worker.lost;

  const syncInputExpandedAria = () => {
    input.setAttribute('aria-expanded', String(Boolean(slashShown.length || mentionShown.length)));
  };

  const closeMention = () => {
    mentionShown = [];
    mentionCursor = 0;
    activeMention = null;
    mentionMenu.hidden = true;
    mentionMenu.replaceChildren();
    syncInputExpandedAria();
  };

  const fetchWorkspaceFiles = (query: string) => {
    const scopeKey = `${opts.floor ?? ''}:${worker.id}`;
    const now = Date.now();
    const validBase = filesCache && filesCache.key === scopeKey && now - filesCache.at < FILES_CACHE_TTL_MS ? filesCache : undefined;
    const needServerFilter = Boolean(query && validBase?.truncated);
    if (validBase && !needServerFilter) return;

    const reqQuery = needServerFilter ? query : '';
    const fetchKey = `${scopeKey}:${reqQuery}`;
    if (filesQueryKey === fetchKey && filesAbort) return;

    filesAbort?.abort();
    const controller = new AbortController();
    filesAbort = controller;
    filesQueryKey = fetchKey;

    const params = new URLSearchParams({
      floor: opts.floor ?? '',
      worker: worker.id,
      ...(reqQuery ? { q: reqQuery } : {}),
    });

    void fetch(withToken(`/api/thread/files?${params}`), {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    })
      .then((res) => {
        if (!res.ok) throw new Error('Could not list workspace files');
        return res.json() as Promise<{ files?: unknown; dirs?: unknown; truncated?: unknown }>;
      })
      .then((body) => {
        if (disposed || controller.signal.aborted) return;
        const files = Array.isArray(body?.files) ? body.files.filter((x): x is string => typeof x === 'string') : [];
        const dirs = Array.isArray(body?.dirs) ? body.dirs.filter((x): x is string => typeof x === 'string') : [];
        const truncated = Boolean(body?.truncated);
        if (!reqQuery) {
          filesCache = { key: scopeKey, at: Date.now(), files, dirs, truncated };
          if (truncated && activeMention?.query) {
            filesAbort = undefined;
            filesQueryKey = '';
            fetchWorkspaceFiles(activeMention.query);
          }
        } else {
          latestFilteredFiles = { query: reqQuery, key: scopeKey, files, dirs };
        }
        if (filesAbort === controller) {
          filesAbort = undefined;
          filesQueryKey = '';
        }
        paintMention();
      })
      .catch(() => {
        if (filesAbort === controller) {
          filesAbort = undefined;
          filesQueryKey = '';
        }
      });
  };

  const pickMention = (item: WorkspaceMentionItem) => {
    const queryNow = findMentionQuery(input.value, input.selectionStart ?? input.value.length) ?? activeMention;
    if (!queryNow) return;
    const next = applyMention(input.value, queryNow.start, queryNow.end, item.path);
    input.value = next.value;
    opts.onDraft(input.value);
    told = '';
    mentionDismissedKey = '';
    mentionCursor = 0;
    input.focus();
    input.setSelectionRange(next.cursor, next.cursor);
    paintSlash();
    paintMention();
    mentionMenu.scrollTop = 0;
    updateControls();
  };

  const paintMention = () => {
    if (!canMentionFiles()) {
      closeMention();
      return;
    }
    const found = findMentionQuery(input.value, input.selectionStart ?? input.value.length);
    if (!found) {
      mentionDismissedKey = '';
      closeMention();
      return;
    }
    const dismissToken = `${found.start}:${found.query}`;
    if (mentionDismissedKey === dismissToken) {
      closeMention();
      return;
    }
    activeMention = found;
    const scopeKey = `${opts.floor ?? ''}:${worker.id}`;
    fetchWorkspaceFiles(found.query);

    const validBase = filesCache && filesCache.key === scopeKey && Date.now() - filesCache.at < FILES_CACHE_TTL_MS ? filesCache : undefined;
    const source = found.query && validBase?.truncated && latestFilteredFiles?.key === scopeKey && latestFilteredFiles.query === found.query ? latestFilteredFiles : (validBase ?? (filesCache?.key === scopeKey ? filesCache : undefined));

    mentionShown = source ? rankWorkspacePaths(source.files, source.dirs, found.query, 12) : [];
    mentionCursor = Math.min(mentionCursor, Math.max(0, mentionShown.length - 1));
    mentionMenu.hidden = !mentionShown.length;
    syncInputExpandedAria();

    mentionMenu.replaceChildren(
      ...mentionShown.map((item, i) =>
        h(
          'button.wt-mention-item',
          {
            type: 'button',
            role: 'option',
            tabindex: -1,
            'aria-selected': String(i === mentionCursor),
            onmousedown: (event: Event) => event.preventDefault(),
            onclick: () => pickMention(item),
          },
          h('span.wt-mention-icon', { 'aria-hidden': 'true' }, icon(item.kind === 'dir' ? 'folder' : 'file', 14)),
          h('span.wt-mention-path', { title: item.path }, item.path),
          h('span.wt-mention-tag', {}, item.kind === 'dir' ? 'Folder' : 'File'),
        ),
      ),
    );
  };

  // Droid's slash commands, offered while a draft is a `/` and the start of a name.
  const slashMenu = h('div.wt-slash', { role: 'listbox', 'aria-label': 'Slash commands', hidden: true });
  let slashShown: SlashCommand[] = [];
  let slashCursor = 0;
  let slashClosed = false;
  // The built-in commands at once; the worker's skills and custom commands once its droid lists them.
  let slashList = cloud ? [] : slashCommands();
  let slashAsked = 0;
  const loadSlash = () => {
    if (cloud || worker.kind !== 'agent' || Date.now() - slashAsked < 60_000) return;
    slashAsked = Date.now();
    fetch(withToken(`/api/agents/droid/commands?worker=${encodeURIComponent(worker.id)}`), { credentials: 'same-origin', cache: 'no-store' })
      .then((res) => {
        if (!res.ok) throw new Error('Could not load slash commands');
        return res.json() as Promise<{ commands?: unknown }>;
      })
      .then((body) => {
        if (disposed || !Array.isArray(body?.commands)) return;
        slashList = slashCommands(body.commands as DroidSlashCommand[]);
        paintSlash();
      })
      .catch(() => {
        slashAsked = 0;
      });
  };
  const pickSlash = (command: SlashCommand) => {
    input.value = `/${command.name} `;
    opts.onDraft(input.value);
    told = '';
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    paintSlash();
    paintMention();
    updateControls();
  };
  const paintSlash = () => {
    slashShown = slashClosed || input.disabled ? [] : slashSuggestions(input.value, slashList);
    slashCursor = Math.min(slashCursor, Math.max(0, slashShown.length - 1));
    slashMenu.hidden = !slashShown.length;
    syncInputExpandedAria();
    slashMenu.replaceChildren(
      ...slashShown.map((command, i) =>
        h(
          'button.wt-slash-item',
          {
            type: 'button',
            role: 'option',
            tabindex: -1,
            'aria-selected': String(i === slashCursor),
            onmousedown: (event: Event) => event.preventDefault(),
            onclick: () => pickSlash(command),
          },
          h('span.wt-slash-name', {}, `/${command.name}`),
          h('span.wt-slash-desc', { title: command.argumentHint ? `${command.description}\n/${command.name} ${command.argumentHint}` : command.description }, command.description),
          command.kind === 'tty' ? h('span.wt-slash-tag', { title: 'Opens one of Droid’s dialogs, in Raw TTY' }, 'Raw TTY') : null,
          command.source ? h('span.wt-slash-tag', { title: command.source === 'skill' ? 'One of this worker’s skills' : 'A custom command' }, command.source === 'skill' ? 'Skill' : 'Command') : null,
        ),
      ),
    );
  };

  input.addEventListener('input', () => {
    opts.onDraft(input.value);
    told = '';
    slashClosed = false;
    slashCursor = 0;
    mentionDismissedKey = '';
    mentionCursor = 0;
    if (input.value.trimStart().startsWith('/')) loadSlash();
    paintSlash();
    paintMention();
    slashMenu.scrollTop = 0;
    mentionMenu.scrollTop = 0;
    updateControls();
  });
  input.addEventListener('click', () => paintMention());
  input.addEventListener('keyup', (event) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') {
      paintMention();
    }
  });

  const images = promptImages(input, worker.id);
  const file = h('input.hidden', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', multiple: true, 'aria-label': 'Choose pictures' });
  file.addEventListener('change', () => {
    images.add([...(file.files ?? [])]);
    file.value = '';
  });
  const attach = h('button.btn.icon.sm.ghost.wt-attach', { type: 'button', 'aria-label': 'Attach pictures', title: 'Attach pictures', onclick: () => file.click() }, icon('paperclip', 15));
  // While a turn runs, Send steers it (Droid reads the message now) and Queue holds it for after the turn.
  const queue = h('button.btn.sm.wt-queue', { type: 'button', title: 'Send once this turn is over', onclick: () => void submit(true) }, 'Queue');
  const sendLabel = h('span', {}, 'Send');
  const send = h('button.btn.sm.primary.wt-send', { type: 'submit' }, sendLabel, icon('arrowUp', 14));
  const stop = h('button.btn.sm.wt-stop', { type: 'button', 'aria-label': 'Stop turn', title: 'Stop turn', onclick: () => stopTurn() }, h('span.wt-stop-symbol', { 'aria-hidden': true }), h('span.wt-stop-label', {}, 'Stop'));
  const hint = h('span.wt-send-hint');
  const box = h('div.wt-compose-box', {}, images.element, input, h('div.wt-compose-bar', {}, attach, hint, h('div.wt-send-buttons', {}, stop, queue, send)));
  box.addEventListener('click', (event) => {
    if (!input.disabled && event.target instanceof Element && !event.target.closest('button, .pimgs, textarea')) input.focus();
  });
  const form = h('form.wt-composer', {}, mentionMenu, slashMenu, file, box);
  const progressLabel = h('span.wt-progress-label');
  const progressDetail = h('span.wt-progress-detail', { hidden: true });
  const progress = h(
    'div.wt-progress',
    { hidden: true },
    h(
      'div.wt-progress-line',
      {},
      h('span.wt-progress-glyph', { 'aria-hidden': 'true' }, h('span'), h('span'), h('span'), h('span')),
      h('span.wt-progress-status', { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' }, progressLabel),
      progressDetail,
    ),
  );
  const blockedText = h('p.wt-blocked-text');
  const blockedNote = h('div.wt-blocked.note.warn', { role: 'status', hidden: true }, icon('lock', 15), blockedText, opts.blockedAction ?? null);
  const element = h('section.worker-thread', { 'aria-label': `${worker.name} thread` }, teamSection, scroll, latestAnchor, progress, h('div.wt-feedback', {}, notice, retry, raw, resume), blockedNote, planBar, form);
  images.dropZone(form);

  const nodes = new Map<string, { key: string; node: HTMLElement; sourceIds: string[] }>();
  const expandedMessages = new Set<string>();
  const userToggles = new Map<string, boolean>();
  const expandedDiffs = new Set<string>();

  const updateClamps = (within: HTMLElement = element) => {
    for (const text of within.querySelectorAll<HTMLElement>('.wt-user-content')) {
      const button = text.parentElement?.nextElementSibling?.querySelector<HTMLButtonElement>('.wt-message-more');
      if (button instanceof HTMLButtonElement) button.hidden = text.classList.contains('clamped') && text.scrollHeight <= text.clientHeight + 1;
    }
    for (const frame of within.querySelectorAll<HTMLElement>('.wt-code-scroll')) syncHorizontalScrollCue(frame);
  };

  let followingLayout = true;
  let viewportWidth = scroll.clientWidth;
  let viewportHeight = scroll.clientHeight;
  const resize = new ResizeObserver(() => {
    updateClamps();
    if (followingLayout && !inspecting && !history.historical) follow();
    viewportWidth = scroll.clientWidth;
    viewportHeight = scroll.clientHeight;
    updateLatest();
  });
  resize.observe(scroll);
  let inspecting = false;
  const atBottom = () => scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
  const follow = () => {
    inspecting = false;
    followingLayout = true;
    scroll.scrollTop = scroll.scrollHeight;
    latest.classList.add('hidden');
  };
  const updateLatest = () => {
    latest.classList.toggle('hidden', !history.historical && !inspecting && atBottom());
    labelLatest(inspecting && atBottom() ? 'Follow latest' : 'Jump to latest');
  };
  let questionContent = '';
  const questionChanges = new MutationObserver(() => {
    const content = opts.question.textContent ?? '';
    if (content === questionContent) return;
    questionContent = content;
    if (active && needsOwnerInput(worker) && !opts.question.hidden) requestAnimationFrame(() => opts.question.scrollIntoView({ block: 'nearest' }));
  });
  questionChanges.observe(opts.question, { childList: true, subtree: true });
  scroll.addEventListener('scroll', () => {
    if (viewportWidth === scroll.clientWidth && viewportHeight === scroll.clientHeight) followingLayout = atBottom();
    updateLatest();
  });
  scroll.addEventListener('click', (event) => {
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
        labelLatest(atBottom() ? 'Follow latest' : 'Jump to latest');
      }
      updateClamps(details);
    },
    true,
  );

  const chevron = () => h('span.wt-chevron', { 'aria-hidden': true }, icon('chevron', 14));
  const thought = (block: Extract<ThreadBlock, { kind: 'thought' }>, entry: ThreadEntry | undefined, toggles: ReadonlyMap<string, boolean>) =>
    setDisclosureOpen(
      h(
        'details.wt-thinking',
        { 'data-disclosure': block.id },
        h('summary', {}, h('span.wt-thought-label', {}, 'Thought'), h('span.wt-thought-preview', {}, block.preview), chevron()),
        h('div.wt-thinking-text', {}, entry?.text ?? block.preview),
      ),
      toggles.get(block.id) ?? block.open,
    );

  /** An entry's pictures, each opening at full size, read from `owner`'s session. A cloud worker's session has none here. */
  const pictures = (entry: ThreadEntry | undefined, title: string, about?: string, owner: WorkerInfo = worker) => {
    const imgs = !owner.cloud && opts.floor ? (entry?.images ?? []) : [];
    if (!imgs.length) return null;
    return h(
      'div.wt-images',
      {},
      ...imgs.map((image, i) => {
        const src = withToken(`/api/thread/image?${new URLSearchParams({ floor: opts.floor ?? '', worker: owner.id, image: image.id })}`);
        const name = imgs.length > 1 ? `${title} · ${i + 1} of ${imgs.length}` : title;
        return h(
          'button.wt-image',
          { type: 'button', title: 'Open the picture', 'aria-label': `Open ${name}`, onclick: () => viewPicture(src, name, { width: image.width, height: image.height, about }) },
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
  }

  // While the worker waits on the owner, its run isn't working: the question card says what it's on.
  const render = (row: ThreadRow, loaded: ReadonlyMap<string, ThreadEntry>, asking: boolean, renderOpts: RenderOptions = {}) => {
    const author = renderOpts.author ?? worker;
    const expanded = renderOpts.expanded ?? expandedMessages;
    const toggles = renderOpts.toggles ?? userToggles;
    const diffs = renderOpts.diffs ?? expandedDiffs;

    const node = h('article.wt-entry', { 'data-entry': row.id });
    if (row.kind === 'activity') {
      node.classList.add('activity');
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
      };

      let exploreSegment: ThreadBlock[] = [];
      const flushExplore = () => {
        if (!exploreSegment.length) return;
        const segment = exploreSegment;
        exploreSegment = [];
        const first = segment[0];
        const exploreKey = `explore:${first.id}`;
        const meta = summarizeExplorationBlocks(segment, row.live);
        const liveNow = meta.live && !asking;
        const bodyItems: HTMLElement[] = [];
        for (const blk of segment) {
          if (blk.kind === 'thought') {
            bodyItems.push(thought(blk, loaded.get(blk.id), toggles));
          } else {
            for (const item of blk.actions) {
              bodyItems.push(renderToolDisclosure(item, loaded.get(item.id), author, pictures, toggles));
            }
          }
        }
        const details = setDisclosureOpen(
          h(
            'details.wt-explore',
            { class: liveNow ? 'working' : meta.state, 'data-disclosure': exploreKey },
            h(
              'summary',
              {},
              h('span.wt-activity-mark', { 'aria-hidden': true }),
              h('span.wt-activity-label', {}, `${liveNow ? 'Working · ' : ''}${meta.label}`),
              meta.status ? h('span.wt-activity-status', {}, meta.status) : null,
              chevron(),
            ),
            h('div.wt-explore-body', {}, ...bodyItems),
          ),
          toggles.get(exploreKey) ?? false,
        );
        node.append(details);
      };

      let hasWorkingCard = false;
      for (const block of row.blocks) {
        if (block.kind === 'tools' && block.card) {
          flushExplore();
          for (const act of block.actions) {
            if (act.state === 'working') hasWorkingCard = true;
            if (block.card === 'change') node.append(renderFileChangeCard(act, loaded.get(act.id), cardCtx));
            else if (block.card === 'command') node.append(renderCommandCard(act, loaded.get(act.id), cardCtx));
            else node.append(renderDelegationCard(act, loaded.get(act.id), cardCtx));
          }
        } else {
          exploreSegment.push(block);
        }
      }
      flushExplore();

      if (row.live && !asking && !hasWorkingCard && row.running && row.running !== row.label) {
        node.append(h('p.wt-running', { role: 'status' }, row.running));
      }
      return node;
    }

    node.classList.add(row.role, row.kind === 'message' ? 'text' : 'notice');
    if (row.kind === 'notice') {
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
        streaming,
        onOpenPath: onOpenPathFor(author),
      });
      node.append(body);
      return node;
    }

    // The pictures sent with the prompt, above its text, in place of where the office kept them.
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
    node.append(h('div.wt-message-actions', {}, more));
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
      card.note.textContent = member.error
        ? `Conversation unavailable: ${member.error}`
        : child.lost
          ? 'This worker’s checkout is unavailable.'
          : !child.sessionId
            ? 'Waiting for a local session…'
            : !member.received
              ? teamSection.open
                ? 'Reading the conversation…'
                : 'Expand Team activity to read recent messages and tools.'
              : rows.length
                ? 'Recent activity only. Open the worker thread for more messages and recorded patches.'
                : 'No conversation recorded yet.';
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
        const key = JSON.stringify([row, child.status === 'needs_input', child.name, streamFlag, hasDelegateCard(row) ? rosterKey : '', rowContent(row, loaded)]);
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
    else empty.replaceChildren(h('span.wt-empty-mark', { 'aria-hidden': true }), h('b', {}, 'Start a conversation'), h('p', {}, 'Your messages and the worker’s replies will appear here.'));
  };

  const paintEntries = (older: boolean) => {
    const stick = !received || (!older && !inspecting && atBottom());
    const top = scroll.scrollTop;
    const height = scroll.scrollHeight;
    const want: HTMLElement[] = [];
    const keep = new Set<string>();
    const focused = document.activeElement;
    const focusedDisclosure = focused instanceof HTMLElement && focused.matches('summary') && list.contains(focused) ? focused.parentElement?.dataset.disclosure : undefined;
    const rows = history.rows;
    const lastRow = rows.at(-1);
    const loaded = new Map(history.entries.map((entry) => [entry.id, entry]));
    const asking = worker.status === 'needs_input';
    const rosterKey = (opts.team?.() ?? []).map((w) => `${w.id}:${w.name}:${w.lead ?? ''}`).join(',');

    for (const row of rows) {
      const isLastRow = row === lastRow;
      const streamFlag = isLastRow && row.kind === 'message' && row.role === 'assistant' && isBusy(worker.status);
      const key = JSON.stringify([row, asking, streamFlag, hasDelegateCard(row) ? rosterKey : '', rowContent(row, loaded)]);
      let had = nodes.get(row.id);
      if (!had || had.key !== key) {
        const positions = [...(had?.node.querySelectorAll<HTMLElement>('pre, .wt-horizontal-content') ?? [])].map((content) => [content.scrollTop, content.scrollLeft]);
        const node = render(row, loaded, asking, { isLastRow });
        [...node.querySelectorAll<HTMLElement>('pre, .wt-horizontal-content')].forEach((content, index) => {
          content.scrollTop = positions[index]?.[0] ?? 0;
          content.scrollLeft = positions[index]?.[1] ?? 0;
        });
        had = { key, node, sourceIds: row.kind === 'activity' ? row.sourceIds : [] };
        nodes.set(row.id, had);
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
    updateClamps();
    if (focusedDisclosure && focused && !focused.isConnected) {
      [...list.querySelectorAll<HTMLDetailsElement>('details[data-disclosure]')]
        .find((el) => el.dataset.disclosure === focusedDisclosure)
        ?.querySelector('summary')
        ?.focus({ preventScroll: true });
    }
    earlier.classList.toggle('hidden', !history.hasMore);
    labelLatest(history.historical ? 'Back to the latest' : 'Jump to latest');
    empty.hidden = rows.length > 0;
    paintEmpty();
    paintPlan();
    if (stick) follow();
    else if (older) scroll.scrollTop = top + scroll.scrollHeight - height;
    else updateLatest();
    if (history.historical) latest.classList.remove('hidden');
  };

  let waitingShown = false;
  // One stable signal outside the scrolling transcript, including gaps between recorded messages.
  // The JSONL isn't a token stream: don't infer "Thinking" or "Generating" from its last entry.
  const paintProgress = () => {
    const show = active && connected && !disposed && !document.hidden && !worker.lost && !error && isBusy(worker.status);
    const label = !show ? '' : worker.status === 'starting' ? 'Starting worker…' : worker.status === 'needs_input' ? 'Waiting for you' : 'Working…';
    const last = history.rows.at(-1);
    const detail = show && worker.status === 'working' && !history.historical && history.sessionId === worker.sessionId && last?.kind === 'activity' && last.live ? (last.running ?? '') : '';
    progress.hidden = !show;
    progress.classList.toggle('running', show && worker.status !== 'needs_input');
    // Polls must neither restart the glyph nor repeatedly announce the same status.
    if (progressLabel.textContent !== label) progressLabel.textContent = label;
    if (progressDetail.textContent !== detail) {
      progressDetail.textContent = detail;
      progressDetail.title = detail ? `Latest activity: ${detail}` : '';
    }
    progressDetail.hidden = !detail;
  };

  const updateControls = () => {
    const broken = worker.cloud?.error;
    const blocked = opts.blocked?.();
    const allowed = active && connected && !disposed && (opts.promptWakes || !isAsleep(worker.status)) && !worker.lost && !broken && !blocked;
    const waiting = worker.status === 'needs_input';
    form.hidden = waiting || !!blocked;
    blockedNote.hidden = !blocked;
    blockedText.textContent = blocked ?? '';
    if (needsOwnerInput(worker) && !waitingShown) requestAnimationFrame(() => opts.question.scrollIntoView({ block: 'nearest' }));
    waitingShown = waiting;
    input.disabled = !allowed || sending || waiting;
    if (input.disabled) {
      if (slashShown.length) paintSlash();
      if (mentionShown.length) closeMention();
    }
    attach.disabled = input.disabled;
    const busy = isBusy(worker.status);
    send.disabled = input.disabled;
    // Factory holds a cloud worker's message until its turn is over: there's nothing to steer with.
    queue.hidden = !busy || cloud;
    queue.disabled = input.disabled || !received || !!slashOf(input.value);
    stop.hidden = !busy && !waiting;
    stop.disabled = !allowed || sending || stopping;
    sendLabel.textContent = sending ? 'Sending…' : busy ? (cloud ? 'Queue' : 'Send now') : 'Send';
    send.title = busy ? (cloud ? `Sent to ${worker.name} once this turn is over` : `Steer ${worker.name}: it reads this now, during the turn`) : '';
    const placeholder = () => {
      if (broken) return `${worker.name} can’t take messages`;
      if (introNow()) return `Tell ${worker.name} what you want done…`;
      if (!busy) return `Reply to ${worker.name}…`;
      return cloud ? `Queue a message for after this turn…` : `Steer ${worker.name}, or queue for after this turn…`;
    };
    input.placeholder = placeholder();
    hint.replaceChildren(
      ...(cloud
        ? [shortcut('Enter', busy ? 'queue' : 'send'), shortcut('⇧ Enter', 'new line')]
        : busy
          ? [shortcut('Enter', 'steer'), shortcut('Ctrl Enter', 'queue'), shortcut('⇧ Enter', 'new line')]
          : worker.kind === 'agent'
            ? [shortcut('Enter', 'send'), shortcut('⇧ Enter', 'new line'), shortcut('@', 'files'), shortcut('/', 'commands')]
            : [shortcut('Enter', 'send'), shortcut('⇧ Enter', 'new line'), shortcut('/', 'commands')]),
    );
    earlier.disabled = !!pending || !connected;
    retry.classList.toggle('hidden', !error);
    retry.disabled = !connected || !!pending;
    empty.classList.toggle('error', !!error && !history.entries.length);
    if (!history.entries.length) paintEmpty();
    notice.textContent = connected
      ? error || told || (broken && !opts.cloudErrorShown ? `${worker.name} can’t work: ${broken}` : '') || (isAsleep(worker.status) && !opts.promptWakes ? 'Resume this worker to send another message.' : '')
      : '';
    raw?.classList.toggle('hidden', !connected || !error);
    // A cloud worker's Resume reads its Factory session again, which is also how one that broke is checked.
    resume.hidden = (!isAsleep(worker.status) || !!opts.promptWakes) && !broken;
    resume.disabled = !active || !connected || !!worker.lost || resuming;
    resume.textContent = broken ? (resuming ? 'Checking…' : 'Check again') : resuming ? 'Resuming…' : 'Resume';
    element.classList.toggle('has-feedback', !!notice.textContent);
    paintPlan();
    paintQueue();
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
    if (msg.t === 'floor.enter' || msg.t === 'welcome') {
      if (msg.t === 'welcome' || watchedWorkerId !== ORCHESTRATOR_ID) {
        watchedWorkerId = '';
        hasPushed = false;
      }
      team.resetWatches();
      team.clear();
      team.enable(false);
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

  const submit = async (queueSend = false) => {
    if ((queueSend ? queue.disabled || queue.hidden : send.disabled) || sending) return;
    const text = input.value.trim();
    const refused = cloud ? undefined : slashRefusal(text, worker.name, isBusy(worker.status));
    if (refused) {
      told = refused;
      updateControls();
      return;
    }
    if (!text && !images.ids().length && !images.busy()) return input.focus();
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
      input.value = '';
      opts.onDraft('');
      told = '';
      paintSlash();
      closeMention();
      if (history.historical) history.clear(worker.sessionId);
      follow();
      read(undefined, 0);
    }
    error = result ?? '';
    updateControls();
    // Droid answers most of its slash commands with a dialog, which only its terminal shows.
    if (!result && !cloud && slashOf(text)?.command?.kind === 'tty') opts.raw?.();
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
    if (mentionShown.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        mentionCursor = (mentionCursor + (event.key === 'ArrowDown' ? 1 : mentionShown.length - 1)) % mentionShown.length;
        paintMention();
        mentionMenu.children[mentionCursor]?.scrollIntoView({ block: 'nearest' });
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (activeMention) mentionDismissedKey = `${activeMention.start}:${activeMention.query}`;
        paintMention();
        return;
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault();
        pickMention(mentionShown[mentionCursor]);
        return;
      }
    }
    if (slashShown.length) {
      const typed = slashOf(input.value)?.name;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        slashCursor = (slashCursor + (event.key === 'ArrowDown' ? 1 : slashShown.length - 1)) % slashShown.length;
        paintSlash();
        slashMenu.children[slashCursor]?.scrollIntoView({ block: 'nearest' });
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        slashClosed = true;
        paintSlash();
        return;
      }
      // Tab, or Enter on a name only partly typed, completes it; Enter on a whole name sends it.
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey && slashShown[slashCursor].name !== typed)) {
        event.preventDefault();
        pickSlash(slashShown[slashCursor]);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit(!cloud && (event.ctrlKey || event.metaKey) && isBusy(worker.status));
    }
  });

  const off = net.onMessage(receive);
  const timer = setInterval(() => {
    if (!active || !connected || document.hidden) return;
    readTeam();
    paintQueue();
    // A cloud worker's conversation is a read of its Factory session, which can take a while.
    if (pending && Date.now() - pending.at > (cloud ? 20_000 : 8000)) {
      pending = undefined;
      error = cloud ? 'The office did not return this conversation. Retry, or open it in Factory.' : 'The office did not return this conversation. Retry, or use Raw TTY on an older office.';
      updateControls();
    }
    if (!error) read(undefined, received ? RECONCILE_INTERVAL_MS : STARTUP_RETRY_MS);
  }, 1000);

  const visibility = () => {
    syncWatch();
    paintProgress();
    readTeam();
    if (!document.hidden && active) read(undefined, 0);
  };
  document.addEventListener('visibilitychange', visibility);

  return {
    element,
    entries: () => history.entries,
    update(next, online) {
      const reconnected = online && !connected;
      const workerChanged = next.id !== worker.id;
      const sessionChanged = next.sessionId !== worker.sessionId || workerChanged;
      if (reconnected && active) net.send({ t: 'worker.attach', workerId: next.id });
      if (sessionChanged) {
        startupReadUntil = threadStarting(worker) || threadStarting(next) ? Infinity : 0;
        history.clear(next.sessionId);
        received = false;
        hasPushed = false;
        pending = undefined;
        lastReadAt = 0;
        error = '';
        nodes.clear();
        expandedMessages.clear();
        userToggles.clear();
        expandedDiffs.clear();
        list.replaceChildren();
        paintEntries(false);
      }
      worker = next;
      connected = online;
      if (!online) {
        watchedWorkerId = '';
        hasPushed = false;
        pending = undefined;
        error = '';
        team.resetWatches();
      }
      syncWatch();
      if (received) paintEntries(false);
      updateControls();
      if (reconnected || sessionChanged) read(undefined, 0);
      else read(undefined, received && hasPushed ? RECONCILE_INTERVAL_MS : 1000);
      readTeam();
    },
    dropZone: (zone, mark) => images.dropZone(zone, mark),
    activate(on) {
      if (active === on) return;
      active = on;
      pending = undefined;
      syncWatch();
      if (on) {
        net.send({ t: 'worker.attach', workerId: worker.id });
        read(undefined, 0);
        loadSlash();
      } else {
        net.send({ t: 'worker.detach', workerId: worker.id });
      }
      updateControls();
      readTeam();
    },
    dispose() {
      if (disposed) return;
      if (active) net.send({ t: 'worker.detach', workerId: worker.id });
      disposed = true;
      active = false;
      syncWatch();
      filesAbort?.abort();
      filesAbort = undefined;
      paintProgress();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visibility);
      teamSection.removeEventListener('toggle', teamDisclosure, true);
      teamSection.removeEventListener('focusout', teamFocus);
      document.removeEventListener('selectionchange', teamSelection);
      off();
      resize.disconnect();
      questionChanges.disconnect();
      images.discard();
      team.dispose(connected ? (msg) => net.send(msg) : undefined);
      teamNodes.clear();
    },
  };
}

// Shared composer assist for Thread views and prompt/hire dialogs:
// `/` slash command autocomplete, `@` workspace file mentions, and large paste chips.
// Free of window/document calls at import time so Node unit tests import it directly.

import { nativeLimits, slashCommands, slashOf, slashSuggestions, type DroidSlashCommand, type SlashCommand } from '../../shared/slash-commands';
import { withToken } from '../token';
import { h } from './dom';
import { icon } from './icons';
import { expandPastes, isLargePaste, livePastes, pastedText, replacePaste, type PastedText } from './thread-compose';
import { applyMention, findMentionQuery, rankWorkspacePaths, type MentionQuery, type WorkspaceMentionItem } from './thread-mention';

const FILES_CACHE_TTL_MS = 10_000;
const SLASH_CACHE_TTL_MS = 60_000;

interface WorkspaceFilesCache {
  key: string;
  at: number;
  files: string[];
  dirs: string[];
  truncated: boolean;
}

export interface ComposerAssistScope {
  /** Floor id for `/api/thread/files` and (when no workerId) `/api/agents/droid/commands`. */
  floor?: string;
  /** Worker id (including `ORCHESTRATOR_ID`); omit when hiring a new worker on `floor`. */
  workerId?: string;
  /** Whether Droid `/` slash command autocomplete is active. */
  slash: boolean;
  /** Whether `@` workspace file mention autocomplete is active. */
  mentions: boolean;
  /** Whether large pastes collapse into expandable chips (defaults to true). */
  pastes?: boolean;
}

export interface ComposerAssistOptions {
  input: HTMLTextAreaElement;
  scope: () => ComposerAssistScope;
  /** Called whenever picking a slash command, picking a mention, or editing/pasting a chip updates the draft. */
  onChange?: (expandedDraft: string) => void;
  /** Whether Factory is connected (controls whether `/limits` shows the Raw TTY tag). */
  factoryConnected?: () => boolean;
  /** Load skills and custom commands immediately instead of waiting for the first `/`. */
  preloadSlash?: boolean;
}

export interface ComposerAssist {
  /** The `@` workspace file listbox (`div.wt-mention`). */
  mentionMenu: HTMLElement;
  /** The `/` slash command listbox (`div.wt-slash`). */
  slashMenu: HTMLElement;
  /** The large paste chips list (`div.wt-pastes`). */
  pasteChips: HTMLElement;
  /** Current slash command list (built-ins plus loaded skills and custom commands). */
  slashList(): readonly SlashCommand[];
  /** Loads the folder's or worker's live skills and custom commands (cached 60s). */
  loadSlash(): void;
  /** Expands large paste tokens in `input.value` into the full prompt text. */
  expand(): string;
  /** Syncs pastes, resets dismissals/cursors, loads slash commands if typing `/`, and repaints both menus. */
  onInput(): void;
  /** Repaints the slash menu (e.g. when Factory connection changes or input disables). */
  paintSlash(): void;
  /** Repaints the `@` mention menu (e.g. when the cursor moves). */
  paintMention(): void;
  /** Closes the `@` mention menu immediately. */
  closeMention(): void;
  /** Resets paste chips and menus after clearing the draft. */
  reset(): void;
  /** Dismisses whichever autocomplete menu is open; returns true if one was open (for modal Escape claims). */
  dismissMenu(): boolean;
  /** Handles Up/Down/Escape/Tab/Enter while an autocomplete menu is open; returns true if consumed. */
  handleKeydown(event: KeyboardEvent): boolean;
  /** Re-evaluates `scope()` (e.g. after switching between local and cloud, or switching workers). */
  syncScope(): void;
  /** Aborts in-flight fetches and detaches listeners from `input`. */
  dispose(): void;
}

export function attachComposerAssist(opts: ComposerAssistOptions): ComposerAssist {
  const { input } = opts;
  let disposed = false;

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

  // Droid's slash commands, offered while a draft is a `/` and the start of a name.
  const slashMenu = h('div.wt-slash', { role: 'listbox', 'aria-label': 'Slash commands', hidden: true });
  let slashShown: SlashCommand[] = [];
  let slashCursor = 0;
  let slashClosed = false;
  let slashScopeKey = '';
  let slashAsked = 0;
  let slashAbort: AbortController | undefined;
  let slashEntries: SlashCommand[] = opts.scope().slash ? slashCommands() : [];

  // Large pastes wait in the draft as tokens shown as chips; the draft and the message carry their text.
  const pastes: PastedText[] = [];
  let pasteSeq = 0;
  let pastesKey = '';
  const pasteChips = h('div.wt-pastes', { role: 'list', 'aria-label': 'Pasted text', hidden: true });

  const expand = () => expandPastes(input.value, pastes);

  const syncInputExpandedAria = () => {
    input.setAttribute('aria-expanded', String(Boolean(slashShown.length || mentionShown.length)));
  };

  const filesScopeKey = (s: ComposerAssistScope): string => (s.workerId ? `${s.floor ?? ''}:${s.workerId}` : s.floor ? `floor:${s.floor}` : '');
  const commandsScopeKey = (s: ComposerAssistScope): string => (s.workerId ? `w:${s.workerId}` : s.floor ? `f:${s.floor}` : '');

  const canMentionFiles = (s: ComposerAssistScope) => s.mentions && !input.disabled && Boolean(s.workerId || s.floor);

  const closeMention = () => {
    mentionShown = [];
    mentionCursor = 0;
    activeMention = null;
    mentionMenu.hidden = true;
    mentionMenu.replaceChildren();
    syncInputExpandedAria();
  };

  const fetchWorkspaceFiles = (query: string) => {
    const s = opts.scope();
    const scopeKey = filesScopeKey(s);
    if (!scopeKey) return;
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

    const params = new URLSearchParams();
    if (s.floor) params.set('floor', s.floor);
    if (s.workerId) params.set('worker', s.workerId);
    if (reqQuery) params.set('q', reqQuery);

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

  const paintMention = () => {
    const s = opts.scope();
    if (!canMentionFiles(s)) {
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
    const scopeKey = filesScopeKey(s);
    fetchWorkspaceFiles(found.query);

    const cached = filesCache?.key === scopeKey ? filesCache : undefined;
    const validBase = cached && Date.now() - cached.at < FILES_CACHE_TTL_MS ? cached : undefined;
    const source = found.query && validBase?.truncated && latestFilteredFiles?.key === scopeKey && latestFilteredFiles.query === found.query ? latestFilteredFiles : cached;

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

  const loadSlash = () => {
    const s = opts.scope();
    const key = commandsScopeKey(s);
    if (!s.slash || !key) return;
    if (key === slashScopeKey && Date.now() - slashAsked < SLASH_CACHE_TTL_MS) return;
    slashScopeKey = key;
    slashAsked = Date.now();
    slashAbort?.abort();
    const controller = new AbortController();
    slashAbort = controller;
    const params = new URLSearchParams(s.workerId ? { worker: s.workerId } : { floor: s.floor! });
    void fetch(withToken(`/api/agents/droid/commands?${params}`), {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    })
      .then((res) => {
        if (!res.ok) throw new Error('Could not load slash commands');
        return res.json() as Promise<{ commands?: unknown }>;
      })
      .then((body) => {
        if (disposed || controller.signal.aborted || !Array.isArray(body?.commands)) return;
        if (!opts.scope().slash || commandsScopeKey(opts.scope()) !== key) return;
        slashEntries = slashCommands(body.commands as DroidSlashCommand[]);
        paintSlash();
      })
      .catch(() => {
        if (slashAbort === controller) slashAsked = 0;
      });
  };

  const paintSlash = () => {
    const s = opts.scope();
    slashShown = !s.slash || slashClosed || input.disabled ? [] : slashSuggestions(input.value, slashEntries);
    slashCursor = Math.min(slashCursor, Math.max(0, slashShown.length - 1));
    slashMenu.hidden = !slashShown.length;
    syncInputExpandedAria();
    const connected = opts.factoryConnected?.() ?? false;
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
          command.kind === 'tty' && !nativeLimits(`/${command.name}`, connected) ? h('span.wt-slash-tag', { title: 'Opens one of Droid’s dialogs, in Raw TTY' }, 'Raw TTY') : null,
          command.source ? h('span.wt-slash-tag', { title: command.source === 'skill' ? 'One of this worker’s skills' : 'A custom command' }, command.source === 'skill' ? 'Skill' : 'Command') : null,
        ),
      ),
    );
  };

  const paintPastes = () => {
    const live = livePastes(input.value, pastes);
    if (live.length !== pastes.length) pastes.splice(0, pastes.length, ...live);
    const key = pastes.map((paste) => paste.id).join();
    if (key === pastesKey) return;
    pastesKey = key;
    pasteChips.hidden = !pastes.length;
    pasteChips.replaceChildren(
      ...pastes.map((paste) => {
        const size = paste.lines > 1 ? `${paste.lines.toLocaleString('en-US')} lines` : `${paste.text.length.toLocaleString('en-US')} characters`;
        return h(
          'div.wt-paste-chip',
          { role: 'listitem' },
          h(
            'button.wt-paste-open',
            {
              type: 'button',
              title: `${paste.text.slice(0, 400)}${paste.text.length > 400 ? '…' : ''}`,
              'aria-label': `Pasted text #${paste.id}, ${size}. Expand it into the message`,
              onclick: () => editPaste(paste, paste.text),
            },
            icon('file', 14),
            h('span.wt-paste-name', {}, `Pasted text #${paste.id}`),
            h('span.wt-paste-size', {}, size),
          ),
          h('button.wt-paste-x', { type: 'button', title: 'Remove', 'aria-label': `Remove pasted text #${paste.id}`, onclick: () => editPaste(paste, '') }, icon('x', 12)),
        );
      }),
    );
  };

  const onInput = () => {
    paintPastes();
    slashClosed = false;
    slashCursor = 0;
    mentionDismissedKey = '';
    mentionCursor = 0;
    if (input.value.trimStart().startsWith('/')) loadSlash();
    paintSlash();
    paintMention();
    slashMenu.scrollTop = 0;
    mentionMenu.scrollTop = 0;
  };

  const editPaste = (paste: PastedText, replacement: string) => {
    const next = replacePaste(input.value, paste, replacement);
    if (!next) return;
    input.value = next.value;
    input.focus();
    input.setSelectionRange(next.cursor, next.cursor);
    onInput();
    opts.onChange?.(expand());
  };

  const pickMention = (item: WorkspaceMentionItem) => {
    const queryNow = findMentionQuery(input.value, input.selectionStart ?? input.value.length) ?? activeMention;
    if (!queryNow) return;
    const next = applyMention(input.value, queryNow.start, queryNow.end, item.path);
    input.value = next.value;
    paintPastes();
    mentionDismissedKey = '';
    mentionCursor = 0;
    input.focus();
    input.setSelectionRange(next.cursor, next.cursor);
    paintSlash();
    paintMention();
    mentionMenu.scrollTop = 0;
    opts.onChange?.(expand());
  };

  const pickSlash = (command: SlashCommand) => {
    input.value = `/${command.name} `;
    paintPastes();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    paintSlash();
    paintMention();
    opts.onChange?.(expand());
  };

  const onPaste = (event: ClipboardEvent) => {
    if (opts.scope().pastes === false) return;
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (input.disabled || !isLargePaste(text)) return;
    event.preventDefault();
    const paste = pastedText(++pasteSeq, text);
    pastes.push(paste);
    input.setRangeText(paste.token, input.selectionStart ?? input.value.length, input.selectionEnd ?? input.value.length, 'end');
    onInput();
    opts.onChange?.(expand());
  };

  const onClick = () => paintMention();
  const onKeyup = (event: KeyboardEvent) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') paintMention();
  };

  input.addEventListener('paste', onPaste);
  input.addEventListener('click', onClick);
  input.addEventListener('keyup', onKeyup);

  const dismissMenu = (): boolean => {
    if (mentionShown.length) {
      if (activeMention) mentionDismissedKey = `${activeMention.start}:${activeMention.query}`;
      paintMention();
      return true;
    }
    if (slashShown.length) {
      slashClosed = true;
      paintSlash();
      return true;
    }
    return false;
  };

  const handleKeydown = (event: KeyboardEvent): boolean => {
    if (event.isComposing) return false;
    if (mentionShown.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        mentionCursor = (mentionCursor + (event.key === 'ArrowDown' ? 1 : mentionShown.length - 1)) % mentionShown.length;
        paintMention();
        mentionMenu.children[mentionCursor]?.scrollIntoView?.({ block: 'nearest' });
        return true;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (activeMention) mentionDismissedKey = `${activeMention.start}:${activeMention.query}`;
        paintMention();
        return true;
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault();
        pickMention(mentionShown[mentionCursor]);
        return true;
      }
    }
    if (slashShown.length) {
      const typed = slashOf(input.value)?.name;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        slashCursor = (slashCursor + (event.key === 'ArrowDown' ? 1 : slashShown.length - 1)) % slashShown.length;
        paintSlash();
        slashMenu.children[slashCursor]?.scrollIntoView?.({ block: 'nearest' });
        return true;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        slashClosed = true;
        paintSlash();
        return true;
      }
      // Tab, or Enter on a name only partly typed, completes it; Enter on a whole name sends it.
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey && slashShown[slashCursor].name !== typed)) {
        event.preventDefault();
        pickSlash(slashShown[slashCursor]);
        return true;
      }
    }
    return false;
  };

  const syncScope = () => {
    const s = opts.scope();
    const nextKey = commandsScopeKey(s);
    if (!s.slash) {
      slashAbort?.abort();
      slashAbort = undefined;
      slashEntries = [];
      slashScopeKey = '';
      slashAsked = 0;
    } else if (nextKey !== slashScopeKey || !slashEntries.length) {
      slashEntries = slashCommands();
      slashScopeKey = '';
      slashAsked = 0;
      if (opts.preloadSlash || input.value.trimStart().startsWith('/')) loadSlash();
    }
    paintSlash();
    if (!canMentionFiles(s)) closeMention();
    else paintMention();
  };

  if (opts.preloadSlash || input.value.trimStart().startsWith('/')) loadSlash();
  if (input.value.trimStart().startsWith('/')) paintSlash();

  return {
    mentionMenu,
    slashMenu,
    pasteChips,
    slashList: () => slashEntries,
    loadSlash,
    expand,
    onInput,
    paintSlash,
    paintMention,
    closeMention,
    reset() {
      paintPastes();
      paintSlash();
      closeMention();
    },
    dismissMenu,
    handleKeydown,
    syncScope,
    dispose() {
      disposed = true;
      filesAbort?.abort();
      filesAbort = undefined;
      slashAbort?.abort();
      slashAbort = undefined;
      input.removeEventListener('paste', onPaste);
      input.removeEventListener('click', onClick);
      input.removeEventListener('keyup', onKeyup);
    },
  };
}

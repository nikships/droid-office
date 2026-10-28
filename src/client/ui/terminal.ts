import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import type { Net, TerminalHold } from '../net';
import { store } from '../state';
import { withToken } from '../token';
import { TERM_THEME } from '../term-theme';
import { suppressMirrorQueries, TerminalMirror } from '../term-mirror';
import { copy } from './clipboard';
import { h, hintToast, openModal, STATUS_LABEL, toast, type Modal } from './dom';
import { colorDot } from './kit';
import { OFFICE_SHELL_ID } from '../../shared/office-shell';
import type { ServerMsg, WorkerInfo } from '../../shared/protocol';
import { PROVIDER_LABEL, outsideNote, statusWord } from '../../shared/guests';
import { teamSummary } from '../../shared/team';
import { forkRefusal } from '../../shared/worker-fork';
import { openForkWorker } from './fork-worker';
import { creditsNote } from '../../shared/factory-sessions';
import { findLine } from '../../shared/search';
import { DROP_MAX_BYTES, droppedPaths } from '../../shared/drops';
import { loadFonts, TERM_FONT } from '../fonts';
import { enterKeyAction, wantsCsiEnter } from '../term-keys';
import { onTermFontSize, setTermFontSize, stepTermFont, termFontSize, TERM_FONT_MAX, TERM_FONT_MIN } from './term-font';
import { terminalSizing } from '../terminal-sizing';

/** A line to scroll to once the terminal has loaded: a search hit (see search.ts). */
export interface TerminalFind {
  /** What was searched for, as a searchKey. */
  needle: string;
  /** How many rows from the bottom of the worker's terminal the line was. */
  fromEnd: number;
}

/** Sends a file dropped or pasted into a worker's terminal to the office; where the office keeps it. */
async function uploadDrop(workerId: string, f: File, floor = store.floor ?? ''): Promise<string> {
  const name = f.name || 'That file';
  if (f.size > DROP_MAX_BYTES) throw new Error(`${name} is too big to drop into a terminal (${DROP_MAX_BYTES / 1024 / 1024} MB at most)`);
  const q = new URLSearchParams({ floor, worker: workerId, name: f.name });
  const res = await fetch(withToken(`/api/term/drop?${q}`), { method: 'POST', headers: { 'content-type': f.type || 'application/octet-stream' }, body: f });
  const r = (await res.json().catch(() => ({}))) as { path?: string; error?: string };
  if (!res.ok || !r.path) throw new Error(r.error ?? `${name} could not be dropped into the terminal`);
  return r.path;
}

let current: { workerId: string; modal: Modal; find(f: TerminalFind): void } | null = null;
/** Opens a teammate's terminal from the team strip (main wires it up, to resume or fix it first). */
let openTeammate: (workerId: string) => void = () => {};

export function onOpenTeammate(fn: (workerId: string) => void) {
  openTeammate = fn;
}
/** Brings a guest in from its window (main wires it up, with its confirmation). */
let bringIn: (workerId: string) => void = () => {};

export function onBringIn(fn: (workerId: string) => void) {
  bringIn = fn;
}
/** Whether we've said, this page load, that Esc now goes to the terminal and how to leave instead. */
let escHinted = false;
const listeners = new Set<(msg: ServerMsg) => void>();

/** Main feeds every server message through here so open terminals can pick theirs. */
export function routeTerminalMessage(msg: ServerMsg) {
  listeners.forEach((fn) => fn(msg));
}

/** The worker whose terminal window is open, if any. */
export function openTerminalFor(): string | null {
  return current?.workerId ?? null;
}

/** The terminal is the front window, not covered by another dialog. */
export function terminalOnTop(): boolean {
  const backdrop = current?.modal.backdrop;
  return !!backdrop && backdrop.parentElement?.lastElementChild === backdrop;
}

/** Closes the open terminal, in a window or inline, if there is one. */
export function closeTerminal() {
  current?.modal.close();
}

/** Where an inline terminal goes, the caller's controls for its header, and what Ctrl+] does there. */
export interface InlineTerminal {
  mount: HTMLElement;
  /** Put first in the header's actions, before Copy and the text size. */
  actions?: HTMLElement;
  /** Ctrl+] in the terminal: leave it. Without one, Ctrl+] goes to the program. */
  onLeave?: () => void;
}

/** One of several terminals side by side (the companion's panes). It never closes another terminal. */
export interface TerminalPaneOptions {
  /** Put first in the header's actions, before Copy and the text size. */
  actions?: HTMLElement;
  /** Shows 🌿 Changes, which calls this. */
  onChanges?: () => void;
  find?: TerminalFind;
  /** Ctrl+] in the terminal: leave it. Without one, Ctrl+] goes to the program. */
  onLeave?: () => void;
  /** The worker left this floor or the office; the pane has already disposed itself. */
  onGone?: () => void;
  /** The pane took keyboard focus, and with it typing and sizing. */
  onFocus?: () => void;
  /** Whether this pane types to and sizes the PTY. Default true. */
  active?: boolean;
}

export interface TerminalPane {
  readonly element: HTMLElement;
  readonly workerId: string;
  /** Only the active pane, once ready, visible and laid out, types or sizes the PTY; others follow its size. */
  setActive(active: boolean): void;
  /** Activates the pane and focuses its terminal. */
  focus(): void;
  find(f: TerminalFind): void;
  /** After the workspace re-lays panes out: repaint the header and fit. */
  update(): void;
  dispose(): void;
}

interface ViewOptions {
  region: boolean;
  actions?: HTMLElement;
  onChanges?: () => void;
  find?: TerminalFind;
  onLeave?: () => void;
  onGone(): void;
  onFocus?: () => void;
  active: boolean;
  /** The window's ✕, last in the header. */
  close?: HTMLElement;
}

interface TerminalView {
  el: HTMLElement;
  host: HTMLElement;
  find(f: TerminalFind): void;
  setActive(on: boolean): void;
  focus(): void;
  update(): void;
  /** Takes drops on `zone`, opens the terminal once fonts are in and holds its stream. */
  start(zone: HTMLElement, focusOnOpen: boolean): void;
  dispose(): void;
}

function createTerminalView(net: Net, workerId: string, o: ViewOptions): TerminalView | undefined {
  const info = store.workers.get(workerId);
  if (!info) return undefined;

  const engine = (w: WorkerInfo) => (w.kind !== 'agent' ? null : w.guest ? PROVIDER_LABEL[w.guest.provider] : 'Droid');
  // A guest has no terminal here: its window shows what the office knows of it, and takes no input.
  const guest = !!info.guest;
  const title = h('h2', {}, [engine(info), info.name].filter(Boolean).join(' · '));
  const sub = h('p.sub.hidden');
  const pill = h('span.pill', {}, '');
  const smaller = h('button.btn.icon', { type: 'button', title: 'Smaller text', 'aria-label': 'Smaller terminal text' }, 'A−');
  const bigger = h('button.btn.icon', { type: 'button', title: 'Bigger text', 'aria-label': 'Bigger terminal text' }, 'A+');
  const zoom = h('span.seg.term-zoom', { role: 'group', 'aria-label': 'Terminal text size' }, smaller, bigger);
  const changesBtn = h('button.btn', { type: 'button', title: 'What this worker changed: files, diff, commit, open a PR (C at the desk)' }, '🌿 Changes');
  const copyBtn = h('button.btn', { type: 'button', title: 'Copy selected text, or the loaded scrollback when nothing is selected' }, 'Copy text');
  const forkBtn = h('button.btn', { type: 'button', onclick: () => openForkWorker(net, workerId) }, 'Fork');
  const disconnected = h('p.note.warn.hidden', { role: 'status' }, 'Disconnected. Terminal input is disabled until a fresh snapshot arrives.');
  const bringInBtn = h('button.btn', { type: 'button' }, '🚪 Bring it in');
  const host = h('div.term-host', guest ? {} : { 'data-drop': 'Drop screenshots or files to put them in the terminal' });
  // A lead's subagents, or a subagent's lead and teammates: one click to the next terminal.
  const team = h('div.term-team.chips.hidden', { role: 'group', 'aria-label': 'Team' });
  let teamKey = '';
  const el = h(
    o.region ? 'div.modal.term.inline' : 'div.modal.full.term',
    o.region ? { role: 'region', 'aria-label': `${info.name} terminal` } : { role: 'dialog', 'aria-label': `${info.name} terminal` },
    h(
      'header',
      {},
      colorDot(info.color),
      h('div.titles', {}, h('div.term-title', {}, title, pill), sub),
      h('div.actions', {}, o.actions ?? null, copyBtn, zoom, o.onChanges ? changesBtn : null, info.kind === 'agent' && !guest ? forkBtn : null, guest ? bringInBtn : null),
      o.close ?? null,
    ),
    team,
    disconnected,
    host,
  );
  const paintTeam = (w: WorkerInfo) => {
    const lead = w.lead ? store.workers.get(w.lead) : undefined;
    const mates = lead ? store.teamOf(lead.id).filter((s) => s.id !== w.id) : store.teamOf(w.id);
    const key = [lead, ...mates].map((x) => x && `${x.id}:${x.name}:${x.status}:${x.title ?? ''}`).join('|');
    if (key === teamKey) return;
    teamKey = key;
    const chip = (x: WorkerInfo) =>
      h(
        'button.chip.team-chip',
        { type: 'button', title: `Open ${x.name}'s terminal${x.title ? `: ${x.title}` : ''}`, onclick: () => openTeammate(x.id) },
        colorDot(x.color),
        h('span.team-chip-name', {}, x.name),
        h('span.pill', { class: x.status }, STATUS_LABEL[x.status] ?? x.status),
      );
    team.classList.toggle('hidden', !lead && !mates.length);
    if (lead) team.replaceChildren(h('span.term-team-label', {}, 'Subagent of'), chip(lead), ...(mates.length ? [h('span.term-team-label', {}, 'with'), ...mates.map(chip)] : []));
    else team.replaceChildren(h('span.term-team-label', {}, teamSummary(mates) ?? ''), ...mates.map(chip));
  };

  const term = new Terminal({
    fontFamily: TERM_FONT,
    fontSize: termFontSize(),
    lineHeight: 1.1,
    theme: TERM_THEME,
    minimumContrastRatio: 4.5,
    cursorBlink: !guest,
    disableStdin: true,
    scrollback: 5000,
    allowProposedApi: true,
    macOptionIsMeta: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  // The addon's default opens a blank window and then assigns its location. Electron's window
  // open handler only sees the blank URL and denies it, so pass the real URL up front.
  term.loadAddon(
    new WebLinksAddon((event, uri) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      window.open(uri, '_blank', 'noopener,noreferrer');
    }),
  );
  // Unicode 11 widths, so powerline glyphs, emoji, CJK and combining marks take the cells
  // they should instead of overlapping or leaving gaps (oh-my-zsh, agnoster…).
  const unicode = new Unicode11Addon();
  term.loadAddon(unicode);
  term.unicode.activeVersion = '11';

  const offQueries = suppressMirrorQueries(term);
  let disposed = false;
  let active = o.active;
  let opened = false;
  let hold: TerminalHold | undefined;
  let lastSentSize = '';
  /**
   * Whether another window already had this terminal open when this one attached. Merely
   * opening or resizing then adopts the shared size instead of reflowing the terminal under
   * it; typing still reclaims the size (latest typist wins). Captured when attaching: the
   * open flag includes this window afterwards, so it can't tell them apart any more.
   */
  let adoptSharedSize = false;
  const laidOut = () => host.isConnected && host.clientWidth > 0 && host.clientHeight > 0;
  /** Sizes the shared PTY to this window, or this window to the shared PTY (see adoptSharedSize). */
  const sendSize = (typing = false) => {
    if (disposed || !mirror.ready || !opened || !net.ready) return;
    if (typing) adoptSharedSize = false;
    const w = store.workers.get(workerId);
    const plan = terminalSizing({ guest, active, laidOut: laidOut(), typing, adoptShared: adoptSharedSize });
    if (plan === 'none') return;
    if (plan === 'fit-only' || plan === 'fit-send') {
      try {
        fit.fit();
      } catch {
        return;
      }
    }
    if (plan === 'follow') {
      if (w && (w.cols !== term.cols || w.rows !== term.rows)) term.resize(w.cols, w.rows);
      return;
    }
    if (plan !== 'fit-send') return;
    const key = `${term.cols}x${term.rows}`;
    if (w && (w.cols !== term.cols || w.rows !== term.rows) && key !== lastSentSize) {
      lastSentSize = key;
      net.send({ t: 'term.resize', workerId, cols: term.cols, rows: term.rows });
    }
  };
  const canType = () => !disposed && !guest && active && laidOut() && mirror.ready && net.ready && !!hold?.attached;

  const refresh = () => {
    if (disposed) return;
    const w = store.workers.get(workerId);
    if (!w) {
      o.onGone();
      return;
    }
    title.textContent = [engine(w), w.name].filter(Boolean).join(' · ');
    title.title = title.textContent;
    sub.textContent = [
      w.guest && `outside the office · pid ${w.guest.pid}`,
      outsideNote(w),
      w.title,
      w.forkedFrom && `Fork of ${w.forkedFrom.name}`,
      w.worktree && `🌿 ${w.worktree.branch}`,
      creditsNote(store.factory.sessions, w.sessionId),
      w.repos?.length && `🗂️ ${[w.worktree?.path.split(/[\\/]/).pop(), ...w.repos.map((r) => r.name)].join(' + ')}`,
    ]
      .filter(Boolean)
      .join(' · ');
    sub.title = sub.textContent;
    sub.classList.toggle('hidden', !sub.textContent);
    pill.className = `pill ${w.status}`;
    pill.textContent = statusWord(w, STATUS_LABEL);
    const forkWhy = forkRefusal(w);
    forkBtn.disabled = !net.ready || !!forkWhy;
    forkBtn.title = forkWhy ?? 'Fork this conversation and its files into an independent worker';
    if (w.guest) {
      const why = w.guest.cantBringIn;
      bringInBtn.toggleAttribute('disabled', !!why);
      bringInBtn.title = why ? `Can't be brought in right now: ${why}` : "Quit its droid outside and carry on the same session here, as one of the office's workers (R at its desk)";
    }
    paintTeam(w);
    // Another window claimed the shared PTY (the latest typist wins): follow it so this view
    // renders correctly. Typing here fits the terminal back to this window and reclaims the size.
    const ptySize = `${w.cols}x${w.rows}`;
    if (mirror.ready && !guest && ptySize !== `${term.cols}x${term.rows}` && ptySize !== lastSentSize) {
      adoptSharedSize = true;
      term.resize(w.cols, w.rows);
      lastSentSize = '';
    }
  };

  /** Scrolls a search hit into view and lights it up for a few seconds. */
  const jumpTo = (f: TerminalFind) => {
    const buf = term.buffer.active;
    const row = findLine(buf, f.needle, f.fromEnd);
    if (row === undefined) return toast('That line has scrolled out of the terminal since', 'warn');
    let end = row;
    while (buf.getLine(end + 1)?.isWrapped) end++;
    // A marker follows the line when the terminal reflows, which it does as the window settles.
    const marker = term.registerMarker(row - (buf.baseY + buf.cursorY));
    if (!marker) return;
    const mark = term.registerDecoration({ marker, width: term.cols, height: end - row + 1, backgroundColor: TERM_THEME.yellow, foregroundColor: TERM_THEME.background });
    const scroll = () => {
      if (marker.line < 0) return;
      // xterm scrolls from where its scrollbar is, which lags behind a resize; from the top is exact.
      term.scrollLines(-term.buffer.active.length);
      term.scrollLines(Math.max(0, marker.line - Math.floor(term.rows / 3)));
    };
    scroll();
    // The window settles its size just after it opens; stay on the line through that.
    const follow = term.onResize(() => setTimeout(scroll, 50));
    setTimeout(() => follow.dispose(), 1500);
    setTimeout(() => {
      mark?.dispose();
      marker.dispose();
    }, 8000);
  };
  let pendingFind = o.find;

  const mirror = new TerminalMirror(
    term,
    (snapshot) => {
      adoptSharedSize = snapshot.shared ?? adoptSharedSize;
      lastSentSize = '';
      term.options.disableStdin = guest || !net.ready;
      disconnected.classList.add('hidden');
      sendSize();
      term.scrollToBottom();
      refresh();
      if (pendingFind) jumpTo(pendingFind);
      pendingFind = undefined;
    },
    () => hold?.resnapshot(),
  );
  const onMsg = (msg: ServerMsg) => {
    // A frame sent before this connection left the floor, or before the arrival was confirmed, is stale.
    if (disposed || !hold || !net.ready) return;
    if (msg.t === 'term.data' && msg.workerId === workerId) mirror.data(msg.data);
    else if (msg.t === 'term.snapshot' && msg.workerId === workerId) {
      term.options.disableStdin = true;
      mirror.snapshot(msg);
    }
  };
  listeners.add(onMsg);
  const unsub = store.on('workers', refresh);
  const unsubCredits = store.on('factory', refresh);
  const ro = new ResizeObserver(() => sendSize());
  // Not ready: the connection dropped or this floor is being left. Input waits for the next
  // authoritative snapshot, which the hold asks for once the office says where this connection is.
  const offReady = net.onReady((ready) => {
    forkBtn.disabled = !ready || !!forkRefusal(store.workers.get(workerId) ?? info);
    if (ready) return;
    mirror.disconnect();
    term.options.disableStdin = true;
    disconnected.classList.remove('hidden');
  });
  const paintZoom = (px: number) => {
    smaller.toggleAttribute('disabled', px <= TERM_FONT_MIN);
    bigger.toggleAttribute('disabled', px >= TERM_FONT_MAX);
    zoom.title = `Text size ${px} px`;
  };
  paintZoom(termFontSize());
  const offFont = onTermFontSize((px) => {
    term.options.fontSize = px;
    paintZoom(px);
    sendSize();
  });
  const zoomBy = (dir: 1 | -1) => {
    setTermFontSize(stepTermFont(term.options.fontSize ?? termFontSize(), dir));
    term.focus();
  };
  smaller.addEventListener('click', () => zoomBy(-1));
  bigger.addEventListener('click', () => zoomBy(1));
  copyBtn.addEventListener('click', () => {
    const buffer = term.buffer.active;
    const text = term.getSelection() || Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true) ?? '').join('\n');
    void copy(text).then((ok) => toast(ok ? 'Terminal text copied' : 'Copy failed. Select text and use your browser’s Copy command.', ok ? 'info' : 'warn'));
  });
  bringInBtn.addEventListener('click', () => bringIn(workerId));
  changesBtn.addEventListener('click', () => o.onChanges?.());

  const csiEnter = () => wantsCsiEnter(store.workers.get(workerId)?.kind);
  term.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown' && e.ctrlKey && e.key === ']' && o.onLeave) {
      o.onLeave();
      return false;
    }
    const enter = enterKeyAction(csiEnter(), e);
    if (enter.do === 'default') return true;
    if (enter.do === 'send') {
      e.preventDefault();
      term.input(enter.data);
    }
    return false;
  });
  term.onData((data) => {
    if (!canType()) return;
    sendSize(true);
    net.send({ t: 'term.input', workerId, data });
  });
  const setActive = (on: boolean) => {
    if (active === on || disposed) return;
    active = on;
    sendSize();
  };
  host.addEventListener('focusin', () => {
    if (disposed) return;
    setActive(true);
    o.onFocus?.();
  });

  // Files dropped in, or a screenshot pasted, go up to the office's machine and the terminal types
  // where they are, as a terminal does with a file dragged into it: Droid attaches a picture.
  let uploading = 0;
  const insertFiles = async (files: File[]) => {
    if (!files.length || disposed) return;
    // A drop or paste on a pane beside the active one makes it the active one, as clicking it would.
    if (!active && !guest) {
      setActive(true);
      o.onFocus?.();
    }
    if (!canType() && !guest) return toast('Disconnected. No files were sent.', 'warn');
    if (guest) return toast(`${info.name} runs outside the office: drop files into its own terminal`, 'warn');
    const stamp = net.stamp();
    const floor = net.floor ?? store.floor ?? '';
    el.classList.toggle('uploading', ++uploading > 0);
    try {
      const paths = await Promise.all(files.map((f) => uploadDrop(workerId, f, floor)));
      if (disposed) return;
      // Uploaded for a connection or floor that has since gone: typing the paths now would land elsewhere.
      if (!net.current(stamp) || !canType()) return toast('The connection changed while uploading. Nothing was typed.', 'warn');
      sendSize(true);
      term.paste(droppedPaths(paths));
      term.focus();
    } catch (err) {
      toast((err as Error).message, 'warn');
    } finally {
      el.classList.toggle('uploading', --uploading > 0);
    }
  };
  const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
  // A picture on the clipboard with no text (a screenshot) pastes like a dropped file. Caught on the
  // way down, before xterm would paste it as nothing.
  host.addEventListener(
    'paste',
    (e) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (!files.length || e.clipboardData?.getData('text/plain')) return;
      e.preventDefault();
      e.stopPropagation();
      void insertFiles(files);
    },
    true,
  );

  return {
    el,
    host,
    find: (f) => {
      if (mirror.ready) jumpTo(f);
      else pendingFind = f;
    },
    setActive,
    focus() {
      setActive(true);
      term.focus();
    },
    update() {
      refresh();
      sendSize();
    },
    start(zone, focusOnOpen) {
      // The whole zone takes drops while the terminal is open, so a near miss doesn't open the file in the browser.
      let dragDepth = 0;
      const dragEnd = () => {
        dragDepth = 0;
        el.classList.remove('dropping');
      };
      zone.addEventListener('dragenter', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth++;
        el.classList.add('dropping');
      });
      zone.addEventListener('dragover', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer!.dropEffect = 'copy';
      });
      zone.addEventListener('dragleave', (e) => {
        if (hasFiles(e) && --dragDepth <= 0) dragEnd();
      });
      zone.addEventListener('drop', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragEnd();
        void insertFiles([...e.dataTransfer!.files]);
      });
      refresh();
      // xterm caches glyph widths when it opens. Opening after the shared font load prevents a
      // slow first visit from retaining fallback measurements even after the icons arrive.
      void loadFonts().then(() => {
        if (disposed) return;
        term.open(host);
        opened = true;
        ro.observe(host);
        adoptSharedSize = store.workers.get(workerId)?.open === true;
        // Its own snapshot even when a Thread pane already holds the stream.
        hold = net.acquireTerminal(workerId, { snapshot: true });
        if (focusOnOpen)
          setTimeout(() => {
            if (!disposed && active) term.focus();
          }, 50);
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.delete(onMsg);
      unsub();
      unsubCredits();
      offReady();
      offQueries();
      mirror.disconnect();
      offFont();
      ro.disconnect();
      hold?.release();
      hold = undefined;
      term.dispose();
      el.remove();
    },
  };
}

/**
 * Opens a worker's terminal in a window. With `inline`, it fills `inline.mount` instead: no window,
 * backdrop or ✕, and Esc goes to the program. The caller closes it with `closeTerminal`. Either way it
 * is the one terminal window: opening another closes it.
 */
export function openTerminal(net: Net, workerId: string, onChanges?: () => void, find?: TerminalFind, inline?: InlineTerminal) {
  if (current?.workerId === workerId) {
    if (find) current.find(find);
    return;
  }
  current?.modal.close();
  if (!store.workers.get(workerId)) return;
  const closeBtn = inline ? undefined : h('button.btn.icon.close', { title: 'Leave terminal (Shift+Esc or Ctrl+]) · Esc goes to the terminal', 'aria-label': 'Close' }, '✕');
  let modal: Modal | undefined;
  const close = () => modal?.close();
  const view = createTerminalView(net, workerId, {
    region: !!inline,
    actions: inline?.actions,
    onChanges: onChanges
      ? () => {
          onChanges();
          close();
        }
      : undefined,
    find,
    onLeave: inline ? inline.onLeave : close,
    onGone: close,
    active: true,
    close: closeBtn,
  });
  if (!view) return;
  const info = store.workers.get(workerId)!;
  const onClose = () => {
    view.dispose();
    if (current?.modal === modal) current = null;
  };
  if (inline) {
    let closed = false;
    modal = {
      el: view.el,
      backdrop: inline.mount,
      close() {
        if (closed) return;
        closed = true;
        onClose();
      },
    };
    inline.mount.replaceChildren(view.el);
  } else
    modal = openModal(view.el, {
      backdropCloses: true,
      // TUIs use Esc to back out of their own menus, so while you're typing in the terminal it goes
      // to the program. Shift+Esc (or Ctrl+], or Esc once focus is off the terminal) leaves.
      escCloses: (e) => {
        if (e.shiftKey || !view.host.contains(document.activeElement)) return true;
        if (!escHinted) {
          escHinted = true;
          hintToast('Esc went to the terminal. Shift+Esc or Ctrl+] leaves it');
        }
        return false;
      },
      doing: `💻 in ${info.name}'s terminal`,
      onClose,
    });
  closeBtn?.addEventListener('click', close);
  current = { workerId, modal, find: view.find };
  view.start(modal.backdrop, true);
}

/**
 * A worker's terminal in `mount`, beside others: any number at once, each a distinct worker. It
 * replaces what `mount` holds, never closes the terminal window, and holds the worker's stream
 * until `dispose`, so closing another view of the same worker leaves it streaming.
 */
export function mountTerminal(net: Net, workerId: string, mount: HTMLElement, opts: TerminalPaneOptions = {}): TerminalPane | undefined {
  let pane: TerminalPane | undefined;
  const view = createTerminalView(net, workerId, {
    region: true,
    actions: opts.actions,
    onChanges: opts.onChanges,
    find: opts.find,
    onLeave: opts.onLeave,
    onGone: () => {
      pane?.dispose();
      opts.onGone?.();
    },
    onFocus: opts.onFocus,
    active: opts.active ?? true,
  });
  if (!view) return undefined;
  mount.replaceChildren(view.el);
  pane = {
    element: view.el,
    workerId,
    setActive: view.setActive,
    focus: view.focus,
    find: view.find,
    update: view.update,
    dispose: view.dispose,
  };
  view.start(view.el, opts.active ?? true);
  return pane;
}
/**
 * The boss monitor's shell. The same kind of terminal as a shell worker's, but there is no worker:
 * no status, no changes, no team. `OFFICE_SHELL_ID` is what `openTerminalFor` reports while it's open,
 * so a reconnect can attach again.
 */
export function openOfficeShell(net: Net) {
  if (current?.workerId === OFFICE_SHELL_ID) return;
  current?.modal.close();
  const where = store.project?.name || 'this floor';
  const title = h('h2', {}, 'Shell');
  const sub = h('p.sub', {}, where);
  const pill = h('span.pill', {}, 'shell');
  const smaller = h('button.btn.icon', { type: 'button', title: 'Smaller text', 'aria-label': 'Smaller terminal text' }, 'A−');
  const bigger = h('button.btn.icon', { type: 'button', title: 'Bigger text', 'aria-label': 'Bigger terminal text' }, 'A+');
  const zoom = h('span.seg.term-zoom', { role: 'group', 'aria-label': 'Terminal text size' }, smaller, bigger);
  const closeBtn = h('button.btn.icon.close', { title: 'Leave terminal (Shift+Esc or Ctrl+]) · Esc goes to the terminal', 'aria-label': 'Close' }, '✕');
  const host = h('div.term-host', { 'data-drop': 'Drop screenshots or files to put them in the shell' });
  const el = h('div.modal.full.term', { role: 'dialog', 'aria-label': 'Shell' }, h('header', {}, colorDot('#8d99ae'), h('div.titles', {}, h('div.term-title', {}, title, pill), sub), h('div.actions', {}, zoom), closeBtn), host);

  const term = new Terminal({
    fontFamily: TERM_FONT,
    fontSize: termFontSize(),
    lineHeight: 1.1,
    theme: TERM_THEME,
    minimumContrastRatio: 4.5,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
    macOptionIsMeta: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(
    new WebLinksAddon((event, uri) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      window.open(uri, '_blank', 'noopener,noreferrer');
    }),
  );
  const unicode = new Unicode11Addon();
  term.loadAddon(unicode);
  term.unicode.activeVersion = '11';

  let opened = false;
  let shared = false;
  let lastSentSize = '';
  let ptyCols = 0;
  let ptyRows = 0;
  const offQueries = suppressMirrorQueries(term);
  let mirror: TerminalMirror | undefined;

  const sendSize = (typing = false) => {
    if (!mirror?.ready || !opened) return;
    if (!typing && shared) {
      if (ptyCols !== term.cols || ptyRows !== term.rows) term.resize(ptyCols, ptyRows);
      return;
    }
    try {
      fit.fit();
    } catch {
      return;
    }
    const key = `${term.cols}x${term.rows}`;
    if ((ptyCols !== term.cols || ptyRows !== term.rows) && key !== lastSentSize) {
      lastSentSize = key;
      shared = false;
      net.send({ t: 'shell.resize', cols: term.cols, rows: term.rows });
    }
  };

  mirror = new TerminalMirror(
    term,
    (snapshot) => {
      shared = snapshot.shared === true;
      ptyCols = snapshot.cols;
      ptyRows = snapshot.rows;
      lastSentSize = '';
      sendSize();
      term.scrollToBottom();
    },
    () => net.send({ t: 'shell.attach' }),
  );
  const onMsg = (msg: ServerMsg) => {
    if (msg.t === 'term.data' && msg.workerId === OFFICE_SHELL_ID) mirror?.data(msg.data);
    else if (msg.t === 'term.snapshot' && msg.workerId === OFFICE_SHELL_ID) {
      shared = msg.shared === true;
      ptyCols = msg.cols;
      ptyRows = msg.rows;
      mirror?.snapshot(msg);
    }
  };
  listeners.add(onMsg);
  // Another window typed and changed the size: follow it, unless this one just sent that size.
  const unsub = store.on('screens', () => {
    const s = store.screens.get(OFFICE_SHELL_ID);
    if (!s || !mirror?.ready) return;
    if (s.cols === ptyCols && s.rows === ptyRows) return;
    ptyCols = s.cols;
    ptyRows = s.rows;
    if (`${ptyCols}x${ptyRows}` === lastSentSize) return;
    term.resize(ptyCols, ptyRows);
    lastSentSize = '';
  });
  const ro = new ResizeObserver(() => sendSize());

  const modal = openModal(el, {
    backdropCloses: true,
    escCloses: (e) => {
      if (e.shiftKey || !host.contains(document.activeElement)) return true;
      if (!escHinted) {
        escHinted = true;
        hintToast('Esc went to the terminal. Shift+Esc or Ctrl+] leaves it');
      }
      return false;
    },
    doing: '💻 in the shell',
    onClose: () => {
      listeners.delete(onMsg);
      unsub();
      offQueries();
      mirror?.disconnect();
      offFont();
      ro.disconnect();
      net.send({ t: 'shell.detach' });
      term.dispose();
      if (current?.modal === modal) current = null;
    },
  });
  current = { workerId: OFFICE_SHELL_ID, modal, find: () => {} };
  const paintZoom = (px: number) => {
    smaller.toggleAttribute('disabled', px <= TERM_FONT_MIN);
    bigger.toggleAttribute('disabled', px >= TERM_FONT_MAX);
    zoom.title = `Text size ${px} px`;
  };
  paintZoom(termFontSize());
  const offFont = onTermFontSize((px) => {
    term.options.fontSize = px;
    paintZoom(px);
    sendSize();
  });
  const zoomBy = (dir: 1 | -1) => {
    setTermFontSize(stepTermFont(term.options.fontSize ?? termFontSize(), dir));
    term.focus();
  };
  smaller.addEventListener('click', () => zoomBy(-1));
  bigger.addEventListener('click', () => zoomBy(1));
  closeBtn.addEventListener('click', () => modal.close());

  term.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown' && e.ctrlKey && e.key === ']') {
      modal.close();
      return false;
    }
    const enter = enterKeyAction(false, e);
    if (enter.do === 'default') return true;
    if (enter.do === 'send') {
      e.preventDefault();
      term.input(enter.data);
    }
    return false;
  });
  term.onData((data) => {
    sendSize(true);
    net.send({ t: 'shell.input', data });
  });

  let uploading = 0;
  const insertFiles = async (files: File[]) => {
    if (!files.length) return;
    el.classList.toggle('uploading', ++uploading > 0);
    try {
      const paths = await Promise.all(files.map((f) => uploadDrop(OFFICE_SHELL_ID, f)));
      if (current?.modal !== modal) return;
      sendSize(true);
      term.paste(droppedPaths(paths));
      term.focus();
    } catch (err) {
      toast((err as Error).message, 'warn');
    } finally {
      el.classList.toggle('uploading', --uploading > 0);
    }
  };
  const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
  let dragDepth = 0;
  const dragEnd = () => {
    dragDepth = 0;
    el.classList.remove('dropping');
  };
  modal.backdrop.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    el.classList.add('dropping');
  });
  modal.backdrop.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
  });
  modal.backdrop.addEventListener('dragleave', (e) => {
    if (hasFiles(e) && --dragDepth <= 0) dragEnd();
  });
  modal.backdrop.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragEnd();
    void insertFiles([...e.dataTransfer!.files]);
  });
  host.addEventListener(
    'paste',
    (e) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (!files.length || e.clipboardData?.getData('text/plain')) return;
      e.preventDefault();
      e.stopPropagation();
      void insertFiles(files);
    },
    true,
  );

  void loadFonts().then(() => {
    if (current?.modal !== modal) return;
    term.open(host);
    opened = true;
    ro.observe(host);
    net.send({ t: 'shell.attach' });
    setTimeout(() => {
      if (current?.modal === modal) term.focus();
    }, 50);
  });
}

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import type { Net } from '../net';
import { store } from '../state';
import { withToken } from '../token';
import { TERM_THEME } from '../world/laptop';
import { h, hintToast, openModal, STATUS_LABEL, toast, type Modal } from './dom';
import type { ServerMsg, WorkerInfo } from '../../shared/protocol';
import { PROVIDER_LABEL, outsideNote, statusWord } from '../../shared/guests';
import { teamSummary } from '../../shared/team';
import { findLine } from '../../shared/search';
import { DROP_MAX_BYTES, droppedPaths } from '../../shared/drops';
import { loadFonts, TERM_FONT } from '../fonts';
import { enterKeyAction, wantsCsiEnter } from '../term-keys';
import { onTermFontSize, setTermFontSize, stepTermFont, termFontSize, TERM_FONT_MAX, TERM_FONT_MIN } from './term-font';

/** A line to scroll to once the terminal has loaded: a search hit (see search.ts). */
export interface TerminalFind {
  /** What was searched for, as a searchKey. */
  needle: string;
  /** How many rows from the bottom of the worker's terminal the line was. */
  fromEnd: number;
}

/** Sends a file dropped or pasted into a worker's terminal to the office; where the office keeps it. */
async function uploadDrop(workerId: string, f: File): Promise<string> {
  const name = f.name || 'That file';
  if (f.size > DROP_MAX_BYTES) throw new Error(`${name} is too big to drop into a terminal (${DROP_MAX_BYTES / 1024 / 1024} MB at most)`);
  const q = new URLSearchParams({ floor: store.floor ?? '', worker: workerId, name: f.name });
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

export function openTerminal(net: Net, workerId: string, onChanges?: () => void, find?: TerminalFind) {
  if (current?.workerId === workerId) {
    if (find) current.find(find);
    return;
  }
  current?.modal.close();
  const info = store.workers.get(workerId);
  if (!info) return;

  const dot = h('span.dot', { style: `background:${info.color}` });
  const engine = (w: WorkerInfo) => (w.kind !== 'agent' ? null : w.guest ? PROVIDER_LABEL[w.guest.provider] : 'Droid');
  // A guest has no terminal here: its window shows what the office knows of it, and takes no input.
  const guest = !!info.guest;
  const title = h('h2', {}, [engine(info), info.name].filter(Boolean).join(' · '));
  const pill = h('span.pill', {}, '');
  const smaller = h('button.btn.term-zoom', { type: 'button', title: 'Smaller text', 'aria-label': 'Smaller terminal text' }, 'A−');
  const bigger = h('button.btn.term-zoom', { type: 'button', title: 'Bigger text', 'aria-label': 'Bigger terminal text' }, 'A+');
  const zoom = h('span.term-zoom-group', { role: 'group', 'aria-label': 'Terminal text size' }, smaller, bigger);
  const changesBtn = h('button.btn', { type: 'button', title: 'What this worker changed: files, diff, commit, open a PR (C at the desk)' }, '🌿 Changes');
  const bringInBtn = h('button.btn', { type: 'button' }, '🚪 Bring it in');
  const closeBtn = h('button.btn.close', { title: 'Leave terminal (Shift+Esc or Ctrl+]) · Esc goes to the terminal', 'aria-label': 'Close' }, '✕');
  const host = h('div.term-host', guest ? {} : { 'data-drop': '📎 Drop screenshots or files here to put them in the terminal' });
  // A lead's subagents, or a subagent's lead and teammates: one click to the next terminal.
  const team = h('div.term-team.hidden', { role: 'group', 'aria-label': 'Team' });
  let teamKey = '';
  const el = h('div.modal.term', { role: 'dialog', 'aria-label': `${info.name} terminal` }, h('header', {}, dot, title, pill, zoom, onChanges ? changesBtn : null, guest ? bringInBtn : null, closeBtn), team, host);
  const paintTeam = (w: WorkerInfo) => {
    const lead = w.lead ? store.workers.get(w.lead) : undefined;
    const mates = lead ? store.teamOf(lead.id).filter((s) => s.id !== w.id) : store.teamOf(w.id);
    const key = [lead, ...mates].map((x) => x && `${x.id}:${x.name}:${x.status}:${x.title ?? ''}`).join('|');
    if (key === teamKey) return;
    teamKey = key;
    const chip = (x: WorkerInfo) =>
      h(
        'button.team-chip',
        { type: 'button', title: `Open ${x.name}'s terminal${x.title ? `: ${x.title}` : ''}`, onclick: () => openTeammate(x.id) },
        h('span.dot', { style: `background:${x.color}` }),
        x.name,
        h('span.pill', { class: x.status }, STATUS_LABEL[x.status] ?? x.status),
      );
    team.classList.toggle('hidden', !lead && !mates.length);
    if (lead) team.replaceChildren(h('span.term-team-label', {}, '🧭 Subagent of'), chip(lead), ...(mates.length ? [h('span.term-team-label', {}, 'with'), ...mates.map(chip)] : []));
    else team.replaceChildren(h('span.term-team-label', {}, teamSummary(mates) ?? ''), ...mates.map(chip));
  };

  const term = new Terminal({
    fontFamily: TERM_FONT,
    fontSize: termFontSize(),
    lineHeight: 1.1,
    theme: TERM_THEME,
    cursorBlink: !guest,
    disableStdin: guest,
    scrollback: 5000,
    allowProposedApi: true,
    macOptionIsMeta: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  // Unicode 11 widths, so powerline glyphs, emoji, CJK and combining marks take the cells
  // they should instead of overlapping or leaving gaps (oh-my-zsh, agnoster…).
  const unicode = new Unicode11Addon();
  term.loadAddon(unicode);
  term.unicode.activeVersion = '11';

  let ready = false;
  let opened = false;
  let lastSentSize = '';
  /**
   * Whether another window already had this terminal open when this one attached. Merely
   * opening or resizing then adopts the shared size instead of reflowing the terminal under
   * it; typing still reclaims the size (latest typist wins). Captured when attaching: the
   * open flag includes this window afterwards, so it can't tell them apart any more.
   */
  let adoptSharedSize = false;
  /** Sizes the shared PTY to this window, or this window to the shared PTY (see adoptSharedSize). */
  const sendSize = (typing = false) => {
    if (!ready || !opened) return;
    // No terminal to size: the banner just fills the window.
    if (guest) {
      try {
        fit.fit();
      } catch {
        // not laid out yet
      }
      return;
    }
    if (!typing && adoptSharedSize) {
      const w = store.workers.get(workerId);
      if (w && (w.cols !== term.cols || w.rows !== term.rows)) term.resize(w.cols, w.rows);
      return;
    }
    try {
      fit.fit();
    } catch {
      return;
    }
    const key = `${term.cols}x${term.rows}`;
    const w = store.workers.get(workerId);
    if (w && (w.cols !== term.cols || w.rows !== term.rows) && key !== lastSentSize) {
      lastSentSize = key;
      net.send({ t: 'term.resize', workerId, cols: term.cols, rows: term.rows });
    }
  };

  const refresh = () => {
    const w = store.workers.get(workerId);
    if (!w) {
      modal.close();
      return;
    }
    title.textContent = [
      engine(w),
      w.name,
      w.guest && `🚪 outside the office · pid ${w.guest.pid}`,
      outsideNote(w),
      w.title,
      w.worktree && `🌿 ${w.worktree.branch}`,
      w.repos?.length && `🗂️ ${[w.worktree?.path.split(/[\\/]/).pop(), ...w.repos.map((r) => r.name)].join(' + ')}`,
    ]
      .filter(Boolean)
      .join(' · ');
    pill.className = `pill ${w.status}`;
    pill.textContent = statusWord(w, STATUS_LABEL);
    if (w.guest) {
      const why = w.guest.cantBringIn;
      bringInBtn.toggleAttribute('disabled', !!why);
      bringInBtn.title = why ? `Can't be brought in right now: ${why}` : "Quit its droid outside and carry on the same session here, as one of the office's workers (R at its desk)";
    }
    paintTeam(w);
    // Another window claimed the shared PTY (the latest typist wins): follow it so this view
    // renders correctly. Typing here fits the terminal back to this window and reclaims the size.
    const ptySize = `${w.cols}x${w.rows}`;
    if (ready && !guest && ptySize !== `${term.cols}x${term.rows}` && ptySize !== lastSentSize) {
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
  let pendingFind = find;

  const onMsg = (msg: ServerMsg) => {
    if (msg.t === 'term.data' && msg.workerId === workerId) term.write(msg.data);
    else if (msg.t === 'term.snapshot' && msg.workerId === workerId) {
      term.reset();
      term.resize(msg.cols, msg.rows);
      term.write(msg.data, () => {
        ready = true;
        sendSize();
        term.scrollToBottom();
        refresh();
        if (pendingFind) jumpTo(pendingFind);
        pendingFind = undefined;
      });
    }
  };
  listeners.add(onMsg);
  const unsub = store.on('workers', refresh);
  const ro = new ResizeObserver(() => sendSize());

  const modal = openModal(el, {
    backdropCloses: true,
    // TUIs use Esc to back out of their own menus, so while you're typing in the terminal it goes
    // to the program. Shift+Esc (or Ctrl+], or Esc once focus is off the terminal) leaves.
    escCloses: (e) => {
      if (e.shiftKey || !host.contains(document.activeElement)) return true;
      if (!escHinted) {
        escHinted = true;
        hintToast('Esc went to the terminal. Shift+Esc or Ctrl+] leaves it');
      }
      return false;
    },
    doing: `💻 in ${info.name}'s terminal`,
    onClose: () => {
      listeners.delete(onMsg);
      unsub();
      offFont();
      ro.disconnect();
      net.send({ t: 'worker.detach', workerId });
      term.dispose();
      if (current?.modal === modal) current = null;
    },
  });
  const csiEnter = () => wantsCsiEnter(store.workers.get(workerId)?.kind);
  current = {
    workerId,
    modal,
    find: (f) => {
      if (ready) jumpTo(f);
      else pendingFind = f;
    },
  };
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
  bringInBtn.addEventListener('click', () => bringIn(workerId));
  changesBtn.addEventListener('click', () => {
    onChanges?.();
    modal.close();
  });

  term.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown' && e.ctrlKey && e.key === ']') {
      modal.close();
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
    if (guest) return;
    sendSize(true);
    net.send({ t: 'term.input', workerId, data });
  });

  // Files dropped in, or a screenshot pasted, go up to the office's machine and the terminal types
  // where they are, as a terminal does with a file dragged into it: Droid attaches a picture.
  let uploading = 0;
  const insertFiles = async (files: File[]) => {
    if (!files.length) return;
    if (guest) return toast(`${info.name} runs outside the office: drop files into its own terminal`, 'warn');
    el.classList.toggle('uploading', ++uploading > 0);
    try {
      const paths = await Promise.all(files.map((f) => uploadDrop(workerId, f)));
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
  // The whole screen is the drop zone while the terminal is open, so a near miss doesn't open the file in the browser.
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

  refresh();
  // xterm caches glyph widths when it opens. Opening after the shared font load prevents a
  // slow first visit from retaining fallback measurements even after the icons arrive.
  void loadFonts().then(() => {
    if (current?.modal !== modal) return;
    term.open(host);
    opened = true;
    ro.observe(host);
    adoptSharedSize = store.workers.get(workerId)?.open === true;
    net.send({ t: 'worker.attach', workerId });
    setTimeout(() => {
      if (current?.modal === modal) term.focus();
    }, 50);
  });
}

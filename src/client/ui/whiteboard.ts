// The Whiteboard window (docs/whiteboard.md, "The window"): the floor's board as a grid of cards,
// newest first, and one card opened large with its marks and a side panel. Opened from the ☰ menu,
// office.open('whiteboard') and the wall. The board itself is store.whiteboard (whiteboard-sync.ts):
// every edit here is a batch applied at once and sent when the office has the connection.
//
// What the wall shows follows the window's explicit navigation: opening a card or going Back to grid
// sends `show`; closing the window leaves it. A worker's `show` never moves an open window: it says so,
// with a button to open that card.

import type { ServerMsg } from '../../shared/protocol';
import { changesSince, type ChangeItem } from '../../shared/whiteboard-marks';
import { OWNER, cardChanged, cardsNewestFirst, findCard, type Board, type Card, type CardView, type Op, type Selection } from '../../shared/whiteboard';
import type { Net } from '../net';
import { store } from '../state';
import { withToken } from '../token';
import { copy } from './clipboard';
import { h, openModal, setDoing, timeAgo, toast, type Modal } from './dom';
import { colorDot, emptyState } from './kit';
import { confirmDelete, openAddHtml, openPing, routePinged } from './whiteboard-dialogs';
import { Panel } from './whiteboard-panel';
import { Surface } from './whiteboard-surface';
import { authorColor, authorName, changedCount, copyForAgent, newId, ownerReadPoint, viewMoved, zoomLabel } from './whiteboard-view';

interface WindowCtl {
  floor: string;
  /** Opens a card (or the grid), as the owner's own navigation. */
  go(card: string | null): void;
  /** A worker put a card on the wall. */
  shown(by: string, card: string): void;
}

let open: WindowCtl | null = null;

/** Cards changed since the owner last opened them, for the ☰ menu's count. */
export function whiteboardChanged(): number {
  return store.floor ? changedCount(store.whiteboard.board(store.floor)) : 0;
}

/** The server messages the window answers besides the board itself: ping results, and a worker's `show`. */
export function routeWhiteboardMessage(msg: ServerMsg) {
  if (msg.t === 'whiteboard.pinged') return routePinged(msg);
  if (msg.t !== 'whiteboard' || msg.update.kind !== 'patch' || !open || open.floor !== msg.floor) return;
  const { actor, ops } = msg.update.patch;
  if (actor.kind !== 'worker') return;
  const show = [...ops].reverse().find((o): o is Extract<Op, { op: 'show' }> => o.op === 'show');
  if (show?.selection.kind === 'card') open.shown(actor.name, show.selection.id);
}

export function openWhiteboard(net: Net, opts: { card?: string } = {}): void {
  if (open) {
    if (opts.card) open.go(opts.card);
    return;
  }
  const here = store.floor;
  if (!here) {
    toast('The Whiteboard is on each floor: take the elevator to one first', 'warn');
    return;
  }
  const floor: string = here;
  const sync = store.whiteboard;

  // ---- Frame of the window ----
  const titleEl = h('h2', {}, 'Whiteboard');
  const sub = h('p.sub');
  const titles = h('div.titles', {}, titleEl, sub);
  const actions = h('div.actions');
  const back = h('button.btn.sm.wb-back', { type: 'button', title: 'Back to the grid of cards' }, '← Grid');
  const header = h('header', {}, back, titles, actions);
  const bars = h('div.wb-bars');
  const main = h('div.wb-main');
  const el = h('div.modal.wb', { 'aria-label': 'Whiteboard', tabindex: '-1' }, header, bars, main);

  let card: string | null = null;
  let surface: Surface | null = null;
  let panel: Panel | null = null;
  /** The owner's read point for the open card when they opened it: what's "changed since you looked". */
  let since = 0;
  let notice: { by: string; card: string; timer: number } | null = null;
  let dismissedError: unknown = null;
  let readTimer = 0;
  let lastView: CardView | undefined;
  let marksVisible = true;

  const board = (): Board | null => sync.board(floor);
  const fileUrl = (hash: string) => withToken(`/api/whiteboard/file?${new URLSearchParams({ floor, card: card ?? '', hash })}`);

  /** Applies the owner's batch; what went wrong goes in a toast (an expired batch becomes a draft in the window). */
  async function apply(ops: Op[], what = 'That'): Promise<boolean> {
    if (!ops.length) return true;
    const r = await sync.apply(floor, ops);
    if (!r.ok && r.reason === 'invalid') toast(`${what} didn't work: ${r.error.reason}`, 'error');
    return r.ok;
  }

  const show = (selection: Selection) => {
    const b = board();
    if (!b) return;
    const same = b.selection.kind === selection.kind && (selection.kind === 'grid' || (b.selection.kind === 'card' && b.selection.id === selection.id));
    if (!same) void apply([{ op: 'show', selection }], 'Showing it on the wall');
  };

  /** Moves the owner's read point for the open card to the board as it is, when someone else changed it. */
  const markRead = () => {
    clearTimeout(readTimer);
    readTimer = window.setTimeout(() => {
      const b = board();
      if (!b || !card || !findCard(b, card) || !cardChanged(b, OWNER, card)) return;
      void apply([{ op: 'read', cards: [card], rev: b.rev }]);
    }, 600);
  };

  const changes = (): ChangeItem[] => {
    const b = board();
    return b && card ? changesSince(b, card, since) : [];
  };

  // ---- Navigation ----

  function go(id: string | null, explicit = true) {
    const b = board();
    if (id && b && !findCard(b, id)) id = null;
    if (id === card && (id !== null || main.querySelector('.wb-grid-wrap'))) return;
    leaveCard();
    card = id;
    if (explicit) show(id ? { kind: 'card', id } : { kind: 'grid' });
    if (id && b) {
      since = ownerReadPoint(b, id);
      openCard(findCard(b, id)!);
      markRead();
    } else paintGrid();
    paintBars();
    paintHeader();
  }

  function leaveCard() {
    surface?.dispose();
    surface = null;
    panel = null;
    tb = null;
    lastView = undefined;
    clearTimeout(readTimer);
  }

  // ---- The grid ----

  function paintGrid() {
    const b = board();
    setDoing(modal, '🧑‍🎨 at the Whiteboard');
    el.classList.remove('wb-on-card');
    if (!b) {
      main.replaceChildren(h('div.wb-grid-wrap', {}, h('div.wb-loading', {}, h('div.spinner'), 'Loading the board…')));
      return;
    }
    const cards = cardsNewestFirst(b);
    if (!cards.length) {
      main.replaceChildren(
        h(
          'div.wb-grid-wrap',
          {},
          emptyState(
            '🧑‍🎨',
            'Nothing on the board yet',
            'Ask a worker to put something on it ("put your plan on the Whiteboard"), or start a canvas or add your own HTML.',
            h('div.row', {}, h('button.btn.accent', { type: 'button', onclick: newCanvas }, 'New canvas'), h('button.btn', { type: 'button', onclick: addHtml }, 'Add HTML')),
          ),
        ),
      );
      return;
    }
    const scroller = main.querySelector('.wb-grid-wrap');
    const top = scroller?.scrollTop ?? 0;
    const grid = h('div.wb-grid', { role: 'list' }, ...cards.map((c) => tile(b, c)));
    const note = rendererNote();
    const wrap = h('div.wb-grid-wrap', {}, ...(note ? [h('p.note.info.wb-grid-note', {}, note)] : []), grid);
    main.replaceChildren(wrap);
    wrap.scrollTop = top;
  }

  function tile(b: Board, c: Card): HTMLElement {
    const changed = cardChanged(b, OWNER, c.id);
    const url = sync.renderUrl(floor, c.id, { size: 'thumb' });
    const thumb = h('div.wb-thumb', { class: c.kind });
    const placeholder = () => thumb.replaceChildren(h('div.wb-thumb-empty', {}, h('span.wb-thumb-icon', { 'aria-hidden': 'true' }, c.kind === 'canvas' ? '🧑‍🎨' : '📄'), h('span', {}, previewNote(c))));
    if (url) {
      const img = h('img', { src: withToken(url), alt: '', loading: 'lazy' });
      img.addEventListener('error', placeholder);
      thumb.append(img);
    } else placeholder();
    const marks = [c.threads.length && `💬 ${c.threads.filter((t) => !t.resolved).length}`, c.stickies.length && `🗒 ${c.stickies.length}`, c.pictures.length && `🖼 ${c.pictures.length}`].filter(Boolean).join('  ');
    return h(
      'button.wb-tile',
      { type: 'button', role: 'listitem', 'data-card': c.id, class: changed ? 'changed' : '', title: `Open “${c.title}”`, onclick: () => go(c.id) },
      thumb,
      h(
        'span.wb-tile-body',
        {},
        h('span.wb-tile-title', {}, changed ? h('span.wb-changed-dot', { title: 'Changed since you last looked', 'aria-label': 'Changed' }) : null, h('span.wb-tile-name', { title: c.title }, c.title)),
        h('span.wb-tile-meta', {}, colorDot(authorColor(c.author)), h('span.wb-tile-who', {}, authorName(c.author)), h('span', {}, `updated ${timeAgo(c.updatedAt)}`), marks ? h('span.wb-tile-marks', {}, marks) : null),
      ),
    );
  }

  /** What a card without an image yet says: why previews are missing, or that one is coming. */
  function previewNote(c: Card): string {
    if (c.kind === 'canvas') return c.stickies.length + c.pictures.length + c.threads.length ? 'Canvas' : 'Blank canvas';
    const f = sync.floor(floor);
    const info = f.renders[c.id];
    if (info?.error) return `Preview failed: ${info.error}`;
    if (!f.renderer.available) return f.renderer.installing ? 'Setting up previews…' : 'No preview';
    return 'Preview coming…';
  }

  /** Why the grid has no images, said once above it rather than in every tile. */
  function rendererNote(): string | undefined {
    const r = sync.floor(floor).renderer;
    if (r.available) return undefined;
    if (r.installing) return `Setting up card previews…${r.installing.percent !== undefined ? ` ${Math.round(r.installing.percent)}%` : ''}`;
    return `No previews: ${r.reason ?? 'the renderer is unavailable'}`;
  }

  // ---- A card ----

  function openCard(c: Card) {
    el.classList.add('wb-on-card');
    setDoing(modal, `🧑‍🎨 on “${c.title}” at the Whiteboard`);
    panel = new Panel({ apply, surface: () => surface, changes, fileUrl });
    surface = new Surface(
      {
        floor,
        apply,
        notify: (text) => toast(text, 'warn'),
        cardUrl: (nonce) => sync.cardUrl(floor, c.id, nonce),
        fileUrl,
        live: () => sync.state(floor) === 'live',
        selectMark: (kind, id) => kind === 'thread' && panel?.focusThread(id),
        changed: () => paintToolbar(),
        located: () => {
          const now = board() && card ? findCard(board()!, card) : undefined;
          if (now) panel?.render(now);
        },
        view: (v) => {
          const now = board() && card ? findCard(board()!, card) : undefined;
          if (!now || !viewMoved(lastView ?? now.view, v)) return;
          lastView = v;
          void apply([{ op: 'card.view', card: now.id, view: v }]);
        },
        changedMarks: () => new Set(changes().flatMap((x) => (x.mark ? [x.mark.id] : []))),
        render: () => sync.floor(floor).renders[c.id],
      },
      c,
    );
    main.replaceChildren(buildToolbar(surface), h('div.wb-art', { class: marksVisible ? '' : 'marks-hidden' }, surface.el, panel.el));
    paintToolbar();
    panel.render(c);
    surface.el.focus({ preventScroll: true });
  }

  let tb: { use: HTMLElement; markup: HTMLElement; pan: HTMLElement; marks: HTMLElement; fit: HTMLElement; actual: HTMLElement; fs: HTMLElement; label: HTMLElement; hint: HTMLElement } | null = null;

  /** The toolbar, made once per card; paintToolbar keeps it current, so a click never lands on a button being replaced. */
  function buildToolbar(s: Surface): HTMLElement {
    const modeBtn = (m: 'use' | 'markup', label: string) => h('button.btn.sm', { type: 'button', role: 'radio', onclick: () => s.setMode(m) }, label);
    const pick = h('input.hidden', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', multiple: true });
    pick.addEventListener('change', () => {
      void s.addPictures([...(pick.files ?? [])]);
      pick.value = '';
    });
    tb = {
      use: modeBtn('use', 'Use'),
      markup: modeBtn('markup', 'Mark up'),
      pan: h('button.btn.sm', { type: 'button', role: 'radio', title: 'Pan without interacting with the page (H). Hold Space for temporary pan.', onclick: () => s.setPan(true) }, 'Pan'),
      marks: h(
        'button.btn.sm',
        {
          type: 'button',
          title: 'Show or hide comments and marks',
          onclick: () => {
            marksVisible = !marksVisible;
            main.querySelector('.wb-art')?.classList.toggle('marks-hidden', !marksVisible);
            paintToolbar();
          },
        },
        'Marks',
      ),
      fit: h('button.btn.sm', { type: 'button', title: 'Fit to the window (0)', onclick: () => s.fit() }, 'Fit'),
      actual: h('button.btn.sm', { type: 'button', title: 'Actual size (1)', onclick: () => s.actual() }, '100%'),
      fs: h('button.btn.sm.icon.wb-fs', { type: 'button', title: 'Full screen (F)', 'aria-label': 'Full screen', 'aria-pressed': 'false', 'aria-keyshortcuts': 'F', onclick: () => void s.toggleFullscreen() }, fsIcon()),
      label: h('span.wb-zoom-label', { title: 'Zoom' }),
      hint: h('span.wb-hint-text'),
    };
    return h(
      'div.wb-toolbar',
      {},
      h('div.seg', { role: 'radiogroup', 'aria-label': 'Mode' }, tb.use, tb.markup, tb.pan),
      h('span.wb-key-hint', {}, h('span.key', { title: 'Switches between Use and Mark up' }, 'M'), tb.hint),
      h('span.grow'),
      h('button.btn.sm', { type: 'button', title: 'Add a PNG, JPEG, WebP or GIF (or paste or drop one)', onclick: () => pick.click() }, '🖼 Picture'),
      pick,
      tb.marks,
      h(
        'div.seg.wb-zoom',
        { role: 'group', 'aria-label': 'Zoom' },
        h('button.btn.sm.icon', { type: 'button', title: 'Zoom out (-)', 'aria-label': 'Zoom out', onclick: () => s.zoomBy(-1) }, '−'),
        tb.fit,
        tb.actual,
        h('button.btn.sm.icon', { type: 'button', title: 'Zoom in (+)', 'aria-label': 'Zoom in', onclick: () => s.zoomBy(1) }, '+'),
      ),
      tb.label,
      tb.fs,
    );
  }

  function paintToolbar() {
    const s = surface;
    if (!s || !tb) return;
    const canvas = s.card.kind === 'canvas';
    for (const [btn, m] of [
      [tb.use, 'use'],
      [tb.markup, 'markup'],
    ] as const) {
      btn.classList.toggle('on', !s.pan && s.mode === m);
      btn.setAttribute('aria-checked', String(!s.pan && s.mode === m));
    }
    tb.pan.classList.toggle('on', s.pan);
    tb.pan.setAttribute('aria-checked', String(s.pan));
    tb.marks.classList.toggle('on', marksVisible);
    tb.marks.setAttribute('aria-pressed', String(marksVisible));
    tb.fit.classList.toggle('on', s.zoomMode.fit);
    tb.actual.classList.toggle('on', !s.zoomMode.fit && Math.abs(s.zoom - 1) < 0.001);
    tb.fs.classList.toggle('on', s.fullscreen);
    tb.fs.setAttribute('aria-pressed', String(s.fullscreen));
    tb.fs.title = s.fullscreen ? 'Exit full screen (F or Esc)' : 'Full screen (F)';
    tb.fs.setAttribute('aria-label', s.fullscreen ? 'Exit full screen' : 'Full screen');
    tb.label.textContent = zoomLabel(s.zoom);
    tb.hint.textContent = s.pan
      ? 'Drag anywhere to pan. Use returns to the page.'
      : s.mode === 'use'
        ? canvas
          ? 'Drag to pan. Mark up adds comments and stickies.'
          : 'Click, type and press its buttons.'
        : 'Click to pin a comment. Drag to place a sticky.';
  }

  // ---- Header, bars ----

  function paintHeader() {
    const b = board();
    const c = b && card ? findCard(b, card) : undefined;
    back.classList.toggle('hidden', !c);
    if (!c) {
      titleEl.replaceChildren('Whiteboard');
      const n = b ? cardsNewestFirst(b).length : 0;
      const changedN = b ? changedCount(b) : 0;
      sub.replaceChildren(b ? `${n} card${n === 1 ? '' : 's'} on ${store.currentFloor()?.name ?? 'this floor'}${changedN ? `, ${changedN} changed since you looked` : ''}` : 'Loading…');
      actions.replaceChildren(
        h('button.btn.sm', { type: 'button', onclick: newCanvas }, 'New canvas'),
        h('button.btn.sm', { type: 'button', onclick: addHtml }, 'Add HTML'),
        h('button.btn.sm', { type: 'button', onclick: () => openPing(net) }, 'Ping a worker'),
      );
      return;
    }
    const input = titleEl.querySelector<HTMLInputElement>('input.wb-title');
    if (input && document.activeElement === input) {
      // Leave a title being edited alone.
    } else {
      const t = h('input.wb-title', { type: 'text', value: c.title, maxlength: '120', 'aria-label': 'Title', title: 'Rename the card' });
      const commit = () => {
        const v = t.value.trim();
        const now = board() && card ? findCard(board()!, card) : undefined;
        if (!now) return;
        if (!v) t.value = now.title;
        else if (v !== now.title) void apply([{ op: 'card.title', card: now.id, title: v }], 'Renaming the card');
      };
      t.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') t.blur();
        if (e.key === 'Escape') {
          t.value = c.title;
          t.blur();
        }
      });
      t.addEventListener('blur', () => {
        commit();
        if (document.activeElement === document.body) el.focus({ preventScroll: true });
      });
      titleEl.replaceChildren(t);
    }
    const link = c.link ? (c.link.status === 'ok' ? h('span.pill.done', { title: `Follows ${c.link.path}` }, 'Linked') : h('span.pill.needs_input', { title: c.link.reason ?? 'The linked file is gone' }, 'Link broken')) : null;
    const parts: HTMLElement[] = [h('span.wb-who', {}, colorDot(authorColor(c.author)), `by ${authorName(c.author)}`), h('span', {}, `updated ${timeAgo(c.updatedAt)}`)];
    if (c.kind === 'canvas') parts.push(h('span', {}, 'canvas'));
    if (link) parts.push(link);
    if (c.link?.status === 'broken' && c.link.reason) parts.push(h('span.wb-link-why', { title: c.link.reason }, c.link.reason));
    sub.replaceChildren(...parts);
    const copyBtn = h('button.btn.sm', { type: 'button', title: 'Copy a line that names this card, to paste into a prompt' }, 'Copy for agent');
    copyBtn.addEventListener('click', async () => {
      copyBtn.textContent = (await copy(copyForAgent(c))) ? '✓ Copied' : 'Copy failed';
      setTimeout(() => (copyBtn.textContent = 'Copy for agent'), 1600);
    });
    actions.replaceChildren(
      copyBtn,
      h('button.btn.sm', { type: 'button', onclick: () => openPing(net) }, 'Ping a worker'),
      h(
        'button.btn.sm.danger',
        {
          type: 'button',
          onclick: () =>
            confirmDelete(c.title, () => {
              // Off the card first, so its going isn't news; the board puts the wall back on the grid itself.
              go(null, false);
              void apply([{ op: 'card.rm', card: c.id }], 'Deleting the card');
            }),
        },
        'Delete',
      ),
    );
  }

  function paintBars() {
    const f = sync.floor(floor);
    const state = sync.state(floor);
    const out: HTMLElement[] = [];
    if (state === 'offline') out.push(h('p.note.warn', {}, `The office connection is down. Your edits are kept here and go when it’s back${f.pending.length ? ` (${f.pending.length} waiting)` : ''}.`));
    else if (state === 'syncing') out.push(h('p.note.info', {}, `Reconnecting to the board…${f.pending.length ? ` ${f.pending.length} edit${f.pending.length === 1 ? '' : 's'} to send` : ''}`));
    for (const d of f.drafts) {
      const kinds = [...new Set(d.ops.map((o) => o.op))].join(', ');
      out.push(
        h(
          'div.note.bad.wb-draft',
          {},
          h('span.grow', {}, `${d.ops.length} edit${d.ops.length === 1 ? '' : 's'} from ${timeAgo(d.at)} couldn’t be confirmed after the office restarted (${kinds}). The board shows what it has now: reapply them on top, or discard them.`),
          h('button.btn.sm', { type: 'button', onclick: () => void sync.reapplyDraft(floor, d.id).then((r) => r && !r.ok && r.reason === 'invalid' && toast(`It doesn't apply any more: ${r.error.reason}`, 'error')) }, 'Reapply'),
          h('button.btn.sm.ghost', { type: 'button', onclick: () => sync.discardDraft(floor, d.id) }, 'Discard'),
        ),
      );
    }
    if (f.lastError && f.lastError !== dismissedError) {
      const err = f.lastError;
      out.push(
        h(
          'div.note.bad.wb-draft',
          {},
          h('span.grow', {}, `The office refused an edit: ${err.message}`),
          h(
            'button.btn.sm.ghost',
            {
              type: 'button',
              onclick: () => {
                dismissedError = err;
                paintBars();
              },
            },
            'Dismiss',
          ),
        ),
      );
    }
    if (notice) {
      const n = notice;
      const c = board() && findCard(board()!, n.card);
      if (c && card !== n.card)
        out.push(
          h(
            'div.note.info.wb-draft',
            {},
            h('span.grow', {}, `${n.by} put `, h('em', {}, c.title), ' on the wall'),
            h(
              'button.btn.sm',
              {
                type: 'button',
                onclick: () => {
                  notice = null;
                  go(n.card, false);
                },
              },
              'Open it',
            ),
            h(
              'button.btn.sm.ghost.icon',
              {
                type: 'button',
                'aria-label': 'Dismiss',
                onclick: () => {
                  notice = null;
                  paintBars();
                },
              },
              '✕',
            ),
          ),
        );
    }
    bars.replaceChildren(...out);
  }

  // ---- Actions ----

  function newCanvas() {
    const id = newId('c');
    void apply([{ op: 'card.create', card: id, kind: 'canvas', title: 'Untitled canvas' }], 'Making the canvas');
    go(id);
    setTimeout(() => titleEl.querySelector<HTMLInputElement>('input.wb-title')?.select(), 60);
  }

  function addHtml() {
    openAddHtml(floor, async (ops, id) => {
      const ok = await apply(ops, 'Adding the HTML');
      if (ok && open) go(id);
      return ok;
    });
  }

  // ---- Live ----

  function onBoard() {
    const b = board();
    if (!b) return paintBars();
    if (card) {
      const c = findCard(b, card);
      if (!c) {
        const gone = b.tombstones.find((t) => t.kind === 'card' && t.id === card);
        toast(gone && gone.author.kind === 'worker' ? `${gone.author.name} deleted that card` : 'That card is gone from the board', 'warn');
        card = null;
        leaveCard();
        paintGrid();
      } else if (surface) {
        surface.update(c);
        panel?.render(c);
        markRead();
      } else {
        since = ownerReadPoint(b, c.id);
        openCard(c);
        markRead();
      }
    } else paintGrid();
    paintHeader();
    paintBars();
  }

  const offs = [store.on('whiteboard', onBoard), store.on('workers', () => !card && paintGrid()), store.on('floor', () => store.floor !== floor && modal.close())];
  const clock = window.setInterval(() => (card ? paintHeader() : paintGrid()), 30_000);

  // Keys: M switches Use and Mark up; H pans; F is full screen; + - 0 1 zoom. Not while typing in a field of the window.
  const onKey = (e: KeyboardEvent) => {
    if (!surface || e.metaKey || e.ctrlKey || e.altKey) return;
    // Only while this window is on top; focus may have fallen back to the page body (after a rename, say).
    if (modal.backdrop.nextElementSibling) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.closest('input, textarea, select, [contenteditable]') || (t !== document.body && !el.contains(t)))) return;
    const s = surface;
    const k = e.key;
    if (k === 'm' || k === 'M') s.setMode(s.mode === 'use' ? 'markup' : 'use');
    else if (k === 'h' || k === 'H') s.setPan(!s.pan);
    else if ((k === 'f' || k === 'F') && !e.repeat) void s.toggleFullscreen();
    else if (k === '+' || k === '=') s.zoomBy(1);
    else if (k === '-' || k === '_') s.zoomBy(-1);
    else if (k === '0') s.fit();
    else if (k === '1') s.actual();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  window.addEventListener('keydown', onKey, true);
  // A picture pasted anywhere in the window goes on the open card.
  const onPaste = (e: ClipboardEvent) => {
    if (!surface || !el.isConnected) return;
    const t = e.target as HTMLElement | null;
    if (t?.closest('input, textarea, [contenteditable]')) return;
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    void surface.addPictures(files);
  };
  window.addEventListener('paste', onPaste);

  const modal: Modal = openModal(el, {
    size: 'full',
    doing: '🧑‍🎨 at the Whiteboard',
    onClose: () => {
      leaveCard();
      for (const off of offs) off();
      clearInterval(clock);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('paste', onPaste);
      if (notice) clearTimeout(notice.timer);
      open = null;
    },
  });
  back.addEventListener('click', () => go(null));

  open = {
    floor,
    go: (id) => go(id),
    shown(by, id) {
      if (card === id) return;
      if (notice) clearTimeout(notice.timer);
      notice = {
        by,
        card: id,
        timer: window.setTimeout(() => {
          notice = null;
          paintBars();
        }, 15_000),
      };
      paintBars();
    },
  };

  // With no card asked for, the window opens on what the wall shows.
  const b = board();
  const start = opts.card ?? (b?.selection.kind === 'card' ? b.selection.id : null);
  card = null;
  if (start && b && findCard(b, start)) go(start, opts.card !== undefined);
  else {
    paintGrid();
    paintHeader();
    paintBars();
  }
  setTimeout(() => el.focus({ preventScroll: true }), 30);
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Four corners, the expand mark next to the zoom controls. */
function fsIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M2.5 6V2.5H6.5M9.5 2.5H13.5V6.5M13.5 10v3.5H10M6.5 13.5H2.5V10');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

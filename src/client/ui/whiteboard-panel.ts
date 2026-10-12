// The Whiteboard window's side panel (docs/whiteboard.md, "The window"): what changed since the owner
// last looked, the detached marks with Reattach, every comment thread (reply, resolve or reopen,
// delete), and the card's stickies and pictures.

import { STICKY_COLORS, type Author, type Card, type Op, type Thread } from '../../shared/whiteboard';
import { h, timeAgo } from './dom';
import { colorDot } from './kit';
import type { MarkKind, Surface } from './whiteboard-surface';
import type { ChangeItem } from '../../shared/whiteboard-marks';
import { authorColor, authorName, newId } from './whiteboard-view';

export interface PanelHost {
  apply(ops: Op[], what?: string): Promise<boolean>;
  surface(): Surface | null;
  changes(): ChangeItem[];
  fileUrl(hash: string): string;
}

function who(a: Author): HTMLElement {
  return h('span.wb-who', { title: authorName(a) }, colorDot(authorColor(a)), h('span', {}, authorName(a)));
}

function clipOne(s: string, max = 80): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export class Panel {
  readonly el = h('aside.wb-panel', { 'aria-label': 'Marks on this card' });
  private card: Card | null = null;
  private expanded = new Set<string>();
  private drafts = new Map<string, string>();
  private showResolved = false;

  constructor(private host: PanelHost) {}

  /** Opens a thread and brings it into view in the panel. */
  focusThread(id: string) {
    this.expanded.add(id);
    if (this.card) this.render(this.card);
    const row = this.el.querySelector<HTMLElement>(`[data-thread="${CSS.escape(id)}"]`);
    row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    row?.classList.add('flash');
    setTimeout(() => row?.classList.remove('flash'), 1200);
  }

  render(card: Card) {
    this.card = card;
    const surface = this.host.surface();
    const detached = (kind: MarkKind, id: string) => surface?.detached(kind, id) ?? false;
    // Keep a reply being typed, and where the panel was scrolled to.
    const active = document.activeElement as HTMLElement | null;
    const typingIn = active?.closest<HTMLElement>('[data-reply]')?.dataset.reply;
    const sel = active instanceof HTMLTextAreaElement ? [active.selectionStart, active.selectionEnd] : null;
    const top = this.el.scrollTop;

    const sections: (HTMLElement | null)[] = [];
    const changes = this.host.changes();
    if (changes.length) {
      sections.push(
        this.section(
          'Changed since you looked',
          changes.length,
          h(
            'ul.list.wb-changes',
            {},
            ...changes.map((c) =>
              h(
                'li',
                {},
                h(
                  'button.list-row',
                  { type: 'button', disabled: !c.mark, onclick: () => c.mark && this.goTo(c.mark.kind, c.mark.id) },
                  h('span.list-icon', {}, colorDot(authorColor(c.author))),
                  h('span.list-main', {}, h('span.list-title', { title: c.text }, c.text), h('span.list-meta', {}, authorName(c.author))),
                ),
              ),
            ),
          ),
        ),
      );
    }

    const lost = [
      ...card.threads.filter((t) => detached('thread', t.id)).map((t, i) => ({ kind: 'thread' as const, id: t.id, label: t.messages[0] ? `Comment: ${clipOne(t.messages[0].text, 50)}` : `Comment ${i + 1}` })),
      ...card.stickies.filter((s) => detached('sticky', s.id)).map((s) => ({ kind: 'sticky' as const, id: s.id, label: s.text ? `Sticky: ${clipOne(s.text, 50)}` : 'Empty sticky' })),
      ...card.pictures.filter((p) => detached('picture', p.id)).map((p) => ({ kind: 'picture' as const, id: p.id, label: 'Picture' })),
    ];
    if (lost.length) {
      sections.push(
        this.section(
          'Detached',
          lost.length,
          h('p.wb-panel-hint', {}, 'What these were attached to is gone from the page. Each is drawn where it was; Reattach puts it on a new spot.'),
          h(
            'ul.list',
            {},
            ...lost.map((m) =>
              h(
                'li.list-row.wb-lost',
                {},
                h('span.list-main', {}, h('span.list-title', { title: m.label }, m.label)),
                h('span.list-end', {}, h('button.btn.sm', { type: 'button', onclick: () => surface?.startReattach(m.kind, m.id) }, 'Reattach')),
              ),
            ),
          ),
        ),
      );
    }

    const open = card.threads.filter((t) => !t.resolved);
    const resolved = card.threads.filter((t) => t.resolved);
    const number = new Map(card.threads.map((t, i) => [t.id, i + 1]));
    const threadList = h('div.wb-threads', {}, ...open.map((t) => this.thread(card, t, number.get(t.id) ?? 0, detached('thread', t.id))));
    if (resolved.length) {
      const toggle = h('button.btn.sm.ghost.wb-resolved-toggle', { type: 'button', 'aria-expanded': String(this.showResolved) }, `${this.showResolved ? 'Hide' : 'Show'} ${resolved.length} resolved`);
      toggle.addEventListener('click', () => {
        this.showResolved = !this.showResolved;
        this.render(card);
      });
      threadList.append(toggle);
      if (this.showResolved) for (const t of resolved) threadList.append(this.thread(card, t, number.get(t.id) ?? 0, detached('thread', t.id)));
    }
    sections.push(this.section('Comments', card.threads.length, card.threads.length ? threadList : h('p.wb-panel-hint', {}, 'In Mark up, click the card to pin a comment.')));

    sections.push(
      this.section(
        'Stickies',
        card.stickies.length,
        card.stickies.length
          ? h(
              'ul.list',
              {},
              ...card.stickies.map((s) => {
                const sw = h('span.wb-swatch.static');
                sw.style.background = STICKY_COLORS[s.color];
                return h(
                  'li.list-row',
                  { class: detached('sticky', s.id) ? 'detached' : '', onclick: () => this.goTo('sticky', s.id) },
                  h('span.list-icon', {}, sw),
                  h('span.list-main', {}, h('span.list-title', { title: s.text }, s.text ? clipOne(s.text) : 'Empty note'), h('span.list-meta', {}, authorName(s.stamps.text.author))),
                  h(
                    'span.list-end',
                    {},
                    h('button.btn.sm.ghost', { type: 'button', title: 'Edit the text', onclick: (e: Event) => (e.stopPropagation(), this.goTo('sticky', s.id), surface?.editSticky(s.id)) }, 'Edit'),
                    h(
                      'button.btn.sm.ghost.icon',
                      { type: 'button', title: 'Delete', 'aria-label': 'Delete the sticky', onclick: (e: Event) => (e.stopPropagation(), void this.host.apply([{ op: 'sticky.rm', card: card.id, id: s.id }], 'Deleting the sticky')) },
                      '✕',
                    ),
                  ),
                );
              }),
            )
          : h('p.wb-panel-hint', {}, 'In Mark up, drag on the card to place a sticky.'),
      ),
    );

    sections.push(
      this.section(
        'Pictures',
        card.pictures.length,
        card.pictures.length
          ? h(
              'ul.list',
              {},
              ...card.pictures.map((p) =>
                h(
                  'li.list-row',
                  { class: detached('picture', p.id) ? 'detached' : '', onclick: () => this.goTo('picture', p.id) },
                  h('span.list-icon', {}, h('img.wb-thumb-mini', { src: this.host.fileUrl(p.file.hash), alt: '' })),
                  h('span.list-main', {}, h('span.list-title', {}, `${p.box.w}×${p.box.h}`), h('span.list-meta', {}, authorName(p.stamps.file.author))),
                  h(
                    'span.list-end',
                    {},
                    h(
                      'button.btn.sm.ghost.icon',
                      { type: 'button', title: 'Delete', 'aria-label': 'Delete the picture', onclick: (e: Event) => (e.stopPropagation(), void this.host.apply([{ op: 'picture.rm', card: card.id, id: p.id }], 'Deleting the picture')) },
                      '✕',
                    ),
                  ),
                ),
              ),
            )
          : h('p.wb-panel-hint', {}, 'Paste, drop or pick a PNG, JPEG, WebP or GIF.'),
      ),
    );

    this.el.replaceChildren(...sections.filter((s): s is HTMLElement => !!s));
    this.el.scrollTop = top;
    if (typingIn) {
      const ta = this.el.querySelector<HTMLTextAreaElement>(`[data-reply="${CSS.escape(typingIn)}"] textarea`);
      if (ta) {
        ta.focus();
        if (sel) ta.setSelectionRange(sel[0], sel[1]);
      }
    }
  }

  private goTo(kind: MarkKind, id: string) {
    if (kind === 'thread') {
      this.expanded.add(id);
      if (this.card) this.render(this.card);
    }
    this.host.surface()?.focusMark(kind, id);
  }

  private section(title: string, n: number, ...body: Node[]): HTMLElement {
    return h('section.section.wb-panel-sec', {}, h('div.eyebrow', {}, title, h('span.grow'), n ? h('span.wb-count', {}, String(n)) : null), ...body);
  }

  private thread(card: Card, t: Thread, n: number, detached: boolean): HTMLElement {
    const open = this.expanded.has(t.id);
    const first = t.messages[0];
    const toggle = () => {
      if (open) this.expanded.delete(t.id);
      else this.expanded.add(t.id);
      this.render(card);
      if (!open) this.host.surface()?.focusMark('thread', t.id);
    };
    const resolve = h(
      'button.btn.sm.ghost',
      { type: 'button', onclick: () => void this.host.apply([{ op: t.resolved ? 'comment.reopen' : 'comment.resolve', card: card.id, thread: t.id }], t.resolved ? 'Reopening the comment' : 'Resolving the comment') },
      t.resolved ? 'Reopen' : 'Resolve',
    );
    const del = h(
      'button.btn.sm.ghost.icon',
      { type: 'button', title: 'Delete the thread', 'aria-label': 'Delete the thread', onclick: () => void this.host.apply([{ op: 'comment.rm', card: card.id, thread: t.id }], 'Deleting the comment') },
      '✕',
    );
    const head = h(
      'div.wb-thread-head',
      {},
      h(
        'button.wb-thread-pin',
        { type: 'button', 'aria-expanded': String(open), title: open ? 'Fold the thread' : 'Open the thread', onclick: toggle },
        h('span.wb-num', {}, String(n)),
        first ? who(first.author) : null,
        h('span.wb-thread-when', {}, first ? timeAgo(first.at) : ''),
      ),
      resolve,
      del,
    );
    const el = h('div.wb-thread', { 'data-thread': t.id, class: [t.resolved && 'resolved', open && 'open'].filter(Boolean).join(' ') }, head);
    if (detached) el.append(h('span.wb-thread-lost', {}, h('span.pill.lost', {}, 'detached'), 'What it was pinned to is gone from the page'));
    if (!open) {
      if (first)
        el.append(
          h('button.wb-thread-peek', { type: 'button', onclick: toggle }, clipOne(first.text, 120), t.messages.length > 1 ? h('span.wb-replies', {}, ` · ${t.messages.length - 1} repl${t.messages.length === 2 ? 'y' : 'ies'}`) : null),
        );
      return el;
    }
    for (const m of t.messages) {
      el.append(
        h(
          'div.wb-msg',
          {},
          h(
            'div.wb-msg-head',
            {},
            who(m.author),
            h('span.wb-thread-when', {}, timeAgo(m.at)),
            h(
              'button.wb-msg-x',
              { type: 'button', title: 'Delete this message', 'aria-label': 'Delete this message', onclick: () => void this.host.apply([{ op: 'comment.rm', card: card.id, thread: t.id, message: m.id }], 'Deleting the message') },
              '✕',
            ),
          ),
          h('div.wb-msg-text', {}, m.text),
        ),
      );
    }
    const ta = h('textarea.input.sm', { rows: '2', placeholder: 'Reply…', 'aria-label': 'Reply', maxlength: '10000' });
    ta.value = this.drafts.get(t.id) ?? '';
    ta.addEventListener('input', () => this.drafts.set(t.id, ta.value));
    const send = async () => {
      const text = ta.value.trim();
      if (!text) return;
      this.drafts.delete(t.id);
      ta.value = '';
      const ok = await this.host.apply([{ op: 'comment.reply', card: card.id, thread: t.id, message: newId('m'), text }], 'Replying');
      if (!ok) this.drafts.set(t.id, text);
    };
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void send();
      }
    });
    el.append(h('div.wb-reply', { 'data-reply': t.id }, ta, h('div.row', {}, h('span.grow'), h('button.btn.sm', { type: 'button', onclick: () => void send() }, 'Reply'))));
    return el;
  }
}

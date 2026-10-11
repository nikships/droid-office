// The Whiteboard window's dialogs (docs/whiteboard.md, "The window" and "Ping a worker"): Add HTML
// (paste, or upload a page or a folder with its assets), Ping a worker, and the delete confirm.

import type { ServerMsg } from '../../shared/protocol';
import { MAX_ASSET_BYTES, MAX_CARD_BYTES, MAX_FILES_PER_CARD, MAX_HTML_BYTES, MAX_TITLE_LENGTH, type CardContent, type FileRef, type Op } from '../../shared/whiteboard';
import type { Net } from '../net';
import { store } from '../state';
import { STATUS_LABEL, h, openModal } from './dom';
import { colorDot, emptyState, field, windowHeader } from './kit';
import { uploadBlob } from './whiteboard-surface';
import { folderFiles, mimeFor, newId, pingRows, pingedText } from './whiteboard-view';

const MB = 1024 * 1024;

// ---- Ping a worker ----

type Pinged = Extract<ServerMsg, { t: 'whiteboard.pinged' }>;
const pingWaiters = new Set<(msg: Pinged) => void>();

/** `whiteboard.pinged` from the server, for the open picker. */
export function routePinged(msg: Pinged) {
  for (const fn of pingWaiters) fn(msg);
}

/** The picker: every worker on the floor, whether the office can type the line in now, and a Ping button. */
export function openPing(net: Net) {
  const results = new Map<string, { ok: boolean; text: string } | 'sending'>();
  const list = h('ul.list.boxed.wb-ping-list');
  const body = h('div.body.stack.tight', {}, h('p.wb-dialog-lead', {}, 'The office types a line into the worker’s terminal telling it to read the Whiteboard. Edit the line in ⚙️ Settings → Prompts.'), list);
  const el = h(
    'div.modal.wb-ping',
    { 'aria-label': 'Ping a worker', tabindex: '-1' },
    windowHeader('Ping a worker', 'Tell a worker on this floor to look at the board'),
    body,
    h('footer', {}, h('span.grow', {}, 'Guests and cloud workers can’t use the board yet'), h('button.btn.ghost', { type: 'button', onclick: () => modal.close() }, 'Done')),
  );
  const paint = () => {
    const rows = pingRows(store.workers.values(), STATUS_LABEL);
    if (!rows.length) {
      list.replaceWith(emptyState('🤖', 'No workers on this floor', 'Hire one at a desk first.'));
      return;
    }
    list.replaceChildren(
      ...rows.map((r) => {
        const res = results.get(r.id);
        const btn = h('button.btn.sm', { type: 'button', class: r.ok ? 'accent' : '', disabled: !r.ok || res === 'sending', title: r.note }, res === 'sending' ? 'Pinging…' : 'Ping');
        btn.addEventListener('click', () => {
          results.set(r.id, 'sending');
          if (!net.send({ t: 'whiteboard.ping', worker: r.id })) results.set(r.id, { ok: false, text: 'The office is offline. Ping again once it’s back.' });
          paint();
        });
        const meta = res && res !== 'sending' ? h('span.list-meta', { class: res.ok ? 'wb-ok' : 'wb-bad', title: res.text }, res.text) : h('span.list-meta', { title: r.note }, r.guest ? `${r.note} (Bring it in from its desk.)` : r.note);
        return h(
          'li.list-row',
          { class: r.ok ? '' : 'wb-ineligible', 'data-worker': r.id },
          h('span.list-icon', {}, colorDot(r.color)),
          h('span.list-main', {}, h('span.list-title', { title: r.name }, r.name), meta),
          h('span.list-end', {}, h('span.pill', { class: r.statusClass }, r.status), btn),
        );
      }),
    );
  };
  const onPinged = (msg: Pinged) => {
    const w = store.workers.get(msg.worker);
    if (!results.has(msg.worker)) return;
    results.set(msg.worker, msg.ok ? { ok: true, text: pingedText(w?.name ?? 'the worker', msg.how) } : { ok: false, text: msg.error ?? 'The ping didn’t go in' });
    paint();
  };
  pingWaiters.add(onPinged);
  const off = store.on('workers', paint);
  const modal = openModal(el, { onClose: () => (pingWaiters.delete(onPinged), off()) });
  paint();
  // Take focus from a card's frame, where the office never hears Esc.
  setTimeout(() => el.focus({ preventScroll: true }), 30);
}

// ---- Delete ----

export function confirmDelete(title: string, onYes: () => void) {
  const yes = h('button.btn.danger', { type: 'button' }, 'Delete');
  const el = h(
    'div.modal',
    { 'aria-label': 'Delete the card' },
    windowHeader('Delete this card?'),
    h('div.body', {}, h('p.wb-dialog-lead', {}, `“${title}” goes from the board with its comments, stickies and pictures. Workers see it as removed.`)),
    h('footer', {}, h('span.grow'), h('button.btn.ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), yes),
  );
  const modal = openModal(el, { size: 'sm' });
  yes.addEventListener('click', () => {
    modal.close();
    onYes();
  });
  setTimeout(() => yes.focus(), 30);
}

// ---- Add HTML ----

type Source = 'paste' | 'file' | 'folder';

interface Picked {
  rel: string;
  file: Blob;
  mime: string;
}

/** The page's <title>, for a card's title. */
function titleOf(html: string): string {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  return (m?.[1] ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH);
}

/** Add HTML: the owner's own artifact, from a paste, a page or a folder with its assets. */
export function openAddHtml(floor: string, create: (ops: Op[], card: string) => Promise<boolean>) {
  let source: Source = 'paste';
  let picked: Picked[] = [];
  let entry = '';
  let skipped = 0;
  const title = h('input', { type: 'text', placeholder: 'What is it?', maxlength: String(MAX_TITLE_LENGTH) });
  const paste = h('textarea.wb-paste', { placeholder: '<!doctype html>\n<html>…</html>', spellcheck: 'false', 'aria-label': 'HTML' });
  const fileInput = h('input', { type: 'file', accept: '.html,.htm,text/html' });
  const folderInput = h('input', { type: 'file', multiple: true });
  folderInput.setAttribute('webkitdirectory', '');
  const entrySelect = h('select', { 'aria-label': 'The page to open' });
  const summary = h('p.field-hint');
  const error = h('p.note.bad.hidden');
  const progress = h('p.field-hint.hidden');
  const add = h('button.btn.accent', { type: 'button' }, 'Add to the board');

  const tabs = (['paste', 'file', 'folder'] as Source[]).map((s) =>
    h('button.tab', { type: 'button', role: 'tab', onclick: () => ((source = s), paint()) }, s === 'paste' ? 'Paste HTML' : s === 'file' ? 'Upload a page' : 'Upload a folder'),
  );
  const panes: Record<Source, HTMLElement> = {
    paste: h('div.stack.tight', {}, field('HTML', paste, 'A whole page or a fragment. Scripts run in the card’s sandbox, with network access.')),
    file: h('div.stack.tight', {}, field('Page', fileInput, 'One .html file. For a page with its own images, styles or scripts, upload its folder instead.')),
    folder: h('div.stack.tight', {}, field('Folder', folderInput, 'Every file in it goes up with the page, so relative links, ES module imports and fetch() work.'), field('Open', entrySelect), summary),
  };
  const body = h('div.body.stack', {}, field('Title', title), h('div.tabs', { role: 'tablist' }, ...tabs), panes.paste, panes.file, panes.folder, error, progress);
  const el = h(
    'div.modal.wb-add',
    { 'aria-label': 'Add HTML' },
    windowHeader('Add HTML', 'Your own artifact on the board'),
    body,
    h('footer', {}, h('span.grow', {}, `Up to ${MAX_HTML_BYTES / MB} MB a page, ${MAX_ASSET_BYTES / MB} MB a file`), h('button.btn.ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), add),
  );

  const say = (text: string) => {
    error.textContent = text;
    error.classList.toggle('hidden', !text);
  };
  const paint = () => {
    tabs.forEach((t, i) => t.setAttribute('aria-selected', String((['paste', 'file', 'folder'] as Source[])[i] === source)));
    for (const s of Object.keys(panes) as Source[]) panes[s].classList.toggle('hidden', s !== source);
    say('');
  };

  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    if (!title.value.trim()) title.value = titleOf(await f.text()) || f.name.replace(/\.html?$/i, '');
  });
  folderInput.addEventListener('change', () => {
    const files = [...(folderInput.files ?? [])].map((f) => ({ path: f.webkitRelativePath || f.name, file: f }));
    const got = folderFiles(files);
    picked = got.files.map((x) => ({ rel: x.rel, file: x.file.file, mime: mimeFor(x.rel, x.file.file.type) }));
    skipped = got.skipped;
    entry = got.entry ?? '';
    const pages = picked.filter((p) => /\.html?$/i.test(p.rel)).map((p) => p.rel);
    entrySelect.replaceChildren(...pages.map((p) => h('option', { value: p, selected: p === entry }, p)));
    const bytes = picked.reduce((n, p) => n + p.file.size, 0);
    summary.textContent = picked.length
      ? `${picked.length} file${picked.length === 1 ? '' : 's'}, ${bytes < MB ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / MB).toFixed(1)} MB`}${skipped ? ` (${skipped} hidden or node_modules files left out)` : ''}`
      : 'That folder has no files.';
    const top = files[0]?.path.split('/')[0];
    if (!title.value.trim() && top) title.value = top;
    say(picked.length && !pages.length ? 'That folder has no .html page to open.' : '');
  });
  entrySelect.addEventListener('change', () => (entry = entrySelect.value));

  /** The files to upload and the page to open, or what's wrong with them. */
  async function files(): Promise<{ files: Picked[]; entry: string } | string> {
    if (source === 'paste') {
      const html = paste.value;
      if (!html.trim()) return 'Paste some HTML first.';
      if (!title.value.trim()) title.value = titleOf(html) || 'Pasted HTML';
      return { files: [{ rel: 'index.html', file: new Blob([html], { type: 'text/html' }), mime: 'text/html; charset=utf-8' }], entry: 'index.html' };
    }
    if (source === 'file') {
      const f = fileInput.files?.[0];
      if (!f) return 'Pick an .html file first.';
      const rel = /^[A-Za-z0-9._ -]+\.html?$/i.test(f.name) && !f.name.startsWith('.') ? f.name : 'index.html';
      return { files: [{ rel, file: f, mime: 'text/html; charset=utf-8' }], entry: rel };
    }
    if (!picked.length) return 'Pick a folder first.';
    if (!entry) return 'That folder has no .html page to open.';
    return { files: picked, entry };
  }

  add.addEventListener('click', async () => {
    say('');
    const got = await files();
    if (typeof got === 'string') return say(got);
    if (!title.value.trim()) return say('Give it a title.');
    if (got.files.length > MAX_FILES_PER_CARD) return say(`That's ${got.files.length} files; a card holds at most ${MAX_FILES_PER_CARD}.`);
    const page = got.files.find((f) => f.rel === got.entry);
    if (page && page.file.size > MAX_HTML_BYTES) return say(`The page is ${(page.file.size / MB).toFixed(1)} MB; the limit is ${MAX_HTML_BYTES / MB} MB.`);
    const big = got.files.find((f) => f.rel !== got.entry && f.file.size > MAX_ASSET_BYTES);
    if (big) return say(`${big.rel} is ${(big.file.size / MB).toFixed(1)} MB; the limit per file is ${MAX_ASSET_BYTES / MB} MB.`);
    const total = got.files.reduce((n, f) => n + f.file.size, 0);
    if (total > MAX_CARD_BYTES) return say(`That's ${(total / MB).toFixed(1)} MB; a card holds at most ${MAX_CARD_BYTES / MB} MB.`);
    if (!store.whiteboard.up) return say('Uploads need the office connection. Try again once it’s back.');
    add.disabled = true;
    progress.classList.remove('hidden');
    const refs: Record<string, FileRef> = {};
    try {
      let done = 0;
      const queue = [...got.files];
      const worker = async () => {
        for (let f = queue.shift(); f; f = queue.shift()) {
          refs[f.rel] = await uploadBlob(floor, f.file, f.mime);
          progress.textContent = `Uploading ${++done} of ${got.files.length}…`;
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
    } catch (err) {
      add.disabled = false;
      progress.classList.add('hidden');
      return say(`The upload failed: ${(err as Error).message}`);
    }
    const content: CardContent = { entry: got.entry, files: refs };
    const card = newId('c');
    const ok = await create([{ op: 'card.create', card, kind: 'html', title: title.value.trim(), content }], card);
    add.disabled = false;
    progress.classList.add('hidden');
    if (ok) modal.close();
    else say('The board refused it. The reason is in the window.');
  });

  const modal = openModal(el, { size: 'lg' });
  paint();
  setTimeout(() => title.focus(), 30);
}

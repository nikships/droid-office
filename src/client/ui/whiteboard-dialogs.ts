// The Whiteboard window's dialogs (docs/whiteboard.md, "The window" and "Ping a worker"): Add card
// (Markdown, Video/Image, Paste HTML with Factory starter, or upload an HTML page or folder package),
// Edit Markdown, drag-and-drop card builder, Ping a worker, and the delete confirm.

import type { ServerMsg } from '../../shared/protocol';
import { FACTORY_HTML_STARTER, type DesignTheme } from '../../shared/whiteboard-design';
import { extractMarkdownTitle, renderImageArtifact, renderMarkdownArtifact, renderVideoArtifact } from '../../shared/whiteboard-markdown';
import { MAX_ASSET_BYTES, MAX_CARD_BYTES, MAX_FILES_PER_CARD, MAX_HTML_BYTES, MAX_TITLE_LENGTH, type Card, type CardContent, type FileRef, type Op } from '../../shared/whiteboard';
import type { Net } from '../net';
import { store, words } from '../state';
import { STATUS_LABEL, h, openModal } from './dom';
import { colorDot, emptyState, field, windowHeader } from './kit';
import { uploadBlob } from './whiteboard-surface';
import { droppedCardKind, folderFiles, mimeFor, pingRows, pingedText } from './whiteboard-picker';
import { deleteConfirmText, newId } from './whiteboard-view';

const MB = 1024 * 1024;

// ---- Ping a worker ----

type Pinged = Extract<ServerMsg, { t: 'whiteboard.pinged' }>;
const pingWaiters = new Set<(msg: Pinged) => void>();

/** `whiteboard.pinged` from the server, for the open picker. */
export function routePinged(msg: Pinged) {
  for (const fn of pingWaiters) fn(msg);
}

/**
 * The picker: every worker on the floor, whether the office can type the line in now, and a Ping button.
 * `author` is the worker id that made the open card; its row is first and tagged while it's on the floor.
 */
export function openPing(net: Net, author?: string) {
  const results = new Map<string, { ok: boolean; text: string } | 'sending'>();
  const list = h('ul.list.boxed.wb-ping-list');
  const none = emptyState('🤖', 'No workers on this floor', 'Hire one at a desk first.');
  const body = h('div.body.stack.tight', {}, h('p.wb-dialog-lead', {}, 'The office types a line into the worker’s terminal telling it to read the Whiteboard. Edit the line in ⚙️ Settings → Workers → Prompts.'), list, none);
  const el = h(
    'div.modal.wb-ping',
    { 'aria-label': 'Ping a worker', tabindex: '-1' },
    windowHeader('Ping a worker', 'Tell a worker on this floor to look at the board'),
    body,
    h('footer', {}, h('span.grow', {}, 'Cloud workers can’t use the board yet'), h('button.btn.ghost', { type: 'button', onclick: () => modal.close() }, 'Done')),
  );
  const paint = () => {
    const rows = pingRows(store.workers.values(), STATUS_LABEL, words(), author);
    // Both stay in the window, so a worker sitting down while the picker is open shows up in it.
    list.classList.toggle('hidden', !rows.length);
    none.classList.toggle('hidden', !!rows.length);
    for (const id of results.keys()) if (!rows.some((r) => r.id === id)) results.delete(id);
    if (!rows.length) return;
    list.replaceChildren(
      ...rows.map((r) => {
        const res = results.get(r.id);
        const btn = h('button.btn.sm', { type: 'button', class: r.ok ? 'accent' : '', disabled: !r.ok || res === 'sending', title: r.note }, res === 'sending' ? 'Pinging…' : 'Ping');
        btn.addEventListener('click', () => {
          results.set(r.id, 'sending');
          if (!net.send({ t: 'whiteboard.ping', worker: r.id })) results.set(r.id, { ok: false, text: 'The office is offline. Ping again once it’s back.' });
          paint();
        });
        const meta = res && res !== 'sending' ? h('span.list-meta', { class: res.ok ? 'wb-ok' : 'wb-bad', title: res.text }, res.text) : h('span.list-meta', { title: r.note }, r.note);
        const task = r.task ?? (r.statusClass === 'starting' ? 'Starting, no task yet' : 'No task yet');
        const job = h('span.list-meta.wb-ping-task', { class: r.task ? '' : 'wb-ping-none', title: [r.task, r.where].filter(Boolean).join('\n') || task }, task);
        const name = h('span.wb-ping-name', {}, h('span.list-title', { title: r.name }, r.name), r.author ? h('span.wb-ping-author-tag', { title: `${r.name} made this card` }, 'Made this card') : null);
        return h(
          'li.list-row',
          { class: [r.ok ? '' : 'wb-ineligible', r.author ? 'on' : ''].filter(Boolean).join(' '), 'data-worker': r.id },
          h('span.list-icon', {}, colorDot(r.color)),
          h('span.list-main', {}, name, job, r.where ? h('span.list-meta.wb-ping-where', { title: r.where }, r.where) : null, meta),
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

/** Confirms deleting one card or several; `titles` are the cards' titles. */
export function confirmDelete(titles: string[], onYes: () => void) {
  const text = deleteConfirmText(titles);
  const yes = h('button.btn.danger', { type: 'button' }, titles.length === 1 ? 'Delete' : `Delete ${titles.length}`);
  const el = h(
    'div.modal',
    { 'aria-label': titles.length === 1 ? 'Delete the card' : 'Delete the cards' },
    windowHeader(text.title),
    h('div.body.stack.tight', {}, h('p.wb-dialog-lead', {}, text.lead), ...(text.more.length ? [h('ul.wb-delete-list', {}, ...text.more.map((t) => h('li', { title: t }, t)))] : [])),
    h('footer', {}, h('span.grow'), h('button.btn.ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), yes),
  );
  const modal = openModal(el, { size: 'sm' });
  yes.addEventListener('click', () => {
    modal.close();
    onYes();
  });
  setTimeout(() => yes.focus(), 30);
}

// ---- Add card, Edit Markdown, and Grid Drop ----

type Source = 'markdown' | 'media' | 'paste' | 'file' | 'folder';

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

function stemOf(filename: string): string {
  return filename
    .replace(/\.[^.]+$/, '')
    .trim()
    .slice(0, MAX_TITLE_LENGTH);
}

function measureImage(file: Blob): Promise<{ w?: number; h?: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth || undefined;
      const h = img.naturalHeight || undefined;
      URL.revokeObjectURL(url);
      resolve({ w, h });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve({});
    };
    img.src = url;
  });
}

function extForMime(mime: string, fallbackName = ''): string {
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'video/ogg': 'ogg',
  };
  return map[mime.split(';')[0].trim().toLowerCase()] ?? (/\.([a-z0-9]+)$/i.exec(fallbackName)?.[1]?.toLowerCase() || 'bin');
}

async function uploadPickedFiles(floor: string, list: Picked[], onProgress?: (done: number, total: number) => void): Promise<Record<string, FileRef>> {
  const refs: Record<string, FileRef> = {};
  let done = 0;
  const queue = [...list];
  const worker = async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      refs[f.rel] = await uploadBlob(floor, f.file, f.mime);
      onProgress?.(++done, list.length);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return refs;
}

/** Builds and uploads a single dropped file (.md, video, image, or .html) for grid drag-and-drop creation. */
export async function buildDroppedCard(floor: string, file: File): Promise<{ ops: Op[]; card: string; title: string } | string> {
  const kind = droppedCardKind(file.name, file.type);
  if (!kind) return `Unsupported file "${file.name}". Drop a Markdown (.md), video (.mp4/.webm/.mov), image (.png/.jpg/.webp/.gif/.svg) or .html file.`;
  if (!store.whiteboard.up) return 'Uploads need the office connection. Try again once it’s back.';
  if (kind === 'html' || kind === 'markdown') {
    if (file.size > MAX_HTML_BYTES) return `"${file.name}" is ${(file.size / MB).toFixed(1)} MB; the limit is ${MAX_HTML_BYTES / MB} MB.`;
    const text = await file.text();
    if (!text.trim()) return `"${file.name}" is empty.`;
    if (kind === 'markdown') {
      const cardTitle = extractMarkdownTitle(text) || stemOf(file.name) || 'Markdown document';
      const html = renderMarkdownArtifact(text, { title: cardTitle });
      const refs = await uploadPickedFiles(floor, [
        { rel: 'index.html', file: new Blob([html], { type: 'text/html' }), mime: 'text/html; charset=utf-8' },
        { rel: 'document.md', file: new Blob([text], { type: 'text/markdown' }), mime: 'text/markdown; charset=utf-8' },
      ]);
      const card = newId('c');
      return { card, title: cardTitle, ops: [{ op: 'card.create', card, kind: 'html', title: cardTitle, content: { entry: 'index.html', format: 'markdown', files: refs } }] };
    }
    const cardTitle = titleOf(text) || stemOf(file.name) || 'HTML artifact';
    const rel = /^[A-Za-z0-9._ -]+\.html?$/i.test(file.name) && !file.name.startsWith('.') ? file.name : 'index.html';
    const refs = await uploadPickedFiles(floor, [{ rel, file, mime: 'text/html; charset=utf-8' }]);
    const card = newId('c');
    return { card, title: cardTitle, ops: [{ op: 'card.create', card, kind: 'html', title: cardTitle, content: { entry: rel, format: 'html', files: refs } }] };
  }
  if (file.size > MAX_ASSET_BYTES) return `"${file.name}" is ${(file.size / MB).toFixed(1)} MB; the limit per file is ${MAX_ASSET_BYTES / MB} MB.`;
  const mime = mimeFor(file.name, file.type);
  const ext = extForMime(mime, file.name);
  const cardTitle = stemOf(file.name) || (kind === 'video' ? 'Video recording' : 'Image');
  if (kind === 'video') {
    const assetRel = `video.${ext}`;
    const html = renderVideoArtifact({ title: cardTitle, videoSrc: assetRel, videoMime: mime, sizeBytes: file.size });
    const refs = await uploadPickedFiles(floor, [
      { rel: 'index.html', file: new Blob([html], { type: 'text/html' }), mime: 'text/html; charset=utf-8' },
      { rel: assetRel, file, mime },
    ]);
    const card = newId('c');
    return { card, title: cardTitle, ops: [{ op: 'card.create', card, kind: 'html', title: cardTitle, content: { entry: 'index.html', format: 'video', files: refs } }] };
  }
  const dims = await measureImage(file);
  const assetRel = `image.${ext}`;
  const html = renderImageArtifact({ title: cardTitle, imageSrc: assetRel, imageMime: mime, width: dims.w, height: dims.h, sizeBytes: file.size });
  const refs = await uploadPickedFiles(floor, [
    { rel: 'index.html', file: new Blob([html], { type: 'text/html' }), mime: 'text/html; charset=utf-8' },
    { rel: assetRel, file, mime },
  ]);
  const card = newId('c');
  return { card, title: cardTitle, ops: [{ op: 'card.create', card, kind: 'html', title: cardTitle, content: { entry: 'index.html', format: 'image', files: refs } }] };
}

/** Add card: Markdown, Video/Image, Paste HTML (with Factory starter), Upload HTML page, or Upload folder package. */
export function openAddCard(floor: string, create: (ops: Op[], card: string) => Promise<boolean>, initialTab: Source = 'markdown') {
  let source: Source = initialTab;
  let picked: Picked[] = [];
  let entry = '';
  let skipped = 0;
  let theme: DesignTheme = 'dark';

  const title = h('input', { type: 'text', placeholder: 'Card title (optional when inferred from # Heading or filename)', maxlength: String(MAX_TITLE_LENGTH) });
  const mdArea = h('textarea.wb-paste', {
    placeholder: '# Proposal\n\n## Architecture\nExplain the trade-offs, tables, or `- [ ]` checklists…',
    spellcheck: 'false',
    'aria-label': 'Markdown',
  });
  const mdFile = h('input', { type: 'file', accept: '.md,.markdown,text/markdown,text/plain' });
  const themeSelect = h('select.select', { 'aria-label': 'Factory theme' }, h('option', { value: 'dark', selected: true }, 'Factory Dark (product)'), h('option', { value: 'light' }, 'Factory Light (document)'));
  themeSelect.addEventListener('change', () => {
    theme = themeSelect.value === 'light' ? 'light' : 'dark';
  });

  const mediaFile = h('input', {
    type: 'file',
    accept: '.mp4,.m4v,.webm,.mov,.ogv,.png,.jpg,.jpeg,.webp,.gif,.svg,video/*,image/png,image/jpeg,image/webp,image/gif,image/svg+xml',
  });
  const posterFile = h('input', { type: 'file', accept: '.png,.jpg,.jpeg,.webp,.gif,.svg,image/*' });
  const posterWrap = field('Poster image (optional, for videos)', posterFile, 'Shown before playback and in headless PNG previews.');
  posterWrap.classList.add('hidden');
  const captionInput = h('input', { type: 'text', placeholder: 'Optional context or shot notes…', maxlength: '500' });

  const paste = h('textarea.wb-paste', { placeholder: '<!doctype html>\n<html>…</html>', spellcheck: 'false', 'aria-label': 'HTML' });
  const starterBtn = h('button.btn.sm', { type: 'button', title: 'Insert a 1280px Factory-designed HTML template with numbered eyebrows and ping buttons' }, 'Load Factory starter');
  starterBtn.addEventListener('click', () => {
    if (paste.value.trim() && !window.confirm('Replace the current HTML with the Factory 1280px starter template?')) return;
    paste.value = FACTORY_HTML_STARTER;
    if (!title.value.trim()) title.value = 'Proposal';
    paste.focus();
  });

  const fileInput = h('input', { type: 'file', accept: '.html,.htm,text/html' });
  const folderInput = h('input', { type: 'file', multiple: true });
  folderInput.setAttribute('webkitdirectory', '');
  const entrySelect = h('select', { 'aria-label': 'The page to open' });
  const summary = h('p.field-hint');
  const error = h('p.note.bad.hidden');
  const progress = h('p.field-hint.hidden');
  const add = h('button.btn.accent', { type: 'button' }, 'Add to the board');

  const SOURCES_LIST: { id: Source; label: string }[] = [
    { id: 'markdown', label: 'Markdown' },
    { id: 'media', label: 'Video / Image' },
    { id: 'paste', label: 'Paste HTML' },
    { id: 'file', label: 'HTML file' },
    { id: 'folder', label: 'Folder' },
  ];

  const tabs = SOURCES_LIST.map((s) => h('button.tab', { type: 'button', role: 'tab', onclick: () => ((source = s.id), paint()) }, s.label));
  const panes: Record<Source, HTMLElement> = {
    markdown: h(
      'div.stack.tight',
      {},
      field('Markdown', mdArea, 'Rendered in 1280px Factory typography with numbered section eyebrows, tables, callouts, and interactive `- [ ]` task checkboxes.'),
      h('div.wb-add-split', {}, field('Or load a .md file', mdFile), field('Surface mood', themeSelect)),
    ),
    media: h('div.stack.tight', {}, field('Video or image file', mediaFile, 'MP4, WebM, MOV, Ogg, PNG, JPEG, WebP, GIF, or SVG up to 100 MB.'), posterWrap, field('Caption (optional)', captionInput)),
    paste: h('div.stack.tight', {}, h('div.row.between', {}, h('span.field-hint', {}, '1280px wide HTML artifact. Scripts run in a sandboxed iframe with window.whiteboard.'), starterBtn), field('HTML', paste)),
    file: h('div.stack.tight', {}, field('Page', fileInput, 'One .html file. For a page with local images, styles or scripts, upload its folder instead.')),
    folder: h('div.stack.tight', {}, field('Folder', folderInput, 'Every file in it goes up with the page, so relative links, ES module imports and fetch() work.'), field('Open', entrySelect), summary),
  };
  const body = h('div.body.stack', {}, field('Title', title), h('div.tabs', { role: 'tablist' }, ...tabs), panes.markdown, panes.media, panes.paste, panes.file, panes.folder, error, progress);
  const el = h(
    'div.modal.wb-add',
    { 'aria-label': 'Add card' },
    windowHeader('Add card', 'Markdown, video, image, or custom HTML artifact'),
    body,
    h('footer', {}, h('span.grow', {}, `Up to ${MAX_HTML_BYTES / MB} MB a page, ${MAX_ASSET_BYTES / MB} MB a media file`), h('button.btn.ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), add),
  );

  const say = (text: string) => {
    error.textContent = text;
    error.classList.toggle('hidden', !text);
  };
  const paint = () => {
    tabs.forEach((t, i) => t.setAttribute('aria-selected', String(SOURCES_LIST[i].id === source)));
    for (const s of Object.keys(panes) as Source[]) panes[s].classList.toggle('hidden', s !== source);
    say('');
  };

  mdFile.addEventListener('change', async () => {
    const f = mdFile.files?.[0];
    if (!f) return;
    const text = await f.text();
    mdArea.value = text;
    if (!title.value.trim()) title.value = extractMarkdownTitle(text) || stemOf(f.name);
  });
  mediaFile.addEventListener('change', () => {
    const f = mediaFile.files?.[0];
    if (!f) {
      posterWrap.classList.add('hidden');
      return;
    }
    const kind = droppedCardKind(f.name, f.type);
    posterWrap.classList.toggle('hidden', kind !== 'video');
    if (!title.value.trim()) title.value = stemOf(f.name);
  });
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    if (!title.value.trim()) title.value = titleOf(await f.text()) || stemOf(f.name);
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

  /** The files to upload, entry page, and optional format tag, or what's wrong with them. */
  async function prepare(): Promise<{ files: Picked[]; entry: string; format?: CardContent['format'] } | string> {
    if (source === 'markdown') {
      const md = mdArea.value;
      if (!md.trim()) return 'Write or paste some Markdown first.';
      const cardTitle = title.value.trim() || extractMarkdownTitle(md) || 'Markdown document';
      title.value = cardTitle;
      const html = renderMarkdownArtifact(md, { title: cardTitle, theme });
      return {
        entry: 'index.html',
        format: 'markdown',
        files: [
          { rel: 'index.html', file: new Blob([html], { type: 'text/html' }), mime: 'text/html; charset=utf-8' },
          { rel: 'document.md', file: new Blob([md], { type: 'text/markdown' }), mime: 'text/markdown; charset=utf-8' },
        ],
      };
    }
    if (source === 'media') {
      const f = mediaFile.files?.[0];
      if (!f) return 'Pick a video or image file first.';
      const kind = droppedCardKind(f.name, f.type);
      if (kind !== 'video' && kind !== 'image') return 'Pick an MP4, WebM, MOV, Ogg, PNG, JPEG, WebP, GIF, or SVG file.';
      const cardTitle = title.value.trim() || stemOf(f.name) || (kind === 'video' ? 'Video' : 'Image');
      title.value = cardTitle;
      const mime = mimeFor(f.name, f.type);
      const ext = extForMime(mime, f.name);
      const caption = captionInput.value.trim() || undefined;
      if (kind === 'video') {
        const videoRel = `video.${ext}`;
        const list: Picked[] = [{ rel: videoRel, file: f, mime }];
        let posterRel: string | undefined;
        const pf = posterFile.files?.[0];
        if (pf) {
          const pMime = mimeFor(pf.name, pf.type);
          posterRel = `poster.${extForMime(pMime, pf.name)}`;
          list.push({ rel: posterRel, file: pf, mime: pMime });
        }
        const html = renderVideoArtifact({ title: cardTitle, videoSrc: videoRel, videoMime: mime, posterSrc: posterRel, caption, sizeBytes: f.size });
        list.unshift({ rel: 'index.html', file: new Blob([html], { type: 'text/html' }), mime: 'text/html; charset=utf-8' });
        return { entry: 'index.html', format: 'video', files: list };
      }
      const dims = await measureImage(f);
      const imgRel = `image.${ext}`;
      const html = renderImageArtifact({ title: cardTitle, imageSrc: imgRel, imageMime: mime, width: dims.w, height: dims.h, sizeBytes: f.size, caption });
      return {
        entry: 'index.html',
        format: 'image',
        files: [
          { rel: 'index.html', file: new Blob([html], { type: 'text/html' }), mime: 'text/html; charset=utf-8' },
          { rel: imgRel, file: f, mime },
        ],
      };
    }
    if (source === 'paste') {
      const html = paste.value;
      if (!html.trim()) return 'Paste some HTML first (or click Load Factory starter).';
      if (!title.value.trim()) title.value = titleOf(html) || 'Pasted HTML';
      return { files: [{ rel: 'index.html', file: new Blob([html], { type: 'text/html' }), mime: 'text/html; charset=utf-8' }], entry: 'index.html', format: 'html' };
    }
    if (source === 'file') {
      const f = fileInput.files?.[0];
      if (!f) return 'Pick an .html file first.';
      const rel = /^[A-Za-z0-9._ -]+\.html?$/i.test(f.name) && !f.name.startsWith('.') ? f.name : 'index.html';
      return { files: [{ rel, file: f, mime: 'text/html; charset=utf-8' }], entry: rel, format: 'html' };
    }
    if (!picked.length) return 'Pick a folder first.';
    if (!entry) return 'That folder has no .html page to open.';
    return { files: picked, entry, format: 'html' };
  }

  add.addEventListener('click', async () => {
    say('');
    const got = await prepare();
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
    let refs: Record<string, FileRef>;
    try {
      refs = await uploadPickedFiles(floor, got.files, (done, n) => {
        progress.textContent = `Uploading ${done} of ${n}…`;
      });
    } catch (err) {
      add.disabled = false;
      progress.classList.add('hidden');
      return say(`The upload failed: ${(err as Error).message}`);
    }
    const content: CardContent = { entry: got.entry, files: refs, ...(got.format ? { format: got.format } : {}) };
    const card = newId('c');
    const ok = await create([{ op: 'card.create', card, kind: 'html', title: title.value.trim(), content }], card);
    add.disabled = false;
    progress.classList.add('hidden');
    if (ok) modal.close();
    else say('The board refused it. The reason is in the window.');
  });

  const modal = openModal(el, { size: 'lg' });
  paint();
  setTimeout(() => (source === 'markdown' ? mdArea : title).focus(), 30);
}

export const openAddHtml = openAddCard;

/** Edit an unlinked Markdown card in place, keeping all existing comments, stickies, pictures, and card state. */
export function openEditMarkdown(floor: string, card: Card, initialMarkdown: string, save: (ops: Op[]) => Promise<boolean>) {
  const currentTheme: DesignTheme = card.state.theme === 'light' ? 'light' : 'dark';
  let theme: DesignTheme = currentTheme;
  const mdArea = h('textarea.wb-paste.wb-md-edit', { spellcheck: 'false', 'aria-label': 'Markdown source' });
  mdArea.value = initialMarkdown;
  const themeSelect = h(
    'select.select',
    { 'aria-label': 'Factory theme' },
    h('option', { value: 'dark', selected: currentTheme === 'dark' }, 'Factory Dark (product)'),
    h('option', { value: 'light', selected: currentTheme === 'light' }, 'Factory Light (document)'),
  );
  themeSelect.addEventListener('change', () => {
    theme = themeSelect.value === 'light' ? 'light' : 'dark';
  });
  const error = h('p.note.bad.hidden');
  const saveBtn = h('button.btn.accent', { type: 'button' }, 'Save Markdown');
  const say = (text: string) => {
    error.textContent = text;
    error.classList.toggle('hidden', !text);
  };

  const commit = async () => {
    say('');
    const md = mdArea.value;
    if (!md.trim()) return say('Markdown cannot be empty.');
    if (!store.whiteboard.up) return say('Saving needs the office connection. Try again once it’s back.');
    const html = renderMarkdownArtifact(md, { title: card.title, theme });
    const htmlBlob = new Blob([html], { type: 'text/html' });
    const mdBlob = new Blob([md], { type: 'text/markdown' });
    if (htmlBlob.size > MAX_HTML_BYTES || mdBlob.size > MAX_HTML_BYTES) return say(`The document exceeds the ${MAX_HTML_BYTES / MB} MB limit.`);
    saveBtn.disabled = true;
    try {
      const uploaded = await uploadPickedFiles(floor, [
        { rel: 'index.html', file: htmlBlob, mime: 'text/html; charset=utf-8' },
        { rel: 'document.md', file: mdBlob, mime: 'text/markdown; charset=utf-8' },
      ]);
      // Keep any relative image assets already attached to this Markdown card.
      const existingAssets = Object.fromEntries(Object.entries(card.content?.files ?? {}).filter(([k]) => k !== 'index.html' && k !== 'document.md'));
      const content: CardContent = { entry: 'index.html', format: 'markdown', files: { ...existingAssets, ...uploaded } };
      const ops: Op[] = [{ op: 'card.content', card: card.id, content }];
      if (card.state.theme !== undefined && card.state.theme !== theme) ops.push({ op: 'state.set', card: card.id, path: ['theme'], value: theme });
      const ok = await save(ops);
      if (ok) modal.close();
      else say('The board refused the update.');
    } catch (err) {
      say(`The upload failed: ${(err as Error).message}`);
    } finally {
      saveBtn.disabled = false;
    }
  };

  mdArea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void commit();
    }
  });
  saveBtn.addEventListener('click', () => void commit());

  const el = h(
    'div.modal.wb-add',
    { 'aria-label': 'Edit Markdown' },
    windowHeader(`Edit “${card.title}”`, 'Comments, stickies, and state stay attached to matching sections'),
    h('div.body.stack', {}, field('Markdown', mdArea, 'Press ⌘/Ctrl+Enter to save.'), field('Surface mood', themeSelect), error),
    h('footer', {}, h('span.grow', {}, 'Relative images attached to this card are preserved'), h('button.btn.ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), saveBtn),
  );
  const modal = openModal(el, { size: 'lg' });
  setTimeout(() => mdArea.focus(), 30);
}

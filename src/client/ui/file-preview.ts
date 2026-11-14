import { threadDeliverable } from '../../shared/thread-diff';
import { withToken } from '../token';
import { attachCopyFeedback, codeLanguageLabel, highlightLine, preloadCodeLanguage } from './code-highlight';
import { h, type Modal, openModal } from './dom';
import { emptyState, windowHeader } from './kit';

// Read-only syntax-highlighted file preview modal opened from clickable `path` / `path:line`
// references in Thread messages. Fetches from GET /api/thread/file and centers the target line.

const MAX_HIGHLIGHTED_LINES = 2_500;

export interface FilePreviewOptions {
  floor: string;
  workerId: string;
  workerName?: string;
  path: string;
  line?: number;
  endLine?: number;
}

export interface NormalizedFilePreview {
  path: string;
  content: string;
  lines: string[];
  binary: boolean;
  truncated: boolean;
  size?: number;
  totalLines?: number;
  error?: string;
}

export function formatFilePreviewBytes(bytes: number | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Builds the authenticated `/api/thread/file` URL for a worker's workspace path. */
export function threadFilePreviewUrl(opts: { floor: string; workerId: string; path: string }): string {
  const params = new URLSearchParams({
    floor: opts.floor,
    worker: opts.workerId,
    path: opts.path,
  });
  return withToken(`/api/thread/file?${params}`);
}

/** The authenticated URL of a picture in a worker's workspace, as its bytes. */
export function threadFileImageUrl(opts: { floor: string; workerId: string; path: string }): string {
  const params = new URLSearchParams({ floor: opts.floor, worker: opts.workerId, path: opts.path, raw: 'image' });
  return withToken(`/api/thread/file?${params}`);
}

function splitFileLines(content: string): string[] {
  if (!content) return [];
  const normalized = content.replace(/\r\n/g, '\n');
  const trimmedTrailing = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
  return trimmedTrailing.split('\n');
}

/** Normalizes a `/api/thread/file` JSON payload without touching the DOM. */
export function normalizeFilePreviewResponse(payload: unknown, fallbackPath = ''): NormalizedFilePreview {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { path: fallbackPath, content: '', lines: [], binary: false, truncated: false, error: 'Unexpected response from the office.' };
  }
  const obj = payload as Record<string, unknown>;
  const path = typeof obj.path === 'string' && obj.path ? obj.path : fallbackPath;
  const error = typeof obj.error === 'string' && obj.error.trim() ? obj.error.trim() : undefined;
  const binary = Boolean(obj.binary ?? obj.isBinary);
  const truncated = Boolean(obj.truncated ?? obj.isTruncated);
  const content = typeof obj.content === 'string' ? obj.content : typeof obj.text === 'string' ? obj.text : '';
  const size = typeof obj.size === 'number' ? obj.size : typeof obj.totalBytes === 'number' ? obj.totalBytes : undefined;
  const totalLines = typeof obj.totalLines === 'number' ? obj.totalLines : undefined;

  return {
    path,
    content,
    lines: binary ? [] : splitFileLines(content),
    binary,
    truncated,
    size,
    totalLines,
    error,
  };
}

function formatLineSubtitle(line?: number, endLine?: number): string {
  if (typeof line !== 'number' || !Number.isFinite(line) || line < 1) return '';
  const start = Math.trunc(line);
  const stop = typeof endLine === 'number' && Number.isFinite(endLine) && Math.trunc(endLine) > start ? Math.trunc(endLine) : undefined;
  return stop ? `Lines ${start}–${stop}` : `Line ${start}`;
}

/** Opens a read-only syntax-highlighted file preview modal scrolled to `opts.line` (`xl` window). */
export function openFilePreviewModal(opts: FilePreviewOptions): Modal {
  const controller = new AbortController();
  let loadedContent = '';
  let canCopyFile = false;

  const startLine = typeof opts.line === 'number' && Number.isFinite(opts.line) && opts.line >= 1 ? Math.trunc(opts.line) : undefined;
  const stopLine = startLine !== undefined ? Math.max(startLine, typeof opts.endLine === 'number' && Number.isFinite(opts.endLine) ? Math.trunc(opts.endLine) : startLine) : undefined;

  const lineSub = formatLineSubtitle(startLine, stopLine);
  const langLabel = codeLanguageLabel(opts.path);
  const subtitleParts = [lineSub, opts.workerName ? `${opts.workerName} workspace` : '', langLabel !== 'code' ? langLabel : ''].filter(Boolean);

  const copyPathBtn = h('button.btn.sm.ghost.wt-code-copy.wt-file-copy-path', { type: 'button' }, 'Copy path');
  const resetCopyPath = attachCopyFeedback(copyPathBtn, () => opts.path, 'Copy path');

  const copyFileBtn = h('button.btn.sm.ghost.wt-code-copy.wt-file-copy-content', { type: 'button', disabled: true }, 'Copy file');
  const resetCopyFile = attachCopyFeedback(copyFileBtn, () => (canCopyFile ? loadedContent : ''), 'Copy file');

  const titleEl = h('span.wt-file-modal-title', { title: opts.path }, opts.path);
  const body = h('div.body.flush.wt-file-modal-body', {}, h('div.wt-file-loading', { role: 'status', 'aria-live': 'polite' }, h('span.spinner', { 'aria-hidden': 'true' }), h('span', {}, 'Loading file…')));
  const metaEl = h('span.grow.wt-file-meta', {}, opts.path);
  const closeFooterBtn = h('button.btn.ghost', { type: 'button', onclick: () => modal.close() }, 'Close');
  const footer = h('footer.wt-file-modal-foot', {}, metaEl, closeFooterBtn);

  const win = h('div.modal.wt-file-modal', { 'aria-label': `File preview: ${opts.path}` }, windowHeader(titleEl, subtitleParts.join(' · ') || undefined, copyPathBtn, copyFileBtn), body, footer);

  const modal = openModal(win, {
    size: 'xl',
    backdropCloses: true,
    reading: true,
    doing: `reading ${opts.path}`,
    onClose: () => {
      controller.abort();
      resetCopyPath();
      resetCopyFile();
    },
  });

  // A picture shows as itself rather than as text.
  if (threadDeliverable(opts.path) === 'image') {
    const img = h('img.wt-file-image', { src: threadFileImageUrl(opts), alt: opts.path, decoding: 'async' });
    img.addEventListener('load', () => (metaEl.textContent = `${img.naturalWidth} × ${img.naturalHeight}`));
    img.addEventListener('error', () => {
      body.replaceChildren(h('div.wt-file-state', {}, emptyState('!', 'Couldn’t open file', `${opts.path} couldn’t be shown as a picture.`)));
      metaEl.textContent = 'Unavailable';
    });
    body.replaceChildren(h('div.wt-file-picture', {}, img));
    return modal;
  }

  const url = threadFilePreviewUrl({ floor: opts.floor, workerId: opts.workerId, path: opts.path });

  void (async () => {
    try {
      const [res] = await Promise.all([fetch(url, { signal: controller.signal }), preloadCodeLanguage(opts.path)]);
      if (controller.signal.aborted || !win.isConnected) return;

      const json: unknown = await res.json().catch(() => null);
      if (controller.signal.aborted || !win.isConnected) return;

      const parsed = normalizeFilePreviewResponse(json, opts.path);
      if (!res.ok || parsed.error) {
        const msg = parsed.error ?? `Couldn’t load ${opts.path} (HTTP ${res.status}).`;
        body.replaceChildren(h('div.wt-file-state', {}, emptyState('!', 'Couldn’t open file', msg)));
        metaEl.textContent = 'Unavailable';
        return;
      }

      const sizeText = formatFilePreviewBytes(parsed.size);

      if (parsed.binary) {
        const desc = sizeText ? `${parsed.path} is a binary file (${sizeText}) and cannot be previewed as text.` : `${parsed.path} is a binary file and cannot be previewed as text.`;
        body.replaceChildren(h('div.wt-file-state', {}, emptyState('◻', 'Binary file', desc)));
        metaEl.textContent = ['Binary file', sizeText].filter(Boolean).join(' · ');
        return;
      }

      loadedContent = parsed.content;
      canCopyFile = true;
      copyFileBtn.disabled = false;

      if (!parsed.lines.length) {
        body.replaceChildren(h('div.wt-file-state', {}, emptyState('◻', 'Empty file', `${parsed.path} is empty.`)));
        metaEl.textContent = ['0 lines', sizeText || '0 B'].filter(Boolean).join(' · ');
        return;
      }

      const banner = parsed.truncated
        ? h(
            'div.note.info.wt-file-banner',
            { role: 'status' },
            sizeText ? `Showing the first ${parsed.lines.length} lines of ${parsed.path} (${sizeText} total, truncated for preview).` : `Showing the first ${parsed.lines.length} lines of ${parsed.path} (truncated for preview).`,
          )
        : null;

      let firstTargetRow: HTMLTableRowElement | undefined;
      const tbody = h('tbody');

      for (let i = 0; i < parsed.lines.length; i++) {
        const lineNo = i + 1;
        const lineText = parsed.lines[i];
        const isTarget = startLine !== undefined && stopLine !== undefined && lineNo >= startLine && lineNo <= stopLine;
        const rendered = lineNo <= MAX_HIGHLIGHTED_LINES ? highlightLine(lineText, parsed.path) : lineText;
        const codeCell = h('td.wt-file-code', {}, lineText.length ? rendered : '\u200b');
        const numCell = h('td.wt-file-num', { 'aria-hidden': 'true', 'data-line': lineNo }, String(lineNo));
        const row = h(isTarget ? 'tr.wt-file-line.is-target' : 'tr.wt-file-line', { 'data-line': lineNo }, numCell, codeCell);
        if (isTarget && !firstTargetRow) firstTargetRow = row;
        tbody.append(row);
      }

      // If requested line exceeds file length (e.g. truncated or stale line ref), scroll to the closest last line.
      if (!firstTargetRow && startLine !== undefined && tbody.lastElementChild instanceof HTMLElement) {
        firstTargetRow = tbody.lastElementChild as HTMLTableRowElement;
      }

      const table = h('table.wt-file-lines', {}, tbody);
      const scroller = h('div.wt-file-scroll', { tabindex: 0, 'aria-label': `Contents of ${parsed.path}` }, table);
      if (banner) body.replaceChildren(banner, scroller);
      else body.replaceChildren(scroller);

      const shownCount = parsed.totalLines ?? parsed.lines.length;
      metaEl.textContent = [`${shownCount} line${shownCount === 1 ? '' : 's'}`, sizeText, parsed.truncated ? 'truncated' : ''].filter(Boolean).join(' · ');

      if (firstTargetRow) {
        const target = firstTargetRow;
        const centerTarget = () => {
          if (target.isConnected && typeof target.scrollIntoView === 'function') {
            target.scrollIntoView({ block: 'center', inline: 'nearest' });
          }
        };
        centerTarget();
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(centerTarget);
      }
    } catch (err) {
      if (controller.signal.aborted || !win.isConnected) return;
      const msg = err instanceof Error ? err.message : 'Network error while reading file.';
      body.replaceChildren(h('div.wt-file-state', {}, emptyState('!', 'Couldn’t open file', msg)));
      metaEl.textContent = 'Error';
    }
  })();

  return modal;
}

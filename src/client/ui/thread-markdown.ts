import DOMPurify from 'dompurify';
import katex from 'katex';
import { Marked } from 'marked';
import { renderThreadMermaid } from './diagram';
import { localImagePath } from '../../shared/worker-thread';
import { CODE_PATH_LINE_RE, codePathRef, type WorkspacePathRef } from '../../shared/path-links';
import { h, openModal } from './dom';
import { extractJsonRenderBlocks, renderJsonWidget } from './json-render';
import { windowHeader } from './kit';
import { renderMdCodeBlock } from './thread-md-code';
import { type MdIconName, mdIcon, wireIconCopy } from './thread-md-icons';
import { openImageLightbox } from './thread-md-lightbox';
import { QUOTABLE_ATTR } from './thread-md-quote';

// Rich Markdown renderer for Thread view: code blocks with copy and "Show more", tables with
// Expand and Copy, colored alerts, Mermaid cards with a pan and zoom viewer, an image lightbox,
// offline KaTeX MathML, <json-render> widgets, clickable inline-code file paths, and sanitized
// user-message Markdown. Free of window/document calls at import time so Node unit tests import
// pure tokenizers and parsers directly.

const md = new Marked({ gfm: true, breaks: true });

const FORBIDDEN_TAGS = ['style', 'form', 'button', 'select', 'textarea', 'script', 'iframe', 'object', 'embed'];
const FORBIDDEN_ATTR = ['style'];

let purifyInstance: ReturnType<typeof DOMPurify> | undefined;

function getPurify(): ReturnType<typeof DOMPurify> {
  if (!purifyInstance) {
    purifyInstance = DOMPurify(window);
    purifyInstance.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A') {
        const href = node.getAttribute('href') ?? '';
        if (!href.toLowerCase().startsWith('mailto:')) {
          node.setAttribute('target', '_blank');
        }
        node.setAttribute('rel', 'noopener noreferrer');
      } else if (node.tagName === 'IMG') {
        node.setAttribute('loading', 'lazy');
        node.setAttribute('referrerpolicy', 'no-referrer');
      } else if (node.tagName === 'INPUT') {
        node.setAttribute('disabled', '');
      }
    });
  }
  return purifyInstance;
}

function sanitizeHtml(html: string): DocumentFragment {
  return getPurify().sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS: FORBIDDEN_TAGS,
    FORBID_ATTR: FORBIDDEN_ATTR,
  });
}

function sanitizeMathMl(mathMarkup: string): DocumentFragment {
  return getPurify().sanitize(mathMarkup, {
    RETURN_DOM_FRAGMENT: true,
    USE_PROFILES: { html: true, mathMl: true },
    FORBID_TAGS: FORBIDDEN_TAGS,
    FORBID_ATTR: FORBIDDEN_ATTR,
  });
}

// ------------------------------------------------------------------------------------------------
// TeX Math ($...$ and $$...$$)

export interface MathSegment {
  placeholder: string;
  tex: string;
  raw: string;
  display: boolean;
}

const PLAIN_NUMBER_MATH_RE = /^[+-]?\d+(?:[.,]\d+)*(?:[kKmMbB%])?$/;
const ALPHA_NUM_RE = /[A-Za-z0-9]/;
const URL_START_RE = /^(?:https?:\/\/|mailto:)[^\s<>()]+/i;
const HTML_TAG_START_RE = /^<(?:[A-Za-z][A-Za-z0-9:-]*(?:\s[^>\n]*)?|\/[A-Za-z][A-Za-z0-9:-]*\s*|!--[\s\S]*?--)>/;

function uniqueMathPrefix(src: string): string {
  let prefix = 'WTMATHSEG';
  let salt = 0;
  while (src.includes(prefix)) prefix = `WTMATHSEG${++salt}X`;
  return prefix;
}

function skipFenceIndent(src: string, pos: number, lineEnd: number): number {
  let i = pos;
  while (i < lineEnd) {
    let spaces = 0;
    while (i < lineEnd && src[i] === ' ' && spaces < 3) {
      i++;
      spaces++;
    }
    if (i < lineEnd && src[i] === '>') {
      i++;
      if (i < lineEnd && src[i] === ' ') i++;
      continue;
    }
    break;
  }
  return i;
}

function matchFenceOpen(src: string, lineStart: number, lineEnd: number): { ch: '`' | '~'; len: number } | null {
  let i = skipFenceIndent(src, lineStart, lineEnd);
  if (i >= lineEnd) return null;
  const ch = src[i];
  if (ch !== '`' && ch !== '~') return null;
  let len = 0;
  while (i < lineEnd && src[i] === ch) {
    len++;
    i++;
  }
  if (len < 3) return null;
  if (ch === '`' && src.slice(i, lineEnd).includes('`')) return null;
  return { ch, len };
}

function isFenceClose(src: string, lineStart: number, lineEnd: number, fence: { ch: '`' | '~'; len: number }): boolean {
  let i = skipFenceIndent(src, lineStart, lineEnd);
  let count = 0;
  while (i < lineEnd && src[i] === fence.ch) {
    count++;
    i++;
  }
  if (count < fence.len) return false;
  while (i < lineEnd && (src[i] === ' ' || src[i] === '\t' || src[i] === '\r')) i++;
  return i === lineEnd;
}

function findUnescapedDoubleDollar(src: string, from: number): number {
  let i = from;
  while (i < src.length - 1) {
    if (src[i] === '\\') {
      i += 2;
      continue;
    }
    if (src[i] === '$' && src[i + 1] === '$') return i;
    i++;
  }
  return -1;
}

function findInlineDollarClose(src: string, from: number, lineEnd: number): number {
  let i = from;
  while (i < lineEnd) {
    const ch = src[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '`') return -1;
    if (ch === '$') return i;
    i++;
  }
  return -1;
}

/**
 * Pure TeX math tokenizer (`$$...$$` display and Pandoc-strict `$...$` inline) that skips fenced code
 * blocks, inline backtick spans, HTML tags, URLs, and currency (`$100`, `$50 - $100`, `$0.00`, `$PATH`).
 */
export function extractMathSegments(src: string): { textWithPlaceholders: string; segments: MathSegment[] } {
  if (!src.includes('$')) return { textWithPlaceholders: src, segments: [] };

  const prefix = uniqueMathPrefix(src);
  const segments: MathSegment[] = [];
  let out = '';
  let i = 0;
  const n = src.length;
  let atLineStart = true;
  let activeFence: { ch: '`' | '~'; len: number } | null = null;

  while (i < n) {
    if (atLineStart) {
      const nl = src.indexOf('\n', i);
      const lineEnd = nl === -1 ? n : nl;
      if (activeFence) {
        if (isFenceClose(src, i, lineEnd, activeFence)) activeFence = null;
        out += src.slice(i, nl === -1 ? n : nl + 1);
        i = nl === -1 ? n : nl + 1;
        atLineStart = true;
        continue;
      }
      const opened = matchFenceOpen(src, i, lineEnd);
      if (opened) {
        activeFence = opened;
        out += src.slice(i, nl === -1 ? n : nl + 1);
        i = nl === -1 ? n : nl + 1;
        atLineStart = true;
        continue;
      }
      atLineStart = false;
    }

    const ch = src[i];
    if (ch === '\n') {
      out += '\n';
      i++;
      atLineStart = true;
      continue;
    }

    // Escaped character (such as \$100): emit both characters verbatim so \$ never opens math.
    if (ch === '\\' && i + 1 < n) {
      out += src.slice(i, i + 2);
      i += 2;
      continue;
    }

    // Skip inline code spans (`...`, ``...``).
    if (ch === '`') {
      let ticks = 0;
      while (i + ticks < n && src[i + ticks] === '`') ticks++;
      let search = i + ticks;
      let matchedEnd = -1;
      while (search < n) {
        const nextTick = src.indexOf('`', search);
        if (nextTick === -1) break;
        let run = 0;
        while (nextTick + run < n && src[nextTick + run] === '`') run++;
        if (run === ticks) {
          matchedEnd = nextTick + run;
          break;
        }
        search = nextTick + run;
      }
      if (matchedEnd !== -1) {
        const span = src.slice(i, matchedEnd);
        out += span;
        atLineStart = span.endsWith('\n');
        i = matchedEnd;
      } else {
        out += src.slice(i, i + ticks);
        i += ticks;
      }
      continue;
    }

    // Skip HTML tags (<a href="...">, <img ...>, etc.).
    if (ch === '<') {
      const tagMatch = HTML_TAG_START_RE.exec(src.slice(i));
      if (tagMatch) {
        out += tagMatch[0];
        i += tagMatch[0].length;
        continue;
      }
    }

    // Skip raw URLs (https://..., http://..., mailto:...).
    if ((ch === 'h' || ch === 'H' || ch === 'm' || ch === 'M') && (i === 0 || !ALPHA_NUM_RE.test(src[i - 1]))) {
      const urlMatch = URL_START_RE.exec(src.slice(i));
      if (urlMatch) {
        out += urlMatch[0];
        i += urlMatch[0].length;
        continue;
      }
    }

    if (ch === '$') {
      const prev = i > 0 ? src[i - 1] : '';

      // Display math: $$...$$
      if (i + 1 < n && src[i + 1] === '$') {
        if (i + 2 < n && src[i + 2] === '$') {
          // Run of 3+ dollars without content: emit literally.
          let run = 0;
          while (i + run < n && src[i + run] === '$') run++;
          out += src.slice(i, i + run);
          i += run;
          continue;
        }
        const closeIdx = findUnescapedDoubleDollar(src, i + 2);
        if (closeIdx !== -1) {
          const inner = src.slice(i + 2, closeIdx).trim();
          if (inner.length > 0) {
            const placeholder = `${prefix}${segments.length}END`;
            const raw = src.slice(i, closeIdx + 2);
            segments.push({ placeholder, tex: inner, raw, display: true });
            const standaloneLine = (i === 0 || src[i - 1] === '\n') && (closeIdx + 2 >= n || src[closeIdx + 2] === '\n' || src[closeIdx + 2] === '\r');
            out += standaloneLine ? `\n\n${placeholder}\n\n` : placeholder;
            i = closeIdx + 2;
            continue;
          }
        }
        out += '$$';
        i += 2;
        continue;
      }

      // Inline math: $...$ (Pandoc/Factory strict boundary rules).
      const next = i + 1 < n ? src[i + 1] : '';
      const validOpen = prev !== '\\' && prev !== '$' && (!prev || !ALPHA_NUM_RE.test(prev)) && Boolean(next) && !/\s/.test(next) && next !== '$';
      if (validOpen) {
        const nl = src.indexOf('\n', i + 1);
        const rIdx = src.indexOf('\r', i + 1);
        const lineEnd = Math.min(nl === -1 ? n : nl, rIdx === -1 ? n : rIdx);
        const closeIdx = findInlineDollarClose(src, i + 1, lineEnd);
        if (closeIdx >= i + 2) {
          const beforeClose = src[closeIdx - 1];
          const afterClose = closeIdx + 1 < n ? src[closeIdx + 1] : '';
          const validClose = !/\s/.test(beforeClose) && afterClose !== '$' && (!afterClose || !ALPHA_NUM_RE.test(afterClose));
          const inner = src.slice(i + 1, closeIdx);
          if (validClose && !PLAIN_NUMBER_MATH_RE.test(inner)) {
            const placeholder = `${prefix}${segments.length}END`;
            const raw = src.slice(i, closeIdx + 1);
            segments.push({ placeholder, tex: inner, raw, display: false });
            out += placeholder;
            i = closeIdx + 1;
            continue;
          }
        }
      }
    }

    out += ch;
    i++;
  }

  return { textWithPlaceholders: out, segments };
}

/**
 * Renders `tex` to pure presentation MathML via KaTeX (`output: 'mathml'`), with zero `style=""`
 * attributes and no KaTeX CSS or font requests: `style.css` draws it in the bundled STIX Two Math. Returns `null` when `tex` fails to parse.
 */
export function renderMathToMathMl(tex: string, displayMode: boolean): string | null {
  if (!tex.trim()) return null;
  try {
    const html = katex.renderToString(tex, {
      displayMode,
      throwOnError: false,
      trust: false,
      strict: 'ignore',
      output: 'mathml',
    });
    if (!html.includes('<math') || html.includes('katex-error')) return null;
    // Strip <annotation> and unwrap <semantics> so DOMPurify's built-in mathMl profile never leaks raw TeX text.
    return html.replace(/<annotation(?:-xml)?\b[^>]*>[\s\S]*?<\/annotation(?:-xml)?>/gi, '').replace(/<\/?semantics\b[^>]*>/gi, '');
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------------------------
// Workspace path:line link parser and DOM linkifier

export { codePathRef, parseWorkspacePathRefs, type WorkspacePathMatch, type WorkspacePathRef } from '../../shared/path-links';

function modifierKey(): { label: string; held: (e: MouseEvent) => boolean } {
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
  return mac ? { label: '⌘', held: (e) => e.metaKey } : { label: 'Ctrl', held: (e) => e.ctrlKey };
}

const OPEN_HINT = 'Click to open preview';

function wireFileLink(el: HTMLElement, label: string, ref: WorkspacePathRef, onOpenPath: (ref: WorkspacePathRef) => void): void {
  const link = el.closest('a');
  const mod = modifierKey();
  el.classList.add('wt-file-link');
  el.setAttribute('role', 'link');
  el.setAttribute('tabindex', '0');
  el.setAttribute('aria-label', label);
  el.setAttribute('title', link && el !== link ? `${OPEN_HINT}, ${mod.label}-click to open link` : OPEN_HINT);
  el.dataset.path = ref.path;
  if (ref.line !== undefined) el.dataset.line = String(ref.line);
  if (ref.endLine !== undefined) el.dataset.endLine = String(ref.endLine);
  const open = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    onOpenPath({ ...ref });
  };
  el.addEventListener('click', (e) => {
    // A path inside a Markdown link: the modifier click follows the link instead.
    if (link && el !== link && mod.held(e)) return;
    open(e);
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') open(e);
  });
}

/** Inline code that names a workspace file becomes Factory's file link chip. */
function linkifyCodePaths(root: HTMLElement, onOpenPath: (ref: WorkspacePathRef) => void): void {
  for (const code of [...root.querySelectorAll('code')]) {
    if (code.closest('pre, .wt-md-code, .jr-root') || code.childElementCount > 0) continue;
    const raw = code.textContent ?? '';
    const ref = codePathRef(raw);
    if (ref) wireFileLink(code, raw.trim(), ref, onOpenPath);
  }
}

const FILE_HREF_PREFIX = '#wt-file=';

/** A `file://` URL or a bare workspace path written as a link target, as the marker href the sanitizer keeps. */
function fileLinkHref(href: string): string | null {
  if (/^file:\/\//i.test(href)) {
    try {
      const url = new URL(href);
      if (url.hostname && url.hostname !== 'localhost') return null;
      return `${FILE_HREF_PREFIX}${encodeURIComponent(decodeURIComponent(url.pathname))}`;
    } catch {
      return null;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#') || href.startsWith('//')) return null;
  return codePathRef(href) ? `${FILE_HREF_PREFIX}${encodeURIComponent(href)}` : null;
}

/** Links to files open the preview (or read as plain text when files cannot open here). */
function upgradeFileAnchors(root: HTMLElement, onOpenPath: ((ref: WorkspacePathRef) => void) | undefined): void {
  for (const a of [...root.querySelectorAll<HTMLAnchorElement>('a[href]')]) {
    const href = a.getAttribute('href') ?? '';
    if (!href.startsWith(FILE_HREF_PREFIX)) continue;
    const target = decodeURIComponent(href.slice(FILE_HREF_PREFIX.length));
    const m = CODE_PATH_LINE_RE.exec(target);
    const ref: WorkspacePathRef = { path: m ? target.slice(0, m.index) : target };
    if (m) ref.line = Number(m[1]);
    if (m?.[3] !== undefined && Number(m[3]) >= Number(m[1])) ref.endLine = Number(m[3]);
    if (!onOpenPath) {
      a.replaceWith(h('span', {}, ...a.childNodes));
      continue;
    }
    a.removeAttribute('target');
    a.setAttribute('href', '#');
    wireFileLink(a, a.textContent?.trim() || ref.path, ref, onOpenPath);
    a.classList.add('wt-file-anchor');
  }
}

// ------------------------------------------------------------------------------------------------
// Shared post-processing: alerts, tables, fenced code blocks, math & <json-render> hydration

const ALERTS: Record<string, { label: string; icon: MdIconName }> = {
  NOTE: { label: 'Note', icon: 'info' },
  TIP: { label: 'Tip', icon: 'sparkles' },
  IMPORTANT: { label: 'Important', icon: 'messageSquare' },
  WARNING: { label: 'Warning', icon: 'triangleAlert' },
  CAUTION: { label: 'Caution', icon: 'circleAlert' },
};

/** `> [!NOTE]` (optionally `> [!NOTE] Custom title`) blockquotes become Factory's colored alerts. */
function upgradeAlerts(root: HTMLElement): void {
  for (const q of root.querySelectorAll('blockquote')) {
    if (q.closest('.jr-root')) continue;
    const p = q.firstElementChild;
    const m = p?.tagName === 'P' ? /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.exec(p.textContent ?? '') : null;
    if (!p || !m) continue;
    const kind = m[1].toUpperCase();
    let title = '';
    const first = p.firstChild;
    if (first?.nodeType === Node.TEXT_NODE) {
      const rest = (first.textContent ?? '').replace(/^\s*\[![A-Za-z]+\][ \t]*/, '');
      const next = first.nextSibling;
      if (rest.trim() && (!next || next.nodeName === 'BR')) {
        title = rest.trim();
        first.remove();
      } else first.textContent = rest;
    }
    if (p.firstChild?.nodeName === 'BR') p.firstChild.remove();
    if (!p.textContent?.trim() && !p.querySelector('img')) p.remove();
    const { label, icon } = ALERTS[kind];
    q.classList.add('wt-md-alert', `wt-md-alert-${kind.toLowerCase()}`);
    q.dataset.markdownAlert = kind.toLowerCase();
    q.prepend(h('div.wt-md-alert-title', {}, mdIcon(icon, 16), h('span', {}, title || label)));
  }
}

/** A rendered table back to GitHub Markdown, for tables whose source could not be matched. */
export function tableToMarkdown(table: HTMLTableElement): string {
  const rows = [...table.rows].map((r) => [...r.cells].map((c) => (c.textContent ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()));
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`;
  return [line(rows[0]), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n');
}

function openTableViewer(table: HTMLTableElement): void {
  const copy = table.cloneNode(true) as HTMLTableElement;
  const content = h('div.modal.wt-md-table-modal', { 'aria-label': 'Table' }, windowHeader('Table'), h('div.body.flush.wt-md-table-viewer', {}, h('div.md.wt-md', {}, copy)));
  openModal(content, { size: 'full', backdropCloses: true, reading: true, doing: 'reading a table' });
}

/** Tables get Factory's frame plus hover Expand and Copy Markdown table actions. */
function upgradeTables(root: HTMLElement, sources: readonly string[] | undefined): void {
  const tables = [...root.querySelectorAll('table')].filter((t) => !t.closest('.jr-root, .wt-md-table'));
  const matched = sources?.length === tables.length;
  tables.forEach((table, i) => {
    const source = matched && sources ? sources[i] : undefined;
    const scroll = h('div.wt-md-table-scroll');
    const expand = h('button.wt-md-table-btn', { type: 'button', 'aria-label': 'Expand Markdown table', title: 'Expand Markdown table' }, mdIcon('maximize', 14));
    expand.addEventListener('click', () => openTableViewer(table));
    const copy = h('button.wt-md-table-btn', { type: 'button' });
    wireIconCopy(copy, () => source ?? tableToMarkdown(table), { idle: 'Copy Markdown table', done: 'Markdown table copied' }, { size: 14 });
    const wrap = h('div.wt-md-table', { 'data-markdown-table-scroll': 'true' }, scroll, h('div.wt-md-table-actions', { 'data-copy-exclude': 'true', 'data-testid': 'markdown-table-actions' }, expand, copy));
    table.replaceWith(wrap);
    scroll.append(table);
  });
}

function mediaFallback(img: HTMLImageElement): HTMLElement {
  const src = img.getAttribute('src') ?? '';
  const alt = img.getAttribute('alt') ?? '';
  const parts = [mdIcon('image', 14), h('span', {}, 'Preview unavailable'), alt ? h('span.wt-md-media-alt', {}, alt) : null];
  return /^https?:/i.test(src) ? h('a.wt-md-media-fallback', { href: src, target: '_blank', rel: 'noopener noreferrer', title: src }, ...parts) : h('span.wt-md-media-fallback', { title: alt }, ...parts);
}

/** Pictures open Factory's lightbox (stepping through this message's pictures) and fall back to a note when they fail to load. */
function upgradeImages(root: HTMLElement): void {
  for (const img of [...root.querySelectorAll('img')]) {
    if (img.closest('.jr-root')) continue;
    img.addEventListener('error', () => img.replaceWith(mediaFallback(img)), { once: true });
    if (img.closest('a')) continue;
    img.classList.add('wt-md-img');
    img.setAttribute('tabindex', '0');
    img.setAttribute('role', 'button');
    img.setAttribute('title', 'Full size preview');
    const open = () => {
      const all = [...root.querySelectorAll<HTMLImageElement>('img.wt-md-img')];
      openImageLightbox(
        all.map((i) => ({ src: i.currentSrc || i.src, alt: i.alt })),
        Math.max(all.indexOf(img), 0),
      );
    };
    img.addEventListener('click', open);
    img.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });
  }
}

function codeFenceLang(codeEl: HTMLElement | null): string {
  if (!codeEl) return '';
  for (const cls of codeEl.classList) {
    if (cls.startsWith('language-')) return cls.slice('language-'.length);
  }
  return '';
}

function displayMath(tex: string): HTMLElement | null {
  const mathMl = renderMathToMathMl(tex, true);
  if (!mathMl) return null;
  const block = h('div.wt-math.wt-math-block');
  block.append(sanitizeMathMl(mathMl));
  return block.querySelector('math') ? block : null;
}

/** Whether a marked `code` token's source closed its fence (an indented block always has). */
export function fenceClosed(raw: string): boolean {
  const open = /^ {0,3}(`{3,}|~{3,})/.exec(raw);
  if (!open) return true;
  const lines = raw.replace(/\n+$/, '').split('\n');
  if (lines.length < 2) return false;
  const last = lines[lines.length - 1].trim();
  return last.length >= open[1].length && [...last].every((c) => c === open[1][0]);
}

/**
 * Replaces `pre` blocks with code blocks, and (for rich replies) ```mermaid and ```math fences
 * with their rendered views. `closed` is each fence's {@link fenceClosed} in document order,
 * matched to the `pre` elements only when the counts agree.
 */
function upgradeFencedBlocks(root: HTMLElement, richBlocks: boolean, closed: readonly boolean[] | undefined, streaming: boolean): void {
  const pres = [...root.querySelectorAll('pre')].filter((pre) => !pre.closest('.wt-md-code, .jr-root, .wt-mermaid-host'));
  const matched = closed?.length === pres.length;
  pres.forEach((pre, i) => {
    const complete = matched && closed ? closed[i] : true;
    const codeEl = pre.querySelector('code');
    const rawText = (codeEl?.textContent ?? pre.textContent ?? '').replace(/\n$/, '');
    const lang = codeFenceLang(codeEl).trim();
    const lower = lang.toLowerCase();

    if (richBlocks && lower === 'mermaid') return pre.replaceWith(renderThreadMermaid(rawText, { complete: !streaming || complete }));
    if (richBlocks && lower === 'math' && complete) {
      const math = displayMath(rawText);
      if (math) return pre.replaceWith(math);
    }
    pre.replaceWith(renderMdCodeBlock(rawText, lang));
  });
}

function hydrateJsonRenderPlaceholders(root: HTMLElement, blocks: ReturnType<typeof extractJsonRenderBlocks>['blocks'], streaming: boolean): void {
  if (!blocks.length) return;
  const byToken = new Map(blocks.map((b) => [b.placeholder, b]));

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('pre, code') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const candidates: Text[] = [];
  while (walker.nextNode()) {
    const t = walker.currentNode as Text;
    for (const b of blocks) {
      if (t.data.includes(b.placeholder)) {
        candidates.push(t);
        break;
      }
    }
  }

  for (const t of candidates) {
    const parent = t.parentElement;
    const trimmed = t.data.trim();
    const exact = byToken.get(trimmed);
    if (exact && parent?.tagName === 'P' && parent.childNodes.length === 1) {
      const widget = renderJsonWidget(exact.rawJson, !exact.complete || streaming);
      if (widget) parent.replaceWith(widget);
      else parent.remove();
      continue;
    }

    let remaining = t.data;
    const frag = document.createDocumentFragment();
    let replaced = false;
    while (remaining) {
      let earliestIdx = -1;
      let earliestBlock: (typeof blocks)[number] | undefined;
      for (const b of blocks) {
        const idx = remaining.indexOf(b.placeholder);
        if (idx !== -1 && (earliestIdx === -1 || idx < earliestIdx)) {
          earliestIdx = idx;
          earliestBlock = b;
        }
      }
      if (earliestIdx === -1 || !earliestBlock) {
        frag.append(remaining);
        break;
      }
      if (earliestIdx > 0) frag.append(remaining.slice(0, earliestIdx));
      const widget = renderJsonWidget(earliestBlock.rawJson, !earliestBlock.complete || streaming);
      if (widget) frag.append(widget);
      remaining = remaining.slice(earliestIdx + earliestBlock.placeholder.length);
      replaced = true;
    }
    if (replaced) t.replaceWith(frag);
  }
}

function hydrateMathPlaceholders(root: HTMLElement, segments: readonly MathSegment[]): void {
  if (!segments.length) return;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('pre, code, .jr-root') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const candidates: Text[] = [];
  while (walker.nextNode()) {
    const t = walker.currentNode as Text;
    for (const seg of segments) {
      if (t.data.includes(seg.placeholder)) {
        candidates.push(t);
        break;
      }
    }
  }

  for (const t of candidates) {
    let remaining = t.data;
    const frag = document.createDocumentFragment();
    let changed = false;

    while (remaining) {
      let earliestIdx = -1;
      let earliestSeg: MathSegment | undefined;
      for (const seg of segments) {
        const idx = remaining.indexOf(seg.placeholder);
        if (idx !== -1 && (earliestIdx === -1 || idx < earliestIdx)) {
          earliestIdx = idx;
          earliestSeg = seg;
        }
      }
      if (earliestIdx === -1 || !earliestSeg) {
        frag.append(remaining);
        break;
      }
      if (earliestIdx > 0) frag.append(remaining.slice(0, earliestIdx));
      const mathMl = renderMathToMathMl(earliestSeg.tex, earliestSeg.display);
      if (mathMl) {
        const wrap = h(earliestSeg.display ? 'span.wt-math.wt-math-display' : 'span.wt-math.wt-math-inline');
        wrap.append(sanitizeMathMl(mathMl));
        if (wrap.querySelector('math')) frag.append(wrap);
        else frag.append(earliestSeg.raw);
      } else {
        frag.append(earliestSeg.raw);
      }
      remaining = remaining.slice(earliestIdx + earliestSeg.placeholder.length);
      changed = true;
    }

    if (changed) {
      const parent = t.parentElement;
      if (parent?.tagName === 'P' && parent.childNodes.length === 1 && frag.childNodes.length === 1 && (frag.firstChild as Element | null)?.classList?.contains('wt-math-display')) {
        const block = h('div.wt-math.wt-math-block');
        block.append(...(frag.firstChild as Element).childNodes);
        parent.replaceWith(block);
      } else {
        t.replaceWith(frag);
      }
    }
  }
}

// ------------------------------------------------------------------------------------------------
// Public Thread Markdown Entry Points

export interface ThreadMarkdownOptions {
  /** Called when the user clicks a workspace `path` or `path:line(-endLine)` reference. */
  onOpenPath?: (ref: WorkspacePathRef) => void;
  /** True while the assistant message is still streaming, so incomplete widgets show a quiet loading state. */
  streaming?: boolean;
  /** The URL that loads a picture on the office's machine an image names ({@link localImagePath}); without it such images keep their own src. */
  imageUrl?: (path: string) => string;
  /**
   * The message's stable id. While `streaming`, blocks that were not in this message's previous
   * render get `data-entering` (Factory's 200ms fade-in); it also tags the reply for quote reply.
   */
  key?: string;
}

interface Lexed {
  html: string;
  /** Each table's Markdown source, in document order. */
  tables: string[];
  /** Whether each code block's fence closed, in document order. */
  fences: boolean[];
}

/** Marked's HTML for `src`, with images of files on the office's machine pointed at `imageUrl` before sanitizing (which drops `file:` URLs), and file links marked. */
function lex(src: string, imageUrl: ((path: string) => string) | undefined): Lexed {
  const tokens = md.lexer(src);
  const tables: string[] = [];
  const fences: boolean[] = [];
  md.walkTokens(tokens, (token) => {
    if (token.type === 'image') {
      const local = imageUrl ? localImagePath(token.href) : null;
      if (local && imageUrl) token.href = imageUrl(local);
    } else if (token.type === 'link') {
      const marked = fileLinkHref(token.href);
      if (marked) token.href = marked;
    } else if (token.type === 'table') tables.push(token.raw.replace(/\n+$/, ''));
    else if (token.type === 'code') fences.push(fenceClosed(token.raw));
  });
  return { html: md.parser(tokens), tables, fences };
}

const cellCount = (row: string) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').length;

/** While streaming, a table's last row that is still arriving is held back until it is whole (Factory's provisional table). */
export function trimProvisionalTable(src: string): string {
  if (src.endsWith('\n')) return src;
  const lines = src.split('\n');
  const last = lines[lines.length - 1];
  if (!/^\s*\|/.test(last)) return src;
  let start = lines.length - 1;
  while (start > 0 && /^\s*\|/.test(lines[start - 1])) start--;
  if (lines.length - 1 - start < 2) return src;
  if (/\|\s*$/.test(last) && cellCount(last) === cellCount(lines[start])) return src;
  return lines.slice(0, -1).join('\n');
}

const MAX_ENTERING_KEYS = 64;
const renderedBlocks = new Map<string, number>();

function markEntering(root: HTMLElement, opts: ThreadMarkdownOptions | undefined): void {
  const key = opts?.key;
  if (!key) return;
  if (!opts?.streaming) {
    renderedBlocks.delete(key);
    return;
  }
  const count = root.children.length;
  const before = renderedBlocks.get(key);
  // The first render of a streaming message is what it already showed: nothing fades.
  if (before !== undefined) for (let i = before; i < count; i++) root.children[i].setAttribute('data-entering', '');
  renderedBlocks.delete(key);
  renderedBlocks.set(key, Math.max(before ?? 0, count));
  if (renderedBlocks.size > MAX_ENTERING_KEYS) {
    const oldest = renderedBlocks.keys().next().value;
    if (oldest !== undefined) renderedBlocks.delete(oldest);
  }
}

function restoreMath(text: string, segments: readonly MathSegment[]): string {
  let out = text;
  for (const seg of segments) if (out.includes(seg.placeholder)) out = out.split(seg.placeholder).join(seg.raw);
  return out;
}

/** Renders rich assistant Markdown for Thread view. */
export function threadMarkdown(src: string, opts?: ThreadMarkdownOptions): HTMLElement {
  const root = h('div.md.wt-md', opts?.key ? { [QUOTABLE_ATTR]: opts.key } : {});
  if (!src.trim()) return root;
  const streaming = Boolean(opts?.streaming);

  const { textWithPlaceholders: withoutWidgets, blocks: jsonBlocks } = extractJsonRenderBlocks(streaming ? trimProvisionalTable(src) : src);
  const { textWithPlaceholders: prepared, segments: mathSegments } = extractMathSegments(withoutWidgets);

  const lexed = lex(prepared, opts?.imageUrl);
  root.append(sanitizeHtml(lexed.html));

  hydrateJsonRenderPlaceholders(root, jsonBlocks, streaming);
  hydrateMathPlaceholders(root, mathSegments);
  upgradeFencedBlocks(root, true, lexed.fences, streaming);
  upgradeAlerts(root);
  upgradeTables(
    root,
    lexed.tables.map((t) => restoreMath(t, mathSegments)),
  );
  upgradeImages(root);
  upgradeFileAnchors(root, opts?.onOpenPath);
  if (opts?.onOpenPath) linkifyCodePaths(root, opts.onOpenPath);
  markEntering(root, opts);

  return root;
}

/** Renders safe formatted Markdown for user messages in Thread view. */
export function threadUserMarkdown(src: string): HTMLElement {
  const root = h('div.md.wt-md.wt-user-md');
  if (!src.trim()) return root;

  const lexed = lex(src, undefined);
  root.append(sanitizeHtml(lexed.html));

  upgradeFencedBlocks(root, false, lexed.fences, false);
  upgradeAlerts(root);
  upgradeTables(root, lexed.tables);
  upgradeImages(root);
  upgradeFileAnchors(root, undefined);

  return root;
}

export { attachQuoteReply, quoteAsMarkdown } from './thread-md-quote';
export { type LightboxImage, openImageLightbox } from './thread-md-lightbox';

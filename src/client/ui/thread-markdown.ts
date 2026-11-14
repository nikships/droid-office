import DOMPurify from 'dompurify';
import katex from 'katex';
import { Marked } from 'marked';
import { attachCopyFeedback, renderCodeFrame, syncHorizontalScrollCue } from './code-highlight';
import { renderThreadMermaid } from './diagram';
import { h } from './dom';
import { extractJsonRenderBlocks, renderJsonWidget } from './json-render';

// Rich Markdown renderer for Thread view: syntax-highlighted code frames, <json-render> widgets,
// interactive Mermaid cards, offline KaTeX MathML, email draft cards, clickable workspace
// path:line links, and sanitized user-message Markdown. Free of window/document calls at import
// time so Node unit tests import pure tokenizers and parsers directly.

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
// Email draft blocks (```email)

export interface EmailDraft {
  to: string;
  cc?: string;
  bcc?: string;
  inReplyTo?: string;
  subject?: string;
  body: string;
  raw: string;
}

const KNOWN_EMAIL_HEADERS = new Set(['to', 'cc', 'bcc', 'in-reply-to', 'subject', 'from', 'reply-to']);

/** Parses an `email` fenced code block with RFC-style headers before the blank line + body. */
export function parseEmailDraft(raw: string): EmailDraft | null {
  const normalized = raw.replace(/\r\n/g, '\n');
  const trimmedStart = normalized.replace(/^\n+/, '');
  if (!trimmedStart.trim()) return null;

  const blankIdx = trimmedStart.indexOf('\n\n');
  const headerPart = blankIdx === -1 ? trimmedStart : trimmedStart.slice(0, blankIdx);
  const bodyPart = blankIdx === -1 ? '' : trimmedStart.slice(blankIdx + 2);

  const lines = headerPart.split('\n');
  const headers = new Map<string, string>();
  let lastHeaderKey = '';

  for (const line of lines) {
    if (/^[ \t]+\S/.test(line) && lastHeaderKey) {
      headers.set(lastHeaderKey, `${headers.get(lastHeaderKey) ?? ''} ${line.trim()}`.trim());
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) return null;
    const key = line.slice(0, colon).trim().toLowerCase();
    if (!KNOWN_EMAIL_HEADERS.has(key)) return null;
    const val = line.slice(colon + 1).trim();
    const prev = headers.get(key);
    headers.set(key, prev ? `${prev}, ${val}` : val);
    lastHeaderKey = key;
  }

  const to = headers.get('to') ?? '';
  const subject = headers.get('subject');
  if (!to && !subject) return null;

  const draft: EmailDraft = {
    to,
    body: bodyPart.replace(/\n+$/, ''),
    raw: trimmedStart.replace(/\n+$/, ''),
  };
  const cc = headers.get('cc');
  const bcc = headers.get('bcc');
  const inReplyTo = headers.get('in-reply-to');
  if (cc) draft.cc = cc;
  if (bcc) draft.bcc = bcc;
  if (inReplyTo) draft.inReplyTo = inReplyTo;
  if (subject !== undefined && subject !== '') draft.subject = subject;
  return draft;
}

function extractRecipientAddresses(rawRecipients: string): string {
  return rawRecipients
    .split(',')
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return '';
      const angle = /<([^<>@\s]+@[^<>@\s]+)>/.exec(trimmed);
      const addr = angle ? angle[1] : trimmed;
      return encodeURIComponent(addr).replace(/%40/g, '@');
    })
    .filter(Boolean)
    .join(',');
}

/** Builds a `mailto:` URL using `encodeURIComponent` (spaces encoded as `%20`, never `+`). */
export function buildMailtoHref(draft: EmailDraft): string {
  const toPath = draft.to ? extractRecipientAddresses(draft.to) : '';
  const params: string[] = [];
  if (draft.cc) params.push(`cc=${encodeURIComponent(draft.cc)}`);
  if (draft.bcc) params.push(`bcc=${encodeURIComponent(draft.bcc)}`);
  if (draft.inReplyTo) params.push(`in-reply-to=${encodeURIComponent(draft.inReplyTo)}`);
  if (draft.subject) params.push(`subject=${encodeURIComponent(draft.subject)}`);
  if (draft.body) params.push(`body=${encodeURIComponent(draft.body)}`);
  return params.length ? `mailto:${toPath}?${params.join('&')}` : `mailto:${toPath}`;
}

function renderEmailCard(draft: EmailDraft): HTMLElement {
  const copyBodyBtn = h('button.btn.sm.ghost.wt-code-copy.wt-email-copy-body', { type: 'button' }, 'Copy body');
  attachCopyFeedback(copyBodyBtn, () => draft.body, 'Copy body');

  const copyAllBtn = h('button.btn.sm.ghost.wt-code-copy.wt-email-copy-all', { type: 'button' }, 'Copy all');
  attachCopyFeedback(copyAllBtn, () => draft.raw, 'Copy all');

  const mailLink = h(
    'a.btn.sm.wt-email-open',
    {
      href: buildMailtoHref(draft),
      rel: 'noopener noreferrer',
    },
    'Open in Mail',
  );

  const metaRows: HTMLElement[] = [];
  const addRow = (label: string, val: string | undefined) => {
    if (!val) return;
    metaRows.push(h('div.wt-email-field', {}, h('span.wt-email-label', {}, label), h('span.wt-email-value', {}, val)));
  };
  addRow('To', draft.to);
  addRow('Cc', draft.cc);
  addRow('Bcc', draft.bcc);
  addRow('In-Reply-To', draft.inReplyTo);
  addRow('Subject', draft.subject);

  return h(
    'div.wt-code-block.wt-email-card',
    {},
    h('div.wt-code-head.wt-email-head', {}, h('span.wt-code-lang', {}, 'EMAIL DRAFT'), h('div.wt-code-actions.wt-email-actions', {}, copyBodyBtn, copyAllBtn, mailLink)),
    metaRows.length ? h('div.wt-email-meta', {}, ...metaRows) : null,
    draft.body ? h('div.wt-email-body', {}, draft.body) : null,
  );
}

// ------------------------------------------------------------------------------------------------
// Workspace path:line link parser and DOM linkifier

export interface WorkspacePathRef {
  path: string;
  line?: number;
  endLine?: number;
}

export interface WorkspacePathMatch extends WorkspacePathRef {
  raw: string;
  start: number;
  end: number;
}

const KNOWN_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'mts',
  'cts',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'json',
  'jsonc',
  'py',
  'pyi',
  'kt',
  'kts',
  'java',
  'rs',
  'go',
  'c',
  'h',
  'cc',
  'cpp',
  'cxx',
  'hpp',
  'hh',
  'm',
  'mm',
  'swift',
  'cs',
  'rb',
  'php',
  'lua',
  'r',
  'scala',
  'clj',
  'dart',
  'zig',
  'nim',
  'sql',
  'graphql',
  'gql',
  'proto',
  'sh',
  'bash',
  'zsh',
  'fish',
  'ps1',
  'yml',
  'yaml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'env',
  'properties',
  'gradle',
  'xml',
  'plist',
  'html',
  'htm',
  'css',
  'scss',
  'sass',
  'less',
  'svg',
  'md',
  'mdx',
  'rst',
  'txt',
  'tex',
  'patch',
  'diff',
  'lock',
  'vue',
  'svelte',
  'astro',
  'prisma',
  'dockerfile',
  'mk',
  'cmake',
  'glsl',
  'wgsl',
  'metal',
  'entitlements',
]);

const KNOWN_EXTENSIONLESS_BASENAMES = new Set(['Dockerfile', 'Containerfile', 'Makefile', 'GNUmakefile', 'Procfile', 'Gemfile', 'Podfile', 'Fastfile', 'Brewfile', 'LICENSE', 'CODEOWNERS']);

const KNOWN_ROOT_FILES = new Set([
  'README.md',
  'AGENTS.md',
  'CLAUDE.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'LICENSE',
  'Makefile',
  'Dockerfile',
  'package.json',
  'package-lock.json',
  'biome.jsonc',
  '.oxlintrc.json',
  '.env.example',
  '.droid-office.json',
  'vite.config.ts',
  'vite.config.js',
  'electron-builder.yml',
  'firebase.json',
  'tsconfig.json',
  'tsconfig.base.json',
  'tsconfig.server.json',
  'tsconfig.client.json',
  'tsconfig.desktop.json',
  'tsconfig.desktop-page.json',
  'Cargo.toml',
  'Cargo.lock',
  'pyproject.toml',
  'go.mod',
  'go.sum',
  'build.gradle.kts',
  'settings.gradle.kts',
]);

const DOMAIN_TLD_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+\.(?:com|org|net|io|ai|dev|app|co|gg|sh|rs|py|js|ts|edu|gov|mil|me|tv|xyz|info|biz|tech|cloud|site|online|page|link|so|to|fm|uk|de|fr|jp|ca|au|in|ch|nl|se|no|es|it|br|us|eu)(?::\d+)?$/i;
const HOST_PORT_OR_IP_RE = /^(?:localhost(?::\d+)?|\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?)$/i;

// Candidate token: optional ./ prefix, path characters, and optional :line(-endLine|:col) or #Lline(-LendLine).
const PATH_CANDIDATE_RE = /(?:\.\/)?[A-Za-z0-9_.][A-Za-z0-9_./-]*[A-Za-z0-9_](?:(?::\d+(?:-\d+|:\d+)?)|(?:#L\d+(?:-L?\d+)?))?/g;

function hasValidFileLeaf(base: string): boolean {
  if (!base || base === '.' || base === '..') return false;
  if (KNOWN_EXTENSIONLESS_BASENAMES.has(base) || KNOWN_ROOT_FILES.has(base)) return true;
  if (base.startsWith('.env.')) return true;
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return false;
  const ext = base.slice(dot + 1).toLowerCase();
  return KNOWN_EXTENSIONS.has(ext);
}

function validateWorkspacePathCandidate(rawToken: string, allowBareRootFile: boolean): WorkspacePathRef | null {
  let work = rawToken;
  let line: number | undefined;
  let endLine: number | undefined;

  const hashMatch = /#L(\d+)(?:-L?(\d+))?$/i.exec(work);
  if (hashMatch) {
    line = Number(hashMatch[1]);
    if (hashMatch[2]) endLine = Math.max(line, Number(hashMatch[2]));
    work = work.slice(0, hashMatch.index);
  } else {
    const colonMatch = /:(\d+)(?:-(\d+)|:(\d+))?$/.exec(work);
    if (colonMatch) {
      line = Number(colonMatch[1]);
      if (colonMatch[2]) endLine = Math.max(line, Number(colonMatch[2]));
      work = work.slice(0, colonMatch.index);
    }
  }

  if (line !== undefined && (!Number.isFinite(line) || line < 1)) return null;

  const hadDotSlash = work.startsWith('./');
  const cleanPath = hadDotSlash ? work.slice(2) : work;
  if (!cleanPath || cleanPath.startsWith('/') || cleanPath.endsWith('/')) return null;
  if (cleanPath.includes('//')) return null;

  const parts = cleanPath.split('/');
  for (const seg of parts) {
    if (!seg || seg === '.' || seg === '..') return null;
  }

  if (parts.length === 1) {
    // Root-level file: require known repo root filename AND (:line or ./prefix or inline-code context).
    if (!KNOWN_ROOT_FILES.has(cleanPath)) return null;
    if (!hadDotSlash && line === undefined && !allowBareRootFile) return null;
  } else {
    const firstSeg = parts[0];
    if (HOST_PORT_OR_IP_RE.test(firstSeg) || DOMAIN_TLD_RE.test(firstSeg)) return null;
    const leaf = parts[parts.length - 1];
    if (!hasValidFileLeaf(leaf)) return null;
  }

  const ref: WorkspacePathRef = { path: cleanPath };
  if (line !== undefined) ref.line = line;
  if (endLine !== undefined && endLine >= (line ?? 1)) ref.endLine = endLine;
  return ref;
}

/**
 * Matches workspace-relative file paths (`src/foo/bar.ts`, `src/foo/bar.ts:42-51`, `README.md:12`)
 * in `text`, excluding URLs (`://`, `mailto:`), `@mentions`, domain names (`factory.ai`, `github.com`),
 * absolute paths, and `..` segments.
 */
export function parseWorkspacePathRefs(text: string): WorkspacePathMatch[] {
  if (!text) return [];
  const matches: WorkspacePathMatch[] = [];
  PATH_CANDIDATE_RE.lastIndex = 0;

  for (let m = PATH_CANDIDATE_RE.exec(text); m; m = PATH_CANDIDATE_RE.exec(text)) {
    const start = m.index;
    const raw = m[0];
    const end = start + raw.length;

    // Check preceding context to exclude URLs (://, mailto:), @mentions/@scopes, ~/home, or absolute /paths.
    if (start > 0) {
      const prev = text[start - 1];
      if (prev === '@' || prev === '/' || prev === '~' || prev === '$' || prev === '#' || ALPHA_NUM_RE.test(prev)) continue;
      if (prev === ':') {
        const beforeColon = text.slice(Math.max(0, start - 12), start).toLowerCase();
        if (/[a-z][a-z0-9+.-]*:$/.test(beforeColon)) continue;
      }
    }

    // Check trailing context so `github.com` inside `github.com:443` or URL query strings aren't split weirdly.
    if (end < text.length) {
      const next = text[end];
      if (next === '@' || ALPHA_NUM_RE.test(next)) continue;
      if (raw && text.slice(end, end + 3) === '://') continue;
    }

    const validated = validateWorkspacePathCandidate(raw, false);
    if (!validated) continue;

    matches.push({
      raw,
      start,
      end,
      ...validated,
    });
  }

  return matches;
}

function makeFileLinkButton(label: string, ref: WorkspacePathRef, onOpenPath: (ref: WorkspacePathRef) => void, codeStyled = false): HTMLButtonElement {
  return h(
    codeStyled ? 'button.wt-file-link.wt-file-link-code' : 'button.wt-file-link',
    {
      type: 'button',
      'data-path': ref.path,
      'data-line': ref.line,
      'data-end-line': ref.endLine,
      title: ref.line ? `${ref.path}:${ref.endLine ? `${ref.line}-${ref.endLine}` : ref.line}` : ref.path,
      onclick: () => onOpenPath({ ...ref }),
    },
    label,
  );
}

function linkifyWorkspacePaths(root: HTMLElement, onOpenPath: (ref: WorkspacePathRef) => void): void {
  // 1. Inline <code> elements whose entire text is a single workspace path or path:line(-end).
  for (const code of [...root.querySelectorAll('code')]) {
    if (code.closest('pre, a, button, .wt-code-block, .jr-root')) continue;
    if (code.childElementCount > 0) continue;
    const raw = (code.textContent ?? '').trim();
    if (!raw || /\s/.test(raw)) continue;
    const validated = validateWorkspacePathCandidate(raw, true);
    if (!validated) continue;
    code.replaceWith(makeFileLinkButton(raw, validated, onOpenPath, true));
  }

  // 2. Plain text nodes outside links, code blocks, buttons, math, and widgets.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest('a, code, pre, button, math, .wt-code-block, .jr-root') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const textNodes: Text[] = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text);

  for (const textNode of textNodes) {
    const content = textNode.data;
    const refs = parseWorkspacePathRefs(content);
    if (!refs.length) continue;
    const frag = document.createDocumentFragment();
    let cursor = 0;
    for (const ref of refs) {
      if (ref.start > cursor) frag.append(content.slice(cursor, ref.start));
      const cleanRef: WorkspacePathRef = { path: ref.path };
      if (ref.line !== undefined) cleanRef.line = ref.line;
      if (ref.endLine !== undefined) cleanRef.endLine = ref.endLine;
      frag.append(makeFileLinkButton(ref.raw, cleanRef, onOpenPath, false));
      cursor = ref.end;
    }
    if (cursor < content.length) frag.append(content.slice(cursor));
    textNode.replaceWith(frag);
  }
}

// ------------------------------------------------------------------------------------------------
// Shared post-processing: alerts, tables, fenced code blocks, math & <json-render> hydration

const ALERTS: Record<string, string> = {
  NOTE: 'ℹ️ Note',
  TIP: '💡 Tip',
  IMPORTANT: '❗ Important',
  WARNING: '⚠️ Warning',
  CAUTION: '🛑 Caution',
};

function upgradeAlerts(root: HTMLElement): void {
  for (const q of root.querySelectorAll('blockquote')) {
    if (q.closest('.jr-root')) continue;
    const p = q.firstElementChild;
    const m = p?.tagName === 'P' ? /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i.exec(p.textContent ?? '') : null;
    if (!p || !m) continue;
    const kind = m[1].toUpperCase();
    const first = p.firstChild;
    if (first?.nodeType === Node.TEXT_NODE) first.textContent = (first.textContent ?? '').replace(/^\s*\[![A-Za-z]+\]\s*/, '');
    if (p.firstChild?.nodeName === 'BR') p.firstChild.remove();
    if (!p.textContent?.trim() && !p.querySelector('img')) p.remove();
    q.classList.add('alert', kind.toLowerCase());
    q.prepend(h('div.alert-title', {}, ALERTS[kind]));
  }
}

function wrapTables(root: HTMLElement): void {
  for (const table of [...root.querySelectorAll('table')]) {
    if (table.closest('.jr-root, .wt-table-scroll, .wt-code-scroll')) continue;
    const tableScroll = h('div.wt-table-scroll.wt-horizontal-content', { tabindex: 0, 'aria-label': 'Table, scroll horizontally' });
    const cue = h('span.wt-code-cue', { hidden: true }, 'Scroll horizontally ↔');
    const frame = h('div.wt-code-scroll', {}, tableScroll, cue);
    table.replaceWith(frame);
    tableScroll.append(table);
    tableScroll.addEventListener('scroll', () => syncHorizontalScrollCue(frame));
  }
}

function codeFenceLang(codeEl: HTMLElement | null): string {
  if (!codeEl) return '';
  for (const cls of codeEl.classList) {
    if (cls.startsWith('language-')) return cls.slice('language-'.length);
  }
  return '';
}

function upgradeFencedBlocks(root: HTMLElement, richBlocks: boolean): void {
  for (const pre of [...root.querySelectorAll('pre')]) {
    if (pre.closest('.wt-code-block, .jr-root')) continue;
    const codeEl = pre.querySelector('code');
    const rawText = (codeEl?.textContent ?? pre.textContent ?? '').replace(/\n$/, '');
    const lang = codeFenceLang(codeEl).trim();
    const lower = lang.toLowerCase();

    if (richBlocks && lower === 'mermaid') {
      pre.replaceWith(renderThreadMermaid(rawText));
      continue;
    }
    if (richBlocks && lower === 'email') {
      const draft = parseEmailDraft(rawText);
      if (draft) {
        pre.replaceWith(renderEmailCard(draft));
        continue;
      }
    }
    pre.replaceWith(renderCodeFrame(rawText, { lang }));
  }
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
}

/** Renders rich assistant Markdown for Thread view. */
export function threadMarkdown(src: string, opts?: ThreadMarkdownOptions): HTMLElement {
  const root = h('div.md.wt-md');
  if (!src.trim()) return root;

  const { textWithPlaceholders: withoutWidgets, blocks: jsonBlocks } = extractJsonRenderBlocks(src);
  const { textWithPlaceholders: prepared, segments: mathSegments } = extractMathSegments(withoutWidgets);

  const html = md.parse(prepared, { async: false }) as string;
  root.append(sanitizeHtml(html));

  hydrateJsonRenderPlaceholders(root, jsonBlocks, !!opts?.streaming);
  hydrateMathPlaceholders(root, mathSegments);
  upgradeFencedBlocks(root, true);
  upgradeAlerts(root);
  wrapTables(root);
  if (opts?.onOpenPath) linkifyWorkspacePaths(root, opts.onOpenPath);

  return root;
}

/** Renders safe formatted Markdown for user messages in Thread view. */
export function threadUserMarkdown(src: string): HTMLElement {
  const root = h('div.md.wt-md.wt-user-md');
  if (!src.trim()) return root;

  const html = md.parse(src, { async: false }) as string;
  root.append(sanitizeHtml(html));

  upgradeFencedBlocks(root, false);
  upgradeAlerts(root);
  wrapTables(root);

  return root;
}

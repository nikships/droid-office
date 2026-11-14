import { type Child, h } from './dom';

// Safe <json-render> widget parser and renderer for Thread view. Supports all 18 layout, data, and
// display components without inline style attributes, guarding against streaming partial JSON,
// cyclic element graphs, deep nesting, and malformed props.

export const MAX_JSON_RENDER_DEPTH = 32;
const MAX_JSON_RENDER_NODES = 512;
const OPEN_TAG = '<json-render>';
const CLOSE_TAG = '</json-render>';

export interface JsonRenderSegment {
  placeholder: string;
  rawJson: string;
  complete: boolean;
}

export interface JsonRenderElementSpec {
  type: string;
  props: Record<string, unknown>;
  children: string[];
}

export interface JsonRenderTree {
  root: string;
  elements: Record<string, JsonRenderElementSpec>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function uniquePlaceholderPrefix(src: string): string {
  let prefix = 'WTJSONRENDERBLOCK';
  let salt = 0;
  while (src.includes(prefix)) prefix = `WTJSONRENDERBLOCK${++salt}X`;
  return prefix;
}

/** Checks whether line slice starting at `lineStart` opens a CommonMark code fence (optionally inside `>` blockquotes). */
function matchFenceOpen(src: string, lineStart: number, lineEnd: number): { ch: '`' | '~'; len: number } | null {
  let i = lineStart;
  // Skip optional blockquote prefixes (`>`) and up to 3 leading spaces per level.
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
  if (i >= lineEnd) return null;
  const ch = src[i];
  if (ch !== '`' && ch !== '~') return null;
  let len = 0;
  while (i < lineEnd && src[i] === ch) {
    len++;
    i++;
  }
  if (len < 3) return null;
  // Per CommonMark, backtick fences cannot contain backticks in their info string.
  if (ch === '`' && src.slice(i, lineEnd).includes('`')) return null;
  return { ch, len };
}

function isFenceClose(src: string, lineStart: number, lineEnd: number, fence: { ch: '`' | '~'; len: number }): boolean {
  let i = lineStart;
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
  let count = 0;
  while (i < lineEnd && src[i] === fence.ch) {
    count++;
    i++;
  }
  if (count < fence.len) return false;
  while (i < lineEnd && (src[i] === ' ' || src[i] === '\t' || src[i] === '\r')) i++;
  return i === lineEnd;
}

/**
 * Extracts `<json-render>...</json-render>` blocks (and trailing unclosed `<json-render>...` while streaming)
 * from Markdown, skipping fenced code blocks and inline backtick code spans.
 */
export function extractJsonRenderBlocks(markdownText: string): { textWithPlaceholders: string; blocks: JsonRenderSegment[] } {
  if (!markdownText.includes(OPEN_TAG)) return { textWithPlaceholders: markdownText, blocks: [] };

  const prefix = uniquePlaceholderPrefix(markdownText);
  const blocks: JsonRenderSegment[] = [];
  let out = '';
  let i = 0;
  const n = markdownText.length;
  let atLineStart = true;
  let activeFence: { ch: '`' | '~'; len: number } | null = null;

  while (i < n) {
    if (atLineStart) {
      const nl = markdownText.indexOf('\n', i);
      const lineEnd = nl === -1 ? n : nl;
      if (activeFence) {
        if (isFenceClose(markdownText, i, lineEnd, activeFence)) activeFence = null;
        out += markdownText.slice(i, nl === -1 ? n : nl + 1);
        i = nl === -1 ? n : nl + 1;
        atLineStart = true;
        continue;
      }
      const opened = matchFenceOpen(markdownText, i, lineEnd);
      if (opened) {
        activeFence = opened;
        out += markdownText.slice(i, nl === -1 ? n : nl + 1);
        i = nl === -1 ? n : nl + 1;
        atLineStart = true;
        continue;
      }
      atLineStart = false;
    }

    const ch = markdownText[i];
    if (ch === '\n') {
      out += '\n';
      i++;
      atLineStart = true;
      continue;
    }

    // Skip inline code spans (`...`, ``...``, etc.).
    if (ch === '`') {
      let ticks = 0;
      while (i + ticks < n && markdownText[i + ticks] === '`') ticks++;
      let search = i + ticks;
      let matchedEnd = -1;
      while (search < n) {
        const nextTick = markdownText.indexOf('`', search);
        if (nextTick === -1) break;
        let run = 0;
        while (nextTick + run < n && markdownText[nextTick + run] === '`') run++;
        if (run === ticks) {
          matchedEnd = nextTick + run;
          break;
        }
        search = nextTick + run;
      }
      if (matchedEnd !== -1) {
        const span = markdownText.slice(i, matchedEnd);
        out += span;
        atLineStart = span.endsWith('\n');
        i = matchedEnd;
      } else {
        out += markdownText.slice(i, i + ticks);
        i += ticks;
      }
      continue;
    }

    if (ch === '<' && markdownText.startsWith(OPEN_TAG, i)) {
      const contentStart = i + OPEN_TAG.length;
      const closeIdx = markdownText.indexOf(CLOSE_TAG, contentStart);
      const placeholder = `${prefix}${blocks.length}END`;
      if (closeIdx === -1) {
        blocks.push({
          placeholder,
          rawJson: markdownText.slice(contentStart),
          complete: false,
        });
        out += `\n\n${placeholder}\n\n`;
        break;
      }
      blocks.push({
        placeholder,
        rawJson: markdownText.slice(contentStart, closeIdx),
        complete: true,
      });
      out += `\n\n${placeholder}\n\n`;
      i = closeIdx + CLOSE_TAG.length;
      atLineStart = false;
      continue;
    }

    out += ch;
    i++;
  }

  return { textWithPlaceholders: out, blocks };
}

/** Validates and normalizes a closed `<json-render>` JSON payload without touching the DOM. */
export function parseJsonRenderSpec(rawJson: string): JsonRenderTree | null {
  let body = rawJson.trim();
  if (body.startsWith(OPEN_TAG)) {
    if (!body.endsWith(CLOSE_TAG)) return null;
    body = body.slice(OPEN_TAG.length, body.length - CLOSE_TAG.length).trim();
  }
  if (!body) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const root = typeof parsed.root === 'string' ? parsed.root.trim() : '';
  if (!root || !isPlainObject(parsed.elements)) return null;

  const rawElements = parsed.elements;
  const rootEntry = rawElements[root];
  if (!isPlainObject(rootEntry) || typeof rootEntry.type !== 'string' || !rootEntry.type.trim()) return null;

  const elements: Record<string, JsonRenderElementSpec> = {};
  for (const [id, val] of Object.entries(rawElements)) {
    if (!isPlainObject(val) || typeof val.type !== 'string' || !val.type.trim()) continue;
    const props = isPlainObject(val.props) ? val.props : {};
    const children = Array.isArray(val.children) ? val.children.filter((c): c is string => typeof c === 'string' && c.length > 0) : [];
    elements[id] = { type: val.type.trim(), props, children };
  }
  if (!elements[root]) return null;
  return { root, elements };
}

const TONE_MAP: Record<string, { cls: string; cssColor: string }> = {
  accent: { cls: 'jr-tone-accent', cssColor: 'var(--accent)' },
  orange: { cls: 'jr-tone-accent', cssColor: 'var(--accent)' },
  brand: { cls: 'jr-tone-accent', cssColor: 'var(--accent)' },
  success: { cls: 'jr-tone-success', cssColor: 'var(--success, #3ccf91)' },
  good: { cls: 'jr-tone-success', cssColor: 'var(--success, #3ccf91)' },
  green: { cls: 'jr-tone-success', cssColor: 'var(--success, #3ccf91)' },
  ok: { cls: 'jr-tone-success', cssColor: 'var(--success, #3ccf91)' },
  warning: { cls: 'jr-tone-warning', cssColor: 'var(--warning, #f2b84b)' },
  warn: { cls: 'jr-tone-warning', cssColor: 'var(--warning, #f2b84b)' },
  yellow: { cls: 'jr-tone-warning', cssColor: 'var(--warning, #f2b84b)' },
  amber: { cls: 'jr-tone-warning', cssColor: 'var(--warning, #f2b84b)' },
  error: { cls: 'jr-tone-danger', cssColor: 'var(--danger, #ef4444)' },
  danger: { cls: 'jr-tone-danger', cssColor: 'var(--danger, #ef4444)' },
  bad: { cls: 'jr-tone-danger', cssColor: 'var(--danger, #ef4444)' },
  red: { cls: 'jr-tone-danger', cssColor: 'var(--danger, #ef4444)' },
  info: { cls: 'jr-tone-info', cssColor: 'var(--info, #5aa9e6)' },
  blue: { cls: 'jr-tone-info', cssColor: 'var(--info, #5aa9e6)' },
  cyan: { cls: 'jr-tone-info', cssColor: 'var(--info, #5aa9e6)' },
  muted: { cls: 'jr-tone-muted', cssColor: 'var(--text-secondary)' },
  secondary: { cls: 'jr-tone-muted', cssColor: 'var(--text-secondary)' },
  gray: { cls: 'jr-tone-muted', cssColor: 'var(--text-secondary)' },
  grey: { cls: 'jr-tone-muted', cssColor: 'var(--text-secondary)' },
  purple: { cls: 'jr-tone-purple', cssColor: '#c084fc' },
  violet: { cls: 'jr-tone-purple', cssColor: '#c084fc' },
};

const SAFE_COLOR_RE = /^(?:#[0-9a-fA-F]{3,8}|(?:rgb|hsl)a?\(\s*[\d.,%\s/]+\))$/;
const SAFE_WIDTH_RE = /^\d+(?:\.\d+)?(?:px|%|ch|rem|em)$/;

function applyJrColor(el: Element, rawColor: unknown): void {
  if (typeof rawColor !== 'string') return;
  const trimmed = rawColor.trim();
  if (!trimmed) return;
  const tone = TONE_MAP[trimmed.toLowerCase()];
  if (tone) {
    el.classList.add(tone.cls, 'jr-has-color');
    if ('style' in el) (el as HTMLElement).style.setProperty('--jr-color', tone.cssColor);
    return;
  }
  if (SAFE_COLOR_RE.test(trimmed)) {
    el.classList.add('jr-has-color');
    if ('style' in el) (el as HTMLElement).style.setProperty('--jr-color', trimmed);
  }
}

function applySpaceProp(el: HTMLElement, rawVal: unknown, kind: 'pad' | 'gap'): void {
  if (rawVal === undefined || rawVal === null) return;
  if (typeof rawVal === 'string') {
    const lower = rawVal.trim().toLowerCase();
    if (lower === 'none' || lower === '0') el.classList.add(`jr-${kind}-0`);
    else if (lower === 'xs' || lower === 'sm' || lower === 'small') el.classList.add(`jr-${kind}-sm`);
    else if (lower === 'md' || lower === 'medium') el.classList.add(`jr-${kind}-md`);
    else if (lower === 'lg' || lower === 'large' || lower === 'xl') el.classList.add(`jr-${kind}-lg`);
    else if (SAFE_WIDTH_RE.test(lower)) {
      el.classList.add(`jr-has-${kind}`);
      el.style.setProperty(`--jr-${kind}`, lower);
    }
    return;
  }
  if (typeof rawVal === 'number' && Number.isFinite(rawVal) && rawVal >= 0) {
    if (rawVal === 0) {
      el.classList.add(`jr-${kind}-0`);
      return;
    }
    // Small integers 1..6 map to 4px design-system steps; larger numbers up to 64 are pixel lengths.
    const px = rawVal <= 6 ? rawVal * 4 : Math.min(64, Math.round(rawVal));
    el.classList.add(`jr-has-${kind}`);
    el.style.setProperty(`--jr-${kind}`, `${px}px`);
  }
}

function textScalar(val: unknown): string | null {
  if (typeof val === 'string') return val;
  if (typeof val === 'number' && Number.isFinite(val)) return String(val);
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  return null;
}

function formatNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : Number(n.toFixed(2)).toString();
}

function buildLoadingCard(): HTMLElement {
  return h('div.jr-root.wt-json-loading', { role: 'status', 'aria-live': 'polite' }, h('span.spinner', { 'aria-hidden': 'true' }), h('span.wt-json-loading-label', {}, 'Rendering widget…'));
}

function renderBox(props: Record<string, unknown>, childNodes: HTMLElement[]): HTMLElement {
  const dirRaw = typeof props.flexDirection === 'string' ? props.flexDirection.trim().toLowerCase() : 'column';
  const dirCls = dirRaw === 'row' ? 'jr-row' : dirRaw === 'row-reverse' ? 'jr-row-reverse' : dirRaw === 'column-reverse' ? 'jr-col-reverse' : 'jr-col';
  const el = h(`div.jr-box.${dirCls}` as `div.${string}`, {}, ...childNodes);
  applySpaceProp(el, props.padding, 'pad');
  applySpaceProp(el, props.gap, 'gap');
  if (typeof props.borderStyle === 'string') {
    const bs = props.borderStyle.trim().toLowerCase();
    if (bs && bs !== 'none') {
      el.classList.add('jr-border');
      if (bs === 'dashed') el.classList.add('jr-border-dashed');
      else if (bs === 'dotted') el.classList.add('jr-border-dotted');
      else el.classList.add('jr-border-solid');
    }
  }
  return el;
}

function renderText(props: Record<string, unknown>, childNodes: HTMLElement[]): HTMLElement | null {
  const txt = textScalar(props.text);
  if ((txt === null || txt === '') && childNodes.length === 0) return null;
  const el = h(props.bold === true ? 'span.jr-text.jr-bold' : 'span.jr-text', {}, txt, ...childNodes);
  applyJrColor(el, props.color);
  return el;
}

function renderHeading(props: Record<string, unknown>, childNodes: HTMLElement[]): HTMLElement | null {
  const txt = textScalar(props.text);
  if ((txt === null || txt === '') && childNodes.length === 0) return null;
  const rawLevel = typeof props.level === 'number' && Number.isFinite(props.level) ? Math.trunc(props.level) : 3;
  const level = Math.min(6, Math.max(1, rawLevel)) as 1 | 2 | 3 | 4 | 5 | 6;
  const tag = `h${level}` as const;
  return h(`${tag}.jr-heading.jr-h${level}`, {}, txt, ...childNodes);
}

function renderDivider(props: Record<string, unknown>): HTMLElement {
  const title = typeof props.title === 'string' ? props.title.trim() : '';
  if (title) {
    return h('div.jr-divider.has-title', { role: 'separator' }, h('span.jr-divider-line', { 'aria-hidden': 'true' }), h('span.jr-divider-title', {}, title), h('span.jr-divider-line', { 'aria-hidden': 'true' }));
  }
  return h('hr.divider.jr-divider');
}

function renderBarChart(props: Record<string, unknown>): HTMLElement | null {
  if (!Array.isArray(props.data)) return null;
  const items: { label: string; value: number; color?: unknown }[] = [];
  for (const raw of props.data) {
    if (!isPlainObject(raw)) continue;
    const label = textScalar(raw.label);
    const value = typeof raw.value === 'number' && Number.isFinite(raw.value) ? raw.value : null;
    if (label === null || value === null) continue;
    items.push({ label, value, color: raw.color });
  }
  if (!items.length) return null;

  const max = Math.max(...items.map((d) => Math.max(0, d.value)), 0);
  const total = items.reduce((sum, d) => sum + Math.max(0, d.value), 0);
  const showPct = props.showPercentage === true;

  const rows = items.map((item) => {
    const clamped = Math.max(0, item.value);
    const widthPct = max > 0 ? (clamped / max) * 100 : 0;
    const sharePct = total > 0 ? Math.round((clamped / total) * 100) : 0;
    const fill = h('div.jr-bar-fill');
    fill.style.setProperty('--pct', `${widthPct.toFixed(2)}%`);
    applyJrColor(fill, item.color);

    let valueLabel = formatNumber(item.value);
    if (showPct) {
      if (Math.abs(total - 100) < 0.5 || (items.length === 1 && clamped <= 100)) valueLabel = `${Math.round(clamped)}%`;
      else valueLabel = `${formatNumber(item.value)} (${sharePct}%)`;
    }
    return h('div.jr-bar-row', {}, h('span.jr-bar-label', { title: item.label }, item.label), h('div.jr-bar-track', {}, fill), h('span.jr-bar-value', {}, valueLabel));
  });

  return h('div.jr-bar-chart', { role: 'group' }, ...rows);
}

function renderSparkline(props: Record<string, unknown>): HTMLElement | null {
  if (!Array.isArray(props.data)) return null;
  const nums = props.data.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (!nums.length) return null;

  const width = 120;
  const height = 32;
  const pad = 3;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min;

  const coords = nums.map((v, idx) => {
    const x = nums.length === 1 ? width / 2 : pad + (idx / (nums.length - 1)) * (width - pad * 2);
    const y = span === 0 ? height / 2 : height - pad - ((v - min) / span) * (height - pad * 2);
    return [Number(x.toFixed(2)), Number(y.toFixed(2))] as const;
  });

  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('class', 'jr-sparkline-svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Sparkline from ${formatNumber(nums[0])} to ${formatNumber(nums[nums.length - 1])} (min ${formatNumber(min)}, max ${formatNumber(max)})`);

  if (coords.length >= 2) {
    const polyPoints = coords.map(([x, y]) => `${x},${y}`).join(' ');
    const area = document.createElementNS(ns, 'polygon');
    area.setAttribute('class', 'jr-sparkline-area');
    area.setAttribute('points', `${coords[0][0]},${height - pad} ${polyPoints} ${coords[coords.length - 1][0]},${height - pad}`);
    svg.append(area);

    const line = document.createElementNS(ns, 'polyline');
    line.setAttribute('class', 'jr-sparkline-line');
    line.setAttribute('fill', 'none');
    line.setAttribute('points', polyPoints);
    svg.append(line);
  } else {
    const flat = document.createElementNS(ns, 'line');
    flat.setAttribute('class', 'jr-sparkline-line');
    flat.setAttribute('x1', String(pad));
    flat.setAttribute('y1', String(height / 2));
    flat.setAttribute('x2', String(width - pad));
    flat.setAttribute('y2', String(height / 2));
    svg.append(flat);
  }

  const last = coords[coords.length - 1];
  const dot = document.createElementNS(ns, 'circle');
  dot.setAttribute('class', 'jr-sparkline-dot');
  dot.setAttribute('cx', String(last[0]));
  dot.setAttribute('cy', String(last[1]));
  dot.setAttribute('r', '2.25');
  svg.append(dot);

  const wrap = h('div.jr-sparkline', {}, svg);
  applyJrColor(wrap, props.color);
  return wrap;
}

function renderTable(props: Record<string, unknown>): HTMLElement | null {
  if (!Array.isArray(props.columns) || !Array.isArray(props.rows)) return null;
  const cols: { header: string; key: string; width?: unknown }[] = [];
  for (const rawCol of props.columns) {
    if (!isPlainObject(rawCol) || typeof rawCol.key !== 'string' || !rawCol.key.trim()) continue;
    const key = rawCol.key.trim();
    const header = textScalar(rawCol.header) ?? key;
    cols.push({ header, key, width: rawCol.width });
  }
  if (!cols.length) return null;

  const headCells = cols.map((col) => {
    const th = h('th.jr-th', { scope: 'col' }, col.header);
    if (typeof col.width === 'number' && Number.isFinite(col.width) && col.width > 0) {
      th.classList.add('jr-has-col-w');
      th.style.setProperty('--col-w', `${Math.round(col.width)}px`);
    } else if (typeof col.width === 'string' && SAFE_WIDTH_RE.test(col.width.trim())) {
      th.classList.add('jr-has-col-w');
      th.style.setProperty('--col-w', col.width.trim());
    }
    return th;
  });

  const thead = h('thead.jr-thead', {}, h('tr.jr-tr', {}, ...headCells));
  applyJrColor(thead, props.headerColor);

  const bodyRows: HTMLElement[] = [];
  for (const rawRow of props.rows) {
    if (!isPlainObject(rawRow)) continue;
    const cells = cols.map((col) => {
      const val = rawRow[col.key];
      const text = textScalar(val) ?? (val === null || val === undefined ? '' : JSON.stringify(val));
      return h('td.jr-td', {}, text);
    });
    bodyRows.push(h('tr.jr-tr', {}, ...cells));
  }

  return h('div.jr-table-wrap', {}, h('table.jr-table', {}, thead, h('tbody.jr-tbody', {}, ...bodyRows)));
}

function renderList(props: Record<string, unknown>): HTMLElement | null {
  if (!Array.isArray(props.items)) return null;
  const items: string[] = [];
  for (const raw of props.items) {
    const txt = textScalar(raw);
    if (txt !== null) items.push(txt);
  }
  if (!items.length) return null;
  const ordered = props.ordered === true;
  return h(ordered ? 'ol.jr-list.jr-list-ordered' : 'ul.jr-list', {}, ...items.map((item) => h('li.jr-list-item', {}, item)));
}

function renderCard(props: Record<string, unknown>, childNodes: HTMLElement[]): HTMLElement | null {
  const title = typeof props.title === 'string' ? props.title.trim() : '';
  if (!title && childNodes.length === 0) return null;
  const card = h('div.jr-card', {}, title ? h('div.jr-card-head', {}, h('span.jr-card-title', {}, title)) : null, h('div.jr-card-body', {}, ...childNodes));
  applySpaceProp(card, props.padding, 'pad');
  return card;
}

function renderStatusLine(props: Record<string, unknown>): HTMLElement | null {
  const text = textScalar(props.text);
  if (text === null || !text.trim()) return null;
  const rawStatus = typeof props.status === 'string' ? props.status.trim().toLowerCase() : 'info';
  const status = rawStatus === 'success' || rawStatus === 'error' || rawStatus === 'warning' || rawStatus === 'info' ? rawStatus : 'info';
  return h(`div.jr-status-line.is-${status}` as `div.${string}`, {}, h('span.jr-status-dot', { 'aria-hidden': 'true' }), h('span.jr-status-text', {}, text));
}

function renderKeyValue(props: Record<string, unknown>): HTMLElement | null {
  const label = textScalar(props.label);
  if (label === null || !label.trim()) return null;
  const value = textScalar(props.value) ?? '';
  return h('div.jr-kv', {}, h('span.jr-kv-label', {}, label), h('span.jr-kv-value', {}, value));
}

function renderBadge(props: Record<string, unknown>): HTMLElement | null {
  const label = textScalar(props.label) ?? textScalar(props.text);
  if (label === null || !label.trim()) return null;
  const rawVariant = typeof props.variant === 'string' ? props.variant.trim().toLowerCase() : 'default';
  const variantMap: Record<string, string> = {
    default: 'default',
    neutral: 'default',
    muted: 'muted',
    secondary: 'muted',
    success: 'success',
    good: 'success',
    ok: 'success',
    warning: 'warning',
    warn: 'warning',
    error: 'danger',
    danger: 'danger',
    bad: 'danger',
    info: 'info',
    accent: 'accent',
    primary: 'accent',
  };
  const variant = variantMap[rawVariant] ?? 'default';
  return h(`span.pill.jr-badge.jr-badge-${variant}` as `span.${string}`, {}, label);
}

function renderProgressBar(props: Record<string, unknown>): HTMLElement | null {
  if (typeof props.progress !== 'number' || !Number.isFinite(props.progress)) return null;
  const ratio = Math.min(1, Math.max(0, props.progress));
  const pct = ratio * 100;
  const label = textScalar(props.label);
  const rounded = Math.round(pct);

  const fill = h('div.jr-progress-fill');
  fill.style.setProperty('--pct', `${pct.toFixed(2)}%`);

  const track = h(
    'div.jr-progress-track',
    {
      role: 'progressbar',
      'aria-valuemin': 0,
      'aria-valuemax': 100,
      'aria-valuenow': rounded,
      'aria-label': label?.trim() ? label : 'Progress',
    },
    fill,
  );

  const head: Child = label?.trim() ? h('div.jr-progress-head', {}, h('span.jr-progress-label', {}, label), h('span.jr-progress-pct', {}, `${rounded}%`)) : h('div.jr-progress-head', {}, h('span.jr-progress-pct', {}, `${rounded}%`));

  const wrap = h('div.jr-progress', {}, head, track);
  if (typeof props.width === 'number' && Number.isFinite(props.width) && props.width > 0) {
    wrap.classList.add('jr-has-width');
    wrap.style.setProperty('--jr-width', `${Math.round(props.width)}px`);
  } else if (typeof props.width === 'string' && SAFE_WIDTH_RE.test(props.width.trim())) {
    wrap.classList.add('jr-has-width');
    wrap.style.setProperty('--jr-width', props.width.trim());
  }
  return wrap;
}

function renderMetric(props: Record<string, unknown>): HTMLElement | null {
  const label = textScalar(props.label);
  const value = textScalar(props.value);
  if ((label === null || !label.trim()) && (value === null || !value.trim())) return null;
  const rawTrend = typeof props.trend === 'string' ? props.trend.trim().toLowerCase() : '';
  const trendNode =
    rawTrend === 'up'
      ? h('span.jr-metric-trend.is-up', { 'aria-label': 'Trend up' }, '↑')
      : rawTrend === 'down'
        ? h('span.jr-metric-trend.is-down', { 'aria-label': 'Trend down' }, '↓')
        : rawTrend === 'flat' || rawTrend === 'neutral'
          ? h('span.jr-metric-trend.is-flat', { 'aria-label': 'Trend flat' }, '→')
          : null;

  return h('div.jr-metric', {}, label ? h('span.jr-metric-label', {}, label) : null, h('div.jr-metric-main', {}, value !== null ? h('span.jr-metric-value', {}, value) : null, trendNode));
}

function renderCallout(props: Record<string, unknown>, childNodes: HTMLElement[]): HTMLElement | null {
  const title = textScalar(props.title);
  const content = textScalar(props.content);
  if (!title && !content && childNodes.length === 0) return null;
  const rawType = typeof props.type === 'string' ? props.type.trim().toLowerCase() : 'info';
  const toneMap: Record<string, { kit: string; jr: string }> = {
    info: { kit: 'info', jr: 'info' },
    note: { kit: 'info', jr: 'info' },
    tip: { kit: 'good', jr: 'success' },
    success: { kit: 'good', jr: 'success' },
    good: { kit: 'good', jr: 'success' },
    warning: { kit: 'warn', jr: 'warning' },
    warn: { kit: 'warn', jr: 'warning' },
    caution: { kit: 'bad', jr: 'danger' },
    error: { kit: 'bad', jr: 'danger' },
    danger: { kit: 'bad', jr: 'danger' },
    bad: { kit: 'bad', jr: 'danger' },
  };
  const tone = toneMap[rawType] ?? toneMap.info;
  return h(`div.jr-callout.note.${tone.kit}.jr-callout-${tone.jr}` as `div.${string}`, {}, title ? h('b.jr-callout-title', {}, title) : null, content ? h('p.jr-callout-body', {}, content) : null, ...childNodes);
}

function renderTimeline(props: Record<string, unknown>): HTMLElement | null {
  if (!Array.isArray(props.items)) return null;
  const rows: HTMLElement[] = [];
  for (const raw of props.items) {
    if (!isPlainObject(raw)) continue;
    const title = textScalar(raw.title);
    if (!title?.trim()) continue;
    const desc = textScalar(raw.description);
    const rawStatus = typeof raw.status === 'string' ? raw.status.trim().toLowerCase() : 'pending';
    const status =
      rawStatus === 'completed' || rawStatus === 'done' || rawStatus === 'success'
        ? 'done'
        : rawStatus === 'in_progress' || rawStatus === 'active' || rawStatus === 'working' || rawStatus === 'current'
          ? 'active'
          : rawStatus === 'error' || rawStatus === 'failed'
            ? 'error'
            : 'pending';
    rows.push(
      h(`li.jr-timeline-item.is-${status}` as `li.${string}`, {}, h('span.jr-timeline-dot', { 'aria-hidden': 'true' }), h('div.jr-timeline-content', {}, h('b.jr-timeline-title', {}, title), desc ? h('p.jr-timeline-desc', {}, desc) : null)),
    );
  }
  if (!rows.length) return null;
  return h('ol.jr-timeline', {}, ...rows);
}

/**
 * Renders a `<json-render>` JSON payload into a `.jr-root` DOM subtree.
 * When `streaming` is true (or an unclosed `<json-render>` is passed), incomplete JSON renders a quiet loading card.
 */
export function renderJsonWidget(rawJson: string, streaming = false): HTMLElement | null {
  const trimmed = rawJson.trim();
  if (trimmed.startsWith(OPEN_TAG) && !trimmed.endsWith(CLOSE_TAG)) return buildLoadingCard();

  const tree = parseJsonRenderSpec(trimmed);
  if (!tree) return streaming ? buildLoadingCard() : null;

  const visited = new Set<string>();
  let nodeBudget = MAX_JSON_RENDER_NODES;

  const renderNode = (id: string, depth: number): HTMLElement | null => {
    if (depth > MAX_JSON_RENDER_DEPTH || nodeBudget <= 0) return null;
    if (visited.has(id)) return null;
    const spec = tree.elements[id];
    if (!spec) return null;
    visited.add(id);
    nodeBudget--;

    const childNodes: HTMLElement[] = [];
    for (const childId of spec.children) {
      const childEl = renderNode(childId, depth + 1);
      if (childEl) childNodes.push(childEl);
    }

    switch (spec.type) {
      case 'Box':
        return renderBox(spec.props, childNodes);
      case 'Text':
        return renderText(spec.props, childNodes);
      case 'Heading':
        return renderHeading(spec.props, childNodes);
      case 'Divider':
        return renderDivider(spec.props);
      case 'Newline':
        return h('div.jr-newline', { 'aria-hidden': 'true' });
      case 'Spacer':
        return h('div.jr-spacer', { 'aria-hidden': 'true' });
      case 'BarChart':
        return renderBarChart(spec.props);
      case 'Sparkline':
        return renderSparkline(spec.props);
      case 'Table':
        return renderTable(spec.props);
      case 'List':
        return renderList(spec.props);
      case 'Card':
        return renderCard(spec.props, childNodes);
      case 'StatusLine':
        return renderStatusLine(spec.props);
      case 'KeyValue':
        return renderKeyValue(spec.props);
      case 'Badge':
        return renderBadge(spec.props);
      case 'ProgressBar':
        return renderProgressBar(spec.props);
      case 'Metric':
        return renderMetric(spec.props);
      case 'Callout':
        return renderCallout(spec.props, childNodes);
      case 'Timeline':
        return renderTimeline(spec.props);
      default:
        return childNodes.length ? h('div.jr-box.jr-col', {}, ...childNodes) : null;
    }
  };

  const rootNode = renderNode(tree.root, 0);
  if (!rootNode) return null;
  return h('div.jr-root', {}, rootNode);
}

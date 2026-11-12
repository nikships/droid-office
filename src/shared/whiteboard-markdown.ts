// Factory-styled Whiteboard artifact builders for GitHub-Flavored Markdown, Video, and Image cards,
// plus relative asset discovery and video timecode parsing. Pure ES2022 so server and client share
// identical rendering and sanitization without extra runtime dependencies.

import { FACTORY_ARTIFACT_CSS, FACTORY_ROTOR_INLINE_SVG, type DesignTheme } from './whiteboard-design.js';

export interface ArtifactAction {
  action: string;
  label: string;
  ping?: string;
  primary?: boolean;
}

export interface MarkdownArtifactOptions {
  title: string;
  theme?: DesignTheme;
  actions?: readonly ArtifactAction[];
}

export interface VideoArtifactOptions {
  title: string;
  videoSrc: string;
  videoMime: string;
  posterSrc?: string;
  caption?: string;
  sizeBytes?: number;
  theme?: DesignTheme;
}

export interface ImageArtifactOptions {
  title: string;
  imageSrc: string;
  imageMime: string;
  width?: number;
  height?: number;
  sizeBytes?: number;
  caption?: string;
  theme?: DesignTheme;
}

export interface TimecodePart {
  kind: 'text' | 'timecode';
  text: string;
  seconds?: number;
}

const ALERT_LABELS: Record<string, { tag: string; cls: string }> = {
  NOTE: { tag: 'NOTE', cls: 'note' },
  TIP: { tag: 'TIP', cls: 'tip' },
  IMPORTANT: { tag: 'IMPORTANT', cls: 'important' },
  WARNING: { tag: 'WARN', cls: 'warning' },
  CAUTION: { tag: 'ERR', cls: 'caution' },
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch);
}

/** Safe URL attribute for Markdown links and media: blocks script/data-html injection while keeping relative paths and standard schemes. */
function safeHref(raw: string, allowDataImage = false): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const controlFree = trimmed.replace(/[\u0000-\u001f\u007f]+/g, '');
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(controlFree);
  if (!scheme) return controlFree;
  const proto = scheme[1].toLowerCase();
  if (proto === 'http' || proto === 'https' || proto === 'mailto') return controlFree;
  if (allowDataImage && proto === 'data' && /^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(controlFree)) return controlFree;
  return undefined;
}

function slugify(text: string): string {
  const base = text
    .toLowerCase()
    .replace(/`[^`]*`/g, (m) => m.slice(1, -1))
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base || 'section';
}

function humanBytes(n?: number): string {
  if (n === undefined || !(n >= 0)) return '';
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${n} B`;
}

/** First ATX `# Heading` in Markdown, stripped of inline formatting, for default card titles. */
export function extractMarkdownTitle(markdown: string): string | undefined {
  const withoutFrontmatter = stripFrontmatter(markdown).body;
  for (const line of withoutFrontmatter.split(/\r?\n/)) {
    const m = /^\s*#\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      return m[1]
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/[*_~`]+/g, '')
        .trim()
        .slice(0, 120);
    }
  }
  return undefined;
}

/** Relative image/media paths referenced in Markdown (`![alt](path)` and reference-style definitions), excluding fenced code blocks. */
export function markdownReferences(markdown: string): string[] {
  const out: string[] = [];
  const { body } = stripFrontmatter(markdown);
  const lines = body.split(/\r?\n/);
  let fence: string | null = null;
  const defs = new Map<string, string>();
  const stripped: string[] = [];
  for (const line of lines) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const def = /^\s*\[([^\]]+)\]:\s*<?([^\s>]+)>?/.exec(line);
    if (def) defs.set(def[1].trim().toLowerCase(), def[2].trim());
    stripped.push(line);
  }
  const prose = stripped.join('\n').replace(/`[^`\n]+`/g, '');
  for (const m of prose.matchAll(/!\[[^\]]*\]\(\s*(?:<([^>\n]+)>|([^\s)\n]+))(?:\s+["'][^"'\n]*["'])?\s*\)/g)) {
    const ref = (m[1] ?? m[2] ?? '').trim();
    if (ref) out.push(ref);
  }
  for (const m of prose.matchAll(/!\[[^\]]*\]\[([^\]]+)\]/g)) {
    const target = defs.get(m[1].trim().toLowerCase());
    if (target) out.push(target);
  }
  return out;
}

function stripFrontmatter(src: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { meta: {}, body: src };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.+)$/.exec(line.trim());
    if (kv) meta[kv[1].toLowerCase()] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return { meta, body: src.slice(m[0].length) };
}

function parseInline(raw: string, defs: ReadonlyMap<string, { url: string; title?: string }>, nextImgId: () => string): string {
  const codes: string[] = [];
  const withCodeTokens = raw.replace(/(`+)([\s\S]*?)\1/g, (_all, _ticks: string, code: string) => {
    const idx = codes.push(`<code>${escapeHtml(code.replace(/^ (.*) $/, '$1'))}</code>`) - 1;
    return `\u0000C${idx}\u0000`;
  });

  const media: string[] = [];
  const stash = (html: string) => `\u0000M${media.push(html) - 1}\u0000`;

  let s = withCodeTokens.replace(/!\[([^\]]*)\]\(\s*(?:<([^>\n]+)>|([^\s)\n]+))(?:\s+"([^"\n]*)"|\s+'([^'\n]*)')?\s*\)/g, (_all, alt: string, u1?: string, u2?: string, t1?: string, t2?: string) => {
    const url = safeHref(u1 ?? u2 ?? '', true);
    if (!url) return escapeHtml(alt);
    const title = t1 ?? t2;
    return stash(`<img data-wb-id="${nextImgId()}" src="${escapeHtml(url)}" alt="${escapeHtml(alt)}"${title ? ` title="${escapeHtml(title)}"` : ''} loading="lazy">`);
  });

  s = s.replace(/!\[([^\]]*)\]\[([^\]]+)\]/g, (_all, alt: string, key: string) => {
    const def = defs.get(key.trim().toLowerCase());
    const url = def ? safeHref(def.url, true) : undefined;
    if (!url) return escapeHtml(_all);
    return stash(`<img data-wb-id="${nextImgId()}" src="${escapeHtml(url)}" alt="${escapeHtml(alt)}"${def?.title ? ` title="${escapeHtml(def.title)}"` : ''} loading="lazy">`);
  });

  s = s.replace(/\[([^\]]+)\]\(\s*(?:<([^>\n]+)>|([^\s)\n]+))(?:\s+"([^"\n]*)"|\s+'([^'\n]*)')?\s*\)/g, (_all, label: string, u1?: string, u2?: string, t1?: string, t2?: string) => {
    const url = safeHref(u1 ?? u2 ?? '');
    const inner = formatEmphasis(escapeHtml(label));
    if (!url) return inner;
    const ext = /^https?:\/\//i.test(url);
    const title = t1 ?? t2;
    return stash(`<a href="${escapeHtml(url)}"${title ? ` title="${escapeHtml(title)}"` : ''}${ext ? ' target="_blank" rel="noopener noreferrer"' : ''}>${inner}</a>`);
  });

  s = s.replace(/\[([^\]]+)\]\[([^\]]+)\]/g, (_all, label: string, key: string) => {
    const def = defs.get(key.trim().toLowerCase());
    const url = def ? safeHref(def.url) : undefined;
    if (!url) return escapeHtml(_all);
    const ext = /^https?:\/\//i.test(url);
    return stash(`<a href="${escapeHtml(url)}"${def?.title ? ` title="${escapeHtml(def.title)}"` : ''}${ext ? ' target="_blank" rel="noopener noreferrer"' : ''}>${formatEmphasis(escapeHtml(label))}</a>`);
  });

  s = s.replace(/<(https?:\/\/[^\s<>]+)>/gi, (_all, url: string) => {
    const safe = safeHref(url);
    return safe ? stash(`<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${escapeHtml(safe)}</a>`) : escapeHtml(_all);
  });

  s = formatEmphasis(escapeHtml(s));
  s = s.replace(/\u0000M(\d+)\u0000/g, (_all, idx: string) => media[Number(idx)] ?? '');
  s = s.replace(/\u0000C(\d+)\u0000/g, (_all, idx: string) => codes[Number(idx)] ?? '');
  return s;
}

function formatEmphasis(escaped: string): string {
  return escaped
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
    .replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/__(?=\S)([\s\S]*?\S)__/g, '<strong>$1</strong>')
    .replace(/(^|[\s([{"'])_(?=\S)([^_\n]*?\S)_(?=$|[\s.,!?:;)\]}"'])/g, '$1<em>$2</em>')
    .replace(/(^|[^*])\*(?=\S)([^*\n]*?\S)\*(?!\*)/g, '$1<em>$2</em>');
}

function splitTableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === '\\' && trimmed[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (trimmed[i] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += trimmed[i];
  }
  cells.push(cur.trim());
  return cells;
}

function isTableRule(line: string, cols: number): ('left' | 'center' | 'right' | null)[] | null {
  if (!line.includes('|') && cols < 2) return null;
  const cells = splitTableCells(line);
  if (cells.length !== cols) return null;
  const aligns: ('left' | 'center' | 'right' | null)[] = [];
  for (const c of cells) {
    if (!/^:?-{3,}:?$/.test(c)) return null;
    if (c.startsWith(':') && c.endsWith(':')) aligns.push('center');
    else if (c.endsWith(':')) aligns.push('right');
    else if (c.startsWith(':')) aligns.push('left');
    else aligns.push(null);
  }
  return aligns;
}

function parseWbActionsFence(text: string): ArtifactAction[] {
  try {
    const parsed = JSON.parse(text);
    const items = Array.isArray(parsed) ? parsed : [];
    return items.flatMap((x) => {
      if (!x || typeof x !== 'object') return [];
      const o = x as Record<string, unknown>;
      const action = typeof o.action === 'string' ? o.action.trim() : '';
      const label = typeof o.label === 'string' ? o.label.trim() : '';
      if (!action || !label) return [];
      return [{ action, label, ...(typeof o.ping === 'string' && o.ping.trim() ? { ping: o.ping.trim() } : {}), ...(o.primary === true ? { primary: true } : {}) }];
    });
  } catch {
    return [];
  }
}

function renderActionButtons(actions: readonly ArtifactAction[], idPrefix: string): string {
  if (!actions.length) return '';
  const btns = actions
    .map((a, idx) => {
      const cls = a.primary || (idx === 0 && !actions.some((x) => x.primary)) ? 'wb-btn primary' : 'wb-btn';
      const label = a.primary && !a.label.endsWith('→') ? `${a.label} →` : a.label;
      const ping = a.ping ? ` data-wb-ping="${escapeHtml(a.ping)}"` : '';
      return `<button type="button" class="${cls}" data-wb-id="${escapeHtml(`${idPrefix}-${slugify(a.action)}`)}" data-wb-action="${escapeHtml(a.action)}"${ping}>${escapeHtml(label)}</button>`;
    })
    .join('\n      ');
  return `<div class="md-actions" data-wb-id="${escapeHtml(idPrefix)}">\n      <div class="wb-eyebrow"><span class="wb-idx">ACT</span> DECISION</div>\n      <div class="md-actions-row">\n      ${btns}\n      </div>\n    </div>`;
}

/**
 * Renders GitHub-Flavored Markdown into a complete 1280px Factory-designed HTML artifact.
 * Headings, tables, tasks, callouts, images, and code blocks carry deterministic `data-wb-id` anchors.
 */
export function renderMarkdownArtifact(markdown: string, opts: MarkdownArtifactOptions): string {
  const theme: DesignTheme = opts.theme === 'light' ? 'light' : 'dark';
  const { meta, body } = stripFrontmatter(markdown);
  const effectiveTheme: DesignTheme = meta.theme === 'light' ? 'light' : meta.theme === 'dark' ? 'dark' : theme;
  const rawLines = body.replace(/\r\n/g, '\n').split('\n');

  const defs = new Map<string, { url: string; title?: string }>();
  const lines: string[] = [];
  let inFence: string | null = null;
  for (const line of rawLines) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!inFence) inFence = f[1][0];
      else if (f[1][0] === inFence) inFence = null;
      lines.push(line);
      continue;
    }
    if (!inFence) {
      const def = /^\s*\[([^\]]+)\]:\s*<?([^\s>]+)>?(?:\s+["']([^"'\n]*)["'])?\s*$/.exec(line);
      if (def) {
        defs.set(def[1].trim().toLowerCase(), { url: def[2].trim(), ...(def[3] ? { title: def[3] } : {}) });
        continue;
      }
    }
    lines.push(line);
  }

  const usedIds = new Map<string, number>();
  const uniqueId = (prefix: string, raw: string) => {
    const base = `${prefix}-${slugify(raw)}`;
    const count = (usedIds.get(base) ?? 0) + 1;
    usedIds.set(base, count);
    return count === 1 ? base : `${base}-${count}`;
  };

  let imgSeq = 0;
  let codeSeq = 0;
  let tableSeq = 0;
  let taskSeq = 0;
  let pSeq = 0;
  let h2Seq = 0;
  let actionSeq = 0;
  const nextImgId = () => `img-${++imgSeq}`;
  const inline = (s: string) => parseInline(s, defs, nextImgId);

  const toc: { id: string; num: string; label: string }[] = [];
  const blocks: string[] = [];

  const parseBlocks = (srcLines: string[], nested = false): string => {
    const out: string[] = [];
    let i = 0;
    while (i < srcLines.length) {
      const line = srcLines[i];
      if (!line.trim()) {
        i++;
        continue;
      }

      // Fenced code block
      const fenceMatch = /^(\s*)(`{3,}|~{3,})([^\n]*)$/.exec(line);
      if (fenceMatch) {
        const marker = fenceMatch[2];
        const info = fenceMatch[3].trim().split(/\s+/)[0]?.toLowerCase() ?? '';
        const buf: string[] = [];
        i++;
        while (i < srcLines.length && !new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`).test(srcLines[i])) {
          buf.push(srcLines[i]);
          i++;
        }
        if (i < srcLines.length) i++;
        if (info === 'wb-actions') {
          const parsed = parseWbActionsFence(buf.join('\n'));
          if (parsed.length) out.push(renderActionButtons(parsed, `actions-${++actionSeq}`));
          continue;
        }
        const cid = `code-${++codeSeq}`;
        const lang = info ? escapeHtml(info) : 'CODE';
        out.push(
          `<div class="md-code" data-wb-id="${cid}">` +
            `<div class="md-code-bar"><span class="md-code-lang">${lang}</span><button type="button" class="wb-btn sm md-copy" data-wb-ignore>COPY</button></div>` +
            `<pre><code>${escapeHtml(buf.join('\n'))}</code></pre>` +
            `</div>`,
        );
        continue;
      }

      // Horizontal rule
      if (/^\s*(?:-\s*){3,}$|^\s*(?:\*\s*){3,}$|^\s*(?:_\s*){3,}$/.test(line)) {
        out.push('<hr class="wb-rule">');
        i++;
        continue;
      }

      // ATX Heading
      const heading = /^\s*(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (heading) {
        const level = heading[1].length;
        const rawText = heading[2].trim();
        const plain = rawText
          .replace(/[*_~`]+/g, '')
          .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
          .trim();
        const id = uniqueId('sec', plain);
        if (level === 2 && !nested) {
          h2Seq++;
          const num = String(h2Seq).padStart(2, '0');
          const clean = rawText.replace(/^\d+[.)]\s+/, '');
          toc.push({ id, num, label: plain.replace(/^\d+[.)]\s+/, '') });
          out.push(`<div class="md-h2-block" id="${escapeHtml(id)}" data-wb-id="${escapeHtml(id)}"><div class="wb-eyebrow"><span class="wb-idx">${num}</span> SECTION</div><h2>${inline(clean)}</h2></div>`);
        } else {
          out.push(`<h${level} id="${escapeHtml(id)}" data-wb-id="${escapeHtml(id)}">${inline(rawText)}</h${level}>`);
        }
        i++;
        continue;
      }

      // GFM Table
      if (i + 1 < srcLines.length && line.includes('|')) {
        const headers = splitTableCells(line);
        const aligns = headers.length >= 1 ? isTableRule(srcLines[i + 1], headers.length) : null;
        if (aligns) {
          const tid = `table-${++tableSeq}`;
          i += 2;
          const rows: string[][] = [];
          while (i < srcLines.length && srcLines[i].trim() && srcLines[i].includes('|') && !/^\s*(?:#|>|`{3,}|~{3,})/.test(srcLines[i])) {
            const cells = splitTableCells(srcLines[i]);
            while (cells.length < headers.length) cells.push('');
            rows.push(cells.slice(0, headers.length));
            i++;
          }
          const alignAttr = (col: number) => (aligns[col] ? ` style="text-align:${aligns[col]}"` : '');
          const ths = headers.map((h, c) => `<th${alignAttr(c)}>${inline(h)}</th>`).join('');
          const trs = rows.map((r, rIdx) => `<tr data-wb-id="${tid}-r${rIdx + 1}">${r.map((cell, c) => `<td${alignAttr(c)}>${inline(cell)}</td>`).join('')}</tr>`).join('');
          out.push(`<div class="md-table-wrap" data-wb-id="${tid}"><table class="wb-table"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>`);
          continue;
        }
      }

      // Blockquote & GitHub Alerts
      if (/^\s*>\s?/.test(line)) {
        const qLines: string[] = [];
        while (i < srcLines.length && (/^\s*>\s?/.test(srcLines[i]) || (srcLines[i].trim() && qLines.length > 0 && !/^\s*(?:#|`{3,}|~{3,}|[-*+]\s|\d+\.\s)/.test(srcLines[i])))) {
          qLines.push(srcLines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        const alertMatch = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i.exec(qLines[0] ?? '') ?? /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s+(.*)$/i.exec(qLines[0] ?? '');
        if (alertMatch) {
          const kind = alertMatch[1].toUpperCase();
          const spec = ALERT_LABELS[kind] ?? ALERT_LABELS.NOTE;
          const rest = alertMatch[2] ? [alertMatch[2], ...qLines.slice(1)] : qLines.slice(1);
          const qid = uniqueId('callout', `${spec.cls}-${rest[0] ?? kind}`);
          out.push(`<aside class="wb-callout ${spec.cls}" data-wb-id="${escapeHtml(qid)}"><div class="wb-callout-tag">${spec.tag}</div><div class="md-callout-body">${parseBlocks(rest, true)}</div></aside>`);
        } else {
          const qid = uniqueId('quote', qLines[0] ?? 'quote');
          out.push(`<blockquote class="md-quote" data-wb-id="${escapeHtml(qid)}">${parseBlocks(qLines, true)}</blockquote>`);
        }
        continue;
      }

      // Lists (unordered, ordered, interactive task lists)
      const listMatch = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (listMatch) {
        const baseIndent = listMatch[1].length;
        const ordered = /\d/.test(listMatch[2][0]);
        const startNum = ordered ? Number.parseInt(listMatch[2], 10) : 1;
        const items: { content: string[]; sub: string[] }[] = [];
        while (i < srcLines.length) {
          const cur = srcLines[i];
          if (!cur.trim()) {
            if (i + 1 < srcLines.length && /^(\s*)([-*+]|\d+[.)])\s+/.test(srcLines[i + 1])) {
              i++;
              continue;
            }
            break;
          }
          const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(cur);
          if (m && m[1].length === baseIndent && /\d/.test(m[2][0]) === ordered) {
            items.push({ content: [m[3]], sub: [] });
            i++;
          } else if (m && m[1].length > baseIndent && items.length) {
            items.at(-1)!.sub.push(cur.slice(Math.min(cur.length, baseIndent + 2)));
            i++;
          } else if (/^\s{2,}/.test(cur) && items.length) {
            items.at(-1)!.sub.push(cur.slice(Math.min(cur.length, baseIndent + 2)));
            i++;
          } else break;
        }
        const lis = items
          .map((item) => {
            const first = item.content[0] ?? '';
            const task = /^\[([ xX])\]\s+(.*)$/.exec(first);
            const subHtml = item.sub.length ? parseBlocks(item.sub, true) : '';
            if (task) {
              const n = ++taskSeq;
              const checked = task[1].toLowerCase() === 'x' ? ' checked' : '';
              const tid = `task-${n}`;
              return `<li class="md-task-item" data-wb-id="${tid}"><label class="md-task-label"><input type="checkbox" name="${tid}"${checked}><span>${inline(task[2])}</span></label>${subHtml}</li>`;
            }
            return `<li>${inline(item.content.join(' '))}${subHtml}</li>`;
          })
          .join('');
        const tag = ordered ? 'ol' : 'ul';
        const startAttr = ordered && startNum !== 1 ? ` start="${startNum}"` : '';
        const cls = items.some((x) => /^\[[ xX]\]\s+/.test(x.content[0] ?? '')) ? ' class="md-task-list"' : '';
        out.push(`<${tag}${startAttr}${cls}>${lis}</${tag}>`);
        continue;
      }

      // Paragraph
      const para: string[] = [];
      while (
        i < srcLines.length &&
        srcLines[i].trim() &&
        !/^\s*(?:#{1,6}\s|>|`{3,}|~{3,}|[-*+]\s|\d+[.)]\s|(?:-\s*){3,}$|(?:\*\s*){3,}$|(?:_\s*){3,}$)/.test(srcLines[i]) &&
        !(i + 1 < srcLines.length && srcLines[i].includes('|') && isTableRule(srcLines[i + 1], splitTableCells(srcLines[i]).length))
      ) {
        para.push(srcLines[i].trim());
        i++;
      }
      if (!para.length) {
        para.push(srcLines[i].trim());
        i++;
      }
      const pid = nested ? '' : ` data-wb-id="p-${++pSeq}"`;
      out.push(`<p${pid}>${inline(para.join(' '))}</p>`);
    }
    return out.join('\n');
  };

  blocks.push(parseBlocks(lines));
  if (opts.actions?.length) blocks.push(renderActionButtons(opts.actions, 'actions-card'));

  const hasToc = toc.length >= 3;
  const navHtml = hasToc
    ? `<aside class="md-rail" data-wb-id="outline"><div class="wb-eyebrow"><span class="wb-idx">00</span> INDEX</div><nav>${toc
        .map((t) => `<a href="#${escapeHtml(t.id)}" class="md-toc-link"><span class="wb-idx">${t.num}</span><span>${escapeHtml(t.label)}</span></a>`)
        .join('')}</nav></aside>`
    : '';

  const hasH1 = /<h1\b/.test(blocks[0] ?? '');
  const titleHeader = hasH1 ? '' : `<h1 class="md-auto-title" data-wb-id="title">${escapeHtml(opts.title)}</h1>`;
  const metaBadges = Object.entries(meta)
    .filter(([k]) => k !== 'theme')
    .slice(0, 4)
    .map(([k, v]) => `<span class="wb-badge">${escapeHtml(k)}: ${escapeHtml(v)}</span>`)
    .join('');

  return `<!doctype html>
<html lang="en" data-theme="${effectiveTheme}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(opts.title)}</title>
<style>
${FACTORY_ARTIFACT_CSS}
.md-layout {
  display: grid;
  grid-template-columns: ${hasToc ? '248px minmax(0, 1fr)' : 'minmax(0, 1fr)'};
  gap: 40px;
  max-width: ${hasToc ? '1200px' : '960px'};
  width: 100%;
  margin: 0 auto;
  padding: 36px 40px 72px;
}
.md-rail {
  align-self: start;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}
.md-rail nav { display: flex; flex-direction: column; gap: 6px; margin-top: 12px; }
.md-toc-link {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 4px 0;
  border: 0;
  color: var(--text-secondary);
  font: 500 12px/1.35 var(--font-sans);
}
.md-toc-link .wb-idx { font: 600 10px/1 var(--font-mono); color: var(--accent); flex: none; }
.md-toc-link:hover { color: var(--text); }
.md-doc { min-width: 0; }
.md-doc > :first-child { margin-top: 0; }
.md-doc h1 { margin: 0 0 16px; font-size: 30px; font-weight: 500; line-height: 1.2; letter-spacing: -0.02em; padding-bottom: 16px; border-bottom: 1px solid var(--border); }
.md-h2-block { margin: 34px 0 14px; padding-top: 20px; border-top: 1px solid var(--border); }
.md-doc > .md-h2-block:first-child { margin-top: 0; padding-top: 0; border-top: 0; }
.md-h2-block h2 { margin: 6px 0 0; font-size: 20px; font-weight: 500; line-height: 1.3; letter-spacing: -0.01em; }
.md-doc h3 { margin: 24px 0 8px; font-size: 16px; font-weight: 600; color: var(--text); }
.md-doc h4, .md-doc h5, .md-doc h6 { margin: 18px 0 6px; font: 600 11px/1.4 var(--font-mono); text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-secondary); }
.md-doc p { margin: 0 0 14px; color: var(--text); }
.md-doc ul, .md-doc ol { margin: 0 0 16px; padding-left: 22px; }
.md-doc li { margin: 5px 0; }
.md-doc li > ul, .md-doc li > ol { margin: 6px 0 4px; }
.md-doc code {
  padding: 2px 5px;
  border: 1px solid var(--border);
  border-radius: 2px;
  background: var(--surface-raised);
  font: 400 13px/1.4 var(--font-mono);
}
.md-code {
  margin: 16px 0;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--surface-sunken);
  overflow: hidden;
}
.md-code-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}
.md-code-lang { font: 600 10px/1 var(--font-mono); text-transform: uppercase; letter-spacing: 0.1em; color: var(--text-secondary); }
.md-code pre { margin: 0; padding: 14px 16px; overflow-x: auto; font: 400 13px/1.55 var(--font-mono); color: var(--text); }
.md-code pre code { padding: 0; border: 0; background: none; font: inherit; }
.md-table-wrap { margin: 16px 0; border: 1px solid var(--border-strong); border-radius: var(--radius); overflow: hidden; background: var(--surface); }
.md-table-wrap .wb-table tr:last-child td { border-bottom: 0; }
.md-quote { margin: 16px 0; padding: 10px 16px; border-left: 2px solid var(--accent); background: var(--surface); color: var(--text-secondary); }
.md-quote p:last-child, .md-callout-body p:last-child { margin-bottom: 0; }
.md-doc img { display: block; max-width: 100%; height: auto; margin: 16px 0; border: 1px solid var(--border-strong); border-radius: var(--radius); }
.md-task-list { list-style: none; padding-left: 0 !important; }
.md-task-item { margin: 8px 0 !important; }
.md-task-label { display: inline-flex; align-items: flex-start; gap: 10px; cursor: pointer; }
.md-task-label input[type="checkbox"] {
  appearance: none;
  width: 15px;
  height: 15px;
  margin: 4px 0 0;
  flex: none;
  border: 1px solid var(--border-strong);
  border-radius: 2px;
  background: var(--surface);
  cursor: pointer;
  position: relative;
}
.md-task-label input[type="checkbox"]:checked { background: var(--accent); border-color: var(--accent); }
.md-task-label input[type="checkbox"]:checked::after {
  content: "";
  position: absolute;
  left: 4px;
  top: 1px;
  width: 4px;
  height: 8px;
  border: solid #020202;
  border-width: 0 2px 2px 0;
  transform: rotate(45deg);
}
.md-task-label input[type="checkbox"]:checked + span { color: var(--text-secondary); text-decoration: line-through; }
.md-actions { margin-top: 28px; padding: 20px 24px; border: 1px solid var(--border-strong); border-radius: var(--radius); background: var(--surface); display: flex; flex-direction: column; gap: 12px; }
.md-actions-row { display: flex; flex-wrap: wrap; gap: 10px; }
.md-band-end { display: flex; align-items: center; gap: 8px; }
[data-rendering="true"] .md-copy, [data-rendering="true"] #wb-theme-toggle { display: none; }
</style>
</head>
<body>
<div class="wb-shell">
  <header class="wb-band" data-wb-id="header">
    <div class="wb-band-left">
      <span class="wb-rotor">${FACTORY_ROTOR_INLINE_SVG}</span>
      <span class="wb-eyebrow"><span class="wb-idx">MD</span> DOCUMENT</span>
      ${metaBadges}
    </div>
    <div class="md-band-end">
      <button type="button" id="wb-theme-toggle" class="wb-btn sm" data-wb-ignore>${effectiveTheme === 'dark' ? 'LIGHT MODE' : 'DARK MODE'}</button>
    </div>
  </header>
  <div class="md-layout">
    ${navHtml}
    <article class="md-doc" data-wb-id="document">
      ${titleHeader}
      ${blocks.join('\n')}
    </article>
  </div>
</div>
<script>
(function () {
  var root = document.documentElement;
  var btn = document.getElementById('wb-theme-toggle');
  function applyTheme(t) {
    if (t !== 'dark' && t !== 'light') return;
    root.setAttribute('data-theme', t);
    if (btn) btn.textContent = t === 'dark' ? 'LIGHT MODE' : 'DARK MODE';
  }
  if (btn) {
    btn.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      applyTheme(next);
      if (window.whiteboard && !window.whiteboard.rendering) window.whiteboard.state.set('theme', next);
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll('.md-copy'), function (b) {
    b.addEventListener('click', function () {
      var pre = b.closest('.md-code') && b.closest('.md-code').querySelector('pre');
      if (!pre || !navigator.clipboard) return;
      navigator.clipboard.writeText(pre.textContent || '').then(function () {
        b.textContent = 'COPIED';
        setTimeout(function () { b.textContent = 'COPY'; }, 1200);
      }).catch(function () {});
    });
  });
  if (window.whiteboard) {
    window.whiteboard.on('ready', function (wb) {
      if (wb.rendering) root.setAttribute('data-rendering', 'true');
      var saved = wb.state.get('theme');
      if (saved === 'dark' || saved === 'light') applyTheme(saved);
    });
    window.whiteboard.on('state', function (st) {
      if (st && (st.theme === 'dark' || st.theme === 'light')) applyTheme(st.theme);
    });
  }
})();
</script>
</body>
</html>
`;
}

/**
 * Renders a dedicated 1280px Factory Video artifact with frame-accurate scrubbing, speed controls,
 * timestamp pinning, comment-timestamp seek integration, and crash-free headless PNG rendering.
 */
export function renderVideoArtifact(opts: VideoArtifactOptions): string {
  const theme: DesignTheme = opts.theme === 'light' ? 'light' : 'dark';
  const ext = opts.videoMime.split('/')[1]?.toUpperCase().replace('QUICKTIME', 'MOV') || 'VIDEO';
  const metaLabel = [ext, humanBytes(opts.sizeBytes)].filter(Boolean).join(' · ');
  const posterAttr = opts.posterSrc ? ` poster="${escapeHtml(opts.posterSrc)}"` : '';
  const captionHtml = opts.caption?.trim() ? `<p class="vid-caption" data-wb-id="caption">${escapeHtml(opts.caption.trim())}</p>` : '';

  return `<!doctype html>
<html lang="en" data-theme="${theme}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(opts.title)}</title>
<style>
${FACTORY_ARTIFACT_CSS}
main { max-width: 1200px; width: 100%; margin: 0 auto; padding: 28px 40px 48px; display: flex; flex-direction: column; gap: 18px; }
.vid-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
h1 { margin: 0; font-size: 22px; font-weight: 500; letter-spacing: -0.015em; }
.vid-caption { margin: 0; color: var(--text-secondary); white-space: pre-wrap; max-width: 90ch; }
.vid-stage {
  position: relative;
  width: 100%;
  background: #020202;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  overflow: hidden;
}
video, .vid-poster-only {
  display: block;
  width: 100%;
  max-height: 720px;
  margin: 0 auto;
  background: #020202;
  object-fit: contain;
}
.vid-slate {
  display: none;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  min-height: 460px;
  padding: 40px;
  color: #eeeeee;
  background: #060606;
  text-align: center;
}
.vid-slate .wb-rotor { width: 36px; height: 36px; }
.vid-controls {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--surface);
  flex-wrap: wrap;
}
.vid-scrub {
  flex: 1;
  min-width: 180px;
  accent-color: var(--accent);
  cursor: pointer;
}
.vid-time {
  font: 600 11px/1 var(--font-mono);
  color: var(--text);
  font-variant-numeric: tabular-nums;
  min-width: 112px;
  text-align: center;
}
[data-rendering="true"] .vid-controls { display: none; }
</style>
</head>
<body>
<div class="wb-shell">
  <header class="wb-band" data-wb-id="header">
    <div class="wb-band-left">
      <span class="wb-rotor">${FACTORY_ROTOR_INLINE_SVG}</span>
      <span class="wb-eyebrow"><span class="wb-idx">01</span> VIDEO ARTIFACT</span>
    </div>
    <span class="wb-badge accent">${escapeHtml(metaLabel)}</span>
  </header>
  <main>
    <div class="vid-head" data-wb-id="title">
      <h1>${escapeHtml(opts.title)}</h1>
    </div>
    ${captionHtml}
    <div class="vid-stage" data-wb-id="video">
      <video id="wb-video"${posterAttr} playsinline preload="metadata"></video>
      <div id="wb-slate" class="vid-slate">
        <span class="wb-rotor">${FACTORY_ROTOR_INLINE_SVG}</span>
        <div class="wb-eyebrow"><span class="wb-idx">VIDEO</span> ${escapeHtml(metaLabel)}</div>
        <div>${escapeHtml(opts.title)}</div>
      </div>
    </div>
    <div class="vid-controls" data-wb-id="controls">
      <button type="button" id="v-play" class="wb-btn sm primary" data-wb-ignore>PLAY →</button>
      <button type="button" id="v-prev" class="wb-btn sm" title="Previous frame (1/30s)" data-wb-ignore>-1F</button>
      <button type="button" id="v-next" class="wb-btn sm" title="Next frame (1/30s)" data-wb-ignore>+1F</button>
      <input type="range" id="v-scrub" class="vid-scrub" min="0" max="1000" value="0" step="1" aria-label="Seek timeline" data-wb-ignore>
      <span id="v-time" class="vid-time">00:00.0 / 00:00.0</span>
      <button type="button" id="v-rate" class="wb-btn sm" title="Playback speed" data-wb-ignore>1×</button>
      <button type="button" id="v-loop" class="wb-btn sm" title="Toggle loop" data-wb-ignore>LOOP</button>
      <button type="button" id="v-mute" class="wb-btn sm" title="Toggle mute" data-wb-ignore>SOUND</button>
      <button type="button" id="v-pin" class="wb-btn sm" title="Copy current @timecode for a comment and save it to card state" data-wb-ignore>PIN @TIME</button>
    </div>
  </main>
</div>
<script>
(function () {
  var SRC = ${JSON.stringify(opts.videoSrc)};
  var POSTER = ${JSON.stringify(opts.posterSrc ?? '')};
  var video = document.getElementById('wb-video');
  var slate = document.getElementById('wb-slate');
  var playBtn = document.getElementById('v-play');
  var prevBtn = document.getElementById('v-prev');
  var nextBtn = document.getElementById('v-next');
  var scrub = document.getElementById('v-scrub');
  var timeEl = document.getElementById('v-time');
  var rateBtn = document.getElementById('v-rate');
  var loopBtn = document.getElementById('v-loop');
  var muteBtn = document.getElementById('v-mute');
  var pinBtn = document.getElementById('v-pin');
  var rates = [0.5, 1, 1.5, 2];
  var rateIdx = 1;
  var scrubbing = false;
  var booted = false;

  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    var m = Math.floor(sec / 60);
    var s = sec - m * 60;
    var whole = Math.floor(s);
    var tenth = Math.floor((s - whole + 1e-6) * 10);
    return (m < 10 ? '0' + m : String(m)) + ':' + (whole < 10 ? '0' + whole : String(whole)) + '.' + tenth;
  }

  function syncUi() {
    var cur = video.currentTime || 0;
    var dur = isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    timeEl.textContent = fmt(cur) + ' / ' + fmt(dur);
    if (!scrubbing && dur > 0) scrub.value = String(Math.round((cur / dur) * 1000));
    playBtn.textContent = video.paused ? 'PLAY →' : 'PAUSE';
    loopBtn.style.borderColor = video.loop ? 'var(--accent)' : '';
    loopBtn.style.color = video.loop ? 'var(--accent)' : '';
    muteBtn.textContent = video.muted ? 'MUTED' : 'SOUND';
  }

  function bootLive() {
    if (booted) return;
    booted = true;
    video.src = SRC;
    video.controls = false;
  }

  function bootRender() {
    if (booted) return;
    booted = true;
    document.documentElement.setAttribute('data-rendering', 'true');
    if (POSTER) {
      var img = document.createElement('img');
      img.className = 'vid-poster-only';
      img.src = POSTER;
      img.alt = '';
      video.replaceWith(img);
      return;
    }
    video.muted = true;
    video.src = SRC;
    var fallback = setTimeout(function () {
      if (video.readyState < 2) {
        video.removeAttribute('src');
        video.load();
        video.style.display = 'none';
        slate.style.display = 'flex';
      }
    }, 1500);
    video.addEventListener('loadeddata', function () {
      clearTimeout(fallback);
      try { video.currentTime = Math.min(0.05, (video.duration || 0) * 0.1); } catch (e) {}
    }, { once: true });
    video.addEventListener('error', function () {
      clearTimeout(fallback);
      video.style.display = 'none';
      slate.style.display = 'flex';
    }, { once: true });
  }

  video.addEventListener('click', function () {
    if (document.documentElement.getAttribute('data-wb-mode') === 'markup') return;
    if (video.paused) video.play().catch(function () {});
    else video.pause();
  });
  playBtn.addEventListener('click', function () {
    if (video.paused) video.play().catch(function () {});
    else video.pause();
  });
  prevBtn.addEventListener('click', function () {
    video.pause();
    video.currentTime = Math.max(0, (video.currentTime || 0) - 1 / 30);
    syncUi();
  });
  nextBtn.addEventListener('click', function () {
    video.pause();
    var dur = isFinite(video.duration) && video.duration > 0 ? video.duration : Infinity;
    video.currentTime = Math.min(dur, (video.currentTime || 0) + 1 / 30);
    syncUi();
  });
  scrub.addEventListener('input', function () {
    scrubbing = true;
    var dur = isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    if (dur > 0) video.currentTime = (Number(scrub.value) / 1000) * dur;
    syncUi();
  });
  scrub.addEventListener('change', function () { scrubbing = false; });
  rateBtn.addEventListener('click', function () {
    rateIdx = (rateIdx + 1) % rates.length;
    video.playbackRate = rates[rateIdx];
    rateBtn.textContent = rates[rateIdx] + '×';
  });
  loopBtn.addEventListener('click', function () {
    video.loop = !video.loop;
    syncUi();
  });
  muteBtn.addEventListener('click', function () {
    video.muted = !video.muted;
    syncUi();
  });
  pinBtn.addEventListener('click', function () {
    video.pause();
    var sec = Math.round((video.currentTime || 0) * 10) / 10;
    var stamp = '@' + fmt(sec);
    if (window.whiteboard && !window.whiteboard.rendering) {
      window.whiteboard.state.set('selectedTime', { seconds: sec, timecode: stamp });
    }
    if (navigator.clipboard) navigator.clipboard.writeText(stamp).catch(function () {});
    pinBtn.textContent = 'COPIED ' + stamp;
    setTimeout(function () { pinBtn.textContent = 'PIN @TIME'; }, 1400);
  });

  ['loadedmetadata', 'timeupdate', 'play', 'pause', 'ended', 'volumechange'].forEach(function (ev) {
    video.addEventListener(ev, syncUi);
  });

  if (window.whiteboard) {
    window.whiteboard.on('ready', function (wb) {
      if (wb.rendering) bootRender();
      else bootLive();
    });
    window.whiteboard.on('seek', function (sec) {
      syncUi();
    });
    setTimeout(function () { if (!booted) bootLive(); }, 300);
  } else {
    bootLive();
  }
})();
</script>
</body>
</html>
`;
}

/**
 * Renders a 1280px Factory Image artifact supporting PNG, JPEG, WebP, GIF, and SVG with an interactive
 * transparency grid toggle (hidden in renders) and exact image anchor preservation (`data-wb-id="image"`).
 */
export function renderImageArtifact(opts: ImageArtifactOptions): string {
  const theme: DesignTheme = opts.theme === 'light' ? 'light' : 'dark';
  const fmt = opts.imageMime.replace('image/', '').replace('+xml', '').toUpperCase();
  const dims = opts.width && opts.height ? `${opts.width} × ${opts.height}` : '';
  const meta = [dims, fmt, humanBytes(opts.sizeBytes)].filter(Boolean).join(' · ');
  const sizeAttrs = opts.width && opts.height ? ` width="${opts.width}" height="${opts.height}"` : '';
  const hasChrome = Boolean(opts.caption?.trim());

  return `<!doctype html>
<html lang="en" data-theme="${theme}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(opts.title)}</title>
<style>
${FACTORY_ARTIFACT_CSS}
body { display: flex; flex-direction: column; min-height: 100%; }
.img-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 24px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}
.img-title { font: 500 14px/1.3 var(--font-sans); color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.img-end { display: flex; align-items: center; gap: 8px; flex: none; }
.img-stage {
  position: relative;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: ${hasChrome ? '24px' : '0'};
  background: var(--bg);
}
.img-stage.checker {
  background-color: #0e0e0e;
  background-image: linear-gradient(45deg, #181818 25%, transparent 25%), linear-gradient(-45deg, #181818 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #181818 75%), linear-gradient(-45deg, transparent 75%, #181818 75%);
  background-size: 20px 20px;
  background-position: 0 0, 0 10px, 10px -10px, -10px 0;
}
.img-stage img { display: block; max-width: 100%; height: auto; margin: 0 auto; }
.img-caption { padding: 14px 24px 20px; border-top: 1px solid var(--border); background: var(--surface); color: var(--text-secondary); font-size: 14px; white-space: pre-wrap; }
[data-rendering="true"] #img-grid-btn { display: none; }
</style>
</head>
<body>
<header class="img-bar">
  <div class="wb-band-left">
    <span class="wb-rotor">${FACTORY_ROTOR_INLINE_SVG}</span>
    <span class="img-title">${escapeHtml(opts.title)}</span>
  </div>
  <div class="img-end">
    <span class="wb-badge">${escapeHtml(meta)}</span>
    <button type="button" id="img-grid-btn" class="wb-btn sm" data-wb-ignore>GRID BG</button>
  </div>
</header>
<div id="img-stage" class="img-stage">
  <img data-wb-id="image" src="${escapeHtml(opts.imageSrc)}" alt="${escapeHtml(opts.title)}"${sizeAttrs}>
</div>
${hasChrome ? `<div class="img-caption" data-wb-id="caption">${escapeHtml(opts.caption!.trim())}</div>` : ''}
<script>
(function () {
  var stage = document.getElementById('img-stage');
  var btn = document.getElementById('img-grid-btn');
  if (btn && stage) {
    btn.addEventListener('click', function () {
      stage.classList.toggle('checker');
    });
  }
  if (window.whiteboard) {
    window.whiteboard.on('ready', function (wb) {
      if (wb.rendering) document.documentElement.setAttribute('data-rendering', 'true');
    });
  }
})();
</script>
</body>
</html>
`;
}

/**
 * Splits a comment message into plain text and video timecode tokens (`@12.5s`, `00:14`, `01:23.4`, `1:02:03`)
 * so comments on video cards get one-click timestamp seek chips without matching ratios like `16:9`.
 */
export function parseTimecodeTokens(text: string): TimecodePart[] {
  const re = /(^|[\s([{"'])(?:@(\d+(?:\.\d+)?)s\b|@?(?:(\d{1,2}):)?(\d{1,2}):([0-5]\d(?:\.\d)?)\b)/g;
  const out: TimecodePart[] = [];
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const prefix = m[1] ?? '';
    const start = m.index + prefix.length;
    const token = m[0].slice(prefix.length);
    let seconds: number;
    if (m[2] !== undefined) seconds = Number(m[2]);
    else {
      const h = m[3] ? Number(m[3]) : 0;
      const min = Number(m[4]);
      const sec = Number(m[5]);
      seconds = h * 3600 + min * 60 + sec;
    }
    if (!Number.isFinite(seconds) || seconds < 0) continue;
    if (start > last) out.push({ kind: 'text', text: text.slice(last, start) });
    out.push({ kind: 'timecode', text: token, seconds });
    last = start + token.length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out.length ? out : [{ kind: 'text', text }];
}

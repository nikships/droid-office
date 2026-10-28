import { Marked, type Token, type Tokens } from 'marked';

// Worker replies as GitHub-flavored Markdown, turned into a small tree the app draws with native Text
// and View. Nothing here is HTML: raw HTML stays literal text, pictures stay links, and only web and
// mail links can be opened, so a reply can't run anything or load anything by itself.

/** Like the web Thread, a lone newline in a reply is a line break. */
const md = new Marked({ gfm: true, breaks: true });

export interface MdSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  /** Only http(s) and mailto: anything else is shown as text. */
  href?: string;
}

export type MdAlign = 'left' | 'center' | 'right' | null;

export type MdBlock =
  | { kind: 'paragraph'; spans: MdSpan[] }
  | { kind: 'heading'; depth: number; spans: MdSpan[] }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'list'; ordered: boolean; start: number; items: MdListItem[] }
  | { kind: 'quote'; blocks: MdBlock[] }
  | { kind: 'table'; align: MdAlign[]; header: MdSpan[][]; rows: MdSpan[][][] }
  | { kind: 'rule' };

export interface MdListItem {
  /** undefined for a plain item; true or false for a task list box. */
  checked?: boolean;
  blocks: MdBlock[];
}

/** Deeper nesting than this is shown flat, so a hostile reply can't blow the stack. */
const MAX_DEPTH = 12;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

/** The few HTML entities a reply carries as text, decoded the way a browser would show them. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (whole, name: string) => {
    if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? whole;
    const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : whole;
  });
}

/** A link the app may hand to the system: web and mail only. */
export function safeHref(href: string | undefined): string | undefined {
  const h = href?.trim();
  if (!h || h.length > 4096) return undefined;
  return /^(https?:\/\/|mailto:)/i.test(h) ? h : undefined;
}

type Marks = Omit<MdSpan, 'text'>;

function spans(tokens: readonly Token[] | undefined, marks: Marks, depth: number, out: MdSpan[] = []): MdSpan[] {
  const push = (text: string, more: Marks = {}) => {
    if (!text) return;
    const span: MdSpan = { text, ...marks, ...more };
    const last = out.at(-1);
    if (last && sameMarks(last, span)) last.text += text;
    else out.push(span);
  };
  for (const t of tokens ?? []) {
    if (depth > MAX_DEPTH) {
      push('raw' in t ? decodeEntities(String(t.raw)) : '');
      continue;
    }
    switch (t.type) {
      case 'strong':
        spans((t as Tokens.Strong).tokens, { ...marks, bold: true }, depth + 1, out);
        break;
      case 'em':
        spans((t as Tokens.Em).tokens, { ...marks, italic: true }, depth + 1, out);
        break;
      case 'del':
        spans((t as Tokens.Del).tokens, { ...marks, strike: true }, depth + 1, out);
        break;
      case 'codespan':
        push(decodeEntities((t as Tokens.Codespan).text), { code: true });
        break;
      case 'br':
        push('\n');
        break;
      case 'link': {
        const link = t as Tokens.Link;
        const href = safeHref(link.href);
        spans(link.tokens, href ? { ...marks, href } : marks, depth + 1, out);
        break;
      }
      case 'image': {
        const image = t as Tokens.Image;
        const href = safeHref(image.href);
        push(`[${decodeEntities(image.text) || 'picture'}]`, href ? { href } : {});
        break;
      }
      case 'escape':
        push((t as Tokens.Escape).text);
        break;
      case 'html':
        push((t as Tokens.HTML).text);
        break;
      case 'text': {
        const text = t as Tokens.Text;
        if (text.tokens?.length) spans(text.tokens, marks, depth + 1, out);
        else push(decodeEntities(text.text));
        break;
      }
      default:
        push('text' in t && typeof t.text === 'string' ? decodeEntities(t.text) : String(t.raw ?? ''));
    }
  }
  return out;
}

function sameMarks(a: MdSpan, b: MdSpan): boolean {
  return !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.strike === !!b.strike && !!a.code === !!b.code && a.href === b.href;
}

function blocks(tokens: readonly Token[], depth: number): MdBlock[] {
  const out: MdBlock[] = [];
  for (const t of tokens) {
    if (depth > MAX_DEPTH) {
      if (t.raw?.trim()) out.push({ kind: 'paragraph', spans: [{ text: t.raw }] });
      continue;
    }
    switch (t.type) {
      case 'space':
        break;
      case 'heading': {
        const h = t as Tokens.Heading;
        out.push({ kind: 'heading', depth: h.depth, spans: spans(h.tokens, {}, depth) });
        break;
      }
      case 'paragraph':
        out.push({ kind: 'paragraph', spans: spans((t as Tokens.Paragraph).tokens, {}, depth) });
        break;
      case 'text': {
        const text = t as Tokens.Text;
        out.push({ kind: 'paragraph', spans: text.tokens?.length ? spans(text.tokens, {}, depth) : [{ text: decodeEntities(text.text) }] });
        break;
      }
      case 'code': {
        const code = t as Tokens.Code;
        out.push({ kind: 'code', lang: code.lang?.split(/\s/)[0] ?? '', text: code.text });
        break;
      }
      case 'blockquote':
        out.push({ kind: 'quote', blocks: blocks((t as Tokens.Blockquote).tokens, depth + 1) });
        break;
      case 'list': {
        const list = t as Tokens.List;
        const start = typeof list.start === 'number' && Number.isSafeInteger(list.start) ? list.start : 1;
        out.push({
          kind: 'list',
          ordered: list.ordered,
          start,
          items: list.items.map((item) => ({
            ...(item.task ? { checked: !!item.checked } : {}),
            blocks: blocks(
              item.tokens.filter((x) => x.type !== 'checkbox'),
              depth + 1,
            ),
          })),
        });
        break;
      }
      case 'table': {
        const table = t as Tokens.Table;
        out.push({
          kind: 'table',
          align: table.align,
          header: table.header.map((cell) => spans(cell.tokens, {}, depth)),
          rows: table.rows.map((row) => row.map((cell) => spans(cell.tokens, {}, depth))),
        });
        break;
      }
      case 'hr':
        out.push({ kind: 'rule' });
        break;
      case 'html':
        if (t.raw.trim()) out.push({ kind: 'paragraph', spans: [{ text: t.raw.replace(/\n+$/, '') }] });
        break;
      default:
        if (t.raw?.trim()) out.push({ kind: 'paragraph', spans: [{ text: t.raw.replace(/\n+$/, '') }] });
    }
  }
  return out;
}

/** A reply's Markdown as blocks to draw. Never throws: what marked can't read is shown as written. */
export function parseMarkdown(src: string): MdBlock[] {
  if (!src.trim()) return [];
  try {
    return blocks(md.lexer(src), 0);
  } catch {
    return [{ kind: 'paragraph', spans: [{ text: src }] }];
  }
}

/**
 * React keys for a list that never reorders: what each item says, counted when it repeats, so a key
 * names the item rather than its position.
 */
export function keyed<T>(items: readonly T[], name: (item: T) => string): [string, T][] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const k = name(item);
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    return [`${k}#${n}`, item];
  });
}

/** A block's text with no marks, for copying a table cell or a heading. */
export function plainText(s: readonly MdSpan[]): string {
  return s.map((x) => x.text).join('');
}

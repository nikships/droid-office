// Pure composer text edits for the Thread view: quoting a transcript selection into a reply, and
// large pastes held as chips that expand back into the message when it's sent.
// Free of window/document globals so Node unit tests import it directly.

/** A paste longer than this many characters becomes a chip. */
export const PASTE_CHIP_CHARS = 1000;
/** A paste with more than this many lines becomes a chip. */
export const PASTE_CHIP_LINES = 15;

export interface PastedText {
  id: number;
  text: string;
  lines: number;
  /** Stands in for `text` in the draft, where the owner can move or delete it like any other text. */
  token: string;
}

const lineCount = (text: string) => (text ? text.split('\n').length : 0);

export function isLargePaste(text: string): boolean {
  const normalized = text.replace(/\r\n?/g, '\n');
  return normalized.length > PASTE_CHIP_CHARS || lineCount(normalized) > PASTE_CHIP_LINES;
}

export function pastedText(id: number, raw: string): PastedText {
  const text = raw.replace(/\r\n?/g, '\n');
  const lines = lineCount(text);
  const size = lines > 1 ? `${lines.toLocaleString('en-US')} lines` : `${text.length.toLocaleString('en-US')} chars`;
  return { id, text, lines, token: `[Pasted text #${id} · ${size}]` };
}

/** The pastes whose token is still in the draft: deleting a token drops its paste. */
export function livePastes(value: string, pastes: readonly PastedText[]): PastedText[] {
  return pastes.filter((paste) => value.includes(paste.token));
}

/**
 * The draft as it is sent: each paste's first token replaced by its text, in one pass over `value`
 * so a paste whose text happens to contain another paste's token stays as pasted.
 */
export function expandPastes(value: string, pastes: readonly PastedText[]): string {
  const found = pastes
    .map((paste) => ({ paste, at: value.indexOf(paste.token) }))
    .filter((hit) => hit.at >= 0)
    .sort((a, b) => a.at - b.at);
  let out = '';
  let from = 0;
  for (const { paste, at } of found) {
    if (at < from) continue;
    out += value.slice(from, at) + paste.text;
    from = at + paste.token.length;
  }
  return out + value.slice(from);
}

/** Replaces a paste's token with `replacement` (its text to edit it in place, or nothing to drop it). */
export function replacePaste(value: string, paste: PastedText, replacement: string): { value: string; cursor: number } | null {
  const at = value.indexOf(paste.token);
  if (at < 0) return null;
  return { value: value.slice(0, at) + replacement + value.slice(at + paste.token.length), cursor: at + replacement.length };
}

/** `selected` as Markdown quote lines, without the blank lines around it or trailing spaces. */
export function quoteLines(selected: string): string {
  const lines = selected
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.trimEnd());
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines.at(-1)) lines.pop();
  return lines.map((line) => (line ? `> ${line}` : '>')).join('\n');
}

/**
 * Inserts `selected` as a quote in place of the draft's `start`..`end` range, on lines of its own
 * with a blank line after it (so the reply typed next isn't read as part of the quote), and returns
 * where the reply starts.
 */
export function insertQuote(value: string, start: number, end: number, selected: string): { value: string; cursor: number } | null {
  const quote = quoteLines(selected);
  if (!quote) return null;
  const from = Math.max(0, Math.min(start, end, value.length));
  const to = Math.max(from, Math.min(Math.max(start, end), value.length));
  const before = value.slice(0, from);
  const after = value.slice(to);
  const lead = !before || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const breaks = /^\n*/.exec(after)?.[0].length ?? 0;
  const trail = '\n'.repeat(Math.max(0, 2 - breaks));
  return { value: before + lead + quote + trail + after, cursor: before.length + lead.length + quote.length + 2 };
}

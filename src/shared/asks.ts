import { FLAG_BOLD, type Run } from './protocol.js';

// A worker's numbered question menu, read from its terminal screen. Ported from Android's
// core/Choices.kt and core/Asks.kt so every client parses, keys and re-checks a menu the same
// way. Pure string logic: the caller supplies the screen as plain text lines.

export interface Choice {
  number: number;
  label: string;
  description?: string;
  selected?: boolean;
}

export interface Menu {
  question?: string;
  choices: Choice[];
  /** Focused option; multi-select also uses choices.length for text and length + 1 for Submit. */
  pointer?: number;
  freeText: boolean;
  multiSelect?: boolean;
}

export const ASK_KEYS = { UP: '\x1b[A', DOWN: '\x1b[B', ENTER: '\r' } as const;

const OPTION = /^([>❯›▸▶→●◉]\s*)?([1-9])[.)]\s+(\S.*)$/;
const FREE_TEXT = /^([>❯›▸▶→●◉]\s*)?(\[[ xX✓✔]\]\s*)?(or\s+)?type your own answer/i;
const CHECKBOX = /^\[([ xX✓✔])\]\s*(.*)$/;
const OTHER = /^other\b|type (your|an?) (own )?answer/i;
const BORDERS = ['│', '┃', '║', '|', ' ', ' '];
const EDGE = ['│', '┃', '║', '|'];
const MAX_TRAILING = 6;
const MAX_GAP = 24;
const QUESTION_REACH = 48;

const trimChars = (s: string, chars: string[]) => {
  let a = 0;
  let b = s.length;
  while (a < b && chars.includes(s[a]!)) a++;
  while (b > a && chars.includes(s[b - 1]!)) b--;
  return s.slice(a, b);
};
const trimStartChars = (s: string, chars: string[]) => {
  let a = 0;
  while (a < s.length && chars.includes(s[a]!)) a++;
  return s.slice(a);
};

function indent(raw: string): number {
  const s = trimStartChars(raw, EDGE);
  return s.length - trimStartChars(s, [' ', ' ']).length;
}

/**
 * Finds the last numbered menu on the screen: options 1…n (at least two), each on its own line,
 * with at most MAX_GAP lines of description between them, and no more than MAX_TRAILING lines of
 * hints under the last one. A numbered list higher up (a plan the agent wrote) is not a menu.
 */
export function readMenu(lines: readonly string[]): Menu | undefined {
  const clean = lines.map((l) => trimChars(l, BORDERS));
  let lastContent = -1;
  for (let i = clean.length - 1; i >= 0; i--)
    if (clean[i]!.trim()) {
      lastContent = i;
      break;
    }
  if (lastContent < 0) return undefined;
  let last = -1;
  for (let i = lastContent; i >= 0; i--) {
    if (OPTION.test(clean[i]!)) {
      last = i;
      break;
    }
  }
  if (last < 0) return undefined;
  const trailing = clean.slice(last + 1, lastContent + 1).filter((line, index) => line.trim() && indent(lines[last + 1 + index]!) <= indent(lines[last]!)).length;
  if (trailing > MAX_TRAILING) return undefined;
  const found: { row: number; m: RegExpMatchArray }[] = [];
  let expect = Number(OPTION.exec(clean[last]!)![2]);
  let gap = 0;
  const gapLimit = indent(lines[last]!) > 0 ? MAX_GAP : 2;
  for (let i = last; i >= 0 && expect >= 1; i--) {
    const m = OPTION.exec(clean[i]!);
    if (m && Number(m[2]) === expect) {
      found.push({ row: i, m });
      expect--;
      gap = 0;
    } else if (m || (clean[i]!.trim() && ++gap > gapLimit)) break;
  }
  if (expect !== 0 || found.length < 2) return undefined;
  found.reverse();
  const choices: Choice[] = found.map(({ row, m }, k) => {
    const end = k + 1 < found.length ? found[k + 1]!.row : lines.length;
    const optionIndent = indent(lines[row]!) + (m[1]?.length ?? 0);
    const descLines: string[] = [];
    for (let r = row + 1; r < end; r++) {
      if (!clean[r]!.trim() || FREE_TEXT.test(clean[r]!) || indent(lines[r]!) <= optionIndent) break;
      descLines.push(clean[r]!);
    }
    const description = descLines.join(' ');
    const checkbox = CHECKBOX.exec(m[3]!.trim());
    return { number: Number(m[2]), label: checkbox ? checkbox[2]!.trim() : m[3]!.trim(), ...(description ? { description } : {}), ...(checkbox ? { selected: checkbox[1] !== ' ' } : {}) };
  });
  const multiSelect = choices.every((c) => c.selected !== undefined);
  if (!multiSelect && choices.some((c) => c.selected !== undefined)) return undefined;
  const marked = found.flatMap(({ m }, i) => (m[1] ? [i] : []));
  const pointerIdx = marked.length === 1 ? marked[0]! : -1;
  const top = found[0]!.row;
  let question: string | undefined;
  for (let r = top - 1; r >= Math.max(0, top - QUESTION_REACH); r--) {
    const line = clean[r]!;
    if (line.includes('?') && /\p{L}/u.test(line)) {
      const parts = [line];
      for (let end = r + 1; end < top; end++) {
        const next = clean[end]!;
        if (!next || OPTION.test(next) || /Ask User|[→●○]|\[question\]/i.test(next) || !/\p{L}/u.test(next)) break;
        parts.push(next);
      }
      for (let start = r - 1; start >= Math.max(0, top - QUESTION_REACH); start--) {
        const previous = clean[start]!;
        if (!previous || OPTION.test(previous) || /Ask User|[→●○]|\[question\]/i.test(previous) || !/\p{L}/u.test(previous)) break;
        parts.unshift(previous);
      }
      question = parts.join(' ');
      break;
    }
  }
  let freeText = menuOnTextRow(lines) || (multiSelect && clean.slice(last + 1).some((line) => /^(Next|Submit)$/.test(line)));
  for (let r = last + 1; r <= lastContent; r++) if (FREE_TEXT.test(clean[r]!)) freeText = true;
  return { ...(question ? { question } : {}), choices, ...(pointerIdx >= 0 ? { pointer: pointerIdx } : {}), freeText, ...(multiSelect ? { multiSelect: true } : {}) };
}

/** Droid marks keyboard focus in bold. A checked option is not necessarily the focused one. */
export function readScreenMenu(rows: readonly (readonly Run[])[]): Menu | undefined {
  const lines = rows.map((runs) => runs.map((run) => run[0]).join(''));
  const menu = readMenu(lines);
  if (!menu) return;
  if (menu.multiSelect && menuOnTextRow(lines)) return { ...menu, pointer: menu.choices.length };
  const optionRows = new Set<number>();
  let expected = menu.choices.length;
  for (let row = lines.length - 1; row >= 0 && expected > 0; row--) {
    const option = OPTION.exec(trimChars(lines[row]!, BORDERS));
    if (option && Number(option[2]) === expected) {
      optionRows.add(row);
      expected--;
    }
  }
  const lastOption = Math.max(...optionRows);
  const focused = rows.flatMap((runs, row) => {
    if (!optionRows.has(row) && row <= lastOption) return [];
    if (!runs.some((run) => (run[3] & FLAG_BOLD) !== 0 && run[0].trim())) return [];
    const line = trimChars(lines[row]!, BORDERS);
    const option = OPTION.exec(line);
    if (option && menu.choices.some((choice) => choice.number === Number(option[2]))) return [Number(option[2]) - 1];
    if (menu.multiSelect && /^(Next|Submit)$/.test(line)) return [menu.choices.length + 1];
    return [];
  });
  return focused.length === 1 ? { ...menu, pointer: focused[0] } : menu;
}

/** The keys that pick a choice: arrows + Enter with a pointer, else its digit. */
export function menuKeys(menu: Menu, choice: Choice): string {
  if (menu.multiSelect) return '';
  if (menu.pointer === undefined) return String(choice.number);
  const target = menu.choices.indexOf(choice);
  if (target < 0) return String(choice.number);
  const delta = target - menu.pointer;
  const step = delta < 0 ? ASK_KEYS.UP : ASK_KEYS.DOWN;
  return step.repeat(Math.abs(delta)) + ASK_KEYS.ENTER;
}

/** Whether the menu takes a typed answer. */
export function menuTakesText(menu: Menu): boolean {
  return menu.freeText || menu.choices.some((c) => OTHER.test(c.label));
}

/** The keys that answer with typed text, or undefined when the menu has no place for one. */
export function menuTextKeys(menu: Menu, text: string): string | undefined {
  if (menu.multiSelect) return undefined;
  const line = text.replace(/[\r\n]+/g, ' ').trim();
  if (!line) return undefined;
  const other = menu.choices.find((c) => OTHER.test(c.label));
  if (other) return menuKeys(menu, other) + line + ASK_KEYS.ENTER;
  if (!menu.freeText) return undefined;
  const from = menu.pointer ?? 0;
  return ASK_KEYS.DOWN.repeat(menu.choices.length - from) + line + ASK_KEYS.ENTER;
}

const TEXT_ROW = /Enter (?:Submit|Add) answer|back to options/i;
/** Whether the bottom of the screen shows Droid's hints for typing an answer. */
export function menuOnTextRow(lines: readonly string[]): boolean {
  return lines
    .filter((l) => l.trim())
    .slice(-MAX_TRAILING)
    .some((l) => TEXT_ROW.test(l));
}

/** The custom answer still renders its empty placeholder below the latest numbered option. */
export function menuTextRowEmpty(lines: readonly string[]): boolean {
  const clean = lines.map((line) => trimChars(line, BORDERS));
  for (let row = clean.length - 1; row >= 0; row--) {
    if (OPTION.test(clean[row]!)) return clean.slice(row + 1).some((line) => FREE_TEXT.test(line));
  }
  return false;
}

/** The same question with the same choices: what was shown is still what an answer would pick. */
export function sameMenu(a: Menu | undefined, b: Menu | undefined): boolean {
  if (!a || !b || !Array.isArray(a.choices) || !Array.isArray(b.choices)) return false;
  return (
    a.question === b.question &&
    !!a.multiSelect === !!b.multiSelect &&
    a.freeText === b.freeText &&
    a.choices.length === b.choices.length &&
    a.choices.every((c, i) => !!c && c.number === b.choices[i]?.number && c.label === b.choices[i]?.label && c.description === b.choices[i]?.description)
  );
}

/** Minimal worker shape the question checks need. */
export interface AskWorker {
  status: string;
  kind: string;
  guest?: unknown;
  cloud?: unknown;
}

/** The numbered menu on a worker's screen: a shell's numbered output is never an ask. */
export function workerMenu(worker: AskWorker, lines: readonly string[] | undefined): Menu | undefined {
  if (worker.kind !== 'agent' || worker.cloud || worker.guest || !lines) return undefined;
  return readMenu(lines);
}

/** Only a live local agent's waiting question with a readable menu can be answered safely. */
export function canAnswer(worker: AskWorker, lines: readonly string[] | undefined): boolean {
  return worker.status === 'needs_input' && workerMenu(worker, lines) !== undefined;
}

/** A reply typed by the owner: a bare digit picks that choice, anything else is their own answer. */
export function replyKeys(menu: Menu | undefined, text: string): string | undefined {
  const t = text.trim();
  if (!menu || !t || menu.multiSelect) return undefined;
  const n = /^\d+$/.test(t) ? Number(t) : undefined;
  if (n !== undefined) {
    const choice = menu.choices.find((c) => c.number === n);
    if (choice) return menuKeys(menu, choice);
  }
  return menuTextKeys(menu, t);
}

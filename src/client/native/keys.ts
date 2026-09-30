/**
 * The on-panel keyboard's keys, and what each press does: the bytes it types into a worker's
 * terminal, or the edit it makes to a text field. Pure, so tests run it in Node.
 *
 * A press is described as a KeyLike (the same shape a real KeyboardEvent has), so the terminal
 * gets exactly the bytes a physical keyboard would send (vr/physical-keys.ts), including
 * Ctrl+Enter and Shift+Enter for workers that bind them (term-keys.ts).
 */

import { modifiedEnter } from '../term-keys';
import { keyBytes, type KeyLike } from '../vr/physical-keys';
import { isPaletteKey, type PaletteKey } from '../../shared/palette';

export type { KeyLike };

/** A modifier the keyboard latches: tap it, then the key it goes with. */
export type Modifier = 'ctrl' | 'alt' | 'shift';

export interface KeyDef {
  /** A KeyboardEvent `key` value ('a', 'Enter', 'ArrowUp'), or `mod:*` / `hide` for the keyboard's own keys. */
  id: string;
  label: string;
  /** Width in key units (1 = a letter key). */
  w?: number;
  /** A spoken name, for keys whose label is a symbol. */
  name?: string;
}

/** US shift symbols for the digit and punctuation keys. */
export const SHIFTED: Readonly<Record<string, string>> = {
  '`': '~',
  '1': '!',
  '2': '@',
  '3': '#',
  '4': '$',
  '5': '%',
  '6': '^',
  '7': '&',
  '8': '*',
  '9': '(',
  '0': ')',
  '-': '_',
  '=': '+',
  '[': '{',
  ']': '}',
  '\\': '|',
  ';': ':',
  "'": '"',
  ',': '<',
  '.': '>',
  '/': '?',
};

const chars = (s: string): KeyDef[] => [...s].map((c) => ({ id: c, label: c }));

/** Five rows: Esc and the digits, QWERTY with Tab, ASDF with Ctrl and Enter, ZXCV with Shift and ↑, then Space and the cursor keys. */
export const KEYBOARD_ROWS: readonly (readonly KeyDef[])[] = [
  [{ id: 'Escape', label: 'Esc' }, ...chars('`1234567890-='), { id: 'Backspace', label: '⌫', w: 1.5, name: 'Backspace' }],
  [{ id: 'Tab', label: 'Tab', w: 1.5 }, ...chars('qwertyuiop[]\\')],
  [{ id: 'mod:ctrl', label: 'Ctrl', w: 1.75 }, ...chars("asdfghjkl;'"), { id: 'Enter', label: 'Enter', w: 1.75 }],
  [{ id: 'mod:shift', label: 'Shift', w: 2.25 }, ...chars('zxcvbnm,./'), { id: 'ArrowUp', label: '↑', name: 'Up' }, { id: 'Delete', label: 'Del', name: 'Delete' }],
  [
    { id: 'hide', label: 'Hide', w: 1.5, name: 'Hide the keyboard' },
    { id: 'mod:alt', label: 'Alt', w: 1.25 },
    { id: ' ', label: 'Space', w: 6, name: 'Space' },
    { id: 'Home', label: 'Home' },
    { id: 'End', label: 'End' },
    { id: 'ArrowLeft', label: '←', name: 'Left' },
    { id: 'ArrowDown', label: '↓', name: 'Down' },
    { id: 'ArrowRight', label: '→', name: 'Right' },
  ],
];

/** What a key shows with Shift latched: capitals and the US shift symbols. */
export function shiftedLabel(def: KeyDef): string {
  if (def.id.length !== 1) return def.label;
  return SHIFTED[def.id] ?? def.id.toUpperCase();
}

/** How the panel names the command palette's shortcut: its keyboard has Ctrl and no ⌘. */
export const COMMANDS_SHORTCUT = 'Ctrl+K';

/**
 * Whether a press is the panel keyboard's Ctrl+K and the page won't open the palette for it by itself:
 * main.ts listens for ⌘K on a Mac-reported platform and Ctrl+K everywhere else.
 */
export function nativeCommandsKey(e: PaletteKey, mac: boolean): boolean {
  return mac && isPaletteKey(e, false);
}

/** The press a key makes with the latched modifiers, as a KeyboardEvent would describe it. */
export function pressOf(id: string, mods: ReadonlySet<Modifier>): KeyLike {
  const shift = mods.has('shift');
  let key = id;
  if (id.length === 1 && shift) key = SHIFTED[id] ?? id.toUpperCase();
  return { key, ctrlKey: mods.has('ctrl'), altKey: mods.has('alt'), shiftKey: shift, metaKey: false };
}

/** The KeyboardEvent `code` of a press, so page keybinds that read codes (walking, emotes) see the same key. */
export function codeOf(key: string): string {
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  const unshifted = Object.entries(SHIFTED).find(([, v]) => v === key)?.[0];
  const base = unshifted ?? key;
  if (/^[0-9]$/.test(base)) return `Digit${base}`;
  const named: Record<string, string> = {
    ' ': 'Space',
    '`': 'Backquote',
    '-': 'Minus',
    '=': 'Equal',
    '[': 'BracketLeft',
    ']': 'BracketRight',
    '\\': 'Backslash',
    ';': 'Semicolon',
    "'": 'Quote',
    ',': 'Comma',
    '.': 'Period',
    '/': 'Slash',
  };
  return named[base] ?? base;
}

/**
 * The bytes a press types into a worker's terminal, or null when it types nothing there.
 * `appCursor` is the terminal's application cursor mode (DECCKM), which shells and TUIs switch on:
 * then, as in xterm, the bare arrows, Home and End send `ESC O x` instead of `ESC [ x`.
 */
export function terminalBytes(k: KeyLike, csiEnter: boolean, appCursor = false): string | null {
  if (k.key === 'Enter') {
    const enter = modifiedEnter(csiEnter, { ctrl: k.ctrlKey, shift: k.shiftKey, alt: k.altKey, meta: k.metaKey });
    if (enter !== undefined) return enter;
  }
  const bytes = keyBytes(k);
  if (appCursor && bytes && /^\x1b\[[ABCDHF]$/.test(bytes)) return `\x1bO${bytes[2]}`;
  return bytes;
}

/** A text field's value and selection, the way HTMLInputElement reports them. */
export interface TextState {
  value: string;
  start: number;
  end: number;
  dir?: 'forward' | 'backward' | 'none';
}

/** An edit to a text field; `inserted` is the text typed, for the input event's `data`. */
export interface TextEdit extends TextState {
  changed: boolean;
  inputType?: 'insertText' | 'insertLineBreak' | 'deleteContentBackward' | 'deleteContentForward' | 'deleteWordBackward' | 'deleteWordForward';
  inserted?: string;
}

const isLow = (v: string, i: number) => {
  const c = v.charCodeAt(i);
  return c >= 0xdc00 && c <= 0xdfff;
};
const isHigh = (v: string, i: number) => {
  const c = v.charCodeAt(i);
  return c >= 0xd800 && c <= 0xdbff;
};
/** One character back from `i`, stepping over a whole surrogate pair (an emoji is one character). */
function prevIndex(v: string, i: number): number {
  if (i <= 0) return 0;
  return i >= 2 && isLow(v, i - 1) && isHigh(v, i - 2) ? i - 2 : i - 1;
}
function nextIndex(v: string, i: number): number {
  if (i >= v.length) return v.length;
  return isHigh(v, i) && isLow(v, i + 1) ? i + 2 : i + 1;
}
const isWord = (ch: string | undefined) => !!ch && /[\p{L}\p{N}_]/u.test(ch);
function wordLeft(v: string, i: number): number {
  while (i > 0 && !isWord(v[i - 1])) i--;
  while (i > 0 && isWord(v[i - 1])) i--;
  return i;
}
function wordRight(v: string, i: number): number {
  while (i < v.length && !isWord(v[i])) i++;
  while (i < v.length && isWord(v[i])) i++;
  return i;
}
const lineStart = (v: string, i: number) => v.lastIndexOf('\n', i - 1) + 1;
function lineEnd(v: string, i: number): number {
  const n = v.indexOf('\n', i);
  return n < 0 ? v.length : n;
}

/** Where the moving end of the selection is. */
function focusOf(s: TextState): number {
  return s.dir === 'backward' ? s.start : s.end;
}
function anchorOf(s: TextState): number {
  return s.dir === 'backward' ? s.end : s.start;
}

function moveTo(s: TextState, to: number, extend: boolean): TextEdit {
  if (!extend) return { value: s.value, start: to, end: to, dir: 'none', changed: false };
  const anchor = anchorOf(s);
  return { value: s.value, start: Math.min(anchor, to), end: Math.max(anchor, to), dir: to < anchor ? 'backward' : 'forward', changed: false };
}

function replace(s: TextState, from: number, to: number, text: string, inputType: TextEdit['inputType']): TextEdit {
  const at = from + text.length;
  return { value: s.value.slice(0, from) + text + s.value.slice(to), start: at, end: at, dir: 'none', changed: true, inputType, inserted: text || undefined };
}

/** `text` typed (or pasted) over the selection. */
export function insertText(s: TextState, text: string): TextEdit {
  const start = Math.max(0, Math.min(s.start, s.value.length));
  const end = Math.max(start, Math.min(s.end, s.value.length));
  return replace({ ...s, start, end }, start, end, text, 'insertText');
}

/**
 * What a press does to a text field the way a browser's own editing would, or null when the field
 * leaves it alone (Esc, Tab, a Ctrl chord other than Ctrl+A, Enter in a one-line field).
 */
export function editText(s: TextState, k: KeyLike, multiline: boolean): TextEdit | null {
  const { value } = s;
  const start = Math.max(0, Math.min(s.start, value.length));
  const end = Math.max(start, Math.min(s.end, value.length));
  const st: TextState = { value, start, end, dir: s.dir };
  const collapsed = start === end;
  const word = k.ctrlKey || k.altKey;
  switch (k.key) {
    case 'Backspace':
      if (!collapsed) return replace(st, start, end, '', 'deleteContentBackward');
      if (start === 0) return { ...st, changed: false };
      return replace(st, word ? wordLeft(value, start) : prevIndex(value, start), start, '', word ? 'deleteWordBackward' : 'deleteContentBackward');
    case 'Delete':
      if (!collapsed) return replace(st, start, end, '', 'deleteContentForward');
      if (end === value.length) return { ...st, changed: false };
      return replace(st, start, word ? wordRight(value, start) : nextIndex(value, start), '', word ? 'deleteWordForward' : 'deleteContentForward');
    case 'ArrowLeft': {
      if (!collapsed && !k.shiftKey) return moveTo(st, start, false);
      const f = focusOf(st);
      return moveTo(st, word ? wordLeft(value, f) : prevIndex(value, f), k.shiftKey);
    }
    case 'ArrowRight': {
      if (!collapsed && !k.shiftKey) return moveTo(st, end, false);
      const f = focusOf(st);
      return moveTo(st, word ? wordRight(value, f) : nextIndex(value, f), k.shiftKey);
    }
    case 'Home':
      return moveTo(st, multiline && !k.ctrlKey ? lineStart(value, focusOf(st)) : 0, k.shiftKey);
    case 'End':
      return moveTo(st, multiline && !k.ctrlKey ? lineEnd(value, focusOf(st)) : value.length, k.shiftKey);
    case 'ArrowUp':
    case 'ArrowDown': {
      const f = focusOf(st);
      if (!multiline) return moveTo(st, k.key === 'ArrowUp' ? 0 : value.length, k.shiftKey);
      const col = f - lineStart(value, f);
      if (k.key === 'ArrowUp') {
        const from = lineStart(value, f);
        if (from === 0) return moveTo(st, 0, k.shiftKey);
        const prev = lineStart(value, from - 1);
        return moveTo(st, Math.min(prev + col, from - 1), k.shiftKey);
      }
      const next = lineEnd(value, f);
      if (next === value.length) return moveTo(st, value.length, k.shiftKey);
      return moveTo(st, Math.min(next + 1 + col, lineEnd(value, next + 1)), k.shiftKey);
    }
    case 'Enter':
      return multiline && !k.ctrlKey && !k.altKey ? replace(st, start, end, '\n', 'insertLineBreak') : null;
  }
  if (k.ctrlKey && !k.altKey && k.key.toLowerCase() === 'a') return { value, start: 0, end: value.length, dir: 'forward', changed: false };
  if (k.ctrlKey || k.altKey || k.metaKey || [...k.key].length !== 1) return null;
  return replace(st, start, end, k.key, 'insertText');
}

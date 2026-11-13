import { CTRL_ENTER, enterKeyAction, type KeyAction, type KeyEventLike } from './csi-enter.js';
import { CLEAR_DROID_QUEUE } from './droid-queue.js';

/**
 * Kitty terminal protocol support shared by the PTY host, server, 3D office, web companion and tests:
 *   1. Progressive keyboard enhancement (`CSI u`: flags 1..16, main/alt stacks, key encoding)
 *   2. Terminal graphics protocol (`APC G`: chunked `t=d` uploads, `U=1` Unicode placeholders,
 *      direct placements, animation frames `a=f`/`a=a`, deletes `a=d`, queries `a=q`, snapshot replay)
 *
 * Pure ES2022 (no Node or DOM globals) per src/shared/AGENTS.md.
 */

// ---------------------------------------------------------------------------
// 1. Kitty Keyboard Protocol (CSI u)
// ---------------------------------------------------------------------------

export const KITTY_KB_DISAMBIGUATE = 1;
export const KITTY_KB_REPORT_EVENTS = 2;
export const KITTY_KB_REPORT_ALTERNATE = 4;
export const KITTY_KB_REPORT_ALL = 8;
export const KITTY_KB_REPORT_TEXT = 16;
export const KITTY_KB_ALL_FLAGS = 31;

const MAX_KB_STACK = 16;

/** Per-terminal Kitty keyboard flag stacks (separate for normal and alternate screen buffers). */
export class KittyKeyboardState {
  private mainFlags = 0;
  private altFlags = 0;
  private mainStack: number[] = [];
  private altStack: number[] = [];
  private alt = false;

  get flags(): number {
    return this.alt ? this.altFlags : this.mainFlags;
  }

  get isAlternate(): boolean {
    return this.alt;
  }

  setAlternate(on: boolean): void {
    this.alt = on;
  }

  /** `CSI = flags ; mode u`: mode 1 = set, 2 = OR, 3 = AND-NOT. */
  set(rawFlags = 0, mode = 1): void {
    const f = rawFlags & KITTY_KB_ALL_FLAGS;
    const cur = this.flags;
    const next = mode === 2 ? (cur | f) & KITTY_KB_ALL_FLAGS : mode === 3 ? cur & ~f : mode === 1 ? f : cur;
    if (this.alt) this.altFlags = next;
    else this.mainFlags = next;
  }

  /** `CSI > flags u`: push current flags onto active stack and set new flags. */
  push(rawFlags = 0): void {
    const stack = this.alt ? this.altStack : this.mainStack;
    stack.push(this.flags);
    if (stack.length > MAX_KB_STACK) stack.shift();
    const next = rawFlags & KITTY_KB_ALL_FLAGS;
    if (this.alt) this.altFlags = next;
    else this.mainFlags = next;
  }

  /** `CSI < count u`: pop `count` entries from active stack (default 1; empty stack resets to 0). */
  pop(rawCount = 1): void {
    const count = rawCount > 0 ? rawCount : 1;
    const stack = this.alt ? this.altStack : this.mainStack;
    let next = 0;
    for (let i = 0; i < count; i++) next = stack.pop() ?? 0;
    if (this.alt) this.altFlags = next;
    else this.mainFlags = next;
  }

  /** `CSI ? u` reply for the currently active buffer. */
  queryReply(): string {
    return `\x1b[?${this.flags}u`;
  }

  reset(): void {
    this.mainFlags = 0;
    this.altFlags = 0;
    this.mainStack = [];
    this.altStack = [];
    this.alt = false;
  }

  /**
   * Escape sequence suffix that restores the active buffer's Kitty keyboard stack and flags
   * after `SerializeAddon.serialize()`. Empty when no flags or stack entries are active.
   */
  serialize(): string {
    const stack = this.alt ? this.altStack : this.mainStack;
    const top = this.flags;
    if (!stack.length && !top) return '';
    const all = [...stack, top];
    let out = all[0] ? `\x1b[=${all[0]};1u` : '';
    for (let i = 1; i < all.length; i++) out += `\x1b[>${all[i]}u`;
    return out;
  }
}

export interface KittyKeyEvent extends KeyEventLike {
  code?: string;
  keyCode?: number;
  repeat?: boolean;
  location?: number;
}

export interface KittyEncodeOpts {
  /** Fallback `Ctrl+Enter` / `Shift+Enter` CSI u for Droid when `flags === 0`. */
  csiEnter?: boolean;
  /** DECSET 1 (`DECCKM`) application cursor mode for unmodified arrow/home/end keys. */
  appCursor?: boolean;
}

/** Functional keys encoded as `CSI <number> ; <mod> u` (or `CSI <number> u`). */
const CSI_U_FUNCTIONAL: Record<string, number> = {
  Escape: 27,
  Enter: 13,
  Tab: 9,
  Backspace: 127,
  CapsLock: 57358,
  ScrollLock: 57359,
  NumLock: 57360,
  PrintScreen: 57361,
  Pause: 57362,
  ContextMenu: 57363,
  F13: 57376,
  F14: 57377,
  F15: 57378,
  F16: 57379,
  F17: 57380,
  F18: 57381,
  F19: 57382,
  F20: 57383,
  F21: 57384,
  F22: 57385,
  F23: 57386,
  F24: 57387,
};

/** Keypad `e.code` values -> Kitty PUA codepoints (`57399..57426`). */
const KEYPAD_CODES: Record<string, number> = {
  Numpad0: 57399,
  Numpad1: 57400,
  Numpad2: 57401,
  Numpad3: 57402,
  Numpad4: 57403,
  Numpad5: 57404,
  Numpad6: 57405,
  Numpad7: 57406,
  Numpad8: 57407,
  Numpad9: 57408,
  NumpadDecimal: 57409,
  NumpadDivide: 57410,
  NumpadMultiply: 57411,
  NumpadSubtract: 57412,
  NumpadAdd: 57413,
  NumpadEnter: 57414,
  NumpadEqual: 57415,
  NumpadComma: 57416,
};

/** Modifier-only keys reported only under `KITTY_KB_REPORT_ALL` (flag 8). */
const MODIFIER_KEYS: Record<string, number> = {
  ShiftLeft: 57441,
  ControlLeft: 57442,
  AltLeft: 57443,
  MetaLeft: 57444,
  ShiftRight: 57447,
  ControlRight: 57448,
  AltRight: 57449,
  MetaRight: 57450,
  Shift: 57441,
  Control: 57442,
  Alt: 57443,
  Meta: 57444,
};

/** Keys using final letter `CSI 1 ; <mod> <final>` (arrows, Home/End, F1..F4). */
const CSI_LETTER_KEYS: Record<string, { final: string; ss3?: boolean }> = {
  ArrowUp: { final: 'A', ss3: true },
  ArrowDown: { final: 'B', ss3: true },
  ArrowRight: { final: 'C', ss3: true },
  ArrowLeft: { final: 'D', ss3: true },
  Home: { final: 'H', ss3: true },
  End: { final: 'F', ss3: true },
  F1: { final: 'P', ss3: true },
  F2: { final: 'Q', ss3: true },
  F3: { final: 'R', ss3: true },
  F4: { final: 'S', ss3: true },
};

/** Keys using `CSI <num> ; <mod> ~`. */
const CSI_TILDE_KEYS: Record<string, number> = {
  Insert: 2,
  Delete: 3,
  PageUp: 5,
  PageDown: 6,
  F5: 15,
  F6: 17,
  F7: 18,
  F8: 19,
  F9: 20,
  F10: 21,
  F11: 23,
  F12: 24,
};

/** US layout unshifted base character from `KeyboardEvent.code`, for `Shift`/`Ctrl` base key resolution. */
function baseCodepointFromCode(code: string | undefined): number | undefined {
  if (!code) return undefined;
  if (code.length === 4 && code.startsWith('Key')) {
    const ch = code.charCodeAt(3);
    if (ch >= 65 && ch <= 90) return ch + 32; // 'a'..'z'
  }
  if (code.length === 6 && code.startsWith('Digit')) {
    const ch = code.charCodeAt(5);
    if (ch >= 48 && ch <= 57) return ch; // '0'..'9'
  }
  switch (code) {
    case 'Space':
      return 32;
    case 'Minus':
      return 45;
    case 'Equal':
      return 61;
    case 'BracketLeft':
      return 91;
    case 'BracketRight':
      return 93;
    case 'Backslash':
      return 92;
    case 'Semicolon':
      return 59;
    case 'Quote':
      return 39;
    case 'Backquote':
      return 96;
    case 'Comma':
      return 44;
    case 'Period':
      return 46;
    case 'Slash':
      return 47;
    default:
      return undefined;
  }
}

function isHostShortcut(e: KittyKeyEvent): boolean {
  // Let browser / Electron / app handle Cmd+* shortcuts on macOS and standard clipboard combos.
  if (e.metaKey) return true;
  if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'V' || e.key === 'c' || e.key === 'v')) return true;
  if ((e.ctrlKey || e.shiftKey) && e.key === 'Insert') return true;
  return false;
}

function formatCsiU(codepoint: number, shifted: number | undefined, mod: number, eventType: number, textCp: number | undefined): string {
  const keyPart = shifted && shifted !== codepoint ? `${codepoint}:${shifted}` : `${codepoint}`;
  const evSuffix = eventType > 1 ? `:${eventType}` : '';
  const hasText = textCp !== undefined && textCp >= 32 && textCp !== 127;
  if (mod === 1 && !evSuffix && !hasText) return `\x1b[${keyPart}u`;
  const modPart = `${mod}${evSuffix}`;
  if (!hasText) return `\x1b[${keyPart};${modPart}u`;
  return `\x1b[${keyPart};${modPart};${textCp}u`;
}

/**
 * Decides how a terminal DOM `KeyboardEvent` should be handled given negotiated Kitty keyboard `flags`.
 * When `flags === 0`, falls back to `enterKeyAction(csiEnter, e)`.
 */
export function encodeKittyKey(e: KittyKeyEvent, flags: number, opts: KittyEncodeOpts = {}): KeyAction {
  if (e.isComposing || e.keyCode === 229 || e.key === 'Dead' || e.key === 'Process') return { do: 'default' };
  if (isHostShortcut(e)) return { do: 'default' };
  if (!flags) return enterKeyAction(opts.csiEnter ?? false, e);

  const reportEvents = (flags & KITTY_KB_REPORT_EVENTS) !== 0;
  const reportAlt = (flags & KITTY_KB_REPORT_ALTERNATE) !== 0;
  const reportAll = (flags & KITTY_KB_REPORT_ALL) !== 0;
  const reportText = (flags & KITTY_KB_REPORT_TEXT) !== 0;

  if (e.type === 'keypress') {
    // xterm types Space and Shift+A..Z on keypress, not keydown, so swallow a keypress only when its keydown already sent bytes.
    const press: KittyKeyEvent = {
      type: 'keydown',
      key: e.key,
      code: e.code,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      metaKey: e.metaKey,
      repeat: e.repeat,
    };
    return encodeKittyKey(press, flags, opts).do === 'send' ? { do: 'swallow' } : { do: 'default' };
  }
  if (e.type === 'keyup') {
    if (!reportEvents) return { do: 'default' };
  } else if (e.type !== 'keydown') {
    return { do: 'default' };
  }

  const eventType = e.type === 'keyup' ? 3 : e.repeat && reportEvents ? 2 : 1;
  const mod = 1 + (e.shiftKey ? 1 : 0) + (e.altKey ? 2 : 0) + (e.ctrlKey ? 4 : 0);

  // Modifier-only presses/releases are reported only when flag 8 (REPORT_ALL) is enabled.
  const modCode = (e.code && MODIFIER_KEYS[e.code]) || MODIFIER_KEYS[e.key];
  if (modCode) {
    if (!reportAll) return { do: 'default' };
    return { do: 'send', data: formatCsiU(modCode, undefined, mod, eventType, undefined) };
  }

  // 1. Letter-terminated functional keys (arrows, Home/End, F1..F4).
  const letterKey = CSI_LETTER_KEYS[e.key];
  if (letterKey) {
    if (mod === 1 && eventType === 1) {
      if (e.key === 'F1' || e.key === 'F2' || e.key === 'F3' || e.key === 'F4') {
        return { do: 'send', data: `\x1bO${letterKey.final}` };
      }
      const prefix = letterKey.ss3 && opts.appCursor ? '\x1bO' : '\x1b[';
      return { do: 'send', data: `${prefix}${letterKey.final}` };
    }
    const evSuffix = eventType > 1 ? `:${eventType}` : '';
    return { do: 'send', data: `\x1b[1;${mod}${evSuffix}${letterKey.final}` };
  }

  // 2. Tilde-terminated functional keys (Insert, Delete, PageUp, PageDown, F5..F12).
  const tildeNum = CSI_TILDE_KEYS[e.key];
  if (tildeNum !== undefined) {
    // Allow Shift+PageUp / Shift+PageDown to scroll local xterm scrollback when unmodified by Ctrl/Alt?
    // Keep xterm's Shift+PageUp/PageDown scrollback shortcut when not in alternate screen unless Ctrl/Alt held.
    if ((e.key === 'PageUp' || e.key === 'PageDown') && e.shiftKey && !e.ctrlKey && !e.altKey && !reportAll) {
      return { do: 'default' };
    }
    const evSuffix = eventType > 1 ? `:${eventType}` : '';
    if (mod === 1 && !evSuffix) return { do: 'send', data: `\x1b[${tildeNum}~` };
    return { do: 'send', data: `\x1b[${tildeNum};${mod}${evSuffix}~` };
  }

  // 3. Keypad keys & functional CSI u keys (Enter, Tab, Escape, Backspace, F13..F24, Lock keys).
  const kpCode = e.code ? KEYPAD_CODES[e.code] : undefined;
  const funcCode = kpCode ?? CSI_U_FUNCTIONAL[e.key];
  if (funcCode !== undefined) {
    // Under flags without REPORT_ALL (8), unmodified Enter, Tab and Backspace press send legacy bytes.
    if (!reportAll && mod === 1 && eventType === 1) {
      if (funcCode === 13) return { do: 'send', data: '\r' };
      if (funcCode === 9) return { do: 'send', data: '\t' };
      if (funcCode === 127) return { do: 'send', data: '\x7f' };
    }
    return { do: 'send', data: formatCsiU(funcCode, undefined, mod, eventType, undefined) };
  }

  // 4. Printable / text keys (`e.key` is a single Unicode grapheme/codepoint, e.g. 'a', 'A', '!', ' ', 'é').
  const cps = [...e.key];
  if (cps.length === 1) {
    const actualCp = cps[0].codePointAt(0)!;
    // Plain typing (no Ctrl/Alt, press event, REPORT_ALL off): let xterm/IME emit UTF-8 text normally,
    // except modified Space (`Shift+Space` / `Ctrl+Space` / `Alt+Space`) which is ambiguous in legacy mode.
    const isModifiedSpace = actualCp === 32 && mod > 1;
    if (!reportAll && !e.ctrlKey && !e.altKey && !isModifiedSpace && eventType === 1) {
      return { do: 'default' };
    }
    const fromCode = baseCodepointFromCode(e.code);
    const lowerCp = cps[0].toLowerCase().codePointAt(0)!;
    const baseCp = fromCode ?? lowerCp;
    const shiftedCp = reportAlt && e.shiftKey && actualCp !== baseCp ? actualCp : undefined;
    const textCp = reportText && eventType !== 3 && !e.ctrlKey && !e.altKey ? actualCp : undefined;
    return { do: 'send', data: formatCsiU(baseCp, shiftedCp, mod, eventType, textCp) };
  }

  return { do: 'default' };
}

/** Matches `Ctrl+Enter` presses/repeats in both fixed (`\x1b[13;5u`) and extended Kitty CSI u forms, ignoring `:3` keyup. */
const CTRL_ENTER_CSI_RE = /\x1b\[(?:13|57414)(?::\d+)?;5(?::[12])?(?:;\d+)?u/g;

/** Counts `Ctrl+Enter` submissions in a raw input chunk so `workers.ts` tracks Droid's queued turns accurately. */
export function countCtrlEnterInputs(data: string): number {
  if (!data.includes('\x1b[')) return 0;
  if (data === CTRL_ENTER) return 1;
  let count = 0;
  CTRL_ENTER_CSI_RE.lastIndex = 0;
  while (CTRL_ENTER_CSI_RE.exec(data)) count++;
  return count;
}

/** Whether `data` is `Ctrl+X` (legacy `\x18` or Kitty `CSI 120 ; 5 u` press/repeat) that clears Droid's queue. */
export function isClearQueueInput(data: string): boolean {
  if (data === CLEAR_DROID_QUEUE) return true;
  return /^\x1b\[120(?::\d+)?;5(?::[12])?(?:;\d+)?u$/.test(data);
}

/** Whether `data` is `Escape` or `Ctrl+C` (legacy `\x1b` / `\x03` or Kitty `CSI 27 u` / `CSI 99;5 u` press). */
export function isCancelInput(data: string): boolean {
  if (data === '\x1b' || data === '\x03') return true;
  return /^\x1b\[27(?:;1(?::[12])?)?u$/.test(data) || /^\x1b\[99(?::\d+)?;5(?::[12])?(?:;\d+)?u$/.test(data);
}

// ---------------------------------------------------------------------------
// 2. Kitty Graphics Protocol (`APC G` + `U=1` Unicode Placeholders)
// ---------------------------------------------------------------------------

/**
 * Cell size in device pixels that the PTY owner reports for `CSI 16 t` (and `CSI 14 t` window size): a 9×18 CSS
 * cell at 2× density, as Kitty and Ghostty report on Retina displays. Image CLIs downsample each inline image to
 * `cols × cell` by `rows × cell` pixels before sending it (Droid caps images at 12 rows), so this sets the
 * resolution every mirror and the expanded viewer receive. It is also the implied cell size for placements that
 * omit `c`/`r`, so every mirror moves the cursor by the same number of cells as the PTY owner.
 */
export const KITTY_CELL_PX_W = 18;
export const KITTY_CELL_PX_H = 36;

/** Unicode Private Use Area character reserved by Kitty for `U=1` virtual image cells. */
export const KITTY_PLACEHOLDER_CP = 0x10eeee;
export const KITTY_PLACEHOLDER_CHAR = '\udbfb\udeee';

/**
 * Exact 297-entry combining diacritic table from Kitty's `rowcolumn-diacritics.txt`
 * (verified byte-identical to Factory Droid CLI's `wt` table).
 */
export const KITTY_DIACRITICS: readonly number[] = [
  773, 781, 782, 784, 786, 829, 830, 831, 838, 842, 843, 844, 848, 849, 850, 855, 859, 867, 868, 869, 870, 871, 872, 873, 874, 875, 876, 877, 878, 879, 1155, 1156, 1157, 1158, 1159, 1426, 1427, 1428, 1429, 1431, 1432, 1433, 1436, 1437,
  1438, 1439, 1440, 1441, 1448, 1449, 1451, 1452, 1455, 1476, 1552, 1553, 1554, 1555, 1556, 1557, 1558, 1559, 1623, 1624, 1625, 1626, 1627, 1629, 1630, 1750, 1751, 1752, 1753, 1754, 1755, 1756, 1759, 1760, 1761, 1762, 1764, 1767, 1768,
  1771, 1772, 1840, 1842, 1843, 1845, 1846, 1850, 1853, 1855, 1856, 1857, 1859, 1861, 1863, 1865, 1866, 2027, 2028, 2029, 2030, 2031, 2032, 2033, 2035, 2070, 2071, 2072, 2073, 2075, 2076, 2077, 2078, 2079, 2080, 2081, 2082, 2083, 2085,
  2086, 2087, 2089, 2090, 2091, 2092, 2093, 2385, 2387, 2388, 3970, 3971, 3974, 3975, 4957, 4958, 4959, 6109, 6458, 6679, 6773, 6774, 6775, 6776, 6777, 6778, 6779, 6780, 7019, 7021, 7022, 7023, 7024, 7025, 7026, 7027, 7376, 7377, 7378,
  7386, 7387, 7392, 7616, 7617, 7619, 7620, 7621, 7622, 7623, 7624, 7625, 7627, 7628, 7633, 7634, 7635, 7636, 7637, 7638, 7639, 7640, 7641, 7642, 7643, 7644, 7645, 7646, 7647, 7648, 7649, 7650, 7651, 7652, 7653, 7654, 7678, 8400, 8401,
  8404, 8405, 8406, 8407, 8411, 8412, 8417, 8423, 8425, 8432, 11503, 11504, 11505, 11744, 11745, 11746, 11747, 11748, 11749, 11750, 11751, 11752, 11753, 11754, 11755, 11756, 11757, 11758, 11759, 11760, 11761, 11762, 11763, 11764, 11765,
  11766, 11767, 11768, 11769, 11770, 11771, 11772, 11773, 11774, 11775, 42607, 42620, 42621, 42736, 42737, 43232, 43233, 43234, 43235, 43236, 43237, 43238, 43239, 43240, 43241, 43242, 43243, 43244, 43245, 43246, 43247, 43248, 43249, 43696,
  43698, 43699, 43703, 43704, 43710, 43711, 43713, 65056, 65057, 65058, 65059, 65060, 65061, 65062, 68111, 68152, 119173, 119174, 119175, 119176, 119177, 119210, 119211, 119212, 119213, 119362, 119363, 119364,
];

const DIACRITIC_MAP = new Map<number, number>(KITTY_DIACRITICS.map((cp, idx) => [cp, idx]));

/** Fast check for whether a cell string starts with `U+10EEEE`. */
export function isKittyPlaceholderCell(chars: string): boolean {
  return chars.length >= 2 && chars.charCodeAt(0) === 0xdbfb && chars.charCodeAt(1) === 0xdeee;
}

/** Strips `U+10EEEE` and its trailing combining diacritics from plain-text strings, replacing each cell with `replacement`. */
export function stripKittyPlaceholders(text: string, replacement = ''): string {
  if (!text.includes(KITTY_PLACEHOLDER_CHAR)) return text;
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text.charCodeAt(i) === 0xdbfb && text.charCodeAt(i + 1) === 0xdeee) {
      i += 2;
      while (i < text.length) {
        const cp = text.codePointAt(i)!;
        const step = cp > 0xffff ? 2 : 1;
        // Skip Kitty row/col diacritics and standard Unicode combining mark blocks.
        if (DIACRITIC_MAP.has(cp) || (cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x1ab0 && cp <= 0x1aff) || (cp >= 0x1dc0 && cp <= 0x1dff) || (cp >= 0x20d0 && cp <= 0x20ff) || (cp >= 0xfe20 && cp <= 0xfe2f)) {
          i += step;
        } else {
          break;
        }
      }
      out += replacement;
      continue;
    }
    const cp = text.codePointAt(i)!;
    const step = cp > 0xffff ? 2 : 1;
    out += text.slice(i, i + step);
    i += step;
  }
  return out;
}

export interface DecodedPlaceholder {
  imageId: number;
  placementId: number;
  row: number;
  col: number;
  msb: number;
}

/**
 * Decodes a single `U+10EEEE` cell given its cell `chars`, foreground 24-bit/palette integer `fgLow24`
 * (`0` if default fg), optional underline color `underlineLow24`, and the previous cell on the same row.
 */
export function decodePlaceholderCell(chars: string, fgLow24: number, underlineLow24 = 0, prev?: DecodedPlaceholder): DecodedPlaceholder | undefined {
  if (!isKittyPlaceholderCell(chars)) return undefined;
  let dCount = 0;
  let d0 = -1;
  let d1 = -1;
  let d2 = -1;
  let i = 2;
  while (i < chars.length && dCount < 3) {
    const cp = chars.codePointAt(i)!;
    i += cp > 0xffff ? 2 : 1;
    const idx = DIACRITIC_MAP.get(cp);
    if (idx !== undefined) {
      if (dCount === 0) d0 = idx;
      else if (dCount === 1) d1 = idx;
      else d2 = idx;
      dCount++;
    }
  }
  const baseId = fgLow24 & 0xffffff;
  const placementId = underlineLow24 & 0xffffff;
  let msb = 0;
  if (dCount >= 3) msb = d2 & 0xff;
  else if (prev && (prev.imageId & 0xffffff) === baseId && prev.placementId === placementId) msb = prev.msb;
  const imageId = (((msb & 0xff) << 24) | baseId) >>> 0;
  if (!imageId) return undefined;

  const samePrev = prev && prev.imageId === imageId && prev.placementId === placementId;
  let row = 0;
  let col = 0;
  if (dCount === 0) {
    if (samePrev) {
      row = prev.row;
      col = prev.col + 1;
    }
  } else if (dCount === 1) {
    row = d0;
    if (samePrev && prev.row === row) col = prev.col + 1;
  } else {
    row = d0;
    col = d1;
  }
  return { imageId, placementId, row, col, msb };
}

// --- Streaming APC G parser ---

export type KittyStreamSegment = { type: 'text'; data: string } | { type: 'apc'; body: string };

const MAX_APC_LEN = 16 * 1024 * 1024;

/**
 * Splits arbitrary terminal output chunks into interleaved `'text'` and `'apc'` (`ESC _ G ... ST/BEL`)
 * segments, preserving exact byte ordering even when chunks split mid-escape or mid-base64.
 */
export class KittyApcSplitter {
  private state: 'ground' | 'esc' | 'apc_start' | 'apc' | 'apc_esc' = 'ground';
  private apcBuf = '';

  reset(): void {
    this.state = 'ground';
    this.apcBuf = '';
  }

  feed(chunk: string): KittyStreamSegment[] {
    if (!chunk) return [];
    // Fast path when ground state and chunk has no ESC or C1 APC.
    if (this.state === 'ground' && !chunk.includes('\x1b') && !chunk.includes('\x9f')) {
      return [{ type: 'text', data: chunk }];
    }
    const out: KittyStreamSegment[] = [];
    let textStart = this.state === 'ground' ? 0 : -1;
    let prefixText = '';
    const emitText = (endIdx: number) => {
      const part = prefixText + (textStart >= 0 && endIdx > textStart ? chunk.slice(textStart, endIdx) : '');
      prefixText = '';
      textStart = -1;
      if (part) {
        const last = out[out.length - 1];
        if (last?.type === 'text') last.data += part;
        else out.push({ type: 'text', data: part });
      }
    };

    for (let i = 0; i < chunk.length; i++) {
      const code = chunk.charCodeAt(i);
      switch (this.state) {
        case 'ground': {
          if (code === 0x1b) {
            emitText(i);
            this.state = 'esc';
          } else if (code === 0x9f) {
            emitText(i);
            this.state = 'apc_start';
          }
          break;
        }
        case 'esc': {
          if (code === 0x5f /* '_' */) {
            this.state = 'apc_start';
          } else if (code === 0x1b) {
            prefixText += '\x1b';
          } else {
            prefixText += `\x1b${chunk[i]}`;
            textStart = i + 1;
            this.state = 'ground';
          }
          break;
        }
        case 'apc_start': {
          if (code === 0x47 /* 'G' */) {
            this.apcBuf = '';
            this.state = 'apc';
          } else {
            // Non-Kitty APC: pass back to xterm so xterm's own parser ignores it cleanly.
            prefixText += `\x1b_${chunk[i]}`;
            textStart = i + 1;
            this.state = 'ground';
          }
          break;
        }
        case 'apc': {
          if (code === 0x1b) {
            this.state = 'apc_esc';
          } else if (code === 0x07 || code === 0x9c) {
            out.push({ type: 'apc', body: this.apcBuf });
            this.apcBuf = '';
            textStart = i + 1;
            this.state = 'ground';
          } else {
            this.apcBuf += chunk[i];
            if (this.apcBuf.length > MAX_APC_LEN) {
              this.apcBuf = '';
              textStart = i + 1;
              this.state = 'ground';
            }
          }
          break;
        }
        case 'apc_esc': {
          if (code === 0x5c /* '\\' */) {
            out.push({ type: 'apc', body: this.apcBuf });
            this.apcBuf = '';
            textStart = i + 1;
            this.state = 'ground';
          } else if (code === 0x1b) {
            this.apcBuf += '\x1b';
          } else {
            // Unexpected ESC inside APC terminates the malformed APC and restarts ESC parsing.
            this.apcBuf = '';
            prefixText += `\x1b${chunk[i]}`;
            textStart = i + 1;
            this.state = 'ground';
          }
          break;
        }
      }
    }

    if (this.state === 'ground') emitText(chunk.length);
    return out;
  }
}

export type KittyImageFormat = 24 | 32 | 100;

export interface KittyAnimationFrame {
  format: KittyImageFormat;
  compression?: 'z';
  width: number;
  height: number;
  delayMs: number;
  data: string;
}

export interface KittyImageRecord {
  id: number;
  number?: number;
  format: KittyImageFormat;
  compression?: 'z';
  width: number;
  height: number;
  cols?: number;
  rows?: number;
  unicode?: boolean;
  /** Base64 payload of the root frame. */
  data: string;
  rootDelayMs?: number;
  frames: KittyAnimationFrame[];
  /** Animation state from `a=a,s=...` (`1` = stopped, `2` = loading, `3` = looping). */
  animState?: number;
}

export interface KittyControlParams {
  a?: string;
  f?: number;
  t?: string;
  o?: string;
  i?: number;
  I?: number;
  p?: number;
  q?: number;
  m?: number;
  s?: number;
  v?: number;
  c?: number;
  r?: number;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  X?: number;
  Y?: number;
  C?: number;
  z?: number;
  U?: number;
  d?: string;
  /** Preserves whether `U=1` was set on a query so the reply echoes `,U=1` for capability probes. */
  rawKeys?: ReadonlySet<string>;
}

const NUMERIC_KEYS = new Set(['f', 'i', 'I', 'p', 'q', 'm', 's', 'v', 'c', 'r', 'x', 'y', 'w', 'h', 'X', 'Y', 'C', 'z', 'U']);

export function parseKittyControl(body: string): { params: KittyControlParams; payload: string } {
  const semi = body.indexOf(';');
  const head = semi >= 0 ? body.slice(0, semi) : body;
  const payload = semi >= 0 ? body.slice(semi + 1) : '';
  const params: Record<string, unknown> = {};
  const keys = new Set<string>();
  if (head) {
    for (const part of head.split(',')) {
      const eq = part.indexOf('=');
      if (eq <= 0) continue;
      const k = part.slice(0, eq);
      const v = part.slice(eq + 1);
      keys.add(k);
      if (NUMERIC_KEYS.has(k)) {
        const n = Number(v);
        if (Number.isFinite(n)) params[k] = Math.trunc(n);
      } else {
        params[k] = v;
      }
    }
  }
  params.rawKeys = keys;
  return { params: params as KittyControlParams, payload };
}

export type KittyCommandEffect =
  | { type: 'none' }
  | { type: 'query' }
  | { type: 'image'; image: KittyImageRecord; display?: KittyPlaceRequest }
  | { type: 'place'; image: KittyImageRecord; display: KittyPlaceRequest }
  | { type: 'animate'; image: KittyImageRecord }
  | { type: 'delete'; selector: string; imageId?: number; placementId?: number; z?: number; free: boolean };

export interface KittyPlaceRequest {
  imageId: number;
  placementId: number;
  unicode: boolean;
  cols?: number;
  rows?: number;
  srcX?: number;
  srcY?: number;
  srcW?: number;
  srcH?: number;
  offsetX?: number;
  offsetY?: number;
  noCursorMove: boolean;
  z: number;
}

export interface KittyProcessResult {
  reply?: string;
  effect: KittyCommandEffect;
}

const MAX_STORED_IMAGES = 64;
const MAX_IMAGE_B64_CHARS = 32 * 1024 * 1024;
const MAX_STORE_B64_CHARS = 48 * 1024 * 1024;
const CHUNK_SIZE = 4096;

function formatKittyReply(params: KittyControlParams, message: string, ok: boolean): string | undefined {
  const q = params.q ?? 0;
  if (q === 2) return undefined;
  if (q === 1 && ok) return undefined;
  const id = params.i ?? 0;
  const num = params.I ?? 0;
  if (!id && !num && params.a !== 'q') return undefined;
  const parts: string[] = [];
  if (id) parts.push(`i=${id}`);
  if (num) parts.push(`I=${num}`);
  if (params.p) parts.push(`p=${params.p}`);
  if (ok && params.a === 'q' && params.U === 1) parts.push('U=1');
  return `\x1b_G${parts.join(',')};${message}\x1b\\`;
}

function validFormat(f: number | undefined): f is KittyImageFormat {
  return f === undefined || f === 24 || f === 32 || f === 100;
}

function b64ChunkedApc(header: string, data: string, contPrefix = 'q=2'): string {
  if (!data.length) return `\x1b_G${header},m=0;\x1b\\`;
  let out = '';
  for (let off = 0; off < data.length; off += CHUNK_SIZE) {
    const slice = data.slice(off, off + CHUNK_SIZE);
    const more = off + CHUNK_SIZE < data.length ? 1 : 0;
    if (off === 0) out += `\x1b_G${header},m=${more};${slice}\x1b\\`;
    else out += `\x1b_G${contPrefix},m=${more};${slice}\x1b\\`;
  }
  return out;
}

/**
 * Stateful Kitty graphics store for a single terminal: reassembles `m=1..0` chunked uploads,
 * answers `a=q` / `OK` / `EINVAL` / `ENOENT` replies, enforces bounded LRU memory, and serializes
 * stored images for late-attaching snapshots.
 */
export class KittyGraphicsStore {
  private readonly images = new Map<number, KittyImageRecord>();
  private totalChars = 0;
  private nextAutoId = 0x7f000001;
  private pendingParams: KittyControlParams | null = null;
  private pendingChunks: string[] = [];
  private pendingChars = 0;

  reset(): void {
    this.images.clear();
    this.totalChars = 0;
    this.pendingParams = null;
    this.pendingChunks = [];
    this.pendingChars = 0;
  }

  get(id: number): KittyImageRecord | undefined {
    return this.images.get(id >>> 0);
  }

  values(): IterableIterator<KittyImageRecord> {
    return this.images.values();
  }

  get size(): number {
    return this.images.size;
  }

  /** Processes one complete `APC G` body (`<header>;<payload>`) and returns any PTY reply + visual effect. */
  processApc(body: string): KittyProcessResult {
    const { params: cur, payload } = parseKittyControl(body);
    const cleanPayload = payload.includes('\n') || payload.includes('\r') ? payload.replace(/[\r\n]+/g, '') : payload;

    // Reassemble multi-chunk (`m=1` ... `m=0`) uploads and animation frames.
    if (this.pendingParams) {
      const merged: KittyControlParams = { ...this.pendingParams };
      if (cur.q !== undefined) merged.q = cur.q;
      if (cur.m !== undefined) merged.m = cur.m;
      this.pendingChars += cleanPayload.length;
      if (this.pendingChars > MAX_IMAGE_B64_CHARS) {
        this.pendingParams = null;
        this.pendingChunks = [];
        this.pendingChars = 0;
        return { reply: formatKittyReply(merged, 'ENOMEM:Image payload too large', false), effect: { type: 'none' } };
      }
      if (cleanPayload) this.pendingChunks.push(cleanPayload);
      if ((cur.m ?? 0) === 1) {
        this.pendingParams = merged;
        return { effect: { type: 'none' } };
      }
      const fullPayload = this.pendingChunks.join('');
      this.pendingParams = null;
      this.pendingChunks = [];
      this.pendingChars = 0;
      return this.execute(merged, fullPayload);
    }

    if (cur.m === 1) {
      this.pendingParams = cur;
      this.pendingChunks = cleanPayload ? [cleanPayload] : [];
      this.pendingChars = cleanPayload.length;
      return { effect: { type: 'none' } };
    }

    return this.execute(cur, cleanPayload);
  }

  private execute(p: KittyControlParams, data: string): KittyProcessResult {
    const action = p.a ?? 't';

    // 1. Capability / validation query (`a=q`): never stores images.
    if (action === 'q') {
      if (p.t && p.t !== 'd') {
        return { reply: formatKittyReply(p, 'EINVAL:Direct transmission only', false), effect: { type: 'query' } };
      }
      if (!validFormat(p.f)) {
        return { reply: formatKittyReply(p, 'EINVAL:Unsupported format', false), effect: { type: 'query' } };
      }
      if (p.o && p.o !== 'z') {
        return { reply: formatKittyReply(p, 'EINVAL:Unsupported compression', false), effect: { type: 'query' } };
      }
      return { reply: formatKittyReply(p, 'OK', true), effect: { type: 'query' } };
    }

    // 2. Delete (`a=d`).
    if (action === 'd') {
      const sel = p.d ?? 'a';
      const lower = sel.toLowerCase();
      const free = sel !== lower || lower === 'a';
      if (lower === 'a') {
        if (sel === 'A') this.clearImages();
        return { effect: { type: 'delete', selector: sel, free: sel === 'A' } };
      }
      if (lower === 'i' && p.i) {
        const id = p.i >>> 0;
        if (sel === 'I' || !p.p) this.removeImage(id);
        return { effect: { type: 'delete', selector: sel, imageId: id, placementId: p.p, free } };
      }
      if (lower === 'n' && p.I) {
        const found = this.findByNumber(p.I);
        if (found && (sel === 'N' || !p.p)) this.removeImage(found.id);
        return { effect: { type: 'delete', selector: sel, imageId: found?.id, placementId: p.p, free } };
      }
      return { effect: { type: 'delete', selector: sel, imageId: p.i, placementId: p.p, z: p.z, free } };
    }

    // 3. Put / display existing image (`a=p`).
    if (action === 'p') {
      const img = p.i ? this.images.get(p.i >>> 0) : p.I ? this.findByNumber(p.I) : undefined;
      if (!img) {
        return { reply: formatKittyReply(p, 'ENOENT:Image not found', false), effect: { type: 'none' } };
      }
      this.touch(img);
      if (p.U === 1) {
        img.unicode = true;
        if (p.c) img.cols = p.c;
        if (p.r) img.rows = p.r;
      }
      const display = this.makePlaceRequest(img.id, p);
      return { reply: formatKittyReply(p, 'OK', true), effect: { type: 'place', image: img, display } };
    }

    // 4. Animation frame (`a=f`).
    if (action === 'f') {
      const img = p.i ? this.images.get(p.i >>> 0) : p.I ? this.findByNumber(p.I) : undefined;
      if (!img) {
        return { reply: formatKittyReply(p, 'ENOENT:Image not found', false), effect: { type: 'none' } };
      }
      if (p.t && p.t !== 'd') {
        return { reply: formatKittyReply(p, 'EINVAL:Direct transmission only', false), effect: { type: 'none' } };
      }
      const fmt = validFormat(p.f) ? (p.f ?? 32) : 32;
      if (img.frames.length < 120 && data) {
        img.frames.push({
          format: fmt,
          compression: p.o === 'z' ? 'z' : undefined,
          width: p.s ?? img.width,
          height: p.v ?? img.height,
          delayMs: Math.max(10, p.z ?? 100),
          data,
        });
        this.totalChars += data.length;
        this.evictIfNeeded(img.id);
      }
      return { reply: formatKittyReply(p, 'OK', true), effect: { type: 'animate', image: img } };
    }

    // 5. Animation control (`a=a`).
    if (action === 'a') {
      const img = p.i ? this.images.get(p.i >>> 0) : p.I ? this.findByNumber(p.I) : undefined;
      if (!img) return { effect: { type: 'none' } };
      if (p.r === 1 && p.z !== undefined) img.rootDelayMs = Math.max(10, p.z);
      if (p.s !== undefined) img.animState = p.s;
      return { reply: formatKittyReply(p, 'OK', true), effect: { type: 'animate', image: img } };
    }

    // 6. Transmit (`a=t`) or Transmit & Display (`a=T`).
    if (action === 't' || action === 'T') {
      if (p.t && p.t !== 'd') {
        return { reply: formatKittyReply(p, 'EINVAL:Direct transmission only', false), effect: { type: 'none' } };
      }
      if (!validFormat(p.f)) {
        return { reply: formatKittyReply(p, 'EINVAL:Unsupported format', false), effect: { type: 'none' } };
      }
      if (p.o && p.o !== 'z') {
        return { reply: formatKittyReply(p, 'EINVAL:Unsupported compression', false), effect: { type: 'none' } };
      }
      const fmt: KittyImageFormat = p.f ?? 32;
      if ((fmt === 24 || fmt === 32) && (!(p.s && p.s > 0) || !(p.v && p.v > 0))) {
        return { reply: formatKittyReply(p, 'EINVAL:Missing dimensions', false), effect: { type: 'none' } };
      }
      const id = p.i && p.i > 0 ? p.i >>> 0 : this.nextAutoId++;
      const record: KittyImageRecord = {
        id,
        number: p.I,
        format: fmt,
        compression: p.o === 'z' ? 'z' : undefined,
        width: p.s ?? 0,
        height: p.v ?? 0,
        cols: p.c,
        rows: p.r,
        unicode: action === 'T' && p.U === 1 ? true : undefined,
        data,
        frames: [],
      };
      this.storeImage(record);
      const display = action === 'T' ? this.makePlaceRequest(id, p) : undefined;
      return {
        reply: formatKittyReply({ ...p, i: p.i ?? (p.I ? id : undefined) }, 'OK', true),
        effect: { type: 'image', image: record, display },
      };
    }

    return { effect: { type: 'none' } };
  }

  private makePlaceRequest(imageId: number, p: KittyControlParams): KittyPlaceRequest {
    return {
      imageId,
      placementId: p.p ?? 0,
      unicode: p.U === 1,
      cols: p.c,
      rows: p.r,
      srcX: p.x,
      srcY: p.y,
      srcW: p.w,
      srcH: p.h,
      offsetX: p.X,
      offsetY: p.Y,
      noCursorMove: p.C === 1 || p.U === 1,
      z: p.z ?? 0,
    };
  }

  private findByNumber(num: number): KittyImageRecord | undefined {
    let match: KittyImageRecord | undefined;
    for (const img of this.images.values()) {
      if (img.number === num) match = img;
    }
    return match;
  }

  private recordChars(img: KittyImageRecord): number {
    let n = img.data.length;
    for (const f of img.frames) n += f.data.length;
    return n;
  }

  private storeImage(img: KittyImageRecord): void {
    this.removeImage(img.id);
    this.images.set(img.id, img);
    this.totalChars += this.recordChars(img);
    this.evictIfNeeded(img.id);
  }

  private touch(img: KittyImageRecord): void {
    this.images.delete(img.id);
    this.images.set(img.id, img);
  }

  private removeImage(id: number): void {
    const prev = this.images.get(id);
    if (!prev) return;
    this.images.delete(id);
    this.totalChars = Math.max(0, this.totalChars - this.recordChars(prev));
  }

  private clearImages(): void {
    this.images.clear();
    this.totalChars = 0;
  }

  private evictIfNeeded(keepId: number): void {
    for (const [id] of this.images) {
      if (this.images.size <= MAX_STORED_IMAGES && this.totalChars <= MAX_STORE_B64_CHARS) break;
      if (id === keepId) continue;
      this.removeImage(id);
    }
  }

  /**
   * Serializes stored images referenced by `keepIds` (or all stored images if `keepIds` is omitted)
   * as quiet `a=t` / `a=T,U=1` + `a=f` + `a=a` APC sequences suitable for prepending to a terminal snapshot.
   */
  serialize(keepIds?: ReadonlySet<number>): string {
    if (!this.images.size) return '';
    let out = '';
    for (const img of this.images.values()) {
      if (keepIds && !keepIds.has(img.id)) continue;
      const headParts = [
        img.unicode ? 'a=T,U=1' : 'a=t',
        'q=2',
        `f=${img.format}`,
        ...(img.compression ? [`o=${img.compression}`] : []),
        ...(img.width ? [`s=${img.width}`] : []),
        ...(img.height ? [`v=${img.height}`] : []),
        `i=${img.id}`,
        ...(img.number ? [`I=${img.number}`] : []),
        ...(img.cols ? [`c=${img.cols}`] : []),
        ...(img.rows ? [`r=${img.rows}`] : []),
      ];
      out += b64ChunkedApc(headParts.join(','), img.data);
      for (const frame of img.frames) {
        const fParts = [
          'a=f',
          `i=${img.id}`,
          'q=2',
          `f=${frame.format}`,
          ...(frame.compression ? [`o=${frame.compression}`] : []),
          ...(frame.width ? [`s=${frame.width}`] : []),
          ...(frame.height ? [`v=${frame.height}`] : []),
          `z=${frame.delayMs}`,
        ];
        out += b64ChunkedApc(fParts.join(','), frame.data, 'a=f,q=2');
      }
      if (img.rootDelayMs !== undefined) out += `\x1b_Ga=a,i=${img.id},r=1,z=${img.rootDelayMs},q=2\x1b\\`;
      if (img.animState !== undefined) out += `\x1b_Ga=a,i=${img.id},s=${img.animState},v=1,q=2\x1b\\`;
    }
    return out;
  }
}

// --- Pure ES2022 Base64 decode helper (no Buffer, no atob) ---

const B64_LOOKUP = (() => {
  const table = new Int8Array(128).fill(-1);
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < chars.length; i++) table[chars.charCodeAt(i)] = i;
  table[45 /* '-' */] = 62;
  table[95 /* '_' */] = 63;
  return table;
})();

export function decodeBase64(b64: string): Uint8Array {
  let cleanLen = 0;
  for (let i = 0; i < b64.length; i++) {
    const c = b64.charCodeAt(i);
    if (c < 128 && B64_LOOKUP[c] >= 0) cleanLen++;
  }
  const outLen = Math.floor((cleanLen * 3) / 4);
  const out = new Uint8Array(outLen);
  let acc = 0;
  let bits = 0;
  let pos = 0;
  for (let i = 0; i < b64.length; i++) {
    const c = b64.charCodeAt(i);
    const val = c < 128 ? B64_LOOKUP[c] : -1;
    if (val < 0) continue;
    acc = (acc << 6) | val;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (pos < outLen) out[pos++] = (acc >> bits) & 0xff;
    }
  }
  return pos === outLen ? out : out.subarray(0, pos);
}

/**
 * Extracts an explicit 24-bit/palette underline color (`placement_id`) from an xterm `CellData`
 * without letting xterm's default `getUnderlineColor()` fallback leak `fgColor` when no underline color was set.
 */
export function cellUnderlineId(cell: unknown): number {
  const c = cell as { hasExtendedAttrs?: () => number | boolean; extended?: { underlineColor?: number }; getUnderlineColor?: () => number } | null | undefined;
  const uc = c?.hasExtendedAttrs?.() ? c.extended?.underlineColor : 0;
  if (!uc || uc === -1 || (uc & 0x03000000) === 0) return 0;
  return (c?.getUnderlineColor?.() ?? 0) & 0xffffff;
}

/** Fast FNV-1a 32-bit hash over a base64 payload (full scan for <=512 chars, strided + head/tail for larger payloads). */
export function hashKittyPayload(data: string): string {
  let h = 0x811c9dc5;
  const len = data.length;
  const head = Math.min(len, 256);
  for (let i = 0; i < head; i++) {
    h ^= data.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  if (len > 512) {
    const step = Math.max(1, (len - 512) >> 10);
    for (let i = 256; i < len - 256; i += step) {
      h ^= data.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  }
  const tailStart = Math.max(head, len - 256);
  for (let i = tailStart; i < len; i++) {
    h ^= data.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Content signature for a Kitty image record or `ScreenImage` so equal-length updates and animation changes invalidate caches. */
export function kittyImageSignature(img: {
  format: number;
  compression?: string;
  width: number;
  height: number;
  data: string;
  frames?: readonly { format: number; delayMs: number; data: string }[];
  animState?: number;
  rootDelayMs?: number;
}): string {
  let sig = `${img.format}:${img.compression ?? ''}:${img.width}x${img.height}:${img.data.length}:${hashKittyPayload(img.data)}`;
  if (img.frames?.length) {
    sig += `:f${img.frames.length}:${img.animState ?? 0}:${img.rootDelayMs ?? 0}`;
    for (const f of img.frames) sig += `,${f.format}@${f.delayMs}:${f.data.length}:${hashKittyPayload(f.data)}`;
  }
  return sig;
}

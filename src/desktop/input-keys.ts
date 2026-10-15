import { type CdpKey, cdpModifiers, MOD, type NativeFlags, type NativeKey } from './input-events.js';

/** What a macOS key press becomes in the page: the DOM `code` and `key`, the Windows virtual key (`keyCode`), the key's side, and the text it types. */
export interface KeyInfo {
  code: string;
  key: string;
  /** DOM `keyCode` / Chromium `windowsVirtualKeyCode`. */
  vk: number;
  /** DOM `location`: 0 standard, 1 left, 2 right, 3 numpad. */
  location: number;
  /** What the key types, or '' for a key that types nothing (a shortcut, an arrow, a modifier). */
  text: string;
}

/** `kVK_*` virtual key codes (HIToolbox/Events.h) to DOM `KeyboardEvent.code`. Layout independent: the physical key. */
const CODES = new Map<number, string>([
  [0x00, 'KeyA'],
  [0x01, 'KeyS'],
  [0x02, 'KeyD'],
  [0x03, 'KeyF'],
  [0x04, 'KeyH'],
  [0x05, 'KeyG'],
  [0x06, 'KeyZ'],
  [0x07, 'KeyX'],
  [0x08, 'KeyC'],
  [0x09, 'KeyV'],
  [0x0a, 'IntlBackslash'],
  [0x0b, 'KeyB'],
  [0x0c, 'KeyQ'],
  [0x0d, 'KeyW'],
  [0x0e, 'KeyE'],
  [0x0f, 'KeyR'],
  [0x10, 'KeyY'],
  [0x11, 'KeyT'],
  [0x12, 'Digit1'],
  [0x13, 'Digit2'],
  [0x14, 'Digit3'],
  [0x15, 'Digit4'],
  [0x16, 'Digit6'],
  [0x17, 'Digit5'],
  [0x18, 'Equal'],
  [0x19, 'Digit9'],
  [0x1a, 'Digit7'],
  [0x1b, 'Minus'],
  [0x1c, 'Digit8'],
  [0x1d, 'Digit0'],
  [0x1e, 'BracketRight'],
  [0x1f, 'KeyO'],
  [0x20, 'KeyU'],
  [0x21, 'BracketLeft'],
  [0x22, 'KeyI'],
  [0x23, 'KeyP'],
  [0x24, 'Enter'],
  [0x25, 'KeyL'],
  [0x26, 'KeyJ'],
  [0x27, 'Quote'],
  [0x28, 'KeyK'],
  [0x29, 'Semicolon'],
  [0x2a, 'Backslash'],
  [0x2b, 'Comma'],
  [0x2c, 'Slash'],
  [0x2d, 'KeyN'],
  [0x2e, 'KeyM'],
  [0x2f, 'Period'],
  [0x30, 'Tab'],
  [0x31, 'Space'],
  [0x32, 'Backquote'],
  [0x33, 'Backspace'],
  [0x35, 'Escape'],
  [0x36, 'MetaRight'],
  [0x37, 'MetaLeft'],
  [0x38, 'ShiftLeft'],
  [0x39, 'CapsLock'],
  [0x3a, 'AltLeft'],
  [0x3b, 'ControlLeft'],
  [0x3c, 'ShiftRight'],
  [0x3d, 'AltRight'],
  [0x3e, 'ControlRight'],
  [0x3f, 'Fn'],
  [0x40, 'F17'],
  [0x41, 'NumpadDecimal'],
  [0x43, 'NumpadMultiply'],
  [0x45, 'NumpadAdd'],
  [0x47, 'NumLock'],
  [0x48, 'AudioVolumeUp'],
  [0x49, 'AudioVolumeDown'],
  [0x4a, 'AudioVolumeMute'],
  [0x4b, 'NumpadDivide'],
  [0x4c, 'NumpadEnter'],
  [0x4e, 'NumpadSubtract'],
  [0x4f, 'F18'],
  [0x50, 'F19'],
  [0x51, 'NumpadEqual'],
  [0x52, 'Numpad0'],
  [0x53, 'Numpad1'],
  [0x54, 'Numpad2'],
  [0x55, 'Numpad3'],
  [0x56, 'Numpad4'],
  [0x57, 'Numpad5'],
  [0x58, 'Numpad6'],
  [0x59, 'Numpad7'],
  [0x5a, 'F20'],
  [0x5b, 'Numpad8'],
  [0x5c, 'Numpad9'],
  [0x5d, 'IntlYen'],
  [0x5e, 'IntlRo'],
  [0x5f, 'NumpadComma'],
  [0x60, 'F5'],
  [0x61, 'F6'],
  [0x62, 'F7'],
  [0x63, 'F3'],
  [0x64, 'F8'],
  [0x65, 'F9'],
  [0x66, 'Lang2'],
  [0x67, 'F11'],
  [0x68, 'Lang1'],
  [0x69, 'F13'],
  [0x6a, 'F16'],
  [0x6b, 'F14'],
  [0x6d, 'F10'],
  [0x6e, 'ContextMenu'],
  [0x6f, 'F12'],
  [0x71, 'F15'],
  [0x72, 'Insert'],
  [0x73, 'Home'],
  [0x74, 'PageUp'],
  [0x75, 'Delete'],
  [0x76, 'F4'],
  [0x77, 'End'],
  [0x78, 'F2'],
  [0x79, 'PageDown'],
  [0x7a, 'F1'],
  [0x7b, 'ArrowLeft'],
  [0x7c, 'ArrowRight'],
  [0x7d, 'ArrowDown'],
  [0x7e, 'ArrowUp'],
]);

/** Windows virtual key codes by DOM code, for the codes that are not a letter or a digit. */
const VK: Record<string, number> = {
  Enter: 13,
  NumpadEnter: 13,
  Tab: 9,
  Space: 32,
  Backspace: 8,
  Escape: 27,
  CapsLock: 20,
  NumLock: 144,
  ShiftLeft: 16,
  ShiftRight: 16,
  ControlLeft: 17,
  ControlRight: 17,
  AltLeft: 18,
  AltRight: 18,
  MetaLeft: 91,
  MetaRight: 93,
  ContextMenu: 93,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  Insert: 45,
  Delete: 46,
  Semicolon: 186,
  Equal: 187,
  Comma: 188,
  Minus: 189,
  Period: 190,
  Slash: 191,
  Backquote: 192,
  BracketLeft: 219,
  Backslash: 220,
  BracketRight: 221,
  Quote: 222,
  IntlBackslash: 226,
  NumpadMultiply: 106,
  NumpadAdd: 107,
  NumpadSubtract: 109,
  NumpadDecimal: 110,
  NumpadDivide: 111,
  NumpadComma: 194,
  NumpadEqual: 187,
  AudioVolumeMute: 173,
  AudioVolumeDown: 174,
  AudioVolumeUp: 175,
  IntlYen: 220,
  IntlRo: 193,
  Lang1: 21,
  Lang2: 25,
};

/** `key` for the keys that are named rather than typed. */
const NAMED: Record<string, string> = {
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Escape: 'Escape',
  CapsLock: 'CapsLock',
  NumLock: 'NumLock',
  Fn: 'Fn',
  ShiftLeft: 'Shift',
  ShiftRight: 'Shift',
  ControlLeft: 'Control',
  ControlRight: 'Control',
  AltLeft: 'Alt',
  AltRight: 'Alt',
  MetaLeft: 'Meta',
  MetaRight: 'Meta',
  ContextMenu: 'ContextMenu',
  ArrowLeft: 'ArrowLeft',
  ArrowUp: 'ArrowUp',
  ArrowRight: 'ArrowRight',
  ArrowDown: 'ArrowDown',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  End: 'End',
  Home: 'Home',
  Insert: 'Insert',
  Delete: 'Delete',
  AudioVolumeMute: 'AudioVolumeMute',
  AudioVolumeDown: 'AudioVolumeDown',
  AudioVolumeUp: 'AudioVolumeUp',
  Lang1: 'KanaMode',
  Lang2: 'Eisu',
};

const MODIFIER_FLAG: Record<string, number> = {
  ShiftLeft: MOD.shift,
  ShiftRight: MOD.shift,
  ControlLeft: MOD.ctrl,
  ControlRight: MOD.ctrl,
  AltLeft: MOD.alt,
  AltRight: MOD.alt,
  MetaLeft: MOD.meta,
  MetaRight: MOD.meta,
  CapsLock: MOD.caps,
};

export function domCode(keyCode: number): string {
  return CODES.get(keyCode) ?? '';
}

/** Whether `code` is a modifier key, and which modifier bit it sets. 0 for any other key. */
export function modifierFlag(code: string): number {
  return MODIFIER_FLAG[code] ?? 0;
}

function vkFor(code: string): number {
  if (code in VK) return VK[code]!;
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3);
  if (/^Digit[0-9]$/.test(code)) return code.charCodeAt(5);
  if (/^Numpad[0-9]$/.test(code)) return 96 + Number(code.slice(6));
  const f = /^F(\d{1,2})$/.exec(code);
  if (f) return 111 + Number(f[1]);
  return 0;
}

/** AppKit gives arrows and function keys a private-use character (U+F700 and up), and Control makes a letter a control character. Neither is typed text. */
function typed(s: string): boolean {
  if (!s) return false;
  const c = s.codePointAt(0)!;
  return c >= 0x20 && c !== 0x7f && !(c >= 0xf700 && c <= 0xf8ff);
}

/**
 * The page's view of a key press. `chars` is NSEvent.characters (the character with Shift and Option applied, a control
 * character under Control), `base` is charactersIgnoringModifiers (Shift still applied).
 */
export function keyInfo(keyCode: number, chars: string, base: string, mods: number): KeyInfo {
  const code = domCode(keyCode);
  const location = code.endsWith('Left') && NAMED[code] ? 1 : code.endsWith('Right') && NAMED[code] ? 2 : code.startsWith('Numpad') ? 3 : 0;
  const vk = vkFor(code);
  let key = NAMED[code];
  if (!key) {
    if (/^F\d{1,2}$/.test(code)) key = code;
    else if (typed(chars) && !(mods & MOD.ctrl)) key = chars;
    else if (typed(base)) key = base;
    else key = 'Unidentified';
  }
  // A shortcut types nothing; a plain key types what it says. Enter types a carriage return.
  let text = '';
  if (!(mods & (MOD.ctrl | MOD.meta))) {
    if (code === 'Enter' || code === 'NumpadEnter') text = '\r';
    else if (!NAMED[code] && typed(chars)) text = chars;
  }
  return { code, key, vk, location, text };
}

/** A Cocoa selector the input system sent while a key was down ("moveToBeginningOfLine:") as the Blink editing command that does the same ("MoveToBeginningOfLine"). */
export function editCommand(selector: string): string {
  const name = selector.replace(/:$/, '');
  return name ? name[0]!.toUpperCase() + name.slice(1) : '';
}

/** Chromium's keyCode while an input method has the key. */
export const IME_KEY_CODE = 229;

/** The `Input.dispatchKeyEvent` call for a key the view saw. */
export function cdpKeyEvent(e: NativeKey): CdpKey {
  const info = keyInfo(e.keyCode, e.chars, e.base, e.mods);
  const base = { modifiers: cdpModifiers(e.mods), code: info.code, nativeVirtualKeyCode: e.keyCode, autoRepeat: e.repeat, location: info.location, isKeypad: info.location === 3 };
  if (e.handled) return { ...base, type: e.kind === 'down' ? 'rawKeyDown' : 'keyUp', key: 'Process', windowsVirtualKeyCode: IME_KEY_CODE };
  if (e.kind === 'up') return { ...base, type: 'keyUp', key: info.key, windowsVirtualKeyCode: info.vk };
  const commands = e.commands.map(editCommand).filter(Boolean);
  const out: CdpKey = { ...base, type: info.text ? 'keyDown' : 'rawKeyDown', key: info.key, windowsVirtualKeyCode: info.vk };
  if (info.text) {
    out.text = info.text;
    out.unmodifiedText = info.text;
  }
  if (commands.length) out.commands = commands;
  return out;
}

/** A modifier key press or release: down when its flag came on, up when it went off. Caps Lock reports both on each toggle. */
export function cdpFlagEvents(e: NativeFlags): CdpKey[] {
  const code = domCode(e.keyCode);
  const flag = modifierFlag(code);
  if (!flag) return [];
  const info = keyInfo(e.keyCode, '', '', e.mods);
  const make = (type: 'rawKeyDown' | 'keyUp', mods: number): CdpKey => ({
    type,
    modifiers: cdpModifiers(mods),
    key: info.key,
    code,
    windowsVirtualKeyCode: info.vk,
    nativeVirtualKeyCode: e.keyCode,
    autoRepeat: false,
    location: info.location,
    isKeypad: false,
  });
  if (flag === MOD.caps) return [make('rawKeyDown', e.mods), make('keyUp', e.mods)];
  return [make(e.mods & flag ? 'rawKeyDown' : 'keyUp', e.mods)];
}

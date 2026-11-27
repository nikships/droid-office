import { encodeKittyKey, KittyKeyboardState } from '../../shared/kitty';
import type { KeyAction } from '../term-keys';
import type { GhosttyAdapter } from './ghostty';

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const IS_WINDOWS = typeof navigator !== 'undefined' && navigator.platform.startsWith('Win');
const punctuation: Record<string, string> = { Minus: '-_', Equal: '=+', BracketLeft: '[{', BracketRight: ']}', Backslash: '\\|', Semicolon: ';:', Quote: `'"`, Comma: ',<', Period: '.>', Slash: '/?', Backquote: '`~' };

function metaDeadKey(e: KeyboardEvent, optionTypes: boolean) {
  return IS_MAC && !optionTypes && e.altKey && e.key === 'Dead' && /^Key[A-Z]$/.test(e.code);
}

// Option+f can have key="ƒ" on macOS. In Meta mode xterm uses the base
// keyboard key, not the character produced by the Option layout.
function metaCharacter(e: KeyboardEvent): string {
  const n = e.keyCode;
  if (n >= 65 && n <= 90) return String.fromCharCode(e.ctrlKey ? n - 64 : e.shiftKey ? n : n + 32);
  if (n >= 48 && n <= 57) return (e.shiftKey ? ')!@#$%^&*(' : '0123456789')[n - 48];
  if (e.code === 'Space') return e.ctrlKey ? '\0' : ' ';
  return punctuation[e.code]?.[Number(e.shiftKey)] ?? e.key;
}

function legacyKey(e: KeyboardEvent, optionTypes: boolean, appCursor: boolean): KeyAction {
  const send = (data: string): KeyAction => ({ do: 'send', data });
  if (e.type !== 'keydown' || e.metaKey || e.isComposing || e.keyCode === 229 || e.key === 'Process') return { do: 'default' };
  if (e.key === 'Dead') {
    if (metaDeadKey(e, optionTypes)) return send(`\x1b${e.shiftKey ? e.code.slice(3) : e.code.slice(3).toLowerCase()}`);
    return { do: 'default' };
  }
  if (e.ctrlKey && !e.altKey && !e.shiftKey && e.code === 'KeyV') return send('\x16'); // Ctrl+V quotes the next key; Cmd+V pastes.
  if (e.key === 'Enter' && e.ctrlKey) return send(e.altKey ? '\x1b\r' : '\r');
  if (e.altKey && e.key === 'Backspace') return send(e.ctrlKey ? '\x1b\b' : '\x1b\x7f');
  if (e.altKey && [...e.key].length === 1 && !e.getModifierState('AltGraph') && !(IS_WINDOWS && e.ctrlKey)) {
    if (optionTypes && !e.ctrlKey) return send(e.key);
    return send(`\x1b${metaCharacter(e)}`);
  }
  // Ghostty hardcodes Home/End before consulting its encoder's DECCKM.
  if (appCursor && !e.altKey && !e.ctrlKey && !e.shiftKey && (e.key === 'Home' || e.key === 'End')) return send(e.key === 'Home' ? '\x1bOH' : '\x1bOF');
  return { do: 'default' };
}

/** Consume negotiated keyboard modes before native Ghostty sees them. The PTY host
 * answers queries; both viewers use the office encoder rather than a second set of flags. */
export function attachGhosttyKeys(adapter: GhosttyAdapter) {
  const keyboard = new KittyKeyboardState();
  const typesCharacters = () => IS_MAC && adapter.options.macOptionIsMeta === false;
  let optionTypes = typesCharacters();
  adapter.onOptionChange((key) => {
    if (key === 'macOptionIsMeta') optionTypes = typesCharacters();
  });
  const { parser } = adapter;
  for (const final of ['h', 'l']) {
    parser.registerCsiHandler({ prefix: '?', final }, (params) => {
      if (params.some((p) => p === 47 || p === 1047 || p === 1049)) keyboard.setAlternate(final === 'h');
      return false;
    });
  }
  parser.registerCsiHandler({ prefix: '=', final: 'u' }, ([flags, mode]) => {
    keyboard.set(typeof flags === 'number' ? flags : 0, typeof mode === 'number' ? mode : 1);
    return true;
  });
  parser.registerCsiHandler({ prefix: '>', final: 'u' }, ([flags]) => {
    keyboard.push(typeof flags === 'number' ? flags : 0);
    return true;
  });
  parser.registerCsiHandler({ prefix: '<', final: 'u' }, ([count]) => {
    // The shared stack has at most 16 saved modes. VT parameters may be arbitrarily large.
    keyboard.pop(typeof count === 'number' ? Math.min(count, 17) : 1);
    return true;
  });
  parser.registerEscHandler({ final: 'c' }, () => {
    keyboard.reset();
    return false;
  });
  adapter.onReset(() => keyboard.reset());
  adapter.onOpen((native, signal) => {
    // Let the browser start a composition. Otherwise the native fallback encodes
    // the physical key and preventDefault()s the keydown before compositionstart.
    native.textarea?.addEventListener(
      'keydown',
      (e) => {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'Process' || (e.key === 'Dead' && !metaDeadKey(e, optionTypes))) e.stopPropagation();
      },
      { signal },
    );
  });
  return {
    keyAction(e: KeyboardEvent, csiEnter: boolean): KeyAction {
      const appCursor = adapter.modes.applicationCursorKeysMode;
      let action = encodeKittyKey(e, keyboard.flags, { csiEnter, appCursor, optionTypes });
      if (action.do === 'default') action = legacyKey(e, optionTypes, appCursor);
      if (action.do === 'send' && !adapter.options.disableStdin && adapter.native?.hasSelection()) adapter.native.clearSelection();
      return action;
    },
  };
}

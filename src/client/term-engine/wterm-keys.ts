import { encodeKittyKey, KittyKeyboardState } from '../../shared/kitty';
import type { KeyAction } from '../term-keys';
import type { WTermAdapter } from './wterm';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const punctuation: Record<number, string> = { 186: ';:', 187: '=+', 188: ',<', 189: '-_', 190: '.>', 191: '/?', 192: '`~', 219: '[{', 220: '\\|', 221: ']}', 222: `'"` };

// In Meta mode the browser's virtual key identifies the base key on this layout.
// event.key may instead contain the Option character ("ƒ"), or just "Dead".
function metaCharacter(e: KeyboardEvent) {
  const vk = e.keyCode;
  if (vk >= 65 && vk <= 90) return String.fromCharCode(e.ctrlKey ? vk - 64 : e.shiftKey ? vk : vk + 32);
  if (vk >= 48 && vk <= 57) return (e.shiftKey ? ')!@#$%^&*(' : '0123456789')[vk - 48];
  if (vk === 32) return e.ctrlKey ? '\0' : ' ';
  if (e.key === 'Dead' && /^Key[A-Z]$/.test(e.code)) return e.shiftKey ? e.code[3] : e.code[3].toLowerCase();
  return punctuation[vk]?.[Number(e.shiftKey)];
}

function legacyKey(e: KeyboardEvent, optionTypes: boolean): KeyAction {
  const send = (data: string): KeyAction => ({ do: 'send', data });
  if (e.type !== 'keydown' || e.isComposing || e.keyCode === 229) return { do: 'default' };
  // Preserve browser copy/paste shortcuts: skip wterm's keydown but don't cancel
  // the browser's default action (unlike returning 'swallow' to the caller).
  if (e.key === 'Insert' && (e.ctrlKey || e.shiftKey)) {
    e.stopPropagation();
  } else if (e.key === 'Insert' && e.altKey) return send('\x1b[2~');
  if (e.key === 'Backspace' && (e.metaKey || (e.ctrlKey && e.altKey))) return send(`${e.altKey ? '\x1b' : ''}${e.ctrlKey ? '\b' : '\x7f'}`);
  if (e.key === 'Tab' && e.altKey && !e.shiftKey) return send('\t');
  if (e.altKey && !e.shiftKey && !e.ctrlKey && (e.key === 'PageUp' || e.key === 'PageDown')) return send(e.key === 'PageUp' ? '\x1b[5~' : '\x1b[6~');
  if (e.key === 'Enter' && e.shiftKey) return send(e.altKey ? '\x1b\r' : '\r');
  // Native Escape eats a selection or arms focus traversal on the next Tab.
  if (e.key === 'Escape') return send(e.altKey ? '\x1b\x1b' : '\x1b');
  if (e.metaKey) return { do: 'default' };
  if (e.ctrlKey && !e.altKey) {
    if (!e.shiftKey && e.keyCode >= 65 && e.keyCode <= 90) return send(String.fromCharCode(e.keyCode - 64));
    if ((e.shiftKey && /^[a-z]$/i.test(e.key)) || e.key === '2' || e.key === '/') e.stopPropagation();
  }
  if (e.altKey && (e.key === 'Dead' || [...e.key].length === 1) && !e.getModifierState('AltGraph')) {
    if (optionTypes && !e.ctrlKey) {
      // Let Chromium commit layout text, including composition, via native input.
      e.stopPropagation();
    } else if (!e.ctrlKey || !navigator.platform.startsWith('Win')) {
      const base = metaCharacter(e);
      if (base !== undefined) return send(`\x1b${base}`);
    }
  }
  return { do: 'default' };
}

export function attachWtermKeys(adapter: WTermAdapter) {
  const { parser } = adapter;
  const keyboard = new KittyKeyboardState();
  const typesCharacters = () => isMac && adapter.options.macOptionIsMeta === false;
  let optionTypes = typesCharacters();
  adapter.onOptionChange((key) => {
    if (key === 'macOptionIsMeta') optionTypes = typesCharacters();
  });

  // One negotiated encoder. Letting these reach the core also changes wterm's
  // DOM input and composition/release paths. suppressMirrorQueries owns CSI ? u.
  parser.registerCsiHandler({ prefix: '=', final: 'u' }, ([flags, mode]) => {
    keyboard.set(typeof flags === 'number' ? flags : 0, typeof mode === 'number' ? mode : 1);
    return true;
  });
  parser.registerCsiHandler({ prefix: '>', final: 'u' }, ([flags]) => {
    keyboard.push(typeof flags === 'number' ? flags : 0);
    return true;
  });
  parser.registerCsiHandler({ prefix: '<', final: 'u' }, ([count]) => {
    // The shared stack holds at most 16 entries.
    keyboard.pop(typeof count === 'number' ? Math.min(count, 17) : 1);
    return true;
  });
  parser.registerCsiHandler({ prefix: '>', final: 'm' }, ([resource]) => resource === 4);
  for (const final of ['h', 'l']) {
    parser.registerCsiHandler({ prefix: '?', final }, (params) => {
      if (params.some((p) => p === 47 || p === 1047 || p === 1049)) keyboard.setAlternate(final === 'h');
      return false;
    });
  }
  parser.registerEscHandler({ final: 'c' }, () => {
    keyboard.reset();
    return false;
  });
  adapter.onReset(() => keyboard.reset());
  adapter.onOpen((native, signal) => {
    adapter.textarea?.addEventListener(
      'paste',
      (e) => {
        const text = e.clipboardData?.getData('text/plain');
        if (!text?.includes('\n')) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        native.clearSelection();
        adapter.paste(text);
      },
      { capture: true, signal },
    );
  });

  return {
    keyAction(e: KeyboardEvent, csiEnter: boolean): KeyAction {
      let action = encodeKittyKey(e, keyboard.flags, { csiEnter, appCursor: adapter.core?.cursorKeysApp(), optionTypes });
      if (action.do === 'default') action = legacyKey(e, optionTypes);
      if (action.do === 'send' && !adapter.options.disableStdin) adapter.native?.clearSelection();
      return action;
    },
  };
}

/**
 * The headset panel's own keyboard, for controller input: a docked QWERTY board under the page that
 * types into whatever has focus, without the system's on-screen keyboard or an IME.
 *
 * Keys never take focus (pointerdown is cancelled), so the caret stays where it was. Where a key
 * goes:
 * - a text field (input, textarea): edited in place, caret and selection included, with the
 *   `keydown`, `input`, `change` and `keyup` events the page's own handlers listen for;
 * - the open worker terminal: the bytes a physical keyboard would send, through xterm, so Ctrl
 *   chords, Alt as meta, cursor keys and Ctrl/Shift+Enter reach the worker unchanged;
 * - anything else (a button, the menu, a dialog): a synthetic `keydown`/`keyup`, so the page's
 *   own shortcuts and dialogs behave as with a real key, and then the default a browser would
 *   give it (Tab moves focus, Enter and Space press a button).
 *
 * Ctrl, Alt and Shift latch for the next key; tap one twice to lock it, a third time to let go.
 */

import './keyboard.css';
import type { TerminalSink } from '../ui/terminal';
import { toast } from '../ui/dom';
import { KeyActivations, PanelClipboard, sameTextSelection } from './keyboard-actions';
import { KEYBOARD_ROWS, codeOf, editText, insertText, pressOf, shiftedLabel, terminalBytes, type KeyDef, type KeyLike, type Modifier, type TextEdit } from './keys';

export interface KeyboardOptions {
  /** The worker terminal that's open, if any. */
  terminal?: () => TerminalSink | null;
  /** Where it remembers whether it was left open. */
  storageKey?: string;
  onVisibility?: (shown: boolean) => void;
}

export interface PanelKeyboard {
  readonly element: HTMLElement;
  shown(): boolean;
  show(on: boolean): void;
  toggle(): void;
  /** Presses a key by its id in KEYBOARD_ROWS (`a`, `Enter`, `mod:ctrl`), as a tap on it would. */
  press(id: string): void;
  /** Types a whole press, modifiers and all, wherever focus is (the keyboard's latches aside). */
  type(k: KeyLike): void;
  dispose(): void;
}

const TEXT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', '']);
const REPEATS = new Set(['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);
const REPEAT_DELAY = 450;
const REPEAT_EVERY = 60;

type Field = HTMLInputElement | HTMLTextAreaElement;

/** A focused text field the keyboard edits itself; xterm's hidden textarea isn't one. */
function textField(el: Element | null): Field | null {
  if (el instanceof HTMLTextAreaElement) return el.closest('.xterm') ? null : el;
  if (el instanceof HTMLInputElement && TEXT_TYPES.has(el.type)) return el;
  return null;
}

function fire(target: EventTarget, type: 'keydown' | 'keyup', k: KeyLike): boolean {
  return target.dispatchEvent(new KeyboardEvent(type, { key: k.key, code: codeOf(k.key), ctrlKey: k.ctrlKey, altKey: k.altKey, shiftKey: k.shiftKey, metaKey: k.metaKey, bubbles: true, cancelable: true, composed: true }));
}

/** What Tab reaches, in document order, inside the topmost dialog when one is open. */
function tabbables(): HTMLElement[] {
  const dialogs = document.querySelectorAll<HTMLElement>('#modal-root > .backdrop');
  const scope: ParentNode = dialogs[dialogs.length - 1] ?? document;
  const sel = 'a[href], button, input, select, textarea, [tabindex]';
  return [...scope.querySelectorAll<HTMLElement>(sel)].filter((el) => !(el as HTMLButtonElement).disabled && el.tabIndex >= 0 && !el.closest('.native-kb, [hidden], .hidden') && el.getClientRects().length > 0);
}

function moveFocus(from: Element | null, dir: 1 | -1) {
  const list = tabbables();
  if (!list.length) return;
  const at = from instanceof HTMLElement ? list.indexOf(from) : -1;
  const next = at < 0 ? (dir > 0 ? list[0] : list[list.length - 1]) : list[(at + dir + list.length) % list.length];
  next.focus();
}

function selectionOf(f: Field): { start: number; end: number; dir: 'forward' | 'backward' | 'none' } | null {
  try {
    if (f.selectionStart === null || f.selectionEnd === null) return null;
    return { start: f.selectionStart, end: f.selectionEnd, dir: (f.selectionDirection as 'forward' | 'backward' | 'none' | null) ?? 'none' };
  } catch {
    return null;
  }
}

export function mountKeyboard(opts: KeyboardOptions = {}): PanelKeyboard {
  const storageKey = opts.storageKey ?? 'droid-office.panel-keyboard';
  const latched = new Set<Modifier>();
  const locked = new Set<Modifier>();
  /** Fields typed into since they took focus, which get a `change` when they lose it, like a browser's. */
  const dirty = new WeakSet<Field>();
  const keys = new Map<string, HTMLButtonElement>();
  const panelClipboard = new PanelClipboard();

  const board = document.createElement('div');
  board.className = 'native-kb';
  board.setAttribute('role', 'group');
  board.setAttribute('aria-label', 'Keyboard');
  for (const row of KEYBOARD_ROWS) {
    const r = document.createElement('div');
    r.className = 'native-kb-row';
    for (const def of row) r.append(keyButton(def));
    board.append(r);
  }
  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'btn native-kb-toggle';
  toggleBtn.setAttribute('aria-label', 'Show the keyboard');
  toggleBtn.title = 'Keyboard';
  toggleBtn.textContent = '⌨️ Keyboard';
  document.body.append(board, toggleBtn);

  function keyButton(def: KeyDef): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.tabIndex = -1;
    b.className = `native-key${def.id.length === 1 ? '' : ' fn'}${def.id === ' ' ? ' space' : ''}`;
    b.dataset.key = def.id;
    b.style.flexGrow = String(def.w ?? 1);
    b.textContent = def.label;
    if (def.name) b.setAttribute('aria-label', def.name);
    if (def.id.startsWith('mod:')) b.setAttribute('aria-pressed', 'false');
    keys.set(def.id, b);
    return b;
  }

  function paintMods() {
    const shift = latched.has('shift');
    for (const row of KEYBOARD_ROWS)
      for (const def of row) {
        const b = keys.get(def.id)!;
        if (def.id.startsWith('mod:')) {
          const m = def.id.slice(4) as Modifier;
          b.setAttribute('aria-pressed', String(latched.has(m)));
          b.classList.toggle('locked', locked.has(m));
        } else if (def.id.length === 1) b.textContent = shift ? shiftedLabel(def) : def.label;
      }
  }

  function tapModifier(m: Modifier) {
    if (locked.has(m)) {
      locked.delete(m);
      latched.delete(m);
    } else if (latched.has(m)) locked.add(m);
    else latched.add(m);
    paintMods();
  }

  function releaseLatches() {
    let changed = false;
    for (const m of [...latched])
      if (!locked.has(m)) {
        latched.delete(m);
        changed = true;
      }
    if (changed) paintMods();
  }

  function applyEdit(f: Field, e: TextEdit, sel: boolean) {
    if (e.changed) {
      const max = f.maxLength;
      if (max >= 0 && e.value.length > max && e.value.length > f.value.length) return;
      f.value = e.value;
      dirty.add(f);
      f.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: e.inputType, data: e.inserted ?? null }));
    }
    if (sel && f.isConnected) f.setSelectionRange(e.start, e.end, e.dir);
  }

  function clipboard(f: Field, k: KeyLike): boolean {
    if (!k.ctrlKey || k.altKey) return false;
    const c = k.key.toLowerCase();
    if (c !== 'c' && c !== 'x' && c !== 'v') return false;
    const sel = selectionOf(f);
    const st = { value: f.value, start: sel?.start ?? f.value.length, end: sel?.end ?? f.value.length };
    const picked = st.value.slice(st.start, st.end);
    const unchanged = () => {
      const now = selectionOf(f);
      return f.isConnected && document.activeElement === f && sameTextSelection(st, { value: f.value, start: now?.start ?? f.value.length, end: now?.end ?? f.value.length });
    };
    const unavailable = () => toast('System clipboard unavailable. Use HTTPS, or Copy and Paste within this panel.', 'warn');
    if (c === 'v') {
      if (f.readOnly || f.disabled) return true;
      void panelClipboard.read(navigator.clipboard).then((result) => {
        if (!result) return unavailable();
        if (!result.system) toast('Pasted the copy kept in this panel. System clipboard needs HTTPS or clipboard permission.');
        if (result.text && unchanged()) applyEdit(f, insertText(st, result.text), !!sel);
      });
      return true;
    }
    if (!picked || f.type === 'password') return true;
    const remove = () => {
      if (!f.readOnly && !f.disabled && unchanged()) applyEdit(f, insertText(st, ''), !!sel);
    };
    const copied = c === 'x' ? panelClipboard.cut(picked, navigator.clipboard, remove) : panelClipboard.write(picked, navigator.clipboard);
    void copied.then((ok) => {
      if (!ok) toast(c === 'x' ? 'Cut could not reach the system clipboard. Text kept; Paste can use the copy in this panel.' : 'Copied within this panel. Use HTTPS for the system clipboard.', 'warn');
    });
    return true;
  }

  function typeIntoField(f: Field, k: KeyLike) {
    const go = fire(f, 'keydown', k);
    try {
      // The keydown's handler may have moved focus or closed the dialog it was in.
      if (!go || !f.isConnected || document.activeElement !== f) return;
      if (k.key === 'Tab') return moveFocus(f, k.shiftKey ? -1 : 1);
      if (clipboard(f, k)) return;
      const sel = selectionOf(f);
      const st = { value: f.value, start: sel?.start ?? f.value.length, end: sel?.end ?? f.value.length, dir: sel?.dir };
      const edit = editText(st, k, f instanceof HTMLTextAreaElement);
      if (!edit) {
        // Enter in a one-line field submits its form, as it would in a browser.
        if (k.key === 'Enter' && f instanceof HTMLInputElement && !k.ctrlKey && !k.altKey) {
          if (dirty.has(f)) {
            dirty.delete(f);
            f.dispatchEvent(new Event('change', { bubbles: true }));
          }
          f.form?.requestSubmit();
        }
        return;
      }
      if (edit.changed && (f.readOnly || f.disabled)) return;
      applyEdit(f, edit, !!sel);
    } finally {
      fire(f, 'keyup', k);
    }
  }

  function typeIntoTerminal(t: TerminalSink, k: KeyLike) {
    // The desktop's ways out of a terminal, which xterm would otherwise type.
    if ((k.key === 'Escape' && k.shiftKey) || (k.ctrlKey && !k.altKey && k.key === ']')) return t.close();
    const bytes = terminalBytes(k, t.csiEnter(), t.appCursor());
    if (bytes !== null) t.input(bytes);
  }

  function typeElsewhere(el: Element | null, k: KeyLike) {
    const target = el instanceof HTMLElement && el !== document.body ? el : document.body;
    const go = fire(target, 'keydown', k);
    fire(target, 'keyup', k);
    if (!go || k.ctrlKey || k.altKey) return;
    if (k.key === 'Tab') return moveFocus(target === document.body ? null : target, k.shiftKey ? -1 : 1);
    if (target === document.body) return;
    if ((k.key === 'Enter' || k.key === ' ') && (target instanceof HTMLButtonElement || target instanceof HTMLAnchorElement || target.getAttribute('role')?.startsWith('menuitem'))) {
      target.click();
      return;
    }
    if (k.key === ' ' && target instanceof HTMLInputElement && (target.type === 'checkbox' || target.type === 'radio')) {
      target.click();
      return;
    }
    if (target instanceof HTMLSelectElement && (k.key === 'ArrowDown' || k.key === 'ArrowUp')) {
      const i = target.selectedIndex + (k.key === 'ArrowDown' ? 1 : -1);
      if (i < 0 || i >= target.options.length) return;
      target.selectedIndex = i;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function type(k: KeyLike) {
    const active = document.activeElement;
    const field = textField(active);
    if (field) return typeIntoField(field, k);
    const term = opts.terminal?.();
    if (term && (active?.closest('.xterm') || term.holdsKeys())) return typeIntoTerminal(term, k);
    typeElsewhere(active, k);
  }

  function press(id: string) {
    if (id === 'hide') return show(false);
    if (id.startsWith('mod:')) return tapModifier(id.slice(4) as Modifier);
    const k = pressOf(id, latched);
    releaseLatches();
    type(k);
  }

  // Keys act on pointerdown and never take focus, so the caret stays in the field being typed into.
  let repeatTimer = 0;
  const activations = new KeyActivations(press);
  const stopRepeat = () => {
    clearTimeout(repeatTimer);
    clearInterval(repeatTimer);
    repeatTimer = 0;
    for (const b of board.querySelectorAll('.native-key.down')) b.classList.remove('down');
  };
  const keyAt = (e: Event) => (e.target as Element | null)?.closest<HTMLButtonElement>('.native-key') ?? null;
  const onPointerDown = (e: PointerEvent) => {
    e.preventDefault();
    const b = keyAt(e);
    if (!b) return;
    stopRepeat();
    b.classList.add('down');
    const id = b.dataset.key!;
    activations.pointerDown(id);
    if (REPEATS.has(id))
      repeatTimer = window.setTimeout(() => {
        repeatTimer = window.setInterval(() => press(id), REPEAT_EVERY);
      }, REPEAT_DELAY);
  };
  // A click with no pointer before it (assistive tech, a synthesized tap) still types the key.
  const onClick = (e: MouseEvent) => {
    const b = keyAt(e);
    if (b) activations.click(b.dataset.key!, e.detail);
  };
  const noFocus = (e: Event) => e.preventDefault();
  board.addEventListener('pointerdown', onPointerDown);
  board.addEventListener('mousedown', noFocus);
  board.addEventListener('click', onClick);
  board.addEventListener('contextmenu', noFocus);
  for (const t of ['pointerup', 'pointercancel', 'pointerleave', 'lostpointercapture']) board.addEventListener(t, stopRepeat);
  toggleBtn.addEventListener('mousedown', noFocus);
  toggleBtn.addEventListener('click', () => show(true));

  const onFocusOut = (e: FocusEvent) => {
    const f = textField(e.target as Element);
    if (!f || !dirty.has(f)) return;
    dirty.delete(f);
    f.dispatchEvent(new Event('change', { bubbles: true }));
  };
  document.addEventListener('focusout', onFocusOut, true);

  const root = document.documentElement;
  const height = new ResizeObserver(() => root.style.setProperty('--native-kb-h', `${isShown ? board.offsetHeight : 0}px`));
  height.observe(board);

  let isShown = false;
  function show(on: boolean) {
    isShown = on;
    board.classList.toggle('open', on);
    toggleBtn.classList.toggle('hidden', on);
    document.body.classList.toggle('native-kb-open', on);
    root.style.setProperty('--native-kb-h', `${on ? board.offsetHeight : 0}px`);
    if (!on) {
      stopRepeat();
      latched.clear();
      locked.clear();
      paintMods();
    }
    try {
      localStorage.setItem(storageKey, on ? '1' : '0');
    } catch {
      // storage blocked
    }
    opts.onVisibility?.(on);
  }
  let saved = false;
  try {
    saved = localStorage.getItem(storageKey) === '1';
  } catch {
    // storage blocked
  }
  show(saved);

  return {
    element: board,
    shown: () => isShown,
    show,
    toggle: () => show(!isShown),
    press,
    type,
    dispose() {
      stopRepeat();
      height.disconnect();
      document.removeEventListener('focusout', onFocusOut, true);
      board.remove();
      toggleBtn.remove();
      document.body.classList.remove('native-kb-open');
      root.style.removeProperty('--native-kb-h');
    },
  };
}

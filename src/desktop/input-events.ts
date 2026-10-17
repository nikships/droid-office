import type { KeyboardInputEvent, MouseInputEvent, MouseWheelInputEvent } from 'electron';

/**
 * What `native/presenter/src/input_view.mm` reports about the native view. Every event is a plain object (numbers, strings,
 * booleans). Positions are in DIPs from the view's top-left corner, which is the page's CSS pixel space.
 */
export const MOD = { shift: 1, ctrl: 2, alt: 4, meta: 8, caps: 16 } as const;
/** `NSEvent.pressedMouseButtons` bits: left 1, right 2, middle 4. */
export const BUTTON = { left: 1, right: 2, middle: 4 } as const;

export interface NativeMouse {
  type: 'mouse';
  kind: 'down' | 'up' | 'move' | 'enter' | 'leave';
  /** 0 left, 1 right, 2 middle (NSEvent.buttonNumber). */
  button: number;
  buttons: number;
  x: number;
  y: number;
  clickCount: number;
  mods: number;
}
/** Relative motion while the pointer is captured. The cursor does not move. */
export interface NativeDelta {
  type: 'delta';
  dx: number;
  dy: number;
  /** Read from the device with no pointer acceleration. */
  raw: boolean;
  buttons: number;
  mods: number;
}
export interface NativeScroll {
  type: 'scroll';
  x: number;
  y: number;
  /** NSEvent.scrollingDeltaX/Y: points when `precise`, lines otherwise. Already includes the user's natural scrolling choice. */
  dx: number;
  dy: number;
  precise: boolean;
  mods: number;
}
export interface NativeKey {
  type: 'key';
  kind: 'down' | 'up';
  /** kVK_* */
  keyCode: number;
  chars: string;
  base: string;
  mods: number;
  repeat: boolean;
  /** The input method took this key (it started, changed or ended a composition). Composition events came first. */
  handled: boolean;
  /** Cocoa selectors the input system asked for ("moveLeft:"), which Blink runs as editing commands. */
  commands: string[];
}
/** A modifier key went down or up (Shift, Control, Option, Command, Caps Lock). `mods` is the state after it. */
export interface NativeFlags {
  type: 'flags';
  keyCode: number;
  mods: number;
}
export interface NativeCompose {
  type: 'compose';
  text: string;
  /** The selection inside `text`. */
  selStart: number;
  selEnd: number;
}
export interface NativeCommit {
  type: 'commit';
  text: string;
}
/** The composition was cancelled (marked text removed without committing). */
export interface NativeComposeEnd {
  type: 'composeEnd';
}
/** The view gained or lost keyboard focus: window key state and first responder together. */
export interface NativeFocus {
  type: 'focus';
  focused: boolean;
}
export type NativeEvent = NativeMouse | NativeDelta | NativeScroll | NativeKey | NativeFlags | NativeCompose | NativeCommit | NativeComposeEnd | NativeFocus;

/** Electron's `modifiers` names for a native modifier mask and pressed buttons. */
export function electronModifiers(mods: number, buttons = 0): NonNullable<MouseInputEvent['modifiers']> {
  const out: NonNullable<MouseInputEvent['modifiers']> = [];
  if (mods & MOD.shift) out.push('shift');
  if (mods & MOD.ctrl) out.push('control');
  if (mods & MOD.alt) out.push('alt');
  if (mods & MOD.meta) out.push('meta');
  if (mods & MOD.caps) out.push('capslock');
  if (buttons & BUTTON.left) out.push('leftbuttondown');
  if (buttons & BUTTON.right) out.push('rightbuttondown');
  if (buttons & BUTTON.middle) out.push('middlebuttondown');
  return out;
}

/** Chromium's `Input.dispatch*` modifier bits: Alt 1, Control 2, Meta 4, Shift 8. */
export function cdpModifiers(mods: number): number {
  return (mods & MOD.alt ? 1 : 0) | (mods & MOD.ctrl ? 2 : 0) | (mods & MOD.meta ? 4 : 0) | (mods & MOD.shift ? 8 : 0);
}

const BUTTON_NAMES = ['left', 'right', 'middle'] as const;

export function mouseButton(n: number): 'left' | 'right' | 'middle' {
  return BUTTON_NAMES[n] ?? 'left';
}

/** The page sees a move as the distance between two screen positions. A mouse in normal mode reports its own position as that. */
export interface Pointer {
  x: number;
  y: number;
  /** The virtual screen position `movementX/Y` are measured on. Moves with the cursor, and by the raw delta while captured. */
  gx: number;
  gy: number;
}

export function pointerAt(x: number, y: number): Pointer {
  return { x, y, gx: x, gy: y };
}

/** A captured move: the cursor stays where it was and the virtual screen position moves by the delta, which is exactly the page's `movementX/Y`. */
export function captured(p: Pointer, dx: number, dy: number): Pointer {
  return { x: p.x, y: p.y, gx: p.gx + dx, gy: p.gy + dy };
}

export function mouseEvent(p: Pointer, type: MouseInputEvent['type'], opts: { button?: number; buttons?: number; mods?: number; clickCount?: number; movementX?: number; movementY?: number } = {}): MouseInputEvent {
  const e: MouseInputEvent = { type, x: p.x, y: p.y, globalX: p.gx, globalY: p.gy, modifiers: electronModifiers(opts.mods ?? 0, opts.buttons ?? 0) };
  if (opts.button !== undefined) e.button = mouseButton(opts.button);
  if (opts.clickCount !== undefined) e.clickCount = opts.clickCount;
  if (opts.movementX !== undefined) e.movementX = opts.movementX;
  if (opts.movementY !== undefined) e.movementY = opts.movementY;
  return e;
}

/** CSS pixels one mouse-wheel notch scrolls, as Chrome on macOS reports it. */
export const WHEEL_LINE_PX = 40;

/**
 * Electron's wheel `deltaX/Y` have the sign of NSEvent.scrollingDeltaX/Y (positive scrolls the content down and right, which
 * the page sees as a negative DOM delta), so the native values go through as they are.
 */
export function wheelEvent(e: NativeScroll, p: { x: number; y: number }): MouseWheelInputEvent {
  const scale = e.precise ? 1 : WHEEL_LINE_PX;
  return {
    type: 'mouseWheel',
    x: p.x,
    y: p.y,
    deltaX: e.dx * scale,
    deltaY: e.dy * scale,
    wheelTicksX: e.precise ? e.dx / WHEEL_LINE_PX : e.dx,
    wheelTicksY: e.precise ? e.dy / WHEEL_LINE_PX : e.dy,
    hasPreciseScrollingDeltas: e.precise,
    modifiers: electronModifiers(e.mods),
  };
}

/** `webContents.sendInputEvent` fallback shape for a key, used only when CDP is not attached. */
export function keyboardEvent(type: 'keyDown' | 'keyUp' | 'char', keyCode: string, mods: number): KeyboardInputEvent {
  return { type, keyCode, modifiers: electronModifiers(mods) as KeyboardInputEvent['modifiers'] };
}

/** Parameters for CDP `Input.dispatchKeyEvent`. */
export interface CdpKey {
  type: 'keyDown' | 'rawKeyDown' | 'keyUp';
  modifiers: number;
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  nativeVirtualKeyCode: number;
  autoRepeat: boolean;
  location: number;
  isKeypad: boolean;
  text?: string;
  unmodifiedText?: string;
  commands?: string[];
}

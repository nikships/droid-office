// The postMessage bridge between a host (the Whiteboard window, or the renderer's harness page) and
// the SDK script the office injects into every artifact's sandboxed iframe (docs/whiteboard.md,
// "Isolation" and "The artifact JavaScript API"). Types and validators only: both sides post plain
// objects with `postMessage(msg, '*')`, since the frame's origin is opaque.
//
// Binding a message to one frame and one load:
// - The host makes a fresh random nonce for every load of a frame and puts it in the frame URL's
//   fragment (`#wb=<nonce>`); the SDK reads it from there before the artifact's own scripts run.
// - Every message on either side carries the bridge's `channel` and that nonce.
// - The host accepts a message only when `event.source === iframe.contentWindow` of the frame it made
//   for that card and the nonce is the one it gave that load, and applies it to that card only.
// - The SDK accepts a message only when `event.source === window.parent` and the nonce matches.
// - While `rendering` is true (the renderer loaded the card), the SDK drops writes and actions, and
//   the host ignores any that arrive.

import type { Anchor, Author, Json, Op, Point, StateObject } from './whiteboard.js';

export const BRIDGE_CHANNEL = 'droid-office-whiteboard';
export const BRIDGE_VERSION = 1;

/** Use: the artifact gets clicks and typing. Mark up: the host's overlay takes them for marks. */
export type BridgeMode = 'use' | 'markup';

export interface BridgeCard {
  id: string;
  title: string;
  author: Author;
}

/** A state write from the artifact (its JavaScript API, or a form field under `state.fields`). */
export type StateWrite = { op: 'set'; path: string[]; value: Json } | { op: 'merge'; path: string[]; value: StateObject } | { op: 'del'; path: string[] };

/**
 * What has focus in the frame, so a content reload can put it back: a form field by its `state.fields`
 * key (and which of the elements with that key), or another focusable element by CSS path; its caret;
 * and, while the owner has typed into it since it was last saved, what they typed and whether an IME
 * composition is open.
 */
export interface FocusedField {
  key?: string;
  index?: number;
  selector?: string;
  start?: number;
  end?: number;
  direction?: 'forward' | 'backward' | 'none';
  value?: string;
  composing?: boolean;
}

/** Host to frame. */
export type HostMsg =
  /** The card, its state, whether this is a render, the mode, and the layout width the host shows it at. */
  | { type: 'init'; card: BridgeCard; state: StateObject; rendering: boolean; mode: BridgeMode; width: number }
  /** The state after someone else changed it; `changes` says which leaves and who, for "changed by Pixel". */
  | { type: 'state'; state: StateObject; changes?: { path: string[]; author: Author }[] }
  /** Which anchor a page point (canonical px) lands on: answered with `anchor`. */
  | { type: 'anchorAt'; req: number; point: Point }
  /** Where these marks' anchors are on the page now: answered with `positions`. */
  | { type: 'locate'; req: number; anchors: { id: string; anchor: Anchor }[] }
  | { type: 'mode'; mode: BridgeMode }
  /** Restores a scroll position, when the frame scrolls itself. */
  | { type: 'scrollTo'; x: number; y: number; seq?: number }
  /**
   * After a content reload, focuses what had focus in the frame it replaced (its value and caret too).
   * Sent when the new frame is swapped in and focused, not with `init`: the new frame loads hidden
   * behind the old one, and focusing it then would take keys the owner is still typing into the old one.
   */
  | { type: 'focus'; field: FocusedField };

/** Frame to host. */
export type FrameMsg =
  | { type: 'ready'; version: number }
  | { type: 'write'; write: StateWrite }
  /** `whiteboard.action(name, data)`, or a `data-wb-action` button. */
  | { type: 'action'; name: string; data?: Json }
  /** The answer to `anchorAt`; null when the point is outside the page. */
  | { type: 'anchor'; req: number; anchor: Anchor | null }
  /** The answer to `locate`: each anchor's page point, or detached when it can't be placed. */
  | { type: 'positions'; req: number; positions: { id: string; point: Point | null; detached: boolean }[] }
  /** The page's laid-out size and scroll, sent on load and whenever either changes. */
  | { type: 'layout'; width: number; height: number; scrollX: number; scrollY: number; seq?: number }
  /** Wheel deltas are device CSS pixels, but the pointer is in the frame's canonical coordinates. */
  | { type: 'wheel'; point: Point; dx: number; dy: number; deltaMode: number; zoom: boolean; shift: boolean }
  | { type: 'space'; pressed: boolean }
  | { type: 'shortcut'; key: 'm' | 'h' | '+' | '-' | '0' | '1' }
  /** Middle-button drag coordinates are screen pixels, unaffected by the frame's transform. */
  | { type: 'pan'; phase: 'start' | 'move' | 'end'; point: Point }
  /** What has focus in the frame now, sent whenever it, its caret or its unsaved value changes; null when nothing does. */
  | { type: 'focus'; field: FocusedField | null }
  /**
   * The owner pressed Esc in the frame, which the office's own key handling can't see across origins:
   * the host treats it as Esc in the office. Not sent during an IME composition, or when the artifact
   * handled the key itself (preventDefault, or stopped it before it reached the window).
   */
  | { type: 'escape' };

export type Wrapped<T> = T & { channel: typeof BRIDGE_CHANNEL; nonce: string };

export function wrap<T extends HostMsg | FrameMsg>(msg: T, nonce: string): Wrapped<T> {
  return { ...msg, channel: BRIDGE_CHANNEL, nonce };
}

/** The nonce from a frame URL's fragment (`#wb=<nonce>`). */
export function nonceFromHash(hash: string): string | undefined {
  const m = /(?:^#|&)wb=([A-Za-z0-9_-]{16,128})(?:&|$)/.exec(hash);
  return m?.[1];
}

/** A message for the frame, from untrusted `event.data`, when it's on the bridge with this nonce. */
export function parseHostMsg(data: unknown, nonce: string): HostMsg | undefined {
  if (!onBridge(data, nonce)) return undefined;
  const d = data as Record<string, any>;
  switch (d.type) {
    case 'init':
      if (!isObject(d.card) || typeof d.card.id !== 'string' || typeof d.card.title !== 'string' || !isObject(d.card.author)) return undefined;
      if (!isObject(d.state) || typeof d.rendering !== 'boolean' || !isMode(d.mode) || !isNum(d.width)) return undefined;
      return { type: 'init', card: { id: d.card.id, title: d.card.title, author: d.card.author as Author }, state: d.state, rendering: d.rendering, mode: d.mode, width: d.width };
    case 'state': {
      if (!isObject(d.state)) return undefined;
      if (d.changes !== undefined && !(Array.isArray(d.changes) && d.changes.every((c: unknown) => isObject(c) && isPath(c.path) && isObject(c.author)))) return undefined;
      const msg: HostMsg = { type: 'state', state: d.state };
      if (d.changes) msg.changes = d.changes;
      return msg;
    }
    case 'anchorAt':
      return isReq(d.req) && isPoint(d.point) ? { type: 'anchorAt', req: d.req, point: { x: d.point.x, y: d.point.y } } : undefined;
    case 'locate':
      if (!isReq(d.req) || !Array.isArray(d.anchors) || !d.anchors.every((a: unknown) => isObject(a) && typeof a.id === 'string' && isAnchor(a.anchor))) return undefined;
      return { type: 'locate', req: d.req, anchors: d.anchors };
    case 'mode':
      return isMode(d.mode) ? { type: 'mode', mode: d.mode } : undefined;
    case 'scrollTo':
      return isNum(d.x) && isNum(d.y) && (d.seq === undefined || (isReq(d.seq) && d.seq >= 0)) ? { type: 'scrollTo', x: d.x, y: d.y, ...(d.seq === undefined ? {} : { seq: d.seq }) } : undefined;
    case 'focus': {
      const field = focusedField(d.field);
      return field ? { type: 'focus', field } : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * A message from the frame, from untrusted `event.data`, when it's on the bridge with this nonce. The
 * caller has already checked `event.source`. Shapes only: a write still goes through `applyOps`.
 */
export function parseFrameMsg(data: unknown, nonce: string): FrameMsg | undefined {
  if (!onBridge(data, nonce)) return undefined;
  const d = data as Record<string, any>;
  switch (d.type) {
    case 'ready':
      return isNum(d.version) ? { type: 'ready', version: d.version } : undefined;
    case 'write': {
      const w = d.write;
      if (!isObject(w) || !isPath(w.path)) return undefined;
      if (w.op === 'set' && w.value !== undefined) return { type: 'write', write: { op: 'set', path: w.path, value: w.value } };
      if (w.op === 'merge' && isObject(w.value)) return { type: 'write', write: { op: 'merge', path: w.path, value: w.value } };
      if (w.op === 'del' && w.path.length > 0) return { type: 'write', write: { op: 'del', path: w.path } };
      return undefined;
    }
    case 'action': {
      if (typeof d.name !== 'string' || d.name === '') return undefined;
      const msg: FrameMsg = { type: 'action', name: d.name };
      if (d.data !== undefined) msg.data = d.data;
      return msg;
    }
    case 'anchor':
      return isReq(d.req) && (d.anchor === null || isAnchor(d.anchor)) ? { type: 'anchor', req: d.req, anchor: d.anchor } : undefined;
    case 'positions':
      if (!isReq(d.req) || !Array.isArray(d.positions)) return undefined;
      if (!d.positions.every((p: unknown) => isObject(p) && typeof p.id === 'string' && (p.point === null || isPoint(p.point)) && typeof p.detached === 'boolean')) return undefined;
      return { type: 'positions', req: d.req, positions: d.positions };
    case 'layout':
      return isNum(d.width) && isNum(d.height) && isNum(d.scrollX) && isNum(d.scrollY) && (d.seq === undefined || (isReq(d.seq) && d.seq >= 0))
        ? { type: 'layout', width: d.width, height: d.height, scrollX: d.scrollX, scrollY: d.scrollY, ...(d.seq === undefined ? {} : { seq: d.seq }) }
        : undefined;
    case 'wheel':
      return isPoint(d.point) && isNum(d.dx) && isNum(d.dy) && [0, 1, 2].includes(d.deltaMode) && typeof d.zoom === 'boolean' && typeof d.shift === 'boolean'
        ? { type: 'wheel', point: d.point, dx: d.dx, dy: d.dy, deltaMode: d.deltaMode, zoom: d.zoom, shift: d.shift }
        : undefined;
    case 'space':
      return typeof d.pressed === 'boolean' ? { type: 'space', pressed: d.pressed } : undefined;
    case 'shortcut':
      return ['m', 'h', '+', '-', '0', '1'].includes(d.key) ? { type: 'shortcut', key: d.key } : undefined;
    case 'pan':
      return ['start', 'move', 'end'].includes(d.phase) && isPoint(d.point) ? { type: 'pan', phase: d.phase, point: d.point } : undefined;
    case 'focus': {
      if (d.field === null) return { type: 'focus', field: null };
      const field = focusedField(d.field);
      return field ? { type: 'focus', field } : undefined;
    }
    case 'escape':
      return { type: 'escape' };
    default:
      return undefined;
  }
}

/** The board operation a frame's state write becomes, for the card the host bound that frame to. */
export function writeOp(card: string, write: StateWrite): Op {
  if (write.op === 'del') return { op: 'state.del', card, path: write.path };
  if (write.op === 'merge') return { op: 'state.merge', card, path: write.path, value: write.value };
  return { op: 'state.set', card, path: write.path, value: write.value };
}

export function actionOp(card: string, name: string, data?: Json): Op {
  return data === undefined ? { op: 'state.action', card, name } : { op: 'state.action', card, name, data };
}

/** The longest unsaved value a focus report carries: a field's value goes into state, so the state limit applies when it's saved. */
export const MAX_FOCUS_VALUE = 100_000;

/** A FocusedField from untrusted data, with only the keys it knows; undefined when it names nothing or a key is the wrong shape. */
function focusedField(v: unknown): FocusedField | undefined {
  if (!isObject(v)) return undefined;
  const str = (s: unknown, max: number) => typeof s === 'string' && s !== '' && s.length <= max;
  const count = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;
  const hasKey = v.key !== undefined;
  const hasSel = v.selector !== undefined;
  if (hasKey === hasSel || (hasKey && !str(v.key, 500)) || (hasSel && !str(v.selector, 2000))) return undefined;
  if (v.index !== undefined && !count(v.index)) return undefined;
  if (v.start !== undefined && !count(v.start)) return undefined;
  if (v.end !== undefined && !count(v.end)) return undefined;
  if (v.direction !== undefined && v.direction !== 'forward' && v.direction !== 'backward' && v.direction !== 'none') return undefined;
  if (v.value !== undefined && !(typeof v.value === 'string' && v.value.length <= MAX_FOCUS_VALUE)) return undefined;
  if (v.composing !== undefined && typeof v.composing !== 'boolean') return undefined;
  const f: FocusedField = hasKey ? { key: v.key } : { selector: v.selector };
  for (const k of ['index', 'start', 'end', 'direction', 'value', 'composing'] as const) if (v[k] !== undefined) (f as Record<string, unknown>)[k] = v[k];
  return f;
}

function onBridge(data: unknown, nonce: string): boolean {
  return isObject(data) && data.channel === BRIDGE_CHANNEL && typeof data.nonce === 'string' && nonce !== '' && data.nonce === nonce;
}

function isObject(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isReq(v: unknown): v is number {
  return Number.isSafeInteger(v);
}

function isMode(v: unknown): v is BridgeMode {
  return v === 'use' || v === 'markup';
}

function isPath(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((k) => typeof k === 'string');
}

function isPoint(v: unknown): v is Point {
  return isObject(v) && isNum(v.x) && isNum(v.y);
}

function isAnchor(v: unknown): v is Anchor {
  if (!isObject(v) || !isPoint(v.point)) return false;
  if (v.kind === 'point') return true;
  return v.kind === 'element' && isPoint(v.offset) && (typeof v.wbId === 'string' || typeof v.selector === 'string');
}

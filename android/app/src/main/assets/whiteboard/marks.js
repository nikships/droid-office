// The phone's card surface without the DOM (host.js draws it): the office's constants, the bridge's
// shapes, a card's state and marks after the owner's own operations, and the operations a drag or a
// reattach sends. Each mirrors src/shared/whiteboard.ts, whiteboard-marks.ts or whiteboard-bridge.ts,
// and tests/android-whiteboard.test.ts holds them to those.

export const CANONICAL_WIDTH = 1280;
/** The frame's sandbox flags (CARD_SANDBOX): never allow-same-origin. */
export const CARD_SANDBOX = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads';
/** What the frame is granted (CARD_ALLOW): clipboard writes, for an artifact's own Copy button, and nothing else. */
export const CARD_ALLOW = 'clipboard-write *';
export const BRIDGE_CHANNEL = 'droid-office-whiteboard';
export const STICKY_COLORS = { yellow: '#ffd866', pink: '#ff9fc6', blue: '#8fd3ff', green: '#a6e3a1', orange: '#ffb070', purple: '#cdb4ff' };
export const STICKY_SIZE = { w: 200, h: 160 };
export const DRAG_MIN = 40;
/** The room the office's window leaves round a canvas's marks (CANVAS_MARGIN). */
export const CANVAS_MARGIN = 80;
export const CANVAS_EMPTY = { x: 0, y: 0, w: CANONICAL_WIDTH, h: 720 };
const OWNER = { kind: 'owner' };

export const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
export const isPoint = (v) => isObj(v) && isNum(v.x) && isNum(v.y);
export const isPath = (v) => Array.isArray(v) && v.every((k) => typeof k === 'string');
export function isAnchor(v) {
  if (!isObj(v) || !isPoint(v.point)) return false;
  if (v.kind === 'point') return true;
  return v.kind === 'element' && isPoint(v.offset) && (typeof v.wbId === 'string' || typeof v.selector === 'string');
}

export const copy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
export const anchorKey = (a) => JSON.stringify(a);

export function jsonEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]));
}

/** A state stamp's key as a path (statePathKey is JSON). */
export function parseStatePathKey(key) {
  try {
    const p = JSON.parse(key);
    return isPath(p) ? p : [key];
  } catch {
    return [key];
  }
}

function walk(state, path) {
  let cur = state;
  for (const k of path) {
    if (!isObj(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  return cur;
}

function mergeInto(target, src) {
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (isObj(v)) {
      if (!isObj(target[k])) target[k] = {};
      mergeInto(target[k], v);
    } else target[k] = copy(v);
  }
}

/** A card's state after one of its own state operations, as the board's reducer writes it. */
export function stateWith(state, op, now = Date.now()) {
  const s = copy(state) ?? {};
  const path = op.path ?? [];
  if (op.op === 'state.set') {
    if (!path.length) return isObj(op.value) ? copy(op.value) : s;
    walk(s, path.slice(0, -1))[path[path.length - 1]] = copy(op.value);
  } else if (op.op === 'state.merge') {
    let target = s;
    if (path.length) {
      const parent = walk(s, path.slice(0, -1));
      const k = path[path.length - 1];
      if (!isObj(parent[k])) parent[k] = {};
      target = parent[k];
    }
    mergeInto(target, op.value);
  } else if (op.op === 'state.del') {
    let parent = s;
    for (const k of path.slice(0, -1)) parent = isObj(parent) ? parent[k] : undefined;
    if (isObj(parent)) delete parent[path[path.length - 1]];
  } else if (op.op === 'state.action') {
    walk(s, ['actions'])[op.name] = { name: op.name, data: op.data === undefined ? null : copy(op.data), at: now };
  }
  return s;
}

/** The board operation a frame's state write becomes (writeOp); null for a write of the wrong shape (parseFrameMsg). */
export function writeOp(card, w) {
  if (!isObj(w) || !isPath(w.path)) return null;
  if (w.op === 'set' && w.value !== undefined) return { op: 'state.set', card, path: w.path, value: w.value };
  if (w.op === 'merge' && isObj(w.value)) return { op: 'state.merge', card, path: w.path, value: w.value };
  if (w.op === 'del' && w.path.length > 0) return { op: 'state.del', card, path: w.path };
  return null;
}

export const actionOp = (card, name, data) => (data === undefined ? { op: 'state.action', card, name } : { op: 'state.action', card, name, data });

/** The state leaves that changed between two versions of a card, and who changed each: for "changed by Pixel". */
export function stateChanges(before, next) {
  const was = before?.stamps?.state ?? {};
  const now = next?.stamps?.state ?? {};
  return Object.keys(now)
    .filter((key) => !was[key] || was[key].rev !== now[key].rev)
    .map((key) => ({ path: parseStatePathKey(key), author: now[key].author }));
}

/** A card from the office, with every list and stamp a card from an older office might leave out. */
export function normalize(c) {
  c.threads = Array.isArray(c.threads) ? c.threads : [];
  c.stickies = Array.isArray(c.stickies) ? c.stickies : [];
  c.pictures = Array.isArray(c.pictures) ? c.pictures : [];
  c.state = isObj(c.state) ? c.state : {};
  c.stamps = isObj(c.stamps) ? c.stamps : {};
  c.stamps.state = isObj(c.stamps.state) ? c.stamps.state : {};
  return c;
}

export const contentRev = (c) => c?.stamps?.content?.rev ?? 0;

export function findMark(card, kind, id) {
  const list = kind === 'thread' ? card.threads : kind === 'sticky' ? card.stickies : card.pictures;
  return list.find((m) => m.id === id) ?? null;
}

export const kindOf = (card, id) => ['thread', 'sticky', 'picture'].find((k) => findMark(card, k, id)) ?? null;

/**
 * What one of the page's own operations does to the card, so it shows at once (the office's window
 * applies its batches to its board the same way before they're sent). The office's answer replaces it.
 */
export function applyLocal(card, op) {
  switch (op.op) {
    case 'state.set':
    case 'state.merge':
    case 'state.del':
    case 'state.action':
      card.state = stateWith(card.state, op);
      return;
    case 'sticky.add':
      card.stickies.push({ id: op.id, text: op.text ?? '', color: op.color ?? 'yellow', anchor: op.anchor, box: { x: 0, y: 0, ...STICKY_SIZE, ...op.box }, stamps: { text: { rev: 0, author: OWNER } } });
      return;
    case 'picture.add':
      card.pictures.push({ id: op.id, file: op.file, anchor: op.anchor, box: { x: 0, y: 0, ...op.box }, stamps: { file: { rev: 0, author: OWNER } } });
      return;
    case 'sticky.move':
    case 'picture.move': {
      const m = findMark(card, op.op === 'sticky.move' ? 'sticky' : 'picture', op.id);
      if (m) m.box = { ...m.box, ...op.box };
      return;
    }
    case 'sticky.reattach':
    case 'picture.reattach':
    case 'comment.reattach': {
      const m = op.op === 'comment.reattach' ? findMark(card, 'thread', op.thread) : findMark(card, op.op === 'sticky.reattach' ? 'sticky' : 'picture', op.id);
      if (m) {
        m.anchor = op.anchor;
        delete m.detached;
      }
      return;
    }
    case 'sticky.rm':
      card.stickies = card.stickies.filter((x) => x.id !== op.id);
      return;
    case 'picture.rm':
      card.pictures = card.pictures.filter((x) => x.id !== op.id);
      return;
    case 'marks.resolve':
      for (const r of op.marks) {
        const m = findMark(card, 'thread', r.id) ?? findMark(card, 'sticky', r.id) ?? findMark(card, 'picture', r.id);
        if (!m) continue;
        if (r.detached) m.detached = true;
        else delete m.detached;
      }
      return;
  }
}

/** The bounds of a canvas's marks plus `margin` (canvasBounds), each at the point `at` gives its anchor. */
export function canvasBounds(card, margin = CANVAS_MARGIN, at = (m) => m.anchor.point) {
  const boxes = [
    ...card.pictures.map((p) => ({ ...p.box, x: at(p).x + p.box.x, y: at(p).y + p.box.y })),
    ...card.stickies.map((s) => ({ ...s.box, x: at(s).x + s.box.x, y: at(s).y + s.box.y })),
    ...card.threads.map((t) => ({ x: at(t).x, y: at(t).y, w: 1, h: 1 })),
  ];
  if (!boxes.length) return CANVAS_EMPTY;
  const x0 = Math.min(...boxes.map((b) => b.x)) - margin;
  const y0 = Math.min(...boxes.map((b) => b.y)) - margin;
  const x1 = Math.max(...boxes.map((b) => b.x + b.w)) + margin;
  const y1 = Math.max(...boxes.map((b) => b.y + b.h)) + margin;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** A picture's size on the page: its own, scaled down to fit `max` on its longer side (pictureSize). */
export function pictureSize(natural, max = 480) {
  const w = Math.max(1, natural.w);
  const h = Math.max(1, natural.h);
  const s = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(16, Math.round(w * s)), h: Math.max(16, Math.round(h * s)) };
}

/** Where a sticky or picture is drawn while its drag is in progress (dragPreview). */
export function dragPreview(origin, box, dx, dy, what) {
  if (what === 'move') return { x: origin.x + box.x + dx, y: origin.y + box.y + dy, w: box.w, h: box.h };
  return { x: origin.x + box.x, y: origin.y + box.y, w: Math.max(DRAG_MIN, box.w + dx), h: Math.max(DRAG_MIN, box.h + dy) };
}

const moveOp = (kind, card, id, box) => ({ op: `${kind}.move`, card, id, box });
const reattachOne = (kind, card, id, anchor) => ({ op: `${kind}.reattach`, card, id, anchor });

/** The operations a finished drag sends (dragMarkOps). */
export function dragMarkOps(o) {
  if (o.what === 'resize') return [moveOp(o.kind, o.card, o.id, { w: Math.round(Math.max(DRAG_MIN, o.box.w + o.dx)), h: Math.round(Math.max(DRAG_MIN, o.box.h + o.dy)) })];
  if (!o.anchor) return [moveOp(o.kind, o.card, o.id, { x: Math.round(o.box.x + o.dx), y: Math.round(o.box.y + o.dy) })];
  const ops = [reattachOne(o.kind, o.card, o.id, o.anchor)];
  if (o.box.x !== 0 || o.box.y !== 0) ops.push(moveOp(o.kind, o.card, o.id, { x: 0, y: 0 }));
  return ops;
}

/** The operations that put a mark back on a spot the owner tapped (reattachMarkOps). */
export function reattachMarkOps(o) {
  if (o.kind === 'thread') return [{ op: 'comment.reattach', card: o.card, thread: o.id, anchor: o.anchor }];
  const ops = [reattachOne(o.kind, o.card, o.id, o.anchor)];
  if (o.box && (o.box.x !== 0 || o.box.y !== 0)) ops.push(moveOp(o.kind, o.card, o.id, { x: 0, y: 0 }));
  return ops;
}

export const authorName = (a) => (!a || a.kind === 'owner' ? 'You' : a.name || 'A worker');
export const authorColor = (a) => (!a || a.kind === 'owner' ? '#eeeeee' : a.color || '#eeeeee');

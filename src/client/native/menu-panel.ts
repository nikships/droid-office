/**
 * A menu for the headset app that floats in the world like an object: a dark slab, sized in metres,
 * with a few big rows a controller ray can hit from arm's length or across a desk (Half-Life: Alyx's
 * pause and options panels are the model: few rows, ‹ value › steppers, one clear way out).
 *
 * The face is a WorldPanel (vr/panel.ts) painted from a MenuModel and drawn opaque, so the headset
 * app also draws it in its unfoveated high-resolution screen layer, as crisp as a laptop screen.
 * layoutMenu is pure: tests check every row's targets without a canvas.
 */

import * as THREE from 'three';
import { SANS, fontRevision } from '../fonts';
import { WorldPanel, type PanelButton, type PanelPaintState } from '../vr/panel';
import type { Rect } from '../vr/math';
import { toon } from '../world/toon';

export interface MenuButton {
  id: string;
  label: string;
  run: () => void;
  primary?: boolean;
  disabled?: boolean;
}

export type MenuRow =
  /** A setting with a value and ‹ › to step it; a missing step is at its end. `repeat` steps on while held. */
  | { kind: 'value'; id: string; label: string; value: string; dec: (() => void) | null; inc: (() => void) | null; repeat?: boolean; wide?: boolean }
  /** An on/off setting: the whole row flips it. */
  | { kind: 'toggle'; id: string; label: string; on: boolean; toggle: (() => void) | null }
  /** One or more buttons side by side. */
  | { kind: 'buttons'; id: string; buttons: MenuButton[] }
  /** A line of plain text: what is so right now. */
  | { kind: 'note'; id: string; text: string; tone?: 'warn' };

export interface MenuModel {
  title: string;
  rows: MenuRow[];
}

/** Heights in metres. Rows are big: a controller ray holds still to a centimetre or two at arm's length. */
export const MENU_TITLE_M = 0.05;
export const MENU_ROW_M: Record<MenuRow['kind'], number> = { value: 0.046, toggle: 0.046, buttons: 0.056, note: 0.03 };
const PAD_M = 0.016;
/** The ‹ and › targets of a value row, and the close button, are this wide. */
const STEP_M = 0.052;
/** A value row's value box: most of the row for a `wide` one (a long engine name). */
const valueWidth = (row: { wide?: boolean }, rowW: number, perM: number) => (row.wide ? rowW * 0.54 : Math.min(perM * 0.15, rowW * 0.4));

/** The panel height a list of rows needs. */
export function menuHeight(rows: readonly MenuRow['kind'][]): number {
  return PAD_M * 2 + MENU_TITLE_M + rows.reduce((sum, kind) => sum + MENU_ROW_M[kind], 0);
}

export interface MenuTarget {
  /** Unique per menu: `close`, `<row>:dec`, `<row>:inc`, `<row>` (a toggle), `<row>:<button>`. */
  id: string;
  rect: Rect;
  run: () => void;
  /** A held ‹ › that keeps stepping. */
  repeat: boolean;
}

export interface MenuLayout {
  title: Rect;
  rows: { row: MenuRow; rect: Rect }[];
  targets: MenuTarget[];
}

/** Where everything goes on a `widthM` by `heightM` panel, in panel coordinates (0..1, top left). */
export function layoutMenu(model: MenuModel, widthM: number, heightM: number): MenuLayout {
  const nx = (m: number) => m / widthM;
  const ny = (m: number) => m / heightM;
  const targets: MenuTarget[] = [];
  const title: Rect = { x: nx(PAD_M), y: ny(PAD_M), w: 1 - nx(PAD_M * 2), h: ny(MENU_TITLE_M) };
  targets.push({ id: 'close', rect: { x: 1 - nx(PAD_M + STEP_M), y: title.y, w: nx(STEP_M), h: title.h }, run: () => {}, repeat: false });
  let y = title.y + title.h;
  const rows: MenuLayout['rows'] = [];
  for (const row of model.rows) {
    const h = ny(MENU_ROW_M[row.kind]);
    const rect: Rect = { x: title.x, y, w: title.w, h };
    rows.push({ row, rect });
    if (row.kind === 'value') {
      const stepW = nx(STEP_M);
      const valueW = valueWidth(row, rect.w, nx(1));
      const right = rect.x + rect.w;
      if (row.dec) targets.push({ id: `${row.id}:dec`, rect: { x: right - valueW - stepW * 2, y, w: stepW, h }, run: row.dec, repeat: !!row.repeat });
      if (row.inc) targets.push({ id: `${row.id}:inc`, rect: { x: right - stepW, y, w: stepW, h }, run: row.inc, repeat: !!row.repeat });
    } else if (row.kind === 'toggle') {
      if (row.toggle) targets.push({ id: row.id, rect, run: row.toggle, repeat: false });
    } else if (row.kind === 'buttons') {
      const gap = nx(0.012);
      const n = row.buttons.length;
      const w = (rect.w - gap * (n - 1)) / Math.max(1, n);
      const inset = ny(0.008);
      row.buttons.forEach((b, i) => {
        if (b.disabled) return;
        targets.push({ id: `${row.id}:${b.id}`, rect: { x: rect.x + i * (w + gap), y: y + inset, w, h: h - inset * 2 }, run: b.run, repeat: false });
      });
    }
    y += h;
  }
  return { title, rows, targets };
}

/** What a theme changes: the frame, highlights and primary buttons. */
export interface MenuTheme {
  accent: string;
  /** Text on an accent-filled button. */
  ink: string;
}

const BG = '#0f1117';
const ROW_LINE = '#262a36';
const TEXT = '#eef0f6';
const MUTED = '#8b90a3';
const WARN = '#ffb454';
/** How long a held ‹ › waits before stepping on, and how often it steps then (seconds). */
const REPEAT_AFTER = 0.45;
const REPEAT_EVERY = 0.085;

export interface VrMenuOptions {
  width: number;
  height: number;
  theme: MenuTheme;
  /** The current rows, built fresh from office state whenever the menu refreshes. */
  build: () => MenuModel;
  onClose: () => void;
  /** A press landed on something: for a click sound and a haptic tick. */
  onPress?: (id: string) => void;
}

/** A menu slab: put `root` in the scene where it should float, facing the player. */
export class VrMenu {
  readonly root = new THREE.Group();
  readonly panel: WorldPanel;
  private readonly opts: VrMenuOptions;
  private model: MenuModel;
  private layout: MenuLayout;
  private key = '';
  private fonts = -1;
  private held: { id: string; since: number; last: number; repeated: boolean } | null = null;

  constructor(opts: VrMenuOptions) {
    this.opts = opts;
    const dpr = typeof window === 'undefined' ? 1 : Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    this.panel = new WorldPanel({ width: opts.width, height: opts.height, pxPerMeter: 2400 / dpr, opaque: true, paint: (ctx, w, h, _dirty, state) => this.paint(ctx, w, h, state) });
    this.panel.mesh.name = 'native-menu-face';
    // A slab, not a sticker: a dark back a little larger than the face, so it reads as an object from the side.
    const back = new THREE.Mesh(new THREE.BoxGeometry(opts.width + 0.018, opts.height + 0.018, 0.014), toon('#1b1e27'));
    back.position.z = -0.0085;
    back.name = 'native-menu-back';
    this.root.add(back, this.panel.group);
    this.root.visible = false;
    this.model = opts.build();
    this.layout = layoutMenu(this.model, opts.width, opts.height);
    this.applyTargets();
  }

  get visible(): boolean {
    return this.root.visible;
  }

  setVisible(on: boolean) {
    this.root.visible = on;
    this.panel.setVisible(on);
    if (!on) {
      this.held = null;
      this.panel.pointerCancel();
    } else this.refresh(true);
  }

  /** Rebuilds the rows from office state; repaints when anything shown changed. */
  refresh(force = false) {
    const model = this.opts.build();
    const key = JSON.stringify(model, (_k, v) => (typeof v === 'function' ? 1 : v));
    if (!force && key === this.key && fontRevision() === this.fonts) {
      this.model = model;
      this.rebind();
      return;
    }
    this.key = key;
    this.fonts = fontRevision();
    this.model = model;
    this.layout = layoutMenu(model, this.opts.width, this.opts.height);
    this.applyTargets();
    this.panel.markDirty();
  }

  /** The ids of every target on it now (for the debug hook and tests). */
  targetIds(): string[] {
    return this.layout.targets.map((t) => t.id);
  }

  /** Where a target is on the face (panel coordinates), or null when it is not there now. */
  targetRect(id: string): Rect | null {
    return this.layout.targets.find((t) => t.id === id)?.rect ?? null;
  }

  /** Runs a target as a press on it would; false when it is not there. */
  press(id: string): boolean {
    const t = this.layout.targets.find((x) => x.id === id);
    if (!t || !this.visible) return false;
    this.run(t);
    return true;
  }

  /** A ray's hit on the face: its uv, or null when it misses or the menu is hidden. */
  hit(raycaster: THREE.Raycaster): { uv: { u: number; v: number }; point: THREE.Vector3 } | null {
    if (!this.visible) return null;
    const h = raycaster.intersectObject(this.panel.mesh, false)[0];
    if (!h?.uv || h.uv.x < 0 || h.uv.x > 1 || h.uv.y < 0 || h.uv.y > 1) return null;
    return { uv: { u: h.uv.x, v: h.uv.y }, point: h.point };
  }

  /** Steps a held ‹ › on, and repaints. `now` in seconds. */
  update(dt: number, now: number) {
    if (!this.visible) return;
    const held = this.held;
    if (held && this.panel.isPressed(held.id)) {
      const t = this.layout.targets.find((x) => x.id === held.id);
      if (t?.repeat && now - held.since >= REPEAT_AFTER && now - held.last >= REPEAT_EVERY) {
        held.last = now;
        held.repeated = true;
        t.run();
        this.refresh();
      }
    }
    this.panel.update(dt);
  }

  /** The press started on a target (the trigger went down with the ray on it). */
  pressStarted(id: string, now: number) {
    this.held = { id, since: now, last: now, repeated: false };
  }

  private run(t: MenuTarget) {
    this.opts.onPress?.(t.id);
    if (t.id === 'close') this.opts.onClose();
    else t.run();
    this.refresh();
  }

  private applyTargets() {
    const buttons: PanelButton[] = this.layout.targets.map((t) => ({
      id: t.id,
      rect: t.rect,
      onClick: () => {
        // A ‹ › that stepped on while held has already done its steps: letting go adds none.
        const held = this.held;
        this.held = null;
        if (held?.id === t.id && held.repeated) return;
        const live = this.layout.targets.find((x) => x.id === t.id);
        if (live) this.run(live);
      },
    }));
    this.panel.setButtons(buttons);
  }

  /** Model callbacks change with every rebuild; the targets keep their ids and rects. */
  private rebind() {
    const fresh = layoutMenu(this.model, this.opts.width, this.opts.height);
    this.layout.targets = fresh.targets;
  }

  private paint(ctx: CanvasRenderingContext2D, w: number, h: number, state: PanelPaintState) {
    const { accent, ink } = this.opts.theme;
    const px = (r: Rect) => ({ x: r.x * w, y: r.y * h, w: r.w * w, h: r.h * h });
    const perM = w / this.opts.width;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, w, h);
    // The frame: a thin accent line with heavier corners.
    const inset = perM * 0.006;
    ctx.strokeStyle = accent;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = Math.max(2, perM * 0.0016);
    ctx.strokeRect(inset, inset, w - inset * 2, h - inset * 2);
    ctx.globalAlpha = 1;
    ctx.lineWidth = Math.max(4, perM * 0.0035);
    const arm = perM * 0.03;
    for (const [cx, cy, sx, sy] of [
      [inset, inset, 1, 1],
      [w - inset, inset, -1, 1],
      [inset, h - inset, 1, -1],
      [w - inset, h - inset, -1, -1],
    ] as const) {
      ctx.beginPath();
      ctx.moveTo(cx, cy + sy * arm);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx + sx * arm, cy);
      ctx.stroke();
    }
    const hot = (id: string) => state.pressedId === id || state.hoverId === id;
    const glow = (r: Rect, id: string, round = perM * 0.008) => {
      if (!hot(id)) return;
      const p = px(r);
      ctx.fillStyle = accent;
      ctx.globalAlpha = state.pressedId === id ? 0.42 : 0.2;
      roundRect(ctx, p.x, p.y, p.w, p.h, round);
      ctx.fill();
      ctx.globalAlpha = 1;
    };
    const text = (s: string, x: number, y: number, size: number, weight: number, color: string, align: CanvasTextAlign = 'left', maxW = w) => {
      ctx.font = `${weight} ${size}px ${SANS}`;
      ctx.fillStyle = color;
      ctx.textAlign = align;
      ctx.textBaseline = 'middle';
      // Too long: smaller type first (to 72%), and only then cut short.
      const full = ctx.measureText(s).width;
      if (full > maxW) ctx.font = `${weight} ${Math.max(size * 0.72, (size * maxW) / full)}px ${SANS}`;
      let shown = s;
      while (shown.length > 1 && ctx.measureText(shown).width > maxW) shown = `${shown.slice(0, -2)}…`;
      ctx.fillText(shown, x, y);
    };
    // Title bar, with the close button at its right.
    const t = px(this.layout.title);
    text(this.model.title.toUpperCase(), t.x + perM * 0.006, t.y + t.h / 2, perM * 0.018, 700, accent, 'left', t.w - perM * (STEP_M + 0.02));
    const close = this.layout.targets.find((x) => x.id === 'close');
    if (close) {
      glow(close.rect, 'close');
      const c = px(close.rect);
      const r = Math.min(c.w, c.h) * 0.2;
      ctx.strokeStyle = state.hoverId === 'close' ? TEXT : MUTED;
      ctx.lineWidth = Math.max(3, perM * 0.0028);
      ctx.beginPath();
      ctx.moveTo(c.x + c.w / 2 - r, c.y + c.h / 2 - r);
      ctx.lineTo(c.x + c.w / 2 + r, c.y + c.h / 2 + r);
      ctx.moveTo(c.x + c.w / 2 + r, c.y + c.h / 2 - r);
      ctx.lineTo(c.x + c.w / 2 - r, c.y + c.h / 2 + r);
      ctx.stroke();
    }
    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.5;
    ctx.fillRect(t.x, t.y + t.h - Math.max(2, perM * 0.0015), t.w, Math.max(2, perM * 0.0015));
    ctx.globalAlpha = 1;
    const labelPx = perM * 0.0165;
    for (const { row, rect } of this.layout.rows) {
      const r = px(rect);
      const mid = r.y + r.h / 2;
      if (row.kind !== 'note' && row.kind !== 'buttons') {
        ctx.fillStyle = ROW_LINE;
        ctx.fillRect(r.x, r.y + r.h - 2, r.w, 2);
      }
      if (row.kind === 'value') {
        const dec = this.layout.targets.find((x) => x.id === `${row.id}:dec`);
        const inc = this.layout.targets.find((x) => x.id === `${row.id}:inc`);
        const stepW = (STEP_M / this.opts.width) * w;
        const valueW = valueWidth(row, r.w, perM);
        const right = r.x + r.w;
        text(row.label.toUpperCase(), r.x + perM * 0.006, mid, labelPx, 600, TEXT, 'left', r.w - valueW - stepW * 2 - perM * 0.02);
        text(row.value, right - stepW - valueW / 2, mid, labelPx, 700, TEXT, 'center', valueW);
        for (const [target, x, glyph] of [
          [dec, right - valueW - stepW * 2, '‹'],
          [inc, right - stepW, '›'],
        ] as const) {
          if (target) glow(target.rect, target.id);
          text(glyph, x + stepW / 2, mid - perM * 0.002, perM * 0.03, 600, target ? accent : ROW_LINE, 'center');
        }
      } else if (row.kind === 'toggle') {
        glow(rect, row.id, perM * 0.006);
        const enabled = !!row.toggle;
        text(row.label.toUpperCase(), r.x + perM * 0.006, mid, labelPx, 600, enabled ? TEXT : MUTED, 'left', r.w * 0.7);
        const pillW = perM * 0.062;
        const pillH = r.h * 0.56;
        const px0 = r.x + r.w - pillW - perM * 0.008;
        ctx.lineWidth = Math.max(2, perM * 0.0018);
        roundRect(ctx, px0, mid - pillH / 2, pillW, pillH, pillH / 2);
        if (row.on) {
          ctx.fillStyle = enabled ? accent : MUTED;
          ctx.fill();
        } else {
          ctx.strokeStyle = MUTED;
          ctx.stroke();
        }
        text(row.on ? 'ON' : 'OFF', px0 + pillW / 2, mid, perM * 0.0135, 800, row.on ? ink : MUTED, 'center');
      } else if (row.kind === 'buttons') {
        const gap = perM * 0.012;
        const n = row.buttons.length;
        const bw = (r.w - gap * (n - 1)) / Math.max(1, n);
        const inset = perM * 0.008;
        row.buttons.forEach((b, i) => {
          const id = `${row.id}:${b.id}`;
          const x = r.x + i * (bw + gap);
          const y = r.y + inset;
          const bh = r.h - inset * 2;
          roundRect(ctx, x, y, bw, bh, perM * 0.008);
          if (b.primary && !b.disabled) {
            ctx.fillStyle = accent;
            ctx.fill();
          } else {
            ctx.strokeStyle = b.disabled ? ROW_LINE : accent;
            ctx.lineWidth = Math.max(2, perM * 0.0018);
            ctx.stroke();
          }
          if (!b.disabled && hot(id)) {
            ctx.fillStyle = b.primary ? '#ffffff' : accent;
            ctx.globalAlpha = state.pressedId === id ? 0.42 : 0.2;
            roundRect(ctx, x, y, bw, bh, perM * 0.008);
            ctx.fill();
            ctx.globalAlpha = 1;
          }
          text(b.label.toUpperCase(), x + bw / 2, y + bh / 2, perM * 0.015, 800, b.disabled ? MUTED : b.primary ? ink : TEXT, 'center', bw - perM * 0.012);
        });
      } else {
        text(row.text, r.x + perM * 0.006, mid, perM * 0.0125, 500, row.tone === 'warn' ? WARN : MUTED, 'left', r.w - perM * 0.012);
      }
    }
  }

  dispose() {
    this.root.removeFromParent();
    this.panel.dispose();
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

import * as THREE from 'three';
import { ANISOTROPY, SCREEN_SCALE } from './texture-quality';
import { DESK_BY_ID } from '../../shared/layout';
import type { GhIssue, GhPull, GhState, QueueState, QueueTask, ServiceInfo, WorkerInfo } from '../../shared/protocol';
import { ticketColumns, type JiraBoardState, type JiraCategory } from '../../shared/jira';
import { words, workerForPull } from '../state';
import { SANS, MONO } from '../fonts';
import { TAB_H, inRect, jiraLayout, tabRects, type BoardSpot, type Rect, type WallTab } from './board-layout';
import { paintGlyph, track } from './toon';

/** The boards are laid out on this many pixels; the canvas holds SCREEN_SCALE times as many. */
const BOARD_W = 1200;
const BOARD_H = 600;

// Factory product UI on the wall: a near-black screen, raised panels with hairline edges and square
// corners, mono uppercase labels, orange only for indexes and what's live, green and red only for status.
const BG = '#050505';
const PANEL = '#101010';
const PANEL_HOT = '#181818';
const HAIR = 'rgba(255, 255, 255, .1)';
const HAIR_STRONG = 'rgba(255, 255, 255, .18)';
const INK = '#eeeeee';
const MUTED = '#8c8c8c';
const FAINT = 'rgba(255, 255, 255, .32)';
const ORANGE = '#ee6018';
const GREEN = '#3ccf91';
const RED = '#ef4444';

/** A card's face on the boards and in a hand: one near-black family, a shade apart. */
export const NOTE_COLORS = ['#111111', '#121212', '#101010', '#131313', '#121212'];
/** The pin heads holding cards up: brushed steel, every fourth one Factory orange. */
export const PINS = ['#ee6018', '#8c8c8c', '#8c8c8c', '#8c8c8c'];

/** A screen's backdrop: near-black with a faint grid of hairlines, like Factory's product shots. */
function backdrop(g: CanvasRenderingContext2D) {
  g.fillStyle = BG;
  g.fillRect(0, 0, BOARD_W, BOARD_H);
  g.fillStyle = 'rgba(255, 255, 255, .025)';
  for (let x = 0; x < BOARD_W; x += 60) g.fillRect(x, 0, 1, BOARD_H);
  for (let y = 0; y < BOARD_H; y += 60) g.fillRect(0, y, BOARD_W, 1);
}

/** Sets a mono font with tracking (a fraction of its size). */
function mono(g: CanvasRenderingContext2D, weight: number, px: number, tracking = 0.04) {
  g.font = `${weight} ${px}px ${MONO}`;
  track(g, px * tracking);
}

function sans(g: CanvasRenderingContext2D, weight: number, px: number) {
  g.font = `${weight} ${px}px ${SANS}`;
  track(g, 0);
}

/** A squared mono status badge with `text` in `color` on a faint tint of it; returns its width. `align` right puts its right edge at `x`. */
function badge(g: CanvasRenderingContext2D, label: string, x: number, y: number, h: number, color: string, align: 'left' | 'right' = 'left', maxW = Infinity): number {
  const px = Math.round(h * 0.5);
  mono(g, 600, px, 0.08);
  const text = maxW === Infinity ? label : clip(g, label, maxW - h * 0.7);
  const w = g.measureText(text).width + h * 0.7;
  const x0 = align === 'right' ? x - w : x;
  g.save();
  g.globalAlpha = 0.12;
  g.fillStyle = color;
  g.fillRect(x0, y, w, h);
  g.restore();
  g.strokeStyle = color;
  g.lineWidth = 1.5;
  g.strokeRect(x0 + 0.75, y + 0.75, w - 1.5, h - 1.5);
  g.fillStyle = color;
  g.textBaseline = 'middle';
  g.textAlign = 'center';
  g.fillText(text, x0 + w / 2 + px * 0.04, y + h / 2 + 1);
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  track(g, 0);
  return w;
}

/** A pin head through a card's top edge: a dark collar, the head in its color, and a glint. */
function pin(g: CanvasRenderingContext2D, x: number, y: number, r: number, color: string) {
  g.beginPath();
  g.arc(x + r * 0.25, y + r * 0.35, r * 1.05, 0, Math.PI * 2);
  g.fillStyle = 'rgba(0, 0, 0, .55)';
  g.fill();
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fillStyle = '#2a2a2a';
  g.fill();
  g.beginPath();
  g.arc(x, y, r * 0.68, 0, Math.PI * 2);
  g.fillStyle = color;
  g.fill();
  g.fillStyle = 'rgba(255, 255, 255, .45)';
  g.fillRect(x - r * 0.35, y - r * 0.4, r * 0.3, r * 0.3);
}

export function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(next).width > maxW && cur) {
      lines.push(cur);
      cur = w;
      if (lines.length === maxLines) break;
    } else cur = next;
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) lines[maxLines - 1] = lines[maxLines - 1].replace(/.{0,2}$/, '…');
  return lines;
}

/** A note as it was last drawn: its middle, size and tilt on the canvas. */
interface DrawnNote {
  number: number;
  x: number;
  y: number;
  w: number;
  h: number;
  tilt: number;
}

const CATEGORY_COLOR: Record<JiraCategory, string> = { new: MUTED, indeterminate: ORANGE, done: GREEN };

function spotKey(spot: BoardSpot | null): string {
  return !spot ? '' : spot.kind === 'tab' ? `tab:${spot.tab}` : `ticket:${spot.key}`;
}

/** A pull request's checks and review, as the code review board's badges say them: a word and its status color. */
function checksBadge(p: GhPull): [string, string] {
  return p.checks === 'pass' ? ['PASS', GREEN] : p.checks === 'fail' ? ['FAIL', RED] : p.checks === 'pending' ? ['RUNNING', MUTED] : ['NO CHECKS', FAINT];
}

function reviewBadge(p: GhPull): [string, string] {
  if (p.isDraft) return ['DRAFT', FAINT];
  return p.reviewDecision === 'APPROVED' ? ['APPROVED', GREEN] : p.reviewDecision === 'CHANGES_REQUESTED' ? ['CHANGES', RED] : ['REVIEW', MUTED];
}

/**
 * Renders a wall display onto a canvas texture: the issues as pinned cards, or the pull requests as a
 * code review table. The issues board of a floor with a Jira epic also draws a tab strip across its
 * top, and on its Jira tab the epic's tickets in To Do, In Progress and Done.
 */
export class BoardTexture {
  readonly texture: THREE.CanvasTexture;
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private notes: DrawnNote[] = [];
  /** The tabs and Jira cards as they were last drawn, for pointing at. */
  private spots: { spot: BoardSpot; rect: Rect }[] = [];
  /** The note being reached for, drawn lifted off the board (see lift). */
  private lifted: number | null = null;
  /** The tab or Jira card being pointed at, drawn outlined (see hover). */
  private hovered = '';
  private jira: JiraBoardState | null = null;
  private shown: WallTab = 'issues';
  private last: [GhState<GhIssue> | GhState<GhPull>, Map<string, WorkerInfo> | undefined] | null = null;

  constructor(private kind: 'issues' | 'pulls') {
    this.canvas.width = BOARD_W * SCREEN_SCALE;
    this.canvas.height = BOARD_H * SCREEN_SCALE;
    this.ctx = this.canvas.getContext('2d')!;
    this.ctx.scale(SCREEN_SCALE, SCREEN_SCALE);
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = ANISOTROPY;
  }

  /** Whether any notes are up on the board. */
  get hasNotes(): boolean {
    return this.notes.length > 0;
  }

  /** The note at a point on the board's face (its uv), or undefined over the bare board. */
  noteAt(uv: THREE.Vector2): number | undefined {
    const px = uv.x * BOARD_W;
    const py = (1 - uv.y) * BOARD_H;
    // Topmost first: later notes are drawn over earlier ones.
    for (let i = this.notes.length - 1; i >= 0; i--) {
      const n = this.notes[i];
      // Into the note's own (tilted) frame.
      const dx = px - n.x;
      const dy = py - n.y;
      const c = Math.cos(-n.tilt);
      const s = Math.sin(-n.tilt);
      if (Math.abs(dx * c - dy * s) <= n.w / 2 && Math.abs(dx * s + dy * c) <= n.h / 2) return n.number;
    }
    return undefined;
  }

  /** Draws one note lifted off the board, the one you're about to take (null for none). */
  lift(number: number | null) {
    if (number === this.lifted) return;
    this.lifted = number;
    if (this.last) this.render(...this.last);
  }

  /** Outlines the tab or Jira card being pointed at (null for none). */
  hover(spot: BoardSpot | null) {
    const k = spotKey(spot);
    if (k === this.hovered) return;
    this.hovered = k;
    if (this.last) this.render(...this.last);
  }

  /** The tab or Jira card at a point on the board's face (its uv), or undefined. */
  spotAt(uv: THREE.Vector2): BoardSpot | undefined {
    const px = uv.x * BOARD_W;
    const py = (1 - uv.y) * BOARD_H;
    return this.spots.find((s) => inRect(s.rect, px, py))?.spot;
  }

  /** Which view is up: the forge's issues, or the Jira epic's tickets. */
  get tab(): WallTab {
    return this.shown;
  }

  /** Takes effect on the next render. The Jira tab needs a Jira board (see setJira). */
  setTab(tab: WallTab) {
    this.shown = tab === 'jira' && this.jira ? 'jira' : 'issues';
  }

  /** The floor's Jira board, or null for none (no tabs then). Takes effect on the next render. */
  setJira(jira: JiraBoardState | null) {
    this.jira = jira;
    if (!jira) this.shown = 'issues';
  }

  /** `workers` lets PR rows name the desk they came from. */
  render(state: GhState<GhIssue> | GhState<GhPull>, workers?: Map<string, WorkerInfo>) {
    this.last = [state, workers];
    this.notes = [];
    this.spots = [];
    const g = this.ctx;
    backdrop(g);
    const open = (state.items as (GhIssue | GhPull)[]).filter((i) => i.state === 'OPEN');
    const jira = this.kind === 'issues' ? this.jira : null;
    const top = jira ? TAB_H : 0;
    if (jira) this.drawTabs(jira, open.length);
    if (jira && this.shown === 'jira') {
      this.drawJira(jira, top);
      this.texture.needsUpdate = true;
      return;
    }
    if (!open.length) {
      const note = state.error ? state.error : state.loading && !state.fetchedAt ? 'Loading…' : this.kind === 'issues' ? 'No open issues' : 'No open PRs';
      this.centerNote(note, top, state.error ? 'NOTICE' : state.loading && !state.fetchedAt ? 'SYNCING' : 'ALL CLEAR', state.error ? ORANGE : MUTED);
      this.texture.needsUpdate = true;
      return;
    }
    if (this.kind === 'pulls') this.drawPulls(open as GhPull[], top, workers);
    else this.drawCards(open as GhIssue[], top);
    this.texture.needsUpdate = true;
  }

  /** The issues: Factory cards pinned up in a grid, fewer cards drawn bigger so a quiet board reads from across the room. */
  private drawCards(open: GhIssue[], top: number) {
    const g = this.ctx;
    const W = BOARD_W;
    const H = BOARD_H;
    const AH = H - top;
    const n = Math.min(open.length, 15);
    const cols = n <= 2 ? n : n <= 4 ? 2 : n <= 6 ? 3 : n <= 8 ? 4 : 5;
    const rows = Math.min(3, Math.ceil(n / cols));
    const scale = Math.min(2, Math.max(1, 3 / Math.max(cols, rows * 1.3)));
    const nw = Math.min(300 * scale, (W - 40) / cols - 30);
    const nh = Math.min(210 * scale, (AH - 40) / rows - 30);
    const gx = (W - cols * nw) / (cols + 1);
    const gy = (AH - rows * nh) / (rows + 1);
    open.slice(0, cols * rows).forEach((it, i) => {
      const c = i % cols;
      const r = Math.floor(i / cols);
      const x = gx + c * (nw + gx);
      const y = top + gy + r * (nh + gy);
      this.notes.push({ number: it.number, x: x + nw / 2, y: y + nh / 2, w: nw, h: nh, tilt: 0 });
      const lifted = it.number === this.lifted;
      g.save();
      g.translate(x + nw / 2, y + nh / 2);
      // Lifted: a little bigger and its shadow further off, as if it's coming away from the board.
      if (lifted) g.scale(1.06, 1.06);
      g.fillStyle = lifted ? 'rgba(0, 0, 0, .6)' : 'rgba(0, 0, 0, .45)';
      g.fillRect(-nw / 2 + (lifted ? 10 : 4), -nh / 2 + (lifted ? 12 : 5), nw, nh);
      g.fillStyle = lifted ? PANEL_HOT : NOTE_COLORS[it.number % NOTE_COLORS.length];
      g.fillRect(-nw / 2, -nh / 2, nw, nh);
      g.lineWidth = lifted ? 4 : 2;
      g.strokeStyle = lifted ? ORANGE : HAIR_STRONG;
      g.strokeRect(-nw / 2 + g.lineWidth / 2, -nh / 2 + g.lineWidth / 2, nw - g.lineWidth, nh - g.lineWidth);
      const fs = Math.round(22 * Math.min(nw / 220, nh / 164));
      const pad = Math.round(fs * 0.7);
      const left = -nw / 2 + pad;
      // The number in orange and a hairline under the card's head, the title in light sans, and its labels and author along the foot.
      mono(g, 700, Math.round(fs * 1.05), 0.04);
      g.fillStyle = ORANGE;
      g.fillText(`#${it.number}`, left, -nh / 2 + fs * 1.75);
      const labels = (it.labels ?? []).slice(0, 2).map((l) => l.name.toUpperCase());
      const footH = Math.round(fs * 1.15);
      const foot = nh / 2 - pad * 0.7 - footH;
      g.fillStyle = HAIR;
      g.fillRect(-nw / 2, -nh / 2 + fs * 2.4, nw, 1.5);
      sans(g, 600, fs);
      g.fillStyle = INK;
      const titleTop = -nh / 2 + fs * 3.5;
      const lines = Math.max(1, Math.floor((foot - titleTop + fs * 0.4) / (fs * 1.18)));
      wrap(g, it.title, nw - 2 * pad, Math.min(4, lines)).forEach((line, li) => g.fillText(line, left, titleTop + li * fs * 1.18));
      let bx = left;
      for (const l of labels) {
        const room = nw / 2 - pad - bx;
        if (room < footH * 2) break;
        bx += badge(g, l, bx, foot, footH, MUTED, 'left', room - footH) + 8;
      }
      if (it.author && bx < nw / 2 - pad - fs * 4) {
        g.textAlign = 'right';
        mono(g, 500, Math.round(fs * 0.68), 0.02);
        g.fillStyle = MUTED;
        g.fillText(clip(g, `@${it.author}`, nw / 2 - pad - bx - 8), nw / 2 - pad, foot + footH * 0.72);
        g.textAlign = 'left';
      }
      pin(g, 0, -nh / 2, Math.max(5, fs * 0.36), PINS[it.number % PINS.length]);
      g.restore();
    });
    if (open.length > cols * rows) this.more(open.length - cols * rows, W - 20, H - 16);
  }

  /** The pull requests: a code review table, a row each, with checks and review as status badges. */
  private drawPulls(open: GhPull[], top: number, workers?: Map<string, WorkerInfo>) {
    const g = this.ctx;
    const W = BOARD_W;
    const H = BOARD_H;
    const x0 = 24;
    const x1 = W - 24;
    const headY = top + 20;
    const headH = 40;
    const bodyTop = headY + headH;
    const bottom = H - 34;
    const fit = Math.max(1, Math.floor((bottom - bodyTop) / 64));
    const shown = open.slice(0, open.length > fit ? fit - 1 : fit);
    const rowH = Math.min(120, (bottom - bodyTop) / Math.max(shown.length, 3));
    const fs = Math.round(Math.min(30, rowH * 0.34));
    // Columns, from the right: lines changed, review, checks; the number and title take the rest.
    const colDiff = x1 - 16;
    const colReview = x1 - 150;
    const colChecks = x1 - 330;
    const colTitle = x0 + 24 + fs * 3.4;
    g.fillStyle = PANEL;
    g.fillRect(x0, headY, x1 - x0, bodyTop - headY + shown.length * rowH);
    g.strokeStyle = HAIR;
    g.lineWidth = 2;
    g.strokeRect(x0 + 1, headY + 1, x1 - x0 - 2, bodyTop - headY + shown.length * rowH - 2);
    mono(g, 600, 16, 0.14);
    g.fillStyle = MUTED;
    g.textBaseline = 'middle';
    g.fillText('PR', x0 + 24, headY + headH / 2);
    g.fillText('TITLE', colTitle, headY + headH / 2);
    g.fillText('CHECKS', colChecks - 140, headY + headH / 2);
    g.fillText('REVIEW', colReview - 150, headY + headH / 2);
    g.textAlign = 'right';
    g.fillText('+/-', colDiff, headY + headH / 2);
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    shown.forEach((p, i) => {
      const y = bodyTop + i * rowH;
      const lifted = p.number === this.lifted;
      this.notes.push({ number: p.number, x: (x0 + x1) / 2, y: y + rowH / 2, w: x1 - x0, h: rowH, tilt: 0 });
      g.fillStyle = HAIR;
      g.fillRect(x0, y, x1 - x0, 1.5);
      if (lifted) {
        g.fillStyle = PANEL_HOT;
        g.fillRect(x0 + 2, y + 2, x1 - x0 - 4, rowH - 3);
        g.fillStyle = ORANGE;
        g.fillRect(x0, y, 4, rowH);
      }
      const w = workers ? workerForPull(workers.values(), p) : undefined;
      const sub = [w ? `${w.name} · ${DESK_BY_ID.get(w.deskId)?.label ?? 'desk'}` : '', p.headRefName ? `${p.headRefName} → ${p.baseRefName || 'main'}` : ''].filter(Boolean).join('  ·  ');
      const mid = y + rowH / 2;
      const titleY = sub ? mid - fs * 0.12 : mid + fs * 0.36;
      mono(g, 700, fs, 0.02);
      g.fillStyle = ORANGE;
      g.fillText(`#${p.number}`, x0 + 24, titleY);
      sans(g, 600, fs);
      g.fillStyle = p.isDraft ? MUTED : INK;
      g.fillText(clip(g, p.title, colChecks - 160 - colTitle), colTitle, titleY);
      if (sub) {
        const subPx = Math.round(fs * 0.6);
        let sx = colTitle;
        if (w) {
          // A dot in the droid's color, so you can tell whose PR it is from across the room.
          g.beginPath();
          g.arc(sx + subPx * 0.35, mid + fs * 0.62 - subPx * 0.32, subPx * 0.35, 0, Math.PI * 2);
          g.fillStyle = w.color;
          g.fill();
          sx += subPx;
        }
        mono(g, 500, subPx, 0.02);
        g.fillStyle = MUTED;
        g.fillText(clip(g, sub, colChecks - 160 - sx), sx, mid + fs * 0.62);
      }
      const bh = Math.round(Math.min(34, rowH * 0.36));
      const [check, checkColor] = checksBadge(p);
      badge(g, check, colChecks - 140, mid - bh / 2, bh, checkColor);
      const [review, reviewColor] = reviewBadge(p);
      badge(g, review, colReview - 150, mid - bh / 2, bh, reviewColor);
      mono(g, 600, Math.round(fs * 0.72), 0.02);
      g.textAlign = 'right';
      const del = `-${p.deletions ?? 0}`;
      g.fillStyle = RED;
      g.fillText(del, colDiff, mid + fs * 0.26);
      const delW = g.measureText(del).width;
      g.fillStyle = GREEN;
      g.fillText(`+${p.additions ?? 0}`, colDiff - delW - 10, mid + fs * 0.26);
      g.textAlign = 'left';
    });
    track(g, 0);
    if (open.length > shown.length) this.more(open.length - shown.length, W - 24, H - 10);
  }

  /** "+N more" in the corner, for what didn't fit. */
  private more(n: number, x: number, y: number) {
    const g = this.ctx;
    mono(g, 500, 20, 0.1);
    g.fillStyle = MUTED;
    g.textAlign = 'right';
    g.fillText(`+${n} MORE`, x, y);
    g.textAlign = 'left';
    track(g, 0);
  }

  /** A message in a panel in the middle of the space below `top`, under an eyebrow: an orange square and `label`. */
  private centerNote(note: string, top: number, label = 'NOTICE', mark = ORANGE) {
    const g = this.ctx;
    const W = BOARD_W;
    const cy = (top + BOARD_H) / 2;
    mono(g, 500, 30, 0);
    const lines = wrap(g, note.replace(/`/g, ''), 780, 4);
    const boxW = 860;
    const boxH = 104 + lines.length * 42;
    const bx = W / 2 - boxW / 2;
    const by = cy - boxH / 2;
    g.fillStyle = PANEL;
    g.fillRect(bx, by, boxW, boxH);
    g.strokeStyle = HAIR_STRONG;
    g.lineWidth = 2;
    g.strokeRect(bx + 1, by + 1, boxW - 2, boxH - 2);
    g.fillStyle = mark;
    g.fillRect(bx + 40, by + 34, 12, 12);
    mono(g, 600, 18, 0.16);
    g.fillStyle = MUTED;
    g.textBaseline = 'middle';
    g.fillText(label, bx + 64, by + 41);
    mono(g, 500, 30, 0);
    g.fillStyle = INK;
    lines.forEach((line, i) => g.fillText(line, bx + 40, by + 86 + i * 42));
    g.textBaseline = 'alphabetic';
    track(g, 0);
  }

  /** The tab strip: the forge's issues and the Jira epic, the one showing underlined in orange. */
  private drawTabs(jira: JiraBoardState, openIssues: number) {
    const g = this.ctx;
    const rects = tabRects();
    const labels: Record<WallTab, string> = { issues: `${words().site} issues · ${openIssues}`, jira: `Jira · ${jira.epic} · ${jira.items.length}` };
    for (const tab of ['issues', 'jira'] as WallTab[]) {
      const r = rects[tab];
      const on = this.shown === tab;
      const hot = this.hovered === `tab:${tab}`;
      this.spots.push({ spot: { kind: 'tab', tab }, rect: r });
      g.fillStyle = on ? '#1c1c1c' : hot ? PANEL_HOT : PANEL;
      g.fillRect(r.x, r.y, r.w, r.h);
      g.lineWidth = 2;
      g.strokeStyle = hot ? ORANGE : on ? HAIR_STRONG : HAIR;
      g.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
      if (on) {
        g.fillStyle = ORANGE;
        g.fillRect(r.x, r.y + r.h - 4, r.w, 4);
      }
      g.fillStyle = on ? INK : MUTED;
      mono(g, 600, 22, 0.06);
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(clip(g, labels[tab].toUpperCase(), r.w - 24), r.x + r.w / 2, r.y + r.h / 2 + 1);
    }
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    g.fillStyle = MUTED;
    mono(g, 500, 18, 0.06);
    g.fillText('point at a tab to switch', BOARD_W - 24, rects.issues.y + rects.issues.h / 2);
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    track(g, 0);
  }

  /** The Jira tab: the epic's tickets in To Do, In Progress and Done, like the board window's. */
  private drawJira(jira: JiraBoardState, top: number) {
    if (jira.error && !jira.items.length) return this.centerNote(`Couldn't load ${jira.epic} from Jira: ${jira.error}`, top);
    if (!jira.fetchedAt) return this.centerNote(`Loading ${jira.epic} from Jira…`, top, 'SYNCING', MUTED);
    const g = this.ctx;
    const cols = ticketColumns(jira.items);
    const layout = jiraLayout(
      cols.map((c) => c.items.length),
      BOARD_W,
      BOARD_H,
      top + 6,
    );
    cols.forEach((col, i) => {
      const { rect, cards, hidden } = layout.columns[i];
      g.fillStyle = 'rgba(255, 255, 255, .025)';
      g.fillRect(rect.x, rect.y, rect.w, rect.h);
      g.strokeStyle = HAIR;
      g.lineWidth = 2;
      g.strokeRect(rect.x, rect.y, rect.w, rect.h);
      mono(g, 600, 22, 0.12);
      g.fillStyle = ORANGE;
      g.fillText(`0${i + 1}`, rect.x + 14, rect.y + 34);
      const idxW = g.measureText(`0${i + 1}`).width;
      g.fillStyle = INK;
      g.fillText(col.name.toUpperCase(), rect.x + 14 + idxW + 10, rect.y + 34);
      g.fillStyle = MUTED;
      g.textAlign = 'right';
      g.fillText(String(col.items.length), rect.x + rect.w - 14, rect.y + 34);
      g.textAlign = 'left';
      if (!col.items.length) {
        g.fillStyle = FAINT;
        mono(g, 500, 18, 0.1);
        g.fillText('NOTHING HERE', rect.x + 14, rect.y + 84);
      }
      cards.forEach((r, j) => {
        const t = col.items[j];
        const hot = this.hovered === `ticket:${t.key}`;
        this.spots.push({ spot: { kind: 'ticket', key: t.key }, rect: r });
        g.fillStyle = hot ? PANEL_HOT : NOTE_COLORS[j % NOTE_COLORS.length];
        g.fillRect(r.x, r.y, r.w, r.h);
        g.lineWidth = hot ? 4 : 2;
        g.strokeStyle = hot ? ORANGE : HAIR_STRONG;
        g.strokeRect(r.x + g.lineWidth / 2, r.y + g.lineWidth / 2, r.w - g.lineWidth, r.h - g.lineWidth);
        g.fillStyle = CATEGORY_COLOR[t.category];
        g.fillRect(r.x, r.y, 4, r.h);
        g.fillStyle = ORANGE;
        mono(g, 700, 20, 0.02);
        g.fillText(t.key, r.x + 16, r.y + 26);
        const keyW = g.measureText(t.key).width;
        const side = [t.type, t.assignee ?? 'unassigned'].filter(Boolean).join(' · ').toUpperCase();
        g.fillStyle = MUTED;
        mono(g, 500, 15, 0.06);
        g.textAlign = 'right';
        g.fillText(clip(g, side, r.w - keyW - 44), r.x + r.w - 12, r.y + 26);
        g.textAlign = 'left';
        g.fillStyle = INK;
        sans(g, 600, 20);
        wrap(g, t.summary, r.w - 30, 2).forEach((line, li) => g.fillText(line, r.x + 16, r.y + 54 + li * 24));
      });
      if (hidden > 0) this.more(hidden, rect.x + rect.w - 14, rect.y + rect.h - 12);
    });
    track(g, 0);
  }
}

/** The services board: a wall display listing the web servers droids are running. */
export class ServicesBoardTexture {
  readonly texture: THREE.CanvasTexture;
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private drawn = '';

  constructor() {
    this.canvas.width = BOARD_W * SCREEN_SCALE;
    this.canvas.height = BOARD_H * SCREEN_SCALE;
    this.ctx = this.canvas.getContext('2d')!;
    this.ctx.scale(SCREEN_SCALE, SCREEN_SCALE);
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = ANISOTROPY;
  }

  render(items: ServiceInfo[], workers: Map<string, WorkerInfo>) {
    const rows = items.map((s) => {
      const w = workers.get(s.workerId);
      return { port: s.port, title: s.title || s.command, who: [w?.name ?? 'A droid', w?.worktree?.branch].filter(Boolean).join(' · '), color: w?.color ?? '#8d99ae' };
    });
    // Droid updates stream in constantly; only redraw when what's shown changes.
    const key = JSON.stringify(rows);
    if (key === this.drawn) return;
    this.drawn = key;
    const g = this.ctx;
    const W = BOARD_W;
    const H = BOARD_H;
    backdrop(g);
    if (!rows.length) {
      g.textAlign = 'center';
      g.fillStyle = INK;
      mono(g, 600, 40, 0.04);
      g.fillText('No web servers running', W / 2, H / 2 - 20);
      g.fillStyle = MUTED;
      mono(g, 500, 24, 0.02);
      g.fillText('When a droid starts one, it shows up here', W / 2, H / 2 + 36);
      g.textAlign = 'left';
      track(g, 0);
      this.texture.needsUpdate = true;
      return;
    }
    const shown = rows.slice(0, 5);
    const rowH = Math.min(140, (H - 40) / shown.length);
    const fs = Math.round(rowH * 0.36);
    shown.forEach((r, i) => {
      const y = 20 + i * rowH;
      g.fillStyle = PANEL;
      g.fillRect(24, y + 6, W - 48, rowH - 12);
      g.strokeStyle = HAIR_STRONG;
      g.lineWidth = 2;
      g.strokeRect(25, y + 7, W - 50, rowH - 14);
      // A live light, and the droid's color down the row's edge.
      g.fillStyle = r.color;
      g.fillRect(24, y + 6, 6, rowH - 12);
      g.fillStyle = GREEN;
      g.fillRect(62, y + rowH / 2 - fs * 0.18, fs * 0.36, fs * 0.36);
      g.fillStyle = ORANGE;
      mono(g, 700, fs, 0.02);
      g.textAlign = 'right';
      g.fillText(`:${r.port}`, W - 50, y + rowH / 2 + fs * 0.35);
      g.textAlign = 'left';
      const textW = W - 120 - 50 - g.measureText(`:${r.port}`).width - 30;
      g.fillStyle = INK;
      sans(g, 600, fs);
      g.fillText(clip(g, r.title, textW), 110, y + rowH / 2 - fs * 0.08);
      g.fillStyle = MUTED;
      mono(g, 500, Math.round(fs * 0.58), 0.02);
      g.fillText(clip(g, r.who, textW), 110, y + rowH / 2 + fs * 0.72);
    });
    track(g, 0);
    if (rows.length > shown.length) {
      g.fillStyle = MUTED;
      mono(g, 500, 20, 0.1);
      g.textAlign = 'right';
      g.fillText(`+${rows.length - shown.length} MORE`, W - 24, H - 10);
      g.textAlign = 'left';
      track(g, 0);
    }
    this.texture.needsUpdate = true;
  }
}

type QueueRow = { kind: 'running' | 'queued' | 'done' | 'failed'; issue?: number; text: string; side: string };

/**
 * The task queue: a wall display drawn like Factory's Mission Control terminal: a title row with the
 * pinwheel, a RUNNING bar of how many droids it keeps busy against how many it may, and a row per
 * task: what's being worked on, what's waiting, and the PRs that came out of it.
 */
export class QueueBoardTexture {
  readonly texture: THREE.CanvasTexture;
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private drawn = '';

  constructor() {
    this.canvas.width = BOARD_W * SCREEN_SCALE;
    this.canvas.height = BOARD_H * SCREEN_SCALE;
    this.ctx = this.canvas.getContext('2d')!;
    this.ctx.scale(SCREEN_SCALE, SCREEN_SCALE);
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = ANISOTROPY;
  }

  render(state: QueueState, workers: Map<string, WorkerInfo>) {
    const title = (t: QueueTask) => (t.issue !== undefined ? t.title.replace(new RegExp(`^#${t.issue}\\s*`), '') : t.title);
    const running = state.tasks.filter((t) => t.status === 'running');
    const queued = state.tasks.filter((t) => t.status === 'queued');
    const done = state.tasks
      .filter((t) => t.status === 'done')
      .slice(-3)
      .reverse();
    const rows: QueueRow[] = [
      ...running.map((t): QueueRow => {
        const w = t.workerId ? workers.get(t.workerId) : undefined;
        const st = { starting: 'starting', idle: 'ready', working: 'working', needs_input: 'needs input', done: 'done', exited: 'stopped', offline: 'asleep' }[w?.status ?? 'working'];
        return { kind: 'running', issue: t.issue, text: title(t), side: `${t.workerName ?? 'a droid'} · ${st}` };
      }),
      ...queued.map((t, i): QueueRow => ({ kind: 'queued', issue: t.issue, text: title(t), side: i === 0 ? 'up next' : `${i + 1}${['th', 'st', 'nd', 'rd'][i + 1 <= 3 ? i + 1 : 0]} in line` })),
      ...done.map(
        (t): QueueRow => ({
          kind: t.outcome === 'done' ? 'done' : 'failed',
          issue: t.issue,
          text: title(t),
          side: t.pr ? `PR #${t.pr.number}${t.pr.state === 'MERGED' ? ' · merged' : ''}` : t.outcome === 'done' ? 'done' : t.outcome === 'failed' ? "didn't start" : t.outcome === 'killed' ? 'sent home' : 'stopped',
        }),
      ),
    ];
    const paused = state.maxWorkers === 0;
    const summary = paused ? 'paused' : `${running.length} working · ${queued.length} waiting · up to ${state.maxWorkers} at once`;
    const key = JSON.stringify([rows, summary]);
    if (key === this.drawn) return;
    this.drawn = key;
    const g = this.ctx;
    const W = BOARD_W;
    const H = BOARD_H;
    backdrop(g);

    // The terminal's window bar: three dots and its title, centered.
    g.fillStyle = '#0c0c0c';
    g.fillRect(0, 0, W, 40);
    g.fillStyle = HAIR;
    g.fillRect(0, 40, W, 1.5);
    for (let i = 0; i < 3; i++) {
      g.beginPath();
      g.arc(30 + i * 22, 20, 6, 0, Math.PI * 2);
      g.fillStyle = '#2a2a2a';
      g.fill();
    }
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    mono(g, 500, 16, 0.06);
    g.fillStyle = FAINT;
    g.fillText('droid -- mission control -- 02 ticket to code', W / 2, 21);

    // The title row: the pinwheel and the board's name in orange, how it stands on the right.
    g.textAlign = 'left';
    g.fillStyle = ORANGE;
    paintGlyph(g, 52, 78, 30);
    mono(g, 600, 30, 0.08);
    g.fillText('TASK QUEUE', 80, 79);
    g.textAlign = 'right';
    mono(g, 500, 20, 0.02);
    g.fillStyle = MUTED;
    g.fillText(summary, W - 36, 79);

    // The RUNNING bar: how many it keeps busy of the most it may.
    const barY = 120;
    const live = running.length > 0;
    const word = paused ? '|| PAUSED' : live ? '\u25CF RUNNING' : '\u25CB IDLE';
    g.textAlign = 'left';
    mono(g, 600, 20, 0.1);
    g.fillStyle = live && !paused ? ORANGE : MUTED;
    g.fillText(word, 36, barY);
    const bx = 36 + 170;
    const bw = W - 36 - bx;
    g.fillStyle = '#1a1a1a';
    g.fillRect(bx, barY - 9, bw, 18);
    const f = paused ? 0 : Math.min(1, running.length / Math.max(1, state.maxWorkers));
    if (f > 0) {
      g.fillStyle = ORANGE;
      g.fillRect(bx, barY - 9, bw * f, 18);
    }
    // A tick per droid it may keep busy.
    g.fillStyle = BG;
    for (let i = 1; i < Math.min(state.maxWorkers, 24); i++) g.fillRect(bx + (bw * i) / state.maxWorkers - 1.5, barY - 9, 3, 18);
    g.fillStyle = HAIR;
    g.fillRect(0, 150, W, 1.5);
    g.textBaseline = 'alphabetic';

    if (!rows.length) {
      g.textAlign = 'center';
      g.fillStyle = INK;
      mono(g, 600, 40, 0.06);
      g.fillText('Nothing queued', W / 2, (150 + H) / 2 - 6);
      g.fillStyle = MUTED;
      mono(g, 500, 22, 0.02);
      g.fillText('Add issues from 01 TRIAGE, or press E here', W / 2, (150 + H) / 2 + 40);
      g.textAlign = 'left';
      track(g, 0);
      this.texture.needsUpdate = true;
      return;
    }
    // A section eyebrow, then the rows, as the terminal lists them.
    mono(g, 600, 16, 0.14);
    g.fillStyle = MUTED;
    g.fillText('TASKS', 36, 182);
    const listTop = 196;
    const shown = rows.slice(0, 7);
    const rowH = Math.min(56, (H - listTop - 30) / shown.length);
    const fs = Math.round(rowH * 0.48);
    const MARK: Record<QueueRow['kind'], [string, string]> = { running: ['\u25B8', ORANGE], queued: ['\u00B7', MUTED], done: ['\u2713', GREEN], failed: ['\u2717', RED] };
    shown.forEach((r, i) => {
      const y = listTop + i * rowH + rowH * 0.66;
      if (r.kind === 'running') {
        g.fillStyle = 'rgba(238, 96, 24, .07)';
        g.fillRect(24, listTop + i * rowH + 3, W - 48, rowH - 6);
      }
      const [mark, markColor] = MARK[r.kind];
      mono(g, 700, fs, 0);
      g.fillStyle = markColor;
      g.fillText(mark, 40, y);
      const sideFont = Math.round(fs * 0.74);
      mono(g, 500, sideFont, 0.02);
      g.textAlign = 'right';
      const sideW = g.measureText(r.side).width;
      g.fillStyle = r.kind === 'running' ? INK : MUTED;
      g.fillText(r.side, W - 40, y);
      g.textAlign = 'left';
      let x = 80;
      mono(g, 600, fs, 0);
      if (r.issue !== undefined) {
        const num = `#${r.issue}`;
        g.fillStyle = r.kind === 'done' || r.kind === 'failed' ? MUTED : ORANGE;
        g.fillText(num, x, y);
        x += g.measureText(num).width + fs * 0.6;
      }
      mono(g, 500, fs, 0);
      g.fillStyle = r.kind === 'done' || r.kind === 'failed' ? MUTED : INK;
      const room = W - 40 - sideW - 30 - x;
      const text = clip(g, r.text, room);
      g.fillText(text, x, y);
      if (r.kind === 'done' || r.kind === 'failed') {
        g.fillStyle = 'rgba(140, 140, 140, .6)';
        g.fillRect(x, y - fs * 0.32, Math.min(g.measureText(text).width, room), 2);
      }
    });
    track(g, 0);
    if (rows.length > shown.length) {
      g.fillStyle = MUTED;
      mono(g, 500, 18, 0.1);
      g.textAlign = 'right';
      g.fillText(`+${rows.length - shown.length} MORE`, W - 40, H - 14);
      g.textAlign = 'left';
      track(g, 0);
    }
    this.texture.needsUpdate = true;
  }
}

function clip(g: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (g.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && g.measureText(`${s}…`).width > maxW) s = s.slice(0, -1);
  return `${s}…`;
}

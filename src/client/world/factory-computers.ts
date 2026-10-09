import * as THREE from 'three';
import { factoryCan, capabilityOf, type FactoryState } from '../../shared/factory';
import { computerPhase, currentStep, diskPct, memPct, METRICS_HOURS, type ComputerPhase, type FactoryComputer, type FactoryMetricPoint } from '../../shared/factory-computers';
import { COMPUTE_WALL } from '../../shared/layout';
import type { MachineState } from '../../shared/protocol';
import { MONO } from '../fonts';
import type { RackCube } from './factory-props';
import { fmtGb, loadColor, officeFull } from './machine';
import { ANISOTROPY } from './texture-quality';
import { paintGlyph, track } from './toon';

// The compute wall on the west wall, between the exit door and the kitchen: this machine on the
// left screen (CPU, memory and droids, as the machine monitor showed them) and every Factory Droid
// Computer on the right one. Two canvases, so the machine's few-second readings don't upload the
// fleet's bigger texture each time. Building one touches no DOM; tests load the view functions.

const MUTED = '#8c8c8c';
const DIM = '#5a5a5a';
const INK = '#eeeeee';
const ORANGE = '#ee6018';
const GREEN = '#3ccf91';
const AMBER = '#f2b84b';
const RED = '#ef4444';
const HAIR = 'rgba(255, 255, 255, .12)';
const PANEL = '#0e0e0e';
const BG = '#050505';

/** 400 px a meter, like the machine monitor was. */
const PX_PER_M = 400;
const H_PX = Math.round(COMPUTE_WALL.height * PX_PER_M);

export const PHASE_COLOR: Record<ComputerPhase, string> = { active: GREEN, asleep: MUTED, provisioning: ORANGE, waking: ORANGE, error: RED };
export const PHASE_WORD: Record<ComputerPhase, string> = { active: 'Active', asleep: 'Asleep', provisioning: 'Provisioning', waking: 'Waking', error: 'Error' };

/** A short age: "just now", "4m", "3h", "2d". */
export function age(ms: number): string {
  const s = Math.max(0, ms / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** One Factory computer's tile, as the wall paints it. */
export interface ComputerTile {
  id: string;
  name: string;
  provider: string;
  managed: boolean;
  phase: ComputerPhase;
  /** What its phase line says after the word: the step, when it was last seen, its size. */
  detail: string;
  /** Percent now (the newest sample), when it has one. */
  cpu?: number;
  mem?: number;
  disk?: number;
  /** [minutes before now, cpu, mem, disk], oldest first, within the last METRICS_HOURS. */
  spark: [number, number, number, number][];
}

/** What the wall shows, worked out once and painted from (and compared, so it's painted only when it changed). */
export interface WallView {
  /** This machine's BYOM computer in Factory, when it is one: the left screen wears a Droid Computer badge. */
  here?: { name: string; phase: ComputerPhase };
  state: 'off' | 'denied' | 'loading' | 'ok';
  /** Why there's no Factory data, or why it's old. */
  note?: string;
  /** The note is a warning (amber) rather than a hint. */
  warn?: boolean;
  tiles: ComputerTile[];
  /** Every computer the account has, the merged one too. */
  total: number;
  counts: Partial<Record<ComputerPhase, number>>;
  /** How old the list is, when it's worth saying. */
  updated?: string;
}

function tileOf(c: FactoryComputer, slice: FactoryState['computers'], now: number): ComputerTile {
  const phase = computerPhase(c, slice, now);
  const m = slice.metrics[c.id];
  const latest = m?.latest;
  let detail = '';
  if (phase === 'provisioning' || (phase === 'error' && c.provisioningSteps?.length)) {
    const steps = c.provisioningSteps ?? [];
    const step = currentStep(c);
    const done = steps.filter((s) => s.status === 'completed').length;
    detail = step ? `${step.name}${steps.length ? ` (${Math.min(done + 1, steps.length)}/${steps.length})` : ''}${step.error ? `: ${step.error}` : ''}` : '';
  } else if (phase === 'asleep') detail = latest ? `last seen ${age(now - latest.at)}` : 'no samples today';
  else if (phase === 'waking') detail = 'starting up';
  else if (latest) detail = `${latest.cpuCount} CPU · ${fmtGb(latest.memTotal)}`;
  else if (!c.managed) detail = 'your own machine';
  const since = now - METRICS_HOURS * 3600_000;
  const spark = (m?.history ?? []).filter((p) => p[0] >= since).map((p: FactoryMetricPoint) => [Math.round((now - p[0]) / 60_000), p[1], p[2], p[3]] as [number, number, number, number]);
  return {
    id: c.id,
    name: c.name,
    provider: c.managed ? c.providerType || 'managed' : 'byom',
    managed: c.managed,
    phase,
    detail,
    ...(latest ? { cpu: Math.round(latest.cpuPct), mem: memPct(latest), disk: diskPct(latest) } : {}),
    spark,
  };
}

/** The wall's view of Factory now. `now` is rounded to the minute, so the view changes at most once a minute on its own. */
export function wallView(factory: FactoryState, now: number): WallView {
  const t = Math.floor(now / 60_000) * 60_000;
  const conn = factory.connection;
  const slice = factory.computers;
  const base: WallView = { state: 'ok', tiles: [], total: slice.items.length, counts: {} };
  if (!conn.connected) return { ...base, state: 'off', total: 0, note: 'Connect Factory in ⚙️ Settings → Factory to see your Droid Computers' };
  if (!conn.rejected && !factoryCan(conn, 'computers')) {
    const cap = capabilityOf(conn, 'computers');
    return { ...base, state: 'denied', total: 0, note: `This Factory key can’t reach Droid Computers${cap?.reason ? ` (${cap.reason})` : ''}`, warn: true };
  }
  const hereC = slice.items.find((c) => c.id === slice.here);
  const tiles = slice.items.filter((c) => c.id !== slice.here).map((c) => tileOf(c, slice, t));
  const counts: WallView['counts'] = {};
  for (const c of slice.items) {
    const p = computerPhase(c, slice, t);
    counts[p] = (counts[p] ?? 0) + 1;
  }
  const view: WallView = { ...base, tiles, counts, ...(hereC ? { here: { name: hereC.name, phase: computerPhase(hereC, slice, t) } } : {}) };
  if (!slice.fetchedAt) return { ...view, state: conn.rejected ? 'ok' : 'loading', ...(conn.rejected ? { note: `Factory rejected the office’s key: ${conn.rejected}`, warn: true } : {}) };
  const old = age(t - slice.fetchedAt);
  if (conn.rejected) return { ...view, note: `Key rejected (${conn.rejected}) · data from ${old}`, warn: true };
  if (slice.error) return { ...view, note: `${slice.error} · data from ${old}`, warn: true };
  return { ...view, updated: old };
}

/** How the fleet screen lays out `n` tiles: big tiles in a grid up to six, then compact rows (two columns), the last one "+N more" past twelve. */
export function gridOf(n: number): { cols: number; rows: number; compact: boolean; shown: number } {
  if (n <= 1) return { cols: 1, rows: 1, compact: false, shown: n };
  if (n === 2) return { cols: 1, rows: 2, compact: false, shown: 2 };
  if (n <= 4) return { cols: 2, rows: 2, compact: false, shown: n };
  if (n <= 6) return { cols: 3, rows: 2, compact: false, shown: n };
  const rows = Math.min(6, Math.ceil(n / 2));
  return { cols: 2, rows, compact: true, shown: n > 12 ? 11 : n };
}

/** The hint bar's few words about the wall: "2 active · 1 asleep". */
export function wallSummary(v: WallView): string {
  if (v.state === 'off') return 'not connected';
  if (v.state === 'denied') return 'no access';
  if (!v.total) return v.state === 'loading' ? 'reading…' : 'no Droid Computers yet';
  const order: ComputerPhase[] = ['active', 'provisioning', 'waking', 'asleep', 'error'];
  return order
    .filter((p) => v.counts[p])
    .map((p) => `${v.counts[p]} ${PHASE_WORD[p].toLowerCase()}`)
    .join(' · ');
}

/** The rack's three cubes as the first three managed Droid Computers, or null (the rack's idle demo) while Factory isn't connected. */
export function rackCubesOf(factory: FactoryState, now = Date.now()): RackCube[] | null {
  const conn = factory.connection;
  if (!conn.connected || !factory.computers.fetchedAt) return null;
  const slice = factory.computers;
  const t = Math.floor(now / 60_000) * 60_000;
  const managed = slice.items.filter((c) => c.managed).slice(0, 3);
  return [0, 1, 2].map((i): RackCube => {
    const c = managed[i];
    if (!c) return { led: 'off' };
    const phase = computerPhase(c, slice, t);
    const m = slice.metrics[c.id]?.latest;
    const led = phase === 'active' ? 'on' : phase === 'asleep' ? 'dim' : phase === 'error' ? 'error' : 'busy';
    const gb = (b: number) => `${(b / 2 ** 30).toFixed(1)}GB`;
    return m && phase === 'active' ? { led, cpu: m.cpuPct, mem: `${gb(m.memUsed)}/${Math.round(m.memTotal / 2 ** 30)}GB`, dsk: `${gb(m.diskUsed)}/${Math.round(m.diskTotal / 2 ** 30)}GB` } : { led };
  });
}

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = ANISOTROPY;
  return { ctx, texture };
}

/** `text` cut with an ellipsis to fit `max` px in the current font. */
function fit(g: CanvasRenderingContext2D, text: string, max: number): string {
  if (g.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && g.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t}…`;
}

/** A label in letter-spaced mono. */
function label(g: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, color: string, spacing = 3, weight = 600) {
  g.font = `${weight} ${size}px ${MONO}`;
  g.fillStyle = color;
  track(g, spacing);
  g.fillText(text, x, y);
  track(g, 0);
}

/** An outlined badge with a light, its right edge at `right`; returns its left edge. */
function badge(g: CanvasRenderingContext2D, text: string, right: number, y: number, color: string, size = 20): number {
  g.font = `600 ${size}px ${MONO}`;
  track(g, 2);
  const tw = g.measureText(text).width;
  const h = size * 2.1;
  const w = tw + size * 2.6;
  const x = right - w;
  g.globalAlpha = 0.12;
  g.fillStyle = color;
  g.fillRect(x, y, w, h);
  g.globalAlpha = 1;
  g.strokeStyle = color;
  g.lineWidth = 2;
  g.strokeRect(x + 1, y + 1, w - 2, h - 2);
  g.fillRect(x + size * 0.8, y + h / 2 - size * 0.22, size * 0.45, size * 0.45);
  g.fillText(text, x + size * 1.7, y + h / 2 + size * 0.36);
  track(g, 0);
  return x;
}

/** A filled graph of 0-100 values over time: `points` are [minutes ago, value], drawn across the last `span` minutes, broken where samples are missing. */
function spark(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, points: [number, number][], span: number, color: string, gapMin = 16) {
  g.strokeStyle = 'rgba(255, 255, 255, .1)';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(x, y + h);
  g.lineTo(x + w, y + h);
  g.stroke();
  if (!points.length) return;
  const px = (ago: number) => x + w - (Math.min(span, ago) / span) * w;
  const py = (v: number) => y + h - (Math.max(0, Math.min(100, v)) / 100) * h;
  // Runs of samples with no gap longer than gapMin minutes between them.
  const runs: [number, number][][] = [];
  for (const p of [...points].sort((a, b) => b[0] - a[0])) {
    const run = runs[runs.length - 1];
    if (run && run[run.length - 1][0] - p[0] <= gapMin) run.push(p);
    else runs.push([p]);
  }
  for (const run of runs) {
    if (run.length === 1) {
      g.fillStyle = color;
      g.fillRect(px(run[0][0]) - 2, py(run[0][1]) - 2, 4, 4);
      continue;
    }
    g.beginPath();
    g.moveTo(px(run[0][0]), y + h);
    for (const p of run) g.lineTo(px(p[0]), py(p[1]));
    g.lineTo(px(run[run.length - 1][0]), y + h);
    g.closePath();
    g.globalAlpha = 0.16;
    g.fillStyle = color;
    g.fill();
    g.globalAlpha = 1;
    g.beginPath();
    run.forEach((p, i) => (i ? g.lineTo(px(p[0]), py(p[1])) : g.moveTo(px(p[0]), py(p[1]))));
    g.strokeStyle = color;
    g.lineWidth = 3;
    g.lineJoin = 'miter';
    g.stroke();
  }
}

/** Both screens of the compute wall. */
export class ComputeWallTextures {
  readonly machine: THREE.CanvasTexture;
  readonly fleet: THREE.CanvasTexture;
  private m: CanvasRenderingContext2D;
  private f: CanvasRenderingContext2D;
  private drawnMachine = '';
  private drawnFleet = '';
  /** What the wall shows of Factory, as last painted. */
  view: WallView | undefined;

  constructor() {
    const left = canvas(Math.round(COMPUTE_WALL.machineWidth * PX_PER_M), H_PX);
    const right = canvas(Math.round((COMPUTE_WALL.width - COMPUTE_WALL.machineWidth - COMPUTE_WALL.gap) * PX_PER_M), H_PX);
    this.m = left.ctx;
    this.machine = left.texture;
    this.f = right.ctx;
    this.fleet = right.texture;
  }

  /** Paints whichever screen changed. */
  render(s: MachineState, factory: FactoryState, now = Date.now()): void {
    const view = wallView(factory, now);
    this.view = view;
    const mKey = JSON.stringify([s, view.here]);
    if (mKey !== this.drawnMachine) {
      this.drawnMachine = mKey;
      this.paintMachine(s, view.here);
      this.machine.needsUpdate = true;
    }
    const fKey = JSON.stringify(view);
    if (fKey !== this.drawnFleet) {
      this.drawnFleet = fKey;
      this.paintFleet(view);
      this.fleet.needsUpdate = true;
    }
  }

  /** Forgets what was painted, so the next render paints again (once the fonts are in). */
  repaint() {
    this.drawnMachine = '';
    this.drawnFleet = '';
  }

  // ---- This machine ----------------------------------------------------------------------------

  private paintMachine(s: MachineState, here: WallView['here']) {
    const g = this.m;
    const W = g.canvas.width;
    const H = g.canvas.height;
    g.fillStyle = BG;
    g.fillRect(0, 0, W, H);
    g.textBaseline = 'alphabetic';
    g.textAlign = 'left';
    g.fillStyle = ORANGE;
    g.fillRect(30, 34, 14, 14);
    g.font = `600 34px ${MONO}`;
    track(g, 3);
    g.fillStyle = INK;
    g.fillText(fit(g, (here?.name ?? 'This machine').toUpperCase(), W - 90), 58, 54);
    track(g, 0);
    const full = officeFull(s);
    const status: [string, string] = !s.memTotal ? ['…', MUTED] : s.pressure ? ['UNDER PRESSURE', RED] : full ? ['OFFICE FULL', AMBER] : ['ROOM TO HIRE', GREEN];
    badge(g, status[0], W - 30, 80, status[1]);
    if (here) {
      g.fillStyle = ORANGE;
      paintGlyph(g, 44, 101, 26);
      label(g, 'DROID COMPUTER', 66, 110, 20, ORANGE, 2);
    } else label(g, 'THE OFFICE’S OWN', 30, 110, 20, MUTED, 2, 500);
    g.fillStyle = HAIR;
    g.fillRect(30, 146, W - 60, 2);
    g.fillStyle = ORANGE;
    g.fillRect(30, 145, 48, 4);

    const memP = s.memTotal ? Math.round((s.memUsed / s.memTotal) * 100) : 0;
    this.gauge(
      30,
      168,
      W - 60,
      330,
      'CPU',
      s.cpu,
      s.cores ? `${s.cores} core${s.cores === 1 ? '' : 's'}` : '',
      s.history.map(([c]) => c),
    );
    this.gauge(
      30,
      518,
      W - 60,
      330,
      'MEM',
      memP,
      s.memTotal ? `${fmtGb(s.memUsed)} of ${fmtGb(s.memTotal)}` : '',
      s.history.map(([, m]) => m),
    );

    // The droids, one pip each, against the limit.
    const y = 906;
    label(g, 'WRK', 30, y, 22, MUTED, 3);
    g.font = `500 30px ${MONO}`;
    g.fillStyle = INK;
    const words = s.limit === undefined ? `${s.workers} droid${s.workers === 1 ? '' : 's'} · no limit` : `${s.workers} / ${s.limit} droids`;
    g.fillText(words, 104, y);
    if (s.limit !== undefined) {
      const n = Math.max(s.limit, s.workers);
      const pip = Math.min(40, (W - 60) / Math.max(1, n));
      for (let i = 0; i < n; i++) {
        g.fillStyle = i >= s.limit ? RED : i < s.workers ? (full ? AMBER : ORANGE) : '#1c1c1c';
        g.fillRect(30 + i * pip, y + 30, Math.max(2, pip - 6), 40);
      }
    } else {
      const pip = Math.min(40, (W - 60) / Math.max(1, s.workers));
      for (let i = 0; i < s.workers; i++) {
        g.fillStyle = ORANGE;
        g.fillRect(30 + i * pip, y + 30, Math.max(2, pip - 6), 40);
      }
    }
  }

  /** One gauge: its name, the percent now, what it's of, and the last few minutes as a filled graph. */
  private gauge(x: number, y: number, w: number, h: number, name: string, pct: number, sub: string, history: number[]) {
    const g = this.m;
    const color = loadColor(pct);
    g.fillStyle = PANEL;
    g.fillRect(x, y, w, h);
    g.strokeStyle = HAIR;
    g.lineWidth = 2;
    g.strokeRect(x + 1, y + 1, w - 2, h - 2);
    g.fillStyle = color;
    g.fillRect(x + 22, y + 28, 12, 12);
    label(g, name, x + 46, y + 44, 26, MUTED, 4);
    g.font = `500 112px ${MONO}`;
    g.fillStyle = INK;
    g.fillText(`${pct}%`, x + 16, y + 158);
    label(g, sub.toUpperCase(), x + 22, y + 196, 22, MUTED, 1, 500);
    const gx = x + 22;
    const gy = y + 214;
    const gw = w - 44;
    const gh = h - 234;
    // The 90% line: past it, hiring comes with a warning.
    g.strokeStyle = 'rgba(255, 255, 255, .14)';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(gx, gy + gh * 0.1);
    g.lineTo(gx + gw, gy + gh * 0.1);
    g.stroke();
    spark(
      g,
      gx,
      gy,
      gw,
      gh,
      history.map((v, i) => [history.length - 1 - i, v]),
      Math.max(1, history.length - 1),
      ORANGE,
      Number.POSITIVE_INFINITY,
    );
  }

  // ---- The Droid Computers ---------------------------------------------------------------------

  private paintFleet(v: WallView) {
    const g = this.f;
    const W = g.canvas.width;
    const H = g.canvas.height;
    g.fillStyle = BG;
    g.fillRect(0, 0, W, H);
    g.textBaseline = 'alphabetic';
    g.textAlign = 'left';
    g.fillStyle = ORANGE;
    paintGlyph(g, 50, 42, 40);
    label(g, 'DROID COMPUTERS', 86, 54, 34, INK, 3);
    if (v.state === 'ok' && v.total) {
      const order: ComputerPhase[] = ['error', 'asleep', 'waking', 'provisioning', 'active'];
      let right = W - 30;
      for (const p of order) {
        const n = v.counts[p];
        if (n) right = badge(g, `${n} ${PHASE_WORD[p].toUpperCase()}`, right, 18, PHASE_COLOR[p]) - 14;
      }
    }
    g.fillStyle = HAIR;
    g.fillRect(30, 96, W - 60, 2);
    g.fillStyle = ORANGE;
    g.fillRect(30, 95, 48, 4);

    const top = 124;
    const bottom = H - 86;
    if (v.state === 'off' || v.state === 'denied') this.message(v.note ?? '', top, bottom, v.state === 'off');
    else if (v.state === 'loading') this.message('Reading your Droid Computers…', top, bottom, false);
    else if (!v.tiles.length) this.message(v.here ? 'Only this machine so far. Press E for the Computers window to make a cloud one.' : 'No Droid Computers yet. Press E for the Computers window to make one.', top, bottom, false);
    else this.tiles(v.tiles, 30, top, W - 60, bottom - top);

    // The footer: how fresh it is, or why it isn't.
    g.fillStyle = HAIR;
    g.fillRect(30, H - 66, W - 60, 2);
    const foot = v.note && v.state === 'ok' ? `⚠ ${v.note}` : v.updated ? `UPDATED ${v.updated.toUpperCase()}` : v.state === 'off' ? 'FACTORY · NOT CONNECTED' : '';
    g.font = `500 24px ${MONO}`;
    g.fillStyle = v.warn && v.state === 'ok' ? AMBER : MUTED;
    track(g, 1);
    g.fillText(fit(g, foot, W - 60), 30, H - 26);
    track(g, 0);
  }

  /** A line or two in the middle of the fleet screen, under a big pinwheel. */
  private message(text: string, top: number, bottom: number, connect: boolean) {
    const g = this.f;
    const W = g.canvas.width;
    const cy = (top + bottom) / 2;
    g.globalAlpha = connect ? 0.9 : 0.35;
    g.fillStyle = ORANGE;
    paintGlyph(g, W / 2, cy - 120, 150);
    g.globalAlpha = 1;
    g.textAlign = 'center';
    g.font = `500 ${connect ? 44 : 36}px ${MONO}`;
    g.fillStyle = connect ? INK : MUTED;
    // Two lines at most, split near the middle at a space.
    const words = text.split(' ');
    const lines: string[] = [];
    let line = '';
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (g.measureText(next).width > W - 120 && line) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    if (line) lines.push(line);
    lines.slice(0, 3).forEach((l, i) => g.fillText(l, W / 2, cy + 40 + i * 60));
    g.textAlign = 'left';
  }

  private tiles(tiles: ComputerTile[], x0: number, y0: number, w: number, h: number) {
    const { cols, rows, compact, shown } = gridOf(tiles.length);
    const gap = compact ? 14 : 20;
    const tw = (w - gap * (cols - 1)) / cols;
    const th = (h - gap * (rows - 1)) / rows;
    for (let i = 0; i < Math.min(shown, cols * rows); i++) {
      const x = x0 + (i % cols) * (tw + gap);
      const y = y0 + Math.floor(i / cols) * (th + gap);
      if (compact) this.row(tiles[i], x, y, tw, th);
      else this.tile(tiles[i], x, y, tw, th);
    }
    if (shown < tiles.length) {
      const i = shown;
      const x = x0 + (i % cols) * (tw + gap);
      const y = y0 + Math.floor(i / cols) * (th + gap);
      const g = this.f;
      g.strokeStyle = HAIR;
      g.lineWidth = 2;
      g.strokeRect(x + 1, y + 1, tw - 2, th - 2);
      label(g, `+${tiles.length - shown} MORE`, x + 28, y + th / 2 + 12, 30, MUTED, 3);
    }
  }

  /** The tile's frame and the stripe in its phase's color down its left edge. */
  private frame(t: ComputerTile, x: number, y: number, w: number, h: number) {
    const g = this.f;
    g.fillStyle = PANEL;
    g.fillRect(x, y, w, h);
    g.strokeStyle = HAIR;
    g.lineWidth = 2;
    g.strokeRect(x + 1, y + 1, w - 2, h - 2);
    g.fillStyle = PHASE_COLOR[t.phase];
    g.fillRect(x, y, 6, h);
  }

  private phaseLine(t: ComputerTile, x: number, y: number, max: number, size: number) {
    const g = this.f;
    g.font = `600 ${size}px ${MONO}`;
    track(g, 2);
    g.fillStyle = PHASE_COLOR[t.phase];
    const word = PHASE_WORD[t.phase].toUpperCase();
    g.fillText(word, x, y);
    const ww = g.measureText(word).width;
    if (t.detail) {
      g.font = `500 ${size}px ${MONO}`;
      track(g, 1);
      g.fillStyle = t.phase === 'error' ? RED : MUTED;
      g.fillText(fit(g, ` · ${t.detail.toUpperCase()}`, max - ww), x + ww, y);
    }
    track(g, 0);
  }

  /** A big tile: name and provider, its phase, and CPU / MEM / DISK now with the last hours under each. */
  private tile(t: ComputerTile, x: number, y: number, w: number, h: number) {
    const g = this.f;
    this.frame(t, x, y, w, h);
    // A lone computer fills the whole screen: its type grows with it, so it reads from the desks.
    const scale = Math.min(1.6, Math.max(1, Math.min(w / 760, h / 520)));
    const pad = Math.round(26 * scale);
    const big = w > 500;
    const nameSize = Math.round((big ? 40 : 32) * scale);
    const provLeft = badge(g, t.provider.toUpperCase(), x + w - pad + 6, y + 20 * scale, t.managed ? ORANGE : MUTED, Math.round((big ? 20 : 17) * scale));
    g.font = `600 ${nameSize}px ${MONO}`;
    g.fillStyle = INK;
    g.fillText(fit(g, t.name, provLeft - x - pad - 16), x + pad, y + 20 * scale + nameSize);
    this.phaseLine(t, x + pad, y + 20 * scale + nameSize + 44 * scale, w - 2 * pad, Math.round((big ? 24 : 20) * scale));

    const top = y + nameSize + 100 * scale;
    const bottom = y + h - 22;
    if (!t.managed) {
      label(g, 'NO METRICS FOR BYOM', x + pad, (top + bottom) / 2 + 10, big ? 26 : 22, DIM, 2, 500);
      return;
    }
    const metrics: [string, number | undefined, number][] = [
      ['CPU', t.cpu, 1],
      ['MEM', t.mem, 2],
      ['DISK', t.disk, 3],
    ];
    const asleep = t.phase !== 'active';
    const span = METRICS_HOURS * 60;
    if (w > 700) {
      // Wide: three columns.
      const cw = (w - 2 * pad - 2 * 24) / 3;
      metrics.forEach(([name, v, k], i) => {
        const cx = x + pad + i * (cw + 24);
        this.metric(
          name,
          v,
          cx,
          top,
          cw,
          bottom - top,
          t.spark.map((p) => [p[0], p[k]]),
          span,
          asleep,
          Math.round(76 * scale),
          Math.round(22 * scale),
        );
      });
    } else {
      // Narrow: three rows.
      const rh = (bottom - top) / 3;
      metrics.forEach(([name, v, k], i) => {
        this.metricRow(
          name,
          v,
          x + pad,
          top + i * rh,
          w - 2 * pad,
          rh - 8,
          t.spark.map((p) => [p[0], p[k]]),
          span,
          asleep,
        );
      });
    }
  }

  /** A metric as a column: its name, the percent, and the sparkline under it. */
  private metric(name: string, v: number | undefined, x: number, y: number, w: number, h: number, points: [number, number][], span: number, asleep: boolean, size: number, labelSize: number) {
    const g = this.f;
    const color = v === undefined ? DIM : loadColor(v);
    const dot = Math.round(labelSize * 0.45);
    g.fillStyle = color;
    g.fillRect(x, y + labelSize * 0.72 - dot, dot, dot);
    label(g, name, x + dot * 2, y + labelSize * 0.72, labelSize, MUTED, 3);
    g.globalAlpha = asleep ? 0.45 : 1;
    g.font = `500 ${size}px ${MONO}`;
    g.fillStyle = INK;
    g.fillText(v === undefined ? '—' : `${v}%`, x, y + labelSize + size);
    g.globalAlpha = 1;
    spark(g, x, y + labelSize * 2 + size, w, h - labelSize * 2 - size, points, span, asleep ? DIM : ORANGE);
  }

  /** A metric as a row: name and percent on one line, the sparkline under them. */
  private metricRow(name: string, v: number | undefined, x: number, y: number, w: number, h: number, points: [number, number][], span: number, asleep: boolean) {
    const g = this.f;
    const color = v === undefined ? DIM : loadColor(v);
    g.fillStyle = color;
    g.fillRect(x, y + 12, 10, 10);
    label(g, name, x + 20, y + 24, 20, MUTED, 3);
    g.globalAlpha = asleep ? 0.45 : 1;
    g.font = `500 40px ${MONO}`;
    g.fillStyle = INK;
    g.textAlign = 'right';
    g.fillText(v === undefined ? '—' : `${v}%`, x + w, y + 36);
    g.textAlign = 'left';
    g.globalAlpha = 1;
    spark(g, x, y + 46, w, Math.max(10, h - 50), points, span, asleep ? DIM : ORANGE);
  }

  /** A compact row: the name and phase, then CPU / MEM / DISK with a small sparkline each. */
  private row(t: ComputerTile, x: number, y: number, w: number, h: number) {
    const g = this.f;
    this.frame(t, x, y, w, h);
    const pad = 22;
    const meters = t.managed ? 3 : 0;
    const mw = 96;
    const left = w - pad * 2 - meters * (mw + 12);
    g.font = `600 30px ${MONO}`;
    g.fillStyle = INK;
    g.fillText(fit(g, t.name, left - 10), x + pad, y + 44);
    this.phaseLine(t, x + pad, y + 80, left - 10, 18);
    label(g, t.provider.toUpperCase(), x + pad, y + h - 18, 16, t.managed ? ORANGE : DIM, 2);
    if (!t.managed) {
      label(g, 'NO METRICS', x + w - pad - 150, y + h / 2 + 8, 18, DIM, 2, 500);
      return;
    }
    const asleep = t.phase !== 'active';
    (['CPU', 'MEM', 'DSK'] as const).forEach((name, i) => {
      const v = [t.cpu, t.mem, t.disk][i];
      const mx = x + pad + left + i * (mw + 12);
      label(g, name, mx, y + 30, 16, MUTED, 2);
      g.globalAlpha = asleep ? 0.45 : 1;
      g.font = `500 32px ${MONO}`;
      g.fillStyle = v === undefined ? DIM : loadColor(v);
      g.fillText(v === undefined ? '—' : `${v}%`, mx, y + 66);
      g.globalAlpha = 1;
      spark(
        g,
        mx,
        y + 78,
        mw,
        h - 92,
        t.spark.map((p) => [p[0], p[i + 1]]),
        METRICS_HOURS * 60,
        asleep ? DIM : ORANGE,
      );
    });
  }
}

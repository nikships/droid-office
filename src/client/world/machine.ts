import * as THREE from 'three';
import { ANISOTROPY } from './texture-quality';
import type { MachineState, ProxyProvider, ProxyState } from '../../shared/protocol';
import { MACHINE_MONITOR, PROXY_REFRESH } from '../../shared/layout';
import { SANS, MONO } from '../fonts';
import { fillGlyphText } from './glyph';
import { paintGlyph, track } from './toon';

const MUTED = '#8c8c8c';
const INK = '#eeeeee';
const ORANGE = '#ee6018';
const HAIR = 'rgba(255, 255, 255, .12)';
const PANEL = '#0e0e0e';

/** Green while there's room, amber when it's getting full, red from where hiring gets a warning. */
export function loadColor(pct: number): string {
  return pct >= 90 ? '#ef4444' : pct >= 70 ? '#f2b84b' : '#3ccf91';
}

export function fmtGb(bytes: number): string {
  const gb = bytes / 2 ** 30;
  return `${gb.toFixed(gb < 10 ? 1 : 0)} GB`;
}

/** The office has as many workers as it takes. */
export function officeFull(s: MachineState): boolean {
  return s.limit !== undefined && s.workers >= s.limit;
}

/** What the hire dialog says while the machine is under pressure. */
export function pressureNote(s: MachineState): string | undefined {
  return s.pressure ? `⚠️ This machine is under pressure: ${s.pressure}. Another worker may slow down the ones already working.` : undefined;
}

/** "42m", "2h 27m", "3d 4h": how long until a limit starts over. */
export function fmtResetIn(at: number, now = Date.now()): string {
  const mins = Math.ceil((at - now) / 60_000);
  if (mins <= 0) return 'now';
  if (mins < 60) return `${mins}m`;
  if (mins < 24 * 60) return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  return `${Math.floor(mins / (24 * 60))}d ${Math.floor((mins % (24 * 60)) / 60)}h`;
}

const PROVIDER_COLOR: Record<ProxyProvider, string> = { claude: '#e08a5f', codex: '#7aa2f7', grok: '#d4d4d4' };
/** The canvas is 400 px a meter: MACHINE_MONITOR.width × height, or × tallHeight with DroidProxy's limits. */
const PX_PER_M = 400;
const SHORT_H = MACHINE_MONITOR.height * PX_PER_M;
const TALL_H = MACHINE_MONITOR.tallHeight * PX_PER_M;
/** The most account rows that fit under the machine's gauges. */
const MAX_ROWS = 4;

/**
 * The machine monitor on the west wall: how busy the CPU and memory are, with the last few minutes
 * of each, and how many workers the office runs of the most it takes. With DroidProxy on the
 * machine, the monitor is taller and shows how much of each of its accounts' limits is used.
 */
export class MachineTexture {
  readonly texture: THREE.CanvasTexture;
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private drawn = '';

  constructor() {
    // Always the tall size: a short monitor shows the top of it, so the texture never reallocates.
    this.canvas.width = MACHINE_MONITOR.width * PX_PER_M;
    this.canvas.height = TALL_H;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = ANISOTROPY;
  }

  /** Draws the monitor. Returns whether it should be the tall one. */
  render(s: MachineState, proxy?: ProxyState): boolean {
    const tall = !!proxy?.accounts.length;
    // Reset countdowns move on with the minute.
    const key = JSON.stringify([s, tall && proxy, tall && Math.floor(Date.now() / 60_000)]);
    if (key === this.drawn) return tall;
    this.drawn = key;
    const g = this.ctx;
    const W = this.canvas.width;
    const H = tall ? TALL_H : SHORT_H;
    // flipY puts the canvas top at v = 1: the short monitor shows the top SHORT_H of it.
    this.texture.repeat.set(1, H / TALL_H);
    this.texture.offset.set(0, 1 - H / TALL_H);
    g.fillStyle = '#050505';
    g.fillRect(0, 0, W, TALL_H);
    g.textBaseline = 'alphabetic';

    // Header: the pinwheel and what this is, like the Droid Computer's own readout, and whether there's room for another worker.
    g.textAlign = 'left';
    g.fillStyle = ORANGE;
    paintGlyph(g, 48, 50, 34);
    g.fillStyle = INK;
    g.font = `600 30px ${MONO}`;
    track(g, 3);
    g.fillText('DROID COMPUTER', 80, 61);
    track(g, 0);
    const full = officeFull(s);
    const status = !s.memTotal ? ['…', MUTED] : s.pressure ? ['UNDER PRESSURE', '#ef4444'] : full ? ['OFFICE FULL', '#f2b84b'] : ['ROOM TO HIRE', '#3ccf91'];
    g.font = `600 20px ${MONO}`;
    track(g, 2);
    const tw = g.measureText(status[0]).width;
    const sx = W - 30 - tw - 52;
    g.globalAlpha = 0.12;
    g.fillStyle = status[1];
    g.fillRect(sx, 26, tw + 52, 44);
    g.globalAlpha = 1;
    g.strokeStyle = status[1];
    g.lineWidth = 2;
    g.strokeRect(sx + 1, 27, tw + 50, 42);
    g.fillRect(sx + 16, 44, 9, 9);
    g.fillText(status[0], sx + 36, 56);
    track(g, 0);
    g.fillStyle = HAIR;
    g.fillRect(30, 86, W - 60, 2);
    g.fillStyle = ORANGE;
    g.fillRect(30, 85, 48, 4);

    const memPct = s.memTotal ? Math.round((s.memUsed / s.memTotal) * 100) : 0;
    this.panel(
      30,
      100,
      415,
      'CPU',
      s.cpu,
      s.cores ? `${s.cores} core${s.cores === 1 ? '' : 's'}` : '',
      s.history.map(([c]) => c),
    );
    this.panel(
      475,
      100,
      415,
      'MEM',
      memPct,
      s.memTotal ? `${fmtGb(s.memUsed)} of ${fmtGb(s.memTotal)}` : '',
      s.history.map(([, m]) => m),
    );

    // Footer: the workers, one pip each, against the limit, read out like the cube's CPU / MEM lines.
    const y = 440;
    g.textAlign = 'left';
    g.font = `600 22px ${MONO}`;
    track(g, 3);
    g.fillStyle = MUTED;
    g.fillText('WRK', 30, y + 10);
    g.font = `500 26px ${MONO}`;
    track(g, 1);
    g.fillStyle = INK;
    const label = s.limit === undefined ? `${s.workers} worker${s.workers === 1 ? '' : 's'} · no limit` : `${s.workers} / ${s.limit} workers`;
    g.fillText(label, 100, y + 10);
    if (s.limit !== undefined) {
      const x0 = 100 + g.measureText(label).width + 28;
      const room = W - 30 - x0;
      const pip = Math.min(34, room / Math.max(s.limit, s.workers));
      for (let i = 0; i < Math.max(s.limit, s.workers); i++) {
        g.fillStyle = i >= s.limit ? '#ef4444' : i < s.workers ? (full ? '#f2b84b' : ORANGE) : '#1c1c1c';
        g.fillRect(x0 + i * pip, y - 12, Math.max(2, pip - 6), 28);
      }
    }
    track(g, 0);
    if (tall) this.proxy(proxy!, SHORT_H, W, H);
    this.texture.needsUpdate = true;
    return tall;
  }

  /** DroidProxy's accounts, a row each: whose, which plan, and a meter per limit with when it starts over. */
  private proxy(p: ProxyState, top: number, W: number, H: number) {
    const g = this.ctx;
    g.fillStyle = HAIR;
    g.fillRect(30, top - 1, W - 60, 2);

    g.textAlign = 'left';
    g.fillStyle = ORANGE;
    g.font = `600 28px ${MONO}`;
    fillGlyphText(g, 'DroidProxy', 30, top + 52, 28);
    g.fillStyle = INK;
    track(g, 3);
    g.fillText('LIMITS', 66, top + 52);
    track(g, 0);
    const status = p.running === undefined ? ['…', MUTED] : p.running ? ['● RUNNING', '#3ccf91'] : ['● NOT RUNNING', '#ef4444'];
    const bx = PROXY_REFRESH.x * PX_PER_M;
    const by = PROXY_REFRESH.y * PX_PER_M;
    const bw = PROXY_REFRESH.width * PX_PER_M;
    const bh = PROXY_REFRESH.height * PX_PER_M;
    g.font = `600 22px ${MONO}`;
    g.textAlign = 'right';
    g.fillStyle = status[1];
    g.fillText(status[0], bx - 20, top + 50);

    // The refresh button, where the office's hit area for it sits (world/office.ts).
    g.fillStyle = p.refreshing ? '#101010' : '#161616';
    g.strokeStyle = p.refreshing ? '#2a2a2a' : 'rgba(255, 255, 255, .32)';
    g.lineWidth = 2;
    g.fillRect(bx, by, bw, bh);
    g.strokeRect(bx + 1, by + 1, bw - 2, bh - 2);
    g.textAlign = 'center';
    g.fillStyle = p.refreshing ? MUTED : '#eeeeee';
    g.font = `600 22px ${MONO}`;
    g.fillText(p.refreshing ? 'READING…' : '↻ REFRESH', bx + bw / 2, by + bh / 2 + 8);

    const rowsTop = top + 80;
    const bottom = H - 20;
    const more = p.accounts.length > MAX_ROWS ? p.accounts.length - (MAX_ROWS - 1) : 0;
    const shown = more ? p.accounts.slice(0, MAX_ROWS - 1) : p.accounts;
    const rowH = Math.min(96, (bottom - rowsTop) / (shown.length + (more ? 1 : 0)));
    const nameW = 220;
    const cols = Math.max(1, ...shown.map((a) => a.windows.length));
    const cellGap = 18;
    const cellW = (W - 30 - (30 + nameW) - cellGap * (cols - 1)) / cols;
    const now = Date.now();

    shown.forEach((a, i) => {
      const y = rowsTop + i * rowH;
      g.textAlign = 'left';
      g.fillStyle = PROVIDER_COLOR[a.provider];
      g.fillRect(30, y + 12, 4, 50);
      g.fillStyle = INK;
      g.font = `600 24px ${SANS}`;
      g.fillText(a.label, 44, y + 32, nameW - 24);
      g.font = `500 18px ${MONO}`;
      g.fillStyle = a.limited ? '#ef4444' : MUTED;
      g.fillText([a.plan?.toUpperCase(), a.limited ? 'LIMIT HIT' : ''].filter(Boolean).join(' · '), 44, y + 58, nameW - 24);
      if (!a.windows.length) {
        g.fillStyle = MUTED;
        g.font = `500 20px ${SANS}`;
        fillGlyphText(g, a.error ?? 'No limits reported', 30 + nameW, y + 42, 20, W - 60 - nameW);
        return;
      }
      a.windows.forEach((w, j) => {
        const x = 30 + nameW + j * (cellW + cellGap);
        const used = Math.round(w.pct);
        const color = loadColor(w.pct);
        g.textAlign = 'left';
        g.fillStyle = MUTED;
        g.font = `600 18px ${MONO}`;
        g.fillText(w.label.toUpperCase(), x, y + 24, cellW - 70);
        g.textAlign = 'right';
        g.fillStyle = color;
        g.font = `700 24px ${MONO}`;
        g.fillText(`${used}%`, x + cellW, y + 26);
        g.fillStyle = '#1c1c1c';
        g.fillRect(x, y + 38, cellW, 8);
        if (w.pct > 0) {
          g.fillStyle = color;
          g.fillRect(x, y + 38, Math.max(4, (cellW * Math.min(100, w.pct)) / 100), 8);
        }
        if (w.resetsAt) {
          g.textAlign = 'left';
          g.fillStyle = MUTED;
          g.font = `500 17px ${MONO}`;
          g.fillText(`↻ ${fmtResetIn(w.resetsAt, now)}`, x, y + 70, cellW);
        }
      });
    });
    if (more) {
      g.textAlign = 'left';
      g.fillStyle = MUTED;
      g.font = `500 20px ${SANS}`;
      g.fillText(`+ ${more} more account${more === 1 ? '' : 's'}`, 30, rowsTop + shown.length * rowH + 30);
    }
  }

  /** One gauge: its name, the percent now, a line under it, and the last few minutes as a filled graph. */
  private panel(x: number, y: number, w: number, name: string, pct: number, sub: string, history: number[]) {
    const g = this.ctx;
    const color = loadColor(pct);
    g.fillStyle = PANEL;
    g.fillRect(x, y, w, 300);
    g.strokeStyle = HAIR;
    g.lineWidth = 2;
    g.strokeRect(x + 1, y + 1, w - 2, 298);
    g.textAlign = 'left';
    // Its name with a status light in its load color, the reading in light mono, and what it's of.
    g.fillStyle = color;
    g.fillRect(x + 20, y + 26, 10, 10);
    g.fillStyle = MUTED;
    g.font = `600 22px ${MONO}`;
    track(g, 4);
    g.fillText(name.toUpperCase(), x + 42, y + 40);
    track(g, 0);
    g.fillStyle = INK;
    g.font = `500 80px ${MONO}`;
    g.fillText(`${pct}%`, x + 16, y + 124);
    g.fillStyle = MUTED;
    g.font = `500 20px ${MONO}`;
    g.fillText(sub.toUpperCase(), x + 20, y + 160);
    // The graph: 0-100%, the newest reading on the right.
    const gx = x + 20;
    const gy = y + 180;
    const gw = w - 40;
    const gh = 100;
    // The 90% line: past it, hiring comes with a warning.
    g.strokeStyle = 'rgba(255, 255, 255, .14)';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(gx, gy + gh * 0.1);
    g.lineTo(gx + gw, gy + gh * 0.1);
    g.stroke();
    if (history.length < 2) return;
    const step = gw / (history.length - 1);
    const at = (i: number) => [gx + i * step, gy + gh - (Math.max(0, Math.min(100, history[i])) / 100) * gh] as const;
    g.beginPath();
    g.moveTo(gx, gy + gh);
    for (let i = 0; i < history.length; i++) g.lineTo(...at(i));
    g.lineTo(gx + gw, gy + gh);
    g.closePath();
    g.globalAlpha = 0.16;
    g.fillStyle = ORANGE;
    g.fill();
    g.globalAlpha = 1;
    g.beginPath();
    for (let i = 0; i < history.length; i++) (i ? g.lineTo : g.moveTo).call(g, ...at(i));
    g.strokeStyle = ORANGE;
    g.lineWidth = 3;
    g.lineJoin = 'miter';
    g.stroke();
  }
}

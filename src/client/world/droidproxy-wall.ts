import * as THREE from 'three';
import { COMPUTE_WALL } from '../../shared/layout';
import { durationWords, providerName, type SubscriptionsState, type UsageWindow } from '../../shared/subscriptions';
import { MONO } from '../fonts';
import { age } from './factory-computers';
import { SCREEN_BLACK } from './screen';
import { ANISOTROPY } from './texture-quality';

const INK = '#eeeeee';
const MUTED = '#969696';
const DIM = '#626262';
const ORANGE = '#ee6018';
const GREEN = '#3ccf91';
const AMBER = '#f2b84b';
const RED = '#ef6363';
const HAIR = '#292929';
const STALE_MS = 5 * 60_000;
const PAGE_MS = 20_000;
const PAGE_SIZE = 6;

export type QuotaStatus = 'reporting' | 'low' | 'limited' | 'paused' | 'sign-in' | 'unavailable' | 'unreported' | 'cached';

export interface QuotaTile {
  id: string;
  provider: string;
  label: string;
  status: QuotaStatus;
  detail: string;
  windows: { name: string; remaining: number; reset: string; due: boolean }[];
  /** More than two windows become continuation cards, so none are silently cut off. */
  continuation?: string;
}

export interface QuotaView {
  phase: SubscriptionsState['proxy']['phase'];
  version: string | null;
  accounts: number;
  reporting: number;
  limited: number;
  pages: number;
  page: number;
  tiles: QuotaTile[];
  note: string;
}

/** Never imply a reset refilled an account before the provider confirms it. */
export function resetWords(w: UsageWindow, now: number): string {
  if (w.resetsAt === null) return 'Reset time not reported';
  if (w.resetsAt <= now) return 'Reset due · awaiting update';
  const clock = new Date(w.resetsAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return `Resets in ${durationWords(w.resetsAt - now)} · ${clock}`;
}

/** All connected accounts, including paused providers and ones without a quota API. Pure, no DOM. */
export function quotaView(s: SubscriptionsState, now: number): QuotaView {
  const t = Math.floor(now / 60_000) * 60_000;
  const all: QuotaTile[] = [];
  let accounts = 0;
  let reporting = 0;
  let limited = 0;
  for (const p of s.providers) {
    for (const a of p.accounts) {
      accounts++;
      const cached = !['running', 'outdated'].includes(s.proxy.phase) || a.usageUpdatedAt === undefined || t - a.usageUpdatedAt > STALE_MS;
      const due = a.windows.some((w) => w.resetsAt !== null && w.resetsAt <= t);
      const min = Math.min(...a.windows.map((w) => 100 - w.usedPercent));
      const status: QuotaStatus = a.expired
        ? 'sign-in'
        : !p.enabled || a.disabled
          ? 'paused'
          : a.usageError
            ? 'unavailable'
            : !a.windows.length
              ? 'unreported'
              : cached || due
                ? 'cached'
                : min <= 0
                  ? 'limited'
                  : min <= 20
                    ? 'low'
                    : 'reporting';
      if (status === 'limited') limited++;
      if (status === 'reporting' || status === 'low') reporting++;
      const detail = a.expired
        ? 'Reconnect in Subscriptions'
        : a.usageError
          ? 'Could not read account usage'
          : !a.windows.length
            ? 'Provider has not reported quotas'
            : a.usageUpdatedAt
              ? `Usage ${age(t - a.usageUpdatedAt)}`
              : 'Usage timestamp not reported';
      const windows = a.windows.map((w) => ({ name: w.name, remaining: Math.max(0, Math.min(100, 100 - w.usedPercent)), reset: resetWords(w, t), due: w.resetsAt !== null && w.resetsAt <= t }));
      const chunks = Math.max(1, Math.ceil(windows.length / 2));
      for (let i = 0; i < chunks; i++) {
        all.push({
          id: `${p.key}:${a.id}:${i}`,
          provider: providerName(p.key),
          label: a.label,
          status,
          detail,
          windows: windows.slice(i * 2, i * 2 + 2),
          ...(chunks > 1 ? { continuation: `WINDOWS ${i * 2 + 1}–${Math.min(windows.length, i * 2 + 2)} OF ${windows.length}` } : {}),
        });
      }
    }
  }
  const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  const page = Math.floor(now / PAGE_MS) % pages;
  const notes: Record<QuotaView['phase'], string> = {
    unsupported: 'Subscriptions need DroidProxy on an Apple silicon Mac',
    missing: 'Connect your plans in Settings → Subscriptions',
    installing: 'Installing DroidProxy…',
    stopped: 'DroidProxy stopped · last known usage',
    starting: 'Starting DroidProxy…',
    outdated: 'Update DroidProxy in Settings → Subscriptions',
    running: accounts ? 'Usage refreshes every minute · bars show quota remaining' : 'Connect an account in Settings → Subscriptions',
  };
  return {
    phase: s.proxy.phase,
    version: s.proxy.version,
    accounts,
    reporting,
    limited,
    pages,
    page,
    tiles: all.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    note: s.proxy.error ? 'DroidProxy could not refresh · last known usage' : notes[s.proxy.phase],
  };
}

/** The low strip lists accounts one per row, so a row can carry its quota windows beside its name. */
export function quotaLayout(n: number): { cols: number; rows: number } {
  return { cols: 1, rows: Math.max(1, Math.min(PAGE_SIZE, n)) };
}

const STATUS: Record<QuotaStatus, [string, string]> = {
  reporting: ['REPORTING', GREEN],
  low: ['LOW QUOTA', AMBER],
  limited: ['LIMIT REACHED', RED],
  paused: ['PAUSED', DIM],
  'sign-in': ['SIGN IN AGAIN', AMBER],
  unavailable: ['USAGE UNAVAILABLE', AMBER],
  unreported: ['NO QUOTA DATA', MUTED],
  cached: ['CACHED USAGE', AMBER],
};

/** A third, independently updated OLED canvas, not another poll or a per-frame texture upload. */
export class QuotaWallTexture {
  readonly texture: THREE.CanvasTexture;
  private g: CanvasRenderingContext2D;
  private drawn = '';

  constructor() {
    const c = document.createElement('canvas');
    c.width = Math.round(COMPUTE_WALL.proxyWidth * 400);
    c.height = Math.round(COMPUTE_WALL.height * 400);
    this.g = c.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(c);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = ANISOTROPY;
  }

  render(s: SubscriptionsState, now = Date.now(), force = false): void {
    const v = quotaView(s, now);
    const key = JSON.stringify(v);
    if (!force && key === this.drawn) return;
    this.drawn = key;
    this.paint(v);
    this.texture.needsUpdate = true;
  }

  private text(text: string, x: number, y: number, size: number, color = INK, max = Number.POSITIVE_INFINITY, weight = 500) {
    const g = this.g;
    g.font = `${weight} ${size}px ${MONO}`;
    g.fillStyle = color;
    let fit = text;
    while (fit.length && g.measureText(fit).width > max) fit = fit.slice(0, -1);
    if (fit !== text) fit = `${fit.slice(0, -1)}…`;
    g.fillText(fit, x, y);
  }

  private paint(v: QuotaView) {
    const g = this.g;
    const W = g.canvas.width;
    const H = g.canvas.height;
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    g.fillStyle = SCREEN_BLACK;
    g.fillRect(0, 0, W, H);
    g.fillStyle = ORANGE;
    g.fillRect(30, 33, 16, 16);
    this.text('DROIDPROXY', 64, 56, 30, INK, W - 320, 600);
    const phase = v.phase === 'running' ? 'CONNECTED' : v.phase.toUpperCase();
    this.pill(phase, W - 30, 22, v.phase === 'running' ? GREEN : AMBER);
    this.text('SUBSCRIPTION QUOTAS', 30, 96, 18, MUTED);
    const summary = `${v.accounts} ACCOUNTS  /  ${v.reporting} REPORTING${v.limited ? `  /  ${v.limited} LIMITED` : ''}`;
    g.font = `500 18px ${MONO}`;
    this.text(summary, W - 30 - g.measureText(summary).width, 96, 18, MUTED);
    g.fillStyle = HAIR;
    g.fillRect(30, 112, W - 60, 2);
    g.fillStyle = ORANGE;
    g.fillRect(30, 111, 48, 4);

    if (!v.tiles.length) {
      this.text('YOUR PLANS. YOUR QUOTAS.', 60, H / 2 - 30, 28, INK, W - 120, 600);
      this.text(v.note, 60, H / 2 + 30, 25, MUTED, W - 120);
      this.text('Claude · ChatGPT · Grok · Meta · and more', 60, H / 2 + 80, 24, DIM, W - 120);
    } else {
      const { cols, rows } = quotaLayout(v.tiles.length);
      const gap = 14;
      const w = (W - 60 - (cols - 1) * gap) / cols;
      const h = (H - 196 - (rows - 1) * gap) / rows;
      v.tiles.forEach((tile, i) => this.card(tile, 30 + (i % cols) * (w + gap), 132 + Math.floor(i / cols) * (h + gap), w, h));
    }
    g.fillStyle = HAIR;
    g.fillRect(30, H - 64, W - 60, 2);
    const page = v.pages > 1 ? `PAGE ${v.page + 1}/${v.pages} · AUTO 20s` : v.version ? `v${v.version}` : '';
    g.font = `500 20px ${MONO}`;
    const pw = g.measureText(page).width;
    this.text(v.note, 30, H - 24, 20, MUTED, W - 90 - pw);
    this.text(page, W - 30 - pw, H - 24, 20, DIM);
  }

  private pill(text: string, right: number, y: number, color: string) {
    const g = this.g;
    g.font = `600 20px ${MONO}`;
    const w = g.measureText(text).width + 28;
    g.fillStyle = color;
    g.globalAlpha = 0.12;
    g.fillRect(right - w, y, w, 36);
    g.globalAlpha = 1;
    g.strokeStyle = color;
    g.lineWidth = 1;
    g.strokeRect(right - w, y, w, 36);
    this.text(text, right - w + 14, y + 25, 20, color, w - 28, 600);
    return right - w;
  }

  /** One account as a row: who it is on the left, its quota windows as bars on the right. */
  private card(t: QuotaTile, x: number, y: number, w: number, h: number) {
    const g = this.g;
    const [status, color] = STATUS[t.status];
    g.fillStyle = '#0e0e0e';
    g.fillRect(x, y, w, h);
    g.strokeStyle = HAIR;
    g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    g.fillStyle = color;
    g.fillRect(x, y, 4, h);
    // Who it is on one line across the top, its status at the right, then its windows underneath.
    g.font = `600 16px ${MONO}`;
    const statusW = g.measureText(status).width;
    this.text(status, x + w - 20 - statusW, y + 30, 16, color, w, 600);
    this.text(t.provider.toUpperCase(), x + 20, y + 32, 23, INK, 170, 600);
    this.text(t.label, x + 178, y + 32, 18, MUTED, w - 198 - statusW);
    const wx = x + 20;
    const ww = w - 40;
    if (!t.windows.length) {
      this.text(t.status === 'sign-in' ? 'Account needs reconnecting' : t.status === 'paused' ? 'Provider or account is switched off' : 'No usage reported', wx, y + 64, 21, t.status === 'sign-in' ? AMBER : MUTED, ww);
      if (h > 84) this.text(t.detail, wx, y + 90, 17, DIM, ww);
      return;
    }
    const colorOf = (q: QuotaTile['windows'][number]) => (q.due || t.status === 'cached' || t.status === 'paused' || t.status === 'sign-in' || t.status === 'unavailable' ? MUTED : q.remaining <= 0 ? RED : q.remaining <= 20 ? AMBER : GREEN);
    if (t.windows.length > 1 && ww > 340 && h < 180) {
      // Windows side by side: each gets a name, the percent left, a bar and its reset line.
      const colW = (ww - 18 * (t.windows.length - 1)) / t.windows.length;
      t.windows.forEach((q, i) => {
        const cx = wx + i * (colW + 18);
        const qc = colorOf(q);
        this.text(q.name, cx, y + 58, 19, INK, colW - 90);
        const pct = `${Number(q.remaining.toFixed(1))}% left`;
        g.font = `600 20px ${MONO}`;
        this.text(pct, cx + colW - g.measureText(pct).width, y + 58, 20, qc, colW, 600);
        g.fillStyle = '#252525';
        g.fillRect(cx, y + 68, colW, 6);
        g.fillStyle = qc;
        g.fillRect(cx, y + 68, (colW * q.remaining) / 100, 6);
        if (h >= 88) this.text(q.reset, cx, y + 90, 13, q.due ? AMBER : MUTED, colW);
      });
    } else {
      const slot = (h - 40) / t.windows.length;
      t.windows.forEach((q, i) => {
        const yy = y + 54 + i * slot;
        const qc = colorOf(q);
        this.text(q.name, wx, yy, 20, INK, ww - 150);
        const pct = `${Number(q.remaining.toFixed(1))}% left`;
        g.font = `600 22px ${MONO}`;
        this.text(pct, x + w - 20 - g.measureText(pct).width, yy, 22, qc, 190, 600);
        g.fillStyle = '#252525';
        g.fillRect(wx, yy + 9, ww, 6);
        g.fillStyle = qc;
        g.fillRect(wx, yy + 9, (ww * q.remaining) / 100, 6);
        if (slot >= 52) this.text(q.reset, wx, yy + 38, 17, q.due ? AMBER : MUTED, ww);
      });
    }
    if (h > 150) this.text(t.continuation ?? t.detail, wx, y + h - 12, 16, DIM, ww);
  }
}

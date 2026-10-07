import * as THREE from 'three';
import type { FactoryState } from '../../shared/factory';
import { compactCredits, isLive, latestArtifacts, artifactLabel, sessionWhere, spanText, type FactorySession } from '../../shared/factory-sessions';
import { MONO } from '../fonts';
import { ANISOTROPY } from './texture-quality';
import { paintGlyph, track } from './toon';

// The lounge TV: the Factory sessions dashboard while the office is connected to Factory (what's
// running right now and where, the credits today and over the week, the top sessions and the
// latest pull requests), else a standby screen that says how to connect. Big type, so it reads
// from the couch and from the desks across the room.

const W = 1920;
const H = 1080;
const INK = '#eeeeee';
const MUTED = '#8c8c8c';
const DIM = '#5a5a5a';
const ORANGE = '#ee6018';
const HAIR = 'rgba(255, 255, 255, .12)';
const PANEL = '#0c0c0c';
const GREEN = '#3ccf91';
const AMBER = '#f2b84b';
const RED = '#ef4444';
const BLUE = '#5aa9e6';

const STATUS_COLOR: Record<string, string> = { running: ORANGE, pending: AMBER, idle: DIM };

/** `text` cut to fit `max` px in the current font, with an ellipsis. */
function fit(g: CanvasRenderingContext2D, text: string, max: number): string {
  if (g.measureText(text).width <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (g.measureText(`${text.slice(0, mid)}…`).width <= max) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo).trimEnd()}…`;
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const titleOf = (s: { title: string; id: string }) => oneLine(s.title) || `Session ${s.id.slice(0, 8)}`;

export class FactoryTvTexture {
  readonly texture: THREE.CanvasTexture;
  private canvas = document.createElement('canvas');
  private g: CanvasRenderingContext2D;
  private drawn = '';

  constructor() {
    this.canvas.width = W;
    this.canvas.height = H;
    this.g = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = ANISOTROPY;
  }

  /** Draws the screen for `state`, unless it would look the same as the last time. `force` redraws anyway (fonts came in). */
  render(state: FactoryState, now = Date.now(), force = false): void {
    const c = state.connection;
    const on = c.connected && !c.rejected && state.sessions.fetchedAt > 0;
    // What's on screen changes with the data and, for running sessions' ages, by the minute.
    const key = on ? JSON.stringify([state.sessions, state.computers.items.map((x) => [x.id, x.name]), Math.floor(now / 60_000)]) : JSON.stringify(['standby', c.connected, c.rejected ?? '', c.checking ?? false]);
    if (!force && key === this.drawn) return;
    this.drawn = key;
    if (on) this.dashboard(state, now);
    else this.standby(state);
    this.texture.needsUpdate = true;
  }

  private background() {
    const g = this.g;
    g.fillStyle = '#060606';
    g.fillRect(0, 0, W, H);
    g.fillStyle = 'rgba(255, 255, 255, .035)';
    for (let y = 24; y < H; y += 48) for (let x = 24; x < W; x += 48) g.fillRect(x, y, 3, 3);
  }

  private standby(state: FactoryState) {
    const g = this.g;
    this.background();
    g.textBaseline = 'alphabetic';
    g.textAlign = 'left';
    g.fillStyle = ORANGE;
    g.fillRect(140, 420, 14, 120);
    g.fillStyle = INK;
    g.font = `700 108px ${MONO}`;
    g.fillText('OFFICE TV', 186, 512);
    const c = state.connection;
    const lines = c.rejected
      ? ['Factory rejected the office’s key.', 'Connect a new one in ⚙️ Settings → Factory']
      : c.connected
        ? ['Reading Droid sessions from Factory…']
        : ['Connect Factory in ⚙️ Settings → Factory', 'to see Droid sessions and credits here'];
    g.font = `500 44px ${MONO}`;
    g.fillStyle = c.rejected ? RED : MUTED;
    lines.forEach((line, i) => g.fillText(fit(g, line, W - 330), 190, 610 + i * 62));
    g.fillStyle = DIM;
    g.font = `500 30px ${MONO}`;
    track(g, 6);
    g.fillText('STANDBY', 190, 640 + lines.length * 62);
    track(g, 0);
  }

  private label(text: string, x: number, y: number, color = MUTED) {
    const g = this.g;
    g.fillStyle = color;
    g.font = `600 28px ${MONO}`;
    track(g, 5);
    g.fillText(text, x, y);
    track(g, 0);
  }

  private dashboard(state: FactoryState, now: number) {
    const g = this.g;
    const s = state.sessions;
    this.background();
    g.textBaseline = 'alphabetic';
    g.textAlign = 'left';

    // Header: the pinwheel, what this is, and how many run now.
    g.fillStyle = ORANGE;
    paintGlyph(g, 76, 74, 52);
    g.fillStyle = INK;
    g.font = `600 46px ${MONO}`;
    track(g, 6);
    g.fillText('DROID SESSIONS', 124, 92);
    track(g, 0);
    const running = s.items.filter(isLive).sort((a, b) => b.updatedAt - a.updatedAt);
    const chip = running.length ? [`${running.length} RUNNING`, ORANGE] : ['ALL IDLE', GREEN];
    g.font = `600 30px ${MONO}`;
    track(g, 3);
    const tw = g.measureText(chip[0]).width;
    const cx = W - 48 - tw - 70;
    g.globalAlpha = 0.14;
    g.fillStyle = chip[1];
    g.fillRect(cx, 40, tw + 70, 64);
    g.globalAlpha = 1;
    g.strokeStyle = chip[1];
    g.lineWidth = 3;
    g.strokeRect(cx + 1.5, 41.5, tw + 67, 61);
    g.fillRect(cx + 22, 64, 14, 14);
    g.fillText(chip[0], cx + 50, 84);
    track(g, 0);
    if (s.error) {
      g.font = `500 26px ${MONO}`;
      g.fillStyle = AMBER;
      g.textAlign = 'right';
      g.fillText(fit(g, `⚠ ${s.error}`, 620), cx - 30, 84);
      g.textAlign = 'left';
    }
    g.fillStyle = HAIR;
    g.fillRect(48, 132, W - 96, 3);
    g.fillStyle = ORANGE;
    g.fillRect(48, 130, 80, 7);

    // Left: running now (or, with nothing running, the latest).
    const LX = 48;
    const LW = 1130;
    const rows = running.length ? running : [...s.items].sort((a, b) => b.updatedAt - a.updatedAt);
    this.label(running.length ? 'RUNNING NOW' : 'NOTHING RUNNING · LATEST', LX, 192);
    // Four rows and the "+ N more" line fit above the bottom section's rule at y 670.
    const shown = rows.slice(0, 4);
    shown.forEach((x, i) => this.sessionRow(state, x, LX, 216 + i * 100, LW, now, !running.length));
    if (!shown.length) {
      g.font = `500 36px ${MONO}`;
      g.fillStyle = DIM;
      g.fillText('No sessions yet', LX, 290);
    }
    if (rows.length > shown.length) {
      g.font = `500 26px ${MONO}`;
      g.fillStyle = MUTED;
      g.fillText(`+ ${rows.length - shown.length} more${running.length ? ' running' : ''} · E opens them all`, LX, 216 + 4 * 100 + 30);
    }

    // Right: credits today and over the week, one bar a day.
    const RX = 1240;
    const RW = W - 48 - RX;
    this.credits(state, RX, 160, RW, 470);

    // Bottom: the top sessions this week, and the latest pull requests.
    const BY = 700;
    g.fillStyle = HAIR;
    g.fillRect(48, BY - 30, W - 96, 2);
    this.label('TOP SESSIONS · 7 DAYS', LX, BY + 20);
    const top = s.credits.top.slice(0, 4);
    top.forEach((t, i) => {
      const y = BY + 80 + i * 72;
      g.font = `600 38px ${MONO}`;
      g.fillStyle = ORANGE;
      g.textAlign = 'right';
      g.fillText(compactCredits(t.credits), LX + 150, y);
      g.textAlign = 'left';
      g.fillStyle = INK;
      g.font = `500 34px ${MONO}`;
      const item = s.items.find((x) => x.id === t.id);
      const where = item ? sessionWhere(s, state.computers.items, item) : undefined;
      const tail = where && where.kind !== 'elsewhere' ? `  ${where.label}` : '';
      const title = fit(g, oneLine(t.title) || `Session ${t.id.slice(0, 8)}`, 760 - (tail ? 40 + g.measureText(tail).width : 0));
      g.fillText(title, LX + 180, y);
      if (tail) {
        g.fillStyle = where?.color ?? MUTED;
        g.fillText(tail, LX + 180 + g.measureText(title).width + 10, y);
      }
    });
    if (!top.length) {
      g.font = `500 32px ${MONO}`;
      g.fillStyle = DIM;
      g.fillText('No credits counted yet', LX, BY + 80);
    }

    const PX = 1100;
    this.label('LATEST PULL REQUESTS', PX, BY + 20);
    const prs = latestArtifacts(s.items, 4);
    prs.forEach(({ artifact, session }, i) => {
      const y = BY + 80 + i * 72;
      const merged = artifact.action === 'merge';
      g.fillStyle = merged ? '#b689ef' : artifact.kind === 'pull_request' ? GREEN : BLUE;
      g.fillRect(PX, y - 26, 12, 30);
      g.font = `600 34px ${MONO}`;
      g.fillStyle = INK;
      // "droid-office#72": the owner is the same on nearly every row, and the number is what matters.
      const label = fit(g, artifactLabel(artifact).replace(/^[\w.-]+\/(?=[\w.-]+#\d+$)/, ''), 440);
      g.fillText(label, PX + 30, y);
      const lx = PX + 30 + g.measureText(label).width;
      g.font = `500 28px ${MONO}`;
      g.fillStyle = MUTED;
      g.fillText(fit(g, `  ${merged ? 'merged' : (artifact.action ?? '')} · ${titleOf(session)}`, W - 48 - lx), lx, y);
    });
    if (!prs.length) {
      g.font = `500 32px ${MONO}`;
      g.fillStyle = DIM;
      g.fillText('None yet', PX, BY + 80);
    }

    // How old the data is, bottom right.
    g.font = `500 22px ${MONO}`;
    g.fillStyle = DIM;
    g.textAlign = 'right';
    g.fillText(`READ ${spanText(now - s.fetchedAt).toUpperCase()} AGO · E OPENS SESSIONS`, W - 48, H - 24);
    g.textAlign = 'left';
  }

  /** One session: its status light, title, and where it runs, its model and how long it's been going. */
  private sessionRow(state: FactoryState, x: FactorySession, X: number, Y: number, w: number, now: number, idle: boolean) {
    const g = this.g;
    const s = state.sessions;
    g.fillStyle = PANEL;
    g.fillRect(X, Y, w, 88);
    g.fillStyle = STATUS_COLOR[x.status] ?? DIM;
    g.fillRect(X, Y, 8, 88);
    const credits = x.credits !== undefined ? `⚡${compactCredits(x.credits)}` : '';
    g.font = `600 32px ${MONO}`;
    const cw = credits ? g.measureText(credits).width : 0;
    if (credits) {
      g.fillStyle = ORANGE;
      g.textAlign = 'right';
      g.fillText(credits, X + w - 20, Y + 40);
      g.textAlign = 'left';
    }
    g.font = `600 40px ${MONO}`;
    g.fillStyle = idle ? '#bdbdbd' : INK;
    g.fillText(fit(g, titleOf(x), w - 50 - cw - 30), X + 30, Y + 42);
    const where = sessionWhere(s, state.computers.items, x);
    g.font = `500 28px ${MONO}`;
    let cx = X + 30;
    const icon = where.kind === 'office' ? '■ ' : where.kind === 'cloud' ? '☁ ' : '· ';
    g.fillStyle = where.kind === 'office' ? (where.color ?? INK) : where.kind === 'cloud' ? BLUE : MUTED;
    const wl = `${icon}${where.label}`;
    g.fillText(wl, cx, Y + 76);
    cx += g.measureText(wl).width;
    g.fillStyle = MUTED;
    const age = idle ? `active ${spanText(now - x.updatedAt)} ago` : `⏱ ${spanText(now - x.createdAt)}`;
    const rest = [x.model, x.effort, age, x.messageCount ? `${x.messageCount} msgs` : ''].filter(Boolean).join(' · ');
    g.fillText(fit(g, `  ${rest}`, X + w - 20 - cx), cx, Y + 76);
  }

  private credits(state: FactoryState, X: number, Y: number, w: number, h: number) {
    const g = this.g;
    const c = state.sessions.credits;
    g.fillStyle = PANEL;
    g.fillRect(X, Y, w, h);
    g.strokeStyle = HAIR;
    g.lineWidth = 2;
    g.strokeRect(X + 1, Y + 1, w - 2, h - 2);
    const guessedToday = (c.days[c.days.length - 1]?.guessed ?? 0) > 0;
    const guessedWeek = c.days.some((d) => d.estimated && d.credits);
    this.label(`${guessedToday ? '≈ ' : ''}CREDITS TODAY`, X + 30, Y + 52);
    g.fillStyle = INK;
    g.font = `500 104px ${MONO}`;
    g.fillText(compactCredits(c.today), X + 26, Y + 160);
    this.label(`${guessedWeek ? '≈ ' : ''}7 DAYS`, X + 380, Y + 52);
    g.fillStyle = ORANGE;
    g.font = `500 72px ${MONO}`;
    g.fillText(compactCredits(c.week), X + 376, Y + 140);

    // The bars: the newest on the right, the estimated part of each hatched.
    const days = c.days;
    const bx = X + 30;
    const by = Y + 220;
    const bw = w - 60;
    const bh = 170;
    const max = Math.max(1, ...days.map((d) => d.credits));
    const step = bw / Math.max(1, days.length);
    g.fillStyle = HAIR;
    g.fillRect(bx, by + bh, bw, 2);
    days.forEach((d, i) => {
      const x = bx + i * step + 8;
      const bwi = step - 16;
      const hh = d.credits ? Math.max(4, (d.credits / max) * bh) : 0;
      const today = i === days.length - 1;
      if (hh) {
        // Counted credits solid at the bottom, the guessed part (first sightings) hatched on top.
        const gh = d.credits ? hh * (d.guessed / d.credits) : 0;
        const top = by + bh - hh;
        g.fillStyle = today ? ORANGE : '#9a4a22';
        g.fillRect(x, top + gh, bwi, hh - gh);
        if (gh > 0) {
          g.fillStyle = today ? '#5a3220' : '#3a3a3a';
          g.fillRect(x, top, bwi, gh);
          g.save();
          g.beginPath();
          g.rect(x, top, bwi, gh);
          g.clip();
          g.strokeStyle = today ? 'rgba(238, 96, 24, .75)' : 'rgba(255, 255, 255, .18)';
          g.lineWidth = 3;
          for (let k = -gh; k < bwi; k += 14) {
            g.beginPath();
            g.moveTo(x + k, top + gh);
            g.lineTo(x + k + gh, top);
            g.stroke();
          }
          g.restore();
        }
      }
      g.font = `500 22px ${MONO}`;
      g.fillStyle = today ? INK : MUTED;
      g.textAlign = 'center';
      const wd = new Date(`${d.day}T12:00:00`).toLocaleDateString('en', { weekday: 'short' }).toUpperCase();
      g.fillText(today ? 'TODAY' : wd, x + bwi / 2, by + bh + 34);
      g.textAlign = 'left';
    });
    // Honest about what's counted and what's a guess.
    const since = c.since ? new Date(c.since) : undefined;
    const sinceText = since ? (Date.now() - c.since < 86_400_000 ? since.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' }) : since.toLocaleDateString('en', { month: 'short', day: 'numeric' })) : '';
    g.font = `500 22px ${MONO}`;
    g.fillStyle = DIM;
    g.fillText(fit(g, since ? `COUNTED SINCE ${sinceText.toUpperCase()}${guessedWeek ? ' · HATCHED: ESTIMATED' : ''}` : 'NOT COUNTED YET', w - 60), X + 30, Y + h - 22);
  }
}

import * as THREE from 'three';
import { GLASS_ROOM_CHAIRS } from '../../shared/layout';
import { PHASE_WORD, type MissionView, type OrchestratorPhase, type RosterAgent } from '../mission-office';
import { MONO, SANS, loadFonts } from '../fonts';
import { STATUS_BULB } from './character';
import { fit } from './factory-tv';
import { SCREEN_BLACK } from './screen';
import { ANISOTROPY } from './texture-quality';
import { paintGlyph, track } from './toon';

// Mission Control's three screens: the Orchestrator's on the back wall over the table (what it's on, its
// todos, its model and its team), the building agents' teams on the east wall, and the sign on the glass
// by the door, which tells the lounge what the Orchestrator is up to. Each is painted only when what it
// shows changes.

const INK = '#eeeeee';
const MUTED = '#8c8c8c';
const DIM = '#5a5a5a';
const ORANGE = '#ee6018';
const HAIR = 'rgba(255, 255, 255, .12)';

/** The colour of each phase's light, pill and ring: a worker's status bulb, grey while off, red while it can't start. */
export function phaseColor(phase: OrchestratorPhase): string {
  if (phase === 'off') return DIM;
  if (phase === 'blocked') return STATUS_BULB.needs_input;
  if (phase === 'fresh') return STATUS_BULB.idle;
  return STATUS_BULB[phase] ?? MUTED;
}

/** The Orchestrator's headline and the line under it, for each phase. */
export function orchestratorWords(v: Pick<MissionView, 'phase' | 'title' | 'activity' | 'blocked'>): { headline: string; sub: string } {
  if (v.phase === 'off') return { headline: 'The Orchestrator is off', sub: 'Turn it on in ⚙️ Settings → Orchestrator' };
  if (v.phase === 'blocked') return { headline: "The Orchestrator can't start", sub: v.blocked ?? '' };
  if (v.phase === 'fresh') return { headline: 'Ready when you are', sub: 'Tell it what you want done, on any floor' };
  if (v.phase === 'exited' || v.phase === 'offline') return { headline: v.title ?? 'Asleep', sub: 'It wakes up on your next prompt' };
  return { headline: v.title ?? (v.phase === 'working' ? 'Working' : 'Waiting for your next prompt'), sub: v.activity ?? '' };
}

/** One canvas screen and the key of what it shows. */
class Screen {
  readonly texture: THREE.CanvasTexture;
  readonly g: CanvasRenderingContext2D;
  drawn = '';

  constructor(
    readonly W: number,
    readonly H: number,
  ) {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    this.g = canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = ANISOTROPY;
  }

  clear() {
    const g = this.g;
    g.fillStyle = SCREEN_BLACK;
    g.fillRect(0, 0, this.W, this.H);
    g.textBaseline = 'alphabetic';
    g.textAlign = 'left';
  }

  /** The pinwheel and "MISSION CONTROL", baseline `y`, in `px` type. */
  title(x: number, y: number, px: number) {
    const g = this.g;
    g.fillStyle = ORANGE;
    paintGlyph(g, x + px * 0.5, y - px * 0.36, px * 1.05);
    g.font = `600 ${px}px ${MONO}`;
    track(g, px * 0.16);
    g.fillText('MISSION CONTROL', x + px * 1.5, y);
    track(g, 0);
  }

  /** A status pill that ends at `right`, its text on baseline `y`. */
  pill(text: string, color: string, right: number, y: number, px: number) {
    const g = this.g;
    g.font = `600 ${px}px ${MONO}`;
    track(g, px * 0.1);
    const w = g.measureText(text).width + px * 2.6;
    const h = px * 1.9;
    const x = right - w;
    const top = y - px * 1.25;
    g.globalAlpha = 0.14;
    g.fillStyle = color;
    g.fillRect(x, top, w, h);
    g.globalAlpha = 1;
    g.strokeStyle = color;
    g.lineWidth = 3;
    g.strokeRect(x + 1.5, top + 1.5, w - 3, h - 3);
    g.fillRect(x + px * 0.7, top + h / 2 - px * 0.25, px * 0.5, px * 0.5);
    g.fillText(text, x + px * 1.6, y);
    track(g, 0);
  }

  dot(x: number, y: number, r: number, color: string) {
    const g = this.g;
    g.fillStyle = color;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }

  /** `text` over at most `lines` lines `max` px wide, the last cut short with an ellipsis. */
  wrap(text: string, x: number, y: number, max: number, lineHeight: number, lines: number) {
    const g = this.g;
    const out: string[] = [];
    let line = '';
    for (const word of text.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (!line || g.measureText(next).width <= max) line = next;
      else {
        out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
    const shown = out.slice(0, lines);
    if (out.length > lines) shown[lines - 1] = out.slice(lines - 1).join(' ');
    shown.forEach((l, i) => g.fillText(fit(g, l, max), x, y + i * lineHeight));
  }
}

export class MissionScreens {
  private boardScreen = new Screen(1500, 500);
  private rosterScreen = new Screen(1400, 800);
  private signScreen = new Screen(500, 800);
  private view: MissionView | null = null;

  constructor() {
    if (document.fonts) void loadFonts().then(() => this.view && this.render(this.view, true));
  }

  /** The Orchestrator's screen, over the table. */
  get board(): THREE.CanvasTexture {
    return this.boardScreen.texture;
  }

  /** The building agents' teams, on the east wall. */
  get roster(): THREE.CanvasTexture {
    return this.rosterScreen.texture;
  }

  /** The sign on the glass by the door. */
  get sign(): THREE.CanvasTexture {
    return this.signScreen.texture;
  }

  /** Paints each screen whose part of `view` changed, or all of them with `force` (the fonts came in). */
  render(view: MissionView, force = false) {
    this.view = view;
    // Bots past the last chair are on the roster only.
    const seated = Math.min(view.agents.filter((a) => a.kind === 'bot').length, GLASS_ROOM_CHAIRS.length);
    const keys: [Screen, string, () => void][] = [
      [this.boardScreen, JSON.stringify([view.phase, view.title, view.activity, view.todos, view.model, view.blocked, view.teamLine]), () => this.paintBoard(view)],
      [this.rosterScreen, JSON.stringify(view.agents), () => this.paintRoster(view.agents)],
      [this.signScreen, JSON.stringify([view.phase, view.title, view.blocked, seated]), () => this.paintSign(view, seated)],
    ];
    for (const [screen, key, paint] of keys) {
      if (!force && key === screen.drawn) continue;
      screen.drawn = key;
      paint();
      screen.texture.needsUpdate = true;
    }
  }

  private paintBoard(v: MissionView) {
    const s = this.boardScreen;
    const g = s.g;
    s.clear();
    s.title(60, 92, 26);
    const color = phaseColor(v.phase);
    s.pill(PHASE_WORD[v.phase].toUpperCase(), color, s.W - 60, 92, 24);
    g.fillStyle = HAIR;
    g.fillRect(60, 122, s.W - 120, 2);
    const { headline, sub } = orchestratorWords(v);
    g.fillStyle = INK;
    g.font = `600 60px ${SANS}`;
    g.fillText(fit(g, headline, s.W - 120), 60, 216);
    g.fillStyle = v.phase === 'blocked' ? color : MUTED;
    g.font = `500 34px ${SANS}`;
    if (sub) s.wrap(sub, 60, 270, s.W - 120, 42, v.todos ? 1 : 2);
    if (v.todos) {
      const t = v.todos;
      g.font = `500 28px ${MONO}`;
      g.fillStyle = INK;
      g.fillText(fit(g, [`${t.done} of ${t.total}`, t.current].filter(Boolean).join(' · '), s.W - 120), 60, 344);
      g.fillStyle = 'rgba(255, 255, 255, .1)';
      g.fillRect(60, 362, s.W - 120, 12);
      g.fillStyle = ORANGE;
      g.fillRect(60, 362, (s.W - 120) * Math.min(1, t.done / t.total), 12);
    }
    g.fillStyle = HAIR;
    g.fillRect(60, 410, s.W - 120, 2);
    if (v.phase === 'off') return;
    g.font = `500 28px ${MONO}`;
    g.fillStyle = MUTED;
    g.fillText(fit(g, [v.model, v.teamLine ?? 'No team yet'].filter(Boolean).join('   ·   '), s.W - 120), 60, 458);
  }

  private paintRoster(agents: RosterAgent[]) {
    const s = this.rosterScreen;
    const g = s.g;
    s.clear();
    g.fillStyle = ORANGE;
    g.font = `600 28px ${MONO}`;
    track(g, 5);
    g.fillText('BUILDING AGENTS', 60, 84);
    track(g, 0);
    const members = agents.reduce((n, a) => n + a.team.length, 0);
    g.textAlign = 'right';
    g.fillStyle = MUTED;
    g.font = `500 26px ${MONO}`;
    g.fillText(`${agents.length} agent${agents.length === 1 ? '' : 's'} · ${members} subagent${members === 1 ? '' : 's'}`, s.W - 60, 84);
    g.textAlign = 'left';
    g.fillStyle = HAIR;
    g.fillRect(60, 112, s.W - 120, 2);
    if (!agents.length) {
      g.fillStyle = INK;
      g.font = `600 48px ${SANS}`;
      g.fillText('Nobody here yet', 60, 210);
      g.fillStyle = MUTED;
      g.font = `500 32px ${SANS}`;
      s.wrap('Turn the Orchestrator on in ⚙️ Settings, or add a bot under Tailscale MCP', 60, 262, s.W - 120, 42, 2);
      return;
    }
    const bottom = s.H - 36;
    const MEMBER = 46;
    // Every line stays a line above the footer, which counts the agents and subagents that didn't fit.
    const last = bottom - MEMBER;
    let y = 172;
    let hidden = 0;
    for (const a of agents) {
      if (hidden || y > last) {
        hidden += 1 + a.team.length;
        continue;
      }
      s.dot(76, y - 13, 12, a.accent);
      g.fillStyle = INK;
      g.font = `600 40px ${SANS}`;
      g.fillText(fit(g, a.name, 620), 104, y);
      g.fillStyle = MUTED;
      g.font = `500 26px ${MONO}`;
      g.fillText(a.kind === 'bot' ? 'BOT' : 'ORCHESTRATOR', 760, y);
      g.textAlign = 'right';
      g.fillStyle = phaseColor(a.status);
      g.font = `600 26px ${MONO}`;
      track(g, 3);
      g.fillText(PHASE_WORD[a.status].toUpperCase(), s.W - 60, y);
      track(g, 0);
      g.textAlign = 'left';
      y += 54;
      if (!a.team.length && y - 6 <= last) {
        g.fillStyle = DIM;
        g.font = `500 26px ${MONO}`;
        g.fillText('no team', 128, y - 6);
        y += 40;
      }
      for (let i = 0; i < a.team.length; i++) {
        const m = a.team[i];
        if (y > last) {
          hidden += a.team.length - i;
          break;
        }
        s.dot(136, y - 9, 8, phaseColor(m.status));
        g.fillStyle = INK;
        g.font = `500 30px ${SANS}`;
        g.fillText(fit(g, m.name, 560), 160, y);
        g.fillStyle = MUTED;
        g.font = `500 26px ${MONO}`;
        g.fillText(fit(g, m.floor, 360), 760, y);
        g.textAlign = 'right';
        g.fillStyle = phaseColor(m.status);
        g.fillText(PHASE_WORD[m.status], s.W - 60, y);
        g.textAlign = 'left';
        y += MEMBER;
      }
      y += 26;
    }
    if (hidden) {
      g.fillStyle = DIM;
      g.font = `500 26px ${MONO}`;
      g.fillText(`+ ${hidden} more`, 60, bottom);
    }
  }

  private paintSign(v: MissionView, seated: number) {
    const s = this.signScreen;
    const g = s.g;
    s.clear();
    g.strokeStyle = 'rgba(255, 255, 255, .18)';
    g.lineWidth = 3;
    g.strokeRect(1.5, 1.5, s.W - 3, s.H - 3);
    g.fillStyle = phaseColor(v.phase);
    g.fillRect(28, 34, 18, 18);
    g.font = `600 30px ${MONO}`;
    track(g, 4);
    g.fillText(PHASE_WORD[v.phase].toUpperCase(), 62, 54);
    track(g, 0);
    g.fillStyle = HAIR;
    g.fillRect(0, 84, s.W, 2);
    s.title(28, 136, 20);
    g.fillStyle = INK;
    g.font = `600 46px ${SANS}`;
    g.fillText('Orchestrator', 28, 220);
    g.fillStyle = MUTED;
    g.font = `500 30px ${SANS}`;
    s.wrap(orchestratorWords(v).headline, 28, 280, s.W - 56, 40, 5);
    g.fillStyle = HAIR;
    g.fillRect(28, s.H - 110, s.W - 56, 2);
    g.fillStyle = MUTED;
    g.font = `500 26px ${MONO}`;
    g.fillText(seated ? `${seated} bot${seated === 1 ? '' : 's'} at the table` : 'No bots at the table', 28, s.H - 60);
  }
}

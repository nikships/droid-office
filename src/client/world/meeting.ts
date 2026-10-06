import * as THREE from 'three';
import { ANISOTROPY } from './texture-quality';
import { MEETING_PATTERNS, meetingSummary } from '../../shared/meetings';
import type { Meeting, MeetingState } from '../../shared/protocol';
import { SANS, MONO } from '../fonts';
import { paintGlyph, plainLabel, track } from './toon';

const INK = '#eeeeee';
const MUTED = '#8c8c8c';
const ORANGE = '#ee6018';
const HAIR = 'rgba(255, 255, 255, .12)';
/** A meeting's status light: orange while it's live, green once done, red when stopped. */
const STATUS = { running: ORANGE, done: '#3ccf91', stopped: '#ef4444' } as const;

/** The eyebrow both screens carry: the pinwheel and MISSION CONTROL in tracked mono. */
function eyebrow(g: CanvasRenderingContext2D, x: number, y: number, px: number) {
  g.fillStyle = ORANGE;
  paintGlyph(g, x + px * 0.5, y - px * 0.36, px * 1.05);
  g.font = `600 ${px}px ${MONO}`;
  track(g, px * 0.16);
  g.fillText('MISSION CONTROL', x + px * 1.5, y);
  track(g, 0);
}

function canvasTexture(w: number, h: number): { canvas: HTMLCanvasElement; g: CanvasRenderingContext2D; texture: THREE.CanvasTexture } {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = ANISOTROPY;
  return { canvas, g: canvas.getContext('2d')!, texture };
}

/** Breaks text into lines no wider than `maxW`, cutting words too long for a line of their own. */
function wrap(g: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const word of text.split(/\s+/)) {
    if (!word) continue;
    if (cur && g.measureText(`${cur} ${word}`).width > maxW) {
      lines.push(cur);
      cur = word;
    } else cur = cur ? `${cur} ${word}` : word;
    while (g.measureText(cur).width > maxW && cur.length > 1) {
      let cut = cur.length - 1;
      while (cut > 1 && g.measureText(cur.slice(0, cut)).width > maxW) cut--;
      lines.push(cur.slice(0, cut));
      cur = cur.slice(cut);
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Who has the floor right now: the roles on the parts being worked on. */
export function speaking(m: Meeting): string[] {
  return m.turns.filter((t) => t.state !== 'done').map((t) => m.seats[t.seat]?.role ?? '?');
}

/** What's on the table in a line: "Round 2 of 3 · critiquing". */
export function meetingStage(m: Meeting): string {
  const doing = [...new Set(m.turns.filter((t) => t.state !== 'done').map((t) => t.doing))].join(', ');
  return `Round ${m.round} of ${m.rounds}${doing ? ` · ${doing}` : ''}`;
}

/**
 * The board on the meeting room's back wall: the meeting's output file as it's being written, like a
 * shared screen, with what's being worked on across the top.
 */
export class MeetingBoardTexture {
  readonly texture: THREE.CanvasTexture;
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;

  constructor() {
    const c = canvasTexture(1500, 500);
    this.canvas = c.canvas;
    this.g = c.g;
    this.texture = c.texture;
  }

  render(state: MeetingState) {
    const { g } = this;
    const W = this.canvas.width;
    const H = this.canvas.height;
    g.fillStyle = '#050505';
    g.fillRect(0, 0, W, H);
    const m = state.current;
    g.textBaseline = 'alphabetic';
    if (!m) {
      g.textAlign = 'left';
      eyebrow(g, 60, 92, 26);
      g.fillStyle = HAIR;
      g.fillRect(60, 122, W - 120, 2);
      g.fillStyle = INK;
      g.font = `600 64px ${SANS}`;
      g.fillText('The table is free', 60, 250);
      g.font = `500 28px ${MONO}`;
      g.fillStyle = MUTED;
      g.fillText('Press E at the table to call a meeting: whatever it writes shows up here.', 60, 320);
      this.texture.needsUpdate = true;
      return;
    }
    const p = MEETING_PATTERNS[m.pattern];
    // Across the top: the file, and where the meeting is, over a hairline with a status light.
    g.fillStyle = '#0c0c0c';
    g.fillRect(0, 0, W, 70);
    g.fillStyle = HAIR;
    g.fillRect(0, 70, W, 2);
    g.fillStyle = STATUS[m.status];
    g.fillRect(24, 28, 14, 14);
    g.fillStyle = INK;
    g.font = `600 32px ${MONO}`;
    g.fillText(m.output, 54, 47);
    g.font = `500 22px ${MONO}`;
    track(g, 2);
    g.fillStyle = MUTED;
    g.textAlign = 'right';
    g.fillText(`${plainLabel(p.label).toUpperCase()} · ${m.status === 'running' ? meetingStage(m).toUpperCase() : m.status === 'done' ? 'DONE' : 'STOPPED'}`, W - 24, 46);
    track(g, 0);
    g.textAlign = 'left';

    const text = (m.preview ?? '').replace(/\r/g, '');
    if (!text.trim()) {
      g.fillStyle = '#8c8c8c';
      g.font = `500 42px ${SANS}`;
      g.textAlign = 'center';
      g.fillText(m.status === 'running' ? `Nothing written yet: ${speaking(m).join(', ') || 'the table'} ${speaking(m).length === 1 ? 'is' : 'are'} on it` : (m.reason ?? 'Nothing was written'), W / 2, H / 2 + 30);
      g.textAlign = 'left';
      this.texture.needsUpdate = true;
      return;
    }
    // The file, markdown-ish: headings bold and bigger, the rest as it is. Only what fits: its start.
    let y = 118;
    const x = 30;
    const maxW = W - 60;
    for (const raw of text.split('\n')) {
      if (y > H - 14) break;
      const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
      const line = heading ? heading[2] : raw.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]*)`/g, '$1');
      const size = heading ? (heading[1].length === 1 ? 44 : 36) : 28;
      g.font = heading ? `700 ${size}px ${SANS}` : `400 ${size}px ${SANS}`;
      g.fillStyle = heading ? INK : '#c9c9c9';
      if (!line.trim()) {
        y += size * 0.5;
        continue;
      }
      for (const l of wrap(g, line, maxW)) {
        if (y > H - 14) break;
        g.fillText(l, x, y);
        y += size * 1.25;
      }
    }
    this.texture.needsUpdate = true;
  }
}

/**
 * The panel on the glass beside the meeting room's door, like a room-booking screen: what's on, the
 * round, who has the floor; once it's over, its one-line summary.
 */
export class MeetingSignTexture {
  readonly texture: THREE.CanvasTexture;
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;

  constructor() {
    const c = canvasTexture(500, 800);
    this.canvas = c.canvas;
    this.g = c.g;
    this.texture = c.texture;
  }

  render(state: MeetingState) {
    const { g } = this;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const m = state.current;
    const pad = 28;
    const lines = (text: string, font: string, color: string, y: number, max: number, lh: number) => {
      g.font = font;
      g.fillStyle = color;
      for (const l of wrap(g, text, W - 2 * pad).slice(0, max)) {
        g.fillText(l, pad, y);
        y += lh;
      }
      return y;
    };
    g.fillStyle = '#0a0a0a';
    g.fillRect(0, 0, W, H);
    g.strokeStyle = 'rgba(255, 255, 255, .18)';
    g.lineWidth = 3;
    g.strokeRect(1.5, 1.5, W - 3, H - 3);
    g.textBaseline = 'alphabetic';
    // A status light and a word across the top say whether the room is taken.
    const [light, label] = !m ? ['#3ccf91', 'FREE'] : m.status === 'running' ? [ORANGE, 'IN SESSION'] : m.status === 'done' ? ['#3ccf91', 'DONE'] : ['#ef4444', 'STOPPED'];
    g.fillStyle = light;
    g.fillRect(pad, 34, 18, 18);
    g.font = `600 30px ${MONO}`;
    track(g, 4);
    g.fillText(label, pad + 34, 54);
    track(g, 0);
    g.fillStyle = HAIR;
    g.fillRect(0, 84, W, 2);
    eyebrow(g, pad, 136, 20);
    if (!m) {
      const y = lines('The table is free', `600 46px ${SANS}`, '#eeeeee', 210, 2, 56);
      lines('Press E at the table to call a meeting: a debate, lead & team, map-reduce, red / blue or a review panel.', `500 26px ${MONO}`, MUTED, y + 30, 9, 38);
      this.texture.needsUpdate = true;
      return;
    }
    const p = MEETING_PATTERNS[m.pattern];
    let y = lines(plainLabel(p.label).toUpperCase(), `600 26px ${MONO}`, MUTED, 186, 1, 36);
    y = lines(m.title, `700 42px ${SANS}`, '#eeeeee', y + 16, 3, 50);
    y += 18;
    if (m.status === 'running') {
      y = lines(meetingStage(m), `500 30px ${SANS}`, '#c9c9c9', y, 3, 40);
      const who = speaking(m);
      if (who.length) lines(`> ${who.join(', ')}`, `500 26px ${MONO}`, ORANGE, y + 8, 3, 36);
    } else {
      // The summary line after the pattern, which is up top already.
      lines(meetingSummary(m).split(' · ').slice(1).join(' · '), `500 28px ${SANS}`, '#c9c9c9', y, Math.floor((H - y) / 38), 38);
    }
    this.texture.needsUpdate = true;
  }
}

import * as THREE from 'three';
import { capabilityOf, type FactoryConnection } from '../../shared/factory';
import { CI_KIND_LABEL, ciOutcome, ciTotals, groupCi, runTime, triggerLabel, type CiOutcome, type CiRepoGroup, type FactoryCiState } from '../../shared/factory-ci';
import { BOARDS } from '../../shared/layout';
import { MONO } from '../fonts';
import { ANISOTROPY } from './texture-quality';
import { paintGlyph, track } from './toon';

// The CI automations board on the north wall past the gong: which repositories have Droid running in
// GitHub Actions (code review, security review, scheduled jobs), how their latest runs went, and the
// totals. The machine monitor's Factory look: near-black, mono, letter-spaced labels, the orange accent.

const MUTED = '#8c8c8c';
const DIM = '#5a5a5a';
const INK = '#eeeeee';
const ORANGE = '#ee6018';
const HAIR = 'rgba(255, 255, 255, .12)';
const PANEL = '#0e0e0e';
const GREEN = '#3ccf91';
const AMBER = '#f2b84b';
const RED = '#ef4444';

const OUTCOME_COLOR: Record<CiOutcome, string> = { pass: GREEN, fail: RED, running: AMBER, skipped: MUTED, unknown: MUTED };
const OUTCOME_WORD: Record<CiOutcome, string> = { pass: 'PASSED', fail: 'FAILED', running: 'RUNNING', skipped: 'SKIPPED', unknown: 'DONE' };

/** 440 px a meter: BOARDS.ci is 4.1 × 2.2 m, so 1804 × 968. */
const PX_PER_M = 440;
const ROW_H = 96;
const BODY_TOP = 132;
const FOOT_TOP = 818;

/** "3m", "5h", "2d": how long ago, to the coarsest unit that fits. */
export function ago(ms: number, now: number): string {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return 'NOW';
  if (s < 3600) return `${Math.floor(s / 60)}M`;
  if (s < 86400) return `${Math.floor(s / 3600)}H`;
  return `${Math.floor(s / 86400)}D`;
}

export interface CiBoardInput {
  connection: FactoryConnection;
  ci: FactoryCiState;
  /** This floor's GitHub repository (owner/repo), if it has one. */
  floorRepo?: string;
  now: number;
}

/** What the board says instead of the repositories, when it can't show them. */
export function ciBoardEmpty(i: CiBoardInput): { title: string; sub: string; tone: string } | undefined {
  const c = i.connection;
  if (!c.connected) return { title: 'CONNECT FACTORY', sub: 'TO SEE DROID IN YOUR CI · ⚙️ SETTINGS → FACTORY', tone: MUTED };
  if (c.rejected) return { title: 'FACTORY TURNED THE KEY DOWN', sub: 'CHECK IT AGAIN IN ⚙️ SETTINGS → FACTORY', tone: RED };
  if (capabilityOf(c, 'ci')?.status === 'denied') return { title: 'NO ACCESS TO CI AUTOMATIONS', sub: capabilityOf(c, 'ci')?.reason?.toUpperCase() ?? 'THE KEY CAN’T READ THEM', tone: AMBER };
  if (!i.ci.fetchedAt) return { title: 'READING FACTORY…', sub: 'THE DROID WORKFLOWS IN YOUR REPOSITORIES', tone: MUTED };
  if (i.ci.github === false) return { title: 'GITHUB ISN’T CONNECTED TO FACTORY', sub: 'CONNECT IT IN FACTORY’S SETTINGS → INTEGRATIONS', tone: AMBER };
  if (!i.ci.workflows.length) return { title: 'NO DROID WORKFLOWS YET', sub: i.floorRepo ? `ADD DROID CODE REVIEW TO ${i.floorRepo.toUpperCase()} · E` : 'PRESS E TO ADD DROID CODE REVIEW TO A REPOSITORY', tone: ORANGE };
  return undefined;
}

/** The status in the header's corner. */
function headerStatus(i: CiBoardInput): [string, string] {
  if (!i.connection.connected) return ['NOT CONNECTED', MUTED];
  if (i.connection.rejected) return ['KEY REJECTED', RED];
  if (!i.ci.fetchedAt) return ['…', MUTED];
  if (i.ci.github === false) return ['GITHUB NOT CONNECTED', AMBER];
  if (i.ci.error) return ['OUT OF DATE', AMBER];
  const t = ciTotals(i.ci, i.now);
  if (t.running) return [`${t.running} RUNNING`, AMBER];
  return ['GITHUB CONNECTED', GREEN];
}

/** Everything the board shows, as a string: it's redrawn only when this changes. */
export function ciBoardKey(i: CiBoardInput): string {
  const groups = groupCi(i.ci, i.floorRepo);
  return JSON.stringify([
    i.connection.connected,
    i.connection.rejected,
    capabilityOf(i.connection, 'ci')?.status,
    !!i.ci.fetchedAt,
    i.ci.github,
    i.ci.error,
    i.floorRepo,
    ciTotals(i.ci, i.now),
    i.ci.scannedAt && ago(i.ci.scannedAt, i.now),
    groups.map((g) => [g.repo, g.here, g.jobs.length, g.workflows.map((w) => [w.workflow.path, w.kind, w.workflow.triggers, w.workflow.cron, w.latest && [ciOutcome(w.latest), ago(runTime(w.latest), i.now)]])]),
  ]);
}

export class CiBoardTexture {
  readonly texture: THREE.CanvasTexture;
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private drawn = '';

  constructor() {
    this.canvas.width = Math.round(BOARDS.ci.width * PX_PER_M);
    this.canvas.height = Math.round(BOARDS.ci.height * PX_PER_M);
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = ANISOTROPY;
  }

  /** Draws the board, unless it would come out the same as last time (or `force`, once the fonts load). */
  render(i: CiBoardInput, force = false): void {
    const key = ciBoardKey(i);
    if (key === this.drawn && !force) return;
    this.drawn = key;
    const g = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    g.fillStyle = '#050505';
    g.fillRect(0, 0, W, H);
    g.textBaseline = 'alphabetic';
    this.header(i, W);
    const empty = ciBoardEmpty(i);
    if (empty) this.empty(empty, W);
    else this.rows(groupCi(i.ci, i.floorRepo), i.now, W);
    this.footer(i, W, H);
    this.texture.needsUpdate = true;
  }

  private header(i: CiBoardInput, W: number) {
    const g = this.ctx;
    g.textAlign = 'left';
    g.fillStyle = ORANGE;
    paintGlyph(g, 58, 58, 44);
    g.fillStyle = INK;
    g.font = `600 40px ${MONO}`;
    track(g, 5);
    g.fillText('CI AUTOMATIONS', 100, 72);
    const titleW = g.measureText('CI AUTOMATIONS').width;
    g.fillStyle = MUTED;
    g.font = `500 22px ${MONO}`;
    track(g, 3);
    g.fillText('DROID IN GITHUB ACTIONS', 100 + titleW + 28, 70);
    const [text, color] = headerStatus(i);
    g.font = `600 22px ${MONO}`;
    track(g, 2);
    const tw = g.measureText(text).width;
    const sx = W - 36 - tw - 56;
    g.globalAlpha = 0.12;
    g.fillStyle = color;
    g.fillRect(sx, 32, tw + 56, 48);
    g.globalAlpha = 1;
    g.strokeStyle = color;
    g.lineWidth = 2;
    g.strokeRect(sx + 1, 33, tw + 54, 46);
    g.fillRect(sx + 18, 51, 10, 10);
    g.fillText(text, sx + 40, 64);
    track(g, 0);
    g.fillStyle = HAIR;
    g.fillRect(36, 104, W - 72, 2);
    g.fillStyle = ORANGE;
    g.fillRect(36, 103, 56, 4);
  }

  private empty(e: { title: string; sub: string; tone: string }, W: number) {
    const g = this.ctx;
    const mid = (BODY_TOP + FOOT_TOP) / 2;
    g.fillStyle = PANEL;
    g.fillRect(36, BODY_TOP + 10, W - 72, FOOT_TOP - BODY_TOP - 40);
    g.strokeStyle = HAIR;
    g.lineWidth = 2;
    g.setLineDash([14, 10]);
    g.strokeRect(37, BODY_TOP + 11, W - 74, FOOT_TOP - BODY_TOP - 42);
    g.setLineDash([]);
    g.textAlign = 'center';
    g.fillStyle = e.tone;
    paintGlyph(g, W / 2, mid - 110, 90);
    g.fillStyle = INK;
    g.font = `600 56px ${MONO}`;
    track(g, 5);
    g.fillText(e.title, W / 2, mid + 20);
    g.fillStyle = e.tone;
    g.font = `500 26px ${MONO}`;
    track(g, 3);
    g.fillText(e.sub, W / 2, mid + 78);
    track(g, 0);
    g.textAlign = 'left';
  }

  private rows(groups: CiRepoGroup[], now: number, W: number) {
    const g = this.ctx;
    const room = Math.floor((FOOT_TOP - BODY_TOP - 10) / ROW_H);
    const shown = groups.length > room ? groups.slice(0, room - 1) : groups;
    let y = BODY_TOP;
    for (const grp of shown) {
      this.row(grp, now, y, W);
      y += ROW_H;
    }
    if (shown.length < groups.length) {
      const more = groups.length - shown.length;
      g.fillStyle = MUTED;
      g.font = `600 24px ${MONO}`;
      track(g, 3);
      g.fillText(`+ ${more} MORE REPOSITOR${more === 1 ? 'Y' : 'IES'} · E TO SEE THEM ALL`, 56, y + 52);
      track(g, 0);
    }
  }

  private row(grp: CiRepoGroup, now: number, y: number, W: number) {
    const g = this.ctx;
    const h = ROW_H - 12;
    g.fillStyle = PANEL;
    g.fillRect(36, y, W - 72, h);
    g.strokeStyle = grp.here ? 'rgba(238, 96, 24, .55)' : HAIR;
    g.lineWidth = 2;
    g.strokeRect(37, y + 1, W - 74, h - 2);
    if (grp.here) {
      g.fillStyle = ORANGE;
      g.fillRect(36, y, 6, h);
    }
    // The repository: its owner dim, its name bright, and a tag on this floor's.
    const [owner, name] = grp.repo.includes('/') ? [grp.repo.slice(0, grp.repo.indexOf('/') + 1), grp.repo.slice(grp.repo.indexOf('/') + 1)] : ['', grp.repo];
    const nameX = 64;
    const baseY = y + h / 2 + 12;
    g.textAlign = 'left';
    g.font = `500 30px ${MONO}`;
    g.fillStyle = DIM;
    g.fillText(fit(g, owner, 200), nameX, baseY);
    const ow = g.measureText(fit(g, owner, 200)).width;
    g.font = `600 34px ${MONO}`;
    g.fillStyle = INK;
    const nm = fit(g, name, 470 - ow);
    g.fillText(nm, nameX + ow, baseY);
    if (grp.here) {
      g.font = `600 17px ${MONO}`;
      track(g, 3);
      g.fillStyle = ORANGE;
      g.fillText('THIS FLOOR', nameX, y + 24);
      track(g, 0);
    }

    // The latest run of any of its workflows, on the right.
    const latest = grp.workflows.map((w) => w.latest).filter((r) => !!r)[0] ?? grp.runs[0];
    const right = W - 60;
    g.textAlign = 'right';
    g.font = `600 24px ${MONO}`;
    track(g, 2);
    let rightW = 0;
    if (latest) {
      const o = ciOutcome(latest);
      const text = `${OUTCOME_WORD[o]} · ${ago(runTime(latest), now)}`;
      g.fillStyle = OUTCOME_COLOR[o];
      g.fillText(text, right, baseY);
      rightW = g.measureText(text).width;
      g.fillRect(right - rightW - 26, baseY - 16, 12, 12);
      rightW += 30;
    } else if (grp.workflows.length) {
      g.fillStyle = DIM;
      g.fillText('NO RUNS YET', right, baseY);
      rightW = g.measureText('NO RUNS YET').width;
    }
    track(g, 0);

    // A chip for each workflow: what it does and what sets it off, lit in its latest run's color.
    let x = 560;
    const limit = right - rightW - 30;
    g.textAlign = 'left';
    const chips = grp.workflows.map((w) => ({
      label: CI_KIND_LABEL[w.kind].toUpperCase(),
      sub: chipSub(w.workflow.triggers, w.workflow.cron),
      color: w.latest ? OUTCOME_COLOR[ciOutcome(w.latest)] : DIM,
    }));
    if (!chips.length) {
      // This floor's repository, with nothing yet: where its first one goes.
      const text = grp.jobs.some((j) => j.prUrl) ? 'WORKFLOW PR OPENED · E' : '+ ADD DROID CODE REVIEW · E';
      g.font = `600 22px ${MONO}`;
      track(g, 2);
      const w = g.measureText(text).width + 40;
      g.strokeStyle = ORANGE;
      g.setLineDash([8, 6]);
      g.strokeRect(x, y + 18, w, h - 36);
      g.setLineDash([]);
      g.fillStyle = ORANGE;
      g.fillText(text, x + 20, baseY - 2);
      track(g, 0);
      return;
    }
    for (let k = 0; k < chips.length; k++) {
      const c = chips[k];
      g.font = `600 21px ${MONO}`;
      track(g, 2);
      const lw = g.measureText(c.label).width;
      g.font = `500 19px ${MONO}`;
      track(g, 1);
      const sw = c.sub ? g.measureText(c.sub).width : 0;
      const w = 34 + Math.max(lw, sw) + 18;
      const left = chips.length - k - 1;
      // The last chip that fits says how many more there are.
      if (x + w > limit - (left ? 90 : 0)) {
        g.font = `600 22px ${MONO}`;
        track(g, 2);
        g.fillStyle = MUTED;
        g.fillText(`+${chips.length - k}`, x + 4, baseY);
        track(g, 0);
        break;
      }
      g.fillStyle = '#151515';
      g.fillRect(x, y + 14, w, h - 28);
      g.strokeStyle = HAIR;
      g.strokeRect(x + 1, y + 15, w - 2, h - 30);
      g.fillStyle = c.color;
      g.fillRect(x + 14, y + 28, 10, 10);
      g.font = `600 21px ${MONO}`;
      track(g, 2);
      g.fillStyle = INK;
      g.fillText(c.label, x + 34, y + 39);
      if (c.sub) {
        g.font = `500 19px ${MONO}`;
        track(g, 1);
        g.fillStyle = MUTED;
        g.fillText(c.sub, x + 34, y + h - 22);
      }
      track(g, 0);
      x += w + 12;
    }
  }

  private footer(i: CiBoardInput, W: number, H: number) {
    const g = this.ctx;
    g.fillStyle = HAIR;
    g.fillRect(36, FOOT_TOP, W - 72, 2);
    const connected = i.connection.connected && !i.connection.rejected && !!i.ci.fetchedAt;
    const t = ciTotals(i.ci, i.now);
    const cells: [string, string, string][] = connected
      ? [
          ['WORKFLOWS', String(t.workflows), INK],
          ['REPOS', String(t.repos), INK],
          ['RUNS · 7D', String(t.week), INK],
          ['PASSED', String(t.passed), t.passed ? GREEN : INK],
          ['FAILED', String(t.failed), t.failed ? RED : INK],
        ]
      : [
          ['WORKFLOWS', '–', DIM],
          ['REPOS', '–', DIM],
          ['RUNS · 7D', '–', DIM],
          ['PASSED', '–', DIM],
          ['FAILED', '–', DIM],
        ];
    const y = FOOT_TOP + (H - FOOT_TOP) / 2 + 22;
    let x = 56;
    for (const [label, value, color] of cells) {
      g.textAlign = 'left';
      g.font = `600 20px ${MONO}`;
      track(g, 3);
      g.fillStyle = MUTED;
      g.fillText(label, x, y - 8);
      const lw = g.measureText(label).width;
      g.font = `500 48px ${MONO}`;
      track(g, 0);
      g.fillStyle = color;
      g.fillText(value, x + lw + 16, y + 6);
      x += lw + 16 + g.measureText(value).width + 56;
    }
    g.textAlign = 'right';
    g.font = `500 20px ${MONO}`;
    track(g, 2);
    g.fillStyle = DIM;
    const scanned = i.ci.scannedAt ? `SCANNED ${ago(i.ci.scannedAt, i.now)}${ago(i.ci.scannedAt, i.now) === 'NOW' ? '' : ' AGO'}` : '';
    g.fillText(scanned, W - 60, y - 2);
    track(g, 0);
    g.textAlign = 'left';
  }
}

/** A workflow's triggers in a few words: the schedule, then the events. */
function chipSub(triggers: string[], cron?: string): string {
  const words = [...new Set(triggers.filter((t) => t !== 'schedule' && t !== 'workflow_dispatch').map(triggerLabel))];
  const parts = [...(cron ? [`CRON ${cron}`] : []), ...words];
  const text = parts.join(' · ').toUpperCase();
  return text.length > 34 ? `${text.slice(0, 33)}…` : text || (triggers.includes('workflow_dispatch') ? 'MANUAL' : '');
}

/** `text` cut with an ellipsis to fit `max` px in the current font. */
function fit(g: CanvasRenderingContext2D, text: string, max: number): string {
  if (g.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && g.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t}…`;
}

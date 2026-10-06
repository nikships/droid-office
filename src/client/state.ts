import type {
  Arrival,
  FloorInfo,
  FloorView,
  GhIssue,
  GhPull,
  GhState,
  LeaveOnMergeState,
  MachineState,
  MeetingState,
  NotifyState,
  ProjectInfo,
  ProjectsDirState,
  PromptsState,
  QueueState,
  QueueTask,
  RepoChoice,
  ServerMsg,
  ServicesState,
  SkyState,
  SubagentsState,
  UpgradeState,
  WorkerInfo,
} from '../shared/protocol';
import { SUBAGENT_DEFAULTS } from '../shared/protocol';
import type { ScreenState } from './world/laptop';
import { randomLook, sanitizeLook, type Look } from '../shared/avatar';
import type { Decoration } from '../shared/decor';
import { JUKEBOX_TUNES, type JukeboxState } from '../shared/jukebox';
import type { CabinetFrame, CabinetState } from '../shared/cabinet';
import { forgeWords, type ForgeWords } from '../shared/floors';
import type { JiraBoardState, JiraFloorState } from '../shared/jira';
import type { BallState } from '../shared/hoop';
import { teamOf } from '../shared/team';

export type Topic =
  | 'workers'
  | 'issues'
  | 'pulls'
  | 'project'
  | 'screens'
  | 'upgrade'
  | 'services'
  | 'decor'
  | 'queue'
  | 'notify'
  | 'machine'
  | 'floors'
  | 'floor'
  | 'projectsDir'
  | 'repos'
  | 'jukebox'
  | 'sky'
  | 'leaveOnMerge'
  | 'subagents'
  | 'cabinet'
  | 'cabinetFrame'
  | 'meeting'
  | 'prompts'
  | 'jira'
  | 'jiraBoard'
  | 'ball';

export interface Profile {
  name: string;
  color: string;
  look: Look;
}

const PROFILE_KEY = 'droid-office.profile';
export const AVATAR_COLORS = ['#ff8a5b', '#4f86f7', '#06d6a0', '#ef476f', '#ffd166', '#9d4edd', '#00b4d8', '#f77f00'];

/** Your saved profile. `look` is missing if you joined before there was a character select screen. */
export function loadProfile(): (Omit<Profile, 'look'> & { look?: Look }) | null {
  try {
    const p = JSON.parse(localStorage.getItem(PROFILE_KEY) ?? 'null');
    if (p && typeof p.name === 'string' && typeof p.color === 'string') {
      return { name: p.name, color: p.color, look: p.look ? sanitizeLook(p.look, randomLook()) : undefined };
    }
  } catch {
    // storage blocked
  }
  return null;
}

export function saveProfile(p: Profile) {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
  } catch {
    // storage blocked
  }
}

export type ViewMode = 'first' | 'third';

/** The panels you can show or hide on screen, from the ☰ menu. */
export type HudPanel = 'workers' | 'floor';
/** The workers show by default; the rest wait in the ☰ menu until turned on. */
export const HUD_DEFAULTS: Record<HudPanel, boolean> = { workers: true, floor: false };

export interface Settings {
  view: ViewMode;
  /** Office sounds, 0–1. */
  volume: number;
  muted: boolean;
  /** The lounge jukebox, 0–1, apart from the office sounds. */
  music: number;
  musicMuted: boolean;
  /** Desktop notifications when a worker needs input or finishes while you're in another tab (once the browser allows them). */
  notify: boolean;
  /** Which panels show on screen. */
  hud: Record<HudPanel, boolean>;
  /** The ☰ menu's actions you pinned to the top bar, by id. */
  pins: string[];
}

const SETTINGS_KEY = 'droid-office.settings';
const FLOOR_KEY = 'droid-office.floor';

/** The floor you were last on, to come back to it after a reload. */
export function lastFloor(): string | null {
  try {
    return localStorage.getItem(FLOOR_KEY);
  } catch {
    return null;
  }
}

function rememberFloor(id: string | null) {
  try {
    if (id) localStorage.setItem(FLOOR_KEY, id);
  } catch {
    // storage blocked
  }
}

const SPOT_KEY = 'droid-office.spot';

/** Where you were standing, on which floor (or the roof), to be back there when you come back in. */
export interface Spot {
  floor: string;
  /** What that floor was called, to say so if it's gone by then. */
  name: string;
  x: number;
  y: number;
  z: number;
  facing: number;
}

/** The spot you were last in, if this browser has one. */
export function lastSpot(): Spot | null {
  try {
    const s = JSON.parse(localStorage.getItem(SPOT_KEY) ?? 'null');
    const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
    if (s && typeof s.floor === 'string' && s.floor && finite(s.x) && finite(s.y) && finite(s.z) && finite(s.facing)) {
      return { floor: s.floor, name: typeof s.name === 'string' ? s.name : '', x: s.x, y: s.y, z: s.z, facing: s.facing };
    }
  } catch {
    // storage blocked
  }
  return null;
}

export function rememberSpot(s: Spot) {
  try {
    localStorage.setItem(SPOT_KEY, JSON.stringify(s));
  } catch {
    // storage blocked
  }
}

/** Query fields for coming back to `at` on `floor`. Nothing unless the remembered spot is on that floor. */
export function spotParams(floor: string | null, at: Spot | null): { x: string; y: string; z: string; rotY: string } | null {
  if (!floor || at?.floor !== floor) return null;
  return { x: at.x.toFixed(2), y: at.y.toFixed(2), z: at.z.toFixed(2), rotY: at.facing.toFixed(3) };
}

export function loadSettings(): Settings {
  const s: Settings = { view: 'first', volume: 0.7, muted: false, music: 0.5, musicMuted: false, notify: true, hud: { ...HUD_DEFAULTS }, pins: [] };
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null');
    if (saved?.view === 'first' || saved?.view === 'third') s.view = saved.view;
    if (typeof saved?.volume === 'number' && Number.isFinite(saved.volume)) s.volume = Math.max(0, Math.min(1, saved.volume));
    if (typeof saved?.muted === 'boolean') s.muted = saved.muted;
    if (typeof saved?.music === 'number' && Number.isFinite(saved.music)) s.music = Math.max(0, Math.min(1, saved.music));
    if (typeof saved?.musicMuted === 'boolean') s.musicMuted = saved.musicMuted;
    if (typeof saved?.notify === 'boolean') s.notify = saved.notify;
    for (const k of Object.keys(s.hud) as HudPanel[]) if (typeof saved?.hud?.[k] === 'boolean') s.hud[k] = saved.hud[k];
    // Yesterday's people/chat panels can't come back from saved settings: the hud loop only reads today's flags, and pins drop their ids.
    if (Array.isArray(saved?.pins)) s.pins = saved.pins.filter((p: unknown): p is string => typeof p === 'string' && p !== 'people' && p !== 'chat').slice(0, 30);
  } catch {
    // storage blocked
  }
  return s;
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // storage blocked
  }
}

/** The worker whose worktree branch a pull request came from, if it is still at a desk. */
export function workerForPull(workers: Iterable<WorkerInfo>, pr: { number: number; headRefName: string }): WorkerInfo | undefined {
  for (const w of workers) if (w.pr?.number === pr.number || (w.worktree && w.worktree.branch === pr.headRefName)) return w;
  return undefined;
}

class Store {
  /** This connection's transport id; never shown, never a player. */
  connection = '';
  /** Where the server last put this connection (see welcome, floor.enter). */
  arrival: Arrival | null = null;
  profile: Profile = { name: 'Guest', color: '#161616', look: randomLook() };
  workers = new Map<string, WorkerInfo>();
  screens = new Map<string, ScreenState>();
  project: ProjectInfo | null = null;
  /** Every floor of the building, and the one you're on (null while there are none). */
  floors: FloorInfo[] = [];
  floor: string | null = null;
  /** Where the office looks for existing checkouts to add as floors. */
  projectsDir: ProjectsDirState = { dir: '', custom: false };
  /** The git checkouts found in the workspace folder, once asked for (see floor.repos). */
  repos: { list: RepoChoice[]; error?: string; loading: boolean; at: number } = { list: [], loading: false, at: 0 };
  issues: GhState<GhIssue> = { items: [], fetchedAt: 0, loading: true };
  pulls: GhState<GhPull> = { items: [], fetchedAt: 0, loading: true };
  upgrade: UpgradeState = { available: false, phase: 'idle' };
  services: ServicesState = { items: [], port: 4600 };
  /** Pictures on the walls. */
  decor: Decoration[] = [];
  /** What the lounge jukebox is playing; `since` is when the track started, on performance.now()'s clock. */
  jukebox: JukeboxState & { since: number } = { on: false, track: JUKEBOX_TUNES[0].id, startedAt: 0, elapsed: 0, since: 0 };
  /** The office's clock minus performance.now(), from the quickest ping (see 'pong'); for the jukebox. */
  private clock?: { offset: number; rtt: number };
  /** Your game on the arcade cabinet on your floor, and the building's high scores. */
  cabinet: CabinetState = { player: null, scores: [] };
  /** Your game on the cabinet as you last sent it; null while you're not playing. */
  cabinetFrame: CabinetFrame | null = null;
  queue: QueueState = { tasks: [], maxWorkers: 0 };
  /** The office's Jira connection and this floor's epic. */
  jira: JiraFloorState = {};
  /** The Jira tab of the issue board; null on a floor without an epic. */
  jiraBoard: JiraBoardState | null = null;
  /** The meeting room: the meeting at the table, and the ones before. */
  meeting: MeetingState = { current: null, past: [] };
  /** The office's Slack / Discord webhook. */
  notify: NotifyState = {};
  /** How busy the office's machine is, and its worker limit. */
  machine: MachineState = { cpu: 0, cores: 0, memUsed: 0, memTotal: 0, history: [], workers: 0 };
  /** The basketball on this floor, as the office last said (see world/hoop.ts). */
  ball: BallState = {};
  /** Outside the windows; null until the server says. */
  sky: SkyState | null = null;
  /** Whether workers whose pull request merged go home by themselves (⚙️ Settings). */
  leaveOnMerge: LeaveOnMergeState = { on: false };
  /** How workers hire subagents (⚙️ Settings → Subagents), and where the Droid skill is. */
  subagents: SubagentsState = { ...SUBAGENT_DEFAULTS };
  /** The office's prompts as rewritten in Settings, and the worker a new one starts on when nobody picks: the same on every floor. */
  prompts: PromptsState = { custom: {} };
  private subs = new Map<Topic, Set<() => void>>();

  on(topic: Topic, fn: () => void) {
    let set = this.subs.get(topic);
    if (!set) this.subs.set(topic, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  emit(topic: Topic) {
    this.subs.get(topic)?.forEach((fn) => fn());
  }

  /** The floor you're on. */
  currentFloor(): FloorInfo | undefined {
    return this.floors.find((f) => f.id === this.floor);
  }

  /** The office's clock (ms since 1970) as near as this page can tell, which the DJ on the roof keeps time by. */
  officeNow(): number {
    return this.clock ? performance.now() + this.clock.offset : Date.now();
  }

  workerAtDesk(deskId: string): WorkerInfo | undefined {
    for (const w of this.workers.values()) if (w.deskId === deskId) return w;
    return undefined;
  }

  /** The subagents a worker on this floor hired, oldest first. */
  teamOf(leadId: string): WorkerInfo[] {
    return teamOf(this.workers.values(), leadId);
  }

  /** The queue task for an issue: the one on the queue if there is one, else the latest finished one. */
  taskForIssue(issue: number): QueueTask | undefined {
    const tasks = this.queue.tasks.filter((t) => t.issue === issue);
    return tasks.find((t) => t.status !== 'done') ?? tasks[tasks.length - 1];
  }

  /** Everything on the floor you just arrived on, in place of the last one's. */
  private enter(v: FloorView) {
    this.floor = v.floor;
    rememberFloor(v.floor);
    this.project = v.project;
    this.workers = new Map(v.workers.map((w) => [w.id, w]));
    this.screens.clear(); // fresh full frames follow
    this.issues = v.issues;
    this.pulls = v.pulls;
    this.queue = v.queue;
    this.meeting = v.meeting;
    this.jira = v.jira ?? {};
    this.jiraBoard = v.jiraBoard ?? null;
    this.decor = v.decor;
    this.services = v.services;
    this.cabinet = { player: v.cabinet.player, scores: v.cabinet.scores };
    this.cabinetFrame = v.cabinet.frame;
    this.setJukebox(v.jukebox);
    this.ball = v.ball ?? {};
    for (const t of ['floor', 'project', 'workers', 'issues', 'pulls', 'queue', 'meeting', 'decor', 'services', 'jukebox', 'cabinet', 'cabinetFrame', 'jira', 'jiraBoard', 'ball'] as Topic[]) this.emit(t);
  }

  /** When the track started on this page's clock: from the office's clock once it's known, else from `elapsed`. */
  private setJukebox(j: JukeboxState) {
    this.jukebox = { ...j, since: this.clock ? j.startedAt - this.clock.offset : performance.now() - j.elapsed };
  }

  apply(msg: ServerMsg) {
    switch (msg.t) {
      case 'welcome':
        this.connection = msg.connection;
        this.arrival = msg.arrival;
        this.floors = msg.floors;
        this.projectsDir = msg.projectsDir;
        this.upgrade = msg.upgrade;
        this.notify = msg.notify;
        this.machine = msg.machine;
        this.clock = undefined; // compared again, in case it's another office (or the same one, restarted)
        this.sky = msg.sky;
        this.leaveOnMerge = msg.leaveOnMerge ?? { on: false };
        this.subagents = msg.subagents ?? { ...SUBAGENT_DEFAULTS };
        this.prompts = msg.prompts ?? { custom: {} };
        this.enter(msg);
        for (const t of ['upgrade', 'notify', 'machine', 'floors', 'projectsDir', 'sky', 'leaveOnMerge', 'subagents', 'prompts'] as Topic[]) this.emit(t);
        break;
      case 'floor.enter':
        this.arrival = msg.arrival;
        this.enter(msg);
        break;
      case 'floors':
        this.floors = msg.floors;
        this.emit('floors');
        break;
      case 'projectsDir':
        this.projectsDir = msg.state;
        this.emit('projectsDir');
        break;
      case 'floor.repos':
        this.repos = { list: msg.repos, error: msg.error, loading: false, at: Date.now() };
        this.emit('repos');
        break;
      case 'worker.update':
        this.workers.set(msg.worker.id, msg.worker);
        this.emit('workers');
        break;
      case 'worker.remove':
        this.workers.delete(msg.workerId);
        this.screens.delete(msg.workerId);
        this.emit('workers');
        break;
      case 'screen': {
        let s = this.screens.get(msg.workerId);
        if (!s || msg.full || s.cols !== msg.cols || s.rows !== msg.rows) {
          s = { cols: msg.cols, rows: msg.rows, lines: [], cursor: msg.cursor, version: (s?.version ?? 0) + 1 };
          this.screens.set(msg.workerId, s);
        }
        for (const [k, v] of Object.entries(msg.lines)) s.lines[Number(k)] = v;
        s.cursor = msg.cursor;
        s.version++;
        this.emit('screens');
        break;
      }
      case 'gh.issues':
        this.issues = msg.state;
        this.emit('issues');
        break;
      case 'gh.pulls':
        this.pulls = msg.state;
        this.emit('pulls');
        break;
      case 'upgrade':
        this.upgrade = msg.state;
        this.emit('upgrade');
        break;
      case 'services':
        this.services = msg.state;
        this.emit('services');
        break;
      case 'decor':
        this.decor = msg.items;
        this.emit('decor');
        break;
      case 'jukebox':
        this.setJukebox(msg.state);
        this.emit('jukebox');
        break;
      case 'cabinet':
        // No game of yours any more, or a new one: the last game's screen goes with it.
        if (!msg.state.player || msg.state.player.game !== this.cabinet.player?.game) this.cabinetFrame = null;
        this.cabinet = msg.state;
        this.emit('cabinet');
        break;
      case 'pong': {
        // The answer that came back quickest says best how the two clocks line up.
        const rtt = performance.now() - msg.at;
        if (this.clock && rtt >= this.clock.rtt) break;
        this.clock = { offset: msg.now - (msg.at + rtt / 2), rtt };
        const was = this.jukebox.since;
        this.setJukebox(this.jukebox);
        if (Math.abs(this.jukebox.since - was) > 20) this.emit('jukebox');
        break;
      }
      case 'queue':
        this.queue = msg.state;
        this.emit('queue');
        break;
      case 'meeting':
        this.meeting = msg.state;
        this.emit('meeting');
        break;
      case 'notify':
        this.notify = msg.state;
        this.emit('notify');
        break;
      case 'jira':
        this.jira = msg.state;
        this.emit('jira');
        break;
      case 'jira.board':
        this.jiraBoard = msg.state;
        this.emit('jiraBoard');
        break;
      case 'machine':
        this.machine = msg.state;
        this.emit('machine');
        break;
      case 'ball':
        this.ball = msg.ball;
        this.emit('ball');
        break;
      case 'sky':
        this.sky = msg.state;
        this.emit('sky');
        break;
      case 'leaveOnMerge':
        this.leaveOnMerge = msg.state;
        this.emit('leaveOnMerge');
        break;
      case 'subagents':
        this.subagents = msg.state;
        this.emit('subagents');
        break;
      case 'prompts':
        this.prompts = msg.state;
        this.emit('prompts');
        break;
    }
  }
}

export const store = new Store();

/** How the floor you're on names things: GitHub's PRs and gh, or GitLab's MRs and glab. */
export function words(): ForgeWords {
  return forgeWords(store.project?.forge);
}

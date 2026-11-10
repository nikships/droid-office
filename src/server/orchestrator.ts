// The Orchestrator: the building agent the office launches and owns, one Droid session in a PTY with no desk,
// in the office's own .droid-office/orchestrator/ folder (docs/mission-control.md). It signs in to the Office
// MCP on the loopback hook listener with its terminal's hook token and gets the building agents' surface.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_ORCHESTRATOR_SETTINGS, ORCHESTRATOR_COLOR, ORCHESTRATOR_ID, ORCHESTRATOR_NAME, type MissionAgent, type OrchestratorSettings, type OrchestratorState } from '../shared/mission-control.js';
import { AGENT_EFFORTS, type AgentChoice, type WorkerInfo } from '../shared/protocol.js';
import type { ScreenFrame } from './screen-frame.js';
import { missionTeam } from './building-agent.js';
import { officePrompt, type PromptSource } from './prompts.js';
import type { Team } from './team.js';
import { WorkerManager, type HookEnv } from './workers.js';

/** In the office's own `.droid-office/`: on or off, and the model and effort it runs on. */
export const ORCHESTRATOR_FILE = 'orchestrator.json';
/** Its folder in the office's own `.droid-office/`: where its session runs, never a checkout. */
export const ORCHESTRATOR_DIR = 'orchestrator';
/** Droid's file-editing tools: the Orchestrator plans and hires, and never edits. */
export const ORCHESTRATOR_DENIED_TOOLS = '^(Edit|MultiEdit|Create|ApplyPatch)$';
const DENIED = 'The Orchestrator never edits files. Hire a worker with team_hire and give it the change.';

/** One open floor, as the Orchestrator's team spans them. */
export interface OrchestratorFloor {
  id: string;
  def: { name: string };
  workers: Pick<WorkerManager, 'list'>;
  team: Pick<Team, 'leadRested' | 'beforeStop'>;
}

export interface OrchestratorOptions {
  /** The office's own `.droid-office/`. */
  dataDir: string;
  agentCmd: string;
  agentArgs: string[];
  hook: HookEnv;
  prompts?: PromptSource;
  floors(): OrchestratorFloor[];
  /** Why no agent can start now: Droid missing or signed out, or the Office MCP off. */
  unready(): string | undefined;
  /** Why an agent on this model can't start now (Subscriptions), if it can't. */
  modelGate?(model: string | undefined): string | undefined;
  /** Its state changed: Mission Control is due a broadcast. */
  changed(): void;
  data(workerId: string, data: string, connectionIds: string[]): void;
  screen(workerId: string, frame: ScreenFrame): void;
  toast(text: string, level: 'info' | 'warn' | 'error'): void;
}

function readSettings(file: string): OrchestratorSettings {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    return {
      on: raw.on !== false,
      ...(typeof raw.model === 'string' && raw.model ? { model: raw.model } : {}),
      ...(typeof raw.effort === 'string' && (AGENT_EFFORTS as readonly string[]).includes(raw.effort) ? { effort: raw.effort as OrchestratorSettings['effort'] } : {}),
    };
  } catch {
    return { ...DEFAULT_ORCHESTRATOR_SETTINGS };
  }
}

export class Orchestrator {
  readonly workers: WorkerManager;
  /** Where its session runs. */
  readonly cwd: string;
  private settings: OrchestratorSettings;
  private readonly file: string;
  private lastStatus?: WorkerInfo['status'];
  /** A new model or effort waits for its turn to end before its session restarts on it. */
  private restartAtRest = false;

  constructor(private readonly opts: OrchestratorOptions) {
    this.file = path.join(opts.dataDir, ORCHESTRATOR_FILE);
    this.settings = readSettings(this.file);
    this.cwd = path.join(opts.dataDir, ORCHESTRATOR_DIR);
    const stateDir = path.join(this.cwd, '.droid-office');
    mkdirSync(stateDir, { recursive: true });
    this.workers = new WorkerManager(
      this.cwd,
      stateDir,
      opts.agentCmd,
      opts.agentArgs,
      opts.hook,
      {
        update: (w) => this.updated(w),
        remove: () => {
          this.lastStatus = undefined;
          opts.changed();
        },
        data: (id, data, ids) => opts.data(id, data, ids),
        screen: (id, frame) => opts.screen(id, frame),
        toast: (text, level) => opts.toast(text, level),
      },
      undefined,
      undefined,
      opts.prompts,
      true,
      undefined,
      true,
    );
    this.workers.systemPrompt = (info) => officePrompt(opts.prompts, 'orchestrator.system', { name: info.name, folder: this.cwd });
    this.workers.denyTools = { matcher: ORCHESTRATOR_DENIED_TOOLS, reason: DENIED };
    this.workers.asleep = () => !this.settings.on;
    this.workers.modelGate = (model) => opts.modelGate?.(model);
    // Its team's news it hasn't been woken for, on every floor, instead of stopping.
    this.workers.beforeStop = (info) => {
      const notes = opts.floors().flatMap((f) => f.team.beforeStop(info) ?? []);
      return notes.length ? notes.join('\n\n') : undefined;
    };
  }

  /** Picks its terminal back up, or resumes its conversation, as a floor does its workers. */
  start(): Promise<void> {
    // A session saved before its colour became the office accent.
    this.workers.recolor(ORCHESTRATOR_ID, ORCHESTRATOR_COLOR);
    return this.workers.start();
  }

  shutdown(keep = false) {
    this.workers.shutdown(keep);
  }

  get info(): WorkerInfo | undefined {
    return this.workers.get(ORCHESTRATOR_ID);
  }

  /** MCP discovery includes the configured agent before its first prompt, without starting a session. */
  rosterAgent(): MissionAgent | undefined {
    const worker = this.identity();
    return worker && { worker, team: missionTeam(this.opts.floors(), ORCHESTRATOR_ID) };
  }

  /**
   * Who it is to the floors: nobody while it is off, so its team reports to nobody. Between conversations
   * it is still their lead, with no session to wake: their news waits for its next one.
   */
  identity(): WorkerInfo | undefined {
    if (!this.settings.on) return undefined;
    return (
      this.info ?? {
        id: ORCHESTRATOR_ID,
        name: ORCHESTRATOR_NAME,
        kind: 'agent',
        deskId: '',
        color: ORCHESTRATOR_COLOR,
        status: 'idle',
        activity: this.blocked() ?? 'Ready for its first prompt',
        acked: true,
        createdBy: 'owner',
        createdAt: 0,
        cols: 100,
        rows: 30,
        open: false,
        ...this.choice(),
      }
    );
  }

  authenticate(id: string, token: string): WorkerInfo | undefined {
    return this.settings.on && id === ORCHESTRATOR_ID ? this.workers.authenticate(id, token) : undefined;
  }

  /** The model and effort it starts on: its own setting, else the office default. */
  private choice(): AgentChoice {
    if (this.settings.model) return { model: this.settings.model, effort: this.settings.effort };
    const office = this.workers.officeDefault;
    return { model: office?.model, effort: this.settings.effort ?? office?.effort };
  }

  blocked(): string | undefined {
    return this.opts.unready() ?? this.opts.modelGate?.(this.choice().model);
  }

  /** The owner's prompt: the first one starts its session. */
  prompt(text: string, images?: readonly string[], queue = false): string | undefined {
    if (!this.settings.on) return 'The Orchestrator is off. Turn it on in ⚙️ Settings → Orchestrator.';
    const blocked = this.blocked();
    if (blocked) return blocked;
    const info = this.info;
    if (!info) {
      const { model, effort } = this.choice();
      const started = this.workers.spawnDeskless(ORCHESTRATOR_ID, ORCHESTRATOR_NAME, ORCHESTRATOR_COLOR, 'owner', text, model, effort, images);
      return typeof started === 'string' ? started : undefined;
    }
    // Not running: carry its conversation on, with this as its next message.
    if (!this.running()) return this.workers.resume(ORCHESTRATOR_ID, text, images);
    return this.workers.prompt(ORCHESTRATOR_ID, text, images, queue);
  }

  private running(): boolean {
    return this.workers.running(ORCHESTRATOR_ID);
  }

  /** A note for it from a floor (its team's news, a worker's message): handed over mid-turn, typed in at rest. */
  tell(text: string): string | undefined {
    if (!this.settings.on) return 'The Orchestrator is off';
    if (!this.running()) return 'The Orchestrator has no session running';
    return this.workers.tell(ORCHESTRATOR_ID, text);
  }

  interrupt(): boolean {
    return this.workers.cancelTurn(ORCHESTRATOR_ID);
  }

  /** New conversation: its session and terminal go, and its team stays its own. */
  reset() {
    this.restartAtRest = false;
    this.workers.forget(ORCHESTRATOR_ID);
    this.opts.changed();
  }

  set(next: OrchestratorSettings): string | undefined {
    const before = this.settings;
    const saved: OrchestratorSettings = { on: next.on, ...(next.model ? { model: next.model } : {}), ...(next.effort ? { effort: next.effort } : {}) };
    this.settings = saved;
    const chosen = before.model !== saved.model || before.effort !== saved.effort;
    if (chosen && this.info) {
      const { model, effort } = this.choice();
      const error = this.workers.choose(ORCHESTRATOR_ID, model, effort);
      if (error) {
        this.settings = before;
        return error;
      }
    }
    try {
      writeFileSync(this.file, `${JSON.stringify(saved)}\n`, { mode: 0o600 });
    } catch {
      // it still applies until the office restarts
    }
    if (!saved.on) {
      this.restartAtRest = false;
      this.workers.halt(ORCHESTRATOR_ID);
    } else if (!before.on && this.info && !this.running()) this.workers.resume(ORCHESTRATOR_ID);
    else if (chosen && this.running()) {
      this.restartAtRest = true;
      this.restartIfRested();
    }
    this.opts.changed();
    return undefined;
  }

  state(): OrchestratorState {
    const info = this.info;
    const blocked = this.settings.on ? this.blocked() : undefined;
    const team = missionTeam(this.opts.floors(), ORCHESTRATOR_ID);
    return {
      settings: { ...this.settings },
      ...(info ? { agent: { worker: info, team } } : {}),
      team,
      ...(blocked ? { blocked } : {}),
    };
  }

  private updated(w: WorkerInfo) {
    const was = this.lastStatus;
    this.lastStatus = w.status;
    const rested = (w.status === 'done' || w.status === 'idle') && was !== w.status && was !== 'done' && was !== 'idle';
    if (rested) {
      // A floor wakes a lead of its own when it comes to rest; it has to be told this one did.
      for (const f of this.opts.floors()) f.team.leadRested(ORCHESTRATOR_ID);
      this.restartIfRested();
    }
    this.opts.changed();
  }

  private restartIfRested() {
    const info = this.info;
    if (!this.restartAtRest || !info || (info.status !== 'done' && info.status !== 'idle')) return;
    this.restartAtRest = false;
    this.workers.halt(ORCHESTRATOR_ID);
    this.workers.resume(ORCHESTRATOR_ID);
  }
}

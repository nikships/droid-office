import { createHash } from 'node:crypto';
import {
  emptyFloorVibes,
  emptyGeminiState,
  FLOOR_EVENT_CONFIDENCE_MIN,
  FLOOR_EVENT_COOLDOWN_MS,
  type FloorEvent,
  type FloorMood,
  type FloorVibesState,
  type GeminiConnectionState,
  isFloorEvent,
  isFloorMood,
  isMonitorSpillTone,
  isValidGeminiApiKey,
  isWorkerMicroReaction,
  isWorkerVibePosture,
  emptyWakeFilterTelemetry,
  MICRO_REACTION_CONFIDENCE_MIN,
  MICRO_REACTION_COOLDOWN_MS,
  MOOD_CONFIDENCE_MIN,
  type MonitorSpillTone,
  POSTURE_CONFIDENCE_MIN,
  SPILL_CONFIDENCE_MIN,
  type TriggeredFloorEvent,
  type TriggeredMicroReaction,
  unitFromScore,
  type WakeFilterTelemetry,
  type WorkerMicroReaction,
  type WorkerVibePosture,
  type WorkerVibeState,
} from '../shared/gemini-vibes.js';
import type { PipelinesState } from '../shared/pipelines.js';
import type { GhPull, ServerMsg, WorkerInfo } from '../shared/protocol.js';
import { ROOF } from '../shared/rooftop.js';
import { AIRGAPPED_REASON } from '../shared/setup.js';
import { isBusy } from '../shared/status.js';
import { callGeminiDecisions, type DecisionAnswer, type DecisionQuestion, type FetchLike, type GeminiDecisionsStore, probeGeminiKey, redactGeminiSecrets } from './gemini-decisions.js';

const DEFAULT_PULSE_MS = 3500;
const QUICK_PULSE_MS = 180;
const RECENT_DONE_WINDOW_MS = 45_000;
const MAX_VIBES_WORKERS = 16;
const TAIL_LINES = 14;
const MAX_TAIL_CHARS = 900;
const RETRY_INITIAL_MS = 10_000;
const RETRY_MAX_MS = 60_000;
/** How long a fired reaction or floor event keeps riding along in later snapshots, so a viewer arriving mid-moment still sees it. */
const REACTION_GRACE_MS = 4500;
const EVENT_GRACE_MS = 6000;

export interface VibesClientView {
  id: string;
  floor: string | null;
  dashboard: boolean;
}

export interface VibesFloorView {
  id: string;
  name: string;
  workers: WorkerInfo[];
  pulls: GhPull[];
  pipelines?: PipelinesState;
  tail(workerId: string, lines: number): string | undefined;
}

export interface OfficeVibesOptions {
  store: GeminiDecisionsStore;
  airgapped: () => boolean;
  clients: () => Iterable<VibesClientView>;
  floors: () => Iterable<VibesFloorView>;
  floor: (id: string) => VibesFloorView | undefined;
  broadcastGemini: (state: GeminiConnectionState) => void;
  /** Inter-agent noise gate counters shown beside the Living 3D telemetry. */
  wakeTelemetry?: () => WakeFilterTelemetry;
  emitFloorVibes: (floorId: string, state: FloorVibesState) => void;
  fetchImpl?: FetchLike;
  pulseMs?: number;
  quickPulseMs?: number;
  now?: () => number;
}

interface WorkerTrack {
  lastReactionAt: number;
  lastReactDigest: string;
  lastReaction?: TriggeredMicroReaction;
}

interface FloorTrack {
  lastDigest: string;
  retryAt: number;
  retryDelay: number;
  state: FloorVibesState;
  workers: Map<string, WorkerTrack>;
  lastEventAt: number;
  lastEventDigest: string;
  lastEvent?: TriggeredFloorEvent;
}

/** Drops carried moments so a neutral snapshot cannot replay them; cooldowns stay so they cannot refire at once. */
function clearCarriedMoments(track: FloorTrack): void {
  track.lastEvent = undefined;
  for (const w of track.workers.values()) w.lastReaction = undefined;
}

/**
 * Every question below asks for a judgment a regex, exit code, tool name or status field cannot
 * make: what the output means for the worker's task. Facts the office already knows (a pull request
 * opened, a worker hired, finished, sent home or shot) play as Living 3D desk moments without Gemini.
 */
const JUDGE_MEANING = 'Judge what the output means for its task and plan, not keywords: errors it expected, wrote on purpose or is calmly working through are not trouble, and a green run of unrelated checks is not progress.';

const MOOD_CRITERIA: Record<FloorMood, string> = {
  calm_planning: 'Nobody is under pressure: workers are reading, designing or tidying, and nothing important is in doubt.',
  deep_crunch: "Heads-down progress: workers are confidently executing clear plans and the floor's work is converging.",
  debugging_tension: 'Things are going wrong in ways the workers have not figured out yet: they are struggling, contradicting their own assumptions or going in circles.',
  celebration_swell: 'The floor just achieved something that matters for its tasks: a hard problem cracked, or a goal genuinely met.',
};

const POSTURE_CRITERIA: Record<WorkerVibePosture, string> = {
  flow: 'Knows exactly what it is doing: each step follows its plan and lands the way it intended.',
  investigating: "Doesn't know the answer yet: forming, testing or ruling out hypotheses, with reasoning that hedges.",
  struggling: 'Its approach is not working and it has not understood why: backtracking, contradicting earlier assumptions or patching symptoms.',
  deliberating: 'Weighing trade-offs or choosing between approaches before acting, or asking the owner a genuine judgment call (not routine permission).',
  steady: 'Routine mechanical work with no particular weight, or no clear read of its state of mind.',
};

const SPILL_CRITERIA: Record<MonitorSpillTone, string> = {
  neutral: 'Too early to tell, or nothing about its task is in doubt right now.',
  emerald: "On track: its latest results move it toward its task's goal, including a failure it expected, such as a new test written to fail before the fix.",
  amber: 'Drifting: effort is going into work unrelated to its task, or it keeps changing things without converging.',
  crimson: 'In trouble: its latest results undercut its plan, it has caused a regression, or it has misread a problem and is heading the wrong way.',
};

const REACTION_CRITERIA: Record<WorkerMicroReaction | 'none', string> = {
  eureka: 'Its reasoning just went from guessing to a specific, convincing explanation of the problem (saying "found it" while still guessing does not count).',
  breakthrough: 'The result that was the point of its task just came through: the fix verified or the hard part working, not a routine green run.',
  setback: 'A new result invalidates its plan or undoes earlier progress (not an expected failure, a probe, or a test written to fail first).',
  puzzled: 'A result just contradicted what it expected, and it shows it does not understand why.',
  frustrated: 'Going in circles: retrying an approach that already failed without meaningfully changing it.',
  pivot: 'Deliberately abandoning its current approach for a different strategy.',
  rabbit_hole: 'Wandered off its task into unrelated work, tangents or yak-shaving.',
  corner_cut: 'Making checks pass the wrong way: skipping or disabling tests, loosening assertions, adding suppressions, hard-coding expected values or swallowing errors.',
  risky_move: 'Just did or is about to do something destructive or hard to undo: force-pushing, rewriting history, deleting data or many files, or touching production.',
  none: 'No such moment in this snapshot.',
};

const FLOOR_EVENT_CRITERIA: Record<FloorEvent | 'none', string> = {
  convergence: "Separate desks' pieces are visibly fitting together toward one shared goal right now.",
  collision: 'Two or more desks are working at cross purposes: changing the same area, undoing each other, or taking contradictory approaches to one problem.',
  crisis: 'One problem is spreading across desks or blocking several workers, and nobody has a handle on it yet.',
  brainstorm: 'Workers are genuinely exchanging ideas or debating a design with each other, beyond routine status messages.',
  none: 'Desks are working on their own, or only one desk has anything notable.',
};

const FLOOR_STAKES_RUBRIC = [
  'Relaxed: nothing important is in doubt anywhere on the floor.',
  'Low: routine work, and any problems are small and understood.',
  'Engaged: meaningful work is underway and some outcomes are still uncertain.',
  'Tense: important work is at risk, workers are struggling, or a key result is about to land.',
  'Critical: a serious problem is unfolding, or a risky high-impact operation is in progress.',
];

const WORKER_STAKES_RUBRIC = [
  'Nothing riding on it: reading, chatting, or trivial edits such as comments, typos or formatting.',
  'Low: small, easily reverted changes in leaf code, tests or docs.',
  'Moderate: real feature or bug-fix work in code other parts depend on.',
  'High: shared core paths, data models, migrations, auth, payments or concurrency, or the fix the whole task hinges on.',
  'Critical: destructive or hard-to-undo operations, production or release actions, or a mistake here would be expensive.',
];

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function choiceProb(ans: DecisionAnswer | undefined, expectedChoice?: string): { choice: string; prob: number; confidence: number } | null {
  if (ans?.type !== 'choice') return null;
  const choice = expectedChoice ?? ans.choice;
  const prob = ans.probabilities[choice] ?? (choice === ans.choice ? ans.confidence : 0);
  return { choice: ans.choice, prob, confidence: ans.confidence };
}

function eligibleWorker(w: WorkerInfo, now: number): boolean {
  if (w.kind !== 'agent' || w.remote) return false;
  if (w.status === 'working' || w.status === 'starting' || w.status === 'needs_input') return true;
  if (w.status === 'done' && w.waitingSince !== undefined && now - w.waitingSince <= RECENT_DONE_WINDOW_MS) return true;
  return false;
}

export interface BuiltFloorSnapshot {
  input: string;
  digest: string;
  workers: { worker: WorkerInfo; keyPrefix: string; workerDigest: string }[];
  questions: Record<string, DecisionQuestion>;
}

/** Builds one scrubbed single-snapshot floor input and batched independent question map for `gemini-decision-1`. */
export function buildFloorDecisionsBatch(floor: VibesFloorView, activeWorkers: WorkerInfo[], extraSecrets: readonly (string | undefined)[] = []): BuiltFloorSnapshot {
  const openPulls = floor.pulls.filter((p) => p.state === 'OPEN').length;
  const mergedPulls = floor.pulls.filter((p) => p.state === 'MERGED').length;
  const failingRuns = floor.pipelines?.runs.filter((r) => r.state === 'failure').length ?? 0;

  const floorName = redactGeminiSecrets(floor.name, extraSecrets);
  const lines: string[] = [
    `Floor "${floorName}" snapshot:`,
    `Summary: ${activeWorkers.length} active/recent desk workers (${Math.min(activeWorkers.length, MAX_VIBES_WORKERS)} shown, ${Math.max(0, activeWorkers.length - MAX_VIBES_WORKERS)} omitted), ${openPulls} open PRs, ${mergedPulls} merged PRs, ${failingRuns} failing CI runs.`,
    '',
  ];

  const questions: Record<string, DecisionQuestion> = {
    floor_mood: {
      type: 'choice',
      instructions: `For floor "${floorName}", classify the emotional story of the floor right now from this snapshot. ${JUDGE_MEANING}`,
      criteria: MOOD_CRITERIA,
    },
    floor_stakes: {
      type: 'score',
      instructions: `For floor "${floorName}", score how much is riding on the floor's work right now, judged from what the workers are doing and what could go wrong, not from how much output scrolls by.`,
      criteria: FLOOR_STAKES_RUBRIC,
    },
    floor_event: {
      type: 'choice',
      instructions: `For floor "${floorName}", compare the desks' tasks and output with each other and decide whether their efforts relate in one of these ways right now, or choose "none".`,
      criteria: FLOOR_EVENT_CRITERIA,
    },
  };

  const trackedWorkers: { worker: WorkerInfo; keyPrefix: string; workerDigest: string }[] = [];

  activeWorkers.slice(0, MAX_VIBES_WORKERS).forEach((w, i) => {
    const keyPrefix = `w${i}`;
    const safeName = redactGeminiSecrets(w.name, extraSecrets);
    const activity = w.activity ? redactGeminiSecrets(w.activity, extraSecrets).slice(0, 220) : 'none';
    const taskLine = w.task ? redactGeminiSecrets(`${w.task.name}: ${w.task.summary}`, extraSecrets).slice(0, 240) : 'none';
    const rawTail = floor.tail(w.id, TAIL_LINES) ?? '';
    const safeTail = redactGeminiSecrets(rawTail, extraSecrets).trim().slice(-MAX_TAIL_CHARS);
    const askDesc = w.ask ? w.ask.kind : 'none';
    const prDesc = w.pr ? `#${w.pr.number}` : 'none';

    const workerBlock = [
      `[${keyPrefix}] Worker "${safeName}" (id=${w.id}, desk=${w.deskId}):`,
      `  status=${w.status} | latest_tool=${w.action ?? 'none'} | pending_ask=${askDesc} | pr=${prDesc}`,
      `  task=${taskLine}`,
      `  activity=${activity}`,
      `  visible_terminal_tail:`,
      safeTail
        ? safeTail
            .split('\n')
            .map((l) => `    ${l}`)
            .join('\n')
        : '    (empty)',
    ].join('\n');

    lines.push(workerBlock, '');
    const workerDigest = sha256(workerBlock);
    trackedWorkers.push({ worker: w, keyPrefix, workerDigest });

    questions[`${keyPrefix}_posture`] = {
      type: 'choice',
      instructions: `For worker [${keyPrefix}] ("${safeName}"), choose the state of mind [${keyPrefix}]'s reasoning and results show right now, read against its task (its latest tool alone does not decide this).`,
      criteria: POSTURE_CRITERIA,
    };
    questions[`${keyPrefix}_spill`] = {
      type: 'choice',
      instructions: `For worker [${keyPrefix}] ("${safeName}"), judge how it is going for [${keyPrefix}] against its task right now. ${JUDGE_MEANING}`,
      criteria: SPILL_CRITERIA,
    };
    questions[`${keyPrefix}_react`] = {
      type: 'choice',
      instructions: `For worker [${keyPrefix}] ("${safeName}"), decide whether [${keyPrefix}]'s snapshot shows one of these moments happening right now, or choose "none". ${JUDGE_MEANING}`,
      criteria: REACTION_CRITERIA,
    };
    questions[`${keyPrefix}_stakes`] = {
      type: 'score',
      instructions: `For worker [${keyPrefix}] ("${safeName}"), score how much is riding on what [${keyPrefix}] is doing right now: the blast radius if it goes wrong, not how busy it looks.`,
      criteria: WORKER_STAKES_RUBRIC,
    };
  });

  const input = lines.join('\n').trim();
  return {
    input,
    digest: sha256(input),
    workers: trackedWorkers,
    questions,
  };
}

/**
 * Coordinates Gemini Decision 1 connectivity and the strictly view-gated Floor 3D Vibes pulse.
 * Zero timers and zero API requests run unless at least one visible 3D floor client is watching.
 */
export class OfficeVibes {
  private readonly watching = new Set<string>();
  private readonly floorTracks = new Map<string, FloorTrack>();
  private readonly inFlight = new Map<string, AbortController>();
  private probeAbort?: AbortController;
  private timer?: NodeJS.Timeout;
  private quickTimer?: NodeJS.Timeout;
  private stopped = false;
  private checking = false;
  private reactionSeq = 0;
  private eventSeq = 0;
  private calls = 0;
  private inputTokens = 0;
  private lastLatencyMs?: number;
  private lastPulseAt?: number;
  private lastError?: string;

  constructor(private readonly opts: OfficeVibesOptions) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** Current connection & telemetry snapshot safe for every client. */
  geminiState(): GeminiConnectionState {
    if (this.opts.airgapped()) {
      return {
        ...emptyGeminiState(),
        vibesOn: this.opts.store.vibesOn(),
        wakeFilterOn: this.opts.store.wakeFilterOn(),
      };
    }
    const { totalViewers } = this.watchedFloorMap();
    return {
      connected: this.opts.store.connected(),
      vibesOn: this.opts.store.vibesOn(),
      wakeFilterOn: this.opts.store.wakeFilterOn(),
      wakeFilter: this.opts.wakeTelemetry?.() ?? emptyWakeFilterTelemetry(),
      ...(this.opts.store.fingerprint() ? { fingerprint: this.opts.store.fingerprint() } : {}),
      ...(this.opts.store.at() !== undefined ? { at: this.opts.store.at() } : {}),
      ...(this.opts.store.checkedAt() !== undefined ? { checkedAt: this.opts.store.checkedAt() } : {}),
      ...(this.checking ? { checking: true } : {}),
      ...(this.opts.store.rejected() ? { rejected: this.opts.store.rejected() } : {}),
      watching3d: totalViewers,
      calls: this.calls,
      inputTokens: this.inputTokens,
      ...(this.lastLatencyMs !== undefined ? { lastLatencyMs: this.lastLatencyMs } : {}),
      ...(this.lastPulseAt !== undefined ? { lastPulseAt: this.lastPulseAt } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  /** Latest cached vibes state for `floorId` (included in `welcome` and `floor.enter`). */
  floorState(floorId: string | null): FloorVibesState | undefined {
    if (!floorId || floorId === ROOF) return undefined;
    return this.floorTracks.get(floorId)?.state ?? emptyFloorVibes(floorId, this.now());
  }

  /** Updates whether a 3D client tab is actively visible and standing on an indoor floor. */
  setWatching(clientId: string, active: boolean): void {
    const changed = active ? !this.watching.has(clientId) : this.watching.delete(clientId);
    if (active) this.watching.add(clientId);
    if (!changed) return;
    this.reconcileSchedule(active);
    this.opts.broadcastGemini(this.geminiState());
  }

  /** Drops a disconnected client immediately so closing the 3D window stops API calls at once. */
  dropClient(clientId: string): void {
    if (!this.watching.delete(clientId)) return;
    this.reconcileSchedule(false);
    this.opts.broadcastGemini(this.geminiState());
  }

  /** Called when a client changes floors (e.g. rides to `@roof` or another project floor) or airgapped mode toggles. */
  syncViewers(triggerQuick = false): void {
    if (this.opts.airgapped()) {
      this.probeAbort?.abort();
      this.probeAbort = undefined;
      this.checking = false;
      this.resetAllFloorsToNeutral();
    }
    this.reconcileSchedule(triggerQuick);
    this.opts.broadcastGemini(this.geminiState());
  }

  /** Drops state for a removed floor. */
  dropFloor(floorId: string): void {
    this.inFlight.get(floorId)?.abort();
    this.inFlight.delete(floorId);
    this.floorTracks.delete(floorId);
    this.reconcileSchedule(false);
    this.opts.broadcastGemini(this.geminiState());
  }

  /** Connects and verifies a new Gemini API key. */
  async connect(rawKey: string, by: string, reply: (msg: Extract<ServerMsg, { t: 'gemini.setup' }>) => void): Promise<void> {
    if (this.opts.airgapped()) {
      reply({ t: 'gemini.setup', ok: false, error: AIRGAPPED_REASON });
      return;
    }
    const key = rawKey.trim();
    if (!key) {
      reply({ t: 'gemini.setup', ok: false, error: 'Enter a Gemini API key.' });
      return;
    }
    if (!isValidGeminiApiKey(key)) {
      reply({ t: 'gemini.setup', ok: false, error: 'Enter a valid Google AI Studio key (starts with AIza).' });
      return;
    }
    this.probeAbort?.abort();
    const abort = new AbortController();
    this.probeAbort = abort;
    this.checking = true;
    this.opts.broadcastGemini(this.geminiState());

    const probe = await probeGeminiKey(key, {
      fetchImpl: this.opts.fetchImpl,
      signal: abort.signal,
      now: this.opts.now,
    });
    if (this.probeAbort !== abort) {
      reply({ t: 'gemini.setup', ok: false, error: 'Cancelled.' });
      return;
    }
    this.probeAbort = undefined;
    this.checking = false;

    if (!probe.ok) {
      this.opts.broadcastGemini(this.geminiState());
      reply({ t: 'gemini.setup', ok: false, error: probe.error });
      return;
    }

    const saveErr = this.opts.store.saveKey(key, by, this.now());
    if (saveErr) {
      this.opts.broadcastGemini(this.geminiState());
      reply({ t: 'gemini.setup', ok: false, error: saveErr });
      return;
    }

    // A response from the previous key must never reject or overwrite the newly verified key.
    this.stopTimersAndInFlight();
    this.calls += 1;
    this.inputTokens += probe.inputTokens;
    this.lastLatencyMs = probe.latencyMs;
    this.lastError = undefined;
    // Force fresh floor digests so watched 3D floors light up immediately on connect.
    for (const track of this.floorTracks.values()) {
      track.lastDigest = '';
      track.retryAt = 0;
      track.retryDelay = 0;
    }
    this.reconcileSchedule(true);
    this.opts.broadcastGemini(this.geminiState());
    reply({ t: 'gemini.setup', ok: true, latencyMs: probe.latencyMs });
  }

  /** Re-verifies the stored Gemini API key ("Check again"). */
  async check(reply: (msg: Extract<ServerMsg, { t: 'gemini.setup' }>) => void): Promise<void> {
    if (this.opts.airgapped()) {
      reply({ t: 'gemini.setup', ok: false, error: AIRGAPPED_REASON });
      return;
    }
    const key = this.opts.store.apiKey();
    if (!key) {
      reply({ t: 'gemini.setup', ok: false, error: 'No Gemini API key is connected.' });
      return;
    }
    this.probeAbort?.abort();
    const abort = new AbortController();
    this.probeAbort = abort;
    this.checking = true;
    this.opts.broadcastGemini(this.geminiState());

    const probe = await probeGeminiKey(key, {
      fetchImpl: this.opts.fetchImpl,
      signal: abort.signal,
      now: this.opts.now,
    });
    if (this.probeAbort !== abort) {
      reply({ t: 'gemini.setup', ok: false, error: 'Cancelled.' });
      return;
    }
    this.probeAbort = undefined;
    this.checking = false;

    if (!probe.ok) {
      this.opts.store.markChecked(this.now(), probe.keyRejected ? probe.error : this.opts.store.rejected());
      this.lastError = probe.error;
      if (probe.keyRejected) this.resetAllFloorsToNeutral();
      this.reconcileSchedule(false);
      this.opts.broadcastGemini(this.geminiState());
      reply({ t: 'gemini.setup', ok: false, error: probe.error });
      return;
    }

    this.opts.store.markChecked(this.now(), undefined);
    this.calls += 1;
    this.inputTokens += probe.inputTokens;
    this.lastLatencyMs = probe.latencyMs;
    this.lastError = undefined;
    this.reconcileSchedule(true);
    this.opts.broadcastGemini(this.geminiState());
    reply({ t: 'gemini.setup', ok: true, latencyMs: probe.latencyMs });
  }

  disconnect(): string | undefined {
    this.probeAbort?.abort();
    this.probeAbort = undefined;
    this.checking = false;
    const err = this.opts.store.disconnect();
    if (err) return err;
    this.lastError = undefined;
    this.resetAllFloorsToNeutral();
    this.reconcileSchedule(false);
    this.opts.broadcastGemini(this.geminiState());
    return undefined;
  }

  setWakeFilterOn(on: boolean): string | undefined {
    const err = this.opts.store.setWakeFilterOn(on);
    if (err) return err;
    this.opts.broadcastGemini(this.geminiState());
    return undefined;
  }

  setVibesOn(on: boolean): string | undefined {
    const err = this.opts.store.setVibesOn(on);
    if (err) return err;
    if (!on) this.resetAllFloorsToNeutral();
    else for (const track of this.floorTracks.values()) track.lastDigest = '';
    this.reconcileSchedule(on);
    this.opts.broadcastGemini(this.geminiState());
    return undefined;
  }

  stop(): void {
    this.stopped = true;
    this.stopTimersAndInFlight();
    this.probeAbort?.abort();
    this.probeAbort = undefined;
  }

  /** Exposed for deterministic unit tests alongside timer ticks. */
  async pulseNow(): Promise<void> {
    if (this.stopped || !this.canPulse()) return;
    const { floors } = this.watchedFloorMap();
    if (!floors.size) return;
    await Promise.all(
      [...floors].map(async (floorId) => {
        try {
          await this.pulseFloor(floorId);
        } catch (error) {
          this.deferRetry(this.ensureTrack(floorId));
          this.lastError = redactGeminiSecrets(error instanceof Error ? error.message : 'Floor snapshot failed.', [this.opts.store.apiKey()]).slice(0, 220);
          // A failed broadcaster must not turn a timer tick into an unhandled rejection either.
          try {
            this.opts.broadcastGemini(this.geminiState());
          } catch {}
        }
      }),
    );
  }

  private watchedFloorMap(): { floors: Set<string>; totalViewers: number } {
    const floors = new Set<string>();
    let totalViewers = 0;
    for (const c of this.opts.clients()) {
      if (!this.watching.has(c.id)) continue;
      if (c.dashboard) continue;
      if (!c.floor || c.floor === ROOF) continue;
      if (!this.opts.floor(c.floor)) continue;
      floors.add(c.floor);
      totalViewers++;
    }
    return { floors, totalViewers };
  }

  private canPulse(): boolean {
    if (this.stopped || this.opts.airgapped()) return false;
    if (!this.opts.store.connected() || !this.opts.store.vibesOn() || this.opts.store.rejected()) return false;
    return true;
  }

  private reconcileSchedule(wantQuick: boolean): void {
    const { floors } = this.watchedFloorMap();
    // Abort in-flight calls on any floor no longer watched in 3D.
    for (const [floorId, ctrl] of this.inFlight) {
      if (!floors.has(floorId) || !this.canPulse()) {
        ctrl.abort();
        this.inFlight.delete(floorId);
      }
    }
    if (!this.canPulse() || floors.size === 0) {
      this.stopTimersAndInFlight();
      return;
    }
    const pulseMs = this.opts.pulseMs ?? DEFAULT_PULSE_MS;
    if (!this.timer) {
      this.timer = setInterval(() => void this.pulseNow(), pulseMs);
      this.timer.unref?.();
    }
    if (wantQuick && !this.quickTimer) {
      const quickMs = this.opts.quickPulseMs ?? QUICK_PULSE_MS;
      this.quickTimer = setTimeout(() => {
        this.quickTimer = undefined;
        void this.pulseNow();
      }, quickMs);
      this.quickTimer.unref?.();
    }
  }

  private stopTimersAndInFlight(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.quickTimer) {
      clearTimeout(this.quickTimer);
      this.quickTimer = undefined;
    }
    for (const ctrl of this.inFlight.values()) ctrl.abort();
    this.inFlight.clear();
  }

  private resetAllFloorsToNeutral(): void {
    const now = this.now();
    for (const floor of this.opts.floors()) {
      const neutral = emptyFloorVibes(floor.id, now);
      const track = this.floorTracks.get(floor.id);
      if (track) {
        track.lastDigest = '';
        track.retryAt = 0;
        track.retryDelay = 0;
        track.state = neutral;
        clearCarriedMoments(track);
      }
      this.opts.emitFloorVibes(floor.id, neutral);
    }
  }

  private ensureTrack(floorId: string): FloorTrack {
    let track = this.floorTracks.get(floorId);
    if (!track) {
      track = {
        lastDigest: '',
        retryAt: 0,
        retryDelay: 0,
        state: emptyFloorVibes(floorId, this.now()),
        workers: new Map(),
        lastEventAt: -Infinity,
        lastEventDigest: '',
      };
      this.floorTracks.set(floorId, track);
    }
    return track;
  }

  private deferRetry(track: FloorTrack): void {
    track.retryDelay = Math.min(RETRY_MAX_MS, track.retryDelay ? track.retryDelay * 2 : RETRY_INITIAL_MS);
    track.retryAt = this.now() + track.retryDelay;
  }

  private async pulseFloor(floorId: string): Promise<void> {
    if (this.inFlight.has(floorId) || !this.canPulse()) return;
    const floor = this.opts.floor(floorId);
    const apiKey = this.opts.store.apiKey();
    if (!floor || !apiKey) return;

    const now = this.now();
    const track = this.ensureTrack(floorId);
    if (now < track.retryAt) return;
    const active = floor.workers.filter((w) => eligibleWorker(w, now));

    // Prune departed workers from per-worker cooldown tracking.
    const presentIds = new Set(floor.workers.map((w) => w.id));
    for (const wid of track.workers.keys()) {
      if (!presentIds.has(wid)) track.workers.delete(wid);
    }

    if (active.length === 0) {
      if (track.state.mood !== 'calm_planning' || Object.keys(track.state.workers).length > 0) {
        track.lastDigest = 'empty';
        track.state = emptyFloorVibes(floorId, now);
        clearCarriedMoments(track);
        this.opts.emitFloorVibes(floorId, track.state);
      }
      return;
    }

    const batch = buildFloorDecisionsBatch(floor, active, [apiKey]);
    if (batch.digest === track.lastDigest) return;

    const ctrl = new AbortController();
    this.inFlight.set(floorId, ctrl);
    try {
      const res = await callGeminiDecisions({
        apiKey,
        input: batch.input,
        questions: batch.questions,
        fetchImpl: this.opts.fetchImpl,
        signal: ctrl.signal,
        now: this.opts.now,
      });
      if (ctrl.signal.aborted || !this.canPulse()) return;

      if (!res.ok) {
        this.deferRetry(track);
        this.lastError = res.error;
        if (res.keyRejected) {
          this.opts.store.markChecked(this.now(), res.error);
          this.resetAllFloorsToNeutral();
          this.reconcileSchedule(false);
        }
        this.opts.broadcastGemini(this.geminiState());
        return;
      }

      const doneAt = this.now();
      track.retryAt = 0;
      track.retryDelay = 0;
      this.calls += 1;
      this.inputTokens += res.inputTokens;
      this.lastLatencyMs = res.latencyMs;
      this.lastPulseAt = doneAt;
      this.lastError = res.blockedReason ? `Snapshot skipped (${res.blockedReason}).` : undefined;

      track.lastDigest = batch.digest;
      if (res.blockedReason) {
        this.opts.broadcastGemini(this.geminiState());
        return;
      }

      const moodAns = choiceProb(res.answers.floor_mood);
      const moodConfident = Boolean(moodAns && isFloorMood(moodAns.choice) && moodAns.prob >= MOOD_CONFIDENCE_MIN);
      const mood: FloorMood = moodConfident && moodAns ? (moodAns.choice as FloorMood) : 'calm_planning';
      const moodConfidence = moodConfident && moodAns ? moodAns.prob : 0;
      const floorStakesAns = res.answers.floor_stakes;
      const floorStakes = floorStakesAns?.type === 'score' ? unitFromScore(floorStakesAns.score, FLOOR_STAKES_RUBRIC.length - 1) : undefined;

      let event = track.lastEvent && doneAt - track.lastEvent.at <= EVENT_GRACE_MS ? track.lastEvent : undefined;
      const eAns = choiceProb(res.answers.floor_event);
      if (eAns && isFloorEvent(eAns.choice) && eAns.prob >= FLOOR_EVENT_CONFIDENCE_MIN && track.lastEventDigest !== batch.digest && doneAt - track.lastEventAt >= FLOOR_EVENT_COOLDOWN_MS) {
        this.eventSeq += 1;
        event = { kind: eAns.choice, seq: this.eventSeq, at: doneAt, confidence: Number(eAns.prob.toFixed(3)) };
        track.lastEventAt = doneAt;
        track.lastEventDigest = batch.digest;
        track.lastEvent = event;
      }

      const workersOut: Record<string, WorkerVibeState> = {};
      const currentFloor = this.opts.floor(floorId);
      for (const { worker, keyPrefix, workerDigest } of batch.workers) {
        const currentWorker = currentFloor?.workers.find((w) => w.id === worker.id);
        if (!currentWorker || !eligibleWorker(currentWorker, doneAt)) continue;

        const pAns = choiceProb(res.answers[`${keyPrefix}_posture`]);
        const sAns = choiceProb(res.answers[`${keyPrefix}_spill`]);
        const rAns = choiceProb(res.answers[`${keyPrefix}_react`]);
        const stakesAns = res.answers[`${keyPrefix}_stakes`];
        const stakes = stakesAns?.type === 'score' ? unitFromScore(stakesAns.score, WORKER_STAKES_RUBRIC.length - 1) : undefined;

        const posture: WorkerVibePosture = isBusy(currentWorker.status) && pAns && isWorkerVibePosture(pAns.choice) && pAns.prob >= POSTURE_CONFIDENCE_MIN ? pAns.choice : 'steady';

        const spill: MonitorSpillTone = sAns && isMonitorSpillTone(sAns.choice) && sAns.prob >= SPILL_CONFIDENCE_MIN ? sAns.choice : 'neutral';

        let wTrack = track.workers.get(currentWorker.id);
        if (!wTrack) {
          wTrack = { lastReactionAt: -Infinity, lastReactDigest: '' };
          track.workers.set(currentWorker.id, wTrack);
        }

        let reaction = wTrack.lastReaction && doneAt - wTrack.lastReaction.at <= REACTION_GRACE_MS ? wTrack.lastReaction : undefined;
        if (rAns && isWorkerMicroReaction(rAns.choice) && rAns.prob >= MICRO_REACTION_CONFIDENCE_MIN && wTrack.lastReactDigest !== workerDigest && doneAt - wTrack.lastReactionAt >= MICRO_REACTION_COOLDOWN_MS) {
          this.reactionSeq += 1;
          reaction = {
            kind: rAns.choice,
            seq: this.reactionSeq,
            at: doneAt,
            confidence: Number(rAns.prob.toFixed(3)),
          };
          wTrack.lastReactionAt = doneAt;
          wTrack.lastReactDigest = workerDigest;
          wTrack.lastReaction = reaction;
        }

        workersOut[currentWorker.id] = {
          posture,
          spill,
          ...(stakes !== undefined ? { stakes: Number(stakes.toFixed(3)) } : {}),
          ...(reaction ? { reaction } : {}),
        };
      }

      track.state = {
        floor: floorId,
        mood,
        moodConfidence: Number(moodConfidence.toFixed(3)),
        ...(floorStakes !== undefined ? { stakes: Number(floorStakes.toFixed(3)) } : {}),
        ...(event ? { event } : {}),
        workers: workersOut,
        updatedAt: doneAt,
      };
      this.opts.emitFloorVibes(floorId, track.state);
      this.opts.broadcastGemini(this.geminiState());
    } finally {
      if (this.inFlight.get(floorId) === ctrl) this.inFlight.delete(floorId);
    }
  }
}

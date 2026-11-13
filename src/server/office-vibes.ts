import { createHash } from 'node:crypto';
import {
  emptyFloorVibes,
  emptyGeminiState,
  type FloorMood,
  type FloorVibesState,
  type GeminiConnectionState,
  isFloorMood,
  isMonitorSpillTone,
  isWorkerMicroReaction,
  isWorkerVibePosture,
  MICRO_REACTION_CONFIDENCE_MIN,
  MICRO_REACTION_COOLDOWN_MS,
  MOOD_CONFIDENCE_MIN,
  type MonitorSpillTone,
  POSTURE_CONFIDENCE_MIN,
  SPILL_CONFIDENCE_MIN,
  type TriggeredMicroReaction,
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
  state: FloorVibesState;
  workers: Map<string, WorkerTrack>;
}

const MOOD_CRITERIA: Record<FloorMood, string> = {
  calm_planning: 'Quiet floor, planning, reading docs/specs, idle desks, or light low-urgency exploration with no active crunch or errors.',
  deep_crunch: 'Focused multi-file coding, brisk implementation, or active feature building across one or more desks without widespread breakage.',
  debugging_tension: 'Visible failing tests, compiler/type errors, stack traces, merge conflicts, or blocked debugging right now.',
  celebration_swell: 'Tests and checks just passed green, build succeeded cleanly, pull request opened or merged, or task completed cleanly.',
};

const POSTURE_CRITERIA: Record<WorkerVibePosture, string> = {
  flow: 'Actively writing or editing code/files, brisk implementation or refactoring in steady momentum.',
  investigating: 'Reading files, grepping/searching code, inspecting architecture, or reviewing specs/PRs thoughtfully.',
  debugging: 'Inspecting a test failure, compiler error, stack trace, or diagnosing broken output right now.',
  waiting: 'Waiting on a running build, test suite, package install, CI check, or user question/permission.',
  steady: 'Neutral seated posture when idle, finished, or when none of the more specific working postures clearly apply.',
};

const SPILL_CRITERIA: Record<MonitorSpillTone, string> = {
  neutral: 'Normal terminal editing, reading, searching, or neutral output with no fresh win or error.',
  emerald: 'Passing test suite, clean build/lint/typecheck success, PR opened/merged, or green completion visible right now.',
  amber: 'Warnings, lint notices, merge conflict markers, slow retry, or active investigation of a tricky trace.',
  crimson: 'Fresh command failure, failing test assertion, uncaught exception, or non-zero exit error visible right now.',
};

const REACTION_CRITERIA: Record<string, string> = {
  breakthrough: 'Unmistakable fresh win visible right now: test suite passed, build/typecheck succeeded cleanly, or PR just opened/merged.',
  fresh_breakage: 'Unmistakable fresh failure visible right now: test failed, build/compile broke, or command exited with an error.',
  puzzled: 'Unexpected merge conflict, confusing compiler mismatch, missing file/symbol error, or ambiguous blocker visible right now.',
  team_sync: 'Actively coordinating with a lead, subagent, or peer worker (team_report, team_hire, team_message, visit) right now.',
  none: 'Ordinary steady work, reading, editing, or no high-certainty moment requiring a special one-shot reaction.',
};

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

  const lines: string[] = [
    `Floor "${redactGeminiSecrets(floor.name, extraSecrets)}" snapshot:`,
    `Summary: ${activeWorkers.length} active/recent desk workers, ${openPulls} open PRs, ${mergedPulls} merged PRs, ${failingRuns} failing CI runs.`,
    '',
  ];

  const questions: Record<string, DecisionQuestion> = {
    floor_mood: {
      type: 'choice',
      instructions: `For floor "${redactGeminiSecrets(floor.name, extraSecrets)}", classify the overall studio lighting mood right now based strictly on this single snapshot.`,
      criteria: MOOD_CRITERIA,
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
      instructions: `For worker [${keyPrefix}] ("${safeName}"), choose the continuous 3D desk posture that best matches what [${keyPrefix}] is visibly doing right now.`,
      criteria: POSTURE_CRITERIA,
    };
    questions[`${keyPrefix}_spill`] = {
      type: 'choice',
      instructions: `For worker [${keyPrefix}] ("${safeName}"), choose the monitor bounce-light color cast onto [${keyPrefix}]'s desk based strictly on [${keyPrefix}]'s visible terminal output and status right now.`,
      criteria: SPILL_CRITERIA,
    };
    questions[`${keyPrefix}_react`] = {
      type: 'choice',
      instructions: `For worker [${keyPrefix}] ("${safeName}"), decide whether [${keyPrefix}]'s current snapshot shows an unmistakable right-now moment for a one-shot 3D micro-reaction, or choose "none".`,
      criteria: REACTION_CRITERIA,
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
      };
    }
    const { totalViewers } = this.watchedFloorMap();
    return {
      connected: this.opts.store.connected(),
      vibesOn: this.opts.store.vibesOn(),
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
    this.reconcileSchedule(triggerQuick);
    this.opts.broadcastGemini(this.geminiState());
  }

  /** Drops state for a removed floor. */
  dropFloor(floorId: string): void {
    this.inFlight.get(floorId)?.abort();
    this.inFlight.delete(floorId);
    this.floorTracks.delete(floorId);
    this.reconcileSchedule(false);
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
    if (this.probeAbort !== abort) return;
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

    this.calls += 1;
    this.inputTokens += probe.inputTokens;
    this.lastLatencyMs = probe.latencyMs;
    this.lastError = undefined;
    // Force fresh floor digests so watched 3D floors light up immediately on connect.
    for (const track of this.floorTracks.values()) track.lastDigest = '';
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
    if (this.probeAbort !== abort) return;
    this.probeAbort = undefined;
    this.checking = false;

    if (!probe.ok) {
      this.opts.store.markChecked(this.now(), probe.keyRejected ? probe.error : undefined);
      this.lastError = probe.error;
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
    await Promise.all([...floors].map((floorId) => this.pulseFloor(floorId)));
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
        track.state = neutral;
      }
      this.opts.emitFloorVibes(floor.id, neutral);
    }
  }

  private ensureTrack(floorId: string): FloorTrack {
    let track = this.floorTracks.get(floorId);
    if (!track) {
      track = {
        lastDigest: '',
        state: emptyFloorVibes(floorId, this.now()),
        workers: new Map(),
      };
      this.floorTracks.set(floorId, track);
    }
    return track;
  }

  private async pulseFloor(floorId: string): Promise<void> {
    if (this.inFlight.has(floorId) || !this.canPulse()) return;
    const floor = this.opts.floor(floorId);
    const apiKey = this.opts.store.apiKey();
    if (!floor || !apiKey) return;

    const now = this.now();
    const track = this.ensureTrack(floorId);
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
        if (res.status === 0 && res.error === 'Cancelled.') return;
        this.lastError = res.error;
        if (res.keyRejected) {
          this.opts.store.markChecked(this.now(), res.error);
          this.reconcileSchedule(false);
        }
        this.opts.broadcastGemini(this.geminiState());
        return;
      }

      const doneAt = this.now();
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
      const mood: FloorMood = moodAns && isFloorMood(moodAns.choice) && moodAns.prob >= MOOD_CONFIDENCE_MIN ? moodAns.choice : 'calm_planning';
      const moodConfidence = moodAns ? moodAns.prob : 1;

      const workersOut: Record<string, WorkerVibeState> = {};
      for (const { worker, keyPrefix, workerDigest } of batch.workers) {
        const currentWorker = floor.workers.find((w) => w.id === worker.id);
        if (!currentWorker) continue;

        const pAns = choiceProb(res.answers[`${keyPrefix}_posture`]);
        const sAns = choiceProb(res.answers[`${keyPrefix}_spill`]);
        const rAns = choiceProb(res.answers[`${keyPrefix}_react`]);

        const posture: WorkerVibePosture = isBusy(currentWorker.status) && pAns && isWorkerVibePosture(pAns.choice) && pAns.prob >= POSTURE_CONFIDENCE_MIN ? pAns.choice : 'steady';

        const spill: MonitorSpillTone = sAns && isMonitorSpillTone(sAns.choice) && sAns.prob >= SPILL_CONFIDENCE_MIN ? sAns.choice : 'neutral';

        let wTrack = track.workers.get(currentWorker.id);
        if (!wTrack) {
          wTrack = { lastReactionAt: -Infinity, lastReactDigest: '' };
          track.workers.set(currentWorker.id, wTrack);
        }

        let reaction = wTrack.lastReaction;
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
          ...(reaction ? { reaction } : {}),
        };
      }

      track.state = {
        floor: floorId,
        mood,
        moodConfidence: Number(moodConfidence.toFixed(3)),
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

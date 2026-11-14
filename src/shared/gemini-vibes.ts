// Pure ES2022 shared contract for Google Gemini Decision 1 (`gemini-decision-1`) and Living 3D Reactions & Mood Lighting.

export const GEMINI_DECISIONS_MODEL = 'gemini-decision-1';
export const GEMINI_AI_STUDIO_KEYS_URL = 'https://aistudio.google.com/apikey';

/**
 * Continuous desk postures smoothly blended while a worker is actively working: its state of mind,
 * read from its reasoning against its task (a tool name or exit code alone never decides one).
 */
export type WorkerVibePosture = 'flow' | 'investigating' | 'struggling' | 'deliberating' | 'steady';
export const WORKER_VIBE_POSTURES: readonly WorkerVibePosture[] = ['flow', 'investigating', 'struggling', 'deliberating', 'steady'];

export function isWorkerVibePosture(value: unknown): value is WorkerVibePosture {
  return (WORKER_VIBE_POSTURES as readonly unknown[]).includes(value);
}

/** High-confidence one-shot micro-reactions Gemini judges from what a worker's output means for its task. */
export type WorkerMicroReaction = 'eureka' | 'breakthrough' | 'setback' | 'puzzled' | 'frustrated' | 'pivot' | 'rabbit_hole' | 'corner_cut' | 'risky_move';
export const WORKER_MICRO_REACTIONS: readonly WorkerMicroReaction[] = ['eureka', 'breakthrough', 'setback', 'puzzled', 'frustrated', 'pivot', 'rabbit_hole', 'corner_cut', 'risky_move'];

export function isWorkerMicroReaction(value: unknown): value is WorkerMicroReaction {
  return (WORKER_MICRO_REACTIONS as readonly unknown[]).includes(value);
}

/** The badge icon, label, and color its sparks and beacon flash in for each micro-reaction. */
export const MICRO_REACTION_FX: Record<WorkerMicroReaction, { glyph: string; hex: string; label: string }> = {
  eureka: { glyph: '💡', hex: '#facc15', label: 'Eureka' },
  breakthrough: { glyph: '🏆', hex: '#34d399', label: 'Breakthrough' },
  setback: { glyph: '💥', hex: '#f43f5e', label: 'Setback' },
  puzzled: { glyph: '❓', hex: '#f59e0b', label: 'Puzzled' },
  frustrated: { glyph: '💢', hex: '#ef4444', label: 'Going in circles' },
  pivot: { glyph: '🔀', hex: '#38bdf8', label: 'Pivot' },
  rabbit_hole: { glyph: '🌀', hex: '#c084fc', label: 'Rabbit hole' },
  corner_cut: { glyph: '🩹', hex: '#fb923c', label: 'Cutting a corner' },
  risky_move: { glyph: '⚠️', hex: '#ff3b1f', label: 'Risky move' },
};

/**
 * Desk moments the office already knows for certain, so they play straight from worker updates with
 * no Gemini call: hired, finished, opened a pull request, sent home, or shot. Living 3D plays them
 * only while it is on.
 */
export type DeskMoment = 'hired' | 'finished' | 'shipped' | 'sent_home' | 'shot';
export const DESK_MOMENT_FX: Record<DeskMoment, { glyph: string; hex: string; label: string }> = {
  hired: { glyph: '👋', hex: '#7dd3fc', label: 'Hired' },
  finished: { glyph: '✅', hex: '#34d399', label: 'Finished' },
  shipped: { glyph: '🚀', hex: '#ff7a1a', label: 'Pull request opened' },
  sent_home: { glyph: '🏠', hex: '#a78bfa', label: 'Sent home' },
  shot: { glyph: '💀', hex: '#ff1f4b', label: 'Shot' },
};

/** One-shot room-wide moments Gemini judges across desks: how the workers' efforts relate to each other. */
export type FloorEvent = 'convergence' | 'collision' | 'crisis' | 'brainstorm';
export const FLOOR_EVENTS: readonly FloorEvent[] = ['convergence', 'collision', 'crisis', 'brainstorm'];

export function isFloorEvent(value: unknown): value is FloorEvent {
  return (FLOOR_EVENTS as readonly unknown[]).includes(value);
}

/**
 * The room flash color, how many times it pulses, and the emoji over the room for each floor event,
 * plus `ship_it`, played without Gemini when a worker on the floor opens a pull request.
 */
export const FLOOR_EVENT_FX: Record<FloorEvent | 'ship_it', { hex: string; pulses: number; glyph: string; label: string }> = {
  convergence: { hex: '#22c55e', pulses: 1, glyph: '🧩', label: 'Coming together' },
  collision: { hex: '#ff9f1c', pulses: 2, glyph: '⚔️', label: 'Collision' },
  crisis: { hex: '#ef4444', pulses: 2, glyph: '🚨', label: 'Crisis' },
  brainstorm: { hex: '#8b5cf6', pulses: 1, glyph: '🧠', label: 'Brainstorm' },
  ship_it: { hex: '#ffb020', pulses: 1, glyph: '🚀', label: 'Ship it' },
};

/**
 * Per-desk laptop bounce-light tint cast across the desk and worker: how it is going for that worker
 * (on track, drifting, in trouble), judged from meaning rather than from error text appearing.
 */
export type MonitorSpillTone = 'neutral' | 'emerald' | 'amber' | 'crimson';
export const MONITOR_SPILL_TONES: readonly MonitorSpillTone[] = ['neutral', 'emerald', 'amber', 'crimson'];

export function isMonitorSpillTone(value: unknown): value is MonitorSpillTone {
  return value === 'neutral' || value === 'emerald' || value === 'amber' || value === 'crimson';
}

/** Studio-wide atmospheric fill mood crossfaded across the viewed 3D floor. */
export type FloorMood = 'calm_planning' | 'deep_crunch' | 'debugging_tension' | 'celebration_swell';
export const FLOOR_MOODS: readonly FloorMood[] = ['calm_planning', 'deep_crunch', 'debugging_tension', 'celebration_swell'];

export function isFloorMood(value: unknown): value is FloorMood {
  return value === 'calm_planning' || value === 'deep_crunch' || value === 'debugging_tension' || value === 'celebration_swell';
}

/** Calibrated probability threshold required before firing a one-shot micro-reaction. */
export const MICRO_REACTION_CONFIDENCE_MIN = 0.6;
/** Minimum milliseconds between one-shot micro-reactions on the same worker so avatars never twitch. */
export const MICRO_REACTION_COOLDOWN_MS = 9_000;
/** Calibrated probability required before a room-wide floor event fires, and the gap between two on one floor. */
export const FLOOR_EVENT_CONFIDENCE_MIN = 0.6;
export const FLOOR_EVENT_COOLDOWN_MS = 20_000;
/** Minimum confidence required to adopt a non-steady posture or non-neutral spill. */
export const POSTURE_CONFIDENCE_MIN = 0.55;
export const SPILL_CONFIDENCE_MIN = 0.65;
export const MOOD_CONFIDENCE_MIN = 0.52;

/** Hex color for each desk laptop bounce-light spill tone. */
export const MONITOR_SPILL_HEX: Record<MonitorSpillTone, string> = {
  neutral: '#ee6018',
  emerald: '#16e09a',
  amber: '#fb9d1b',
  crimson: '#f43f5e',
};

/** How much brighter than a plain screen each spill tone throws its light across the desk and worker. */
export const MONITOR_SPILL_POWER: Record<MonitorSpillTone, number> = {
  neutral: 1,
  emerald: 1.65,
  amber: 1.55,
  crimson: 1.75,
};

/**
 * Studio fill tint, intensity multiplier, and a slow breathing pulse (amplitude as a fraction of the
 * fill, rate in Hz), scaled by the owner's Overhead lights slider and never altering GI bake keys.
 * `calm_planning` stays the baseline clear-night fill that Remastered bakes against.
 */
export const FLOOR_MOOD_LIGHTING: Record<FloorMood, { hex: string; fillScale: number; pulse: number; pulseHz: number; label: string }> = {
  calm_planning: { hex: '#383a46', fillScale: 1, pulse: 0, pulseHz: 0, label: 'Calm planning' },
  deep_crunch: { hex: '#283c6e', fillScale: 0.92, pulse: 0.08, pulseHz: 0.14, label: 'Deep crunch' },
  debugging_tension: { hex: '#5c2d2a', fillScale: 0.95, pulse: 0.12, pulseHz: 0.22, label: 'Debugging tension' },
  celebration_swell: { hex: '#694e26', fillScale: 1.18, pulse: 0.1, pulseHz: 0.26, label: 'Celebration swell' },
};

export interface TriggeredMicroReaction {
  kind: WorkerMicroReaction;
  /** Monotonic sequence counter per floor session so clients play each event at most once. */
  seq: number;
  at: number;
  confidence: number;
}

export interface WorkerVibeState {
  posture: WorkerVibePosture;
  spill: MonitorSpillTone;
  /** How much is riding on what it is doing, 0 (nothing) to 1 (critical): speeds its posture. */
  stakes?: number;
  reaction?: TriggeredMicroReaction;
}

export interface TriggeredFloorEvent {
  kind: FloorEvent;
  /** Monotonic per floor so clients play each event at most once. */
  seq: number;
  at: number;
  confidence: number;
}

export interface FloorVibesState {
  floor: string;
  mood: FloorMood;
  moodConfidence: number;
  /** How much is riding on the floor right now, 0 (relaxed) to 1 (critical): how hard the room's mood light breathes. */
  stakes?: number;
  event?: TriggeredFloorEvent;
  workers: Record<string, WorkerVibeState>;
  updatedAt: number;
}

/** Maps a Gemini Decisions `score` answer on a 0..`max` rubric to 0..1. */
export function unitFromScore(score: number | undefined, max = 4): number | undefined {
  if (typeof score !== 'number' || !Number.isFinite(score) || max <= 0) return undefined;
  return Math.max(0, Math.min(1, score / max));
}

/** How the inter-agent noise gate routes one message to a lead (docs/office-mcp.md#inter-agent-noise-gate). */
export type WakeTraffic = 'wake_immediately' | 'hold_for_batch' | 'record_silently' | 'block_and_coach';
export const WAKE_TRAFFIC: readonly WakeTraffic[] = ['wake_immediately', 'hold_for_batch', 'record_silently', 'block_and_coach'];

export function isWakeTraffic(value: unknown): value is WakeTraffic {
  return (WAKE_TRAFFIC as readonly unknown[]).includes(value);
}

/** Live noise gate counters since the office started. */
export interface WakeFilterTelemetry {
  /** Messages the gate routed (deterministic guardrails included; bypassed and failed-open calls are not). */
  evaluated: number;
  woken: number;
  held: number;
  silent: number;
  blocked: number;
  /** Mid-turn sibling notices a team_note skipped because the note did not concern that sibling. */
  siblingFiltered: number;
  /** Calls that failed or timed out and delivered as before. */
  failedOpen: number;
  /** Input tokens the noise gate spent, kept apart from the view-gated Living 3D usage readout. */
  inputTokens: number;
  lastLatencyMs?: number;
  lastAt?: number;
}

export function emptyWakeFilterTelemetry(): WakeFilterTelemetry {
  return { evaluated: 0, woken: 0, held: 0, silent: 0, blocked: 0, siblingFiltered: 0, failedOpen: 0, inputTokens: 0 };
}

export interface GeminiConnectionState {
  connected: boolean;
  /** Whether Living 3D Reactions & Mood Lighting runs while a 3D floor is open and visible. */
  vibesOn: boolean;
  /** Whether the inter-agent noise gate and smart lead wakeup filter routes team traffic. */
  wakeFilterOn: boolean;
  wakeFilter: WakeFilterTelemetry;
  fingerprint?: string;
  at?: number;
  checkedAt?: number;
  checking?: boolean;
  rejected?: string;
  /** Active visible 3D floor viewers right now. When 0, zero Gemini Decisions API calls run. */
  watching3d: number;
  calls: number;
  inputTokens: number;
  lastLatencyMs?: number;
  lastPulseAt?: number;
  lastError?: string;
}

/** Visual and interactive state of the in-world Living 3D pedestal switch beneath the ceiling glyph. */
export type VibesSwitchState = 'on' | 'off' | 'disconnected' | 'rejected' | 'airgapped';

/**
 * Resolves the honest in-world switch state from the shared Gemini connection and airgapped mode.
 * Never reports `on` or `off` when Gemini Decisions is disconnected, rejected or airgapped, even
 * though `vibesOn` defaults to `true` before a key is connected.
 */
export function resolveVibesSwitchState(gemini: Pick<GeminiConnectionState, 'connected' | 'vibesOn' | 'rejected'>, opts: { airgapped?: boolean } = {}): VibesSwitchState {
  if (opts.airgapped) return 'airgapped';
  if (!gemini.connected) return 'disconnected';
  if (gemini.rejected) return 'rejected';
  return gemini.vibesOn ? 'on' : 'off';
}

export interface VibesToggleReceipt {
  ok: boolean;
  error?: string;
}

export type VibesSwitchPressOutcome = { kind: 'open-settings'; state: 'disconnected' | 'rejected' | 'airgapped' } | { kind: 'offline' } | { kind: 'busy'; target: boolean } | { kind: 'request'; target: boolean; token: number };

export type VibesSwitchSettleOutcome = { kind: 'confirmed'; state: 'on' | 'off' } | { kind: 'unconfirmed'; state: VibesSwitchState; error?: string } | { kind: 'stale' };

/**
 * Coordinates in-world Living 3D pedestal presses against async `gemini.vibes` server receipts:
 * - Absorbs repeated rapid presses while an action receipt is already in flight.
 * - Confirms `on` / `off` feedback and toasts only after the server acknowledges the change and the
 *   authoritative connection state matches the requested toggle.
 */
export class VibesSwitchToggle {
  private seq = 0;
  private inflight: { token: number; target: boolean } | null = null;

  get pendingTarget(): boolean | null {
    return this.inflight ? this.inflight.target : null;
  }

  press(gemini: Pick<GeminiConnectionState, 'connected' | 'vibesOn' | 'rejected'>, opts: { airgapped?: boolean; netUp: boolean }): VibesSwitchPressOutcome {
    const state = resolveVibesSwitchState(gemini, { airgapped: opts.airgapped });
    if (state === 'disconnected' || state === 'rejected' || state === 'airgapped') {
      return { kind: 'open-settings', state };
    }
    if (!opts.netUp) {
      return { kind: 'offline' };
    }
    if (this.inflight) {
      return { kind: 'busy', target: this.inflight.target };
    }
    const target = state !== 'on';
    const token = ++this.seq;
    this.inflight = { token, target };
    return { kind: 'request', target, token };
  }

  settle(token: number, receipt: VibesToggleReceipt, gemini: Pick<GeminiConnectionState, 'connected' | 'vibesOn' | 'rejected'>, opts: { airgapped?: boolean } = {}): VibesSwitchSettleOutcome {
    if (!this.inflight || this.inflight.token !== token) return { kind: 'stale' };
    const want = this.inflight.target;
    this.inflight = null;
    const state = resolveVibesSwitchState(gemini, opts);
    if (!receipt.ok) {
      return { kind: 'unconfirmed', state, error: receipt.error };
    }
    const expected: VibesSwitchState = want ? 'on' : 'off';
    if (state === expected) {
      return { kind: 'confirmed', state: expected };
    }
    return { kind: 'unconfirmed', state };
  }

  reset(): void {
    this.inflight = null;
  }
}

export function emptyGeminiState(): GeminiConnectionState {
  return {
    connected: false,
    vibesOn: true,
    wakeFilterOn: true,
    wakeFilter: emptyWakeFilterTelemetry(),
    watching3d: 0,
    calls: 0,
    inputTokens: 0,
  };
}

export function emptyFloorVibes(floor: string, now = 0): FloorVibesState {
  return {
    floor,
    mood: 'calm_planning',
    moodConfidence: 1,
    workers: {},
    updatedAt: now,
  };
}

/** Basic format check for a user-supplied Gemini API key (no whitespace or control chars, reasonable length). */
export function isValidGeminiApiKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.length >= 16 && trimmed.length <= 512 && !/[\s\p{Cc}\p{Cf}]/u.test(trimmed);
}

/** Safe display fingerprint (e.g. `AIza…x9Qp`) without exposing the secret key. */
export function fingerprintGeminiKey(key: string): string {
  const k = key.trim();
  if (k.length <= 10) return '••••';
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

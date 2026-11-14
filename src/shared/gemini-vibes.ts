// Pure ES2022 shared contract for Google Gemini Decision 1 (`gemini-decision-1`) and Living 3D Reactions & Mood Lighting.

export const GEMINI_DECISIONS_MODEL = 'gemini-decision-1';
export const GEMINI_AI_STUDIO_KEYS_URL = 'https://aistudio.google.com/apikey';

/** Continuous desk postures smoothly blended while a worker is actively working. */
export type WorkerVibePosture = 'flow' | 'investigating' | 'debugging' | 'waiting' | 'steady';
export const WORKER_VIBE_POSTURES: readonly WorkerVibePosture[] = ['flow', 'investigating', 'debugging', 'waiting', 'steady'];

export function isWorkerVibePosture(value: unknown): value is WorkerVibePosture {
  return value === 'flow' || value === 'investigating' || value === 'debugging' || value === 'waiting' || value === 'steady';
}

/** High-confidence one-shot micro-reactions triggered on unmistakable visible snapshots. */
export type WorkerMicroReaction = 'breakthrough' | 'fresh_breakage' | 'puzzled' | 'team_sync';
export const WORKER_MICRO_REACTIONS: readonly WorkerMicroReaction[] = ['breakthrough', 'fresh_breakage', 'puzzled', 'team_sync'];

export function isWorkerMicroReaction(value: unknown): value is WorkerMicroReaction {
  return value === 'breakthrough' || value === 'fresh_breakage' || value === 'puzzled' || value === 'team_sync';
}

/** Per-desk laptop bounce-light tint cast across the desk and worker. */
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
export const MICRO_REACTION_CONFIDENCE_MIN = 0.85;
/** Minimum milliseconds between one-shot micro-reactions on the same worker so avatars never twitch. */
export const MICRO_REACTION_COOLDOWN_MS = 18_000;
/** Minimum confidence required to adopt a non-steady posture or non-neutral spill. */
export const POSTURE_CONFIDENCE_MIN = 0.55;
export const SPILL_CONFIDENCE_MIN = 0.65;
export const MOOD_CONFIDENCE_MIN = 0.52;

/** Hex color for each desk laptop bounce-light spill tone. */
export const MONITOR_SPILL_HEX: Record<MonitorSpillTone, string> = {
  neutral: '#ee6018',
  emerald: '#2dd4a8',
  amber: '#f59e0b',
  crimson: '#f43f5e',
};

/** Studio fill tint and intensity multiplier (scaled by the owner's Overhead lights slider, never altering GI bake keys). */
export const FLOOR_MOOD_LIGHTING: Record<FloorMood, { hex: string; fillScale: number; label: string }> = {
  calm_planning: { hex: '#383a46', fillScale: 1, label: 'Calm planning' },
  deep_crunch: { hex: '#2c344d', fillScale: 0.82, label: 'Deep crunch' },
  debugging_tension: { hex: '#483633', fillScale: 0.92, label: 'Debugging tension' },
  celebration_swell: { hex: '#4f4130', fillScale: 1.22, label: 'Celebration swell' },
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
  reaction?: TriggeredMicroReaction;
}

export interface FloorVibesState {
  floor: string;
  mood: FloorMood;
  moodConfidence: number;
  workers: Record<string, WorkerVibeState>;
  updatedAt: number;
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

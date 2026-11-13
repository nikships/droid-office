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

export interface GeminiConnectionState {
  connected: boolean;
  /** Whether Living 3D Reactions & Mood Lighting runs while a 3D floor is open and visible. */
  vibesOn: boolean;
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

export function emptyGeminiState(): GeminiConnectionState {
  return {
    connected: false,
    vibesOn: true,
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

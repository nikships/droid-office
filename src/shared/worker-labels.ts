/** Separate from worker effort pins: the sign writer can use a model's non-thinking modes. */
export const LABEL_EFFORTS = ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type LabelEffort = (typeof LABEL_EFFORTS)[number];

export interface WorkerLabelSettings {
  on: boolean;
  /** Omitted in older preferences: the isolated Droid implementation. */
  implementation?: 'droid' | 'custom';
  /** Absolute executable and literal arguments, never a shell command. */
  command?: string;
  args?: string[];
  model: string;
  effort: LabelEffort;
  intervalSeconds: number;
}

/** One request on stdin, followed by EOF. Respond with {"name":string,"summary":string}. */
export interface WorkerLabelRequest {
  version: 1;
  system: string;
  conversation: string;
  previousSubject?: string;
  model: string;
  effort: LabelEffort;
}

export interface WorkerLabelState {
  settings: WorkerLabelSettings;
  running: number;
  queued: number;
  error?: string;
  updatedAt?: number;
}

export const WORKER_LABEL_DEFAULTS: WorkerLabelSettings = { on: true, model: 'glm-5.3-flash', effort: 'low', intervalSeconds: 60 };
export const LABEL_TEXT_CHARS = 24_000;
export const isLabelEffort = (value: unknown): value is LabelEffort => LABEL_EFFORTS.includes(value as LabelEffort);

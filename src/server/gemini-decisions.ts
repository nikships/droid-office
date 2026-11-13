import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fingerprintGeminiKey, GEMINI_DECISIONS_MODEL, isValidGeminiApiKey } from '../shared/gemini-vibes.js';

export const GEMINI_DECISIONS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/decisions';
const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const ERROR_MAX = 220;
const QUESTION_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;

export type DecisionQuestion =
  | {
      type: 'noul';
      instructions: string;
      criteria?: { true_description: string; false_description: string };
    }
  | {
      type: 'choice';
      instructions: string;
      criteria: Record<string, string>;
    }
  | {
      type: 'score';
      instructions: string;
      criteria: string[];
    };

export type DecisionAnswer =
  | { type: 'noul'; noul: number; confidence: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number };

export interface GeminiDecisionResult {
  ok: true;
  answers: Record<string, DecisionAnswer>;
  blockedReason?: string;
  inputTokens: number;
  latencyMs: number;
}

export interface GeminiDecisionFailure {
  ok: false;
  status: number;
  error: string;
  keyRejected?: boolean;
}

export type GeminiDecisionResponse = GeminiDecisionResult | GeminiDecisionFailure;

export type FetchLike = typeof fetch;

/** Scrubs API keys, bearer headers, and common secret tokens from snapshots, logs, and errors. */
export function redactGeminiSecrets(text: string, extraSecrets: readonly (string | undefined)[] = []): string {
  const variants = [...new Set(extraSecrets.flatMap((s) => (s ? [s, encodeURIComponent(s)] : [])))].sort((a, b) => b.length - a.length);
  const pattern = variants.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  let out = pattern ? text.replace(new RegExp(pattern, 'g'), '[redacted]') : text;
  out = out.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
  out = out.replace(/(x-goog-api-key\s*[:=]\s*)\S+/gi, '$1[redacted]');
  out = out.replace(/\bAIza[A-Za-z0-9_-]{16,}(?![A-Za-z0-9_-])/g, '[redacted]');
  out = out.replace(/\b(?:fk|sk|rk)-[A-Za-z0-9_-]{16,}(?![A-Za-z0-9_-])/g, '[redacted]');
  out = out.replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{16,}(?![A-Za-z0-9_])/g, '[redacted]');
  out = out.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}(?![A-Za-z0-9_])/g, '[redacted]');
  out = out.replace(/\bglpat-[A-Za-z0-9_-]{16,}(?![A-Za-z0-9_-])/g, '[redacted]');
  out = out.replace(/\blin_api_[A-Za-z0-9_-]{16,}(?![A-Za-z0-9_-])/g, '[redacted]');
  out = out.replace(/\bcrsr_[A-Za-z0-9_-]{12,}(?![A-Za-z0-9_-])/g, '[redacted]');
  return out;
}

function cleanError(text: string, apiKey?: string): string {
  return redactGeminiSecrets(text, [apiKey]).replace(/\s+/g, ' ').trim().slice(0, ERROR_MAX);
}

async function readBoundedText(res: Response, maxBytes: number): Promise<string> {
  const contentLength = Number(res.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error('Gemini response exceeded size limit.');
  }
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('Gemini response exceeded size limit.');
    return text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new Error('Gemini response exceeded size limit.');
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseAnswer(raw: unknown): DecisionAnswer | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  const confidence = typeof a.confidence === 'number' && Number.isFinite(a.confidence) ? Math.max(0, Math.min(1, a.confidence)) : 0;
  if (a.type === 'noul' && typeof a.noul === 'number' && Number.isFinite(a.noul)) {
    return { type: 'noul', noul: Math.max(0, Math.min(1, a.noul)), confidence };
  }
  if (a.type === 'choice' && typeof a.choice === 'string') {
    const probs: Record<string, number> = {};
    if (a.probabilities && typeof a.probabilities === 'object') {
      for (const [k, v] of Object.entries(a.probabilities as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isFinite(v)) probs[k] = Math.max(0, Math.min(1, v));
      }
    }
    return { type: 'choice', choice: a.choice, probabilities: probs, confidence };
  }
  if (a.type === 'score' && typeof a.score === 'number' && Number.isFinite(a.score)) {
    const probs: Record<string, number> = {};
    if (a.probabilities && typeof a.probabilities === 'object') {
      for (const [k, v] of Object.entries(a.probabilities as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isFinite(v)) probs[k] = Math.max(0, Math.min(1, v));
      }
    }
    const legend: Record<string, string> = {};
    if (a.legend && typeof a.legend === 'object') {
      for (const [k, v] of Object.entries(a.legend as Record<string, unknown>)) {
        if (typeof v === 'string') legend[k] = v;
      }
    }
    return { type: 'score', score: a.score, legend, probabilities: probs, confidence };
  }
  return null;
}

export interface CallGeminiDecisionsInit {
  apiKey: string;
  input: string;
  questions: Record<string, DecisionQuestion>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  signal?: AbortSignal;
  now?: () => number;
}

/** Calls `POST /v1beta/decisions` (`gemini-decision-1`) in one zero-output-token forward pass. */
export async function callGeminiDecisions(init: CallGeminiDecisionsInit): Promise<GeminiDecisionResponse> {
  const { apiKey, input, questions, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, signal, now = Date.now } = init;
  if (signal?.aborted) return { ok: false, status: 0, error: 'Cancelled.' };
  const keys = Object.keys(questions);
  if (keys.length < 1 || keys.length > 1000) {
    return { ok: false, status: 400, error: 'Gemini Decisions requires between 1 and 1,000 questions per request.' };
  }
  for (const k of keys) {
    if (!QUESTION_KEY_RE.test(k)) {
      return { ok: false, status: 400, error: `Invalid Gemini Decisions question key: ${k.slice(0, 32)}` };
    }
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  const startedAt = now();
  try {
    const res = await fetchImpl(GEMINI_DECISIONS_ENDPOINT, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        model: GEMINI_DECISIONS_MODEL,
        input,
        questions,
      }),
      signal: controller.signal,
    });
    const latencyMs = Math.max(0, now() - startedAt);
    const rawText = await readBoundedText(res, MAX_RESPONSE_BYTES);
    let parsed: Record<string, unknown> | null = null;
    try {
      const json = JSON.parse(rawText) as unknown;
      if (json && typeof json === 'object' && !Array.isArray(json)) parsed = json as Record<string, unknown>;
    } catch {
      parsed = null;
    }

    if (!res.ok) {
      const errObj = parsed?.error && typeof parsed.error === 'object' ? (parsed.error as Record<string, unknown>) : undefined;
      const rawMsg = typeof errObj?.message === 'string' ? errObj.message : `HTTP ${res.status}`;
      const statusStr = typeof errObj?.status === 'string' ? errObj.status : '';
      const keyRejected = res.status === 401 || res.status === 403 || /API_KEY_INVALID|API key not valid|PERMISSION_DENIED/i.test(`${statusStr} ${rawMsg}`);
      return {
        ok: false,
        status: res.status,
        error: cleanError(rawMsg, apiKey) || `HTTP ${res.status}`,
        ...(keyRejected ? { keyRejected: true } : {}),
      };
    }

    if (!parsed) {
      return { ok: false, status: 502, error: 'Gemini Decisions returned malformed JSON.' };
    }

    const feedback = (parsed.prompt_feedback ?? parsed.promptFeedback) as Record<string, unknown> | undefined;
    const blockReason = typeof feedback?.block_reason === 'string' ? feedback.block_reason : typeof feedback?.blockReason === 'string' ? feedback.blockReason : undefined;

    const usage = (parsed.usage ?? parsed.usage_metadata ?? parsed.usageMetadata) as Record<string, unknown> | undefined;
    const promptTokens =
      typeof usage?.total_input_tokens === 'number'
        ? usage.total_input_tokens
        : typeof usage?.totalInputTokens === 'number'
          ? usage.totalInputTokens
          : typeof usage?.prompt_token_count === 'number'
            ? usage.prompt_token_count
            : typeof usage?.promptTokenCount === 'number'
              ? usage.promptTokenCount
              : typeof usage?.total_tokens === 'number'
                ? usage.total_tokens
                : 0;

    const answers: Record<string, DecisionAnswer> = {};
    if (parsed.answers && typeof parsed.answers === 'object') {
      for (const [k, v] of Object.entries(parsed.answers as Record<string, unknown>)) {
        const ans = parseAnswer(v);
        if (ans) answers[k] = ans;
      }
    }

    return {
      ok: true,
      answers,
      ...(blockReason ? { blockedReason: cleanError(blockReason, apiKey) } : {}),
      inputTokens: Math.max(0, Math.floor(promptTokens)),
      latencyMs,
    };
  } catch (err) {
    if (signal?.aborted) {
      return { ok: false, status: 0, error: 'Cancelled.' };
    }
    const msg = err instanceof Error ? err.message : 'Request failed';
    const timedOut = controller.signal.aborted;
    return {
      ok: false,
      status: 0,
      error: timedOut ? 'Gemini Decisions timed out.' : cleanError(msg, apiKey) || 'Could not reach Gemini Decisions.',
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Verifies a Gemini API key against `gemini-decision-1` with a tiny single-question probe. */
export async function probeGeminiKey(
  apiKey: string,
  opts: { fetchImpl?: FetchLike; timeoutMs?: number; signal?: AbortSignal; now?: () => number } = {},
): Promise<{ ok: true; latencyMs: number; inputTokens: number } | { ok: false; error: string; keyRejected?: boolean }> {
  const res = await callGeminiDecisions({
    apiKey,
    input: 'Floor check: Worker Byte is seated at Desk 1 editing tests.',
    questions: {
      ready: {
        type: 'noul',
        instructions: 'Is Worker Byte actively working at a desk in this floor check?',
      },
    },
    ...opts,
  });
  if (!res.ok) return { ok: false, error: res.error, keyRejected: res.keyRejected };
  if (res.blockedReason || !res.answers.ready) {
    return { ok: false, error: res.blockedReason ? `Blocked by safety filter (${res.blockedReason}).` : 'Gemini Decisions returned no answer.' };
  }
  return { ok: true, latencyMs: res.latencyMs, inputTokens: res.inputTokens };
}

interface PersistedGeminiData {
  apiKey?: string;
  vibesOn?: boolean;
  wakeFilterOn?: boolean;
  at?: number;
  by?: string;
  checkedAt?: number;
  rejected?: string;
}

/**
 * Office-wide `.droid-office/gemini.json` (mode `0600`). The raw API key never leaves the server;
 * clients only see `connected`, `fingerprint`, `vibesOn` and live telemetry.
 */
export class GeminiDecisionsStore {
  private readonly file: string;
  private savedKey?: string;
  private vibes = true;
  private wakeFilter = true;
  private connectedAt?: number;
  private connectedBy?: string;
  private lastCheckedAt?: number;
  private rejectedReason?: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'gemini.json');
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as PersistedGeminiData | null;
      if (raw && typeof raw === 'object') {
        if (isValidGeminiApiKey(raw.apiKey)) this.savedKey = raw.apiKey.trim();
        if (typeof raw.vibesOn === 'boolean') this.vibes = raw.vibesOn;
        if (typeof raw.wakeFilterOn === 'boolean') this.wakeFilter = raw.wakeFilterOn;
        if (typeof raw.at === 'number' && Number.isFinite(raw.at)) this.connectedAt = raw.at;
        if (typeof raw.by === 'string' && raw.by) this.connectedBy = raw.by;
        if (typeof raw.checkedAt === 'number' && Number.isFinite(raw.checkedAt)) this.lastCheckedAt = raw.checkedAt;
        if (typeof raw.rejected === 'string' && raw.rejected) this.rejectedReason = raw.rejected;
      }
    } catch {
      // Fresh office or unreadable file uses clean defaults.
    }
  }

  apiKey(): string | undefined {
    return this.savedKey;
  }

  connected(): boolean {
    return Boolean(this.savedKey);
  }

  vibesOn(): boolean {
    return this.vibes;
  }

  wakeFilterOn(): boolean {
    return this.wakeFilter;
  }

  fingerprint(): string | undefined {
    return this.savedKey ? fingerprintGeminiKey(this.savedKey) : undefined;
  }

  at(): number | undefined {
    return this.connectedAt;
  }

  checkedAt(): number | undefined {
    return this.lastCheckedAt;
  }

  rejected(): string | undefined {
    return this.rejectedReason;
  }

  saveKey(key: string, by: string, now: number): string | undefined {
    if (!isValidGeminiApiKey(key)) return 'Enter a valid Gemini API key.';
    const trimmed = key.trim();
    const prev = this.snapshot();
    this.savedKey = trimmed;
    this.connectedAt = now;
    this.connectedBy = by;
    this.lastCheckedAt = now;
    this.rejectedReason = undefined;
    const err = this.persist();
    if (err) this.restore(prev);
    return err;
  }

  markChecked(now: number, rejected?: string): void {
    this.lastCheckedAt = now;
    this.rejectedReason = rejected;
    if (this.savedKey) void this.persist();
  }

  setVibesOn(on: boolean): string | undefined {
    if (this.vibes === on) return undefined;
    const prev = this.vibes;
    this.vibes = on;
    const err = this.persist();
    if (err) this.vibes = prev;
    return err;
  }

  setWakeFilterOn(on: boolean): string | undefined {
    if (this.wakeFilter === on) return undefined;
    const prev = this.wakeFilter;
    this.wakeFilter = on;
    const err = this.persist();
    if (err) this.wakeFilter = prev;
    return err;
  }

  disconnect(): string | undefined {
    const prev = this.snapshot();
    this.savedKey = undefined;
    this.connectedAt = undefined;
    this.connectedBy = undefined;
    this.lastCheckedAt = undefined;
    this.rejectedReason = undefined;
    const err = this.persist();
    if (err) this.restore(prev);
    return err;
  }

  private snapshot(): PersistedGeminiData {
    return {
      apiKey: this.savedKey,
      vibesOn: this.vibes,
      wakeFilterOn: this.wakeFilter,
      at: this.connectedAt,
      by: this.connectedBy,
      checkedAt: this.lastCheckedAt,
      rejected: this.rejectedReason,
    };
  }

  private restore(s: PersistedGeminiData): void {
    this.savedKey = s.apiKey;
    this.vibes = s.vibesOn ?? true;
    this.wakeFilter = s.wakeFilterOn ?? true;
    this.connectedAt = s.at;
    this.connectedBy = s.by;
    this.lastCheckedAt = s.checkedAt;
    this.rejectedReason = s.rejected;
  }

  private persist(): string | undefined {
    const temp = `${this.file}.${randomUUID()}.tmp`;
    const disk: PersistedGeminiData = {
      vibesOn: this.vibes,
      wakeFilterOn: this.wakeFilter,
      ...(this.savedKey ? { apiKey: this.savedKey } : {}),
      ...(this.connectedAt !== undefined ? { at: this.connectedAt } : {}),
      ...(this.connectedBy ? { by: this.connectedBy } : {}),
      ...(this.lastCheckedAt !== undefined ? { checkedAt: this.lastCheckedAt } : {}),
      ...(this.rejectedReason ? { rejected: this.rejectedReason } : {}),
    };
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(temp, JSON.stringify(disk, null, 2), { mode: 0o600, flag: 'wx' });
      renameSync(temp, this.file);
      return undefined;
    } catch {
      try {
        unlinkSync(temp);
      } catch {}
      return 'Could not save Gemini settings to disk.';
    }
  }
}

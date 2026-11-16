// Public model benchmarks from Artificial Analysis (artificialanalysis.ai), so leads picking a model see
// how capable each one is and what a task costs at each reasoning effort (docs/subscriptions.md#benchmarks).

import { AGENT_EFFORTS, type AgentEffort } from './protocol.js';

export const ARTIFICIAL_ANALYSIS_URL = 'https://artificialanalysis.ai';
export const ARTIFICIAL_ANALYSIS_KEYS_URL = 'https://artificialanalysis.ai/api-key-management-redirect';

/** A reasoning setting Artificial Analysis names in parentheses: Droid's efforts, or reasoning on or off. */
export type BenchmarkEffort = AgentEffort | 'reasoning' | 'non-reasoning';

/** One reasoning effort of a model as Artificial Analysis measured it; nulls are "not measured". */
export interface BenchmarkVariant {
  /** Undefined for a model measured at one setting only. */
  effort?: BenchmarkEffort;
  /** Artificial Analysis Intelligence Index (0–100). */
  intelligence: number | null;
  /** Artificial Analysis Engineering capability index (0–100). */
  engineering: number | null;
  /** US dollars per Intelligence Index task at the creator's API prices (tokens spent times price), not plan quota. */
  costPerTask: number | null;
  /** Mean output tokens per second on the creator's API. */
  tokensPerSecond: number | null;
}

/** A model family as Artificial Analysis names it ("Claude Opus 5.5"), with each effort it measured. */
export interface BenchmarkModel {
  name: string;
  variants: BenchmarkVariant[];
}

/** The office's Artificial Analysis connection, as clients see it (the key never leaves the server). */
export interface BenchmarksState {
  connected: boolean;
  /** The key's last four characters. */
  fingerprint?: string;
  /** When it was connected, ms since the epoch. */
  at?: number;
  /** When the benchmarks were last read. */
  fetchedAt?: number;
  /** How many model families were read. */
  models: number;
  /** A read is under way. */
  checking?: boolean;
  /** Why the last read failed; the benchmarks from before stay in use. */
  error?: string;
}

export function emptyBenchmarksState(): BenchmarksState {
  return { connected: false, models: 0 };
}

export const BENCHMARK_EFFORTS: readonly BenchmarkEffort[] = [...AGENT_EFFORTS, 'reasoning', 'non-reasoning'];
const EFFORT_WORDS = new Set<string>(BENCHMARK_EFFORTS);

export function isBenchmarkEffort(v: unknown): v is BenchmarkEffort {
  return typeof v === 'string' && EFFORT_WORDS.has(v);
}

/** "Claude Opus 5.5 (High, Default Fallback)" is Claude Opus 5.5 at high; "Gemini 1.5 Pro (Sep '24)" is a name of its own. */
export function benchmarkName(name: string): { base: string; effort?: BenchmarkEffort } {
  const trimmed = name.trim();
  const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(trimmed);
  if (!m) return { base: trimmed };
  const base = m[1].trim();
  const word = m[2].split(',')[0].trim().toLowerCase();
  return base && isBenchmarkEffort(word) ? { base, effort: word } : { base: trimmed };
}

/** Brand words a name may or may not lead with: "Claude Opus 5.5" is Droid's "Opus 5.5". */
const BRANDS = new Set(['claude', 'anthropic', 'openai', 'google', 'xai', 'meta']);
/** Labels in front of a model's own name: "DroidProxy: Antigravity: ", or the "custom:droidproxy:" of an id. */
const GATEWAYS = /^(?:[^:()]*:\s*)+/;
/** Efforts an id may end in ("gemini-3.8-flash-high"); "max" and "minimal" are left alone, since names such as "Qwen3 Max" end in them. */
const ID_EFFORTS = new Set<string>(['low', 'medium', 'high', 'xhigh']);
const TRAILING_PARENTHESIS = /\s*\([^()]*\)\s*$/;

function keyWords(text: string): string[] {
  const words = text
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter(Boolean);
  if (words.length > 2 && BRANDS.has(words[0])) words.shift();
  return words;
}

/** "gemini-4-carbon" reads gemini 4 carbon, and "claude-opus-5-5" claude opus 5.5, since ids write a version's dot as a hyphen. */
function idWords(id: string): { words: string[]; effort?: BenchmarkEffort } {
  const parts = id.toLowerCase().split(/[_-]+/).filter(Boolean);
  const last = parts.at(-1);
  const effort = parts.length > 1 && last && ID_EFFORTS.has(last) && isBenchmarkEffort(last) ? last : undefined;
  if (effort) parts.pop();
  const words: string[] = [];
  for (const part of parts) {
    const prev = words.at(-1);
    if (prev !== undefined && /^\d+$/.test(part) && /^\d+(?:\.\d+)*$/.test(prev)) words[words.length - 1] = `${prev}.${part}`;
    else words.push(part);
  }
  if (words.length > 2 && BRANDS.has(words[0])) words.shift();
  return { words, ...(effort ? { effort } : {}) };
}

/** How a name reads for matching: `exact` keeps a parenthesis that isn't an effort ("Gemini 1.5 Pro (Sep '24)"), `loose` drops every trailing one ("(Interactions proxy)"). */
export interface ModelNameKey {
  exact: string;
  loose: string;
  effort?: BenchmarkEffort;
}

export function readModelName(name: string): ModelNameKey {
  const own = name.trim().replace(GATEWAYS, '').trim();
  if (own && !/\s/.test(own) && /[-_]/.test(own)) {
    const { words, effort } = idWords(own);
    const key = words.join(' ');
    return { exact: key, loose: key, ...(effort ? { effort } : {}) };
  }
  const { base, effort } = benchmarkName(own);
  let bare = base;
  while (TRAILING_PARENTHESIS.test(bare)) bare = bare.replace(TRAILING_PARENTHESIS, '');
  return { exact: keyWords(base).join(' '), loose: keyWords(bare).join(' '), ...(effort ? { effort } : {}) };
}

/** "DroidProxy: GPT 6.1 Sol", "GPT-6.1 Sol" and "DroidProxy: Antigravity: GPT 6.1 Sol (High)" all read gpt 6.1 sol. */
export function nameKey(name: string): string {
  return readModelName(name).exact;
}

const sortedWords = (key: string) => key.split(' ').sort().join(' ');
const withoutPreview = (key: string) => key.replace(/\s+\(?preview\)?$/, '');

/**
 * The benchmarks for a Droid model by its display name (or its id); undefined when no family is
 * certainly the same model. First a family that reads the same; then, only when exactly one family
 * fits, the name without its trailing parentheses ("Gemini 4 Carbon (Interactions proxy)"), a family
 * Artificial Analysis still calls Preview, or the same words in another order ("Claude 4.5 Haiku").
 * Dated families ("Gemini 1.5 Pro (Sep '24)") only match a name with that date.
 */
export function matchBenchmark(displayName: string, models: readonly BenchmarkModel[]): BenchmarkModel | undefined {
  const name = readModelName(displayName);
  if (!name.exact) return undefined;
  const families = models.map((model) => ({ model, key: nameKey(model.name) }));
  const exact = families.find((f) => f.key === name.exact);
  if (exact) return exact.model;
  const only = (fits: (key: string) => boolean) => {
    const hits = families.filter((f) => fits(f.key));
    return hits.length === 1 ? hits[0].model : undefined;
  };
  return only((key) => key === name.loose) ?? only((key) => withoutPreview(key) === name.loose) ?? only((key) => sortedWords(key) === sortedWords(name.loose));
}

const versions = (key: string) => (key.match(/\d+(?:\.\d+)*/g) ?? []).sort().join(' ');

/** A Droid name and a family name carry the same version numbers ("PostHog Claude Opus 5.5" and "Claude Opus 5.5", not "Opus 5"). */
export function sameVersions(displayName: string, family: string): boolean {
  return versions(readModelName(displayName).loose) === versions(nameKey(family));
}

const score = (n: number | null) => (n === null ? '?' : String(Math.round(n * 10) / 10));
const dollars = (n: number | null) => (n === null ? '$?' : `$${n.toFixed(n < 10 ? 2 : 1)}`);
const variantWords = (v: BenchmarkVariant) => `${score(v.intelligence)}/${score(v.engineering)} ${dollars(v.costPerTask)}`;

/**
 * "medium* 48.2/53.7 $2.45 · low 34.8/43.2 $0.98 · high …": intelligence/engineering and dollars per
 * task at each effort the model takes, in order, default first and starred; a model measured at one
 * unnamed setting prints just its numbers.
 */
export function benchmarkWords(m: BenchmarkModel, efforts?: readonly string[], defaultEffort?: string): string {
  if (!m.variants.length) return '';
  if (m.variants.length === 1 && !m.variants[0].effort) return variantWords(m.variants[0]);
  const rank = (v: BenchmarkVariant) => (v.effort ? BENCHMARK_EFFORTS.indexOf(v.effort) : -1);
  const taken = m.variants.filter((v) => v.effort && (!efforts?.length || efforts.includes(v.effort)));
  // Models Artificial Analysis rates only as (Reasoning) / (Non-reasoning) match none of Droid's efforts, so show all variants.
  const shown = [...(taken.length ? taken : m.variants)].sort((a, b) => {
    if ((a.effort === defaultEffort) !== (b.effort === defaultEffort)) return a.effort === defaultEffort ? -1 : 1;
    return rank(a) - rank(b);
  });
  return shown.map((v) => `${v.effort ? `${v.effort}${v.effort === defaultEffort ? '*' : ''} ` : ''}${variantWords(v)}`).join(' · ');
}

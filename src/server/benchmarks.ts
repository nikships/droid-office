// Office-wide Artificial Analysis connection: the owner's Data API key, and the public model
// benchmarks read with it once a day for team_models (docs/subscriptions.md#benchmarks).

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { benchmarkName, isBenchmarkEffort, matchBenchmark, sameVersions, type BenchmarkModel, type BenchmarksState, type BenchmarkVariant } from '../shared/benchmarks.js';
import { callGeminiDecisions, type DecisionQuestion } from './gemini-decisions.js';
import { AIRGAPPED_REASON } from '../shared/setup.js';
import { durationWords } from '../shared/subscriptions.js';

/** The free tier's model list; the full list needs a paid plan. */
export const BENCHMARKS_URL = 'https://artificialanalysis.ai/api/v2/language/models/free';
export const BENCHMARKS_REFRESH_MS = 24 * 60 * 60_000;
/** How often the office looks whether a day has passed, and the least time between two failed reads. */
const CHECK_EVERY_MS = 60 * 60_000;
const FIRST_CHECK_MS = 15_000;
/** The free tier allows 100 requests a day; the list is about four pages. */
const PAGE_MAX = 10;
const TIMEOUT_MS = 20_000;
/** Gemini Decisions must be at least this sure that a name is a family before the office uses its benchmarks. */
export const NAME_MATCH_MIN_PROBABILITY = 0.8;
/** How long names that need Gemini gather before one request asks about all of them. */
const ASK_AFTER_MS = 1_000;
const ALIASES_MAX = 200;

export interface BenchmarksTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface BenchmarksOptions {
  /** The office's .droid-office. */
  dataDir: string;
  broadcast(state: BenchmarksState): void;
  /** Airgapped: no reads. */
  paused(): boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timers?: BenchmarksTimers;
  /** Gemini Decisions (the office's `GeminiDecisionsStore`), asked about names no rule matches. */
  decisions?: { apiKey(): string | undefined };
}

/** What Gemini Decisions said a Droid model name is (null: none), against the family list `families` fingerprints. */
interface NameMatch {
  family: string | null;
  families: string;
}

interface Persisted {
  apiKey?: string;
  at?: number;
  by?: string;
  fetchedAt?: number;
  error?: string;
  models?: BenchmarkModel[];
  /** Droid model name -> what Gemini Decisions matched it to. */
  aliases?: Record<string, NameMatch>;
}

export function isValidBenchmarksKey(key: unknown): key is string {
  return typeof key === 'string' && /^[\x21-\x7e]{8,256}$/.test(key.trim());
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

/** The rows of one `/language/models/free` page, grouped by model family with one variant per effort. */
export function groupBenchmarks(rows: readonly unknown[], into: BenchmarkModel[] = []): BenchmarkModel[] {
  for (const raw of rows) {
    const row = obj(raw);
    if (typeof row.name !== 'string' || !row.name.trim()) continue;
    const { base, effort } = benchmarkName(row.name);
    const evals = obj(row.evaluations);
    const variant: BenchmarkVariant = {
      ...(effort ? { effort } : {}),
      intelligence: num(evals.artificial_analysis_intelligence_index),
      engineering: num(evals.artificial_analysis_engineering_index),
      costPerTask: num(obj(obj(row.artificial_analysis_intelligence_index_cost).cost_per_task).total_cost),
      tokensPerSecond: num(obj(row.performance_v3).mean_output_tokens_per_second),
    };
    if (variant.intelligence === null && variant.engineering === null) continue;
    let model = into.find((m) => m.name === base);
    if (!model) {
      model = { name: base, variants: [] };
      into.push(model);
    }
    if (!model.variants.some((v) => v.effort === variant.effort)) model.variants.push(variant);
  }
  return into;
}

const isNullableNum = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v));

function isVariant(v: unknown): v is BenchmarkVariant {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const x = v as Record<string, unknown>;
  return (x.effort === undefined || isBenchmarkEffort(x.effort)) && isNullableNum(x.intelligence) && isNullableNum(x.engineering) && isNullableNum(x.costPerTask) && isNullableNum(x.tokensPerSecond);
}

function isModel(v: unknown): v is BenchmarkModel {
  const m = obj(v);
  return typeof m.name === 'string' && m.name.trim().length > 0 && Array.isArray(m.variants) && m.variants.length > 0 && m.variants.every(isVariant);
}

function isNameMatch(v: unknown): v is NameMatch {
  const m = obj(v);
  return (m.family === null || (typeof m.family === 'string' && m.family.length > 0)) && typeof m.families === 'string';
}

/** Changes whenever Artificial Analysis lists other families, so a match made against an older list is asked again. */
function fingerprintFamilies(models: readonly BenchmarkModel[]): string {
  return createHash('sha256')
    .update(
      models
        .map((m) => m.name)
        .sort()
        .join('\n'),
    )
    .digest('hex')
    .slice(0, 16);
}

const NAME_MATCH_INPUT = "Droid Office shows each Droid model the Artificial Analysis benchmarks of the same model. A wrong family shows another model's numbers, which is worse than showing none.";

/** One `choice` question per name over every family plus "none"; the question repeats its name, since it can't see its key. */
export function nameMatchQuestions(names: readonly string[], models: readonly BenchmarkModel[]): { questions: Record<string, DecisionQuestion>; families: Map<string, string> } {
  const families = new Map<string, string>();
  for (const m of models) {
    const slug =
      m.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 56) || 'family';
    let option = slug === 'none' ? 'none_family' : slug;
    for (let n = 2; families.has(option); n++) option = `${slug}_${n}`;
    families.set(option, m.name);
  }
  const criteria: Record<string, string> = Object.fromEntries([...families].map(([option, name]) => [option, name]));
  criteria.none = 'None of these families is exactly this model and version.';
  const questions = Object.fromEntries(
    names.map((name, i): [string, DecisionQuestion] => [
      `m${i}`,
      {
        type: 'choice',
        instructions: `Which Artificial Analysis benchmark family is the model Droid calls "${name}"? Labels for where "${name}" runs (a "DroidProxy:" or "Antigravity:" prefix, a gateway or company name in front, a note such as "(Interactions proxy)") don't change the model. Answer none unless "${name}" is exactly that family's model and version, not another size, edition, fine-tune or modified copy.`,
        criteria,
      },
    ]),
  );
  return { questions, families };
}

export class Benchmarks {
  private readonly file: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timers: BenchmarksTimers;
  private key?: string;
  private at?: number;
  private by?: string;
  private fetchedAt?: number;
  private error?: string;
  private list: BenchmarkModel[] = [];
  private aliases = new Map<string, NameMatch>();
  private printed: { list: BenchmarkModel[]; print: string } | undefined;
  /** Names waiting for the next Gemini Decisions request, and when each was last asked about. */
  private asking = new Set<string>();
  private askedAt = new Map<string, number>();
  private askTimer: unknown;
  private matching: Promise<void> | null = null;
  private reading: Promise<string | undefined> | null = null;
  private connecting = 0;
  private triedAt = Number.NEGATIVE_INFINITY;
  private timer: unknown;
  private stopped = false;
  /** Moves on every connect and disconnect, so a read that started before one never saves over it. */
  private gen = 0;
  private tempCount = 0;

  constructor(private readonly opts: BenchmarksOptions) {
    this.file = path.join(opts.dataDir, 'artificial-analysis.json');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.timers = opts.timers ?? {
      setTimeout: (fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        return t;
      },
      clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
    };
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Persisted;
      if (isValidBenchmarksKey(raw?.apiKey)) this.key = raw.apiKey.trim();
      this.at = num(raw?.at) ?? undefined;
      if (typeof raw?.by === 'string') this.by = raw.by;
      this.fetchedAt = num(raw?.fetchedAt) ?? undefined;
      if (typeof raw?.error === 'string' && raw.error) this.error = raw.error;
      if (Array.isArray(raw?.models)) this.list = raw.models.filter(isModel);
      for (const [name, match] of Object.entries(obj(raw?.aliases))) if (isNameMatch(match)) this.aliases.set(name, match);
    } catch {
      // Not connected yet.
    }
    this.schedule(FIRST_CHECK_MS);
  }

  state(): BenchmarksState {
    if (!this.key) return { connected: false, models: 0 };
    return {
      connected: true,
      fingerprint: this.key.slice(-4),
      ...(this.at !== undefined ? { at: this.at } : {}),
      ...(this.fetchedAt !== undefined ? { fetchedAt: this.fetchedAt } : {}),
      models: this.list.length,
      ...(this.reading || this.connecting > 0 ? { checking: true } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  /**
   * The benchmarks for a Droid model by its display name, while connected: by the naming rules, else by
   * what Gemini Decisions said about the name. Never waits on the network; a name nobody has asked
   * about yet is asked about shortly after, in one request with any others.
   */
  forModel(displayName: string): BenchmarkModel | undefined {
    if (!this.key) return undefined;
    const found = matchBenchmark(displayName, this.list);
    if (found) return found;
    const said = this.aliases.get(displayName);
    if (said && said.families === this.familiesPrint()) return said.family === null ? undefined : this.list.find((m) => m.name === said.family);
    this.ask([displayName]);
    return undefined;
  }

  /** Resolves once the Gemini Decisions request under way, if any, has saved its answers. */
  async namesMatched(): Promise<void> {
    await this.matching;
  }

  private familiesPrint(): string {
    if (this.printed?.list !== this.list) this.printed = { list: this.list, print: fingerprintFamilies(this.list) };
    return this.printed.print;
  }

  /** Queues names for Gemini Decisions; a name asked about in the last hour waits, unless the family list changed (`again`). */
  private ask(names: readonly string[], again = false): void {
    if (this.stopped || !this.list.length || !this.opts.decisions?.apiKey() || this.opts.paused()) return;
    const t = this.now();
    for (const name of names) if (again || t - (this.askedAt.get(name) ?? Number.NEGATIVE_INFINITY) >= CHECK_EVERY_MS) this.asking.add(name);
    if (!this.asking.size || this.askTimer !== undefined) return;
    this.askTimer = this.timers.setTimeout(() => {
      this.askTimer = undefined;
      const run = this.matchNames().finally(() => {
        if (this.matching === run) this.matching = null;
      });
      this.matching = run;
    }, ASK_AFTER_MS);
  }

  /** One Gemini Decisions request about every queued name; an answer below `NAME_MATCH_MIN_PROBABILITY`, "none" or other version numbers is saved as no match. */
  private async matchNames(): Promise<void> {
    const names = [...this.asking];
    this.asking.clear();
    const apiKey = this.opts.decisions?.apiKey();
    if (!names.length || !apiKey || !this.key || this.opts.paused()) return;
    const t = this.now();
    for (const name of names) this.askedAt.set(name, t);
    const { list, gen } = this;
    const families = this.familiesPrint();
    const { questions, families: options } = nameMatchQuestions(names, list);
    const res = await callGeminiDecisions({ apiKey, input: NAME_MATCH_INPUT, questions, fetchImpl: this.fetchImpl, now: this.now });
    if (!res.ok || res.blockedReason || this.stopped || gen !== this.gen || list !== this.list) return;
    names.forEach((name, i) => {
      const answer = res.answers[`m${i}`];
      if (answer?.type !== 'choice') return;
      const family = options.get(answer.choice);
      const sure = (answer.probabilities[answer.choice] ?? answer.confidence) >= NAME_MATCH_MIN_PROBABILITY;
      this.aliases.delete(name);
      this.aliases.set(name, { family: family && sure && sameVersions(name, family) ? family : null, families });
    });
    for (const name of this.aliases.keys()) {
      if (this.aliases.size <= ALIASES_MAX) break;
      this.aliases.delete(name);
    }
    this.persist();
  }

  /** Reads the benchmarks with `key` and keeps it only when that works; resolves with why not. */
  async connect(key: string, by: string): Promise<string | undefined> {
    if (!isValidBenchmarksKey(key)) return 'Enter a valid Artificial Analysis API key.';
    if (this.opts.paused()) return AIRGAPPED_REASON;
    const trimmed = key.trim();
    const gen = ++this.gen;
    this.connecting++;
    this.publish();
    let read: BenchmarkModel[] | string;
    try {
      read = await this.read(trimmed);
    } finally {
      this.connecting--;
    }
    if (gen !== this.gen || this.stopped) {
      this.publish();
      return 'The Artificial Analysis connection changed while the key was being checked; nothing was saved.';
    }
    if (typeof read === 'string') {
      this.publish();
      return read;
    }
    return this.commit({ apiKey: trimmed, at: this.now(), by, fetchedAt: this.now(), models: read });
  }

  disconnect(): string | undefined {
    this.gen++;
    return this.commit({});
  }

  private commit(next: Persisted): string | undefined {
    const prev = this.snapshot();
    this.restore(next);
    const err = this.persist();
    if (err) this.restore(prev);
    this.publish();
    return err;
  }

  /** Reads the benchmarks again now; resolves with why that failed. */
  async refresh(): Promise<string | undefined> {
    if (!this.key) return 'Connect an Artificial Analysis API key first.';
    if (this.opts.paused()) return AIRGAPPED_REASON;
    if (this.connecting > 0) return 'An Artificial Analysis key check is already under way.';
    if (this.reading) return this.reading;
    const key = this.key;
    const gen = this.gen;
    this.reading = (async () => {
      this.triedAt = this.now();
      const read = await this.read(key);
      if (this.key !== key || gen !== this.gen) return undefined;
      if (typeof read === 'string') {
        this.error = read;
        this.persist();
        return read;
      }
      const prev = this.snapshot();
      this.list = read;
      this.fetchedAt = this.now();
      this.error = undefined;
      const err = this.persist();
      if (err) {
        this.restore(prev);
        this.error = err;
      } else {
        const families = this.familiesPrint();
        this.ask(
          [...this.aliases].filter(([, m]) => m.families !== families).map(([name]) => name),
          true,
        );
      }
      return err;
    })();
    this.publish();
    try {
      return await this.reading;
    } finally {
      this.reading = null;
      this.publish();
    }
  }

  stop(): void {
    this.stopped = true;
    this.timers.clearTimeout(this.timer);
    this.timers.clearTimeout(this.askTimer);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = this.timers.setTimeout(() => {
      const t = this.now();
      const due = this.key && !this.connecting && !this.opts.paused() && (this.fetchedAt === undefined || t - this.fetchedAt >= BENCHMARKS_REFRESH_MS) && t - this.triedAt >= CHECK_EVERY_MS;
      void (due ? this.refresh() : Promise.resolve()).finally(() => this.schedule(CHECK_EVERY_MS));
    }, ms);
  }

  /** Every page of the free model list, grouped; or why it couldn't be read (never naming the key). */
  private async read(key: string): Promise<BenchmarkModel[] | string> {
    const models: BenchmarkModel[] = [];
    for (let page = 1; page <= PAGE_MAX; page++) {
      if (this.opts.paused()) return AIRGAPPED_REASON;
      let res: Response;
      try {
        res = await this.fetchImpl(`${BENCHMARKS_URL}?page=${page}`, { headers: { 'x-api-key': key, accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch {
        return 'Could not reach Artificial Analysis.';
      }
      if (!res.ok) return this.failure(res, key);
      let body: Record<string, unknown>;
      try {
        body = obj(await res.json());
      } catch {
        return 'Artificial Analysis sent something that is not JSON.';
      }
      if (!Array.isArray(body.data)) return 'Artificial Analysis sent no model list.';
      groupBenchmarks(body.data, models);
      if (obj(body.pagination).has_more !== true) break;
    }
    return models.length ? models : 'Artificial Analysis listed no benchmarked models.';
  }

  private async failure(res: Response, key: string): Promise<string> {
    if (res.status === 401) return 'Artificial Analysis rejected the key.';
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after'));
      return `Artificial Analysis's daily request limit is used up${Number.isFinite(wait) && wait > 0 ? `; it resets in ${durationWords(wait * 1000)}` : ''}.`;
    }
    let said = '';
    try {
      const e = obj(await res.json()).error;
      if (typeof e === 'string') said = e.split(key).join('…').slice(0, 200);
    } catch {}
    return `Artificial Analysis answered ${res.status}${said ? `: ${said}` : ''}.`;
  }

  private publish(): void {
    if (!this.stopped) this.opts.broadcast(this.state());
  }

  private snapshot(): Persisted {
    return { apiKey: this.key, at: this.at, by: this.by, fetchedAt: this.fetchedAt, error: this.error, models: this.list, aliases: this.aliases.size ? Object.fromEntries(this.aliases) : undefined };
  }

  private restore(s: Persisted): void {
    this.key = s.apiKey;
    this.at = s.at;
    this.by = s.by;
    this.fetchedAt = s.fetchedAt;
    this.error = s.error;
    this.list = s.models ?? [];
    this.aliases = new Map(Object.entries(s.aliases ?? {}));
  }

  private persist(): string | undefined {
    const temp = `${this.file}.${process.pid}.${this.tempCount++}.tmp`;
    const disk: Persisted = this.key ? Object.fromEntries(Object.entries(this.snapshot()).filter(([, v]) => v !== undefined)) : {};
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(temp, JSON.stringify(disk), { mode: 0o600, flag: 'wx' });
      renameSync(temp, this.file);
      return undefined;
    } catch {
      try {
        unlinkSync(temp);
      } catch {}
      return 'Could not save the Artificial Analysis settings to disk.';
    }
  }
}

import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Benchmarks, BENCHMARKS_REFRESH_MS, BENCHMARKS_URL, groupBenchmarks } from '../src/server/benchmarks.js';
import { benchmarkName, benchmarkWords, matchBenchmark, nameKey, readModelName, sameVersions, type BenchmarkModel } from '../src/shared/benchmarks.js';

/** Rows from the owner's `GET /api/v2/language/models/free` (November 2026), trimmed to the fields the office reads. */
const PAGE_1 = [
  {
    slug: 'glm-4-5v',
    name: 'GLM-4.5V (Non-reasoning)',
    evaluations: { artificial_analysis_intelligence_index: null, artificial_analysis_engineering_index: null },
    artificial_analysis_intelligence_index_cost: null,
    performance_v3: { mean_output_tokens_per_second: 44.73 },
  },
  {
    slug: 'kimi-k2-6',
    name: 'Kimi K2.6 (Reasoning)',
    evaluations: { artificial_analysis_intelligence_index: null, artificial_analysis_engineering_index: null },
    artificial_analysis_intelligence_index_cost: null,
    performance_v3: { mean_output_tokens_per_second: 40.63 },
  },
  {
    slug: 'claude-haiku-5-5-high',
    name: 'Claude Haiku 5.5 (High)',
    evaluations: { artificial_analysis_intelligence_index: 29.9, artificial_analysis_engineering_index: 36.5 },
    artificial_analysis_intelligence_index_cost: { total_cost: 121.41, cost_per_task: { total_cost: 0.1586 } },
    performance_v3: { mean_output_tokens_per_second: 224.23 },
  },
  {
    slug: 'claude-opus-5-5',
    name: 'Claude Opus 5.5 (Max, Default Fallback)',
    evaluations: { artificial_analysis_intelligence_index: 59.1, artificial_analysis_engineering_index: 65.3 },
    artificial_analysis_intelligence_index_cost: { total_cost: 8909.67, cost_per_task: { total_cost: 10.0364 } },
    performance_v3: { mean_output_tokens_per_second: 116.23 },
  },
  {
    slug: 'gpt-6-1-sol-high',
    name: 'GPT-6.1 Sol (High)',
    evaluations: { artificial_analysis_intelligence_index: 50.3, artificial_analysis_engineering_index: 55.4 },
    artificial_analysis_intelligence_index_cost: { total_cost: 573.17, cost_per_task: { total_cost: 0.591 } },
    performance_v3: { mean_output_tokens_per_second: 49.67 },
  },
];
const PAGE_2 = [
  {
    slug: 'claude-opus-5-5-low',
    name: 'Claude Opus 5.5 (Low, Default Fallback)',
    evaluations: { artificial_analysis_intelligence_index: 34.8, artificial_analysis_engineering_index: 43.2 },
    artificial_analysis_intelligence_index_cost: { total_cost: 979.66, cost_per_task: { total_cost: 0.9755 } },
    performance_v3: { mean_output_tokens_per_second: 104.68 },
  },
  {
    slug: 'gpt-6-1-sol-medium',
    name: 'GPT-6.1 Sol (Medium)',
    evaluations: { artificial_analysis_intelligence_index: 46.3, artificial_analysis_engineering_index: 52.1 },
    artificial_analysis_intelligence_index_cost: { total_cost: 388.57, cost_per_task: { total_cost: 0.3594 } },
    performance_v3: { mean_output_tokens_per_second: 51.93 },
  },
  {
    slug: 'claude-opus-5-5-medium',
    name: 'Claude Opus 5.5 (Medium, Default Fallback)',
    evaluations: { artificial_analysis_intelligence_index: 48.2, artificial_analysis_engineering_index: 53.7 },
    artificial_analysis_intelligence_index_cost: { total_cost: 2031.27, cost_per_task: { total_cost: 2.4511 } },
    performance_v3: { mean_output_tokens_per_second: 106.26 },
  },
  {
    slug: 'gemini-1-5-pro',
    name: "Gemini 1.5 Pro (Sep '24)",
    evaluations: { artificial_analysis_intelligence_index: 30, artificial_analysis_engineering_index: null },
    artificial_analysis_intelligence_index_cost: null,
    performance_v3: { mean_output_tokens_per_second: null },
  },
];
/** More rows from the same read: every Claude Sonnet 5.5 effort, Gemini 4 Carbon, and an older family named brand-version-name. */
const row = (slug: string, name: string, intelligence: number, engineering: number, costPerTask: number, tokensPerSecond: number) => ({
  slug,
  name,
  evaluations: { artificial_analysis_intelligence_index: intelligence, artificial_analysis_engineering_index: engineering },
  artificial_analysis_intelligence_index_cost: { cost_per_task: { total_cost: costPerTask } },
  performance_v3: { mean_output_tokens_per_second: tokensPerSecond },
});
const SONNET = [
  row('claude-sonnet-5-5-low', 'Claude Sonnet 5.5 (Low, Default Fallback)', 25.6, 33.4, 0.5113, 135.15),
  row('claude-sonnet-5-5-medium', 'Claude Sonnet 5.5 (Medium, Default Fallback)', 30.8, 37.3, 0.7807, 127.94),
  row('claude-sonnet-5-5-high', 'Claude Sonnet 5.5 (High, Default Fallback)', 41.5, 46.2, 1.6361, 144.43),
  row('claude-sonnet-5-5-xhigh', 'Claude Sonnet 5.5 (Xhigh, Default Fallback)', 49.9, 53.8, 4.092, 143.36),
  row('claude-sonnet-5-5', 'Claude Sonnet 5.5 (Max, Default Fallback)', 54.5, 58.5, 10.0206, 151.27),
];
const CARBON = [
  row('gemini-4-carbon-low', 'Gemini 4 Carbon (Low)', 54.2, 60.2, 5.2214, 52.66),
  row('gemini-4-carbon-medium', 'Gemini 4 Carbon (Medium)', 58.3, 63.9, 4.6777, 59.47),
  row('gemini-4-carbon', 'Gemini 4 Carbon (High)', 60, 65.3, 5.4848, 62.43),
];
const HAIKU_4_5 = row('claude-4-5-haiku-reasoning', 'Claude 4.5 Haiku (Reasoning)', 7.4, 17, 0.5318, 115.83);
const KEY = 'aa_TestKeyNotReal1234';
const GEMINI_KEY = 'AIzaTestGeminiKeyNotReal0000';
const DECISIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/decisions';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

test('Artificial Analysis names group by family and effort, and match Droid model names', () => {
  assert.deepEqual(benchmarkName('Claude Opus 5.5 (High, Default Fallback)'), { base: 'Claude Opus 5.5', effort: 'high' });
  assert.deepEqual(benchmarkName('Kimi K2.6 (Non-reasoning)'), { base: 'Kimi K2.6', effort: 'non-reasoning' });
  assert.deepEqual(benchmarkName("Gemini 1.5 Pro (Sep '24)"), { base: "Gemini 1.5 Pro (Sep '24)" });
  assert.equal(nameKey('DroidProxy: GPT 6.1 Sol'), nameKey('GPT-6.1 Sol'));
  assert.equal(nameKey('DroidProxy: Opus 5.5'), nameKey('Claude Opus 5.5'));

  const models = groupBenchmarks([...PAGE_1, ...PAGE_2]);
  assert.deepEqual(
    models.map((m) => [m.name, m.variants.map((v) => v.effort ?? '-')]),
    [
      ['Claude Haiku 5.5', ['high']],
      ['Claude Opus 5.5', ['max', 'low', 'medium']],
      ['GPT-6.1 Sol', ['high', 'medium']],
      ["Gemini 1.5 Pro (Sep '24)", ['-']],
    ],
    'rows with no scores at all are left out',
  );
  assert.equal(matchBenchmark('DroidProxy: Opus 5.5', models)?.name, 'Claude Opus 5.5');
  assert.equal(matchBenchmark('Opus 5.5', models)?.name, 'Claude Opus 5.5');
  assert.equal(matchBenchmark('DroidProxy: GPT 6.1 Sol', models)?.name, 'GPT-6.1 Sol');
  assert.equal(matchBenchmark('DroidProxy: Antigravity: Claude Opus 5.5 (High)', models)?.name, 'Claude Opus 5.5');
  assert.equal(matchBenchmark('Opus 5', models), undefined, 'a version prefix is a different model');
  assert.equal(matchBenchmark('GPT 6.1 Sol Mini', models), undefined);
  assert.equal(matchBenchmark('Gemini 1.5 Pro', models), undefined, 'a dated name is its own model');
  assert.equal(matchBenchmark("Gemini 1.5 Pro (Sep '24)", models)?.name, "Gemini 1.5 Pro (Sep '24)");
});

test('a name drops a parenthesis that is not an effort, and ids read as names', () => {
  const models = groupBenchmarks([...PAGE_1, ...PAGE_2, ...CARBON, ...SONNET, HAIKU_4_5]);
  assert.deepEqual(readModelName('Gemini 4 Carbon (Interactions proxy)'), { exact: 'gemini 4 carbon (interactions proxy)', loose: 'gemini 4 carbon' });
  assert.equal(matchBenchmark('Gemini 4 Carbon (Interactions proxy)', models)?.name, 'Gemini 4 Carbon');
  assert.equal(matchBenchmark('DroidProxy: Gemini 4 Carbon (Interactions proxy) (High)', models)?.name, 'Gemini 4 Carbon');
  assert.equal(matchBenchmark('Gemini 4 Carbon Lite (Interactions proxy)', models), undefined, 'the words outside the parenthesis still have to agree');
  assert.deepEqual(readModelName('gemini-3.8-flash-high'), { exact: 'gemini 3.8 flash', loose: 'gemini 3.8 flash', effort: 'high' });
  assert.equal(matchBenchmark('gemini-4-carbon', models)?.name, 'Gemini 4 Carbon');
  assert.equal(matchBenchmark('claude-opus-5-5', models)?.name, 'Claude Opus 5.5', 'an id writes 5.5 as 5-5');
  assert.equal(matchBenchmark('custom:droidproxy:gpt-6.1-sol', models)?.name, 'GPT-6.1 Sol');
  assert.equal(matchBenchmark('claude-opus-5', models), undefined);
  assert.equal(nameKey('qwen3-max'), 'qwen3 max', 'max ends model names, so an id keeps it');
  assert.equal(matchBenchmark('Haiku 4.5', models)?.name, 'Claude 4.5 Haiku', 'the same words in another order, when only one family has them');
  const preview: BenchmarkModel[] = [{ name: 'Gemini 3.1 Pro Preview', variants: [{ intelligence: 50, engineering: 50, costPerTask: 1, tokensPerSecond: null }] }];
  assert.equal(matchBenchmark('Gemini 3.1 Pro', preview)?.name, 'Gemini 3.1 Pro Preview');
  assert.equal(matchBenchmark('Gemini 3.1 Pro', [...preview, { ...preview[0], name: 'Gemini 3.1 Pro (Preview)' }]), undefined, 'two families fit, so neither does');
  assert.ok(sameVersions('PostHog Claude Opus 5.5', 'Claude Opus 5.5'));
  assert.ok(!sameVersions('Opus 5', 'Claude Opus 5.5'));
  assert.ok(!sameVersions('Gemini 1.5 Pro', "Gemini 1.5 Pro (Sep '24)"));
});

test("Claude Sonnet 5.5's efforts are Artificial Analysis's own rows (regression: the owner's report that Sonnet looked shifted)", () => {
  const models = groupBenchmarks([...SONNET, ...PAGE_1, ...PAGE_2]);
  const sonnet = matchBenchmark('Sonnet 5.5', models)!;
  assert.equal(sonnet.name, 'Claude Sonnet 5.5');
  assert.deepEqual(
    sonnet.variants.map((v) => [v.effort, v.intelligence, v.engineering, v.costPerTask]),
    [
      ['low', 25.6, 33.4, 0.5113],
      ['medium', 30.8, 37.3, 0.7807],
      ['high', 41.5, 46.2, 1.6361],
      ['xhigh', 49.9, 53.8, 4.092],
      ['max', 54.5, 58.5, 10.0206],
    ],
    'each "(Effort, Default Fallback)" row is that effort, with nothing merged or shifted',
  );
  assert.equal(benchmarkWords(sonnet, EFFORTS, 'high'), 'high* 41.5/46.2 $1.64 · low 25.6/33.4 $0.51 · medium 30.8/37.3 $0.78 · xhigh 49.9/53.8 $4.09 · max 54.5/58.5 $10.0');
  assert.equal(matchBenchmark('DroidProxy: Sonnet 5.5', models), sonnet);
  assert.equal(matchBenchmark('Sonnet 5', models), undefined);
});

test('benchmark lines are compact: default effort first and starred, only the efforts the model takes', () => {
  const models = groupBenchmarks([...PAGE_1, ...PAGE_2]);
  const opus = matchBenchmark('DroidProxy: Opus 5.5', models)!;
  assert.equal(benchmarkWords(opus, EFFORTS, 'medium'), 'medium* 48.2/53.7 $2.45 · low 34.8/43.2 $0.98 · max 59.1/65.3 $10.0');
  assert.equal(benchmarkWords(opus, ['low', 'medium'], 'medium'), 'medium* 48.2/53.7 $2.45 · low 34.8/43.2 $0.98');
  assert.equal(benchmarkWords(matchBenchmark('Haiku 5.5', models)!, EFFORTS, 'medium'), 'high 29.9/36.5 $0.16');
  assert.equal(benchmarkWords(models[3]), '30/? $?');
});

function rig(
  t: { after(fn: () => void): void },
  opts: {
    paused?: () => boolean;
    respond?: (url: string, key: string | null) => Response | undefined | Promise<Response | undefined>;
    gemini?: () => string | undefined;
    decide?: (body: { questions: Record<string, { instructions: string; criteria: Record<string, string> }> }) => Response;
  } = {},
) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'benchmarks-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let now = Date.UTC(2026, 10, 16, 4);
  const calls: string[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const states: unknown[] = [];
  const pages = (url: string) => {
    const page = Number(new URL(url).searchParams.get('page'));
    return Response.json({ tier: 'free', pagination: { page, page_size: 5, total_pages: 2, has_more: page < 2 }, data: page === 1 ? PAGE_1 : PAGE_2 });
  };
  const decisions: { questions: Record<string, { instructions: string; criteria: Record<string, string> }> }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === DECISIONS_URL) {
      const body = JSON.parse(String(init?.body));
      assert.equal(new Headers(init?.headers).get('x-goog-api-key'), GEMINI_KEY);
      decisions.push(body);
      return opts.decide?.(body) ?? Response.json({ answers: {} });
    }
    calls.push(url);
    const key = new Headers(init?.headers).get('x-api-key');
    return (await opts.respond?.(url, key)) ?? pages(url);
  }) as typeof fetch;
  const make = () =>
    new Benchmarks({
      dataDir: dir,
      broadcast: (s) => states.push(s),
      paused: () => opts.paused?.() ?? false,
      fetchImpl,
      now: () => now,
      timers: { setTimeout: (fn, ms) => timers.push({ fn, ms }), clearTimeout: () => {} },
      decisions: { apiKey: () => opts.gemini?.() },
    });
  return { dir, file: path.join(dir, 'artificial-analysis.json'), calls, decisions, timers, states, make, advance: (ms: number) => (now += ms), at: () => now };
}

test('connecting reads every page with the key, keeps the key private, and survives a restart', async (t) => {
  const r = rig(t);
  const b = r.make();
  assert.deepEqual(b.state(), { connected: false, models: 0 });
  assert.equal(await b.connect('not a key', 'owner'), 'Enter a valid Artificial Analysis API key.');
  assert.equal(await b.connect(KEY, 'owner'), undefined);
  assert.deepEqual(r.calls, [`${BENCHMARKS_URL}?page=1`, `${BENCHMARKS_URL}?page=2`]);
  assert.deepEqual(b.state(), { connected: true, fingerprint: '1234', at: r.at(), fetchedAt: r.at(), models: 4 });
  assert.equal(b.forModel('DroidProxy: GPT 6.1 Sol')?.variants.length, 2);
  assert.equal(statSync(r.file).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(r.states).includes(KEY), 'clients never see the key');

  const again = r.make();
  assert.equal(again.state().models, 4);
  assert.equal(again.forModel('Opus 5.5')?.name, 'Claude Opus 5.5');
  assert.equal(again.disconnect(), undefined);
  assert.deepEqual(again.state(), { connected: false, models: 0 });
  assert.equal(again.forModel('Opus 5.5'), undefined);
  assert.deepEqual(JSON.parse(readFileSync(r.file, 'utf8')), {});
});

test('a rejected key is not saved, and a failed refresh keeps the benchmarks it had', async (t) => {
  let answer: ((key: string | null) => Response) | undefined = (key) => (key === KEY ? Response.json({ status: 401, error: 'Unauthorized' }, { status: 401 }) : Response.json({}));
  const r = rig(t, { respond: (_url, key) => answer?.(key) });
  const b = r.make();
  assert.equal(await b.connect(KEY, 'owner'), 'Artificial Analysis rejected the key.');
  assert.equal(b.state().connected, false);

  answer = undefined;
  assert.equal(await b.connect(KEY, 'owner'), undefined);
  answer = () => new Response(JSON.stringify({ error: `Language models list requires a Pro subscription for ${KEY}` }), { status: 403 });
  assert.equal(await b.refresh(), 'Artificial Analysis answered 403: Language models list requires a Pro subscription for ….');
  answer = () => new Response('{}', { status: 429, headers: { 'retry-after': '7200' } });
  const limited = await b.refresh();
  assert.equal(limited, "Artificial Analysis's daily request limit is used up; it resets in 2 h.");
  assert.equal(b.state().error, limited);
  assert.equal(b.state().models, 4, 'the benchmarks from before stay in use');
  assert.ok(b.forModel('Opus 5.5'));
  answer = () => {
    throw new Error('offline');
  };
  assert.equal(await b.refresh(), 'Could not reach Artificial Analysis.');
});

test('benchmarks are read again once a day, never while airgapped', async (t) => {
  const r = rig(t);
  const b = r.make();
  await b.connect(KEY, 'owner');
  r.calls.length = 0;
  assert.equal(r.timers[0].ms, 15_000);
  r.timers.shift()!.fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(r.calls.length, 0, 'read less than a day ago');
  r.advance(BENCHMARKS_REFRESH_MS);
  r.timers.shift()!.fn();
  for (let i = 0; i < 20 && r.calls.length < 2; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(r.calls.length, 2);
  assert.equal(b.state().fetchedAt, r.at());

  const paused = rig(t, { paused: () => true });
  writeFileSync(paused.file, readFileSync(r.file));
  const off = paused.make();
  assert.match((await off.refresh()) ?? '', /airgapped/i);
  paused.advance(BENCHMARKS_REFRESH_MS * 2);
  paused.timers.shift()!.fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(paused.calls.length, 0);
});

test('a read under way never saves over a later disconnect, and airgapped mode stops it before the next page', async (t) => {
  let hold: Promise<void> | undefined;
  let open = () => {};
  const block = () => {
    hold = new Promise((resolve) => (open = resolve));
  };
  let airgapped = false;
  const r = rig(t, {
    paused: () => airgapped,
    respond: async () => {
      await hold;
      return undefined;
    },
  });
  const b = r.make();
  block();
  const pending = b.connect(KEY, 'owner');
  assert.equal(b.disconnect(), undefined);
  open();
  assert.match((await pending) ?? '', /changed while the key was being checked/);
  assert.equal(b.state().connected, false);
  assert.deepEqual(JSON.parse(readFileSync(r.file, 'utf8')), {});

  hold = undefined;
  assert.equal(await b.connect(KEY, 'owner'), undefined);
  r.calls.length = 0;
  block();
  const reading = b.refresh();
  airgapped = true;
  open();
  assert.match((await reading) ?? '', /airgapped/i);
  assert.deepEqual(r.calls, [`${BENCHMARKS_URL}?page=1`], 'no page is asked for once the office is airgapped');
  assert.equal(b.state().models, 4);
});

test('a refresh that cannot save says so', async (t) => {
  const r = rig(t);
  const b = r.make();
  assert.equal(await b.connect(KEY, 'owner'), undefined);
  chmodSync(r.dir, 0o500);
  try {
    assert.equal(await b.refresh(), 'Could not save the Artificial Analysis settings to disk.');
    assert.equal(b.state().error, 'Could not save the Artificial Analysis settings to disk.');
  } finally {
    chmodSync(r.dir, 0o700);
  }
});

/** A Gemini Decisions answer for each question, naming the option whose description is `family` (or "none"). */
function answers(pick: (instructions: string) => [family: string, probability: number]) {
  return (body: { questions: Record<string, { instructions: string; criteria: Record<string, string> }> }) =>
    Response.json({
      answers: Object.fromEntries(
        Object.entries(body.questions).map(([key, q]) => {
          const [family, p] = pick(q.instructions);
          const choice = family === 'none' ? 'none' : Object.keys(q.criteria).find((option) => q.criteria[option] === family)!;
          return [key, { type: 'choice', choice, probabilities: { [choice]: p, none: choice === 'none' ? p : 1 - p }, confidence: p }];
        }),
      ),
      usage: { total_input_tokens: 900, total_output_tokens: 0, total_tokens: 900 },
    });
}

/** Fires the queued Gemini Decisions request (the timer `forModel` set) and waits for its answers to be saved. */
async function askGemini(r: ReturnType<typeof rig>, b: Benchmarks) {
  const i = r.timers.findIndex((x) => x.ms === 1_000);
  assert.notEqual(i, -1, 'a Gemini Decisions request is queued');
  r.timers.splice(i, 1)[0].fn();
  await b.namesMatched();
}

test('names no rule matches go to Gemini Decisions once, together, and only a sure answer of the same version is used', async (t) => {
  const r = rig(t, {
    gemini: () => GEMINI_KEY,
    decide: answers((q) => {
      if (q.includes('"PostHog Claude Opus 5.5"')) return ['Claude Opus 5.5', 0.93];
      if (q.includes('"Sol Preview Build"')) return ['GPT-6.1 Sol', 0.62];
      if (q.includes('"Abliterated Large Flash"')) return ['none', 0.97];
      if (q.includes('"Opus Next"')) return ['Claude Opus 5.5', 0.95];
      throw new Error(`unexpected question ${q}`);
    }),
  });
  const b = r.make();
  await b.connect(KEY, 'owner');
  for (const name of ['PostHog Claude Opus 5.5', 'Sol Preview Build', 'Abliterated Large Flash', 'Opus Next']) assert.equal(b.forModel(name), undefined, 'team_models never waits on the network');
  assert.equal(b.forModel('Opus 5.5')?.name, 'Claude Opus 5.5', 'a name the rules match never asks');
  await askGemini(r, b);
  assert.equal(r.decisions.length, 1, 'one request for every name');
  const asked = Object.values(r.decisions[0].questions);
  assert.equal(asked.length, 4);
  assert.deepEqual(Object.values(asked[0].criteria).sort(), ['Claude Haiku 5.5', 'Claude Opus 5.5', "Gemini 1.5 Pro (Sep '24)", 'GPT-6.1 Sol', 'None of these families is exactly this model and version.'].sort());
  assert.ok(
    asked.every((q, i) => q.instructions.split(`"${['PostHog Claude Opus 5.5', 'Sol Preview Build', 'Abliterated Large Flash', 'Opus Next'][i]}"`).length > 2),
    'each question repeats its name',
  );

  assert.equal(b.forModel('PostHog Claude Opus 5.5')?.name, 'Claude Opus 5.5', 'accepted at 0.93');
  assert.equal(b.forModel('Sol Preview Build'), undefined, 'rejected at 0.62');
  assert.equal(b.forModel('Abliterated Large Flash'), undefined, 'none');
  assert.equal(b.forModel('Opus Next'), undefined, 'a family with other version numbers is never used');
  assert.equal(r.timers.filter((x) => x.ms === 1_000).length, 0, 'answered names are not asked again');
  assert.equal(r.decisions.length, 1);

  const again = r.make();
  assert.equal(again.forModel('PostHog Claude Opus 5.5')?.name, 'Claude Opus 5.5', 'answers survive a restart');
  assert.equal(again.forModel('Abliterated Large Flash'), undefined);
  assert.equal(r.timers.filter((x) => x.ms === 1_000).length, 0);
  assert.ok(!readFileSync(r.file, 'utf8').includes(GEMINI_KEY));
});

test('a refresh that lists other families asks again in one request; without Gemini, the rules alone answer', async (t) => {
  let page2 = PAGE_2;
  const r = rig(t, {
    gemini: () => GEMINI_KEY,
    decide: answers(() => ['Claude Opus 5.5', 0.9]),
    respond: (url) => {
      const page = Number(new URL(url).searchParams.get('page'));
      return Response.json({ pagination: { has_more: page < 2 }, data: page === 1 ? PAGE_1 : page2 });
    },
  });
  const b = r.make();
  await b.connect(KEY, 'owner');
  b.forModel('PostHog Claude Opus 5.5');
  b.forModel('Gateway Opus 5.5');
  await askGemini(r, b);
  assert.equal(r.decisions.length, 1);
  assert.equal(await b.refresh(), undefined);
  assert.equal(r.timers.filter((x) => x.ms === 1_000).length, 0, 'the same families: nothing to ask');
  page2 = [...PAGE_2, ...CARBON];
  assert.equal(await b.refresh(), undefined);
  assert.equal(b.forModel('PostHog Claude Opus 5.5'), undefined, 'an answer about the old list is not used');
  await askGemini(r, b);
  assert.equal(r.decisions.length, 2);
  assert.equal(Object.keys(r.decisions[1].questions).length, 2, 'both names in one request');
  assert.equal(b.forModel('PostHog Claude Opus 5.5')?.name, 'Claude Opus 5.5');

  const off = rig(t, { decide: () => assert.fail('Gemini Decisions is not connected') });
  const plain = off.make();
  await plain.connect(KEY, 'owner');
  assert.equal(plain.forModel('PostHog Claude Opus 5.5'), undefined);
  assert.equal(plain.forModel('DroidProxy: GPT 6.1 Sol')?.name, 'GPT-6.1 Sol');
  assert.equal(off.timers.filter((x) => x.ms === 1_000).length, 0, 'nothing is queued');
  assert.equal(off.decisions.length, 0);
});

test('a failed Gemini Decisions request saves nothing and waits an hour before asking about that name again', async (t) => {
  let fail = true;
  const r = rig(t, {
    gemini: () => GEMINI_KEY,
    decide: (body) => (fail ? Response.json({ error: { message: 'quota exhausted', status: 'RESOURCE_EXHAUSTED' } }, { status: 429 }) : answers(() => ['Claude Opus 5.5', 0.9])(body)),
  });
  const b = r.make();
  await b.connect(KEY, 'owner');
  b.forModel('PostHog Claude Opus 5.5');
  await askGemini(r, b);
  assert.equal(b.forModel('PostHog Claude Opus 5.5'), undefined);
  assert.equal(r.timers.filter((x) => x.ms === 1_000).length, 0, 'not asked again at once');
  fail = false;
  r.advance(60 * 60_000);
  b.forModel('PostHog Claude Opus 5.5');
  await askGemini(r, b);
  assert.equal(b.forModel('PostHog Claude Opus 5.5')?.name, 'Claude Opus 5.5');
  assert.equal(r.decisions.length, 2);
});

#!/usr/bin/env bun
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EVAL_CASES, type EvalCase } from './cases.js';
import type { SampleGrade } from './grader.js';
import { createEvalRig, type ContextBreakdown, type EvalRole, type OpenAiToolDef, type RecordedCall } from './rig.js';

interface CliFlags {
  contextOnly: boolean;
  models: string[];
  samples: number;
  concurrency: number;
  maxSteps: number;
  effort: string;
  baseUrl: string;
  apiKey: string;
  caseFilter?: Set<string>;
  outDir?: string;
  compareFile?: string;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

interface SampleRunResult {
  caseId: string;
  category: EvalCase['category'];
  model: string;
  sample: number;
  durationMs: number;
  steps: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  firstTurnPromptTokens: number;
  grade: SampleGrade;
  calls: RecordedCall[];
  messages: ChatMessage[];
  finalText: string;
  error?: string;
}

interface ModelAggregate {
  model: string;
  casesPassed: number;
  casesTotal: number;
  samplesPassed: number;
  samplesTotal: number;
  samplePassRate: number;
  activeManagerPassRate: number;
  avgRubricScore: number;
  avgArgCorrectness: number;
  avgMcpCalls: number;
  avgTotalCalls: number;
  avgFirstTurnPromptTokens: number;
  perCase: Record<
    string,
    {
      category: string;
      passedSamples: number;
      totalSamples: number;
      avgRubric: number;
      avgCalls: number;
      failedChecks: string[];
    }
  >;
}

interface EvalReport {
  commit: string;
  createdAt: string;
  effort: string;
  samplesPerCase: number;
  context: ContextBreakdown[];
  models: ModelAggregate[];
  samples: SampleRunResult[];
}

export function parseFlags(argv: string[]): CliFlags {
  const flags: CliFlags = {
    contextOnly: false,
    models: ['custom:droidproxy:gpt-6.1-sol'],
    samples: 2,
    concurrency: 6,
    maxSteps: 6,
    effort: 'medium',
    baseUrl: process.env.DROIDPROXY_BASE_URL ?? 'http://localhost:8317/v1',
    apiKey: process.env.DROIDPROXY_API_KEY ?? 'dummy-not-used',
  };
  const explicitModels: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--context') flags.contextOnly = true;
    else if (arg === '--model' && argv[i + 1])
      explicitModels.push(
        ...argv[++i]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      );
    else if (arg === '--samples' && argv[i + 1]) flags.samples = Number(argv[++i]);
    else if (arg === '--concurrency' && argv[i + 1]) flags.concurrency = Number(argv[++i]);
    else if (arg === '--max-steps' && argv[i + 1]) flags.maxSteps = Number(argv[++i]);
    else if (arg === '--effort' && argv[i + 1]) flags.effort = argv[++i];
    else if (arg === '--base-url' && argv[i + 1]) flags.baseUrl = argv[++i];
    else if (arg === '--case' && argv[i + 1])
      flags.caseFilter = new Set(
        argv[++i]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      );
    else if (arg === '--out' && argv[i + 1]) flags.outDir = argv[++i];
    else if (arg === '--compare' && argv[i + 1]) flags.compareFile = argv[++i];
    else throw new Error(`Unknown option or missing value: ${arg}`);
  }
  if (explicitModels.length) flags.models = explicitModels;
  for (const key of ['samples', 'concurrency', 'maxSteps'] as const) {
    if (!Number.isSafeInteger(flags[key]) || flags[key] < 1) throw new Error(`${key} must be a positive integer.`);
  }
  return flags;
}

function wireModelId(model: string): string {
  return model.replace(/^custom:droidproxy:/, '');
}

function currentCommit(): string {
  try {
    const repo = path.resolve(import.meta.dirname, '../..');
    const sha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
    return `${sha}${dirty ? '-dirty' : ''}`;
  } catch {
    return 'unknown';
  }
}

export async function measureAllContexts(): Promise<ContextBreakdown[]> {
  const roles: EvalRole[] = ['orchestrator', 'external-bot', 'floor-lead', 'subagent'];
  const results: ContextBreakdown[] = [];
  for (const role of roles) {
    const rig = await createEvalRig({
      role,
      floors: [{ id: 'droid-office', name: 'droid-office', dir: '/work/droid-office' }],
      workers: role === 'floor-lead' ? [{ id: 'sub-seed', name: 'Pixel', floor: 'droid-office', lead: 'caller' }] : [],
    });
    try {
      results.push(rig.contextBreakdown());
    } finally {
      await rig.close();
    }
  }
  return results;
}

async function callChatCompletion(opts: { baseUrl: string; apiKey: string; model: string; effort: string; messages: ChatMessage[]; tools: OpenAiToolDef[] }) {
  const url = `${opts.baseUrl.replace(/\/$/, '')}/chat/completions`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify({
          model: wireModelId(opts.model),
          reasoning_effort: opts.effort,
          messages: opts.messages,
          tools: opts.tools,
          parallel_tool_calls: true,
        }),
        signal: AbortSignal.timeout(90_000),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        if (attempt < 2 && (response.status >= 500 || response.status === 429)) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 240)}`);
      }
      return (await response.json()) as {
        choices?: {
          message?: {
            content?: string | null;
            tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
          };
        }[];
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          completion_tokens_details?: { reasoning_tokens?: number };
        };
      };
    } catch (err) {
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Unreachable');
}

export async function runSingleSample(evalCase: EvalCase, model: string, sample: number, flags: CliFlags): Promise<SampleRunResult> {
  const started = Date.now();
  const rig = await createEvalRig(evalCase.world);
  const messages: ChatMessage[] = [{ role: 'system', content: rig.fullSystemPrompt }];
  for (const turn of evalCase.priorTurns ?? []) {
    messages.push({ role: 'user', content: turn.user });
    messages.push({ role: 'assistant', content: turn.assistant });
  }
  messages.push({ role: 'user', content: evalCase.prompt });

  let promptTokens = 0;
  let completionTokens = 0;
  let reasoningTokens = 0;
  let firstTurnPromptTokens = 0;
  let finalText = '';
  let steps = 0;
  let finished = false;
  const maxSteps = evalCase.maxSteps ?? flags.maxSteps;

  try {
    for (let step = 1; step <= maxSteps; step++) {
      steps = step;
      const reply = await callChatCompletion({
        baseUrl: flags.baseUrl,
        apiKey: flags.apiKey,
        model,
        effort: flags.effort,
        messages,
        tools: rig.allTools,
      });
      const pTok = reply.usage?.prompt_tokens ?? 0;
      if (step === 1) firstTurnPromptTokens = pTok;
      promptTokens += pTok;
      completionTokens += reply.usage?.completion_tokens ?? 0;
      reasoningTokens += reply.usage?.completion_tokens_details?.reasoning_tokens ?? 0;

      const msg = reply.choices?.[0]?.message;
      if (!msg) throw new Error('Model returned no assistant message.');
      const content = msg?.content ?? null;
      const toolCalls = msg?.tool_calls ?? [];
      if (content) finalText = content;

      if (!toolCalls.length) {
        messages.push({ role: 'assistant', content });
        finished = true;
        break;
      }

      messages.push({ role: 'assistant', content, tool_calls: toolCalls });
      for (const tc of toolCalls) {
        let parsed: Record<string, unknown> = {};
        let parseFailed = false;
        try {
          parsed = tc.function.arguments ? (JSON.parse(tc.function.arguments) as Record<string, unknown>) : {};
        } catch {
          parseFailed = true;
        }
        const toolOut = parseFailed
          ? (() => {
              const errText = `Invalid JSON arguments for ${tc.function.name}`;
              rig.calls.push({ step, name: tc.function.name, args: {}, isError: true, resultText: errText });
              return Promise.resolve(errText);
            })()
          : rig.executeTool(step, tc.function.name, parsed);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: await toolOut });
      }
    }

    const grade = evalCase.grade({ calls: rig.calls, state: rig.state, finalText });
    if (!finished) {
      grade.passed = false;
      grade.checks.push({ name: 'finished-within-step-budget', ok: false, detail: `Still calling tools at step ${maxSteps}.` });
      grade.rubricScore = grade.checks.filter((c) => c.ok).length / grade.checks.length;
    }
    return {
      caseId: evalCase.id,
      category: evalCase.category,
      model,
      sample,
      durationMs: Date.now() - started,
      steps,
      promptTokens,
      completionTokens,
      reasoningTokens,
      firstTurnPromptTokens,
      grade,
      calls: rig.calls,
      messages,
      finalText,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      caseId: evalCase.id,
      category: evalCase.category,
      model,
      sample,
      durationMs: Date.now() - started,
      steps,
      promptTokens,
      completionTokens,
      reasoningTokens,
      firstTurnPromptTokens,
      grade: {
        passed: false,
        rubricScore: 0,
        argCorrectness: 0,
        mcpCallCount: 0,
        totalCallCount: 0,
        checks: [{ name: 'sample-ran-without-error', ok: false, detail: message }],
      },
      calls: rig.calls,
      messages,
      finalText,
      error: message,
    };
  } finally {
    await rig.close();
  }
}

function aggregateModel(model: string, cases: EvalCase[], samples: SampleRunResult[]): ModelAggregate {
  const mine = samples.filter((s) => s.model === model);
  const perCase: ModelAggregate['perCase'] = {};
  let casesPassed = 0;
  for (const c of cases) {
    const cs = mine.filter((s) => s.caseId === c.id);
    const passedSamples = cs.filter((s) => s.grade.passed).length;
    if (cs.length > 0 && passedSamples > cs.length / 2) casesPassed++;
    const failedSet = new Set<string>();
    for (const s of cs) {
      for (const chk of s.grade.checks) if (!chk.ok) failedSet.add(chk.detail ? `${chk.name} (${chk.detail})` : chk.name);
    }
    perCase[c.id] = {
      category: c.category,
      passedSamples,
      totalSamples: cs.length,
      avgRubric: cs.length ? cs.reduce((a, b) => a + b.grade.rubricScore, 0) / cs.length : 0,
      avgCalls: cs.length ? cs.reduce((a, b) => a + b.grade.totalCallCount, 0) / cs.length : 0,
      failedChecks: [...failedSet],
    };
  }
  const activeSamples = mine.filter((s) => s.category === 'active-manager');
  const avg = (fn: (s: SampleRunResult) => number) => (mine.length ? mine.reduce((a, b) => a + fn(b), 0) / mine.length : 0);
  return {
    model,
    casesPassed,
    casesTotal: cases.length,
    samplesPassed: mine.filter((s) => s.grade.passed).length,
    samplesTotal: mine.length,
    samplePassRate: avg((s) => (s.grade.passed ? 1 : 0)),
    activeManagerPassRate: activeSamples.length ? activeSamples.filter((s) => s.grade.passed).length / activeSamples.length : 0,
    avgRubricScore: avg((s) => s.grade.rubricScore),
    avgArgCorrectness: avg((s) => s.grade.argCorrectness),
    avgMcpCalls: avg((s) => s.grade.mcpCallCount),
    avgTotalCalls: avg((s) => s.grade.totalCallCount),
    avgFirstTurnPromptTokens: avg((s) => s.firstTurnPromptTokens),
    perCase,
  };
}

function formatContextTable(contexts: ContextBreakdown[]): string {
  const lines = ['| Role | Tools | System chars | MCP instructions chars | Tool desc chars | Full tool schema chars | Total chars | Est. tokens |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'];
  for (const c of contexts) {
    lines.push(
      `| \`${c.role}\` | ${c.toolCount} | ${c.systemPromptChars.toLocaleString()} | ${c.mcpInstructionsChars.toLocaleString()} | ${c.toolDescriptionsChars.toLocaleString()} | ${c.toolSchemasChars.toLocaleString()} | ${c.totalChars.toLocaleString()} | ~${c.estimatedTokens.toLocaleString()} |`,
    );
  }
  return lines.join('\n');
}

function formatReportMarkdown(report: EvalReport, baseline?: EvalReport): string {
  const lines: string[] = [`# Orchestration & Office MCP Eval (${report.commit})`, '', '## Context Footprint', '', formatContextTable(report.context)];
  if (baseline) {
    lines.push('', '### Context Delta vs Baseline', '', '| Role | Baseline chars (~tokens) | Current chars (~tokens) | Change |', '| --- | ---: | ---: | ---: |');
    for (const cur of report.context) {
      const prev = baseline.context.find((b) => b.role === cur.role);
      if (!prev) continue;
      const pct = (((cur.totalChars - prev.totalChars) / prev.totalChars) * 100).toFixed(1);
      lines.push(`| \`${cur.role}\` | ${prev.totalChars.toLocaleString()} (~${prev.estimatedTokens.toLocaleString()}) | ${cur.totalChars.toLocaleString()} (~${cur.estimatedTokens.toLocaleString()}) | ${pct}% |`);
    }
  }
  if (report.models.length) {
    lines.push('', '## Model Scores', '', '| Model | Cases passed | Samples passed | Active-manager pass | Rubric score | Arg correctness | Avg calls | Turn-1 prompt tokens |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const m of report.models) {
      lines.push(
        `| \`${m.model}\` | ${m.casesPassed}/${m.casesTotal} | ${m.samplesPassed}/${m.samplesTotal} (${(m.samplePassRate * 100).toFixed(0)}%) | ${(m.activeManagerPassRate * 100).toFixed(0)}% | ${(m.avgRubricScore * 100).toFixed(1)}% | ${(m.avgArgCorrectness * 100).toFixed(1)}% | ${m.avgTotalCalls.toFixed(1)} | ${Math.round(m.avgFirstTurnPromptTokens).toLocaleString()} |`,
      );
    }
    if (baseline?.models.length) {
      lines.push('', '### Before vs After Summary', '', '| Model | Metric | Baseline | After | Delta |', '| --- | --- | ---: | ---: | ---: |');
      for (const m of report.models) {
        const b = baseline.models.find((x) => x.model === m.model);
        if (!b) continue;
        lines.push(
          `| \`${m.model}\` | Cases passed | ${b.casesPassed}/${b.casesTotal} | ${m.casesPassed}/${m.casesTotal} | ${m.casesPassed - b.casesPassed >= 0 ? '+' : ''}${m.casesPassed - b.casesPassed} |`,
          `| \`${m.model}\` | Sample pass rate | ${(b.samplePassRate * 100).toFixed(0)}% | ${(m.samplePassRate * 100).toFixed(0)}% | ${((m.samplePassRate - b.samplePassRate) * 100 >= 0 ? '+' : '') + ((m.samplePassRate - b.samplePassRate) * 100).toFixed(0)} pp |`,
          `| \`${m.model}\` | Active-manager pass rate | ${(b.activeManagerPassRate * 100).toFixed(0)}% | ${(m.activeManagerPassRate * 100).toFixed(0)}% | ${((m.activeManagerPassRate - b.activeManagerPassRate) * 100 >= 0 ? '+' : '') + ((m.activeManagerPassRate - b.activeManagerPassRate) * 100).toFixed(0)} pp |`,
          `| \`${m.model}\` | Rubric score | ${(b.avgRubricScore * 100).toFixed(1)}% | ${(m.avgRubricScore * 100).toFixed(1)}% | ${((m.avgRubricScore - b.avgRubricScore) * 100 >= 0 ? '+' : '') + ((m.avgRubricScore - b.avgRubricScore) * 100).toFixed(1)} pp |`,
          `| \`${m.model}\` | Turn-1 prompt tokens | ${Math.round(b.avgFirstTurnPromptTokens).toLocaleString()} | ${Math.round(m.avgFirstTurnPromptTokens).toLocaleString()} | ${(((m.avgFirstTurnPromptTokens - b.avgFirstTurnPromptTokens) / Math.max(1, b.avgFirstTurnPromptTokens)) * 100).toFixed(1)}% |`,
        );
      }
    }
    for (const m of report.models) {
      lines.push('', `### Per-Case Breakdown (\`${m.model}\`)`, '', '| Case | Category | Pass | Rubric | Avg calls | Misses |', '| --- | --- | ---: | ---: | ---: | --- |');
      for (const [id, info] of Object.entries(m.perCase)) {
        lines.push(`| \`${id}\` | ${info.category} | ${info.passedSamples}/${info.totalSamples} | ${(info.avgRubric * 100).toFixed(0)}% | ${info.avgCalls.toFixed(1)} | ${info.failedChecks.slice(0, 2).join('; ') || '—'} |`);
      }
    }
  }
  return lines.join('\n');
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const context = await measureAllContexts();
  const baseline = flags.compareFile ? (JSON.parse(readFileSync(flags.compareFile, 'utf8')) as EvalReport) : undefined;

  if (flags.contextOnly) {
    const report: EvalReport = {
      commit: currentCommit(),
      createdAt: new Date().toISOString(),
      effort: flags.effort,
      samplesPerCase: 0,
      context,
      models: [],
      samples: [],
    };
    console.log(formatReportMarkdown(report, baseline));
    if (flags.outDir) {
      mkdirSync(flags.outDir, { recursive: true });
      writeFileSync(path.join(flags.outDir, 'context.json'), JSON.stringify(report, null, 2));
    }
    return;
  }

  if (flags.caseFilter) {
    for (const id of flags.caseFilter) if (!EVAL_CASES.some((c) => c.id === id)) throw new Error(`Unknown eval case: ${id}`);
  }
  const cases = flags.caseFilter ? EVAL_CASES.filter((c) => flags.caseFilter!.has(c.id)) : EVAL_CASES;
  if (!cases.length) throw new Error('No eval cases matched --case filter.');

  const queue: { evalCase: EvalCase; model: string; sample: number }[] = [];
  for (const model of flags.models) {
    for (const evalCase of cases) {
      for (let s = 1; s <= flags.samples; s++) queue.push({ evalCase, model, sample: s });
    }
  }

  console.error(`Running ${queue.length} eval samples (${cases.length} cases × ${flags.samples} samples × ${flags.models.length} model(s), concurrency=${flags.concurrency}, effort=${flags.effort})...`);
  const results: SampleRunResult[] = new Array(queue.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(flags.concurrency, queue.length) }, async () => {
    for (;;) {
      const idx = cursor++;
      if (idx >= queue.length) return;
      const item = queue[idx];
      const res = await runSingleSample(item.evalCase, item.model, item.sample, flags);
      results[idx] = res;
      const status = res.grade.passed ? 'PASS' : 'FAIL';
      console.error(
        `[${idx + 1}/${queue.length}] ${status} ${wireModelId(item.model)} ${item.evalCase.id}#${item.sample} rubric=${(res.grade.rubricScore * 100).toFixed(0)}% calls=${res.grade.totalCallCount} tok=${res.firstTurnPromptTokens} (${(res.durationMs / 1000).toFixed(1)}s)${res.error ? ` ERR=${res.error}` : ''}`,
      );
    }
  });
  await Promise.all(workers);

  const models = flags.models.map((m) => aggregateModel(m, cases, results));
  const report: EvalReport = {
    commit: currentCommit(),
    createdAt: new Date().toISOString(),
    effort: flags.effort,
    samplesPerCase: flags.samples,
    context,
    models,
    samples: results,
  };

  const md = formatReportMarkdown(report, baseline);
  console.log(md);

  if (flags.outDir) {
    mkdirSync(flags.outDir, { recursive: true });
    writeFileSync(path.join(flags.outDir, 'report.json'), JSON.stringify(report, null, 2));
    writeFileSync(path.join(flags.outDir, 'summary.md'), `${md}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

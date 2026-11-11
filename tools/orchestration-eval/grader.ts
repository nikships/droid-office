import type { RecordedCall, EvalWorldState } from './rig.js';

export interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface SampleGrade {
  passed: boolean;
  rubricScore: number;
  argCorrectness: number;
  mcpCallCount: number;
  totalCallCount: number;
  checks: CheckResult[];
}

export interface GradeInput {
  calls: RecordedCall[];
  state: EvalWorldState;
  finalText: string;
}

export function called(calls: RecordedCall[], name: string | RegExp): RecordedCall[] {
  return calls.filter((c) => (typeof name === 'string' ? c.name === name : name.test(c.name)));
}

export function okCalls(calls: RecordedCall[], name: string | RegExp): RecordedCall[] {
  return called(calls, name).filter((c) => !c.isError);
}

export function firstStepOf(calls: RecordedCall[], name: string | RegExp): number | undefined {
  return okCalls(calls, name)[0]?.step;
}

export function computeSampleGrade(checks: CheckResult[], calls: RecordedCall[]): SampleGrade {
  const mcpCalls = calls.filter((c) => c.name !== 'shell' && c.name !== 'read_file');
  const isCallFailure = (c: RecordedCall) => c.isError && c.structured?.code !== 'merge_conflict';
  const validMcp = mcpCalls.filter((c) => !isCallFailure(c)).length;
  const argCorrectness = mcpCalls.length === 0 ? 1 : validMcp / mcpCalls.length;
  const passedChecks = checks.filter((c) => c.ok).length;
  const rubricScore = checks.length === 0 ? 1 : passedChecks / checks.length;
  return {
    passed: checks.every((c) => c.ok) && mcpCalls.every((c) => !isCallFailure(c)),
    rubricScore,
    argCorrectness,
    mcpCallCount: mcpCalls.length,
    totalCallCount: calls.length,
    checks,
  };
}

/** Rejects shell sleep-polling or bypassing Office MCP delegation via CLI subagents. */
export function noShellAntiPatterns(state: EvalWorldState): CheckResult {
  const bad = state.shellCommands.find((cmd) => /\bsleep\s+\d+/.test(cmd) || /\b(?:droid|claude|codex)\s+(?:exec|-p|--print)\b/.test(cmd));
  return {
    name: 'no-shell-polling-or-cli-bypass',
    ok: !bad,
    detail: bad ? `Ran anti-pattern shell command: ${bad}` : undefined,
  };
}

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EVAL_CASES } from '../tools/orchestration-eval/cases.js';
import { called, computeSampleGrade, firstStepOf, noShellAntiPatterns, okCalls } from '../tools/orchestration-eval/grader.js';
import { createEvalRig, estimateTokens, type EvalRole, type RecordedCall } from '../tools/orchestration-eval/rig.js';

test('orchestration-eval grader computes pass, rubric, MCP argument correctness, and shell anti-patterns', () => {
  const calls: RecordedCall[] = [
    { step: 1, name: 'team_models', args: {}, isError: false, resultText: 'ok' },
    { step: 2, name: 'team_hire', args: { title: 't' }, isError: true, resultText: 'missing brief' },
    { step: 2, name: 'shell', args: { command: 'git status' }, isError: false, resultText: 'clean' },
    { step: 3, name: 'team_hire', args: { title: 't', brief: 'b' }, isError: false, resultText: 'hired' },
  ];
  assert.equal(called(calls, 'team_hire').length, 2);
  assert.equal(okCalls(calls, 'team_hire').length, 1);
  assert.equal(firstStepOf(calls, 'team_hire'), 3);

  const failedArgGrade = computeSampleGrade(
    [
      { name: 'c1', ok: true },
      { name: 'c2', ok: true },
    ],
    calls,
  );
  assert.equal(failedArgGrade.passed, false, 'an MCP validation error fails strict sample pass even when rubric checks pass');
  assert.equal(failedArgGrade.rubricScore, 1);
  assert.ok(Math.abs(failedArgGrade.argCorrectness - 2 / 3) < 1e-9);
  assert.equal(failedArgGrade.mcpCallCount, 3);
  assert.equal(failedArgGrade.totalCallCount, 4);

  const cleanCalls = calls.filter((c) => !c.isError);
  assert.equal(computeSampleGrade([{ name: 'c1', ok: true }], cleanCalls).passed, true);

  const conflictCalls: RecordedCall[] = [...cleanCalls, { step: 4, name: 'team_merge', args: { worker: 'Byte', target: 'main' }, isError: true, resultText: 'Merge conflict', structured: { code: 'merge_conflict' } }];
  assert.equal(computeSampleGrade([{ name: 'c1', ok: true }], conflictCalls).argCorrectness, 1, 'a legitimate Git merge_conflict is not an MCP argument error');

  const emptyState = {
    hiredWorkers: [],
    spawnedWorkers: [],
    messagedWorkers: [],
    answeredQuestions: [],
    dismissedWorkers: [],
    interruptedWorkers: [],
    ackedInboxIds: [],
    statusReports: [],
    shellCommands: ['git status --short'],
    dirtyFiles: new Set<string>(),
    commits: [],
    mergedBranches: [],
  };
  assert.equal(noShellAntiPatterns(emptyState).ok, true);
  assert.equal(noShellAntiPatterns({ ...emptyState, shellCommands: ['sleep 30 && git status'] }).ok, false);
  assert.equal(noShellAntiPatterns({ ...emptyState, shellCommands: ['droid exec "fix bug"'] }).ok, false);
});

test('orchestration-eval rig serves live Office MCP roles, measures context, and codifies active-lead guidance across every lead surface', async (t) => {
  const roles: EvalRole[] = ['orchestrator', 'external-bot', 'floor-lead', 'subagent'];
  const counts: Record<EvalRole, number> = { orchestrator: 0, 'external-bot': 0, 'floor-lead': 0, subagent: 0 };

  for (const role of roles) {
    const rig = await createEvalRig({
      role,
      floors: [{ id: 'droid-office', name: 'droid-office', dir: '/work/droid-office' }],
    });
    t.after(() => rig.close());

    const breakdown = rig.contextBreakdown();
    counts[role] = breakdown.toolCount;
    assert.ok(breakdown.totalChars > 0);
    assert.equal(breakdown.estimatedTokens, estimateTokens(`${rig.baseSystemPrompt}\n${rig.mcpInstructions}\n${JSON.stringify(rig.listedTools)}`));

    const whoami = await rig.executeTool(1, 'office_whoami', {});
    assert.match(whoami, role === 'orchestrator' ? /Orchestrator/ : role === 'external-bot' ? /external bot/ : /droid-office/);
    assert.equal(rig.calls.at(-1)?.isError, false);

    if (role !== 'subagent') {
      // Every lead role—including external MCP clients without orchestrator.system—receives active-manager guidance.
      const combinedLeadGuidance = [rig.fullSystemPrompt, ...rig.listedTools.filter((tool) => /^team_(?:hire|status|wait|message|review|merge)$|^worker_diff$/.test(tool.name)).map((tool) => tool.description ?? '')].join('\n');
      assert.match(combinedLeadGuidance, /connective tissue/i, `${role} should receive active-manager connective-tissue rule`);
      assert.match(combinedLeadGuidance, /worker_diff/, `${role} should be instructed to verify worker_diff`);
      assert.match(combinedLeadGuidance, /team_review/, `${role} should receive team_review gate guidance`);
      assert.match(combinedLeadGuidance, /team_merge/, `${role} should receive team_merge integration guidance`);
      assert.match(combinedLeadGuidance, /team_message/, `${role} should be instructed to relay sibling updates via team_message`);
      assert.match(combinedLeadGuidance, /permission prompt/i, `${role} should distinguish technical questions from desk permission prompts`);
    }
  }

  assert.equal(counts.orchestrator, 24);
  assert.equal(counts['external-bot'], 26);
  assert.equal(counts['floor-lead'], 25);
  assert.equal(counts.subagent, 9);
});

test('orchestration-eval scenario suite has unique ids and grades live MCP interactions end to end', async (t) => {
  const ids = EVAL_CASES.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(EVAL_CASES.some((c) => c.category === 'control'));
  assert.ok(EVAL_CASES.some((c) => c.category === 'active-manager'));

  const relayCase = EVAL_CASES.find((c) => c.id === 'active-relay-sibling-schema-change')!;
  const rig = await createEvalRig(relayCase.world);
  t.after(() => rig.close());

  await rig.executeTool(1, 'team_status', { floor: 'droid-office' });
  await rig.executeTool(2, 'worker_diff', { worker: 'Byte', floor: 'droid-office' });
  await rig.executeTool(3, 'team_message', {
    worker: 'Nova',
    floor: 'droid-office',
    text: "Byte updated PipelineTriggerReply to { status: 'queued' | 'blocked'; jobId: string; blockedReason?: string }.",
  });

  const grade = relayCase.grade({ calls: rig.calls, state: rig.state, finalText: 'Relayed schema update to Nova.' });
  assert.equal(grade.passed, true);
  assert.equal(grade.rubricScore, 1);
});

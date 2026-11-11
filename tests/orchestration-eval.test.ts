import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EVAL_CASES } from '../tools/orchestration-eval/cases.js';
import { called, computeSampleGrade, firstStepOf, noShellAntiPatterns, okCalls } from '../tools/orchestration-eval/grader.js';
import { createEvalRig, estimateTokens, type EvalRole, type RecordedCall } from '../tools/orchestration-eval/rig.js';
import { parseFlags, runSingleSample } from '../tools/orchestration-eval/run.js';

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
    stagedFiles: new Set<string>(),
    commits: [],
    mergedBranches: [],
  };
  assert.equal(noShellAntiPatterns(emptyState).ok, true);
  assert.equal(noShellAntiPatterns({ ...emptyState, shellCommands: ['sleep 30 && git status'] }).ok, false);
  assert.equal(noShellAntiPatterns({ ...emptyState, shellCommands: ['droid exec "fix bug"'] }).ok, false);
});

test('eval requires actual approval and landing, not just diff reads and a rebase message', async (t) => {
  const scenario = EVAL_CASES.find((c) => c.id === 'sequence-merges-and-rebase-siblings')!;
  const rig = await createEvalRig(scenario.world);
  t.after(() => rig.close());
  const grade = () => scenario.grade({ calls: rig.calls, state: rig.state, finalText: '' });
  await rig.executeTool(1, 'worker_diff', { worker: 'Pixel', floor: 'droid-office' });
  await rig.executeTool(1, 'worker_diff', { worker: 'Byte', floor: 'droid-office' });
  await rig.executeTool(2, 'team_message', { worker: 'Byte', text: 'Rebase onto main and align with badgeCount.', floor: 'droid-office' });
  assert.equal(grade().passed, false, 'the old false-positive transcript must fail');
  await rig.executeTool(2, 'team_review', { worker: 'Pixel', verdict: 'approve', notes: 'Inspected server contract and tests.', floor: 'droid-office' });
  await rig.executeTool(3, 'team_merge', { worker: 'sub-1', target: 'main', floor: 'droid-office' });
  assert.equal(grade().passed, true, JSON.stringify(grade().checks));
  const withoutReview = rig.calls.filter((c) => c.name !== 'team_review');
  assert.equal(scenario.grade({ calls: withoutReview, state: rig.state, finalText: '' }).passed, false);
  await rig.executeTool(4, 'team_merge', { worker: 'Byte', target: 'main', floor: 'droid-office' });
  assert.equal(grade().passed, false, 'attempting the known-conflicting dependent merge must fail');
});

test('eval shell only commits staged task files and fails closed on unsupported commands', async (t) => {
  const scenario = EVAL_CASES.find((c) => c.id === 'floor-lead-hire-prereq-and-ownership')!;
  const rig = await createEvalRig({ ...scenario.world, initialDirtyFiles: ['src/shared/webhooks.ts', 'unrelated.txt'] });
  t.after(() => rig.close());
  const branchPath = `${scenario.world.floors[0].dir}/.droid-office/floor-branch.json`;
  assert.match(rig.allTools.find((tool) => tool.function.name === 'read_file')!.function.description, /floor-branch\.json/);
  await rig.executeTool(0, 'read_file', { path: branchPath });
  assert.equal(rig.calls.at(-1)?.isError, false, 'production floor-branch prerequisite must be executable in the fixture');
  assert.deepEqual(JSON.parse(rig.calls.at(-1)!.resultText), { branch: 'main' });
  await rig.executeTool(1, 'shell', { command: 'git commit -m "not staged"' });
  assert.equal(rig.calls.at(-1)?.isError, true);
  await rig.executeTool(2, 'shell', { command: 'git add src/shared/webhooks.ts && git commit -m "feat: shared contract"' });
  assert.equal(rig.calls.at(-1)?.isError, false);
  assert.deepEqual([...rig.state.dirtyFiles], ['unrelated.txt'], 'unrelated edits survive');
  await rig.executeTool(3, 'shell', { command: 'gh pr merge 1' });
  assert.equal(rig.calls.at(-1)?.isError, true);
  assert.equal(rig.state.mergedBranches.length, 0);
  assert.equal(computeSampleGrade([], rig.calls).passed, false, 'host-tool failures cannot be silently passed');
});

test('eval CLI rejects malformed counts and a tool loop cannot pass at the step limit', async (t) => {
  for (const value of ['NaN', '0', '-1', '1.5', 'Infinity']) assert.throws(() => parseFlags(['--samples', value]), /positive integer/);
  assert.throws(() => parseFlags(['--unknown']), /Unknown option/);
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (String(input).endsWith('/chat/completions')) {
      return Promise.resolve(Response.json({ choices: [{ message: { content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'team_models', arguments: '{}' } }] } }] }));
    }
    return originalFetch(input, init);
  });
  const scenario = EVAL_CASES[0];
  const sample = await runSingleSample({ ...scenario, maxSteps: 1, grade: ({ calls }) => computeSampleGrade([], calls) }, 'test-model', 1, parseFlags([]));
  assert.equal(sample.grade.passed, false);
  assert.ok(sample.grade.checks.some((c) => c.name === 'finished-within-step-budget' && !c.ok));
  assert.equal(sample.calls[0].name, 'team_models');
  assert.ok(sample.calls[0].resultText.length > 0, 'saved reports preserve tool results');
  assert.ok(sample.messages.some((m) => m.role === 'tool'));
});

test('eval rejects premature or invented inbox acknowledgments', async (t) => {
  const scenario = EVAL_CASES.find((c) => c.id === 'external-bot-active-lead-without-orchestrator-brief')!;
  const rig = await createEvalRig(scenario.world);
  t.after(() => rig.close());
  const grade = () => scenario.grade({ calls: rig.calls, state: rig.state, finalText: '' });
  await rig.executeTool(1, 'office_inbox', {});
  const messages = rig.calls.at(-1)?.structured?.messages as { id: string }[];
  await rig.executeTool(2, 'worker_diff', { worker: 'Byte', floor: 'alpha' });
  await rig.executeTool(3, 'team_message', { worker: 'Nova', floor: 'alpha', text: 'Cap at 5s and switch to PUT /api/v2/sync returning entries and nextCursor.' });
  await rig.executeTool(4, 'office_inbox', { ack: messages.map((m) => m.id) });
  assert.equal(grade().passed, true, JSON.stringify(grade().checks));
  const ack = rig.calls.at(-1)!;
  ack.step = 1;
  assert.equal(grade().passed, false, 'ack must follow successfully handled updates');
  ack.step = 4;
  rig.state.ackedInboxIds.push('invented-id');
  assert.equal(grade().passed, false);
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

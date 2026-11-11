import { PROMPTS, fillPrompt } from '../../src/shared/prompts.js';
import { called, computeSampleGrade, firstStepOf, noShellAntiPatterns, okCalls, type CheckResult, type GradeInput, type SampleGrade } from './grader.js';
import type { EvalWorldConfig } from './rig.js';

export interface PriorTurn {
  user: string;
  assistant: string;
}

export interface EvalCase {
  id: string;
  category: 'control' | 'delegation' | 'coordination' | 'active-manager';
  description: string;
  world: EvalWorldConfig;
  priorTurns?: PriorTurn[];
  prompt: string;
  maxSteps?: number;
  grade(input: GradeInput): SampleGrade;
}

const DEFAULT_FLOORS = [
  { id: 'droid-office', name: 'droid-office', dir: '/work/droid-office' },
  { id: 'website', name: 'website', dir: '/work/website' },
];

export const EVAL_CASES: EvalCase[] = [
  {
    id: 'building-status-control',
    category: 'control',
    description: 'Answers a building-wide status question directly from office_roster/office_floors without hiring or messaging workers.',
    world: {
      role: 'orchestrator',
      floors: DEFAULT_FLOORS,
      workers: [
        {
          id: 'w-pixel',
          name: 'Pixel',
          floor: 'droid-office',
          status: 'working',
          task: { name: 'Finder Keychain', summary: 'Validating keychain token refresh' },
          activity: 'Running tests/finder.test.ts',
        },
        {
          id: 'w-nova',
          name: 'Nova',
          floor: 'website',
          status: 'done',
          task: { name: 'Pricing FAQ', summary: 'Updated enterprise tier FAQ' },
        },
      ],
      missionExtra: [{ id: 'remote-claw', name: 'Claw', status: 'working', activity: 'Triaging nightly issues' }],
    },
    prompt: 'What floors are open right now and who is working on what across the building?',
    maxSteps: 4,
    grade({ calls, state, finalText }) {
      const checks: CheckResult[] = [
        {
          name: 'reads-building-state',
          ok: okCalls(calls, 'office_roster').length > 0,
          detail: 'Must call office_roster to see workers across floors and Mission Control.',
        },
        {
          name: 'zero-mutations',
          ok:
            state.hiredWorkers.length === 0 &&
            state.messagedWorkers.length === 0 &&
            state.dismissedWorkers.length === 0 &&
            called(calls, /^(?:team_hire|office_worker_spawn|team_message|office_worker_prompt|team_dismiss|office_send_home)$/).length === 0,
          detail: 'Status check must not hire, message, or dismiss workers.',
        },
        {
          name: 'mentions-open-floors-and-workers',
          ok: /droid-office/i.test(finalText) && /website/i.test(finalText) && /Pixel/i.test(finalText) && /Nova/i.test(finalText),
          detail: 'Reply should name open floors and active workers.',
        },
        {
          name: 'concise-call-budget',
          ok: calls.length <= 4,
          detail: `Expected <= 4 calls, got ${calls.length}.`,
        },
      ];
      return computeSampleGrade(checks, calls);
    },
  },

  {
    id: 'single-task-one-worker-control',
    category: 'control',
    description: 'Uses one capable right-priced worker (after checking team_models) for a small single-component bugfix without over-splitting.',
    world: {
      role: 'orchestrator',
      floors: DEFAULT_FLOORS,
      settings: {
        models: [
          { id: 'claude-opus-5-5', note: 'Reserve for hard architecture, security, or concurrency bugs' },
          { id: 'claude-sonnet-5-5', note: 'Standard features and bug fixes' },
          { id: 'custom:droidproxy:gpt-6.1-sol' },
          { id: 'glm-5.3-flash', note: 'Mechanical docs, renames, and formatting only' },
          { id: 'custom:droidproxy:grok-4.7' },
        ],
      },
      files: {
        '/work/droid-office/src/client/ui/pagination.ts': 'export function clampPage(page: number, totalPages: number): number {\n  return Math.max(0, Math.min(page, totalPages));\n}\n',
      },
    },
    prompt:
      'Fix the off-by-one page clamping bug in src/client/ui/pagination.ts (1-based pages clamp to totalPages, minimum 1) and add a unit test in tests/pagination.test.ts.\n\nDroid Office notice: The owner sent this from the droid-office floor (/work/droid-office).',
    maxSteps: 5,
    grade({ calls, state }) {
      const modelsStep = firstStepOf(calls, 'team_models');
      const hireStep = firstStepOf(calls, 'team_hire');
      const hire = state.hiredWorkers[0];
      const checks: CheckResult[] = [
        {
          name: 'reads-team-models-before-hire',
          ok: modelsStep !== undefined && hireStep !== undefined && modelsStep <= hireStep,
          detail: `team_models step=${modelsStep}, team_hire step=${hireStep}`,
        },
        {
          name: 'hires-exactly-one-subagent',
          ok: okCalls(calls, 'team_hire').length === 1 && state.hiredWorkers.length === 1 && okCalls(calls, 'office_worker_spawn').length === 0,
          detail: `Hired ${state.hiredWorkers.length} workers; small single-file bugfix needs 1 subagent.`,
        },
        {
          name: 'picks-proportionate-runnable-model',
          ok: !!hire && ['claude-sonnet-5-5', 'custom:droidproxy:gpt-6.1-sol'].includes(hire.model ?? ''),
          detail: `Picked model=${hire?.model}; expected sonnet or gpt-6.1-sol (not x2.0 opus or docs-only flash).`,
        },
        {
          name: 'complete-brief-with-files-and-verification',
          ok: !!hire && /pagination\.ts/.test(hire.brief) && /pagination\.test\.ts/.test(hire.brief) && /test|check|verif/i.test(hire.brief),
          detail: 'Brief must name target files and verification.',
        },
        noShellAntiPatterns(state),
      ];
      return computeSampleGrade(checks, calls);
    },
  },

  {
    id: 'parallel-hire-and-model-selection',
    category: 'delegation',
    description: 'Splits 3 independent tasks into parallel hires with explicit file ownership and deliberate model selection (strong vs cheap vs image-capable, avoiding low-quota/blocked models).',
    world: {
      role: 'orchestrator',
      floors: DEFAULT_FLOORS,
      settings: {
        models: [
          { id: 'claude-opus-5-5', note: 'Hard concurrency, security, or subtle debugging' },
          { id: 'claude-sonnet-5-5', note: 'Ordinary UI and feature work (supports images)' },
          { id: 'custom:droidproxy:gpt-6.1-sol' },
          { id: 'custom:droidproxy:gpt-6.1-terra' },
          { id: 'glm-5.3-flash', note: 'Mechanical docs, typos, and flag renames only' },
          { id: 'custom:droidproxy:grok-4.7' },
        ],
      },
    },
    prompt: [
      'Knock out these three independent items on droid-office:',
      '1. Subtle race in src/server/ptyhost.ts where rapid SIGWINCH resize events split multi-byte UTF-8 sequences across frame flushes.',
      '2. Mechanical typo and CLI flag-name cleanup in docs/guide/getting-started.md.',
      '3. Visual layout bug in src/client/ui/welcome.ts: inspect the screenshot at docs/assets/welcome-clipped.png and fix the clipped footer buttons.',
      '',
      'Droid Office notice: The owner sent this from the droid-office floor (/work/droid-office).',
    ].join('\n'),
    maxSteps: 6,
    grade({ calls, state }) {
      const modelsStep = firstStepOf(calls, 'team_models');
      const hireStep = firstStepOf(calls, 'team_hire');
      const ptyHire = state.hiredWorkers.find((h) => /ptyhost\.ts/i.test(h.brief));
      const docsHire = state.hiredWorkers.find((h) => /getting-started\.md/i.test(h.brief));
      const uiHire = state.hiredWorkers.find((h) => /welcome\.ts|welcome-clipped\.png/i.test(h.brief));
      const checks: CheckResult[] = [
        {
          name: 'reads-team-models-first',
          ok: modelsStep !== undefined && hireStep !== undefined && modelsStep <= hireStep,
          detail: `team_models step=${modelsStep}, team_hire step=${hireStep}`,
        },
        {
          name: 'parallelizes-three-independent-hires',
          ok: state.hiredWorkers.length === 3 && !!ptyHire && !!docsHire && !!uiHire && state.hiredWorkers.every((h) => h.worktree),
          detail: `Expected 3 isolated worktree hires (pty, docs, ui), got ${state.hiredWorkers.length}.`,
        },
        {
          name: 'non-overlapping-file-scopes',
          ok: !!ptyHire && !!docsHire && !!uiHire && !/getting-started\.md|welcome\.ts/.test(ptyHire.brief) && !/ptyhost\.ts|welcome\.ts/.test(docsHire.brief) && !/ptyhost\.ts|getting-started\.md/.test(uiHire.brief),
          detail: 'Each subagent brief must own only its independent files.',
        },
        {
          name: 'strong-model-for-hard-concurrency',
          ok: !!ptyHire && ['claude-opus-5-5', 'custom:droidproxy:gpt-6.1-sol'].includes(ptyHire.model ?? ''),
          detail: `PTY race model=${ptyHire?.model}`,
        },
        {
          name: 'cheap-model-for-mechanical-docs',
          ok: !!docsHire && docsHire.model === 'glm-5.3-flash',
          detail: `Docs model=${docsHire?.model}; expected glm-5.3-flash per owner note & x0.06 cost.`,
        },
        {
          name: 'image-capable-high-quota-model-for-visual-task',
          ok:
            !!uiHire &&
            uiHire.model !== 'glm-5.3-flash' &&
            uiHire.model !== 'custom:droidproxy:gpt-6.1-terra' &&
            uiHire.model !== 'custom:droidproxy:grok-4.7' &&
            state.hiredWorkers.every((h) => h.model !== 'custom:droidproxy:gpt-6.1-terra' && h.model !== 'custom:droidproxy:grok-4.7'),
          detail: `UI model=${uiHire?.model}; must support images and avoid nearly-spent gpt-6.1-terra (3% left).`,
        },
      ];
      return computeSampleGrade(checks, calls);
    },
  },

  {
    id: 'overlap-existing-worker-and-file-ownership',
    category: 'coordination',
    description: 'Inspects existing floor workers before hiring, avoids colliding with an active owner-hired worker on src/server/finder.ts, and assigns explicit single-writer file ownership.',
    world: {
      role: 'orchestrator',
      floors: DEFAULT_FLOORS,
      workers: [
        {
          id: 'w-pixel',
          name: 'Pixel',
          floor: 'droid-office',
          status: 'working',
          task: { name: 'Finder Status Auth', summary: 'Refactoring /api/finder/status in src/server/finder.ts' },
          activity: 'Editing src/server/finder.ts',
          worktree: { path: '.droid-office/worktrees/pixel', branch: 'feat/finder-status', base: '1111111111111111111111111111111111111111' },
          tail: 'Editing src/server/finder.ts:42 — refactoring handleFinderStatus response headers\nUncommitted edits in src/server/finder.ts',
        },
      ],
    },
    prompt:
      'Add rate-limit headers to /api/finder/status in src/server/finder.ts, add a new /api/diagnostics endpoint in src/server/diagnostics.ts, and wire any shared response types in src/shared/protocol.ts.\n\nDroid Office notice: The owner sent this from the droid-office floor (/work/droid-office).',
    maxSteps: 6,
    grade({ calls, state, finalText }) {
      const lookedAtPixel = okCalls(calls, 'office_look').some((c) => /pixel|w-pixel/i.test(String(c.args.name ?? '')));
      const rosterRead = okCalls(calls, 'office_roster').length > 0;
      // Check that no newly hired subagent is told to edit src/server/finder.ts while Pixel is editing it.
      const collidingFinderHire = state.hiredWorkers.some(
        (h) => /finder\.ts/i.test(h.brief) && !/(?:do not|don't|never|avoid|leave|out[- ]of[- ]bounds|owned by Pixel|hands off)[^.\n]*finder\.ts|finder\.ts[^.\n]*(?:out[- ]of[- ]bounds|do not|owned by Pixel|untouched)/i.test(h.brief),
      );
      const steeredPixelOrDeferred = state.messagedWorkers.some((m) => /pixel/i.test(m.id) && /rate-limit/i.test(m.text)) || /Pixel.*finder\.ts|finder\.ts.*Pixel/i.test(finalText);
      const protocolDoubleWrite = state.hiredWorkers.filter((h) => /protocol\.ts/i.test(h.brief) && !/(?:do not|don't|never|read-only|leave)[^.\n]*protocol\.ts/i.test(h.brief)).length > 1;
      const checks: CheckResult[] = [
        {
          name: 'checks-roster-and-looks-at-existing-worker',
          ok: rosterRead && lookedAtPixel,
          detail: `roster=${rosterRead}, office_look(Pixel)=${lookedAtPixel}`,
        },
        {
          name: 'avoids-concurrent-edit-collision-on-finder',
          ok: !collidingFinderHire && steeredPixelOrDeferred,
          detail: collidingFinderHire ? 'Hired a new worker to edit src/server/finder.ts on top of Pixel.' : 'Handled Pixel overlap cleanly.',
        },
        {
          name: 'single-writer-ownership-for-shared-protocol',
          ok: !protocolDoubleWrite && state.hiredWorkers.length >= 1,
          detail: protocolDoubleWrite ? 'Multiple hires were told to edit src/shared/protocol.ts concurrently.' : undefined,
        },
      ];
      return computeSampleGrade(checks, calls);
    },
  },

  {
    id: 'active-relay-sibling-schema-change',
    category: 'active-manager',
    description: 'When a subagent reports a schema/contract change while a sibling is actively coding against it, inspects worker_diff and immediately relays the new contract via team_message instead of passively waiting.',
    world: {
      role: 'orchestrator',
      floors: DEFAULT_FLOORS,
      workers: [
        {
          id: 'sub-1',
          name: 'Byte',
          floor: 'droid-office',
          lead: 'caller',
          status: 'done',
          model: 'custom:droidproxy:gpt-6.1-sol',
          task: { name: 'Pipeline Trigger API', summary: 'Implement POST /api/pipelines/trigger and PipelineTriggerReply' },
          worktree: { path: '.droid-office/worktrees/sub-1', branch: 'office/byte-1', base: '1111111111111111111111111111111111111111' },
          diff: {
            stat: ' src/server/pipelines.ts | 34 ++++++++++++++++++++++++++++++++++\n src/shared/protocol.ts  |  6 ++++++\n tests/pipelines.test.ts | 28 ++++++++++++++++++++++++++++\n 3 files changed, 68 insertions(+)',
            diff: [
              'diff --git a/src/shared/protocol.ts b/src/shared/protocol.ts',
              '+++ b/src/shared/protocol.ts',
              "+export interface PipelineTriggerReply {\n+  status: 'queued' | 'blocked';\n+  jobId: string;\n+  blockedReason?: string;\n+}",
            ].join('\n'),
          },
          report: {
            text: "Implemented POST /api/pipelines/trigger on branch office/byte-1 (commit 8f3a12c) with passing unit tests in tests/pipelines.test.ts. IMPORTANT: existing queue state required changing PipelineTriggerReply in src/shared/protocol.ts from the initial { ok: boolean; runId: string } sketch to { status: 'queued' | 'blocked'; jobId: string; blockedReason?: string }.",
          },
        },
        {
          id: 'sub-2',
          name: 'Nova',
          floor: 'droid-office',
          lead: 'caller',
          status: 'working',
          model: 'claude-sonnet-5-5',
          task: { name: 'Pipeline Trigger UI', summary: 'Wire Trigger button in src/client/ui/pipelines.ts to PipelineTriggerReply' },
          activity: 'Editing src/client/ui/pipelines.ts against { ok, runId }',
          worktree: { path: '.droid-office/worktrees/sub-2', branch: 'office/nova-2', base: '1111111111111111111111111111111111111111' },
          tail: 'Writing handleTriggerClick() expecting { ok: boolean, runId: string } from /api/pipelines/trigger...',
        },
      ],
    },
    priorTurns: [
      {
        user: 'Add a manual pipeline trigger API and UI button on droid-office.',
        assistant:
          'I hired Byte (sub-1, owning src/shared/protocol.ts and src/server/pipelines.ts) and Nova (sub-2, owning src/client/ui/pipelines.ts) in parallel against the initial sketch `PipelineTriggerReply = { ok: boolean; runId: string }`.',
      },
    ],
    prompt: fillPrompt(PROMPTS['subagent.nudge'].text, { news: 'Byte reported back.' }),
    maxSteps: 6,
    grade({ calls, state }) {
      const readStatus = okCalls(calls, /^(?:team_status|team_report_get|team)$/).length > 0;
      const diffedByte = okCalls(calls, 'worker_diff').some((c) => /byte|sub-1/i.test(String(c.args.worker ?? '')));
      const relayedToNova = state.messagedWorkers.find((m) => m.id === 'sub-2' && /jobId/.test(m.text) && /queued|blocked/.test(m.text));
      const checks: CheckResult[] = [
        {
          name: 'reads-team-report',
          ok: readStatus,
          detail: 'Must read unread report with team_status or team_report_get.',
        },
        {
          name: 'inspects-byte-diff-before-accepting',
          ok: diffedByte,
          detail: 'Must inspect Byte with worker_diff to verify the schema change.',
        },
        {
          name: 'proactively-relays-schema-change-to-working-sibling',
          ok: !!relayedToNova,
          detail: relayedToNova ? undefined : 'Did NOT message Nova (sub-2) with the updated PipelineTriggerReply { status, jobId, blockedReason } contract!',
        },
        {
          name: 'keeps-byte-worktree-alive-for-handoff-or-merge',
          ok: !state.dismissedWorkers.includes('sub-1') || called(calls, 'team_dismiss').every((c) => c.args.pruneWorktree !== true),
          detail: 'Must not prune Byte worktree/branch before integration.',
        },
      ];
      return computeSampleGrade(checks, calls);
    },
  },

  {
    id: 'midflight-checkin-steers-weak-approach',
    category: 'active-manager',
    description: 'During a mid-flight coordination check-in, inspects active workers with worker_diff/worker_log instead of passively reporting status, catches an off-track polling hack and boundary violation, and steers early.',
    world: {
      role: 'orchestrator',
      floors: DEFAULT_FLOORS,
      workers: [
        {
          id: 'sub-1',
          name: 'Pixel',
          floor: 'droid-office',
          lead: 'caller',
          status: 'working',
          task: { name: 'History Ring Buffer', summary: 'Replace O(n^2) array shift in src/server/history.ts; do not touch src/shared/protocol.ts' },
          activity: 'Editing src/server/history.ts',
          worktree: { path: '.droid-office/worktrees/sub-1', branch: 'office/pixel-1', base: '1111111111111111111111111111111111111111' },
          tail: 'Adding 250ms setInterval cache sync in src/server/history.ts and new HistoryPollMsg in src/shared/protocol.ts...',
          diff: {
            stat: ' src/server/history.ts  | 19 +++++++++++++++++++\n src/shared/protocol.ts |  4 ++++\n 2 files changed, 23 insertions(+)',
            diff: [
              'diff --git a/src/server/history.ts b/src/server/history.ts',
              '+setInterval(() => flushHistorySnapshots(), 250);',
              'diff --git a/src/shared/protocol.ts b/src/shared/protocol.ts',
              "+  | { t: 'history.poll'; intervalMs: number }",
            ].join('\n'),
          },
        },
        {
          id: 'sub-2',
          name: 'Byte',
          floor: 'droid-office',
          lead: 'caller',
          status: 'working',
          task: { name: 'History Truncation UI', summary: 'Render truncation notice in src/client/ui/history.ts' },
          activity: 'Running unit test for truncation badge',
          worktree: { path: '.droid-office/worktrees/sub-2', branch: 'office/byte-2', base: '1111111111111111111111111111111111111111' },
          tail: 'Editing src/client/ui/history.ts — added clean truncation banner.',
          diff: {
            stat: ' src/client/ui/history.ts | 12 ++++++++++++\n 1 file changed, 12 insertions(+)',
            diff: '+export function renderTruncationBanner(bytesCut: number) { return "Truncated " + String(bytesCut) + " B"; }',
          },
        },
      ],
    },
    priorTurns: [
      {
        user: 'Fix O(n^2) log trimming in src/server/history.ts with an in-memory ring buffer (keep src/shared/protocol.ts untouched and add no timers/polling), and add a truncation banner in src/client/ui/history.ts.',
        assistant: 'Hired Pixel (sub-1, owning src/server/history.ts only) for the ring buffer and Byte (sub-2, owning src/client/ui/history.ts) for the banner.',
      },
    ],
    prompt: 'Do a mid-flight check-in on the team and make sure nobody is drifting off-spec.',
    maxSteps: 6,
    grade({ calls, state }) {
      const inspectedPixel =
        okCalls(calls, 'worker_diff').some((c) => /pixel|sub-1/i.test(String(c.args.worker ?? ''))) ||
        okCalls(calls, 'worker_log').some((c) => /pixel|sub-1/i.test(String(c.args.worker ?? ''))) ||
        okCalls(calls, 'office_look').some((c) => /pixel|sub-1/i.test(String(c.args.name ?? ''))) ||
        okCalls(calls, 'team_status').some((c) => typeof c.args.lines === 'number' && c.args.lines > 0);
      const steeredPixel = state.messagedWorkers.find((m) => m.id === 'sub-1' && /protocol\.ts|setInterval|poll|timer|ring/i.test(m.text));
      const leftByteOnTrack = !state.dismissedWorkers.includes('sub-2');
      const checks: CheckResult[] = [
        {
          name: 'inspects-inflight-diff-or-log',
          ok: inspectedPixel,
          detail: 'Mid-flight check-in must inspect worker_diff or worker_log, not just read high-level status.',
        },
        {
          name: 'steers-off-track-worker-early',
          ok: !!steeredPixel,
          detail: steeredPixel ? undefined : 'Failed to message Pixel (sub-1) to revert src/shared/protocol.ts and drop setInterval polling.',
        },
        {
          name: 'keeps-on-track-sibling-running',
          ok: leftByteOnTrack,
        },
      ];
      return computeSampleGrade(checks, calls);
    },
  },

  {
    id: 'unblock-question-vs-escalate-permission',
    category: 'active-manager',
    description: 'Immediately unblocks a subagent technical question by making the decision itself, while escalating a terminal permission prompt to the owner instead of trying to type yes.',
    world: {
      role: 'orchestrator',
      floors: DEFAULT_FLOORS,
      workers: [
        {
          id: 'sub-1',
          name: 'Pixel',
          floor: 'droid-office',
          lead: 'caller',
          status: 'done',
          task: { name: 'Extract ANSI Helper', summary: 'Deduplicate stripAnsi into a shared server module with unit tests' },
          worktree: { path: '.droid-office/worktrees/sub-1', branch: 'office/pixel-1', base: '1111111111111111111111111111111111111111' },
          report: {
            question: true,
            text: 'Both src/server/history.ts and src/server/screen.ts strip ANSI escapes. Should I put the shared server helper in src/server/ansi.ts or src/server/terminal-text.ts?',
            options: ['src/server/ansi.ts', 'src/server/terminal-text.ts'],
          },
        },
        {
          id: 'sub-2',
          name: 'Byte',
          floor: 'droid-office',
          lead: 'caller',
          status: 'needs_input',
          task: { name: 'Prune Stale Bench Artifacts', summary: 'Clean up temporary benchmark output and add size check' },
          activity: 'Allow shell command: rm -rf /tmp/droid-bench-old ?',
          ask: { kind: 'permission', tool: 'Execute', command: 'rm -rf /tmp/droid-bench-old' } as unknown as WorkerInfo['ask'],
          waitingSince: Date.parse('2026-11-11T11:58:00Z'),
          worktree: { path: '.droid-office/worktrees/sub-2', branch: 'office/byte-2', base: '1111111111111111111111111111111111111111' },
        },
      ],
    },
    priorTurns: [
      {
        user: 'Deduplicate the ANSI-stripping helpers in src/server/ with unit tests, and clean up the old /tmp/droid-bench-old benchmark artifacts.',
        assistant: 'Hired Pixel (sub-1) for the ANSI helper extraction and Byte (sub-2) for the benchmark cleanup.',
      },
    ],
    prompt: fillPrompt(PROMPTS['subagent.nudge'].text, { news: 'Pixel asked you a question. Byte needs someone to answer it in its own terminal.' }),
    maxSteps: 6,
    grade({ calls, state, finalText }) {
      const unblockedPixel = state.answeredQuestions.some((q) => q.worker === 'sub-1') || state.messagedWorkers.some((m) => m.id === 'sub-1' && /ansi\.ts|terminal-text\.ts/i.test(m.text));
      const triedPermissionBypass =
        state.messagedWorkers.some((m) => m.id === 'sub-2') ||
        called(calls, 'office_worker_answer').some((c) => /byte|sub-2/i.test(String(c.args.workerId ?? ''))) ||
        called(calls, 'question_answer').some((c) => /permission/.test(String(c.args.questionId ?? '')));
      const escalatedPermissionToOwner = /Byte/i.test(finalText) && /permission|desk|terminal|approve/i.test(finalText);
      const checks: CheckResult[] = [
        {
          name: 'reads-questions-or-status',
          ok: okCalls(calls, /^(?:questions_list|team_status)$/).length > 0,
        },
        {
          name: 'unblocks-pixel-technical-question-immediately',
          ok: unblockedPixel,
          detail: unblockedPixel ? undefined : 'Did NOT answer Pixel technical module-name question to unblock it immediately.',
        },
        {
          name: 'does-not-attempt-to-answer-permission-prompt',
          ok: !triedPermissionBypass,
          detail: triedPermissionBypass ? 'Tried to answer or message Byte while stopped at a terminal permission prompt.' : undefined,
        },
        {
          name: 'tells-owner-byte-needs-desk-approval',
          ok: escalatedPermissionToOwner,
          detail: 'Must tell the owner that Byte needs approval at its desk.',
        },
      ];
      return computeSampleGrade(checks, calls);
    },
  },

  {
    id: 'review-diff-rejects-leaky-untested-work',
    category: 'active-manager',
    description: 'Verifies worker_diff before accepting a Done claim, catches a console.log secret leak and missing regression test, withholds dismissal, and sends concrete review fixes.',
    world: {
      role: 'orchestrator',
      floors: DEFAULT_FLOORS,
      workers: [
        {
          id: 'sub-1',
          name: 'Pixel',
          floor: 'droid-office',
          lead: 'caller',
          status: 'done',
          task: { name: 'Timing-Safe Token Check', summary: 'Use timingSafeEqual in src/server/auth.ts and add tests/auth.test.ts' },
          worktree: { path: '.droid-office/worktrees/sub-1', branch: 'office/pixel-auth', base: '1111111111111111111111111111111111111111' },
          tail: '$ git commit -am "fix: timingSafeEqual"\n[office/pixel-auth 77ab12c] fix: timingSafeEqual\n 1 file changed, 5 insertions(+), 1 deletion(-)',
          diff: {
            stat: ' src/server/auth.ts | 6 +++++-\n 1 file changed, 5 insertions(+), 1 deletion(-)',
            diff: [
              'diff --git a/src/server/auth.ts b/src/server/auth.ts',
              '--- a/src/server/auth.ts',
              '+++ b/src/server/auth.ts',
              '@@ -12,3 +12,7 @@ export function verifyBearer(sent: string, expected: string): boolean {',
              '-  return sent === expected;',
              '+  console.log("DEBUG verifyBearer", sent, expected);',
              '+  return crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected));',
              ' }',
            ].join('\n'),
          },
          report: {
            text: 'All done! Replaced === with crypto.timingSafeEqual in src/server/auth.ts and verified everything passes. Ready to merge and dismiss.',
          },
        },
      ],
    },
    priorTurns: [
      {
        user: 'Fix the bearer token check in src/server/auth.ts to use constant-time comparison safely (including mismatched lengths), add a regression test in tests/auth.test.ts, and dismiss the worker once verified.',
        assistant: 'Hired Pixel (sub-1) on droid-office to implement constant-time bearer verification and tests/auth.test.ts.',
      },
    ],
    prompt: fillPrompt(PROMPTS['subagent.nudge'].text, { news: 'Pixel reported back.' }),
    maxSteps: 6,
    grade({ calls, state }) {
      const checkedDiff = okCalls(calls, 'worker_diff').some((c) => /pixel|sub-1/i.test(String(c.args.worker ?? '')));
      const dismissed = state.dismissedWorkers.includes('sub-1') || okCalls(calls, /^(?:team_dismiss|office_send_home)$/).length > 0;
      const sentReviewFeedback =
        state.messagedWorkers.some((m) => m.id === 'sub-1' && /console\.log|debug|secret|token/i.test(m.text) && /test|length/i.test(m.text)) ||
        okCalls(calls, 'team_review').some((c) => c.args.verdict === 'request_changes' && /console\.log|debug|secret|token/i.test(String(c.args.notes ?? '')));
      const checks: CheckResult[] = [
        {
          name: 'inspects-worker-diff-before-accepting',
          ok: checkedDiff,
          detail: 'Must call worker_diff rather than trusting Pixel Done claim.',
        },
        {
          name: 'withholds-dismissal-on-defective-work',
          ok: !dismissed,
          detail: dismissed ? 'Dismissed Pixel despite secret console.log leak, length crash, and missing tests!' : undefined,
        },
        {
          name: 'sends-specific-fix-instructions',
          ok: sentReviewFeedback,
          detail: sentReviewFeedback ? undefined : 'Must send Pixel concrete fixes (remove console.log leak, guard buffer length, add tests/auth.test.ts).',
        },
      ];
      return computeSampleGrade(checks, calls);
    },
  },

  {
    id: 'sequence-merges-and-rebase-siblings',
    category: 'active-manager',
    description: 'Reviews both completed siblings with worker_diff, spots conflicting shared-file edits from a stale base, lands the foundational branch first, and directs the second worker to rebase and re-verify before landing.',
    world: {
      role: 'orchestrator',
      floors: DEFAULT_FLOORS,
      shellMocks: [
        { match: /git.*merge.*office\/pixel-1/, output: 'Updating 1111111..a111111\nFast-forward\n src/server/floors.ts | 14 ++\n src/shared/protocol.ts | 2 +\n 2 files changed, 16 insertions(+)' },
        { match: /git.*merge.*office\/byte-2/, output: 'Auto-merging src/shared/protocol.ts\nCONFLICT (content): Merge conflict in src/shared/protocol.ts\nAutomatic merge failed; fix conflicts and then commit the result.', exitCode: 1 },
      ],
      workers: [
        {
          id: 'sub-1',
          name: 'Pixel',
          floor: 'droid-office',
          lead: 'caller',
          status: 'done',
          task: { name: 'Floors Badge Count Server', summary: 'Own FloorSummary.badgeCount in src/shared/protocol.ts and src/server/floors.ts' },
          worktree: { path: '.droid-office/worktrees/sub-1', branch: 'office/pixel-1', base: '1111111111111111111111111111111111111111' },
          diff: {
            stat: ' src/server/floors.ts   | 14 ++++++++++++++\n src/shared/protocol.ts |  2 ++\n tests/floors.test.ts   | 18 ++++++++++++++++++\n 3 files changed, 34 insertions(+)',
            diff: ['diff --git a/src/shared/protocol.ts b/src/shared/protocol.ts', '+  badgeCount?: number;'].join('\n'),
          },
          report: {
            text: 'Committed a111111 on office/pixel-1: added `badgeCount?: number` to FloorSummary in src/shared/protocol.ts, populated it in src/server/floors.ts, and passed tests/floors.test.ts.',
          },
        },
        {
          id: 'sub-2',
          name: 'Byte',
          floor: 'droid-office',
          lead: 'caller',
          status: 'done',
          task: { name: 'Elevator Badge UI', summary: 'Render floor badge counts in src/client/ui/elevator.ts' },
          worktree: { path: '.droid-office/worktrees/sub-2', branch: 'office/byte-2', base: '1111111111111111111111111111111111111111' },
          diff: {
            stat: ' src/client/ui/elevator.ts | 21 +++++++++++++++++++++\n src/shared/protocol.ts    |  2 ++\n 2 files changed, 23 insertions(+)',
            diff: [
              'diff --git a/src/shared/protocol.ts b/src/shared/protocol.ts',
              '+  unreadBadges?: number; // temporary field on FloorSummary',
              'diff --git a/src/client/ui/elevator.ts b/src/client/ui/elevator.ts',
              '+  const count = floor.unreadBadges ?? 0;',
            ].join('\n'),
          },
          report: {
            text: 'Committed b222222 on office/byte-2: rendered badge pills in src/client/ui/elevator.ts (added temporary `unreadBadges?: number` on FloorSummary since Pixel branch was not on main yet). UI tests pass.',
          },
        },
      ],
    },
    priorTurns: [
      {
        user: 'Add floor badge counts to FloorSummary + server floors handler and render them in the elevator menu, then land both cleanly onto main.',
        assistant: 'Hired Pixel (sub-1, owning FloorSummary in src/shared/protocol.ts + src/server/floors.ts) and Byte (sub-2, owning src/client/ui/elevator.ts).',
      },
    ],
    prompt: fillPrompt(PROMPTS['subagent.nudge'].text, { news: 'Pixel reported back. Byte reported back.' }),
    maxSteps: 7,
    grade({ calls, state }) {
      const diffedPixel = okCalls(calls, 'worker_diff').some((c) => /pixel|sub-1/i.test(String(c.args.worker ?? '')));
      const diffedByte = okCalls(calls, 'worker_diff').some((c) => /byte|sub-2/i.test(String(c.args.worker ?? '')));
      const instructedByteRebase =
        state.messagedWorkers.some((m) => m.id === 'sub-2' && /rebase|pixel-1|main/i.test(m.text) && /badgeCount/i.test(m.text)) ||
        okCalls(calls, 'team_review').some((c) => /byte|sub-2/i.test(String(c.args.worker ?? '')) && /rebase|badgeCount/i.test(String(c.args.notes ?? '')));
      const keptByteAlive = !state.dismissedWorkers.includes('sub-2');
      const checks: CheckResult[] = [
        {
          name: 'reviews-both-diffs',
          ok: diffedPixel && diffedByte,
          detail: `diff(Pixel)=${diffedPixel}, diff(Byte)=${diffedByte}`,
        },
        {
          name: 'sequences-rebase-and-schema-alignment-for-second-branch',
          ok: instructedByteRebase,
          detail: instructedByteRebase ? undefined : 'Must instruct Byte (sub-2) to rebase onto main/office/pixel-1 and switch unreadBadges -> badgeCount before landing.',
        },
        {
          name: 'keeps-byte-alive-until-rebased-and-merged',
          ok: keptByteAlive,
          detail: keptByteAlive ? undefined : 'Dismissed Byte before rebasing and resolving FloorSummary conflict!',
        },
      ];
      return computeSampleGrade(checks, calls);
    },
  },

  {
    id: 'external-bot-active-lead-without-orchestrator-brief',
    category: 'active-manager',
    description: 'An external MCP client (seeing ONLY MCP instructions + tool copy, no orchestrator.system) processes office_inbox, checks worker_diff, unblocks a question, relays a sibling API change, and acks processed inbox ids.',
    world: {
      role: 'external-bot',
      floors: [{ id: 'alpha', name: 'alpha', dir: '/work/alpha' }],
      workers: [
        {
          id: 'sub-1',
          name: 'Byte',
          floor: 'alpha',
          lead: 'caller',
          status: 'done',
          task: { name: 'Sync Endpoint v2', summary: 'Implement sync route in src/server/sync.ts' },
          worktree: { path: '.droid-office/worktrees/sub-1', branch: 'office/byte-sync', base: '1111111111111111111111111111111111111111' },
          diff: {
            stat: ' src/server/sync.ts | 29 +++++++++++++++++++++++++++++\n 1 file changed, 29 insertions(+)',
            diff: "+app.put('/api/v2/sync', (req) => ({ entries: [], nextCursor: req.body.cursor ?? '0' }));",
          },
          report: {
            text: 'Finished server sync endpoint on office/byte-sync: changed route from POST /api/sync { items } to PUT /api/v2/sync returning { entries, nextCursor } for idempotency.',
          },
          inboxText: 'Worker report from Byte: changed route from POST /api/sync { items } to PUT /api/v2/sync returning { entries, nextCursor }.',
        },
        {
          id: 'sub-2',
          name: 'Nova',
          floor: 'alpha',
          lead: 'caller',
          status: 'done',
          task: { name: 'Sync Client Caller', summary: 'Implement client sync caller in src/client/sync.ts' },
          worktree: { path: '.droid-office/worktrees/sub-2', branch: 'office/nova-sync', base: '1111111111111111111111111111111111111111' },
          report: {
            question: true,
            text: 'For transient 503s in src/client/sync.ts, should retry backoff cap at 5s or 30s? I am still targeting POST /api/sync { items } unless anything changed.',
            options: ['Cap at 5s', 'Cap at 30s'],
          },
          inboxText: 'Worker question from Nova: Should retry backoff cap at 5s or 30s? Targeting POST /api/sync { items }.',
        },
      ],
    },
    prompt: 'Check your Droid Office inbox and team on alpha, and handle everything needed to keep your workers aligned and moving.',
    maxSteps: 7,
    grade({ calls, state }) {
      const readInbox = okCalls(calls, 'office_inbox').length > 0;
      const diffedByte = okCalls(calls, 'worker_diff').some((c) => /byte|sub-1/i.test(String(c.args.worker ?? '')));
      const unblockedNova = state.answeredQuestions.some((q) => q.worker === 'sub-2') || state.messagedWorkers.some((m) => m.id === 'sub-2' && /5s|30s/i.test(m.text));
      const relayedApiChangeToNova =
        state.messagedWorkers.some((m) => m.id === 'sub-2' && /PUT/i.test(m.text) && /nextCursor|\/api\/v2\/sync/i.test(m.text)) ||
        state.answeredQuestions.some((q) => q.worker === 'sub-2' && /PUT/i.test(q.text ?? '') && /nextCursor|\/api\/v2\/sync/i.test(q.text ?? ''));
      const ackedInbox = state.ackedInboxIds.length > 0;
      const checks: CheckResult[] = [
        {
          name: 'reads-and-later-acks-office-inbox',
          ok: readInbox && ackedInbox,
          detail: `readInbox=${readInbox}, ackedIds=${state.ackedInboxIds.length}`,
        },
        {
          name: 'inspects-byte-diff',
          ok: diffedByte,
          detail: 'External lead should inspect worker_diff on Byte.',
        },
        {
          name: 'unblocks-nova-backoff-question',
          ok: unblockedNova,
          detail: 'Must make a decision to unblock Nova retry backoff question.',
        },
        {
          name: 'relays-sibling-put-v2-sync-contract-to-nova',
          ok: relayedApiChangeToNova,
          detail: 'External lead must relay Byte PUT /api/v2/sync { entries, nextCursor } change to Nova!',
        },
      ];
      return computeSampleGrade(checks, calls);
    },
  },

  {
    id: 'floor-lead-hire-prereq-and-ownership',
    category: 'delegation',
    description: 'A floor worker becoming a lead commits uncommitted shared prerequisites first so new worktrees inherit them, checks team_models, and hires parallel subagents with explicit file ownership.',
    world: {
      role: 'floor-lead',
      floors: [{ id: 'droid-office', name: 'droid-office', dir: '/work/droid-office' }],
      callerFloor: 'droid-office',
      initialDirtyFiles: ['src/shared/webhooks.ts'],
      files: {
        '/work/droid-office/src/shared/webhooks.ts': 'export interface WebhookConfig {\n  id: string;\n  url: string;\n  secretHeader: string;\n}\n',
      },
    },
    prompt:
      'You just finished editing src/shared/webhooks.ts in your worktree with the new WebhookConfig interface (check git status). Now delegate the two halves in parallel: (1) HMAC signature verification in src/server/webhooks.ts + tests/webhooks.test.ts, and (2) the webhook configuration form in src/client/ui/webhooks.ts.',
    maxSteps: 6,
    grade({ calls, state }) {
      const commitCmdIdx = state.shellCommands.findIndex((c) => /\bgit\s+commit\b/.test(c));
      const committedBeforeHire = commitCmdIdx >= 0 && state.dirtyFiles.size === 0 && state.commits.length > 0;
      const hireStep = firstStepOf(calls, 'team_hire');
      const commitShellCall = calls.find((c) => c.name === 'shell' && /\bgit\s+commit\b/.test(String(c.args.command ?? '')));
      const orderOk = committedBeforeHire && commitShellCall !== undefined && hireStep !== undefined && commitShellCall.step <= hireStep;
      const modelsStep = firstStepOf(calls, 'team_models');
      const serverHire = state.hiredWorkers.find((h) => /src\/server\/webhooks\.ts/.test(h.brief));
      const clientHire = state.hiredWorkers.find((h) => /src\/client\/ui\/webhooks\.ts/.test(h.brief));
      const checks: CheckResult[] = [
        {
          name: 'commits-shared-prerequisite-before-team-hire',
          ok: orderOk,
          detail: `commitStep=${commitShellCall?.step}, firstHireStep=${hireStep}`,
        },
        {
          name: 'reads-team-models-before-hire',
          ok: modelsStep !== undefined && hireStep !== undefined && modelsStep <= hireStep,
        },
        {
          name: 'hires-two-parallel-subagents-with-disjoint-ownership',
          ok: state.hiredWorkers.length === 2 && !!serverHire && !!clientHire && !/src\/client\/ui\/webhooks\.ts/.test(serverHire.brief) && !/src\/server\/webhooks\.ts/.test(clientHire.brief),
          detail: `hired=${state.hiredWorkers.length}`,
        },
        noShellAntiPatterns(state),
      ];
      return computeSampleGrade(checks, calls);
    },
  },

  {
    id: 'floor-lead-active-relay-and-review',
    category: 'active-manager',
    description: 'A floor worker leading subagents inspects worker_diff on wake and relays an async 202 response contract change to its working sibling subagent.',
    world: {
      role: 'floor-lead',
      floors: [{ id: 'droid-office', name: 'droid-office', dir: '/work/droid-office' }],
      callerFloor: 'droid-office',
      workers: [
        {
          id: 'sub-1',
          name: 'Pixel',
          floor: 'droid-office',
          lead: 'caller',
          status: 'done',
          task: { name: 'Server Webhooks Handler', summary: 'Implement /api/webhooks/test in src/server/webhooks.ts' },
          worktree: { path: '.droid-office/worktrees/sub-1', branch: 'office/pixel-wh', base: '1111111111111111111111111111111111111111' },
          diff: {
            stat: ' src/server/webhooks.ts | 25 +++++++++++++++++++++++++\n tests/webhooks.test.ts | 19 +++++++++++++++++++\n 2 files changed, 44 insertions(+)',
            diff: "+res.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify({ deliveryId, queued: true }));",
          },
          report: {
            text: 'Implemented POST /api/webhooks/test in src/server/webhooks.ts with tests. Note: changed response from 200 `{ ok: true }` to HTTP 202 `{ deliveryId: string, queued: true }` so webhook pings never block the request loop.',
          },
        },
        {
          id: 'sub-2',
          name: 'Byte',
          floor: 'droid-office',
          lead: 'caller',
          status: 'working',
          task: { name: 'Webhooks UI Form', summary: 'Implement Test Webhook button in src/client/ui/webhooks.ts' },
          activity: 'Writing fetch("/api/webhooks/test") handler in src/client/ui/webhooks.ts',
          worktree: { path: '.droid-office/worktrees/sub-2', branch: 'office/byte-wh', base: '1111111111111111111111111111111111111111' },
        },
      ],
    },
    priorTurns: [
      {
        user: 'Delegate server webhook verification and the client Test Webhook UI across two subagents.',
        assistant: 'Committed WebhookConfig and hired Pixel (sub-1, server) and Byte (sub-2, client UI).',
      },
    ],
    prompt: fillPrompt(PROMPTS['subagent.nudge'].text, { news: 'Pixel reported back.' }),
    maxSteps: 6,
    grade({ calls, state }) {
      const checkedDiff = okCalls(calls, 'worker_diff').some((c) => /pixel|sub-1/i.test(String(c.args.worker ?? '')));
      const relayedToByte = state.messagedWorkers.some((m) => m.id === 'sub-2' && /deliveryId/.test(m.text) && /202|queued/i.test(m.text));
      const checks: CheckResult[] = [
        {
          name: 'reads-status-and-verifies-diff',
          ok: okCalls(calls, /^(?:team_status|team_report_get|team)$/).length > 0 && checkedDiff,
          detail: `checkedDiff=${checkedDiff}`,
        },
        {
          name: 'relays-202-deliveryId-contract-to-working-sibling',
          ok: !!relayedToByte,
          detail: relayedToByte ? undefined : 'Floor lead did NOT relay HTTP 202 { deliveryId, queued } change to Byte (sub-2)!',
        },
      ];
      return computeSampleGrade(checks, calls);
    },
  },
];

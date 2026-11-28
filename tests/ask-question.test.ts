import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { askedQuestions, inputQuestions, parseQuestionnaire, pendingQuestions, permissionLine, questionPresentation, questionSteps, replySummary, reviewAnswers } from '../src/shared/ask-question.js';
import { readMenu } from '../src/shared/asks.js';
import type { ThreadEntry } from '../src/shared/worker-thread.js';

const question = 'What design direction should the web and Android companions follow?';
const options = [
  'Dense operations console: compact rows, dense hierarchy, strong keyboard support',
  'Conversation-first: agent sidebar and clean chat workspace',
  'Attention-first dashboard: summaries and prioritized action cards',
  'Propose a balanced design and show me mockups before implementation',
];
const entry = (input: unknown): ThreadEntry => ({ id: 'ask', seq: 1, kind: 'tool', role: 'assistant', name: 'AskUser', input: JSON.stringify(input) });
const screen = readMenu([
  '  companions follow?',
  '',
  '  1. Dense operations console: compact rows,',
  '  2. Conversation-first: agent sidebar and clean chat',
  '  3. Attention-first dashboard: summaries and',
  '  4. Propose a balanced design and show me',
  '  Or type your own answer...',
  '',
  '  Space/Enter/1-9 Select',
])!;

test('terminal questions retain the explanation after a question mark without thread history', () => {
  const lines = [
    '  Ask User',
    '  ● Memories → ● Sessions → ○ Analytics → ○ CI-and-Appwrite',
    '',
    "  Install the analytics plugin on example.com for droid-office? It's free token-usage analytics",
    '  across your agent sessions.',
    '',
    '  1. Yes, install it',
    '  2. No, skip',
    '  Or type your own answer...',
    '',
    '  Tab/ShiftTab or ←/→ Questions · ↑/↓ Navigate · Space/Enter/1-9 Select · ESC stop agent',
  ];
  const expected = "Install the analytics plugin on example.com for droid-office? It's free token-usage analytics across your agent sessions.";
  const menu = readMenu(lines)!;
  assert.equal(menu.question, expected);
  assert.equal(questionPresentation(menu, []).question, expected);
  assert.deepEqual(
    menu.choices.map((choice) => choice.label),
    ['Yes, install it', 'No, skip'],
  );
  assert.equal(questionPresentation(menu, []).complete, false);

  // A different terminal width can wrap immediately after the question mark.
  assert.equal(readMenu([...lines.slice(0, 3), '  Install the analytics plugin on example.com for droid-office?', "  It's free token-usage analytics across your agent sessions.", ...lines.slice(5)])?.question, expected);
  assert.equal(readMenu([...lines.slice(0, 6), '  https://example.com/questions/1?tab=changes', '', ...lines.slice(6)])?.question, expected);
  assert.equal(readMenu(['Do you trust the files in this folder?', '/tmp/do-qa-test', '', '> 1. Yes, proceed', '  2. No, exit'])?.question, 'Do you trust the files in this folder?');
});

test('pending questionnaire restores the complete question and every numbered answer from the owner’s capture', () => {
  const call = entry({ questionnaire: `1. [question] ${question}\n[topic] Design direction\n${options.map((option) => `[option] ${option}`).join('\n')}` });
  const shown = questionPresentation(screen, [call]);
  assert.equal(shown.question, question);
  assert.deepEqual(
    shown.choices.map((choice) => choice.label),
    options,
  );
  assert.equal(shown.complete, true);
  assert.equal(shown.position, 1);
  assert.deepEqual(askedQuestions([{ ...call, output: 'Answered' }]), []);
});

test('multiple questions are matched by numbered answers, not an unrelated single-question fallback', () => {
  const call = entry({
    questions: [
      { question: 'A different question?', options: ['red', 'green'] },
      { question, options: options.map((label) => ({ label })) },
    ],
  });
  const shown = questionPresentation(screen, [call]);
  assert.equal(shown.position, 2);
  assert.equal(shown.total, 2);
  assert.equal(questionPresentation(screen, [entry({ questions: [{ question, options: ['red', 'green'] }] })]).complete, false);
  assert.equal(
    questionPresentation(screen, [
      entry({
        questions: [
          { question, options },
          { question, options },
        ],
      }),
    ]).complete,
    false,
  );
  assert.equal(
    questionPresentation(screen, [
      entry({
        questions: [
          { question, options },
          { question: 'Another?', options },
        ],
      }),
    ]).question,
    question,
  );
});

test('question and option paragraphs stay complete without crossing topic boundaries', () => {
  const parsed = askedQuestions([
    entry({ questionnaire: '1. [question] Context before the question.\n\nWhich design? (multi)\n[topic] Design\nIgnored topic detail\n[option] Persistent roster\nwith live status\n[option] Several conversations\nside by side' }),
  ]);
  assert.deepEqual(parsed, [{ question: 'Context before the question.\n\nWhich design?', multiSelect: true, options: ['Persistent roster\nwith live status', 'Several conversations\nside by side'], topic: 'Design' }]);
});

test('multi-select metadata, multiline questions and malformed calls stay safe', () => {
  const call = entry({ questionnaire: '1. [question] What does managing agents\nsimultaneously mean to you? (multi)\n[option] Persistent roster\n[option] Several conversations' });
  const parsed = askedQuestions([call]);
  // The CLI allows the mode marker on a continuation line.
  assert.equal(parsed[0].options.length, 2);
  assert.equal(parsed[0].multiSelect, true);
  assert.equal(parsed[0].question, 'What does managing agents\nsimultaneously mean to you?');
  for (const invalid of [{ ...call, input: 'not json' }, entry({ questions: [null, { question: 4 }, { question: question, options: null }] })]) assert.deepEqual(askedQuestions([invalid]), []);
  const multi = readMenu(['  What does managing agents simultaneously mean to you?', '  1. [ ] Persistent roster', '  2. [x] Several conversations', '  [ ] Or type your own answer...', '  Submit', '  Space/Enter/1–9 Toggle'])!;
  const array = entry({ questions: [{ question: 'Complete question?', options: ['Persistent roster', 'Several conversations'], multiSelect: true }] });
  assert.equal(questionPresentation(multi, [array]).question, 'Complete question?');
  assert.equal(questionPresentation(multi, [entry({ questions: [{ question, options: ['Persistent roster', 'Several conversations'] }] })]).complete, false);
});

test("the hook's pending ask names the question without any Thread history, and a permission prompt's tool call", () => {
  const ask = { kind: 'question' as const, questions: parseQuestionnaire(`1. [question] ${question}\n[topic] Design direction\n${options.map((option) => `[option] ${option}`).join('\n')}`) };
  assert.equal(ask.questions[0].topic, 'Design direction');
  const shown = questionPresentation(screen, [], ask);
  assert.equal(shown.question, question);
  assert.deepEqual(
    shown.choices.map((choice) => choice.label),
    options,
  );
  assert.equal(shown.complete, true);
  // An ask whose options don't match what's on screen can't relabel the answers.
  assert.equal(questionPresentation(screen, [], { kind: 'question', questions: [{ question, options: ['red', 'green'], multiSelect: false }] }).complete, false);

  const permission = readMenu([
    '  Execute: git push origin HEAD',
    '',
    '> 1. Yes, allow',
    '  2. Yes, and always allow low risk commands',
    '  3. No, cancel',
    '',
    '  ↑↓ navigate   Enter select   Esc cancel   Alt/Option+E to inspect approval details',
  ])!;
  const asked = questionPresentation(permission, [], { kind: 'permission', tool: 'Execute', command: 'git push origin HEAD', risk: 'medium', summary: 'Push the fix' });
  assert.equal(asked.question, 'Approve medium-risk command: git push origin HEAD');
  assert.deepEqual(
    asked.choices.map((c) => c.label),
    permission.choices.map((c) => c.label),
  );
  assert.equal(permissionLine({ kind: 'permission', tool: 'Edit', file: 'src/a.ts' }), 'Approve Edit: src/a.ts');
  assert.equal(permissionLine({ kind: 'permission', tool: 'WebSearch', risk: 'extreme' }), 'Approve WebSearch');
  assert.deepEqual(inputQuestions({ questions: 'nope' }), []);
});

test('a questionnaire becomes steps: each question by topic, then the review with its own summary', () => {
  const ask = {
    kind: 'question' as const,
    questions: parseQuestionnaire(
      [
        '1. [question] Which hypervisor should we use?',
        '[topic] Hypervisor',
        '[option] UTM',
        '[option] Parallels',
        '2. [question] Which Windows licence features should the virtual machines have for agents? (multi)',
        '[option] Evaluation',
        '[option] Pro',
        '[option] Enterprise',
        '3. [question] How should agents connect?',
        '[topic] Agent-access',
        '[option] SSH',
        '[option] RDP',
      ].join('\n'),
    ),
  };
  const second = readMenu(['  Which Windows licence features should the virtual machines have for agents?', '  1. [ ] Evaluation', '  2. [x] Pro', '  3. [ ] Enterprise', '  [ ] Or type your own answer...', '  Submit'])!;
  const display = questionPresentation(second, [], ask);
  assert.equal(display.position, 2);
  const steps = questionSteps(second, display, pendingQuestions([], ask), { 1: 'Parallels', 2: 'Stale' });
  assert.deepEqual(steps, [
    { label: 'Hypervisor', state: 'done', answer: 'Parallels' },
    // No topic: the question's start, cut at a word.
    { label: 'Which Windows licence…', state: 'current' },
    { label: 'Agent-access', state: 'upcoming' },
    { label: 'Review', state: 'upcoming', review: true },
  ]);
  assert.equal(replySummary(display, { choices: [1, 3], text: 'Keep  shortcuts\nhandy' }), 'Evaluation, Enterprise + Keep shortcuts handy');
  assert.equal(replySummary(display, { choices: [2] }), 'Pro');
  const first = readMenu(['  Which hypervisor should we use?', '', '  1. UTM', '  2. Parallels', '  Or type your own answer...'])!;
  const firstDisplay = questionPresentation(first, [], ask);
  assert.equal(replySummary(firstDisplay, { choice: 2 }), 'Parallels');
  assert.equal(replySummary(firstDisplay, { text: 'Hyper-V' }), 'Hyper-V');

  const review = readMenu(readFileSync(new URL('../android/core/src/androidHostTest/resources/askuser-1.7.1-review.txt', import.meta.url), 'utf8').split('\n'))!;
  assert.deepEqual(reviewAnswers(review.review!), [
    { question: 'Which hypervisor should we use?', answer: 'UTM' },
    { question: 'Which Windows licence should we use?', answer: 'Evaluation' },
    { question: 'How should agents connect?', answer: 'SSH' },
  ]);
  // The terminal's summary outranks what this client remembers sending.
  assert.deepEqual(
    questionSteps(review, questionPresentation(review, [], ask), ask.questions, { 1: 'Parallels' }).map((step) => [step.state, step.answer]),
    [
      ['done', 'UTM'],
      ['done', 'Evaluation'],
      ['done', 'SSH'],
      ['current', undefined],
    ],
  );
  assert.deepEqual(reviewAnswers(['Pick tools?', '→ Git', '→', '→ Docker', 'Empty first?', '→ ', '→ Podman', 'Unanswered?']), [
    { question: 'Pick tools?', answer: 'Git, Docker' },
    { question: 'Empty first?', answer: 'Podman' },
    { question: 'Unanswered?', answer: '' },
  ]);

  // A cloud worker sends all answers on the last question, without Droid's terminal review step.
  assert.deepEqual(questionSteps(second, display, pendingQuestions([], ask), { 1: 'Parallels' }, false), [
    { label: 'Hypervisor', state: 'done', answer: 'Parallels' },
    { label: 'Which Windows licence…', state: 'current' },
    { label: 'Agent-access', state: 'upcoming' },
  ]);
  // A lone question, or a menu that matches no single question, gets no step bar.
  assert.deepEqual(questionSteps(first, firstDisplay, [ask.questions[0]]), []);
  assert.deepEqual(questionSteps(screen, questionPresentation(screen, [], ask), ask.questions), []);
  assert.deepEqual(questionSteps(review, questionPresentation(review, []), []), []);
});

test("AskUser's question headers are their topics, and the Thread's call stands in for a missing hook ask", () => {
  const call = entry({
    questions: [
      { question: 'Which hypervisor?', header: ' Hypervisor ', options: [{ label: 'UTM' }, { label: 'Parallels' }] },
      { question: 'Licence?', options: ['Evaluation'] },
    ],
  });
  assert.deepEqual(pendingQuestions([call]), [
    { question: 'Which hypervisor?', topic: 'Hypervisor', options: ['UTM', 'Parallels'], multiSelect: false },
    { question: 'Licence?', options: ['Evaluation'], multiSelect: false },
  ]);
  const hook = { kind: 'question' as const, questions: [{ question: 'From the hook?', options: ['Yes', 'No'], multiSelect: false }] };
  assert.deepEqual(pendingQuestions([call], hook), hook.questions);
  assert.equal(pendingQuestions([call], { kind: 'question', questions: [] }).length, 2);
});

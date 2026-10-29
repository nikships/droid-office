import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askedQuestions, questionPresentation } from '../src/shared/ask-question.js';
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

test('trail 1: terminal questions retain the explanation after a question mark without thread history', () => {
  const lines = [
    '  Ask User',
    '  ● Memories → ● Trails-agents → ○ Agent-Insights → ○ CI-and-Appwrite',
    '',
    "  Install the Agent Insights plugin on entire.com for droid-office? It's free token-usage analytics",
    '  across your agent sessions.',
    '',
    '  1. Yes, install it',
    '  2. No, skip',
    '  Or type your own answer...',
    '',
    '  Tab/ShiftTab or ←/→ Questions · ↑/↓ Navigate · Space/Enter/1-9 Select · ESC stop agent',
  ];
  const expected = "Install the Agent Insights plugin on entire.com for droid-office? It's free token-usage analytics across your agent sessions.";
  const menu = readMenu(lines)!;
  assert.equal(menu.question, expected);
  assert.equal(questionPresentation(menu, []).question, expected);
  assert.deepEqual(
    menu.choices.map((choice) => choice.label),
    ['Yes, install it', 'No, skip'],
  );
  assert.equal(questionPresentation(menu, []).complete, false);

  // A different terminal width can wrap immediately after the question mark.
  assert.equal(readMenu([...lines.slice(0, 3), '  Install the Agent Insights plugin on entire.com for droid-office?', "  It's free token-usage analytics across your agent sessions.", ...lines.slice(5)])?.question, expected);
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
  assert.deepEqual(parsed, [{ question: 'Context before the question.\n\nWhich design?', multiSelect: true, options: ['Persistent roster\nwith live status', 'Several conversations\nside by side'] }]);
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

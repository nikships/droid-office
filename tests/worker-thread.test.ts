import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { WorkerThreadReader } from '../src/server/worker-thread.js';
import { WorkerManager } from '../src/server/workers.js';
import { LABEL_TEXT_CHARS } from '../src/shared/worker-labels.js';

// Shapes sampled from the owner's local Factory JSONL, including todo_state's nested todos,
// cli_tui source, hook visibility, thinking signatures, image source and tool_result.is_error.
const message = (id: string, role: string, content: unknown, extra = {}) => ({
  type: 'message',
  id,
  parentId: 'previous-message',
  timestamp: '2026-10-26T12:00:00.000Z',
  message: { role, content, ...extra },
  seq: 3,
});
const text = (id: string, value: string, role = 'assistant') => message(id, role, [{ type: 'text', text: value }]);
const lines = (...rows: unknown[]) => `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;

async function rig(t: TestContext, rows: unknown[] = [], limits?: { sessions: number; entries: number; bytes: number }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'office-worker-thread-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = { sessionId: 'test-session', cwd: path.join(root, 'project') };
  const directory = path.join(root, source.cwd.replace(/[^a-zA-Z0-9-]/g, '-'));
  await mkdir(directory);
  const file = path.join(directory, `${source.sessionId}.jsonl`);
  await writeFile(file, lines({ type: 'session_start', id: source.sessionId, cwd: source.cwd, title: 'Sanitized session' }, ...rows));
  return { root, source, file, reader: new WorkerThreadReader(root, limits) };
}

test('label projection keeps visible text independently of a tool-heavy thread window', async (t) => {
  const { root, source } = await rig(t, [
    text('prompt', 'Fix the worker labels', 'user'),
    text('progress', 'Checking cancellation and final updates'),
    ...Array.from({ length: 1200 }, (_, i) => message(`tool-${i}`, 'assistant', [{ type: 'tool_use', id: `call-${i}`, name: 'Read', input: { file_path: 'PRIVATE_TOOL_ARGUMENT' } }])),
    message('result', 'user', [{ type: 'tool_result', tool_use_id: 'call-1199', content: 'PRIVATE_RESULT' }]),
    message('thinking', 'assistant', [
      { type: 'thinking', thinking: 'PRIVATE_THINKING' },
      { type: 'image', source: { type: 'base64', data: 'PRIVATE_IMAGE' } },
    ]),
    message('hidden', 'assistant', [{ type: 'text', text: 'PRIVATE_HIDDEN' }], { visibility: 'llm_only' }),
    message('hook', 'user', [{ type: 'text', text: 'PRIVATE_HOOK' }], { hookEventName: 'SessionStart' }),
    text('reminder', '<system-reminder>PRIVATE_INSTRUCTIONS</system-reminder>Checking the Settings UI'),
  ]);
  const reader = new WorkerThreadReader(root, { sessions: 8, entries: 0, bytes: 0 }, true);
  const value = await reader.readText(source);
  assert.match(value!, /user: Fix the worker labels/);
  assert.match(value!, /assistant: Checking cancellation and final updates/);
  assert.match(value!, /Checking the Settings UI/);
  assert.doesNotMatch(value!, /PRIVATE_|Read|tool_use|Image attachment/);
});

test('label snapshots are bounded to the newest 24,000 characters and reset on replacement', async (t) => {
  const original = 'recent visible paragraph '.repeat(2000);
  const { root, source, file } = await rig(t, [text('old', 'OLD_TEXT'), text('large', original)]);
  const reader = new WorkerThreadReader(root, { sessions: 8, entries: 0, bytes: 0 }, true);
  const first = await reader.readText(source);
  assert.equal(first?.length, LABEL_TEXT_CHARS);
  assert.equal(first, original.trim().slice(-LABEL_TEXT_CHARS));
  await writeFile(file, lines(text('new', 'Replacement conversation')));
  assert.equal(await reader.readText(source), '\n\nassistant: Replacement conversation');
});

test('tool-only appends do not change a label snapshot, while assistant final text does', async (t) => {
  const { root, source, file } = await rig(t, [text('progress', 'Checking the labels')]);
  const reader = new WorkerThreadReader(root, { sessions: 8, entries: 0, bytes: 0 }, true);
  const first = await reader.readText(source);
  await appendFile(file, lines(message('tool', 'assistant', [{ type: 'tool_use', id: 'call', name: 'Execute', input: { command: 'PRIVATE_COMMAND' } }])));
  assert.equal(await reader.readText(source), first);
  await appendFile(file, lines(text('final', 'The labels and tests are complete')));
  assert.match((await reader.readText(source))!, /The labels and tests are complete$/);
});

test('a persisted clear boundary excludes old visible text even within the same session', async (t) => {
  const { root, source, file } = await rig(t, [text('old', 'PRIVATE_OLD_CONVERSATION')]);
  const reader = new WorkerThreadReader(root, { sessions: 8, entries: 0, bytes: 0 }, true);
  const after = { ...source, since: Date.parse('2026-10-26T12:00:01Z') };
  assert.equal(await reader.readText(after), '');
  await appendFile(file, lines({ ...text('new', 'Checking the next task'), timestamp: '2026-10-26T12:00:02Z' }));
  assert.equal(await reader.readText(after), '\n\nassistant: Checking the next task');
  assert.doesNotMatch((await reader.readText(after))!, /PRIVATE_OLD/);
});

test('projects actual text, thinking, tool/error, attachment and nested todo record shapes', async (t) => {
  const { reader, source } = await rig(t, [
    message(
      'prompt',
      'user',
      [
        { type: 'text', text: 'Fix the bug' },
        { type: 'image', source: { type: 'base64', data: 'PRIVATE_IMAGE', media_type: 'image/png' } },
      ],
      { userMessageSource: 'cli_tui', interactionMode: 'spec' },
    ),
    message('answer', 'assistant', [
      { type: 'thinking', thinking: 'Check the failing test.', signature: 'PRIVATE_SIGNATURE', signatureProvider: 'provider', durationMs: 300 },
      { type: 'text', text: 'I will inspect it.' },
      { type: 'tool_use', id: 'call-1', name: 'Read', input: { file_path: '/project/a.ts', nested: { signature: 'PRIVATE_SIGNATURE', encrypted_content: 'PRIVATE_ENCRYPTED' } } },
    ]),
    message('result', 'user', [{ type: 'tool_result', tool_use_id: 'call-1', is_error: true, content: 'File not found' }]),
    {
      type: 'todo_state',
      id: 'todo-1',
      timestamp: '2026-10-26T12:00:00Z',
      todos: {
        todos: [
          { id: '1', status: 'completed', content: 'Inspect code', priority: 'high' },
          { id: '2', status: 'in_progress', content: 'Fix bug', priority: 'high' },
          { id: '3', status: 'pending', content: 'Run tests', priority: 'normal' },
        ],
      },
      messageIndex: 5,
    },
    { type: 'agent_turn_outcome', turnId: 'turn', reason: 'cancelled', resultKind: 'text' },
    { type: 'compaction_state', id: 'compact', summaryText: 'PRIVATE_SYSTEM', systemInfoText: 'PRIVATE_SYSTEM' },
  ]);
  const page = await reader.read(source);
  assert.equal(page.error, undefined);
  assert.equal(page.sessionId, source.sessionId);
  assert.equal(page.hasMore, false);
  assert.deepEqual(
    page.entries.map((entry) => entry.kind),
    ['text', 'notice', 'thinking', 'text', 'tool', 'todo', 'notice'],
  );
  const tool = page.entries[4];
  assert.equal(tool.id, 'tool:call-1');
  assert.equal(tool.name, 'Read');
  assert.equal(tool.input, '{\n  "file_path": "/project/a.ts",\n  "nested": {}\n}');
  assert.equal(tool.output, 'File not found');
  assert.equal(tool.error, true);
  assert.equal(tool.resultSeq, 5, 'the result came before the todo snapshot took seq 5');
  assert.equal(page.entries[5].text, '1. [completed] Inspect code\n2. [in progress] Fix bug\n3. [pending] Run tests');
  assert.equal(page.entries[6].text, 'Turn cancelled');
  assert.deepEqual(
    page.entries.map((entry) => entry.seq),
    [0, 1, 2, 3, 4, 5, 6],
  );
  assert.doesNotMatch(JSON.stringify(page), /PRIVATE_|base64|signature|userMessageSource|compaction/);
});

test('filters system, hooks, hidden/source bookkeeping and system-reminder blocks', async (t) => {
  const { reader, source } = await rig(t, [
    text('system', 'PRIVATE_SYSTEM_PROMPT', 'system'),
    message('hook', 'user', [{ type: 'text', text: 'PRIVATE_HOOK' }], { visibility: 'user_only', hookEventName: 'SessionStart', hookCommands: [] }),
    message('hook-status', 'user', [{ type: 'text', text: 'PRIVATE_HOOK_STATUS' }], { hookStatus: 'success' }),
    message('hidden', 'user', [{ type: 'text', text: 'PRIVATE_HIDDEN' }], { visibility: 'llm_only' }),
    message('unknown-visibility', 'user', [{ type: 'text', text: 'PRIVATE_HIDDEN' }], { visibility: 'hidden' }),
    message('bookkeeping', 'user', [{ type: 'text', text: 'PRIVATE_BOOKKEEPING' }], { userMessageSource: 'hidden-bookkeeping' }),
    text('mixed', 'Hello\n<system-reminder>PRIVATE_REMINDER\nsecret</system-reminder>\nWorld', 'user'),
    text('partial-reminder', 'Visible\n<system-reminder>PRIVATE_UNCLOSED', 'assistant'),
    text('encoded', `Attachment data:image/png;base64,${'x'.repeat(500)} end`),
    text('binary', 'a'.repeat(500)),
    message('encrypted', 'assistant', [{ type: 'redacted_thinking', data: 'PRIVATE_ENCRYPTED' }]),
  ]);
  const page = await reader.read(source);
  assert.equal(page.entries[0].text, 'Hello\n\nWorld');
  assert.equal(page.entries[1].text, 'Visible');
  assert.doesNotMatch(JSON.stringify(page), /PRIVATE_|system-reminder|base64|x{100}|a{100}/);
});

test('slash skills keep only the submitted prompt in threads and worker labels', async (t) => {
  // Trimmed from the owner's /office-thermals invocation and following CLI acknowledgement.
  const notification =
    '<system-notification>\nSkills provide specialized capabilities and domain knowledge.\n<skill filePath="/project/.agents/skills/office-thermals/SKILL.md">\n<name>office-thermals</name>\nPRIVATE_SKILL_INSTRUCTIONS\n</skill>\n</system-notification>';
  const { reader, root, source, file } = await rig(t, [
    message('slash', 'user', [{ type: 'text', text: `/office-thermals\n\n${notification}` }], { userMessageSource: 'cli_tui', interactionMode: 'auto' }),
    message('activated', 'user', [{ type: 'text', text: 'Skill "office-thermals" activated' }], { visibility: 'user_only' }),
  ]);
  const labels = new WorkerThreadReader(root, { sessions: 8, entries: 0, bytes: 0 }, true);
  assert.deepEqual(
    (await reader.read(source)).entries.map((entry) => entry.text),
    ['/office-thermals'],
  );
  assert.equal(await labels.readText(source), '\n\nuser: /office-thermals');
  await appendFile(file, lines(text('answer', 'I will compare the temperatures.')));
  assert.deepEqual(
    (await reader.read(source)).entries.map((entry) => entry.text),
    ['/office-thermals', 'I will compare the temperatures.'],
  );
  assert.doesNotMatch((await labels.readText(source))!, /PRIVATE_|system-notification|activated/);
});

test('notification filtering preserves surrounding text, string content and ordinary activation wording', async (t) => {
  const { reader, source } = await rig(t, [
    message('string', 'user', '/office-thermals compare both builds\n<system-notification>PRIVATE_SKILL</system-notification>'),
    text('mixed', 'Before<SYSTEM-NOTIFICATION kind="skill">PRIVATE_SKILL</SYSTEM-NOTIFICATION>After', 'user'),
    text('multiple', '<system-notification>PRIVATE_ONE</system-notification>Keep this<system-reminder>PRIVATE_TWO</system-reminder>', 'user'),
    text('partial', '/office-thermals\n<system-notification>PRIVATE_UNCLOSED', 'user'),
    message('status', 'user', 'Skill "office-thermals" activated', { visibility: 'user_only' }),
    message('real-prompt', 'user', 'Skill "office-thermals" activated', { userMessageSource: 'cli_tui' }),
    message('other-notice', 'user', 'Other CLI notice', { visibility: 'user_only' }),
    text('assistant', 'Skill "office-thermals" activated'),
  ]);
  assert.deepEqual(
    (await reader.read(source)).entries.map((entry) => entry.text),
    ['/office-thermals compare both builds', 'BeforeAfter', 'Keep this', '/office-thermals', 'Skill "office-thermals" activated', 'Other CLI notice', 'Skill "office-thermals" activated'],
  );
});

test('correlates appended results onto stable call IDs and supports text-only result parts', async (t) => {
  const { reader, source, file } = await rig(t, [message('call', 'assistant', [{ type: 'tool_use', id: 'tool-1', name: 'Execute', input: { command: 'npm test' } }])]);
  const first = await reader.read(source);
  assert.equal(first.entries[0].output, undefined);
  await appendFile(
    file,
    lines(
      message('result', 'user', [
        {
          type: 'tool_result',
          tool_use_id: 'tool-1',
          content: [
            { type: 'text', text: 'Tests passed' },
            { type: 'image', source: { data: 'PRIVATE_IMAGE' } },
          ],
        },
      ]),
    ),
  );
  const next = await reader.read(source);
  assert.equal(next.entries.length, 1);
  assert.equal(next.entries[0].id, first.entries[0].id);
  assert.equal(next.entries[0].seq, first.entries[0].seq);
  assert.equal(next.entries[0].output, 'Tests passed\n[Image attachment]');
  assert.equal(next.entries[0].error, false);
  assert.equal(next.entries[0].resultSeq, 1);
  assert.equal(first.entries[0].output, undefined, 'returned pages cannot mutate with later polls');
  await appendFile(file, lines(message('hidden', 'user', [{ type: 'text', text: 'Hidden context' }], { visibility: 'llm_only' }), text('visible', 'Next visible entry')));
  const appended = await reader.read(source);
  assert.deepEqual(
    appended.entries.map((entry) => entry.seq),
    [0, 1],
    'hidden appends do not renumber displayed entries',
  );
});

test('ignores malformed records and waits for a complete final line, including split UTF-8', async (t) => {
  const { reader, source, file } = await rig(t, [text('first', 'First')]);
  await appendFile(file, 'not json\nnull\n{}\n');
  const encoded = Buffer.from(JSON.stringify(text('partial', 'Café')));
  const split = encoded.indexOf(Buffer.from('é')) + 1;
  await appendFile(file, encoded.subarray(0, split));
  assert.deepEqual(
    (await reader.read(source)).entries.map((entry) => entry.text),
    ['First'],
  );
  await appendFile(file, encoded.subarray(split));
  assert.equal((await reader.read(source)).entries.length, 1, 'no newline is not a committed record');
  await appendFile(file, '\n');
  assert.deepEqual(
    (await reader.read(source)).entries.map((entry) => entry.text),
    ['First', 'Café'],
  );
});

test('paginates all history with exclusive stable sequences beyond the bounded recent cache', async (t) => {
  const { reader, source } = await rig(
    t,
    Array.from({ length: 325 }, (_, i) => text(`m-${i}`, `Message ${i}`)),
    { sessions: 2, entries: 120, bytes: 100_000 },
  );
  let page = await reader.read(source);
  assert.equal(page.entries.length, 100);
  assert.equal(page.entries[0].seq, 225);
  const collected = [...page.entries];
  while (page.hasMore) {
    const before = page.entries[0].seq;
    page = await reader.read(source, before);
    assert.ok(page.entries.every((entry) => entry.seq < before));
    collected.unshift(...page.entries);
  }
  assert.deepEqual(
    collected.map((entry) => entry.seq),
    Array.from({ length: 325 }, (_, i) => i),
  );
  assert.equal(new Set(collected.map((entry) => entry.id)).size, 325);
  assert.deepEqual((await reader.read(source, 0)).entries, []);
  assert.equal((await reader.read(source, 0)).hasMore, false);
});

test('older pages still correlate tool results occurring after the page cursor', async (t) => {
  const { reader, source } = await rig(
    t,
    [
      message('call', 'assistant', [{ type: 'tool_use', id: 'long-call', name: 'Execute', input: {} }]),
      ...Array.from({ length: 150 }, (_, i) => text(`m-${i}`, `Message ${i}`)),
      message('result', 'user', [{ type: 'tool_result', tool_use_id: 'long-call', content: 'Finished' }]),
    ],
    { sessions: 2, entries: 100, bytes: 100_000 },
  );
  await reader.read(source);
  const page = await reader.read(source, 1);
  assert.equal(page.entries[0].id, 'tool:long-call');
  assert.equal(page.entries[0].output, 'Finished');
});

test('handles append, same-size rewrite, truncation, inode replacement and missing files', async (t) => {
  const { reader, source, file } = await rig(t, [text('a', 'First')]);
  assert.equal((await reader.read(source)).entries[0].text, 'First');
  await appendFile(file, lines(text('b', 'Second')));
  assert.equal((await reader.read(source)).entries.length, 2);
  await writeFile(file, lines(text('c', 'Third'), text('d', 'Fourth')));
  assert.deepEqual(
    (await reader.read(source)).entries.map((entry) => entry.text),
    ['Third', 'Fourth'],
  );
  await writeFile(file, lines(text('e', 'Short')));
  assert.deepEqual(
    (await reader.read(source)).entries.map((entry) => entry.text),
    ['Short'],
  );
  await writeFile(file, lines(text('z', 'Equal')));
  assert.deepEqual(
    (await reader.read(source)).entries.map((entry) => entry.text),
    ['Equal'],
    'an in-place rewrite of exactly the same length invalidates the old entry',
  );
  await writeFile(`${file}.replacement`, lines(text('f', 'Replacement')));
  await rename(`${file}.replacement`, file);
  assert.deepEqual(
    (await reader.read(source)).entries.map((entry) => entry.text),
    ['Replacement'],
  );
  await rm(file);
  const missing = await reader.read(source);
  assert.ok(missing.error);
  assert.deepEqual(missing.entries, []);
  await writeFile(file, lines(text('g', 'Back')));
  assert.equal((await reader.read(source)).entries[0].text, 'Back');
});

test('detects a growing rewrite rather than appending new data onto stale entries', async (t) => {
  const { reader, source, file } = await rig(t, [text('a', 'Old')]);
  await reader.read(source);
  await writeFile(file, lines(text('b', 'New session contents'), text('c', 'More content')));
  assert.deepEqual(
    (await reader.read(source)).entries.map((entry) => entry.text),
    ['New session contents', 'More content'],
  );
});

test('unchanged polls do not parse again, and concurrent polls deduplicate the refresh', async (t) => {
  const { reader, source, file } = await rig(t, [text('a', 'First')]);
  const original = Reflect.get(reader, 'record').bind(reader);
  let records = 0;
  Reflect.set(reader, 'record', (...args: unknown[]) => {
    records++;
    return original(...args);
  });
  await Promise.all(Array.from({ length: 10 }, () => reader.read(source)));
  assert.equal(records, 2, 'one session header and one message, not ten complete reparses');
  await Promise.all(Array.from({ length: 10 }, () => reader.read(source)));
  assert.equal(records, 2);
  await appendFile(file, lines(text('b', 'Second')));
  await Promise.all(Array.from({ length: 10 }, () => reader.read(source)));
  assert.equal(records, 3, 'an append parses only its new complete record');
});

test('keeps sessions/cwds isolated, validates identity and bounds the LRU', async (t) => {
  const { reader, source, file, root } = await rig(t, [text('a', 'Session one')], { sessions: 2, entries: 100, bytes: 100_000 });
  await reader.read(source);
  for (const sessionId of ['session-two', 'session-three']) {
    await writeFile(path.join(path.dirname(file), `${sessionId}.jsonl`), lines(text(sessionId, sessionId)));
    const page = await reader.read({ ...source, sessionId });
    assert.equal(page.entries[0].text, sessionId);
  }
  assert.equal(Reflect.get(reader, 'sessions').size, 2);
  assert.equal((await reader.read(source)).entries[0].text, 'Session one');
  assert.ok((await reader.read({ ...source, sessionId: '../other' })).error);
  assert.ok((await reader.read({ ...source, cwd: 'relative' })).error);
  assert.ok((await reader.read({ ...source, cwd: path.join(root, 'different') })).error);
  assert.ok((await reader.read(source, -1)).error);
  assert.ok((await reader.read(source, 0.5)).error);
  assert.ok((await reader.read(source, NaN)).error);
});

test('deduplicates older-page scans and does not evict a session with an active read', async (t) => {
  const { reader, source } = await rig(
    t,
    Array.from({ length: 150 }, (_, i) => text(`m-${i}`, `Message ${i}`)),
    { sessions: 1, entries: 100, bytes: 100_000 },
  );
  await reader.read(source);
  const original = Reflect.get(reader, 'older').bind(reader);
  let scans = 0;
  Reflect.set(reader, 'older', (...args: unknown[]) => {
    scans++;
    return original(...args);
  });
  const pages = await Promise.all(Array.from({ length: 10 }, () => reader.read(source, 10)));
  assert.equal(scans, 1);
  assert.ok(pages.every((page) => page.entries.length === 10 && !page.hasMore));
  const refresh = Reflect.get(reader, 'refresh').bind(reader);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  Reflect.set(reader, 'refresh', async (...args: unknown[]) => {
    await gate;
    return refresh(...args);
  });
  const active = reader.read(source);
  try {
    const busy = await reader.read({ ...source, sessionId: 'other-session' });
    assert.match(busy.error ?? '', /busy/);
    assert.equal(Reflect.get(reader, 'sessions').size, 1);
  } finally {
    release();
  }
  assert.equal((await active).error, undefined);
});

test('discovery fallback requires the actual session header working directory', async (t) => {
  const { reader, source, root, file } = await rig(t, [text('a', 'Found')]);
  const alternate = path.join(root, 'different-directory-spelling');
  await mkdir(alternate);
  await rename(file, path.join(alternate, path.basename(file)));
  assert.equal((await reader.read(source)).entries[0].text, 'Found');
  assert.ok((await reader.read({ ...source, cwd: '/unrelated' })).error);
  assert.ok((await reader.read({ ...source, sessionId: 'missing-session' })).error);
});

test('discovers canonical and fallback session paths through a checkout symlink', async (t) => {
  const { source, root, file } = await rig(t, [text('a', 'Canonical checkout')]);
  await mkdir(source.cwd);
  const link = path.join(root, 'checkout-alias');
  await symlink(source.cwd, link, 'dir');
  const alias = { ...source, cwd: link };
  assert.equal((await new WorkerThreadReader(root).read(alias)).entries[0].text, 'Canonical checkout');
  const alternate = path.join(root, 'alternate-session-directory');
  await mkdir(alternate);
  await rename(file, path.join(alternate, path.basename(file)));
  assert.equal((await new WorkerThreadReader(root).read(alias)).entries[0].text, 'Canonical checkout');
  assert.ok((await new WorkerThreadReader(root).read({ ...source, cwd: root })).error);
});

test('bounds field/response/cache sizes and skips oversized complete records without losing later records', async (t) => {
  const huge = 'A paragraph with spaces and unicode. '.repeat(1500);
  const { reader, source, file } = await rig(
    t,
    Array.from({ length: 200 }, (_, i) => text(`m-${i}`, huge)),
    { sessions: 2, entries: 1000, bytes: 200_000 },
  );
  const page = await reader.read(source);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 1_000_000);
  assert.ok(page.hasMore);
  assert.ok(page.entries.every((entry) => entry.text?.endsWith('[… truncated]')));
  const cache = [...Reflect.get(reader, 'sessions').values()][0];
  assert.ok(cache.projection.bytes <= 200_000);
  assert.ok(cache.projection.tools.size <= cache.projection.entries.length);
  await appendFile(file, `${' '.repeat(4 * 1024 * 1024 + 10)}\n${lines(text('last', 'After oversized'))}`);
  const next = await reader.read(source);
  assert.equal(next.entries.at(-1)?.text, 'After oversized');
  assert.ok(next.entries.some((entry) => entry.kind === 'notice' && entry.text?.includes('too large')));
  await appendFile(file, 'x'.repeat(4 * 1024 * 1024 + 10));
  const incomplete = await reader.read(source);
  assert.equal(incomplete.entries.at(-1)?.text, 'After oversized');
  assert.ok(cache.pending.length <= 4 * 1024 * 1024);
  await appendFile(file, `\n${lines(text('resumed', 'After partial oversized'))}`);
  assert.equal((await reader.read(source)).entries.at(-1)?.text, 'After partial oversized');
});

test('response budget trims older entries without breaking the next cursor', async (t) => {
  const long = '\u0001 '.repeat(9000);
  const { reader, source } = await rig(
    t,
    Array.from({ length: 100 }, (_, i) => message(`m-${i}`, 'assistant', [{ type: 'tool_use', id: `tool-${i}`, name: 'Execute', input: { command: long } }])),
    { sessions: 1, entries: 1000, bytes: 8_000_000 },
  );
  const page = await reader.read(source);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 1_000_000);
  assert.ok(page.entries.length < 100);
  assert.equal(page.hasMore, true);
  const older = await reader.read(source, page.entries[0].seq);
  assert.ok(older.entries.length > 0);
  assert.ok(older.entries.at(-1)!.seq < page.entries[0].seq);
});

test('WorkerManager exposes only a server-known local agent session and cwd', () => {
  const manager: WorkerManager = Object.create(WorkerManager.prototype);
  Reflect.set(manager, 'dir', '/project');
  Reflect.set(
    manager,
    'workers',
    new Map([
      ['agent', { info: { kind: 'agent', sessionId: 'owned', worktree: { path: '.droid-office/worktrees/agent' } } }],
      ['shell', { info: { kind: 'shell', sessionId: 'shell-session' } }],
      ['cloud', { info: { kind: 'cloud', sessionId: 'cloud-session' } }],
      ['guest', { info: { kind: 'agent', sessionId: 'guest-session', guest: {} } }],
      ['starting', { info: { kind: 'agent' } }],
    ]),
  );
  assert.deepEqual(manager.threadSession('agent'), { sessionId: 'owned', cwd: '/project/.droid-office/worktrees/agent' });
  for (const id of ['shell', 'cloud', 'guest', 'starting', 'missing']) assert.equal(manager.threadSession(id), undefined);
});

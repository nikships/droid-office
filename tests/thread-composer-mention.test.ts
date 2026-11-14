import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { tokenizeCode } from '../src/client/ui/code-highlight.js';
import { firstDiffTargetLine, mergeSyntaxAndDiffSpans, pairIntralineSpans, resolveDelegatedWorkerId, summarizeExplorationBlocks, toWorkspaceRelPath } from '../src/client/ui/thread-diff-view.js';
import { applyMention, findMentionQuery, rankWorkspacePaths } from '../src/client/ui/thread-mention.js';
import { mountWorkerThread } from '../src/client/ui/worker-thread.js';
import type { WorkerInfo } from '../src/shared/protocol.js';
import { looksGeneratedPath, type ThreadDiffLine, type ThreadFileChange } from '../src/shared/thread-diff.js';
import { presentThread } from '../src/shared/thread-presentation.js';
import type { ThreadEntry } from '../src/shared/worker-thread.js';

test('V3 Thread UI modules load cleanly in Node without window or document globals and use zero inline style attributes in h()', () => {
  assert.equal(typeof globalThis.window, 'undefined');
  assert.equal(typeof globalThis.document, 'undefined');
  assert.equal(typeof findMentionQuery, 'function');
  assert.equal(typeof rankWorkspacePaths, 'function');
  assert.equal(typeof applyMention, 'function');
  assert.equal(typeof mountWorkerThread, 'function');
  assert.equal(looksGeneratedPath('package-lock.json'), true);
  assert.equal(looksGeneratedPath('src/client/style.css'), false);
  const pulldiffSrc = readFileSync(new URL('../src/client/ui/pulldiff.ts', import.meta.url), 'utf8');
  assert.match(pulldiffSrc, /export\s*\{\s*looksGeneratedPath\s+as\s+looksGenerated\s*\}\s*from\s*['"]\.\.\/\.\.\/shared\/thread-diff['"]/);

  for (const rel of ['thread-mention.ts', 'thread-diff-view.ts', 'worker-thread.ts']) {
    const src = readFileSync(new URL(`../src/client/ui/${rel}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /\bh\([^)]*\bstyle\s*:/, `${rel} must not pass style: to h()`);
  }
});

test('findMentionQuery detects @<query> at start or after whitespace and ignores emails, @@, and spaces', () => {
  assert.deepEqual(findMentionQuery('@', 1), { start: 0, end: 1, query: '' });
  assert.deepEqual(findMentionQuery('@src/client/ui', 14), { start: 0, end: 14, query: 'src/client/ui' });
  assert.deepEqual(findMentionQuery('Check @src/client/style.css please', 17), {
    start: 6,
    end: 27,
    query: 'src/client',
  });
  assert.deepEqual(findMentionQuery('line1\n@package.json', 19), {
    start: 6,
    end: 19,
    query: 'package.json',
  });

  // Cursor before @ or after trailing space returns null
  assert.equal(findMentionQuery('@src/foo.ts', 0), null);
  assert.equal(findMentionQuery('@src/foo.ts ', 12), null);
  assert.equal(findMentionQuery('', 0), null);

  // Emails, mid-word @, and double @@ return null
  assert.equal(findMentionQuery('Email nik@factory.ai', 20), null);
  assert.equal(findMentionQuery('foo@bar', 7), null);
  assert.equal(findMentionQuery('@@double', 8), null);
  assert.equal(findMentionQuery('(@paren', 7), null);
});

test('rankWorkspacePaths handles empty query, folder drilldown, and fuzzy basename/path matching', () => {
  const dirs = ['src/', 'src/client/', 'src/client/ui/', 'tests/'];
  const files = ['AGENTS.md', 'package.json', 'src/client/style.css', 'src/client/team-thread.ts', 'src/client/ui/worker-thread.ts', 'src/client/ui/thread-mention.ts', 'tests/team-thread.test.ts'];

  // Empty query surfaces top-level folders first, then root files
  const rootItems = rankWorkspacePaths(files, dirs, '', 6);
  assert.deepEqual(rootItems.slice(0, 4), [
    { path: 'src/', kind: 'dir' },
    { path: 'tests/', kind: 'dir' },
    { path: 'AGENTS.md', kind: 'file' },
    { path: 'package.json', kind: 'file' },
  ]);

  // Folder drilldown (trailing /) shows immediate children of src/client/ ahead of deeper files
  const clientItems = rankWorkspacePaths(files, dirs, 'src/client/', 10);
  assert.equal(clientItems[0].path, 'src/client/ui/');
  assert.equal(clientItems[1].path, 'src/client/style.css');
  assert.equal(clientItems[2].path, 'src/client/team-thread.ts');
  assert.ok(clientItems.every((item) => item.path.startsWith('src/client/') && item.path !== 'src/client/'));

  // Exact basename and fuzzy subsequence ranking
  const styleHits = rankWorkspacePaths(files, dirs, 'style.css');
  assert.equal(styleHits[0].path, 'src/client/style.css');

  const fuzzyHits = rankWorkspacePaths(files, dirs, 'wt.ts');
  assert.ok(fuzzyHits.some((item) => item.path === 'src/client/ui/worker-thread.ts'));

  assert.deepEqual(rankWorkspacePaths([], [], 'anything'), []);
});

test('applyMention inserts trailing space for files and keeps cursor after slash for folders', () => {
  // Picking a folder keeps @<folder>/ with cursor right after / so narrowing continues
  const dirStep = applyMention('Inspect @cl', 8, 11, 'src/client/');
  assert.deepEqual(dirStep, { value: 'Inspect @src/client/', cursor: 20 });
  assert.deepEqual(findMentionQuery(dirStep.value, dirStep.cursor), {
    start: 8,
    end: 20,
    query: 'src/client/',
  });

  // Narrowing further to a file inserts @<file> + trailing space and exits active mention
  const fileStep = applyMention(dirStep.value, 8, 20, 'src/client/style.css');
  assert.deepEqual(fileStep, { value: 'Inspect @src/client/style.css ', cursor: 30 });
  assert.equal(findMentionQuery(fileStep.value, fileStep.cursor), null);

  // Replacing a token followed by an existing space avoids double spaces
  const midSentence = applyMention('Check @pkg before shipping', 6, 10, 'package.json');
  assert.deepEqual(midSentence, { value: 'Check @package.json before shipping', cursor: 20 });
});

test('toWorkspaceRelPath, firstDiffTargetLine, pairIntralineSpans, and mergeSyntaxAndDiffSpans work across real diff shapes', async () => {
  assert.equal(toWorkspaceRelPath('src/client/ui/worker-thread.ts'), 'src/client/ui/worker-thread.ts');
  assert.equal(toWorkspaceRelPath('/Users/nik/repos/droid-office/.droid-office/worktrees/pixel-1662/src/client/style.css'), 'src/client/style.css');
  assert.equal(toWorkspaceRelPath('/Users/nik/repos/droid-office/src/server/server.ts', '/Users/nik/repos/droid-office'), 'src/server/server.ts');
  assert.equal(toWorkspaceRelPath('/etc/hosts', '/Users/nik/repos/droid-office'), null);
  assert.equal(toWorkspaceRelPath('../outside.ts'), null);
  assert.equal(toWorkspaceRelPath('.git/config'), null);

  const lines: ThreadDiffLine[] = [
    { kind: 'hunk', text: '@@ -14,3 +14,3 @@' },
    { kind: 'ctx', text: 'const ready = true;', oldLine: 14, newLine: 14 },
    { kind: 'del', text: 'export const timeout = 1000;', oldLine: 15 },
    { kind: 'add', text: 'export const timeout = 15000;', newLine: 15 },
  ];
  const change: ThreadFileChange = {
    path: 'src/client/team-thread.ts',
    shortPath: 'src/client/team-thread.ts',
    kind: 'modified',
    additions: 1,
    deletions: 1,
    generated: false,
    lines,
  };
  assert.equal(firstDiffTargetLine(change), 14);
  assert.equal(firstDiffTargetLine({ ...change, lines: [{ kind: 'hunk', text: '@@ -0,0 +42,5 @@' }] }), 42);

  const paired = pairIntralineSpans(lines);
  assert.equal(paired.has(1), false);
  assert.ok(paired.get(2)?.some((s) => s.changed && s.text === '1000'));
  assert.ok(paired.get(3)?.some((s) => s.changed && s.text === '15000'));

  const tokens = await tokenizeCode('export const timeout = 15000;', 'ts');
  const merged = mergeSyntaxAndDiffSpans(tokens, paired.get(3)!);
  assert.equal(merged.map((m) => m.text).join(''), 'export const timeout = 15000;');
  assert.ok(merged.some((m) => m.text === 'export' && m.cls.includes('tok-kw') && !m.changed));
  assert.ok(merged.some((m) => m.text === '15000' && m.cls.includes('tok-num') && m.changed));
});

test('summarizeExplorationBlocks and resolveDelegatedWorkerId format V3 summaries and match subagents', () => {
  const entries: ThreadEntry[] = [
    { id: 'r1', seq: 1, role: 'assistant', kind: 'tool', name: 'Read', input: '{"file_path":"a.ts"}', output: 'a' },
    { id: 'r2', seq: 2, role: 'assistant', kind: 'tool', name: 'Read', input: '{"file_path":"b.ts"}', output: 'b' },
    { id: 'th1', seq: 3, role: 'assistant', kind: 'thinking', text: 'Need to search callers too' },
    { id: 'r3', seq: 4, role: 'assistant', kind: 'tool', name: 'Read', input: '{"file_path":"c.ts"}', output: 'c' },
    { id: 's1', seq: 5, role: 'assistant', kind: 'tool', name: 'Grep', input: '{"pattern":"foo"}', output: 'hit' },
    { id: 's2', seq: 6, role: 'assistant', kind: 'tool', name: 'Grep', input: '{"pattern":"bar"}' },
  ];
  const rows = presentThread(entries, true);
  assert.equal(rows[0].kind, 'activity');
  if (rows[0].kind === 'activity') {
    const summary = summarizeExplorationBlocks(rows[0].blocks, rows[0].live);
    assert.equal(summary.label, 'Read 3 files · Searched 2 times');
    assert.equal(summary.live, true);
    assert.equal(summary.state, 'working');

    const thoughtOnly = summarizeExplorationBlocks(
      rows[0].blocks.filter((b) => b.kind === 'thought'),
      false,
    );
    assert.equal(thoughtOnly.label, 'Thought · Need to search callers too');
  }

  const team: WorkerInfo[] = [
    {
      id: '166273c366ff',
      kind: 'agent',
      deskId: 'd1',
      name: 'Pixel',
      color: '#ee6018',
      status: 'working',
      acked: false,
      createdBy: 'lead',
      createdAt: 1,
      cols: 80,
      rows: 24,
      open: false,
      lead: 'orchestrator',
    },
  ];
  assert.equal(resolveDelegatedWorkerId({ agent: 'Pixel', summary: 'UI', workerId: '166273c366ff' }, 'orchestrator', team), '166273c366ff');
  assert.equal(resolveDelegatedWorkerId({ agent: 'Pixel', summary: 'UI', workerId: '1662' }, 'orchestrator', team), '166273c366ff');
  assert.equal(resolveDelegatedWorkerId({ agent: 'pixel', summary: 'UI', workerName: 'PIXEL' }, 'orchestrator', team), '166273c366ff');
  assert.equal(resolveDelegatedWorkerId({ agent: 'Ghost', summary: 'UI', workerName: 'Ghost' }, 'orchestrator', team), undefined);
});

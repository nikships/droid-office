import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anchorSnippetLine, editedFilePaths, extractThreadChanges, intralineDiffSpans, looksGeneratedPath, MAX_WIRE_DIFF_LINES, threadDeliverable } from '../src/shared/thread-diff.js';
import type { ThreadEntry } from '../src/shared/worker-thread.js';

const toolEntry = (name: string, input: unknown, extra: Partial<ThreadEntry> = {}): ThreadEntry => ({
  id: 'tool:1',
  seq: 1,
  role: 'assistant',
  kind: 'tool',
  name,
  input: typeof input === 'string' ? input : JSON.stringify(input),
  output: 'Done',
  ...extra,
});

test('looksGeneratedPath flags lockfiles, minified bundles, snapshots and dist outputs only', () => {
  for (const generated of [
    'package-lock.json',
    '/repo/package-lock.json',
    'yarn.lock',
    'apps/web/pnpm-lock.yaml',
    'bun.lock',
    'bun.lockb',
    'Cargo.lock',
    'Gemfile.lock',
    'poetry.lock',
    'composer.lock',
    'go.sum',
    'assets/vendor.min.js',
    'styles/app.min.css',
    'tests/__snapshots__/view.test.ts.snap',
    'dist/server/index.js',
    '/Users/nik/repos/droid-office/dist/client/main.js',
  ]) {
    assert.equal(looksGeneratedPath(generated), true, generated);
  }

  for (const authored of ['package.json', 'src/my-package-lock.json', 'src/dist-helpers.ts', 'src/shared/thread-diff.ts', 'tests/snap-helper.ts', 'src/client/styles.css']) {
    assert.equal(looksGeneratedPath(authored), false, authored);
  }
});

test('extractThreadChanges computes Myers unified hunks with 3 context lines for Edit', () => {
  const before = ['line 1', 'line 2', 'line 3', 'line 4', 'old A', 'line 6', 'line 7', 'line 8', 'line 9', 'line 10', 'line 11', 'line 12', 'old B', 'line 14'].join('\n');
  const after = ['line 1', 'line 2', 'line 3', 'line 4', 'new A1', 'new A2', 'line 6', 'line 7', 'line 8', 'line 9', 'line 10', 'line 11', 'line 12', 'line 14'].join('\n');
  const filePath = '/Users/nik/repos/droid-office/.droid-office/worktrees/byte-f670/src/shared/example.ts';
  const entry = toolEntry('Edit', { file_path: filePath, old_str: before, new_str: after });

  // Without the file the snippet's position is unknown, so no line is numbered.
  const unanchored = extractThreadChanges(entry)![0];
  assert.deepEqual(
    unanchored.lines.filter((l) => l.kind === 'hunk').map((l) => l.text),
    ['@@', '@@'],
  );
  assert.equal(
    unanchored.lines.some((l) => l.oldLine !== undefined || l.newLine !== undefined),
    false,
  );

  // The file as it is now begins with the snippet, so its lines are the snippet's own.
  const changes = extractThreadChanges(entry, (p) => (p === filePath ? `${after}\nline 15\n` : undefined));

  assert.ok(changes);
  assert.equal(changes.length, 1);
  const [change] = changes;
  assert.equal(change.shortPath, 'src/shared/example.ts');
  assert.equal(change.kind, 'modified');
  assert.equal(change.additions, 2);
  assert.equal(change.deletions, 2);
  assert.equal(change.generated, false);
  assert.equal('truncated' in change, false);

  const hunks = change.lines.filter((l) => l.kind === 'hunk').map((l) => l.text);
  assert.deepEqual(hunks, ['@@ -2,7 +2,8 @@', '@@ -10,5 +11,4 @@']);
  assert.deepEqual(
    change.lines.filter((l) => l.kind === 'del').map((l) => [l.oldLine, l.text]),
    [
      [5, 'old A'],
      [13, 'old B'],
    ],
  );
  assert.deepEqual(
    change.lines.filter((l) => l.kind === 'add').map((l) => [l.newLine, l.text]),
    [
      [5, 'new A1'],
      [6, 'new A2'],
    ],
  );
});

test('Edit diffs carry the real file lines where the snippet sits, deep in the file', () => {
  const head = Array.from({ length: 899 }, (_, i) => `row ${i + 1}`);
  const file = [...head, 'function target() {', '  return 2;', '}', 'tail'].join('\n');
  const entry = toolEntry('Edit', { file_path: 'src/deep.ts', old_str: 'function target() {\n  return 1;\n}', new_str: 'function target() {\n  return 2;\n}' });
  const [change] = extractThreadChanges(entry, () => file)!;
  assert.deepEqual(
    change.lines.map((l) => [l.kind, l.oldLine, l.newLine, l.text]),
    [
      ['hunk', undefined, undefined, '@@ -900,3 +900,3 @@'],
      ['ctx', 900, 900, 'function target() {'],
      ['del', 901, undefined, '  return 1;'],
      ['add', undefined, 901, '  return 2;'],
      ['ctx', 902, 902, '}'],
    ],
  );

  // A snippet that appears twice, or not at all, is never given a guessed line.
  for (const text of [`${file}\nfunction target() {\n  return 2;\n}`, head.join('\n')]) {
    const [unknown] = extractThreadChanges(entry, () => text)!;
    assert.equal(
      unknown.lines.some((l) => l.oldLine !== undefined || l.newLine !== undefined),
      false,
    );
    assert.equal(unknown.lines[0].text, '@@');
  }
});

test('anchorSnippetLine finds the new text, falls back to the old text and refuses ambiguity', () => {
  const file = 'a\r\nb\r\nc\r\nd\n';
  assert.equal(anchorSnippetLine(file, 'c\nd', ''), 3, 'CRLF files match LF snippets');
  assert.equal(anchorSnippetLine(file, '', 'b'), 2, 'a deletion is found by what it removed when that is still there');
  assert.equal(anchorSnippetLine(file, 'gone', 'd'), 4, 'old text when the new text is no longer there');
  assert.equal(anchorSnippetLine('x\nx\n', 'x', ''), undefined);
  assert.equal(anchorSnippetLine('x\ny\n', '   ', 'y'), 2, 'blank new text cannot anchor');
  assert.equal(anchorSnippetLine('x\ny\n', '', ''), undefined);
  assert.equal(anchorSnippetLine('x\ny\n', 'mid', 'none'), undefined);
});

test('MultiEdit numbers each edit on its own and editedFilePaths names the edited files', () => {
  const file = ['import a;', 'const a = 1;', 'const b = 20;', '', 'export { a, b };', 'export default a;'].join('\n');
  const entry = toolEntry('MultiEdit', {
    file_path: 'src/x.ts',
    edits: [
      { old_str: 'const b = 2;', new_str: 'const b = 20;' },
      { old_str: 'export default a;', new_str: 'export { a, b };\nexport default a;' },
      { old_str: 'x', new_str: 'a' },
    ],
  });
  const [change] = extractThreadChanges(entry, () => file)!;
  assert.deepEqual(
    change.lines.filter((l) => l.kind === 'hunk').map((l) => l.text),
    ['@@ -3,1 +3,1 @@', '@@ -5,1 +5,2 @@', '@@'],
  );
  assert.deepEqual(change.lines.find((l) => l.kind === 'add' && l.text === 'export { a, b };')?.newLine, 5);
  assert.deepEqual(
    editedFilePaths([entry, toolEntry('Edit', { file_path: ' src/y.ts ', old_str: 'a', new_str: 'b' }, { id: 'tool:2' }), toolEntry('Create', { file_path: 'src/z.ts', content: '' }), toolEntry('Edit', { file_path: 'src/x.ts' })]),
    ['src/x.ts', 'src/y.ts'],
  );
});

test('extractThreadChanges aggregates MultiEdit hunks and counts', () => {
  const changes = extractThreadChanges(
    toolEntry('functions.MultiEdit', {
      path: 'src/server/config.ts',
      edits: [
        { old_string: 'const a = 1;\nconst b = 2;', new_string: 'const a = 1;\nconst b = 20;' },
        { old_string: 'export default a;', new_string: 'export { a, b };\nexport default a;' },
      ],
    }),
  );
  assert.ok(changes);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, 'modified');
  assert.equal(changes[0].additions, 2);
  assert.equal(changes[0].deletions, 1);
  assert.equal(changes[0].lines.filter((l) => l.kind === 'hunk').length, 2);
});

test('extractThreadChanges builds added file hunks for Create and Write and caps wire lines at 400', () => {
  const small = extractThreadChanges(
    toolEntry('Create', {
      file_path: 'src/shared/new-file.ts',
      content: 'export const x = 1;\nexport const y = 2;\n',
    }),
  );
  assert.ok(small);
  assert.equal(small[0].kind, 'added');
  assert.equal(small[0].additions, 2);
  assert.equal(small[0].deletions, 0);
  assert.equal(small[0].truncated, undefined);
  assert.equal(small[0].lines[0].text, '@@ -0,0 +1,2 @@');
  assert.deepEqual(small[0].lines.slice(1), [
    { kind: 'add', text: 'export const x = 1;', newLine: 1 },
    { kind: 'add', text: 'export const y = 2;', newLine: 2 },
  ]);

  const bigContent = Array.from({ length: 520 }, (_, i) => `line ${i + 1}`).join('\n');
  const big = extractThreadChanges(
    toolEntry('Write', {
      path: 'package-lock.json',
      content: bigContent,
    }),
  );
  assert.ok(big);
  assert.equal(big[0].kind, 'added');
  assert.equal(big[0].additions, 520);
  assert.equal(big[0].deletions, 0);
  assert.equal(big[0].generated, true);
  assert.equal(big[0].truncated, true);
  assert.equal(big[0].lines.length, MAX_WIRE_DIFF_LINES);
});

test('extractThreadChanges parses V4A / Factory ApplyPatch payloads', () => {
  const patch = [
    '*** Begin Patch',
    '*** Add File: src/new.ts',
    '+export const added = true;',
    '+export const count = 1;',
    '*** Delete File: src/obsolete.ts',
    '*** Update File: src/old-name.ts',
    '*** Move to: src/new-name.ts',
    '@@ export function run() {',
    ' const ok = true;',
    '-return false;',
    '+return ok;',
    '*** End Patch',
  ].join('\n');

  const changes = extractThreadChanges(toolEntry('ApplyPatch', { input: patch }));
  assert.ok(changes);
  assert.equal(changes.length, 3);

  assert.deepEqual(
    changes.map((c) => ({ path: c.path, kind: c.kind, add: c.additions, del: c.deletions })),
    [
      { path: 'src/new.ts', kind: 'added', add: 2, del: 0 },
      { path: 'src/obsolete.ts', kind: 'deleted', add: 0, del: 0 },
      { path: 'src/new-name.ts', kind: 'modified', add: 1, del: 1 },
    ],
  );
  assert.equal(changes[0].lines[0].kind, 'hunk');
  assert.ok(changes[2].lines.some((l) => l.kind === 'note' && l.text.includes('old-name.ts')));
});

test('extractThreadChanges parses standard git unified diffs in ApplyPatch', () => {
  const unified = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1111111..2222222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -10,3 +10,4 @@ function demo() {',
    ' const x = 1;',
    '-const y = 2;',
    '+const y = 3;',
    '+const z = 4;',
    ' return x + y;',
    '\\ No newline at end of file',
    'diff --git a/src/added.ts b/src/added.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/src/added.ts',
    '@@ -0,0 +1,1 @@',
    '+export const fresh = 1;',
  ].join('\n');

  const changes = extractThreadChanges(toolEntry('ApplyPatch', unified));
  assert.ok(changes);
  assert.equal(changes.length, 2);
  assert.equal(changes[0].path, 'src/a.ts');
  assert.equal(changes[0].kind, 'modified');
  assert.equal(changes[0].additions, 2);
  assert.equal(changes[0].deletions, 1);
  assert.ok(changes[0].lines.some((l) => l.kind === 'note' && l.text.includes('No newline')));
  assert.equal(changes[0].lines.find((l) => l.kind === 'del')?.oldLine, 11);
  assert.deepEqual(
    changes[0].lines.filter((l) => l.kind === 'add').map((l) => l.newLine),
    [11, 12],
  );
  assert.equal(changes[1].path, 'src/added.ts');
  assert.equal(changes[1].kind, 'added');
  assert.equal(changes[1].additions, 1);
});

test('intralineDiffSpans highlights token and identifier differences while preserving exact text', () => {
  const numeric = intralineDiffSpans('  const timeout = 50;', '  const timeout = 80;');
  assert.equal(numeric.del.map((s) => s.text).join(''), '  const timeout = 50;');
  assert.equal(numeric.add.map((s) => s.text).join(''), '  const timeout = 80;');
  assert.deepEqual(numeric.del, [{ text: '  const timeout = ' }, { text: '50', changed: true }, { text: ';' }]);
  assert.deepEqual(numeric.add, [{ text: '  const timeout = ' }, { text: '80', changed: true }, { text: ';' }]);

  const identifier = intralineDiffSpans('renderWorkerThreadHeader(row)', 'renderWorkerThreadFooter(row)');
  assert.equal(identifier.del.map((s) => s.text).join(''), 'renderWorkerThreadHeader(row)');
  assert.equal(identifier.add.map((s) => s.text).join(''), 'renderWorkerThreadFooter(row)');
  assert.deepEqual(identifier.del, [{ text: 'renderWorkerThread' }, { text: 'Header', changed: true }, { text: '(row)' }]);
  assert.deepEqual(identifier.add, [{ text: 'renderWorkerThread' }, { text: 'Footer', changed: true }, { text: '(row)' }]);

  const same = intralineDiffSpans('unchanged', 'unchanged');
  assert.deepEqual(same, { del: [{ text: 'unchanged' }], add: [{ text: 'unchanged' }] });
});

test('threadDeliverable names the created files worth previewing or sharing', () => {
  assert.deepEqual(['docs/spec.md', 'notes.MARKDOWN', 'site/index.html', 'a.htm', 'shot.PNG', 'b.jpeg', 'c.webp', 'd.svg', 'e.gif', 'src/app.ts', 'README', 'archive.md.zip'].map(threadDeliverable), [
    'markdown',
    'markdown',
    'html',
    'html',
    'image',
    'image',
    'image',
    'image',
    'image',
    undefined,
    undefined,
    undefined,
  ]);
});

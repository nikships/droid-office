import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractThreadChanges, intralineDiffSpans, looksGeneratedPath, MAX_WIRE_DIFF_LINES } from '../src/shared/thread-diff.js';
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

  const changes = extractThreadChanges(
    toolEntry('Edit', {
      file_path: '/Users/nik/repos/droid-office/.droid-office/worktrees/byte-f670/src/shared/example.ts',
      old_str: before,
      new_str: after,
    }),
  );

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

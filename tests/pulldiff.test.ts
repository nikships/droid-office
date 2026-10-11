import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDiff, type DiffFile } from '../src/client/ui/diffparse.js';

// Reviewed.mark (pulldiff.ts) is this comparison, keyed by path, of the fingerprint it stored.
function mark(stored: string | undefined, file: DiffFile): 'none' | 'reviewed' | 'stale' {
  return stored === undefined ? 'none' : stored === file.hash ? 'reviewed' : 'stale';
}

/** The fingerprint a text file had before blob ids were counted: path and changed lines only. */
function textFingerprint(path: string, changes: string[]): string {
  let x = 0x811c9dc5;
  const s = `${path}\n${changes.join('\n')}`;
  for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 0x01000193);
  return (x >>> 0).toString(36);
}

// Real `git diff` of the same path and base blob, with a different new blob. GitHub's `gh pr diff`
// is this header: no hunks, so a fingerprint of the patch text cannot tell the two apart.
const binary = (newBlob: string) => ['diff --git a/docs/x.png b/docs/x.png', `index 76376a9..${newBlob} 100644`, 'Binary files a/docs/x.png and b/docs/x.png differ', ''].join('\n');

test('a reviewed binary file goes stale when its blob changes, and stays reviewed when it does not', () => {
  const first = parseDiff(binary('06ff02a'))[0];
  const same = parseDiff(binary('06ff02a'))[0];
  const changed = parseDiff(binary('c2e99b0'))[0];
  assert.equal(first.binary, true);
  assert.equal(first.path, 'docs/x.png');
  assert.equal(first.lines.length, 0);
  assert.equal(changed.path, first.path);
  assert.equal(first.hash, same.hash);
  assert.notEqual(first.hash, changed.hash);
  // The old fingerprint was the path alone, which these two diffs share.
  assert.notEqual(first.hash, textFingerprint(first.path, []));
  assert.equal(mark(first.hash, same), 'reviewed');
  assert.equal(mark(first.hash, changed), 'stale');
  assert.equal(mark(undefined, first), 'none');
});

test('a binary patch and a deleted binary count both blob ids', () => {
  const patch = (newBlob: string) => ['diff --git a/docs/x.png b/docs/x.png', `index 76376a9a3dbadcd946a1c4d6eb59c5cd475dbe0e..${newBlob} 100644`, 'GIT binary patch', 'literal 7', 'OcmWIWb7u$%_Xhw6X93^<', ''].join('\n');
  const full = parseDiff(patch('53ac2cd8a87b7151c304762c200735c3be9e4231'))[0];
  const other = parseDiff(patch('06ff02a000000000000000000000000000000000'))[0];
  assert.equal(full.binary, true);
  assert.notEqual(full.hash, other.hash);
  assert.equal(mark(full.hash, other), 'stale');

  // Same new blob (the empty one), different old blob: still a different file.
  const deleted = (oldBlob: string) => ['diff --git a/docs/fresh.bin b/docs/fresh.bin', 'deleted file mode 100644', `index ${oldBlob}..0000000`, 'Binary files a/docs/fresh.bin and /dev/null differ', ''].join('\n');
  const gone = parseDiff(deleted('7f3375b'))[0];
  const otherGone = parseDiff(deleted('aaaaaaa'))[0];
  assert.equal(gone.status, 'D');
  assert.equal(gone.binary, true);
  assert.notEqual(gone.hash, otherGone.hash);
  assert.equal(mark(gone.hash, otherGone), 'stale');
  assert.equal(mark(gone.hash, parseDiff(deleted('7f3375b'))[0]), 'reviewed');
});

test('a text file keeps its review mark when only the blob ids change, and loses it when the patch does', () => {
  const patch = (oldId: string, newId: string, extra?: string) =>
    ['diff --git a/docs/note.txt b/docs/note.txt', `index ${oldId}..${newId} 100644`, '--- a/docs/note.txt', '+++ b/docs/note.txt', '@@ -1 +1,2 @@', ' hello', '+world', ...(extra ? [extra] : []), ''].join('\n');
  const before = parseDiff(patch('ce01362', '94954ab'))[0];
  const rebased = parseDiff(patch('aaaaaaa', 'bbbbbbb'))[0];
  assert.equal(before.binary, false);
  assert.equal(before.additions, 1);
  assert.equal(before.deletions, 0);
  assert.equal(before.hash, textFingerprint('docs/note.txt', ['+world']));
  assert.equal(before.hash, rebased.hash);
  assert.equal(mark(before.hash, rebased), 'reviewed');
  const edited = parseDiff(patch('ce01362', '94954ab', '+again'))[0];
  assert.equal(edited.additions, 2);
  assert.notEqual(before.hash, edited.hash);
  assert.equal(mark(before.hash, edited), 'stale');
});

test('a rename stays a different path, and a renamed text file still fingerprints its patch', () => {
  const renamed = parseDiff(['diff --git a/docs/x.png b/docs/y.png', 'similarity index 100%', 'rename from docs/x.png', 'rename to docs/y.png', ''].join('\n'))[0];
  assert.equal(renamed.status, 'R');
  assert.equal(renamed.oldPath, 'docs/x.png');
  assert.equal(renamed.path, 'docs/y.png');
  assert.equal(renamed.binary, false);
  // The marker stores by path, so the mark on the old path does not apply.
  assert.equal(mark(undefined, renamed), 'none');
  assert.equal(renamed.hash, textFingerprint('docs/y.png', []));

  const text = (oldId: string, newId: string) =>
    ['diff --git a/src/a.ts b/src/b.ts', 'similarity index 90%', 'rename from src/a.ts', 'rename to src/b.ts', `index ${oldId}..${newId} 100644`, '--- a/src/a.ts', '+++ b/src/b.ts', '@@ -1 +1,2 @@', ' keep', '+added', ''].join('\n');
  const moved = parseDiff(text('1111111', '2222222'))[0];
  const movedAgain = parseDiff(text('ccccccc', 'ddddddd'))[0];
  assert.equal(moved.status, 'R');
  assert.equal(moved.path, 'src/b.ts');
  assert.equal(moved.oldPath, 'src/a.ts');
  assert.equal(moved.additions, 1);
  assert.equal(moved.hash, textFingerprint('src/b.ts', ['+added']));
  assert.equal(moved.hash, movedAgain.hash);
  assert.equal(mark(moved.hash, movedAgain), 'reviewed');
});

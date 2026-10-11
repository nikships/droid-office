// A PR's unified diff (`gh pr diff` / `glab mr diff`), split into files. The Files tab draws it
// (pulldiff.ts). The fingerprint is what a review mark compares, so it has to change when the
// file's contents change.

export interface DiffLine {
  kind: 'ctx' | 'add' | 'del' | 'hunk' | 'note';
  text: string;
  old?: number;
  new?: number;
}

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: 'A' | 'D' | 'M' | 'R';
  binary: boolean;
  additions: number;
  deletions: number;
  lines: DiffLine[];
  /** Fingerprint of the file's changes (its blob ids, when the file is binary), so a review mark can tell when it changed since. */
  hash: string;
}

/** FNV-1a, enough to notice that a file's changes are different. */
function fnv(s: string): string {
  let x = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 0x01000193);
  return (x >>> 0).toString(36);
}

/** `a/src/x.ts` or `"a/odd name.ts"` → `src/x.ts` */
function unprefix(p: string): string {
  const q = p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1).replace(/\\(["\\])/g, '$1') : p;
  return q.replace(/^[ab]\//, '');
}

/** `index <old>..<new> [mode]` from a diff header. GitHub's binary diff is only this line plus a note. */
function blobIds(line: string): { old: string; new: string } | undefined {
  const m = /^index ([0-9a-f]+)\.\.([0-9a-f]+)/i.exec(line);
  return m ? { old: m[1], new: m[2] } : undefined;
}

export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let f: DiffFile | null = null;
  let changes: string[] = [];
  let oldBlob = '';
  let newBlob = '';
  let inHunk = false;
  let o = 0;
  let n = 0;
  const finish = () => {
    if (!f) return;
    // Only the changed lines count, so a rebase that just moves them doesn't undo your review.
    // A binary file has no patch text. Its index line names the blobs, which is what changed.
    const body = f.binary && (oldBlob || newBlob) ? `${oldBlob}..${newBlob}` : changes.join('\n');
    f.hash = fnv(`${f.path}\n${body}`);
    files.push(f);
  };
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      finish();
      const m = /^diff --git ("?a\/.+"?) ("?b\/.+"?)$/.exec(line);
      f = { path: m ? unprefix(m[2]) : line.slice(11), oldPath: undefined, status: 'M', binary: false, additions: 0, deletions: 0, lines: [], hash: '' };
      changes = [];
      oldBlob = '';
      newBlob = '';
      inHunk = false;
      continue;
    }
    if (!f) continue;
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m) {
        o = Number(m[1]);
        n = Number(m[2]);
        inHunk = true;
        f.lines.push({ kind: 'hunk', text: line });
        continue;
      }
    }
    if (!inHunk) {
      if (line.startsWith('new file mode')) f.status = 'A';
      else if (line.startsWith('deleted file mode')) f.status = 'D';
      else if (line.startsWith('rename from ')) {
        f.oldPath = line.slice(12);
        f.status = 'R';
      } else if (line.startsWith('rename to ')) f.path = line.slice(10);
      else if (line.startsWith('Binary files ') || line === 'GIT binary patch') f.binary = true;
      else if (line.startsWith('index ')) {
        const ids = blobIds(line);
        if (ids) {
          oldBlob = ids.old;
          newBlob = ids.new;
        }
      } else if (line.startsWith('+++ ') && line !== '+++ /dev/null') f.path = unprefix(line.slice(4));
      continue;
    }
    const c = line[0];
    if (c === '+') {
      f.lines.push({ kind: 'add', text: line.slice(1), new: n++ });
      f.additions++;
      changes.push(line);
    } else if (c === '-') {
      f.lines.push({ kind: 'del', text: line.slice(1), old: o++ });
      f.deletions++;
      changes.push(line);
    } else if (c === ' ') f.lines.push({ kind: 'ctx', text: line.slice(1), old: o++, new: n++ });
    else if (c === '\\') f.lines.push({ kind: 'note', text: line.slice(2) });
  }
  finish();
  return files;
}

import type { ThreadEntry } from './worker-thread.js';

export const MAX_WIRE_DIFF_LINES = 400;

const CONTEXT_LINES = 3;
const MAX_MYERS_LINES = 4000;
const MAX_MYERS_DISTANCE = 1200;
const MAX_INTRALINE_CHARS = 2000;
const MAX_INTRALINE_TOKENS = 300;

const GENERATED_PATH_RE = /((^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|Gemfile\.lock|poetry\.lock|composer\.lock|go\.sum)$|\.min\.(js|css)$|\.snap$|(^|\/)dist\/)/;
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export interface ThreadDiffSpan {
  text: string;
  changed?: boolean;
}

export interface ThreadDiffLine {
  kind: 'hunk' | 'ctx' | 'add' | 'del' | 'note';
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface ThreadFileChange {
  path: string;
  shortPath: string;
  kind: 'added' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
  generated: boolean;
  truncated?: boolean;
  lines: ThreadDiffLine[];
  /** Whether the diff starts expanded; set by the presentation (see presentThread). */
  open?: boolean;
}

const baseName = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '').split('/').at(-1) || path;

export function threadShortPath(path: string): string {
  const root = path.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (/\/\.droid-office\/worktrees\/[^/]+$/.test(root)) return baseName(root);
  const short = path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^.*?\/\.droid-office\/worktrees\/[^/]+\//, '')
    .replace(/^\/(?:Users|home)\/[^/]+\//, '~/');
  const parts = short.split('/').filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : short;
}

/** Normalizes MCP and provider-prefixed tool names (`droid-office___team_hire`, `mcp__x__y`, `functions.Execute`) to their lowercase leaf. */
export function toolLeaf(name = ''): string {
  const afterTriple = name.split('___').at(-1) ?? name;
  const afterMcp = afterTriple.startsWith('mcp__') ? afterTriple.split('__').slice(2).join('__') || afterTriple : afterTriple;
  return (afterMcp.split(/[.:/]/).at(-1) ?? '').toLowerCase();
}

export function looksGeneratedPath(path: string): boolean {
  return GENERATED_PATH_RE.test(path.trim().replace(/\\/g, '/'));
}

function parseObject(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function normalizeLf(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function splitContentLines(text: string): string[] {
  const norm = normalizeLf(text);
  if (!norm) return [];
  return (norm.endsWith('\n') ? norm.slice(0, -1) : norm).split('\n');
}

function splitPairLines(oldRaw: string, newRaw: string): [string[], string[]] {
  const oldNorm = normalizeLf(oldRaw);
  const newNorm = normalizeLf(newRaw);
  const stripTrailing = (oldNorm.endsWith('\n') && newNorm.endsWith('\n')) || (oldNorm === '' && newNorm.endsWith('\n')) || (newNorm === '' && oldNorm.endsWith('\n'));
  const toLines = (s: string) => {
    if (!s) return [];
    return (stripTrailing && s.endsWith('\n') ? s.slice(0, -1) : s).split('\n');
  };
  return [toLines(oldNorm), toLines(newNorm)];
}

type DiffOp = 'equal' | 'delete' | 'insert';

function myersOps<T>(a: readonly T[], b: readonly T[]): DiffOp[] {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let aEnd = a.length;
  let bEnd = b.length;
  while (aEnd > prefix && bEnd > prefix && a[aEnd - 1] === b[bEnd - 1]) {
    aEnd--;
    bEnd--;
  }
  const out: DiffOp[] = [];
  for (let i = 0; i < prefix; i++) out.push('equal');

  const n = aEnd - prefix;
  const m = bEnd - prefix;
  if (n === 0 && m === 0) {
    for (let i = aEnd; i < a.length; i++) out.push('equal');
    return out;
  }
  if (n === 0) {
    for (let i = 0; i < m; i++) out.push('insert');
    for (let i = aEnd; i < a.length; i++) out.push('equal');
    return out;
  }
  if (m === 0) {
    for (let i = 0; i < n; i++) out.push('delete');
    for (let i = aEnd; i < a.length; i++) out.push('equal');
    return out;
  }

  const max = n + m;
  if (max > MAX_MYERS_LINES) {
    for (let i = 0; i < n; i++) out.push('delete');
    for (let i = 0; i < m; i++) out.push('insert');
    for (let i = aEnd; i < a.length; i++) out.push('equal');
    return out;
  }

  const offset = max;
  const v = new Int32Array(2 * max + 1);
  const trace: Int32Array[] = [];
  let reached = -1;

  for (let d = 0; d <= max; d++) {
    if (d > MAX_MYERS_DISTANCE) break;
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[prefix + x] === b[prefix + y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        reached = d;
        break;
      }
    }
    if (reached >= 0) break;
  }

  if (reached < 0) {
    for (let i = 0; i < n; i++) out.push('delete');
    for (let i = 0; i < m; i++) out.push('insert');
    for (let i = aEnd; i < a.length; i++) out.push('equal');
    return out;
  }

  const mid: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = reached; d > 0; d--) {
    const prevV = trace[d];
    const k = x - y;
    const down = k === -d || (k !== d && prevV[offset + k - 1] < prevV[offset + k + 1]);
    const prevK = down ? k + 1 : k - 1;
    const prevX = prevV[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      mid.push('equal');
      x--;
      y--;
    }
    mid.push(down ? 'insert' : 'delete');
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    mid.push('equal');
    x--;
    y--;
  }
  mid.reverse();
  for (const op of mid) out.push(op);
  for (let i = aEnd; i < a.length; i++) out.push('equal');
  return out;
}

/** Reads the text of the file an Edit or MultiEdit changed, as it is now, or undefined when it can't be read. */
export type ThreadFileText = (path: string) => string | undefined;

/**
 * The 1-based line where an edit's snippet starts in `fileText`: where its new text is now, or where its
 * old text still is when the new text is empty or gone. Undefined unless exactly one place matches, so a
 * diff never claims a line it can't prove.
 */
export function anchorSnippetLine(fileText: string, newRaw: string, oldRaw: string): number | undefined {
  const text = normalizeLf(fileText);
  for (const raw of [newRaw, oldRaw]) {
    const needle = normalizeLf(raw);
    if (!needle.trim()) continue;
    const at = text.indexOf(needle);
    if (at < 0) continue;
    if (text.indexOf(needle, at + 1) >= 0) return undefined;
    let line = 1;
    for (let i = text.indexOf('\n'); i >= 0 && i < at; i = text.indexOf('\n', i + 1)) line++;
    return line;
  }
  return undefined;
}

/** `anchor` is the file line the snippet starts on; without one the lines carry no numbers. */
function diffSnippet(oldRaw: string, newRaw: string, anchor?: number): { additions: number; deletions: number; lines: ThreadDiffLine[] } {
  const [oldLines, newLines] = splitPairLines(oldRaw, newRaw);
  const ops = myersOps(oldLines, newLines);
  const full: ThreadDiffLine[] = [];
  let oldLine = 1;
  let newLine = 1;
  let additions = 0;
  let deletions = 0;
  const changedIndices: number[] = [];

  for (const op of ops) {
    if (op === 'equal') {
      full.push({ kind: 'ctx', text: oldLines[oldLine - 1], oldLine, newLine });
      oldLine++;
      newLine++;
    } else if (op === 'delete') {
      changedIndices.push(full.length);
      full.push({ kind: 'del', text: oldLines[oldLine - 1], oldLine });
      oldLine++;
      deletions++;
    } else {
      changedIndices.push(full.length);
      full.push({ kind: 'add', text: newLines[newLine - 1], newLine });
      newLine++;
      additions++;
    }
  }

  if (!changedIndices.length) return { additions: 0, deletions: 0, lines: [] };

  const ranges: [number, number][] = [];
  for (const idx of changedIndices) {
    const start = Math.max(0, idx - CONTEXT_LINES);
    const end = Math.min(full.length - 1, idx + CONTEXT_LINES);
    const last = ranges.at(-1);
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }

  const lines: ThreadDiffLine[] = [];
  for (const [start, end] of ranges) {
    const slice = full.slice(start, end + 1);
    if (anchor === undefined) {
      lines.push({ kind: 'hunk', text: '@@' });
      lines.push(...slice.map(({ kind, text }): ThreadDiffLine => ({ kind, text })));
      continue;
    }
    const shift = anchor - 1;
    const placed = slice.map(
      (l): ThreadDiffLine => ({
        kind: l.kind,
        text: l.text,
        ...(l.oldLine !== undefined ? { oldLine: l.oldLine + shift } : {}),
        ...(l.newLine !== undefined ? { newLine: l.newLine + shift } : {}),
      }),
    );
    const oldCount = placed.filter((l) => l.kind === 'ctx' || l.kind === 'del').length;
    const newCount = placed.filter((l) => l.kind === 'ctx' || l.kind === 'add').length;
    // An empty side starts on the line before the change, as in a unified diff.
    const firstOld = placed.find((l) => l.oldLine !== undefined)?.oldLine;
    const firstNew = placed.find((l) => l.newLine !== undefined)?.newLine;
    const oldStart = oldCount === 0 ? (firstNew ?? anchor) - 1 : (firstOld ?? anchor);
    const newStart = newCount === 0 ? (firstOld ?? anchor) - 1 : (firstNew ?? anchor);
    lines.push({ kind: 'hunk', text: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@` });
    lines.push(...placed);
  }

  return { additions, deletions, lines };
}

function buildFileChange(rawPath: string, kind: ThreadFileChange['kind'], additions: number, deletions: number, allLines: ThreadDiffLine[]): ThreadFileChange {
  const cleanPath = rawPath.trim().replace(/\\/g, '/');
  const truncated = allLines.length > MAX_WIRE_DIFF_LINES;
  return {
    path: cleanPath,
    shortPath: threadShortPath(cleanPath),
    kind,
    additions,
    deletions,
    generated: looksGeneratedPath(cleanPath),
    ...(truncated ? { truncated: true } : {}),
    lines: truncated ? allLines.slice(0, MAX_WIRE_DIFF_LINES) : allLines,
  };
}

function mergeFileChanges(items: ThreadFileChange[]): ThreadFileChange[] {
  const byPath = new Map<string, { kind: ThreadFileChange['kind']; additions: number; deletions: number; lines: ThreadDiffLine[]; truncated: boolean }>();
  for (const item of items) {
    const existing = byPath.get(item.path);
    if (!existing) {
      byPath.set(item.path, {
        kind: item.kind,
        additions: item.additions,
        deletions: item.deletions,
        lines: [...item.lines],
        truncated: Boolean(item.truncated),
      });
      continue;
    }
    existing.additions += item.additions;
    existing.deletions += item.deletions;
    if (item.kind === 'deleted') existing.kind = 'deleted';
    if (!existing.truncated) {
      const remaining = MAX_WIRE_DIFF_LINES - existing.lines.length;
      if (item.lines.length > remaining) {
        existing.lines.push(...item.lines.slice(0, Math.max(0, remaining)));
        existing.truncated = true;
      } else {
        existing.lines.push(...item.lines);
        if (item.truncated) existing.truncated = true;
      }
    }
  }
  return [...byPath.entries()].map(([path, data]) => ({
    path,
    shortPath: threadShortPath(path),
    kind: data.kind,
    additions: data.additions,
    deletions: data.deletions,
    generated: looksGeneratedPath(path),
    ...(data.truncated ? { truncated: true } : {}),
    lines: data.lines,
  }));
}

function extractPatchText(entry: ThreadEntry, args: Record<string, unknown>): string {
  const fromArgs = str(args.input ?? args.patch ?? args.diff);
  if (fromArgs) return fromArgs;
  const raw = entry.input?.trim();
  if (!raw) return '';
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'string' ? parsed : '';
  } catch {
    return raw;
  }
}

function parseV4APatch(patch: string): ThreadFileChange[] {
  const rawLines = splitContentLines(patch);
  const out: ThreadFileChange[] = [];

  let path = '';
  let kind: ThreadFileChange['kind'] = 'modified';
  let additions = 0;
  let deletions = 0;
  let lines: ThreadDiffLine[] = [];
  let oldLine = 1;
  let newLine = 1;
  let sawExplicitHunk = false;

  const flush = () => {
    if (!path) return;
    let finalLines = lines;
    if (!sawExplicitHunk && lines.some((l) => l.kind === 'add' || l.kind === 'del' || l.kind === 'ctx')) {
      const oldCount = lines.filter((l) => l.kind === 'ctx' || l.kind === 'del').length;
      const newCount = lines.filter((l) => l.kind === 'ctx' || l.kind === 'add').length;
      const header = `@@ -${oldCount ? 1 : 0},${oldCount} +${newCount ? 1 : 0},${newCount} @@`;
      finalLines = [{ kind: 'hunk', text: header }, ...lines];
    }
    out.push(buildFileChange(path, kind, additions, deletions, finalLines));
    path = '';
    additions = 0;
    deletions = 0;
    lines = [];
    oldLine = 1;
    newLine = 1;
    sawExplicitHunk = false;
  };

  for (const line of rawLines) {
    if (line.startsWith('*** Begin Patch') || line.startsWith('*** End Patch')) {
      if (line.startsWith('*** End Patch')) flush();
      continue;
    }
    const header = /^\*\*\* (Add|Delete|Update) File:\s*(.+)$/.exec(line);
    if (header) {
      flush();
      const op = header[1];
      path = header[2].trim();
      kind = op === 'Add' ? 'added' : op === 'Delete' ? 'deleted' : 'modified';
      continue;
    }
    if (!path) continue;
    const move = /^\*\*\* Move to:\s*(.+)$/.exec(line);
    if (move) {
      const oldPath = path;
      path = move[1].trim();
      lines.push({ kind: 'note', text: `Renamed from ${threadShortPath(oldPath)}` });
      continue;
    }
    if (line.startsWith('*** End of File')) {
      lines.push({ kind: 'note', text: 'End of file' });
      continue;
    }
    if (line.startsWith('@@')) {
      sawExplicitHunk = true;
      const m = HUNK_HEADER_RE.exec(line);
      if (m) {
        oldLine = Number(m[1]);
        newLine = Number(m[3]);
      }
      lines.push({ kind: 'hunk', text: line });
      continue;
    }
    if (line.startsWith('+')) {
      additions++;
      lines.push({ kind: 'add', text: line.slice(1), newLine: newLine++ });
    } else if (line.startsWith('-')) {
      deletions++;
      lines.push({ kind: 'del', text: line.slice(1), oldLine: oldLine++ });
    } else if (line.startsWith('\\')) {
      lines.push({ kind: 'note', text: line.replace(/^\\\s*/, '') });
    } else {
      lines.push({ kind: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line, oldLine: oldLine++, newLine: newLine++ });
    }
  }
  flush();
  return mergeFileChanges(out);
}

function cleanUnifiedPath(raw: string): string {
  let p = raw.split('\t')[0].trim();
  if (p.startsWith('"') && p.endsWith('"') && p.length >= 2) p = p.slice(1, -1);
  if (p === '/dev/null') return '/dev/null';
  return p.replace(/^[ab]\//, '');
}

function parseUnifiedDiff(patch: string): ThreadFileChange[] {
  const rawLines = splitContentLines(patch);
  const out: ThreadFileChange[] = [];

  let oldPath = '';
  let newPath = '';
  let kind: ThreadFileChange['kind'] = 'modified';
  let additions = 0;
  let deletions = 0;
  let lines: ThreadDiffLine[] = [];
  let inHunk = false;
  let oldLine = 1;
  let newLine = 1;
  let oldRem = 0;
  let newRem = 0;

  const flush = () => {
    const chosen = kind === 'deleted' ? oldPath || newPath : newPath || oldPath;
    if (chosen && chosen !== '/dev/null') {
      out.push(buildFileChange(chosen, kind, additions, deletions, lines));
    }
    oldPath = '';
    newPath = '';
    kind = 'modified';
    additions = 0;
    deletions = 0;
    lines = [];
    inHunk = false;
    oldLine = 1;
    newLine = 1;
    oldRem = 0;
    newRem = 0;
  };

  for (const line of rawLines) {
    if (line.startsWith('diff --git ')) {
      flush();
      const m = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/.exec(line);
      if (m) {
        oldPath = m[1];
        newPath = m[2];
      }
      continue;
    }

    const hunkDone = !inHunk || (oldRem <= 0 && newRem <= 0);

    if (hunkDone) {
      if (line.startsWith('new file mode ')) {
        kind = 'added';
        continue;
      }
      if (line.startsWith('deleted file mode ')) {
        kind = 'deleted';
        continue;
      }
      if (line.startsWith('rename from ')) {
        oldPath = line.slice('rename from '.length).trim();
        continue;
      }
      if (line.startsWith('rename to ')) {
        const prev = oldPath;
        newPath = line.slice('rename to '.length).trim();
        if (prev) lines.push({ kind: 'note', text: `Renamed from ${threadShortPath(prev)}` });
        continue;
      }
      if (line.startsWith('index ') || line.startsWith('similarity index ') || line.startsWith('old mode ') || line.startsWith('new mode ')) {
        continue;
      }
      if (line.startsWith('Binary files ')) {
        lines.push({ kind: 'note', text: line });
        continue;
      }
      if (line.startsWith('--- ')) {
        if (inHunk) flush();
        const p = cleanUnifiedPath(line.slice(4));
        if (p === '/dev/null') kind = 'added';
        else oldPath = p;
        continue;
      }
      if (line.startsWith('+++ ')) {
        const p = cleanUnifiedPath(line.slice(4));
        if (p === '/dev/null') kind = 'deleted';
        else newPath = p;
        continue;
      }
    }

    const hunk = HUNK_HEADER_RE.exec(line);
    if (hunk) {
      inHunk = true;
      oldLine = Number(hunk[1]);
      oldRem = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newLine = Number(hunk[3]);
      newRem = hunk[4] === undefined ? 1 : Number(hunk[4]);
      lines.push({ kind: 'hunk', text: line });
      continue;
    }

    if (!inHunk) continue;
    if (oldRem <= 0 && newRem <= 0 && line === '') continue;

    if (line.startsWith('+')) {
      additions++;
      newRem--;
      lines.push({ kind: 'add', text: line.slice(1), newLine: newLine++ });
    } else if (line.startsWith('-')) {
      deletions++;
      oldRem--;
      lines.push({ kind: 'del', text: line.slice(1), oldLine: oldLine++ });
    } else if (line.startsWith('\\')) {
      lines.push({ kind: 'note', text: line.replace(/^\\\s*/, '') });
    } else if (line.startsWith(' ') || (line === '' && oldRem > 0 && newRem > 0)) {
      oldRem--;
      newRem--;
      lines.push({ kind: 'ctx', text: line.startsWith(' ') ? line.slice(1) : '', oldLine: oldLine++, newLine: newLine++ });
    }
  }
  flush();
  return mergeFileChanges(out);
}

/** The files Edit and MultiEdit calls in `entries` changed, as they named them: the ones whose text numbers their diffs. */
export function editedFilePaths(entries: readonly ThreadEntry[]): string[] {
  const out = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== 'tool') continue;
    const name = toolLeaf(entry.name);
    if (name !== 'edit' && name !== 'multiedit') continue;
    const args = parseObject(entry.input);
    const filePath = str(args.file_path ?? args.path)?.trim();
    if (filePath) out.add(filePath);
  }
  return [...out];
}

/**
 * An Edit or MultiEdit records only the strings it swapped, so its line numbers come from finding them in
 * the file (`fileText`); without the file, or without a single match, its lines carry no numbers.
 */
export function extractThreadChanges(entry: ThreadEntry, fileText?: ThreadFileText): ThreadFileChange[] | undefined {
  if (entry.kind !== 'tool') return undefined;
  const name = toolLeaf(entry.name);
  const args = parseObject(entry.input);

  if (name === 'edit') {
    const filePath = str(args.file_path ?? args.path)?.trim();
    const oldStr = str(args.old_str ?? args.old_string);
    const newStr = str(args.new_str ?? args.new_string);
    if (!filePath || (oldStr === undefined && newStr === undefined)) return undefined;
    const text = fileText?.(filePath);
    const anchor = text === undefined ? undefined : anchorSnippetLine(text, newStr ?? '', oldStr ?? '');
    const { additions, deletions, lines } = diffSnippet(oldStr ?? '', newStr ?? '', anchor);
    return [buildFileChange(filePath, 'modified', additions, deletions, lines)];
  }

  if (name === 'multiedit') {
    const filePath = str(args.file_path ?? args.path)?.trim();
    const rawEdits = Array.isArray(args.edits) ? args.edits : [];
    if (!filePath || !rawEdits.length) return undefined;
    const text = fileText?.(filePath);
    let totalAdd = 0;
    let totalDel = 0;
    const allLines: ThreadDiffLine[] = [];
    let anyValid = false;
    for (const item of rawEdits) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const edit = item as Record<string, unknown>;
      const oldStr = str(edit.old_str ?? edit.old_string);
      const newStr = str(edit.new_str ?? edit.new_string);
      if (oldStr === undefined && newStr === undefined) continue;
      anyValid = true;
      const anchor = text === undefined ? undefined : anchorSnippetLine(text, newStr ?? '', oldStr ?? '');
      const { additions, deletions, lines } = diffSnippet(oldStr ?? '', newStr ?? '', anchor);
      totalAdd += additions;
      totalDel += deletions;
      allLines.push(...lines);
    }
    if (!anyValid) return undefined;
    return [buildFileChange(filePath, 'modified', totalAdd, totalDel, allLines)];
  }

  if (name === 'create' || name === 'write') {
    const filePath = str(args.file_path ?? args.path)?.trim();
    const content = str(args.content ?? args.file_text);
    if (!filePath || content === undefined) return undefined;
    const contentLines = splitContentLines(content);
    const additions = contentLines.length;
    const allLines: ThreadDiffLine[] = additions ? [{ kind: 'hunk', text: `@@ -0,0 +1,${additions} @@` }, ...contentLines.map((text, idx): ThreadDiffLine => ({ kind: 'add', text, newLine: idx + 1 }))] : [];
    return [buildFileChange(filePath, 'added', additions, 0, allLines)];
  }

  if (name === 'applypatch' || name === 'apply_patch') {
    const patch = normalizeLf(extractPatchText(entry, args));
    if (!patch.trim()) return undefined;
    const changes = /^\*\*\* (?:Begin Patch|(?:Add|Delete|Update) File:)/m.test(patch) ? parseV4APatch(patch) : parseUnifiedDiff(patch);
    return changes.length ? changes : undefined;
  }

  return undefined;
}

function pushSpan(list: ThreadDiffSpan[], text: string, changed: boolean): void {
  if (!text) return;
  const last = list.at(-1);
  if (last && Boolean(last.changed) === changed) {
    last.text += text;
    return;
  }
  list.push(changed ? { text, changed: true } : { text });
}

function charPrefixSuffix(oldText: string, newText: string): { del: ThreadDiffSpan[]; add: ThreadDiffSpan[] } {
  let pre = 0;
  const minLen = Math.min(oldText.length, newText.length);
  while (pre < minLen && oldText.charCodeAt(pre) === newText.charCodeAt(pre)) pre++;
  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (oldEnd > pre && newEnd > pre && oldText.charCodeAt(oldEnd - 1) === newText.charCodeAt(newEnd - 1)) {
    oldEnd--;
    newEnd--;
  }
  const del: ThreadDiffSpan[] = [];
  const add: ThreadDiffSpan[] = [];
  pushSpan(del, oldText.slice(0, pre), false);
  pushSpan(del, oldText.slice(pre, oldEnd), true);
  pushSpan(del, oldText.slice(oldEnd), false);
  pushSpan(add, newText.slice(0, pre), false);
  pushSpan(add, newText.slice(pre, newEnd), true);
  pushSpan(add, newText.slice(newEnd), false);
  return { del, add };
}

function tokenizeLine(text: string): string[] {
  return text.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+|_+|\s+|[^A-Za-z0-9_\s]/gu) ?? [];
}

export function intralineDiffSpans(oldText: string, newText: string): { del: ThreadDiffSpan[]; add: ThreadDiffSpan[] } {
  if (oldText === newText) {
    return {
      del: oldText ? [{ text: oldText }] : [],
      add: newText ? [{ text: newText }] : [],
    };
  }
  if (!oldText || !newText) {
    return {
      del: oldText ? [{ text: oldText, changed: true }] : [],
      add: newText ? [{ text: newText, changed: true }] : [],
    };
  }
  if (oldText.length > MAX_INTRALINE_CHARS || newText.length > MAX_INTRALINE_CHARS) {
    return charPrefixSuffix(oldText, newText);
  }

  const oldTokens = tokenizeLine(oldText);
  const newTokens = tokenizeLine(newText);
  if (oldTokens.length + newTokens.length > MAX_INTRALINE_TOKENS) {
    return charPrefixSuffix(oldText, newText);
  }

  const ops = myersOps(oldTokens, newTokens);
  const del: ThreadDiffSpan[] = [];
  const add: ThreadDiffSpan[] = [];
  let oi = 0;
  let ni = 0;

  for (const op of ops) {
    if (op === 'equal') {
      pushSpan(del, oldTokens[oi++], false);
      pushSpan(add, newTokens[ni++], false);
    } else if (op === 'delete') {
      pushSpan(del, oldTokens[oi++], true);
    } else {
      pushSpan(add, newTokens[ni++], true);
    }
  }

  return { del, add };
}

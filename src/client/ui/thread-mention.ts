// Pure @file workspace mention detection, fuzzy client ranking, and cursor replacement.
// Free of window/document globals so Node unit tests import it directly.

export interface MentionQuery {
  start: number;
  end: number;
  query: string;
}

export interface WorkspaceMentionItem {
  path: string;
  kind: 'file' | 'dir';
}

const DEFAULT_MENTION_LIMIT = 12;

/**
 * Detects an active `@<query>` token at `cursor` (at start of input or preceded by whitespace,
 * with no whitespace inside `<query>`). Returns `null` for email addresses (`a@b.com`), `@@`,
 * or cursors outside a mention token.
 */
export function findMentionQuery(value: string, cursor: number): MentionQuery | null {
  if (!value) return null;
  const pos = Math.max(0, Math.min(value.length, Math.trunc(cursor)));
  let start = pos;
  while (start > 0 && !/\s/.test(value[start - 1])) start--;
  if (start >= pos || value[start] !== '@') return null;
  if (start > 0 && !/\s/.test(value[start - 1])) return null;

  let end = pos;
  while (end < value.length && !/\s/.test(value[end])) end++;

  const query = value.slice(start + 1, pos);
  if (query.includes('@')) return null;
  return { start, end, query };
}

function scorePathCandidate(cleanPath: string, query: string): number | null {
  const lower = cleanPath.toLowerCase();
  const base = lower.slice(lower.lastIndexOf('/') + 1);

  if (lower === query) return 0;
  if (base === query) return 10;
  if (base.startsWith(query)) return 20 + (base.length - query.length);
  if (lower.startsWith(query)) return 40 + (lower.length - query.length);
  const baseIdx = base.indexOf(query);
  if (baseIdx >= 0) return 80 + baseIdx;
  const pathIdx = lower.indexOf(query);
  if (pathIdx >= 0) return 120 + pathIdx;

  let qi = 0;
  let penalty = 200;
  let prevMatch = -2;
  for (let i = 0; i < lower.length && qi < query.length; i++) {
    if (lower.charCodeAt(i) === query.charCodeAt(qi)) {
      const boundary = i === 0 || '/-_ .'.includes(lower[i - 1]);
      if (i === prevMatch + 1) penalty += 1;
      else if (boundary) penalty += 3;
      else penalty += 8;
      prevMatch = i;
      qi++;
    }
  }
  return qi === query.length ? penalty : null;
}

function pathDepth(cleanPath: string): number {
  let slashes = 0;
  for (let i = 0; i < cleanPath.length; i++) {
    if (cleanPath[i] === '/') slashes++;
  }
  return slashes;
}

/**
 * Ranks workspace files and folders for an `@<query>` mention.
 * - Bare `@` (`query === ''`): top-level folders and root files first, then shallower paths.
 * - Folder drilldown (`query` ending in `/`, e.g. `src/client/`): immediate children of that folder first.
 * - General query: exact, prefix, substring, and boundary-aware subsequence ranking.
 */
export function rankWorkspacePaths(files: readonly string[], dirs: readonly string[], query: string, limit = DEFAULT_MENTION_LIMIT): WorkspaceMentionItem[] {
  const max = Math.max(1, Math.trunc(limit));
  const candidates: WorkspaceMentionItem[] = [];
  const seenDirs = new Set<string>();
  const seenFiles = new Set<string>();

  const toSlashPath = (raw: string): string => raw.trim().replace(/\\/g, '/');
  for (const rawDir of dirs) {
    const trimmed = toSlashPath(rawDir).replace(/^\.\//, '');
    if (!trimmed) continue;
    const withSlash = trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
    if (seenDirs.has(withSlash)) continue;
    seenDirs.add(withSlash);
    candidates.push({ path: withSlash, kind: 'dir' });
  }

  for (const rawFile of files) {
    const trimmed = toSlashPath(rawFile).replace(/^\.\//, '').replace(/\/+$/, '');
    if (!trimmed || seenFiles.has(trimmed)) continue;
    seenFiles.add(trimmed);
    candidates.push({ path: trimmed, kind: 'file' });
  }

  if (!candidates.length) return [];

  const rawQuery = toSlashPath(query).replace(/^@+/, '').replace(/^\.\//, '');

  if (!rawQuery) {
    return [...candidates]
      .sort((a, b) => {
        const cleanA = a.kind === 'dir' ? a.path.slice(0, -1) : a.path;
        const cleanB = b.kind === 'dir' ? b.path.slice(0, -1) : b.path;
        const depthA = pathDepth(cleanA);
        const depthB = pathDepth(cleanB);
        if (depthA !== depthB) return depthA - depthB;
        if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
        return cleanA.localeCompare(cleanB);
      })
      .slice(0, max);
  }

  if (rawQuery.endsWith('/')) {
    const prefix = rawQuery.toLowerCase();
    const inside: { item: WorkspaceMentionItem; depth: number; clean: string }[] = [];
    for (const item of candidates) {
      const lower = item.path.toLowerCase();
      if (!lower.startsWith(prefix) || lower.length <= prefix.length) continue;
      const rest = item.kind === 'dir' ? item.path.slice(prefix.length, -1) : item.path.slice(prefix.length);
      if (!rest) continue;
      inside.push({ item, depth: pathDepth(rest), clean: rest });
    }
    inside.sort((a, b) => {
      if (a.depth !== b.depth) return a.depth - b.depth;
      if (a.item.kind !== b.item.kind) return a.item.kind === 'dir' ? -1 : 1;
      return a.clean.localeCompare(b.clean);
    });
    return inside.slice(0, max).map((entry) => entry.item);
  }

  const normalized = rawQuery.replace(/\/+$/, '').toLowerCase();
  const scored: { item: WorkspaceMentionItem; score: number; clean: string }[] = [];
  for (const item of candidates) {
    const clean = item.kind === 'dir' ? item.path.slice(0, -1) : item.path;
    const score = scorePathCandidate(clean, normalized);
    if (score !== null) scored.push({ item, score, clean });
  }

  scored.sort((a, b) => a.score - b.score || a.clean.length - b.clean.length || (a.item.kind === b.item.kind ? 0 : a.item.kind === 'file' ? -1 : 1) || a.clean.localeCompare(b.clean));
  return scored.slice(0, max).map((entry) => entry.item);
}

/**
 * Replaces the mention token `[start, end)` in `value` with `picked`.
 * - Picking a file inserts `@<path> ` (avoiding duplicate spaces when one already follows) and places the cursor after the space.
 * - Picking a folder (`src/client/`) inserts `@src/client/` and keeps the cursor right after `/` so narrowing continues.
 */
export function applyMention(value: string, start: number, end: number, picked: string): { value: string; cursor: number } {
  const s = Math.max(0, Math.min(value.length, Math.trunc(start)));
  const e = Math.max(s, Math.min(value.length, Math.trunc(end)));
  const clean = picked.trim().replace(/^@+/, '');
  let prefix = '@';
  if (value[s] !== '@' && s > 0 && value[s - 1] === '@') prefix = '';
  const isDir = clean.endsWith('/');

  if (isDir) {
    const inserted = `${prefix}${clean}`;
    return {
      value: `${value.slice(0, s)}${inserted}${value.slice(e)}`,
      cursor: s + inserted.length,
    };
  }

  const hasSpaceAfter = e < value.length && value[e] === ' ';
  const inserted = hasSpaceAfter ? `${prefix}${clean}` : `${prefix}${clean} `;
  return {
    value: `${value.slice(0, s)}${inserted}${value.slice(e)}`,
    cursor: s + prefix.length + clean.length + 1,
  };
}

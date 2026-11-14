import { execFile } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { isBinaryBuffer } from '../shared/docs.js';
import { insideCheckout } from './changes.js';

const CACHE_TTL_MS = 5000;
const GIT_TIMEOUT_MS = 10_000;
const MAX_WALK_DEPTH = 10;
const MAX_EMPTY_QUERY_RESULTS = 5000;
const MAX_QUERY_RESULTS = 200;
const MAX_STAT_BYTES = 2 * 1024 * 1024;
const MAX_READ_BYTES = 512 * 1024;
/** The largest picture a Thread shows or sends to the Whiteboard from a worker's workspace. */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'target', 'vendor', 'coverage', '__pycache__', 'venv']);
const ALLOWED_ENV_TEMPLATES = new Set(['.env.example', '.env.sample', '.env.template']);

export interface ThreadFilesResult {
  files: string[];
  dirs: string[];
  truncated: boolean;
}

export interface ThreadFilePreview {
  path: string;
  text: string;
  totalLines: number;
  truncated: boolean;
}

export interface ThreadWorkspaceImage {
  type: string;
  body: Buffer;
}

export interface ThreadWorkspaceFailure {
  status: number;
  error: string;
  binary?: boolean;
}

export function isEnvSecretPath(relPath: string): boolean {
  const normalized = relPath.trim().replace(/\\/g, '/');
  for (const segment of normalized.split('/')) {
    if (!segment) continue;
    const lower = segment.toLowerCase();
    if (ALLOWED_ENV_TEMPLATES.has(lower)) continue;
    if (lower === '.env' || lower.startsWith('.env.') || lower === '.envrc') return true;
  }
  return false;
}

function isAllowedWorkspaceRelPath(relPath: string): boolean {
  if (!relPath || relPath.startsWith('/') || relPath.includes('\0') || /^[a-zA-Z]:/.test(relPath)) return false;
  if (/(^|\/)\.\.?(\/|$)/.test(relPath)) return false;
  if (/(^|\/)\.(git|droid-office)(\/|$)/.test(relPath)) return false;
  const base = relPath.slice(relPath.lastIndexOf('/') + 1).toLowerCase();
  if (!base || base === '.ds_store') return false;
  return true;
}

function gitListFiles(cwd: string): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: GIT_TIMEOUT_MS,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      },
      (err, stdout) => {
        if (err) return resolve(undefined);
        resolve([...new Set(stdout.split('\0').filter(Boolean))]);
      },
    );
  });
}

async function walkWorkspace(root: string): Promise<{ files: string[]; dirs: string[]; truncated: boolean }> {
  const files: string[] = [];
  const seenDirs = new Set<string>();
  const queue: [string, number][] = [['', 0]];
  let head = 0;
  let truncated = false;

  while (head < queue.length) {
    if (files.length >= MAX_EMPTY_QUERY_RESULTS) {
      truncated = true;
      break;
    }
    const [rel, depth] = queue[head++];
    let entries: Dirent[];
    try {
      entries = await readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
        seenDirs.add(`${relPath}/`);
        if (depth < MAX_WALK_DEPTH) queue.push([relPath, depth + 1]);
      } else if (entry.isFile()) {
        if (!isAllowedWorkspaceRelPath(relPath) || isEnvSecretPath(relPath)) continue;
        files.push(relPath);
        if (files.length >= MAX_EMPTY_QUERY_RESULTS) {
          truncated = true;
          break;
        }
      }
    }
  }

  for (const file of files) {
    addParentDirs(file, seenDirs);
  }
  const dirs = [...seenDirs].sort((a, b) => a.localeCompare(b));
  return { files, dirs, truncated };
}

function addParentDirs(filePath: string, into: Set<string>): void {
  let idx = filePath.indexOf('/');
  while (idx > 0) {
    into.add(filePath.slice(0, idx + 1));
    idx = filePath.indexOf('/', idx + 1);
  }
}

function scoreCandidate(candidate: string, query: string): number | null {
  const clean = candidate.endsWith('/') ? candidate.slice(0, -1) : candidate;
  const lower = clean.toLowerCase();
  const base = lower.slice(lower.lastIndexOf('/') + 1);

  if (lower === query) return 0;
  if (base === query) return 10;
  if (base.startsWith(query)) return 20 + (base.length - query.length);
  if (lower.startsWith(query)) return 40 + (lower.length - query.length);
  const baseIdx = base.indexOf(query);
  if (baseIdx >= 0) return 80 + baseIdx;
  const pathIdx = lower.indexOf(query);
  if (pathIdx >= 0) return 120 + pathIdx;

  // Fuzzy subsequence match across path characters, rewarding contiguous and boundary hits.
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

function filterAndRank(items: readonly string[], query: string, limit: number): { matches: string[]; truncated: boolean } {
  const scored: { item: string; score: number }[] = [];
  for (const item of items) {
    const score = scoreCandidate(item, query);
    if (score !== null) scored.push({ item, score });
  }
  scored.sort((a, b) => a.score - b.score || a.item.length - b.item.length || a.item.localeCompare(b.item));
  const truncated = scored.length > limit;
  return {
    matches: scored.slice(0, limit).map((s) => s.item),
    truncated,
  };
}

function sliceUtf8Clean(buf: Buffer, maxBytes: number): string {
  if (buf.length <= maxBytes) return buf.toString('utf8');
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

function countLines(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let newlines = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 10) newlines++;
  }
  return buf[buf.length - 1] === 10 ? newlines : newlines + 1;
}

/**
 * Where a workspace-relative path really is: inside the worker's folder, not through a symlink leading
 * out of it, and not a secret or repository-internal file.
 */
async function resolveWorkspaceFile(cwd: string, rawPath: string): Promise<{ abs: string; rel: string } | ThreadWorkspaceFailure> {
  const trimmed = rawPath.trim();
  if (!trimmed) return { status: 400, error: 'Missing file path.' };

  const cleanRelPath = trimmed.replace(/\\/g, '/').replace(/^\.\//, '');
  if (cleanRelPath.startsWith('/') || cleanRelPath.includes('\0') || /^[a-zA-Z]:/.test(cleanRelPath) || /(^|\/)\.\.(\/|$)/.test(cleanRelPath) || /(^|\/)\.(git|droid-office)(\/|$)/.test(cleanRelPath)) {
    return { status: 403, error: 'Path is outside the worker workspace.' };
  }

  if (isEnvSecretPath(cleanRelPath)) {
    return { status: 403, error: 'Environment secret files cannot be previewed.' };
  }

  let root: string;
  try {
    root = await realpath(cwd);
  } catch {
    return { status: 404, error: 'Workspace folder is unavailable.' };
  }

  const candidate = path.resolve(root, cleanRelPath);
  let linkStat: Awaited<ReturnType<typeof lstat>>;
  try {
    linkStat = await lstat(candidate);
  } catch {
    return { status: 404, error: 'File not found in workspace.' };
  }

  const abs = await insideCheckout(root, cleanRelPath);
  if (!abs) {
    if (linkStat.isSymbolicLink()) {
      return { status: 403, error: 'Symlink points outside the worker workspace.' };
    }
    // Also check whether an ancestor directory in cleanRelPath was a symlink pointing outside root.
    try {
      const resolved = await realpath(candidate);
      const rel = path.relative(root, resolved);
      if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
        return { status: 403, error: 'Symlink points outside the worker workspace.' };
      }
    } catch {
      return { status: 404, error: 'File not found in workspace.' };
    }
    return { status: 403, error: 'Path is outside the worker workspace.' };
  }

  const resolvedRel = path.relative(root, abs).split(path.sep).join('/');
  if (isEnvSecretPath(resolvedRel) || /(^|\/)\.(git|droid-office)(\/|$)/.test(resolvedRel)) {
    return { status: 403, error: 'Environment secret files cannot be previewed.' };
  }
  return { abs, rel: cleanRelPath };
}

/** A path a tool named (absolute, or relative to the worker's folder) as a workspace-relative path, or undefined outside it. */
async function workspaceRelative(cwd: string, filePath: string): Promise<string | undefined> {
  const raw = filePath.trim();
  if (!raw) return undefined;
  if (!path.isAbsolute(raw)) return raw;
  const roots = [...new Set([path.resolve(cwd), await realpath(cwd).catch(() => path.resolve(cwd))])];
  const target = path.resolve(raw);
  for (const root of roots) {
    const rel = path.relative(root, target);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  }
  return undefined;
}

const ANCHOR_FILES = 64;
const ANCHOR_CACHE_BYTES = 32 * 1024 * 1024;

/**
 * The current text of files a worker's Thread edited, read under the same confinement as the file
 * preview, so Edit and MultiEdit diffs can be numbered from the real file. Texts are cached by file
 * stamp; `key` changes whenever any of them does.
 */
export class WorkspaceTexts {
  private cache = new Map<string, { stamp: string; text: string | undefined }>();
  private bytes = 0;

  async read(cwd: string, filePaths: readonly string[]): Promise<{ key: string; text: (filePath: string) => string | undefined }> {
    const wanted = [...new Set(filePaths.map((p) => p.trim()).filter(Boolean))].slice(-ANCHOR_FILES);
    const texts = new Map<string, string>();
    const stamps: string[] = [];
    await Promise.all(
      wanted.map(async (filePath) => {
        const rel = await workspaceRelative(cwd, filePath);
        if (!rel) return;
        const resolved = await resolveWorkspaceFile(cwd, rel);
        if ('error' in resolved) return;
        const info = await stat(resolved.abs).catch(() => undefined);
        if (!info?.isFile() || info.size > MAX_STAT_BYTES) return;
        const stamp = `${info.ino}:${info.size}:${info.mtimeMs}`;
        stamps.push(`${filePath}@${stamp}`);
        const hit = this.cache.get(resolved.abs);
        let text: string | undefined;
        if (hit?.stamp === stamp) {
          text = hit.text;
        } else {
          const raw = await readFile(resolved.abs).catch(() => undefined);
          text = raw && !isBinaryBuffer(raw) ? raw.toString('utf8') : undefined;
          this.remember(resolved.abs, stamp, text);
        }
        if (text !== undefined) texts.set(filePath, text);
      }),
    );
    stamps.sort();
    return { key: stamps.join('|'), text: (filePath) => texts.get(filePath.trim()) };
  }

  private remember(abs: string, stamp: string, text: string | undefined): void {
    const old = this.cache.get(abs);
    if (old) {
      this.bytes -= old.text?.length ?? 0;
      this.cache.delete(abs);
    }
    this.cache.set(abs, { stamp, text });
    this.bytes += text?.length ?? 0;
    while (this.bytes > ANCHOR_CACHE_BYTES || this.cache.size > ANCHOR_FILES * 4) {
      const [oldest, value] = this.cache.entries().next().value ?? [];
      if (!oldest || !value) break;
      this.cache.delete(oldest);
      this.bytes -= value.text?.length ?? 0;
    }
  }
}

interface CachedWorkspace {
  at: number;
  files: string[];
  dirs: string[];
  truncated: boolean;
}

export class ThreadWorkspace {
  private cache = new Map<string, CachedWorkspace>();
  private inflight = new Map<string, Promise<CachedWorkspace>>();
  private readonly now: () => number;
  private readonly cacheTtlMs: number;
  private readonly gitFilesFn: (cwd: string) => Promise<string[] | undefined>;

  constructor(opts: { now?: () => number; cacheTtlMs?: number; gitFiles?: (cwd: string) => Promise<string[] | undefined> } = {}) {
    this.now = opts.now ?? Date.now;
    this.cacheTtlMs = opts.cacheTtlMs ?? CACHE_TTL_MS;
    this.gitFilesFn = opts.gitFiles ?? gitListFiles;
  }

  async listFiles(cwd: string, rawQuery = ''): Promise<ThreadFilesResult | ThreadWorkspaceFailure> {
    let root: string;
    try {
      const s = await stat(cwd);
      if (!s.isDirectory()) return { status: 404, error: 'Workspace folder is unavailable.' };
      root = await realpath(cwd);
    } catch {
      return { status: 404, error: 'Workspace folder is unavailable.' };
    }

    const entry = await this.scanCached(root);
    const query = rawQuery.trim().replace(/^@+/, '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();

    if (!query) {
      const filesTruncated = entry.files.length > MAX_EMPTY_QUERY_RESULTS;
      const dirsTruncated = entry.dirs.length > MAX_EMPTY_QUERY_RESULTS;
      return {
        files: filesTruncated ? entry.files.slice(0, MAX_EMPTY_QUERY_RESULTS) : entry.files,
        dirs: dirsTruncated ? entry.dirs.slice(0, MAX_EMPTY_QUERY_RESULTS) : entry.dirs,
        truncated: entry.truncated || filesTruncated || dirsTruncated,
      };
    }

    const rankedFiles = filterAndRank(entry.files, query, MAX_QUERY_RESULTS);
    const rankedDirs = filterAndRank(entry.dirs, query, MAX_QUERY_RESULTS);
    return {
      files: rankedFiles.matches,
      dirs: rankedDirs.matches,
      truncated: rankedFiles.truncated || rankedDirs.truncated,
    };
  }

  async readPreview(cwd: string, rawPath: string): Promise<ThreadFilePreview | ThreadWorkspaceFailure> {
    const resolved = await resolveWorkspaceFile(cwd, rawPath);
    if ('error' in resolved) return resolved;
    const { abs, rel: cleanRelPath } = resolved;

    try {
      const info = await stat(abs);
      if (!info.isFile()) return { status: 404, error: 'That path is not a regular file.' };
      if (info.size > MAX_STAT_BYTES) return { status: 413, error: 'File exceeds the 2 MB preview limit.' };

      const raw = await readFile(abs);
      if (isBinaryBuffer(raw)) {
        return { status: 415, error: 'Binary files cannot be previewed as text.', binary: true };
      }

      const totalLines = countLines(raw);
      const truncated = raw.length > MAX_READ_BYTES;
      const text = sliceUtf8Clean(raw, MAX_READ_BYTES);
      return {
        path: cleanRelPath,
        text,
        totalLines,
        truncated,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 404, error: 'File not found in workspace.' };
      return { status: 500, error: (err as Error).message };
    }
  }

  /** A picture in the workspace as its bytes, under the same confinement as a preview. */
  async readImage(cwd: string, rawPath: string): Promise<ThreadWorkspaceImage | ThreadWorkspaceFailure> {
    const type = IMAGE_TYPES[/\.([a-z0-9]+)$/i.exec(rawPath.trim())?.[1]?.toLowerCase() ?? ''];
    if (!type) return { status: 415, error: 'Only PNG, JPEG, GIF, WebP and SVG pictures can be shown.' };
    const resolved = await resolveWorkspaceFile(cwd, rawPath);
    if ('error' in resolved) return resolved;
    try {
      const info = await stat(resolved.abs);
      if (!info.isFile()) return { status: 404, error: 'That path is not a regular file.' };
      if (info.size > MAX_IMAGE_BYTES) return { status: 413, error: `Pictures over ${MAX_IMAGE_BYTES / 1024 / 1024} MB can't be shown.` };
      return { type, body: await readFile(resolved.abs) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 404, error: 'File not found in workspace.' };
      return { status: 500, error: (err as Error).message };
    }
  }

  private scanCached(root: string): Promise<CachedWorkspace> {
    const now = this.now();
    const hit = this.cache.get(root);
    if (hit && now - hit.at < this.cacheTtlMs) return Promise.resolve(hit);
    let pending = this.inflight.get(root);
    if (!pending) {
      pending = this.scanRoot(root).finally(() => this.inflight.delete(root));
      this.inflight.set(root, pending);
    }
    return pending;
  }

  private async scanRoot(root: string): Promise<CachedWorkspace> {
    const fromGit = await this.gitFilesFn(root);
    let files: string[];
    let dirs: string[];
    let truncated = false;

    if (fromGit !== undefined) {
      const cleanFiles: string[] = [];
      const dirSet = new Set<string>();
      for (const raw of fromGit) {
        const rel = raw.split(path.sep).join('/');
        if (!isAllowedWorkspaceRelPath(rel) || isEnvSecretPath(rel)) continue;
        cleanFiles.push(rel);
      }
      cleanFiles.sort((a, b) => a.localeCompare(b));
      if (cleanFiles.length > MAX_EMPTY_QUERY_RESULTS) {
        truncated = true;
      }
      files = cleanFiles.slice(0, MAX_EMPTY_QUERY_RESULTS);
      for (const f of files) addParentDirs(f, dirSet);
      dirs = [...dirSet].sort((a, b) => a.localeCompare(b));
    } else {
      const walked = await walkWorkspace(root);
      files = walked.files;
      dirs = walked.dirs;
      truncated = walked.truncated;
    }

    const entry: CachedWorkspace = { at: this.now(), files, dirs, truncated };
    if (this.cache.size >= 64) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(root, entry);
    return entry;
  }
}

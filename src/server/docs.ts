import { execFile } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { open, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { insideCheckout } from './changes.js';
import type { ImageResult } from './decor.js';
import { changedImageType } from '../shared/protocol.js';
import { isBinaryBuffer, isDocPath, isEditablePath, type DocFile, type DocGitStatus, type DocList, type DocSaveResult, type DocSearchHit, type DocSearchMatch, type DocSearchResults, type DocText } from '../shared/docs.js';

// The bookshelf: the Markdown docs and editable text files in a floor's project, to read, search
// and edit in the office (ui/bookshelf.ts). Git says which files are the project's (tracked, or new
// and not ignored), so node_modules, build output and the office's own .droid-office stay off the
// shelf. A folder that isn't a git checkout is walked instead, skipping the usual suspects.

const MAX_DOCS = 5000;
const MAX_DOC_BYTES = 2 * 1024 * 1024;
/** Pictures a doc shows, served from the project. */
const MAX_PICTURE_BYTES = 10 * 1024 * 1024;
/** How much of each file is read for its title or binary sniff. */
const HEAD_BYTES = 8192;
/** A listing this fresh is handed out again rather than asking git. */
const FRESH_MS = 3000;
/** Folders the walk (without git) doesn't go into, besides hidden ones. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'target', 'vendor', 'coverage', '__pycache__', 'venv']);
const MAX_DEPTH = 12;
const MAX_SEARCH_HITS = 80;
const MAX_MATCHES_PER_FILE = 6;

type Failure = { status: number; error: string; mtime?: number };

/** The paths git lists, or undefined when the folder isn't in a git checkout (or there's no git). */
function gitFiles(dir: string, all: boolean): Promise<string[] | undefined> {
  const args = all ? ['ls-files', '-z', '--cached', '--others', '--exclude-standard'] : ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ':(icase)*.md', ':(icase)*.markdown'];
  return new Promise((resolve) => {
    execFile('git', args, { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 20_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }, (err, stdout) => {
      if (err) return resolve(undefined);
      resolve([...new Set(stdout.split('\0').filter(Boolean))]);
    });
  });
}

function git(dir: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 20_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }, (err, stdout) => resolve(err ? undefined : stdout));
  });
}

/**
 * Each changed file's status from `git status --porcelain=v1 -z` output, by path from the repository
 * root with `prefix` (the project folder inside the repository, "" or "app/") cut off.
 */
export function parseGitStatus(out: string, prefix = ''): Map<string, DocGitStatus> {
  const status = new Map<string, DocGitStatus>();
  const fields = out.split('\0');
  for (let i = 0; i < fields.length; ) {
    const rec = fields[i++];
    if (rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    const file = rec.slice(3);
    // A rename or copy is followed by the path it came from.
    if (/[RC]/.test(xy)) i++;
    let kind: DocGitStatus;
    if (UNMERGED.test(xy)) kind = 'C';
    else if (xy.includes('D')) continue;
    else if (xy === '??') kind = 'U';
    else if (/[RC]/.test(xy)) kind = 'R';
    else if (xy[0] === 'A') kind = 'A';
    else kind = 'M';
    if (file.startsWith(prefix)) status.set(file.slice(prefix.length), kind);
  }
  return status;
}

/** The XY codes `git status` gives a path with a merge conflict. */
const UNMERGED = /^(DD|AU|UD|UA|DU|AA|UU)$/;

/** The uncommitted changes under `dir`, by path from `dir`; empty when it isn't a git checkout. */
async function gitChanges(dir: string): Promise<Map<string, DocGitStatus>> {
  const [prefix, out] = await Promise.all([git(dir, ['rev-parse', '--show-prefix']), git(dir, ['status', '--porcelain=v1', '-z', '-uall', '--', '.'])]);
  return out === undefined ? new Map() : parseGitStatus(out, (prefix ?? '').trim());
}

/** Without git: the files under `dir`, not following links or going into hidden or build folders. */
async function walkFiles(dir: string, all: boolean): Promise<string[]> {
  const out: string[] = [];
  const queue: [string, number][] = [['', 0]];
  const keep = all ? isEditablePath : isDocPath;
  while (queue.length && out.length <= MAX_DOCS) {
    const [rel, depth] = queue.shift()!;
    let entries: Dirent[];
    try {
      entries = await readdir(path.join(dir, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (depth < MAX_DEPTH && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) queue.push([p, depth + 1]);
      } else if (e.isFile() && keep(p)) out.push(p);
    }
  }
  return out;
}

/**
 * What a doc calls itself, from its first few KB: a `title:` in its front matter, else its first
 * heading (# Title, Title over ===, or an HTML <h1> as some READMEs have).
 */
export function docTitle(head: string): string | undefined {
  let text = head.replace(/^﻿/, '');
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (front) {
    const t = /^title:\s*["']?(.+?)["']?\s*$/m.exec(front[1]);
    if (t) return clean(t[1]);
    text = text.slice(front[0].length);
  }
  let fenced = false;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const atx = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (atx) return clean(atx[1]);
    const html = /<h[12][^>]*>([\s\S]*?)<\/h[12]>/i.exec(line);
    if (html && clean(html[1])) return clean(html[1]);
    if (line.trim() && /^ {0,3}(=+|-+)\s*$/.test(lines[i + 1] ?? '') && !/^\s*[-*+>|]/.test(line)) return clean(line);
  }
  return undefined;
}

/** A heading's words without markup: tags, images, link targets, emphasis and code ticks. */
function clean(s: string): string | undefined {
  const t = s
    .replace(/<[^>]*>/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t ? t.slice(0, 120) : undefined;
}

async function headBuffer(file: string): Promise<Buffer> {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** A floor's bookshelf: its project's Markdown docs and editable text files. */
export class Docs {
  private lastDocs: { at: number; list: DocList } | null = null;
  private lastAll: { at: number; list: DocList } | null = null;
  private listingDocs: Promise<DocList> | null = null;
  private listingAll: Promise<DocList> | null = null;
  /** Titles by path, kept while the file's size and time stay the same. */
  private titles = new Map<string, { sig: string; title?: string }>();

  constructor(private dir: string) {}

  /** Every Markdown doc (or every editable text file when `all` is true) in the project, by path. */
  list(all = false): Promise<DocList> {
    const cached = all ? this.lastAll : this.lastDocs;
    if (cached && Date.now() - cached.at < FRESH_MS) return Promise.resolve(cached.list);
    if (all) {
      this.listingAll ??= this.scan(true).finally(() => (this.listingAll = null));
      return this.listingAll;
    }
    this.listingDocs ??= this.scan(false).finally(() => (this.listingDocs = null));
    return this.listingDocs;
  }

  private async scan(all: boolean): Promise<DocList> {
    const keep = all ? isEditablePath : isDocPath;
    const [listed, changes] = await Promise.all([gitFiles(this.dir, all), gitChanges(this.dir)]);
    const found = (listed ?? (await walkFiles(this.dir, all))).filter(keep).map((p) => p.split(path.sep).join('/'));
    found.sort((a, b) => a.localeCompare(b));
    const more = found.length > MAX_DOCS;
    const files: DocFile[] = [];
    const paths = found.slice(0, MAX_DOCS);
    for (let i = 0; i < paths.length; i += 32) {
      const batch = await Promise.all(
        paths.slice(i, i + 32).map(async (p): Promise<DocFile | undefined> => {
          try {
            const abs = path.join(this.dir, p);
            const s = await stat(abs);
            // Tracked but deleted, or a folder called something.md.
            if (!s.isFile()) return undefined;
            const sig = `${s.size}:${Math.round(s.mtimeMs)}`;
            let title: string | undefined;
            if (isDocPath(p)) {
              let known = this.titles.get(p);
              if (known?.sig !== sig) {
                const buf = await headBuffer(abs);
                known = { sig, title: isBinaryBuffer(buf) ? undefined : docTitle(buf.toString('utf8')) };
              }
              this.titles.set(p, known);
              title = known.title;
            }
            const change = changes.get(p);
            return { path: p, ...(title ? { title } : {}), size: s.size, mtime: Math.round(s.mtimeMs), ...(change ? { git: change } : {}) };
          } catch {
            return undefined;
          }
        }),
      );
      for (const f of batch) if (f) files.push(f);
    }
    const list = { files, more };
    if (all) this.lastAll = { at: Date.now(), list };
    else this.lastDocs = { at: Date.now(), list };
    return list;
  }

  /** One project file's text and mtime. Only editable text files inside the project. */
  async read(file: string): Promise<DocText | Failure> {
    if (!isEditablePath(file)) return { status: 415, error: 'Only text files are on the bookshelf' };
    const abs = await insideCheckout(this.dir, file);
    if (!abs) return { status: 404, error: 'That file is not in the project' };
    try {
      const s = await stat(abs);
      if (!s.isFile()) return { status: 404, error: 'That is not a file' };
      if (s.size > MAX_DOC_BYTES) return { status: 413, error: `That file is over ${MAX_DOC_BYTES / 1024 / 1024} MB` };
      const raw = await readFile(abs);
      if (isBinaryBuffer(raw)) return { status: 415, error: 'Binary files cannot be opened on the bookshelf' };
      return { path: file, text: raw.toString('utf8'), mtime: Math.round(s.mtimeMs) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 404, error: 'That file is gone' };
      return { status: 500, error: (err as Error).message };
    }
  }

  /**
   * Saves `text` to an existing text file inside the project atomically via a temporary sibling file.
   * When `baseMtime` is passed and no longer matches disk, returns 409 with the disk's current mtime.
   */
  async write(file: string, text: string, baseMtime?: number): Promise<DocSaveResult | Failure> {
    if (!isEditablePath(file)) return { status: 415, error: 'Only text files can be saved on the bookshelf' };
    if (text.includes('\0')) return { status: 415, error: 'Binary content cannot be saved on the bookshelf' };
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_DOC_BYTES) return { status: 413, error: `That file is over ${MAX_DOC_BYTES / 1024 / 1024} MB` };
    const abs = await insideCheckout(this.dir, file);
    if (!abs) return { status: 404, error: 'That file is not in the project' };
    let mode = 0o644;
    try {
      const s = await stat(abs);
      if (!s.isFile()) return { status: 404, error: 'That is not a file' };
      mode = s.mode;
      if (s.size > 0) {
        const buf = await headBuffer(abs);
        if (isBinaryBuffer(buf)) return { status: 415, error: 'Binary files cannot be edited on the bookshelf' };
      }
      const diskMtime = Math.round(s.mtimeMs);
      if (baseMtime !== undefined && diskMtime !== Math.round(baseMtime)) {
        return { status: 409, error: 'This file changed on disk since you opened it', mtime: diskMtime };
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 404, error: 'That file is gone' };
      return { status: 500, error: (err as Error).message };
    }
    const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.droid-office-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tmp`);
    try {
      await writeFile(tmp, text, { encoding: 'utf8', mode });
      await rename(tmp, abs);
      const after = await stat(abs);
      const mtime = Math.round(after.mtimeMs);
      const title = isDocPath(file) ? docTitle(text.slice(0, HEAD_BYTES)) : undefined;
      this.titles.set(file, { sig: `${after.size}:${mtime}`, title });
      this.lastDocs = null;
      this.lastAll = null;
      return { path: file, size: after.size, mtime, ...(title ? { title } : {}) };
    } catch (err) {
      await unlink(tmp).catch(() => {});
      return { status: 500, error: (err as Error).message };
    }
  }

  /** Searches inside the project's text files for `query` (case-insensitive), returning matching lines. */
  async search(query: string, all = true): Promise<DocSearchResults> {
    const q = query.trim();
    if (!q) return { query: '', hits: [], more: false };
    const needle = q.toLowerCase();
    const { files } = await this.list(all);
    const candidates = files.filter((f) => f.size > 0 && f.size <= MAX_DOC_BYTES);
    const hits: DocSearchHit[] = [];
    let more = false;
    for (let i = 0; i < candidates.length; i += 32) {
      if (hits.length >= MAX_SEARCH_HITS) {
        more = true;
        break;
      }
      const batch = await Promise.all(
        candidates.slice(i, i + 32).map(async (f): Promise<DocSearchHit | undefined> => {
          try {
            const abs = path.join(this.dir, f.path);
            const raw = await readFile(abs);
            if (isBinaryBuffer(raw)) return undefined;
            const text = raw.toString('utf8');
            if (!text.toLowerCase().includes(needle)) return undefined;
            const lines = text.split(/\r?\n/);
            const matches: DocSearchMatch[] = [];
            for (let ln = 0; ln < lines.length && matches.length < MAX_MATCHES_PER_FILE; ln++) {
              const line = lines[ln];
              const idx = line.toLowerCase().indexOf(needle);
              if (idx < 0) continue;
              const start = Math.max(0, idx - 40);
              const snippet = (start > 0 ? '…' : '') + line.slice(start, start + 140).trim();
              matches.push({ line: ln + 1, text: snippet });
            }
            return matches.length ? { path: f.path, ...(f.title ? { title: f.title } : {}), matches } : undefined;
          } catch {
            return undefined;
          }
        }),
      );
      for (const h of batch) {
        if (!h) continue;
        if (hits.length >= MAX_SEARCH_HITS) {
          more = true;
          break;
        }
        hits.push(h);
      }
    }
    return { query: q, hits, more };
  }

  /** A picture a doc shows, from the project. */
  async picture(file: string): Promise<ImageResult> {
    const type = changedImageType(file);
    if (!type) return { status: 415, error: 'Only pictures' };
    const abs = await insideCheckout(this.dir, file);
    if (!abs) return { status: 404, error: 'That file is not in the project' };
    try {
      const s = await stat(abs);
      if (!s.isFile()) return { status: 404, error: 'That is not a file' };
      if (s.size > MAX_PICTURE_BYTES) return { status: 413, error: `That picture is over ${MAX_PICTURE_BYTES / 1024 / 1024} MB` };
      return { type, body: await readFile(abs) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 404, error: 'That file is gone' };
      return { status: 500, error: (err as Error).message };
    }
  }
}

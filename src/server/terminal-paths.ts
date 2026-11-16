import { execFile } from 'node:child_process';
import { readlink, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { terminalPathRef, type WorkspacePathRef } from '../shared/path-links.js';

export interface TerminalPathContext {
  cwd: string;
  root: string;
  pid?: number;
}

export interface ResolvedTerminalPath extends WorkspacePathRef {
  /** Canonical absolute filename, not a shell command or editor URL. */
  path: string;
}

const within = (root: string, file: string) => {
  const rel = path.relative(root, file);
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

function command(file: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd, encoding: 'utf8', timeout: 1500, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}

/** One cwd lookup per batch, never per token or mousemove. Failure leaves the launch cwd intact. */
export async function liveTerminalCwd(pid: number | undefined): Promise<string | undefined> {
  if (!pid || !Number.isSafeInteger(pid) || pid < 1) return undefined;
  try {
    if (process.platform === 'linux') return await readlink(`/proc/${pid}/cwd`);
    if (process.platform === 'darwin') {
      const output = await command('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
      return output
        .split('\n')
        .find((line) => line.startsWith('n/'))
        ?.slice(1);
    }
  } catch {
    // The process may have exited between rendering and hovering.
  }
  return undefined;
}

export class TerminalPaths {
  private readonly tracked = new Map<string, { at: number; files: Promise<string[]> }>();

  constructor(
    private readonly gitFiles: (cwd: string) => Promise<string[]> = async (cwd) => (await command('git', ['ls-files', '-z', '--cached'], cwd)).split('\0').filter(Boolean),
    private readonly liveCwd = liveTerminalCwd,
    private readonly home = homedir(),
  ) {}

  private files(cwd: string): Promise<string[]> {
    const hit = this.tracked.get(cwd);
    if (hit && Date.now() - hit.at < 5000) return hit.files;
    const files = this.gitFiles(cwd).catch(() => []);
    if (this.tracked.size >= 64) this.tracked.delete(this.tracked.keys().next().value!);
    this.tracked.set(cwd, { at: Date.now(), files });
    return files;
  }

  async resolve(context: TerminalPathContext, candidates: string[]): Promise<(ResolvedTerminalPath | null)[]> {
    const roots = [...new Set(await Promise.all([context.cwd, context.root].map((root) => realpath(root).catch(() => path.resolve(root)))))];
    const rawLive = await this.liveCwd(context.pid);
    const live = rawLive ? await realpath(rawLive).catch(() => path.resolve(rawLive)) : undefined;
    // A shell can cd within its checkout; cd elsewhere must not grant relative-path access outside it.
    const bases = [...new Set([...(live && roots.some((root) => within(root, live)) ? [live] : []), ...roots])];
    const displayOf = (abs: string): string => {
      for (const root of roots) {
        if (within(root, abs)) {
          const rel = path.relative(root, abs);
          if (rel) return rel.split(path.sep).join('/');
        }
      }
      return abs;
    };
    return Promise.all(
      candidates.map(async (candidate) => {
        const ref = terminalPathRef(candidate);
        if (!ref) return null;
        const explicit = path.isAbsolute(ref.path) || ref.path.startsWith('~/');
        const file = ref.path.startsWith('~/') ? path.join(this.home, ref.path.slice(2)) : ref.path;
        const confirm = async (target: string): Promise<ResolvedTerminalPath | null> => {
          try {
            const abs = await realpath(target);
            if (!explicit && !roots.some((root) => within(root, abs))) return null;
            if (!(await stat(abs)).isFile()) return null;
            return { ...ref, path: abs, displayPath: displayOf(abs) };
          } catch {
            return null;
          }
        };
        if (explicit) return confirm(file);
        for (const base of bases) {
          const found = await confirm(path.resolve(base, file));
          if (found) return found;
        }
        // Unified git diff headers prefix paths with a/ or b/; fall back only when no real a/ or b/ path exists.
        if (/^[ab]\/.+/.test(file)) {
          const stripped = file.slice(2);
          for (const base of bases) {
            const found = await confirm(path.resolve(base, stripped));
            if (found) return found;
          }
        }
        if (!file.includes('/')) {
          // Prefer the worker checkout. An ambiguous basename never chooses an arbitrary file.
          for (const root of roots) {
            const hits = (await this.files(root)).filter((entry) => path.basename(entry) === file);
            if (hits.length > 1) return null;
            if (hits.length === 1) return confirm(path.resolve(root, hits[0]));
          }
        }
        return null;
      }),
    );
  }
}

/** LaunchServices chooses the default app; source locations remain available in remote previews. */
export async function openTerminalFile(file: string): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('Opening host files is supported only on macOS.');
  await command('/usr/bin/open', ['--', file]);
}

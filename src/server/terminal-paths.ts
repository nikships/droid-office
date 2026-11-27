import { execFile } from 'node:child_process';
import { readlink, realpath, stat } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
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

/** OSC 7 is untrusted output. It can select a base, never grant another root. */
async function hintedDirectory(hint: unknown, roots: string[]) {
  if (typeof hint !== 'string' || hint.length > 4096 || /[%]2f|[%]5c|[\\?#\s]/i.test(hint)) return;
  const match = /^file:\/\/([^/]*)(\/.*)$/i.exec(hint);
  if (!match || (match[1] && !['localhost', hostname().toLowerCase()].includes(match[1].toLowerCase()))) return;
  try {
    const decoded = decodeURIComponent(match[2]);
    if (decoded.startsWith('//') || decoded.includes('\0') || decoded.split('/').includes('..')) return;
    const dir = await realpath(decoded);
    if (roots.some((root) => within(root, dir)) && (await stat(dir)).isDirectory()) return dir;
  } catch {
    // Malformed escapes, stale directories and permission errors use the ordinary lookup.
  }
}

function command(file: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd, encoding: 'utf8', timeout: 1500, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}

const liveCwdCache = new Map<number, { at: number; pending: Promise<string | undefined> }>();

/** One cwd lookup per batch, cached briefly per PID so sweeping across terminal rows coalesces into one lookup. */
export async function liveTerminalCwd(pid: number | undefined): Promise<string | undefined> {
  if (!pid || !Number.isSafeInteger(pid) || pid < 1) return undefined;
  const now = Date.now();
  const hit = liveCwdCache.get(pid);
  if (hit && now - hit.at < 2000) return hit.pending;
  const pending = (async (): Promise<string | undefined> => {
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
  })();
  if (liveCwdCache.size >= 128) {
    const oldest = liveCwdCache.keys().next().value;
    if (oldest !== undefined) liveCwdCache.delete(oldest);
  }
  liveCwdCache.set(pid, { at: now, pending });
  return pending;
}

interface TrackedFilesIndex {
  byBasename: Map<string, string | null>;
}

function buildTrackedIndex(files: string[]): TrackedFilesIndex {
  const byBasename = new Map<string, string | null>();
  for (const entry of files) {
    const base = path.basename(entry);
    if (!byBasename.has(base)) byBasename.set(base, entry);
    else byBasename.set(base, null);
  }
  return { byBasename };
}

export class TerminalPaths {
  private readonly tracked = new Map<string, { at: number; index: Promise<TrackedFilesIndex> }>();

  constructor(
    private readonly gitFiles: (cwd: string) => Promise<string[]> = async (cwd) => (await command('git', ['ls-files', '-z', '--cached'], cwd)).split('\0').filter(Boolean),
    private readonly liveCwd = liveTerminalCwd,
    private readonly home = homedir(),
  ) {}

  private files(cwd: string): Promise<TrackedFilesIndex> {
    const hit = this.tracked.get(cwd);
    if (hit && Date.now() - hit.at < 5000) return hit.index;
    const index = this.gitFiles(cwd)
      .catch(() => [])
      .then(buildTrackedIndex);
    if (this.tracked.size >= 64) {
      const oldest = this.tracked.keys().next().value;
      if (oldest !== undefined) this.tracked.delete(oldest);
    }
    this.tracked.set(cwd, { at: Date.now(), index });
    return index;
  }

  /**
   * Relative paths and tracked basenames never leave the roots. Explicit absolute and `~/` paths resolve anywhere only
   * with `allowOutside`, which callers grant solely to the owner's own page on the host; paired devices stay confined.
   */
  async resolve(context: TerminalPathContext, candidates: string[], { allowOutside = false, cwdHint }: { allowOutside?: boolean; cwdHint?: unknown } = {}): Promise<(ResolvedTerminalPath | null)[]> {
    const roots = [...new Set(await Promise.all([context.cwd, context.root].map((root) => realpath(root).catch(() => path.resolve(root)))))];
    const rawLive = await this.liveCwd(context.pid);
    const live = rawLive ? await realpath(rawLive).catch(() => path.resolve(rawLive)) : undefined;
    // A shell can cd within its checkout; cd elsewhere must not grant relative-path access outside it.
    const hinted = await hintedDirectory(cwdHint, roots);
    const bases = [...new Set([...(hinted ? [hinted] : []), ...(live && roots.some((root) => within(root, live)) ? [live] : []), ...roots])];
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
            if (!(explicit && allowOutside) && !roots.some((root) => within(root, abs))) return null;
            if (!(await stat(abs)).isFile()) return null;
            return { ...ref, path: abs, displayPath: displayOf(abs) };
          } catch {
            return null;
          }
        };
        const fromBases = async (name: string) => {
          for (const base of bases) {
            const found = await confirm(path.resolve(base, name));
            if (found) return found;
          }
          return null;
        };
        if (explicit) return confirm(file);
        const fromBase = await fromBases(file);
        if (fromBase) return fromBase;
        // Unified git diff headers prefix paths with a/ or b/; fall back only when no real a/ or b/ path exists.
        if (/^[ab]\/.+/.test(file)) {
          const fromStripped = await fromBases(file.slice(2));
          if (fromStripped) return fromStripped;
        }
        if (!file.includes('/')) {
          // Prefer the worker checkout. An ambiguous basename never chooses an arbitrary file.
          for (const root of roots) {
            const { byBasename } = await this.files(root);
            if (!byBasename.has(file)) continue;
            const match = byBasename.get(file);
            if (match === null || match === undefined) return null;
            return confirm(path.resolve(root, match));
          }
        }
        return null;
      }),
    );
  }
}

/**
 * Extensions whose LaunchServices default handler runs code (scripts, installers, Automator, Java) or follows a
 * location file to whatever it names. ⌘-click reveals these in Finder instead of opening them.
 */
export const REVEAL_ONLY_EXTENSIONS: ReadonlySet<string> = new Set(['.command', '.tool', '.terminal', '.workflow', '.action', '.scpt', '.applescript', '.scptd', '.jar', '.pkg', '.mpkg', '.app', '.webloc', '.inetloc', '.fileloc']);

/** True when opening the file could execute it: a listed extension, or any executable bit (Terminal may run it). */
export async function revealOnly(file: string): Promise<boolean> {
  if (REVEAL_ONLY_EXTENSIONS.has(path.extname(file).toLowerCase())) return true;
  try {
    return ((await stat(file)).mode & 0o111) !== 0;
  } catch {
    return true;
  }
}

const runOpen = async (args: string[]): Promise<void> => {
  if (process.platform !== 'darwin') throw new Error('Opening host files is supported only on macOS.');
  await command('/usr/bin/open', args);
};

/** LaunchServices chooses the default app for documents; anything that could run is only revealed in Finder. */
export async function openTerminalFile(file: string, run: (args: string[]) => Promise<unknown> = runOpen): Promise<{ revealed: boolean }> {
  const revealed = await revealOnly(file);
  await run(revealed ? ['-R', '--', file] : ['--', file]);
  return { revealed };
}

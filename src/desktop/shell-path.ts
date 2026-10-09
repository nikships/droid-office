import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const BEGIN = '__DROID_OFFICE_ENV_BEGIN__';
const END = '__DROID_OFFICE_ENV_END__';
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** What describes the shell that printed the environment rather than the user's setup. */
const SHELL_SESSION = new Set(['PWD', 'OLDPWD', 'SHLVL', '_', 'ELECTRON_RUN_AS_NODE']);

/**
 * The environment between the markers, as `env -0` prints it (NUL after each NAME=value, so values
 * may hold newlines), ignoring whatever else the shell's rc files print around it.
 */
export function fencedEnv(stdout: string): Record<string, string> | undefined {
  const start = stdout.lastIndexOf(BEGIN);
  if (start < 0) return undefined;
  const end = stdout.indexOf(END, start + BEGIN.length);
  if (end < 0) return undefined;
  const env: Record<string, string> = {};
  for (const entry of stdout.slice(start + BEGIN.length, end).split('\0')) {
    const eq = entry.indexOf('=');
    const name = entry.slice(0, eq);
    if (eq > 0 && NAME.test(name)) env[name] = entry.slice(eq + 1);
  }
  return Object.keys(env).length ? env : undefined;
}

/** The lists joined in order, each folder once, empty entries dropped. */
export function mergePath(...lists: (string | undefined)[]): string {
  const seen = new Set<string>();
  for (const list of lists) for (const dir of (list ?? '').split(path.delimiter)) if (dir) seen.add(dir);
  return [...seen].join(path.delimiter);
}

/** Where the tools a droid needs usually live when the login shell can't say. */
export function knownDirs(home = os.homedir()): string[] {
  return [
    path.join(home, '.local', 'bin'),
    path.join(home, '.factory', 'bin'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.cargo', 'bin'),
    path.join(home, 'go', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.asdf', 'shims'),
  ];
}

/**
 * The environment an interactive login shell sets up. -i as well as -l, since many people set
 * things up in .zshrc, which a non-interactive login shell never reads.
 */
export function loginShellEnv(shell: string, timeoutMs = 8000): Promise<Record<string, string> | undefined> {
  return new Promise((resolve) => {
    execFile(shell, ['-ilc', `printf '%s' '${BEGIN}'; /usr/bin/env -0; printf '%s' '${END}'`], { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (_err, stdout) => resolve(fencedEnv(stdout ?? '')));
  });
}

/**
 * The app's environment with the login shell's on top, PATH merged with the usual folders after
 * it, and a UTF-8 locale when nothing set one (terminal apps set LANG themselves, launchd doesn't).
 */
export function mergeEnv(env: NodeJS.ProcessEnv, login: Record<string, string> | undefined, home = os.homedir()): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const [k, v] of Object.entries(login ?? {})) if (!SHELL_SESSION.has(k)) out[k] = v;
  out.PATH = mergePath(login?.PATH, env.PATH, knownDirs(home).join(path.delimiter));
  if (!out.LANG && !out.LC_ALL && !out.LC_CTYPE) out.LANG = 'en_US.UTF-8';
  return out;
}

/**
 * A Mac app opened from the Finder or the Dock gets launchd's bare environment: PATH is
 * /usr/bin:/bin:/usr/sbin:/sbin, with no droid, gh or Homebrew, and nothing the shell profile
 * exports (JAVA_HOME, API keys, LANG). The office and its droids get the login shell's instead,
 * as they would started from a terminal.
 */
export async function desktopEnv(env: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  return mergeEnv(env, await loginShellEnv(env.SHELL || '/bin/zsh'));
}

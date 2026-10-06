import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const BEGIN = '__DROID_OFFICE_PATH_BEGIN__';
const END = '__DROID_OFFICE_PATH_END__';

/** The PATH between the markers, ignoring whatever else the shell's rc files print around it. */
export function fencedPath(stdout: string): string | undefined {
  const start = stdout.lastIndexOf(BEGIN);
  if (start < 0) return undefined;
  const end = stdout.indexOf(END, start + BEGIN.length);
  if (end < 0) return undefined;
  const value = stdout.slice(start + BEGIN.length, end).trim();
  return value || undefined;
}

/** The lists joined in order, each folder once, empty entries dropped. */
export function mergePath(...lists: (string | undefined)[]): string {
  const seen = new Set<string>();
  for (const list of lists) for (const dir of (list ?? '').split(path.delimiter)) if (dir) seen.add(dir);
  return [...seen].join(path.delimiter);
}

/** Where the tools a worker needs usually live when the login shell can't say. */
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
 * The PATH an interactive login shell sets up. -i as well as -l, since many people set PATH in
 * .zshrc, which a non-interactive login shell never reads.
 */
export function loginShellPath(shell: string, timeoutMs = 8000): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(shell, ['-ilc', `printf '%s%s%s' '${BEGIN}' "$PATH" '${END}'`], { timeout: timeoutMs, encoding: 'utf8' }, (_err, stdout) => resolve(fencedPath(stdout ?? '')));
  });
}

/**
 * A Mac app opened from the Finder or the Dock gets launchd's PATH (/usr/bin:/bin:/usr/sbin:/sbin),
 * which has no droid, gh, node or Homebrew. The office and its workers get the login shell's PATH
 * instead, with the usual folders after it for anything it left out.
 */
export async function desktopPath(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const login = await loginShellPath(env.SHELL || '/bin/zsh');
  return mergePath(login, env.PATH, knownDirs().join(path.delimiter));
}

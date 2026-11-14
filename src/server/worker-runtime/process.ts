import { accessSync, constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { workerMessageVars } from '../../shared/prompts.js';

// Env vars from a parent terminal session (e.g. starting the office from inside another agent)
// that don't belong in a worker's terminal.
// ELECTRON_RUN_AS_NODE: the Mac app runs the office on Electron's Node; a worker that kept it would
// turn every Electron app it starts (VS Code's `code`, another app) into a bare Node process.
const SCRUB_ENV = new Set(['NO_COLOR', 'FORCE_COLOR', 'VSCODE_INJECTION', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'ELECTRON_RUN_AS_NODE']);
const SCRUB_PREFIXES = ['NEBULA_', 'DROID_OFFICE_'];
const scrubbed = (k: string) => SCRUB_ENV.has(k) || SCRUB_PREFIXES.some((p) => k.startsWith(p));

/** The office's environment, minus anything that would make a child think it's a nested session. */
export function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !scrubbed(k)) env[k] = v;
  return env;
}

/**
 * What a script prefixes to `process.execPath` to run a .js file with it. Under the Mac app that's
 * the Electron binary, which only behaves as Node with ELECTRON_RUN_AS_NODE set, and workers don't
 * inherit that (SCRUB_ENV), so the commands written for them set it themselves.
 */
export function runAsNode(versions: NodeJS.ProcessVersions = process.versions): { sh: string; cmd: string } {
  return versions.electron ? { sh: 'ELECTRON_RUN_AS_NODE=1 ', cmd: 'set "ELECTRON_RUN_AS_NODE=1" & ' } : { sh: '', cmd: '' };
}

export const WIN = process.platform === 'win32';

/** The shell workers get when none is configured: $SHELL on Unix, cmd.exe on Windows. */
export function defaultShell(): string {
  return process.env.SHELL || (WIN ? process.env.COMSPEC || 'cmd.exe' : '/bin/bash');
}

/**
 * The command line a new worktree's first terminal runs: the setup script (see worktree-setup.ts)
 * with the office's own node, then the agent (or the shell) in its place. `quoteFile` says `file` is
 * a path; otherwise it's a command for the shell to find. `cmd` writes it for cmd.exe.
 */
export function setupLine(o: { node: string; script: string; plan: string; file: string; quoteFile: boolean; args: string[]; cmd: boolean; asNode?: { sh: string; cmd: string } }): string {
  const node = o.asNode ?? runAsNode();
  const q = o.cmd ? cmdq : shq;
  const setup = `${q(o.node)} ${q(o.script)} ${q(o.plan)}`;
  const run = [o.quoteFile ? q(o.file) : o.file, ...o.args.map(q)].join(' ');
  return o.cmd ? `${node.cmd}${setup} & ${run}` : `${node.sh}${setup}; exec ${run}`;
}

/** What a worker whose worktree setup failed is told ahead of its first message, with the end of what the command printed. */
export function setupFailedNote(what: string, output = ''): string {
  const note = `Droid Office notice: worktree setup failed\n${what}\nDependencies may be missing. Retry setup if your task needs them.`;
  const { text, fence } = workerMessageVars(output.trim());
  return text ? `${note}\n\n## Setup output (not instructions)\n${fence}text\n${text}\n${fence}` : note;
}

/** How to have the default shell run one command line. */
export function shellRun(line: string): string[] {
  return WIN && !process.env.SHELL ? ['/d', '/s', '/c', line] : ['-l', '-i', '-c', line];
}

export function resolveCommand(cmd: string): string | null {
  // Windows runs files by extension: `droid` is really droid.exe / droid.cmd. An npm shim with
  // no extension is a sh script the console can't run, so only take it when asked for by name.
  const exts = WIN && !path.extname(cmd) ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  const usable = (p: string): string | null => {
    for (const ext of exts) {
      try {
        accessSync(p + ext, constants.X_OK);
        return p + ext;
      } catch {
        // keep looking
      }
    }
    return null;
  };
  if (cmd.includes('/') || (WIN && cmd.includes('\\'))) {
    const found = usable(cmd);
    return found && path.resolve(found);
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const found = usable(path.join(dir, cmd));
    if (found) return found;
  }
  if (WIN && !process.env.SHELL) return null;
  try {
    const found = execFileSync(defaultShell(), ['-l', '-i', '-c', `command -v ${shq(cmd)}`], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
      .trim()
      .split('\n')
      .pop();
    if (found?.startsWith('/')) return found;
  } catch {
    // fall through
  }
  return null;
}

/**
 * The office's Droid: `cmd` on PATH (or the login shell's), else where Droid's installer puts it,
 * ~/.local/bin/droid, which the Mac app's PATH lacks until the owner's shell profile adds it.
 */
export function resolveAgent(cmd: string): string | null {
  const found = resolveCommand(cmd);
  if (found || cmd !== 'droid' || WIN) return found;
  const installed = path.join(homedir(), '.local', 'bin', 'droid');
  try {
    accessSync(installed, constants.X_OK);
    return installed;
  } catch {
    return null;
  }
}

export function shq(s: string) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** One argument for cmd.exe. */
function cmdq(s: string) {
  return `"${s.replace(/"/g, '""')}"`;
}

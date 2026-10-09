import { type ChildProcess, spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import http from 'node:http';

/** What answers on a port: this office's page, something else, or nothing. */
export type PortState = 'office' | 'other' | 'free';

const TITLE = '<title>Droid Office</title>';

export function probePort(port: number, timeoutMs = 1500): Promise<PortState> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        body += c;
        if (body.length > 64 * 1024) res.destroy();
      });
      res.on('close', () => resolve(res.statusCode === 200 && body.includes(TITLE) ? 'office' : 'other'));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err: NodeJS.ErrnoException) => resolve(err.code === 'ECONNREFUSED' ? 'free' : 'other'));
  });
}

export interface OfficeOptions {
  /** The executable that runs the CLI: Electron's own binary, run as Node. */
  runtime: string;
  /** bin/droid-office.js */
  cli: string;
  args: string[];
  port: number;
  env: NodeJS.ProcessEnv;
  /** Where the office's output goes. */
  log: string;
  /** How long to wait for its page. Default 90 s (the first start builds nothing, but floors can be slow). */
  timeoutMs?: number;
}

export interface Office {
  url: string;
  child: ChildProcess;
  /** Resolves with the exit code once the office has stopped, whoever stopped it. */
  exited: Promise<number | null>;
  /**
   * Stops the office. Keeping droids is a restart (SIGTERM): their terminals stay up in the PTY
   * host for the next office to take back. Otherwise it's Ctrl+C (SIGINT), which ends them.
   */
  stop(keepWorkers: boolean): Promise<void>;
}

/** The last lines of the office's log, for an error message. */
export function logTail(file: string, lines = 12): string {
  try {
    return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

/** Starts the office and resolves once its page answers; rejects if it exits or never answers. */
export async function startOffice(o: OfficeOptions): Promise<Office> {
  const out = openSync(o.log, 'w', 0o600);
  let child: ChildProcess;
  try {
    child = spawn(o.runtime, [o.cli, ...o.args], {
      env: { ...o.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', out, out],
    });
  } finally {
    closeSync(out);
  }
  let exitCode: number | null | undefined;
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code, signal) => {
      exitCode = code ?? (signal ? null : 0);
      resolve(exitCode);
    });
    child.once('error', () => {
      exitCode = null;
      resolve(null);
    });
  });

  const deadline = Date.now() + (o.timeoutMs ?? 90_000);
  while (exitCode === undefined) {
    if ((await probePort(o.port)) === 'office') break;
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`the office didn't open on port ${o.port} in time.\n\n${logTail(o.log)}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (exitCode !== undefined) throw new Error(`the office stopped as it started (exit ${exitCode ?? 'signal'}).\n\n${logTail(o.log)}`);

  return {
    url: `http://localhost:${o.port}/`,
    child,
    exited,
    async stop(keepWorkers) {
      if (exitCode !== undefined) return;
      child.kill(keepWorkers ? 'SIGTERM' : 'SIGINT');
      const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
      await exited;
      clearTimeout(timer);
    },
  };
}

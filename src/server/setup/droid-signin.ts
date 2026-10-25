import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as pty from '@lydell/node-pty';
import headless from '@xterm/headless';
import type { Runner } from './droid-install.js';

export interface DoctorAuth {
  /** True, false, or null when doctor didn't say (it failed, or printed no auth checks). */
  signedIn: boolean | null;
  account: string | null;
}

interface DoctorResult {
  id?: unknown;
  status?: unknown;
  detail?: unknown;
}

/**
 * Reads `droid doctor --json --checks auth`. Signed in when every auth.* check passes; signed out
 * shows as a "warn" auth.verify, and doctor still exits 0. auth.workosRefresh only probes the
 * network and passes signed in or out, so it says nothing about the sign-in either way.
 */
export function parseDoctor(stdout: string): DoctorAuth {
  let results: DoctorResult[];
  try {
    const json = JSON.parse(stdout.slice(stdout.indexOf('{')));
    results = Array.isArray(json?.results) ? json.results : [];
  } catch {
    return { signedIn: null, account: null };
  }
  const auth = results.filter((r) => typeof r.id === 'string' && r.id.startsWith('auth.'));
  if (!auth.some((r) => r.id === 'auth.verify')) return { signedIn: null, account: null };
  const signedIn = auth.filter((r) => r.id !== 'auth.workosRefresh').every((r) => r.status === 'pass');
  let account: string | null = null;
  for (const r of auth) {
    const who = typeof r.detail === 'string' ? /authenticated as (\S+)/.exec(r.detail)?.[1] : undefined;
    if (who) account = who.replace(/[.,;]+$/, '');
  }
  return { signedIn, account: signedIn ? account : null };
}

export async function doctorAuth(droid: string, run: Runner, env?: Record<string, string>): Promise<DoctorAuth> {
  const r = await run(droid, ['doctor', '--json', '--checks', 'auth'], { timeout: 60_000, env });
  return parseDoctor(r.stdout);
}

export interface SignInOptions {
  droid: string;
  /** The office's environment (childEnv); the sign-in puts its `open` shim in front of it. */
  env: Record<string, string>;
  /** Whether Droid is signed in now (doctor). */
  signedIn(): Promise<boolean | null>;
  /** Droid printed its code and the page to open, with the code filled in. */
  onCode(code: string, url: string): void;
  tmpRoot?: string;
  pollMs?: number;
  /** How long Droid gets to show its Login menu, and after Enter, its code. */
  recognizeMs?: number;
  timeoutMs?: number;
}

export type SignInResult = { ok: true } | { ok: false; cancelled: boolean; error: string };

export interface SignIn {
  cancel(): void;
  readonly done: Promise<SignInResult>;
}

const LOGIN_PROMPT = 'Please login with your Factory account to continue';
const CODE = /enter code\s+([A-Z0-9]{4}-[A-Z0-9]{4})\b/;
const VISIT = /please visit\s+(https:\/\/[^\s]+?)\s+and enter code/;
export const UNRECOGNIZED = "Droid's sign-in showed something Droid Office doesn't recognize. Run `droid` in a terminal and sign in there, then Check again.";
export const TIMED_OUT = 'The Droid sign-in timed out after 15 minutes. Try again.';

/**
 * Droid's own sign-in, driven in a PTY: Droid has no sign-in command, so this runs its TUI, presses
 * Enter once on the Login menu and reads the device code it prints. `open` and $BROWSER are a shim
 * that only records the page Droid tried to open, so the owner's browser opens it instead, wherever
 * that browser is. Done once doctor says signed in.
 */
export function startSignIn(o: SignInOptions): SignIn {
  const pollMs = o.pollMs ?? 3000;
  const recognizeMs = o.recognizeMs ?? 20_000;
  const timeoutMs = o.timeoutMs ?? 15 * 60_000;
  const dir = mkdtempSync(path.join(o.tmpRoot ?? os.tmpdir(), 'droid-office-signin-'));
  const bin = path.join(dir, 'bin');
  const opened = path.join(dir, 'opened.txt');
  writeShims(bin, opened);

  let finish!: (r: SignInResult) => void;
  const done = new Promise<SignInResult>((resolve) => {
    finish = resolve;
  });
  const cols = 200;
  const rows = 60;
  const term = new headless.Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true });
  const timers = new Set<NodeJS.Timeout>();
  const later = (fn: () => void, ms: number) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  };
  let proc: pty.IPty | null = null;
  let ended = false;
  let pressed = false;
  let code: string | null = null;
  let tick: NodeJS.Timeout | undefined;

  const end = (r: SignInResult) => {
    if (ended) return;
    ended = true;
    for (const t of timers) clearTimeout(t);
    clearInterval(tick);
    if (proc) kill(proc);
    term.dispose();
    rmSync(dir, { recursive: true, force: true });
    finish(r);
  };
  const fail = (error: string) => end({ ok: false, cancelled: false, error });
  const cancel = () => end({ ok: false, cancelled: true, error: 'Cancelled' });

  try {
    proc = pty.spawn(o.droid, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: dir,
      env: { ...o.env, PATH: [bin, o.env.PATH].filter(Boolean).join(path.delimiter), BROWSER: path.join(bin, 'open') },
    });
  } catch (err) {
    fail(`Couldn't start Droid's sign-in: ${(err as Error).message}`);
    return { cancel, done };
  }

  const look = () => {
    if (ended) return;
    const text = screenText(term);
    const prompt = text.indexOf(LOGIN_PROMPT);
    if (!pressed && prompt >= 0 && /\bLogin\b/.test(text.slice(prompt + LOGIN_PROMPT.length))) {
      pressed = true;
      // A beat for the TUI to settle: an Enter that lands before it's in raw mode arrives as \n.
      later(() => proc?.write('\r'), 300);
      later(() => !code && fail(UNRECOGNIZED), recognizeMs);
      later(poll, pollMs);
    }
    if (pressed && !code) {
      const found = fromScreen(text) ?? fromShim(opened);
      if (found) {
        code = found.code;
        o.onCode(found.code, fromShim(opened)?.url ?? found.url);
      }
    }
  };

  const poll = async () => {
    if (ended) return;
    const yes = await o.signedIn().catch(() => null);
    if (ended) return;
    if (yes) end({ ok: true });
    else later(poll, pollMs);
  };

  proc.onData((d) => {
    if (!ended) term.write(d, look);
  });
  proc.onExit(() => {
    if (ended) return;
    // Droid may exit by itself once it's signed in; doctor has the last word.
    void o
      .signedIn()
      .catch(() => null)
      .then((yes) => (yes ? end({ ok: true }) : fail(pressed ? "Droid's sign-in stopped before it finished. Try again." : UNRECOGNIZED)));
  });
  tick = setInterval(look, 250);
  later(() => !pressed && fail(UNRECOGNIZED), recognizeMs);
  later(() => fail(TIMED_OUT), timeoutMs);
  return { cancel, done };
}

function kill(p: pty.IPty) {
  try {
    p.kill('SIGTERM');
  } catch {
    return;
  }
  const hard = setTimeout(() => {
    try {
      p.kill('SIGKILL');
    } catch {
      // already gone
    }
  }, 2000);
  hard.unref();
  p.onExit(() => clearTimeout(hard));
}

/** The whole screen and scrollback as text, wrapped lines joined back up. */
function screenText(term: InstanceType<typeof headless.Terminal>): string {
  const b = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < b.length; i++) {
    const line = b.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  return lines.join('\n');
}

/** "please visit https://auth.factory.ai/device and enter code QSMK-CDLX" */
export function fromScreen(text: string): { code: string; url: string } | null {
  const code = CODE.exec(text)?.[1];
  if (!code) return null;
  const visit = VISIT.exec(text)?.[1] ?? 'https://auth.factory.ai/device';
  const url = new URL(visit);
  if (!url.searchParams.has('user_code')) url.searchParams.set('user_code', code);
  return { code, url: url.href };
}

/** What Droid passed to `open`: https://auth.factory.ai/device?user_code=QSMK-CDLX */
function fromShim(file: string): { code: string; url: string } | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  for (const word of text.split(/\s+/)) {
    try {
      const url = new URL(word);
      const code = url.searchParams.get('user_code');
      if (url.protocol === 'https:' && code) return { code, url: url.href };
    } catch {
      // not a URL
    }
  }
  return null;
}

function writeShims(bin: string, opened: string) {
  mkdirSync(bin, { recursive: true });
  const shim = `#!/bin/sh\nprintf '%s\\n' "$*" >> '${opened.replace(/'/g, `'\\''`)}'\n`;
  for (const name of ['open', 'xdg-open']) writeFileSync(path.join(bin, name), shim, { mode: 0o755 });
}

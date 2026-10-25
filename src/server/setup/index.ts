import { execFile } from 'node:child_process';
import { constants, readFileSync } from 'node:fs';
import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ClientMsg } from '../../shared/protocol.js';
import { droidReady, emptySetupState, type SetupState } from '../../shared/setup.js';
import { childEnv, defaultShell } from '../workers.js';
import { canInstall, droidVersion, installDroid, latestDroid, type Runner, runCommand } from './droid-install.js';
import { type DoctorAuth, doctorAuth, type SignIn, startSignIn } from './droid-signin.js';

/** The setup.* messages a client sends (see protocol.ts). */
export type SetupMsg = Extract<ClientMsg, { t: 'setup.check' | 'setup.droid.install' | 'setup.droid.signIn' | 'setup.droid.signInCancel' | 'setup.onboarded' }>;

export interface SetupOptions {
  /** The office's .droid-office, where setup.json keeps whether the welcome is done. */
  dataDir: string;
  /** The agent command (--agent, DROID_OFFICE_AGENT): 'droid' unless the owner named another. */
  agentCmd: string;
  /** Setup changed: to everyone. */
  broadcast(state: SetupState): void;
  toast(text: string, level?: 'info' | 'warn' | 'error'): void;
  /** Droid was installed (or found somewhere new): every floor runs it from `path` from now on. */
  agentChanged(path: string): void;
  fetchImpl?: typeof fetch;
  /** Where ~/.local/bin/droid goes. */
  home?: string;
  platform?: string;
  arch?: string;
  run?: Runner;
  /** Where the agent command is now; defaults to PATH, the login shell's PATH, then ~/.local/bin/droid. */
  findAgent?: (cmd: string) => Promise<string | null>;
  env?: () => Record<string, string>;
  timing?: Partial<SetupTiming>;
}

export interface SetupTiming {
  /** How often to ask for the newest release. */
  latestMs: number;
  /** How often to check Droid is still there and signed in. */
  checkMs: number;
  signInPollMs: number;
  signInRecognizeMs: number;
  signInTimeoutMs: number;
}

const TIMING: SetupTiming = {
  latestMs: 6 * 3600_000,
  checkMs: 30 * 60_000,
  signInPollMs: 3000,
  signInRecognizeMs: 20_000,
  signInTimeoutMs: 15 * 60_000,
};

export interface Setup {
  state(): SetupState;
  /** Handles a setup.* message from `who`. */
  message(who: string, msg: SetupMsg): void;
  stop(): void;
}

/** setup.json: whether the owner has been through the welcome. Null when there's none (or it's unreadable). */
export function readSetupFile(dataDir: string): { onboarded: boolean; at?: number } | null {
  try {
    const v = JSON.parse(readFileSync(path.join(dataDir, 'setup.json'), 'utf8'));
    return typeof v?.onboarded === 'boolean' ? { onboarded: v.onboarded, at: typeof v.at === 'number' ? v.at : undefined } : null;
  } catch {
    return null;
  }
}

async function writeSetupFile(dataDir: string, onboarded: boolean): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, 'setup.json');
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ onboarded, at: Date.now() })}\n`);
  await rename(tmp, file);
}

/**
 * Where the agent command is, as resolveAgent (workers.ts) looks for it, without blocking the office
 * on the login shell.
 */
export function agentFinder(home: string, platform: string): (cmd: string) => Promise<string | null> {
  const executable = (file: string) =>
    access(file, constants.X_OK).then(
      () => file,
      () => null,
    );
  return async (cmd) => {
    if (cmd.includes('/')) return executable(path.resolve(cmd));
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      const found = dir && (await executable(path.join(dir, cmd)));
      if (found) return found;
    }
    if (platform === 'win32') return null;
    const shell = await new Promise<string | null>((resolve) => {
      execFile(defaultShell(), ['-l', '-i', '-c', `command -v '${cmd.replace(/'/g, `'\\''`)}'`], { encoding: 'utf8', timeout: 5000 }, (err, stdout) => {
        const last = err ? '' : stdout.trim().split('\n').pop();
        resolve(last?.startsWith('/') ? last : null);
      });
    });
    if (shell) return shell;
    return cmd === 'droid' ? executable(path.join(home, '.local', 'bin', 'droid')) : null;
  };
}

/**
 * Droid installed and signed in, and the welcome (docs/subscriptions.md). server.ts calls only this.
 */
export function mountSetup(opts: SetupOptions): Setup {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const home = opts.home ?? os.homedir();
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const run = opts.run ?? runCommand;
  const env = opts.env ?? childEnv;
  const timing = { ...TIMING, ...opts.timing };
  const find = opts.findAgent ?? agentFinder(home, platform);

  const file = readSetupFile(opts.dataDir);
  const state: SetupState = {
    ...emptySetupState(),
    onboarded: file?.onboarded ?? false,
    // An owner who named another agent command (--agent) runs that one: the office doesn't install a droid beside it.
    droid: { ...emptySetupState().droid, busy: 'checking', canInstall: opts.agentCmd === 'droid' && canInstall(platform, arch) },
  };
  let stopped = false;
  /** Whether a check has told ready from not yet: only the first decides an office without setup.json. */
  let decided = file !== null;
  /** Where the office put Droid itself; it wins over another droid on PATH from then on. */
  let installed: string | null = null;
  let checking: Promise<void> | null = null;
  let again = false;
  let signIn: SignIn | null = null;
  let install: AbortController | null = null;
  const timers: NodeJS.Timeout[] = [];

  const send = () => {
    if (!stopped) opts.broadcast(structuredClone(state));
  };

  const applyAuth = (auth: DoctorAuth) => {
    state.droid.signedIn = auth.signedIn;
    state.droid.account = auth.account;
  };

  /**
   * The first check that can tell decides an office without setup.json and writes it down: Droid
   * ready is an office that already worked, anything else a fresh one, whose welcome then survives
   * reloads and restarts until the owner finishes it.
   */
  const settleOnboarded = async () => {
    if (decided || (state.droid.path && state.droid.signedIn === null)) return;
    decided = true;
    state.onboarded = droidReady(state);
    await writeSetupFile(opts.dataDir, state.onboarded).catch(() => {});
  };

  const look = async (first: boolean) => {
    const found = (installed && (await find(installed))) || (await find(opts.agentCmd));
    if (found !== state.droid.path) {
      state.droid.path = found;
      if (found && !first) opts.agentChanged(found);
    }
    if (!found) {
      state.droid.version = null;
      state.droid.signedIn = null;
      state.droid.account = null;
    } else {
      const [version, auth] = await Promise.all([droidVersion(found, run, env()), doctorAuth(found, run, env())]);
      state.droid.version = version;
      if (state.droid.busy !== 'signing-in') applyAuth(auth);
    }
    await settleOnboarded();
  };

  /** Looks at Droid again; a call while one is running runs once more after it. */
  const check = (opts2: { busy?: boolean; first?: boolean } = {}): Promise<void> => {
    if (checking) {
      again = true;
      return checking;
    }
    if (opts2.busy && !state.droid.busy) {
      state.droid.busy = 'checking';
      send();
    }
    checking = (async () => {
      try {
        do {
          again = false;
          await look(!!opts2.first);
        } while (again && !stopped);
      } catch (err) {
        state.droid.error = `Couldn't check Droid: ${(err as Error).message}`;
      } finally {
        checking = null;
        if (state.droid.busy === 'checking') state.droid.busy = null;
        send();
      }
    })();
    return checking;
  };

  const lookLatest = async () => {
    const latest = await latestDroid(fetchImpl);
    if (latest && latest !== state.droid.latest) {
      state.droid.latest = latest;
      send();
    }
    return latest;
  };

  const doInstall = async () => {
    if (state.droid.busy === 'installing' || state.droid.busy === 'signing-in') return;
    if (!state.droid.canInstall) {
      state.droid.error =
        opts.agentCmd === 'droid'
          ? `Droid Office can't install Droid on ${platform} ${arch}. Install it yourself with: curl -fsSL https://app.factory.ai/cli | sh`
          : `The office runs ${opts.agentCmd} (--agent), so it doesn't install Droid itself.`;
      send();
      return;
    }
    state.droid.busy = 'installing';
    state.droid.progress = 0;
    state.droid.error = null;
    send();
    install = new AbortController();
    let shown = 0;
    try {
      const version = state.droid.latest ?? (await lookLatest());
      if (!version) throw new Error("Couldn't find out Droid's newest release. Check the connection and try again.");
      const file = await installDroid({
        version,
        home,
        platform,
        arch,
        fetchImpl,
        run,
        signal: install.signal,
        onProgress: (p) => {
          state.droid.progress = p;
          if (p - shown >= 0.02 || p === 1) {
            shown = p;
            send();
          }
        },
      });
      if (stopped) return;
      installed = file;
      state.droid.path = file;
      state.droid.version = (await droidVersion(file, run, env())) ?? version;
      opts.agentChanged(file);
      opts.toast(`Droid ${state.droid.version} installed.`);
      applyAuth(await doctorAuth(file, run, env()));
      await settleOnboarded();
      if (checking) void check();
    } catch (err) {
      state.droid.error = (err as Error).message;
      opts.toast(state.droid.error, 'error');
    } finally {
      install = null;
      if (state.droid.busy === 'installing') state.droid.busy = null;
      delete state.droid.progress;
      send();
    }
  };

  const doSignIn = async () => {
    if (state.droid.busy === 'installing' || signIn) return;
    const droid = state.droid.path;
    if (!droid) {
      state.droid.error = 'Install Droid first.';
      send();
      return;
    }
    state.droid.error = null;
    state.droid.busy = 'signing-in';
    state.droid.signIn = { code: null, url: null, since: Date.now() };
    send();
    const auth = await doctorAuth(droid, run, env());
    if (stopped) return;
    if (auth.signedIn) {
      applyAuth(auth);
      state.droid.busy = null;
      delete state.droid.signIn;
      await settleOnboarded();
      send();
      return;
    }
    let last = auth;
    const s = startSignIn({
      droid,
      env: env(),
      pollMs: timing.signInPollMs,
      recognizeMs: timing.signInRecognizeMs,
      timeoutMs: timing.signInTimeoutMs,
      signedIn: async () => {
        last = await doctorAuth(droid, run, env());
        return last.signedIn;
      },
      onCode: (code, url) => {
        state.droid.signIn = { code, url, since: state.droid.signIn?.since ?? Date.now() };
        send();
      },
    });
    signIn = s;
    const result = await s.done;
    signIn = null;
    if (stopped) return;
    state.droid.busy = null;
    delete state.droid.signIn;
    if (result.ok) {
      applyAuth(last);
      opts.toast(last.account ? `Droid is signed in as ${last.account}.` : 'Droid is signed in.');
      await settleOnboarded();
    } else if (!result.cancelled) {
      state.droid.error = result.error;
      opts.toast(result.error, 'error');
    }
    send();
  };

  void check({ first: true });
  void lookLatest();
  timers.push(setInterval(() => void lookLatest(), timing.latestMs));
  timers.push(setInterval(() => void check(), timing.checkMs));
  for (const t of timers) t.unref();

  return {
    state: () => state,
    message: (_who, msg) => {
      switch (msg.t) {
        case 'setup.check':
          state.droid.error = null;
          void check({ busy: true });
          void lookLatest();
          break;
        case 'setup.droid.install':
          void doInstall();
          break;
        case 'setup.droid.signIn':
          void doSignIn();
          break;
        case 'setup.droid.signInCancel':
          signIn?.cancel();
          break;
        case 'setup.onboarded':
          state.onboarded = msg.done;
          decided = true;
          send();
          void writeSetupFile(opts.dataDir, msg.done).catch((err) => opts.toast(`Couldn't save setup.json: ${(err as Error).message}`, 'error'));
          break;
      }
    },
    stop: () => {
      stopped = true;
      for (const t of timers) clearInterval(t);
      signIn?.cancel();
      install?.abort();
    },
  };
}

import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HotReloadState } from '../shared/hot-reload.js';

/** Resolve the running office's install, never the project droids happen to be editing. */
export function sourceAppDir(url = import.meta.url): string | undefined {
  let dir = path.dirname(fileURLToPath(url));
  for (let i = 0; i < 6; i++, dir = path.dirname(dir)) {
    try {
      if (JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).name === 'droid-office') return dir;
    } catch {
      // Continue up from either src/server or dist/server/server.
    }
  }
  return undefined;
}

function run(file: string, args: string[], cwd: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd, signal, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (err, out, errOut) => {
      if (err) reject(new Error(`${out}\n${errOut}`.trim().slice(-8000) || err.message));
      else resolve();
    });
  });
}

/** Child processes isolate compiler/config failures from the running office and its PTYs. */
export async function buildClient(appDir: string, output: string, signal: AbortSignal): Promise<void> {
  await run(process.execPath, [path.join(appDir, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.client.json', '--noEmit'], appDir, signal);
  await run(process.execPath, [path.join(appDir, 'node_modules/vite/bin/vite.js'), 'build', '--config', path.join(appDir, 'vite.config.ts'), '--outDir', output, '--emptyOutDir'], appDir, signal);
}

interface SourceStamp {
  client: string;
  server: string;
}

const BUILD_INPUTS = ['vite.config.ts', 'package.json', 'package-lock.json', 'tsconfig.base.json', 'tsconfig.client.json'];

async function sourceStamp(appDir: string): Promise<SourceStamp> {
  const tree = async (relative: string): Promise<string[]> => {
    const dir = path.join(appDir, relative);
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [`${relative}:missing`];
      throw err;
    }
    const files = await Promise.all(
      entries
        .filter((e) => !['node_modules', '.git', 'dist'].includes(e.name))
        .map(async (e) => {
          const name = path.join(relative, e.name);
          if (e.isDirectory()) return tree(name);
          const s = await stat(path.join(appDir, name), { bigint: true });
          return [`${name}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`];
        }),
    );
    return files.flat();
  };
  const file = async (relative: string) => {
    try {
      const s = await stat(path.join(appDir, relative), { bigint: true });
      return `${relative}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return `${relative}:missing`;
      throw err;
    }
  };
  const [client, shared, server, inputs, serverConfig] = await Promise.all([tree('src/client'), tree('src/shared'), tree('src/server'), Promise.all(BUILD_INPUTS.map(file)), file('tsconfig.server.json')]);
  const digest = (parts: string[]) => createHash('sha256').update(parts.sort().join('\n')).digest('hex');
  return { client: digest([...client, ...shared, ...inputs]), server: digest([...server, ...shared, serverConfig, ...inputs.filter((s) => !s.startsWith('vite.config.ts:') && !s.startsWith('tsconfig.client.json:'))]) };
}

interface ReloadOptions {
  appDir?: string;
  dataDir: string;
  publicDir: string;
  pollMs?: number;
  settleMs?: number;
  build?: (output: string, signal: AbortSignal) => Promise<void>;
}

/** Publish only complete, current builds; keep previous assets for clients still using them. */
export class HotReload {
  private current: HotReloadState;
  private originalDir: string;
  private published: string[] = [];
  private stage?: string;
  private settingsFile: string;
  private timer?: NodeJS.Timeout;
  private baseline?: SourceStamp;
  private seen?: SourceStamp;
  private pending = false;
  private due = 0;
  private scanning = false;
  private stopped = false;
  private building?: Promise<void>;
  private abort?: AbortController;
  private epoch = 0;
  private saving: Promise<string | undefined> = Promise.resolve(undefined);
  private builder: (output: string, signal: AbortSignal) => Promise<void>;

  constructor(private options: ReloadOptions) {
    this.originalDir = options.publicDir;
    this.settingsFile = path.join(options.dataDir, 'hot-reload.json');
    const app = options.appDir;
    const source = app && existsSync(path.join(app, 'src/client/index.html')) && existsSync(path.join(app, 'vite.config.ts'));
    const tools = app && ['node_modules/vite/bin/vite.js', 'node_modules/typescript/bin/tsc'].every((p) => existsSync(path.join(app, p)));
    const available = !!source && (!!options.build || !!tools);
    let enabled = false;
    try {
      enabled = JSON.parse(readFileSync(this.settingsFile, 'utf8')).enabled === true;
    } catch {
      // Off by default, including a damaged settings file.
    }
    this.current = {
      available,
      reason: available
        ? undefined
        : source
          ? 'Source hot reload needs the office’s development dependencies (npm ci in its checkout).'
          : 'Source hot reload needs a source checkout of the running office; packaged releases do not contain source.',
      enabled: available && enabled,
      phase: 'idle',
      revision: randomBytes(12).toString('hex'),
      restartRequired: false,
    };
    this.builder = options.build ?? ((output, signal) => buildClient(app!, output, signal));
  }

  get publicDir(): string {
    return this.published.at(-1) ?? this.originalDir;
  }

  state(): HotReloadState {
    return { ...this.current };
  }

  async start(): Promise<void> {
    if (!this.current.available || this.stopped || this.timer) return;
    try {
      this.baseline = this.seen = await sourceStamp(this.options.appDir!);
    } catch (err) {
      this.fail(err);
    }
    this.timer = setInterval(() => void this.check(), this.options.pollMs ?? 1000);
    this.timer.unref();
    if (this.current.enabled) this.requestBuild();
  }

  setEnabled(enabled: boolean): Promise<string | undefined> {
    this.saving = this.saving.then(() => this.saveEnabled(enabled));
    return this.saving;
  }

  private async saveEnabled(enabled: boolean): Promise<string | undefined> {
    if (enabled && !this.current.available) return this.current.reason;
    if (this.stopped) return 'The office is shutting down';
    if (this.current.enabled === enabled) return;
    const tmp = `${this.settingsFile}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await mkdir(this.options.dataDir, { recursive: true });
      await writeFile(tmp, JSON.stringify({ enabled }), { mode: 0o600 });
      await rename(tmp, this.settingsFile);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      return `Could not save source hot reload: ${(err as Error).message}`;
    }
    if (this.stopped) return 'The office is shutting down';
    this.current.enabled = enabled;
    this.epoch++;
    this.abort?.abort();
    this.pending = false;
    this.current.phase = 'idle';
    this.current.error = undefined;
    if (enabled) this.requestBuild();
  }

  rebuild(): string | undefined {
    if (!this.current.enabled) return 'Enable source hot reload first';
    if (this.stopped) return 'The office is shutting down';
    this.requestBuild();
  }

  private requestBuild() {
    this.pending = true;
    this.due = Date.now();
    void this.check();
  }

  private fail(err: unknown) {
    this.current.phase = 'error';
    this.current.error = String((err as Error).message ?? err).slice(-8000);
  }

  private async check(): Promise<void> {
    if (this.scanning || this.stopped || !this.current.enabled) return;
    this.scanning = true;
    try {
      const stamp = await sourceStamp(this.options.appDir!);
      if (this.stopped || !this.current.enabled) return;
      this.current.restartRequired = !!this.baseline && stamp.server !== this.baseline.server;
      if (stamp.client !== this.seen?.client) {
        this.pending = true;
        this.due = Date.now() + (this.options.settleMs ?? 600);
      }
      this.seen = stamp;
      if (this.pending && !this.building && Date.now() >= this.due) {
        this.pending = false;
        this.building = this.compile(stamp, this.epoch).finally(() => {
          this.building = undefined;
        });
      }
    } catch (err) {
      this.fail(err);
    } finally {
      this.scanning = false;
    }
  }

  private async compile(stamp: SourceStamp, epoch: number): Promise<void> {
    const abort = new AbortController();
    this.abort = abort;
    this.current.phase = 'building';
    this.current.error = undefined;
    let output: string | undefined;
    try {
      if (!this.stage) {
        await mkdir(this.options.dataDir, { recursive: true });
        this.stage = await mkdtemp(path.join(this.options.dataDir, 'hot-reload-'));
      }
      output = await mkdtemp(path.join(this.stage, 'build-'));
      await this.builder(output, abort.signal);
      if (!existsSync(path.join(output, 'index.html'))) throw new Error('The client build did not produce index.html');
      const now = await sourceStamp(this.options.appDir!);
      if (this.stopped || epoch !== this.epoch || !this.current.enabled) return;
      this.current.restartRequired = !!this.baseline && now.server !== this.baseline.server;
      if (now.client !== stamp.client) {
        this.seen = now;
        this.pending = true;
        this.due = Date.now() + (this.options.settleMs ?? 600);
        this.current.phase = 'idle';
        return;
      }
      this.published.push(output);
      output = undefined;
      this.current.revision = randomBytes(12).toString('hex');
      this.current.lastBuiltAt = Date.now();
      this.current.phase = 'idle';
    } catch (err) {
      if (!this.stopped && epoch === this.epoch) this.fail(err);
    } finally {
      if (output) await rm(output, { recursive: true, force: true }).catch(() => {});
      if (this.abort === abort) this.abort = undefined;
    }
  }

  /** Older hashed chunks remain reachable; unhashed props come only from the current build. */
  file(urlPath: string): string | undefined {
    const dirs = urlPath.startsWith('/assets/') ? [...this.published].reverse().concat(this.originalDir) : [this.publicDir];
    for (const dir of dirs) {
      const file = path.resolve(dir, `.${urlPath}`);
      if (file.startsWith(dir + path.sep) && existsSync(file) && statSync(file).isFile()) return file;
    }
    return undefined;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.epoch++;
    clearInterval(this.timer);
    this.abort?.abort();
    await this.building;
    if (this.stage) await rm(this.stage, { recursive: true, force: true });
  }
}

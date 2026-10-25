import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

/** Factory's Developer ID team, which signs every macOS droid it publishes. */
export const FACTORY_TEAM = 'SW6TL4V6Q5';
export const DOWNLOADS = 'https://downloads.factory.ai/factory-cli';
const MAX_REDIRECTS = 5;

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command to the end without a shell; never rejects (a command that couldn't start is code -1). */
export type Runner = (cmd: string, args: string[], opts?: { timeout?: number; env?: Record<string, string> }) => Promise<RunResult>;

export const runCommand: Runner = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: opts.timeout ?? 30_000, maxBuffer: 16 * 1024 * 1024, env: opts.env }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : -1) : 0;
      resolve({ code, stdout: stdout ?? '', stderr: stderr ?? (err ? err.message : '') });
    });
  });

/** The office can install Droid by itself here: the platforms and architectures Factory publishes. */
export function canInstall(platform: string, arch: string): boolean {
  return (platform === 'darwin' || platform === 'linux') && (arch === 'arm64' || arch === 'x64');
}

/**
 * The build to download, as Factory's own installer (https://app.factory.ai/cli) picks it: x64
 * without AVX2 gets the baseline build.
 */
export async function droidTarget(o: { platform: string; arch: string; run: Runner; cpuinfo?: () => Promise<string> }): Promise<{ os: string; arch: string }> {
  if (!canInstall(o.platform, o.arch)) throw new Error(`Droid Office can't install Droid on ${o.platform} ${o.arch}.`);
  if (o.arch === 'arm64') return { os: o.platform, arch: 'arm64' };
  let avx2 = false;
  if (o.platform === 'linux') {
    const info = await (o.cpuinfo ?? (() => readFile('/proc/cpuinfo', 'utf8')))().catch(() => '');
    avx2 = /avx2/i.test(info);
  } else {
    const r = await o.run('sysctl', ['-a'], { timeout: 10_000 });
    avx2 = /machdep\.cpu.*AVX2/.test(r.stdout);
  }
  return { os: o.platform, arch: avx2 ? 'x64' : 'x64-baseline' };
}

export function droidUrl(version: string, target: { os: string; arch: string }): string {
  return `${DOWNLOADS}/releases/${version}/${target.os}/${target.arch}/droid`;
}

/** A version as Factory writes them (0.249.0), or null for anything else. */
export function cleanVersion(text: string): string | null {
  return /\b(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\b/.exec(text.trim())?.[1] ?? null;
}

/** The newest Droid release (https://downloads.factory.ai/factory-cli/LATEST), or null when it can't tell. */
export async function latestDroid(fetchImpl: typeof fetch, signal?: AbortSignal): Promise<string | null> {
  try {
    const res = await httpsGet(`${DOWNLOADS}/LATEST`, fetchImpl, signal ?? AbortSignal.timeout(15_000));
    if (!res.ok) return null;
    return cleanVersion(await res.text());
  } catch {
    return null;
  }
}

/** `droid --version`: its version, or null when it doesn't run. */
export async function droidVersion(file: string, run: Runner, env?: Record<string, string>): Promise<string | null> {
  const r = await run(file, ['--version'], { timeout: 20_000, env });
  return r.code === 0 ? cleanVersion(r.stdout) : null;
}

/** GET that follows redirects itself, so none of them can leave https. */
export async function httpsGet(url: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<Response> {
  let at = url;
  for (let hop = 0; ; hop++) {
    if (new URL(at).protocol !== 'https:') throw new Error(`refused a download over ${new URL(at).protocol.replace(':', '')} (${at})`);
    const res = await fetchImpl(at, { redirect: 'manual', signal });
    if (res.status < 300 || res.status >= 400) return res;
    const next = res.headers.get('location');
    if (!next) return res;
    if (hop >= MAX_REDIRECTS) throw new Error('too many redirects');
    at = new URL(next, at).href;
  }
}

export interface InstallOptions {
  version: string;
  /** The home folder Droid goes into, as ~/.local/bin/droid. */
  home: string;
  platform: string;
  arch: string;
  fetchImpl: typeof fetch;
  run: Runner;
  cpuinfo?: () => Promise<string>;
  /** 0..1 as the binary downloads. */
  onProgress?(fraction: number): void;
  signal?: AbortSignal;
}

/** An install that failed one of its checks, named in words for the owner. */
export class InstallError extends Error {}

/**
 * Installs Droid `version` into ~/.local/bin/droid as Factory's installer does, with more checks: the
 * published SHA-256 and, on macOS, Factory's signature. It's written through a temp file in the same
 * folder and a rename, so a droid that's running keeps the binary it started with. Returns its path.
 */
export async function installDroid(o: InstallOptions): Promise<string> {
  const target = await droidTarget(o);
  const url = droidUrl(o.version, target);
  const dir = path.join(o.home, '.local', 'bin');
  const dest = path.join(dir, 'droid');
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.droid-${randomBytes(6).toString('hex')}.download`);
  try {
    const shaRes = await httpsGet(`${url}.sha256`, o.fetchImpl, o.signal);
    if (!shaRes.ok) throw new InstallError(`Couldn't get Droid ${o.version}'s checksum (HTTP ${shaRes.status}).`);
    const expected = /\b[0-9a-f]{64}\b/i.exec(await shaRes.text())?.[0]?.toLowerCase();
    if (!expected) throw new InstallError(`Droid ${o.version}'s checksum file has no SHA-256 in it.`);

    const res = await httpsGet(url, o.fetchImpl, o.signal);
    if (!res.ok || !res.body) throw new InstallError(`Couldn't download Droid ${o.version} (HTTP ${res.status}).`);
    const total = Number(res.headers.get('content-length')) || 0;
    const hash = createHash('sha256');
    const fh = await open(tmp, 'w', 0o600);
    let got = 0;
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        hash.update(chunk);
        await fh.write(chunk);
        got += chunk.byteLength;
        if (total) o.onProgress?.(Math.min(1, got / total));
      }
    } finally {
      await fh.close();
    }
    if (total && got !== total) throw new InstallError(`Droid's download stopped short (${got} of ${total} bytes).`);
    if (hash.digest('hex') !== expected) throw new InstallError('Droid failed its SHA-256 check: the download is not the file Factory published.');
    o.onProgress?.(1);

    if (o.platform === 'darwin') {
      const verify = await o.run('codesign', ['--verify', '--strict', tmp], { timeout: 60_000 });
      if (verify.code !== 0) throw new InstallError(`Droid failed its code signature check (codesign --verify): ${lastLine(verify.stderr) || 'not signed'}.`);
      const info = await o.run('codesign', ['-dv', tmp], { timeout: 60_000 });
      const team = /^TeamIdentifier=(\S+)/m.exec(`${info.stdout}\n${info.stderr}`)?.[1];
      if (team !== FACTORY_TEAM) throw new InstallError(`Droid failed its signature check: it's signed by team ${team ?? 'none'}, not Factory (${FACTORY_TEAM}).`);
    }
    await chmod(tmp, 0o755);
    await rename(tmp, dest);
    return dest;
  } catch (err) {
    await rm(tmp, { force: true });
    if (err instanceof InstallError) throw err;
    if ((err as Error).name === 'AbortError') throw new InstallError('The Droid install was stopped.');
    throw new InstallError(`Couldn't install Droid: ${(err as Error).message}`);
  }
}

function lastLine(s: string): string {
  return s.trim().split('\n').filter(Boolean).pop()?.trim() ?? '';
}

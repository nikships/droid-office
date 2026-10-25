import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { access, mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** DroidProxy's release on GitHub, and how the office checks and installs it (docs/subscriptions.md). */

export const DROIDPROXY_REPO = 'nikships/droidproxy';
export const DROIDPROXY_BUNDLE_ID = 'com.droidproxy.app';
/** DroidProxy's Developer ID team. */
export const DROIDPROXY_TEAM = 'NW6B3R27LQ';
export const APP_NAME = 'DroidProxy.app';
const ZIP = 'DroidProxy-arm64.zip';
const LATEST = `https://api.github.com/repos/${DROIDPROXY_REPO}/releases/latest`;
const DOWNLOAD_PREFIX = `https://github.com/${DROIDPROXY_REPO}/releases/download/`;
/** Where GitHub sends a release download. Anything else, or plain http, is refused. */
const DOWNLOAD_HOSTS = new Set(['github.com', 'api.github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command (open, codesign, ditto, osascript, spctl, plutil) without a shell. */
export type Runner = (cmd: string, args: string[], opts?: { timeoutMs?: number }) => Promise<RunResult>;

export const runCommand: Runner = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: opts.timeoutMs ?? 60_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code as number) : 1) : 0;
      resolve({ code, stdout: stdout ?? '', stderr: stderr ?? (err ? String(err.message) : '') });
    });
  });

export interface Release {
  version: string;
  zip: string;
  sha256: string;
}

/** Where DroidProxy goes: /Applications when the office can write there, else ~/Applications. */
export interface AppDirs {
  system: string;
  user: string;
}

export class InstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstallError';
  }
}

/** The newest DroidProxy release and its two assets. */
export async function latestRelease(fetchImpl: typeof fetch = fetch): Promise<Release> {
  let res: Response;
  try {
    res = await fetchImpl(LATEST, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'droid-office' }, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new InstallError(`Couldn't reach GitHub for DroidProxy's newest release (${(err as Error)?.message ?? err})`);
  }
  if (!res.ok) throw new InstallError(`GitHub answered ${res.status} for DroidProxy's newest release`);
  const json = (await res.json().catch(() => ({}))) as { tag_name?: unknown; assets?: { name?: unknown; browser_download_url?: unknown }[] };
  const tag = typeof json.tag_name === 'string' ? json.tag_name : '';
  const version = tag.replace(/^v/i, '');
  if (!/^\d+(\.\d+)*$/.test(version)) throw new InstallError("GitHub's newest DroidProxy release has no version the office understands");
  const asset = (name: string) => {
    const url = json.assets?.find((a) => a?.name === name)?.browser_download_url;
    if (typeof url !== 'string' || !url.startsWith(DOWNLOAD_PREFIX)) throw new InstallError(`DroidProxy ${version} has no ${name} on GitHub`);
    return url;
  };
  return { version, zip: asset(ZIP), sha256: asset(`${ZIP}.sha256`) };
}

/** Fetches `url`, following GitHub's redirects only over HTTPS and only to GitHub's hosts. */
async function download(fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<Response> {
  let at = url;
  for (let hop = 0; hop < 5; hop++) {
    const u = new URL(at);
    if (u.protocol !== 'https:' || !DOWNLOAD_HOSTS.has(u.hostname)) throw new InstallError(`Refused to download DroidProxy from ${u.protocol}//${u.hostname}`);
    let res: Response;
    try {
      res = await fetchImpl(at, { redirect: 'manual', headers: { 'user-agent': 'droid-office' }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new InstallError(`Couldn't download DroidProxy (${(err as Error)?.message ?? err})`);
    }
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location');
      if (!next) throw new InstallError(`GitHub answered ${res.status} with nowhere to go`);
      at = new URL(next, at).href;
      continue;
    }
    if (!res.ok || !res.body) throw new InstallError(`GitHub answered ${res.status} for ${path.basename(new URL(url).pathname)}`);
    return res;
  }
  throw new InstallError('GitHub redirected the download too many times');
}

/** The SHA-256 the release publishes: the first word of its .sha256 file. */
export function parseSha(text: string): string | undefined {
  const word = text.trim().split(/\s+/)[0]?.toLowerCase();
  return word && /^[0-9a-f]{64}$/.test(word) ? word : undefined;
}

/** A bundle's id and version, from its Info.plist (plutil reads both the XML and binary forms). */
export async function readBundle(run: Runner, app: string): Promise<{ id: string; version: string | null } | undefined> {
  const plist = path.join(app, 'Contents', 'Info.plist');
  try {
    await access(plist);
  } catch {
    return undefined;
  }
  const r = await run('plutil', ['-convert', 'json', '-o', '-', plist], { timeoutMs: 10_000 });
  if (r.code !== 0) return undefined;
  try {
    const j = JSON.parse(r.stdout) as Record<string, unknown>;
    if (typeof j.CFBundleIdentifier !== 'string') return undefined;
    return { id: j.CFBundleIdentifier, version: typeof j.CFBundleShortVersionString === 'string' ? j.CFBundleShortVersionString : null };
  } catch {
    return undefined;
  }
}

/** Why the app at `app` isn't DroidProxy as its team signed and Apple notarized it; undefined when it is. */
export async function verifyApp(run: Runner, app: string): Promise<string | undefined> {
  const bundle = await readBundle(run, app);
  if (bundle?.id !== DROIDPROXY_BUNDLE_ID) return `The download isn't DroidProxy (its bundle id is ${bundle?.id ?? 'missing'})`;
  const sig = await run('codesign', ['--verify', '--deep', '--strict', app], { timeoutMs: 120_000 });
  if (sig.code !== 0) return "The download's code signature doesn't verify (codesign --verify --deep --strict)";
  const who = await run('codesign', ['-dv', app], { timeoutMs: 30_000 });
  const team = /^TeamIdentifier=(\S+)/m.exec(`${who.stderr}\n${who.stdout}`)?.[1];
  if (team !== DROIDPROXY_TEAM) return `The download is signed by team ${team ?? 'unknown'}, not DroidProxy's (${DROIDPROXY_TEAM})`;
  const gate = await run('spctl', ['-a', '-t', 'exec', '-vv', app], { timeoutMs: 60_000 });
  if (gate.code !== 0 || !/source=Notarized Developer ID/.test(`${gate.stderr}\n${gate.stdout}`)) return "The download isn't notarized by Apple (spctl -a -t exec)";
  return undefined;
}

async function writable(dir: string): Promise<boolean> {
  try {
    await access(dir, constants.W_OK);
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** Where to put DroidProxy: where it already is when the office can write there, else /Applications, else ~/Applications. */
export async function targetDir(dirs: AppDirs, current: string | null): Promise<string> {
  const here = current ? path.dirname(current) : undefined;
  if (here && (await writable(here))) return here;
  if (await writable(dirs.system)) return dirs.system;
  await mkdir(dirs.user, { recursive: true });
  return dirs.user;
}

export interface InstallOptions {
  fetchImpl?: typeof fetch;
  run?: Runner;
  dirs: AppDirs;
  /** The installed DroidProxy, to replace; null for a first install. */
  current: string | null;
  /** The release to install; the newest one when left out. */
  release?: Release;
  /** Where the download is unpacked and checked. */
  tmp?: string;
  /** 0..1 while downloading. */
  progress?(p: number): void;
}

/**
 * Downloads the newest DroidProxy, checks it (SHA-256, signature, team, notarization), quits the
 * running one and puts the new one where the old one was. Starting it is up to the caller. Every
 * failed check deletes the download and says which check failed.
 */
export async function installProxy(opts: InstallOptions): Promise<{ path: string; version: string }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const run = opts.run ?? runCommand;
  const release = opts.release ?? (await latestRelease(fetchImpl));
  const work = await mkdtemp(path.join(opts.tmp ?? tmpdir(), 'droidproxy-'));
  try {
    const shaText = await (await download(fetchImpl, release.sha256, 30_000)).text();
    const want = parseSha(shaText);
    if (!want) throw new InstallError(`DroidProxy ${release.version}'s published SHA-256 can't be read`);

    const zip = path.join(work, ZIP);
    const res = await download(fetchImpl, release.zip, 10 * 60_000);
    const total = Number(res.headers.get('content-length')) || 0;
    const hash = createHash('sha256');
    let got = 0;
    let shown = -1;
    const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>);
    const tally = async function* (src: AsyncIterable<Buffer>) {
      for await (const chunk of src) {
        hash.update(chunk);
        got += chunk.length;
        const step = total ? Math.floor(Math.min(1, got / total) * 50) : -1;
        if (step !== shown && total) {
          shown = step;
          opts.progress?.(step / 50);
        }
        yield chunk;
      }
    };
    try {
      await pipeline(body, tally, createWriteStream(zip));
    } catch (err) {
      throw new InstallError(`The DroidProxy download broke off (${(err as Error)?.message ?? err})`);
    }
    if (hash.digest('hex') !== want) throw new InstallError(`The DroidProxy download doesn't match its published SHA-256: the office deleted it`);

    const unpacked = path.join(work, 'app');
    const ditto = await run('ditto', ['-x', '-k', zip, unpacked], { timeoutMs: 120_000 });
    if (ditto.code !== 0) throw new InstallError(`The DroidProxy download wouldn't unpack (ditto: ${ditto.stderr.trim().slice(0, 200) || ditto.code})`);
    const staged = path.join(unpacked, APP_NAME);
    const bad = await verifyApp(run, staged);
    if (bad) throw new InstallError(`${bad}: the office deleted it`);

    const dir = await targetDir(opts.dirs, opts.current);
    const dest = path.join(dir, APP_NAME);
    // Copied next to its final place first, so the swap is a rename on the same volume.
    const next = path.join(dir, `.${APP_NAME}.new-${process.pid}-${Date.now()}`);
    const copy = await run('ditto', [staged, next], { timeoutMs: 120_000 });
    if (copy.code !== 0) {
      await rm(next, { recursive: true, force: true });
      throw new InstallError(`Couldn't copy DroidProxy into ${dir} (ditto: ${copy.stderr.trim().slice(0, 200) || copy.code})`);
    }
    await run('osascript', ['-e', `quit app id "${DROIDPROXY_BUNDLE_ID}"`], { timeoutMs: 20_000 });
    const old = path.join(dir, `.${APP_NAME}.old-${process.pid}-${Date.now()}`);
    let moved = false;
    try {
      try {
        await rename(dest, old);
        moved = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      await rename(next, dest);
    } catch (err) {
      if (moved) await rename(old, dest).catch(() => {});
      await rm(next, { recursive: true, force: true });
      throw new InstallError(`Couldn't put DroidProxy in ${dir} (${(err as Error)?.message ?? err})`);
    }
    await rm(old, { recursive: true, force: true });
    return { path: dest, version: release.version };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

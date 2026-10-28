import { execFile } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { MAX_FLOORS } from '../shared/floors.js';
import { isValidDroidModel } from './agents.js';
import type { Building, FloorDef } from './building.js';

const execute = promisify(execFile);
const BODY_MAX = 512 * 1024;
const PATHS_MAX = 100;
const GROUPS_MAX = 5;

export interface FinderGroup {
  floorId: string;
  floorName: string;
  repoRoot: string | null;
  paths: string[];
  relativePaths: string[];
  isNewFloor: boolean;
  model?: string;
}

interface Dispatch {
  floorId: string;
  leadId: string;
  threadUrl: string;
  deepLink: string;
}

interface Receipt {
  dispatches: Dispatch[];
  errors: { floorId: string; error: string }[];
}

export class FinderError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

function within(file: string, dir: string): boolean {
  const relative = path.relative(dir, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Apply after resolving aliases too: a symlink must not bypass the native presenter's exclusions. */
export function finderPathAllowed(file: string, home = os.homedir()): boolean {
  if (!path.isAbsolute(file) || file === path.parse(file).root || /[\u0000-\u001f\u007f]/u.test(file)) return false;
  if (
    ['/System', '/Library', '/Network', '/net', '/dev', '/bin', '/sbin', '/usr', '/etc', '/private/etc', '/private/var/root', '/private/var/db', '/private/var/run', '/Volumes/Time Machine', path.join(home, 'Library')].some((dir) =>
      within(file, dir),
    )
  )
    return false;
  return !file.split(path.sep).some((part) => ['.Trash', '.Trashes', '.timemachine', '.MobileBackups', 'Backups.backupdb', '.droid-office'].includes(part) || part.startsWith('com.apple.TimeMachine.'));
}

/** Finder supplies paths, never a git command or a floor id chosen by an untrusted client. */
export async function finderTargets(raw: unknown, home = os.homedir()): Promise<{ repoRoot: string | null; paths: string[] }[]> {
  if (!Array.isArray(raw) || !raw.length || raw.length > PATHS_MAX) throw new FinderError(`Select between 1 and ${PATHS_MAX} files or folders.`);
  const groups = new Map<string | null, string[]>();
  for (const value of raw) {
    if (typeof value !== 'string' || value.length > 4096 || !finderPathAllowed(value, home)) throw new FinderError('That selection is not eligible for Finder dispatch.');
    let target: string;
    let directory: string;
    try {
      target = await realpath(value);
      const info = await stat(target);
      if (!info.isFile() && !info.isDirectory()) throw new Error('Not a regular file or directory');
      directory = info.isDirectory() ? target : path.dirname(target);
    } catch {
      throw new FinderError('A selected file or folder is unavailable. Select it again in Finder.');
    }
    if (!finderPathAllowed(target, home)) throw new FinderError('That selection is not eligible for Finder dispatch.');
    let repoRoot: string | null = null;
    for (let dir = directory; ; dir = path.dirname(dir)) {
      const git = await stat(path.join(dir, '.git')).catch(() => undefined);
      if (git?.isFile() || git?.isDirectory()) {
        repoRoot = dir;
        break;
      }
      if (path.dirname(dir) === dir) break;
    }
    const paths = groups.get(repoRoot) ?? [];
    if (!paths.includes(target)) paths.push(target);
    groups.set(repoRoot, paths);
    if (groups.size > GROUPS_MAX) throw new FinderError(`Select items from at most ${GROUPS_MAX} repositories or Home.`);
  }
  return [...groups].map(([repoRoot, paths]) => ({ repoRoot, paths }));
}

export interface FinderOptions {
  building: Building;
  dataDir: string;
  officeUrl: () => string;
  models: () => Promise<{ models: { id: string; label: string }[]; defaultModel?: string }>;
  dispatch: (floor: FloorDef, text: string, model?: string) => { leadId: string; model?: string } | string;
  changed: () => void;
}

/** Uses the building's single persistent registry; no Finder-only floors or orchestration brief. */
export class FinderDispatch {
  private remembered: Record<string, string> = {};
  private receipts = new Map<string, { fingerprint: string; result: Promise<Receipt> }>();
  private file: string;
  private stopped = false;

  constructor(private options: FinderOptions) {
    this.file = path.join(options.dataDir, 'finder.json');
    try {
      const saved: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        for (const [id, model] of Object.entries(saved)) if (isValidDroidModel(model)) this.remembered[id] = model;
      }
    } catch {
      // No Finder model choices have been saved yet.
    }
  }

  async resolve(paths: unknown): Promise<FinderGroup[]> {
    const targets = await finderTargets(paths);
    if (this.stopped) throw new FinderError('The office is shutting down. Nothing was dispatched.', 503);
    const { building } = this.options;
    const existing = building.list();
    const key = (dir: string) => {
      try {
        return realpathSync(dir);
      } catch {
        return dir;
      }
    };
    const byCheckout = new Map(existing.map((def) => [key(def.dir), def]));
    const unknown = targets.filter((g) => g.repoRoot && !byCheckout.has(g.repoRoot));
    if (existing.length + unknown.length > MAX_FLOORS) throw new FinderError('The building is full. Remove a floor in Settings first.', 409);
    try {
      return targets.map((target) => {
        const known = target.repoRoot ? byCheckout.get(target.repoRoot) : existing.find((d) => building.isHome(d.id));
        const def = known ?? (target.repoRoot ? building.finderFloor(target.repoRoot) : undefined);
        if (!def || typeof def === 'string') throw new FinderError(typeof def === 'string' ? def : 'The Home floor is unavailable.', 409);
        return {
          floorId: def.id,
          floorName: def.name,
          repoRoot: target.repoRoot,
          paths: target.paths,
          relativePaths: target.paths.map((p) => (target.repoRoot ? path.relative(target.repoRoot, p) || '.' : p)),
          isNewFloor: !known,
          ...(this.remembered[def.id] ? { model: this.remembered[def.id] } : {}),
        };
      });
    } finally {
      // Earlier groups may already be persisted when a later registration fails.
      this.options.changed();
    }
  }

  dispatch(raw: unknown): Promise<Receipt> {
    if (this.stopped) throw new FinderError('The office is shutting down. Nothing was dispatched.', 503);
    if (!raw || typeof raw !== 'object') throw new FinderError('Send a Finder dispatch request.');
    const body = raw as Record<string, unknown>;
    if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 16000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(body.prompt))
      throw new FinderError('Enter a task of 1 to 16,000 characters without terminal control characters.');
    if (body.model !== undefined && body.model !== 'floor-default' && !isValidDroidModel(body.model)) throw new FinderError('Choose a valid model.');
    if (typeof body.requestId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(body.requestId)) throw new FinderError('Send a unique requestId.');
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([body.paths, body.prompt, body.model]))
      .digest('hex');
    const seen = this.receipts.get(body.requestId);
    if (seen) {
      if (seen.fingerprint !== fingerprint) throw new FinderError('That requestId was already used for another task.', 409);
      return seen.result;
    }
    // Never evict a receipt and risk replaying it. A restart begins a new connection/session.
    if (this.receipts.size >= 1000) throw new FinderError('Finder dispatch receipt storage is full. Restart the office before dispatching again.', 503);
    const result = this.perform(body);
    this.receipts.set(body.requestId, { fingerprint, result });
    return result;
  }

  private async perform(body: Record<string, unknown>): Promise<Receipt> {
    const catalogue = await this.options.models();
    if (body.model && body.model !== 'floor-default' && !catalogue.models.some((m) => m.id === body.model)) throw new FinderError('That model is no longer available in the picker.');
    const groups = await this.resolve(body.paths);
    if (this.stopped) throw new FinderError('The office is shutting down. Nothing was dispatched.', 503);
    const result: Receipt = { dispatches: [], errors: [] };
    for (const group of groups) {
      if (this.stopped) {
        result.errors.push({ floorId: group.floorId, error: 'The office is shutting down. Nothing was dispatched to this floor.' });
        continue;
      }
      const def = this.options.building.list().find((d) => d.id === group.floorId);
      if (!def) {
        result.errors.push({ floorId: group.floorId, error: 'That floor was removed. Nothing was dispatched.' });
        continue;
      }
      const explicitModel = body.model && body.model !== 'floor-default';
      const model = explicitModel ? (body.model as string) : group.model;
      // Keep paths quoted and separate; no planning or orchestration text is added.
      const text = `${(body.prompt as string).trim()}\n\n${group.paths.map((p) => JSON.stringify(p)).join('\n')}`;
      try {
        const sent = this.options.dispatch(def, text, model);
        if (typeof sent === 'string') {
          result.errors.push({ floorId: def.id, error: sent });
          continue;
        }
        const hash = new URLSearchParams({ worker: sent.leadId, floor: def.id, view: 'thread' });
        result.dispatches.push({
          floorId: def.id,
          leadId: sent.leadId,
          threadUrl: new URL(`dashboard#${hash}`, this.options.officeUrl()).toString(),
          deepLink: `droid-office://thread/${encodeURIComponent(sent.leadId)}?floor=${encodeURIComponent(def.id)}`,
        });
        if (explicitModel && (sent.model ?? model)) this.remembered[def.id] = (sent.model ?? model)!;
      } catch {
        result.errors.push({ floorId: def.id, error: 'The office failed during dispatch. Open the Team lead thread before trying again.' });
      }
    }
    if (this.stopped) return result;
    try {
      writeFileSync(`${this.file}.tmp`, JSON.stringify(this.remembered, null, 2), { mode: 0o600 });
      renameSync(`${this.file}.tmp`, this.file);
    } catch {
      result.errors.push({ floorId: '', error: 'Tasks were dispatched, but their model preferences could not be saved.' });
    }
    return result;
  }

  stop(): void {
    this.stopped = true;
  }
}

/** The signed bridge owns Keychain access. Token material never enters argv, environment or logs. */
export async function publishFinder(bridge: string, url: string): Promise<string> {
  try {
    const { stdout } = await execute(bridge, ['--publish', url], { timeout: 10000, maxBuffer: 16384 });
    const data: unknown = JSON.parse(stdout);
    if (data && typeof data === 'object') {
      const credentials = data as Record<string, unknown>;
      if (credentials.url === url && typeof credentials.token === 'string' && /^[a-f0-9]{64}$/.test(credentials.token)) return credentials.token;
    }
  } catch {
    // execFile errors contain stdout, which can include a token. Never propagate them.
  }
  throw new Error('Finder integration could not access its signed shared Keychain credential.');
}

export function finderAuthorized(req: IncomingMessage, token: string | undefined): boolean {
  if (!token || req.socket.remoteAddress !== '127.0.0.1' || !/^127\.0\.0\.1(?::\d+)?$/.test(req.headers.host ?? '') || req.headers.origin || req.headers['sec-fetch-site']) return false;
  const sent = req.headers['x-droid-office-token'];
  const actual = createHash('sha256')
    .update(typeof sent === 'string' ? sent : '')
    .digest();
  const expected = createHash('sha256').update(token).digest();
  return timingSafeEqual(actual, expected);
}

/** Mounted only on the 127.0.0.1 hook listener, never the LAN/companion HTTP server. */
export async function handleFinder(req: IncomingMessage, res: ServerResponse, pathname: string, token: string | undefined, finder: FinderDispatch | undefined, models: FinderOptions['models']): Promise<void> {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  if (!finderAuthorized(req, token) || !finder) return send(401, { error: 'Finder authentication required.' });
  if (pathname === '/api/finder/status' && req.method === 'GET') return send(200, { ok: true });
  if (!['/api/finder/resolve', '/api/finder/dispatch'].includes(pathname)) return send(404, { error: 'Not found.' });
  if (req.method !== 'POST') return send(405, { error: 'POST a JSON request.' });
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) return send(415, { error: 'Send application/json.' });
  try {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > BODY_MAX) {
        send(413, { error: 'Finder request is too large.' });
        return;
      }
      chunks.push(Buffer.from(chunk));
    }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new FinderError('Send a JSON object.');
    }
    if (pathname === '/api/finder/dispatch') return send(200, await finder.dispatch(body));
    const paths = body && typeof body === 'object' ? (body as Record<string, unknown>).paths : undefined;
    const catalogue = await models();
    return send(200, { groups: await finder.resolve(paths), ...catalogue });
  } catch (err) {
    send(err instanceof FinderError ? err.status : 500, { error: err instanceof FinderError ? err.message : 'Finder request failed. Check the Team lead before retrying a dispatch.' });
  }
}

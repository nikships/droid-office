import { readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { Worker } from './state.js';

/**
 * The hook command's version, sent in its URL. Droid reads its hooks once, at start, so a worker
 * the terminal host kept across an office update still runs the command it started with: only one
 * that says 2 prints the office's reply and spools the events it can't deliver (see writeHookSettings).
 */
export const HOOK_VERSION = 2;
/** The events the office subscribes its workers' droids to. */
export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SubagentStop', 'PreCompact'];
/** The most a worker's hook spool holds (see hook.cjs); the oldest events go first. */
export const SPOOL_MAX_BYTES = 512 * 1024;
/** Where hooks that couldn't reach the office wait for it, one file per worker, in the floor's .droid-office. */
const SPOOL_DIR = 'hook-spool';
/** How long after an office start a second look at the spools catches hooks that failed while it was coming up. */
export const SPOOL_RECHECK_MS = 5000;
export function safeEq(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

interface SpoolContext {
  get(id: string): Worker | undefined;
  workers(): Iterable<Worker>;
  accept(worker: Worker, event: string, payload: unknown, from: { at: number }): string | undefined;
}

/** Claims spool files before replay so concurrent hook writers are never truncated. */
export class WorkerHookSpool {
  constructor(
    private dataDir: string,
    private context: SpoolContext,
  ) {}
  file(id: string): string {
    return path.join(this.dataDir, SPOOL_DIR, `${id}.jsonl`);
  }

  /**
   * Replays the hooks its droid spooled while the office couldn't take them (see hook.cjs), in the
   * order they fired, then forgets them. The file's place in the floor's .droid-office stands in for
   * the hook token; the session checks still apply. Only hooks the office refused or couldn't be
   * reached for are spooled; one older than the last hook the office took is stale, superseded by
   * that newer one, and is skipped.
   */
  replay(w: Worker) {
    const file = this.file(w.info.id);
    const taken = `${file}.replay`;
    try {
      // Moved aside first, so a hook spooling meanwhile starts a new file instead of being truncated away.
      renameSync(file, taken);
    } catch {
      return;
    }
    let text = '';
    try {
      text = readFileSync(taken, 'utf8');
    } catch {
      // gone again: nothing to replay
    } finally {
      rmSync(taken, { force: true });
    }
    const since = w.hookAt;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let row: { event?: unknown; at?: unknown; token?: unknown; payload?: unknown };
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof row.event !== 'string' || typeof row.at !== 'number' || row.at < since) continue;
      // From an earlier run of its droid, which had another token.
      if (typeof row.token !== 'string' || !safeEq(row.token, w.hookToken)) continue;
      if (this.context.get(w.info.id) !== w || !w.pty) return;
      this.context.accept(w, row.event, row.payload, { at: row.at });
    }
  }

  /** Every running worker's spooled hooks, replayed (see replaySpool). */
  replayAll() {
    for (const w of this.context.workers()) if (w.pty) this.replay(w);
  }

  /** Spools of workers who aren't on the floor any more. */
  prune() {
    const dir = path.join(this.dataDir, SPOOL_DIR);
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const id = name.slice(0, name.indexOf('.'));
      if (!this.context.get(id) || name !== `${id}.jsonl`) rmSync(path.join(dir, name), { force: true });
    }
  }
}

/**
 * The hook command's Node half (see writeHookSettings): posts one hook to the office with a short
 * connect timeout and prints its answer, or, given `spool` or when the office can't take it, keeps
 * it in hook-spool/<worker>.jsonl for the office to replay. The file holds at most SPOOL_MAX_BYTES;
 * the oldest hooks go first.
 */
export function hookScript(): string {
  return String.raw`const http = require('http');
const fs = require('fs');
const path = require('path');
const MAX = ${SPOOL_MAX_BYTES};
const [event, mode] = process.argv.slice(2);
const worker = process.env.DROID_OFFICE_WORKER_ID || '';
const token = process.env.DROID_OFFICE_HOOK_TOKEN || '';
let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (body += c));
process.stdin.on('end', () => (mode === 'spool' ? spool() : send()));
function send() {
  const url = new URL(process.env.DROID_OFFICE_HOOK_URL + '/hooks/droid');
  url.searchParams.set('worker', worker);
  url.searchParams.set('event', event);
  // A command from before HOOK_VERSION runs this file too, after an update rewrote it, and throws
  // its output away: only one that says 'reply' prints what the office answers.
  url.searchParams.set('v', mode === 'reply' ? '${HOOK_VERSION}' : '0');
  let done = false;
  let sent = false;
  // Once the office has the whole hook, a slow answer isn't a failure: spooling it would replay it.
  const fail = () => {
    if (done) return;
    done = true;
    if (!sent) spool();
  };
  const req = http.request(url, { method: 'POST', timeout: 2000, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' } }, (res) => {
    let out = '';
    res.setEncoding('utf8');
    res.on('data', (c) => (out += c));
    res.on('error', fail);
    res.on('end', () => {
      if (done) return;
      done = true;
      // Refused (a worker the office hasn't picked back up yet): kept for the replay.
      if (res.statusCode !== 200) return spool();
      process.stdout.write(out);
    });
  });
  const connect = setTimeout(() => req.destroy(), 500);
  req.on('socket', (s) => s.once('connect', () => clearTimeout(connect)));
  req.on('error', fail);
  req.on('close', () => clearTimeout(connect));
  req.on('timeout', () => req.destroy());
  req.end(body, () => (sent = true));
}
function spool() {
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return;
  }
  if (!/^[\w-]+$/.test(worker)) return;
  const dir = path.join(__dirname, 'hook-spool');
  const file = path.join(dir, worker + '.jsonl');
  const line = JSON.stringify({ event, at: Date.now(), token, payload }) + '\n';
  const size = Buffer.byteLength(line);
  if (size > MAX) return;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    let had = 0;
    try {
      had = fs.statSync(file).size;
    } catch {}
    if (had + size <= MAX) return fs.appendFileSync(file, line, { mode: 0o600 });
    const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const kept = [];
    let total = size;
    for (let i = rows.length - 1; i >= 0; i--) {
      const n = Buffer.byteLength(rows[i]) + 1;
      if (total + n > MAX) break;
      total += n;
      kept.unshift(rows[i] + '\n');
    }
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, kept.join('') + line, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {}
}
`;
}

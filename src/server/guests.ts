import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { open, readdir, readlink, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ClientMsg, GuestInfo, GuestProvider, OutsideProcess, WorkerInfo, WorkerStatus } from '../shared/protocol.js';
import { nextFreeSeat } from '../shared/layout.js';
import { PROVIDER_LABEL } from '../shared/guests.js';
import { DROID_SESSIONS_DIR, DroidSessionReader } from './droid-session.js';

// Guests: agent processes (droid, claude, codex…) that someone started by hand in a terminal of
// their own, in one of the floors' checkouts. The office didn't start them and doesn't own their
// terminals, so it only watches: every few seconds it lists this user's processes, reads each
// agent's working directory, and seats the ones working in a floor's checkout at a desk there.
// Nothing here writes to, signals or otherwise touches those processes.

const SCAN_MS = 4000;
/** The session transcript's tail that is read for how a droid guest is doing. */
const TAIL_BYTES = 128 * 1024;
const HEAD_BYTES = 8 * 1024;
/** A session file written up to this long before its process started still counts as its (droid writes it as it starts). */
const START_SLACK_MS = 5000;
const SESSION_ID = /^[a-zA-Z0-9-]{1,160}$/;
/** A guest goes home after this many scans in a row without its process. */
const MISSES_TO_LEAVE = 2;

/** The executable names of the agent CLIs a guest can be, by provider. */
const PROVIDERS: Record<string, GuestProvider> = {
  droid: 'droid',
  claude: 'claude',
  codex: 'codex',
  opencode: 'opencode',
  grok: 'grok',
  muse: 'muse',
};

/** One line of `ps`. */
export interface ProcRow {
  pid: number;
  ppid: number;
  /** As ps names it: ttys004, pts/3, or ?? / ? for none. */
  tty: string;
  /** ps's start time, as written: with the pid, it tells this process from a later one given the same pid. */
  lstart: string;
  startedAt: number;
  /** The executable (a full path on macOS, a short name on Linux). */
  comm: string;
}

/** An agent process that may be a guest: what it is and where it works. */
export interface AgentProcess extends OutsideProcess {
  /** Stable for the life of the process, and across office restarts (see guestId). */
  id: string;
  cwd: string;
  startedAt: number;
  /** The session it was started to resume (`droid --resume <id>`), when its arguments say so. */
  resume?: string;
}

/** `ps -o pid=,ppid=,tty=,lstart=,comm=` in the C locale. */
export function parsePs(text: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const lstart = m[4].replace(/\s+/g, ' ');
    const startedAt = Date.parse(lstart);
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), tty: m[3], lstart, startedAt: Number.isFinite(startedAt) ? startedAt : 0, comm: m[5] });
  }
  return rows;
}

/** `ps -o pid=,args=`: each process's arguments, split on spaces (only flags and subcommands are read from them, never paths). */
export function parseArgs(text: string): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m) out.set(Number(m[1]), m[2].trim().split(/\s+/));
  }
  return out;
}

/** `lsof -a -p <pids> -d cwd -Fn`: each process's working directory. */
export function parseLsofCwd(text: string): Map<number, string> {
  const out = new Map<number, string>();
  let pid = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid) out.set(pid, line.slice(1));
  }
  return out;
}

/** Which agent CLI an executable is, if any. */
export function providerOf(comm: string): GuestProvider | undefined {
  const name = path
    .basename(comm.trim())
    .replace(/^-/, '')
    .replace(/\.exe$/i, '')
    .toLowerCase();
  return Object.hasOwn(PROVIDERS, name) ? PROVIDERS[name] : undefined;
}

const hasTty = (tty: string) => !!tty && tty !== '?' && tty !== '??' && tty !== '-';

/** A process's id as a guest: the same for the life of the process (and across office restarts), and never reused by a later one with its pid. */
export function guestId(pid: number, lstart: string): string {
  let h = 0;
  for (const ch of lstart) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
  return `guest-${pid}-${(h >>> 0).toString(36)}`;
}

/**
 * Whether an agent's arguments say an office started it: every Droid Office worker, board agent and
 * meeting seat starts with `--settings <its floor>/.droid-office/droid-….json`, the office's hooks.
 */
export function officeLaunched(argv: string[] | undefined): boolean {
  if (!argv) return false;
  for (let i = 1; i < argv.length - 1; i++) if (argv[i] === '--settings' && /[\\/]\.droid-office[\\/]droid-[^\\/]*\.json$/.test(argv[i + 1])) return true;
  return false;
}

/**
 * The processes that can be guests: an agent CLI with a terminal of its own, that isn't the office's
 * (started with the office's hooks, or under a terminal host, the office or one of its workers, here
 * or in another office on this machine) and isn't another agent's helper (only the topmost agent in
 * a process tree counts). Headless runs (`droid exec`) aren't sessions anyone works in.
 */
export function agentCandidates(rows: ProcRow[], args: Map<number, string[]>, officePids: ReadonlySet<number>): ProcRow[] {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const officeOwned = (r: ProcRow) => path.basename(r.comm).startsWith('droid-office') || officePids.has(r.pid);
  return rows.filter((r) => {
    if (!providerOf(r.comm) || !hasTty(r.tty) || officePids.has(r.pid)) return false;
    const argv = args.get(r.pid);
    if (argv?.[1] === 'exec' || officeLaunched(argv)) return false;
    const seen = new Set<number>();
    for (let up = byPid.get(r.ppid); up && !seen.has(up.pid); up = byPid.get(up.ppid)) {
      seen.add(up.pid);
      if (officeOwned(up) || providerOf(up.comm)) return false;
    }
    return true;
  });
}

/** The session id an agent's arguments say it resumes (`--resume <id>`, `-r <id>`), when they do. */
export function resumedSession(argv: string[] | undefined): string | undefined {
  if (!argv) return undefined;
  for (let i = 1; i < argv.length - 1; i++) {
    if ((argv[i] === '--resume' || argv[i] === '-r') && SESSION_ID.test(argv[i + 1])) return argv[i + 1];
  }
  return undefined;
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } }, (_err, out) => resolve(out ?? ''));
  });
}

/**
 * This user's agent processes that could be guests, with their working directories. `officePids`
 * are processes the office runs (itself, its workers' terminals): nothing under them is a guest.
 * Nothing on Windows, which has no ps or lsof.
 */
export async function scanAgents(officePids: Iterable<number> = []): Promise<AgentProcess[]> {
  if (process.platform === 'win32') return [];
  const uid = String(process.getuid?.() ?? '');
  const rows = parsePs(await run('ps', ['-U', uid, '-o', 'pid=,ppid=,tty=,lstart=,comm=']));
  const agents = rows.filter((r) => providerOf(r.comm) && hasTty(r.tty));
  if (!agents.length) return [];
  const pids = agents.map((r) => r.pid).join(',');
  const args = parseArgs(await run('ps', ['-ww', '-o', 'pid=,args=', '-p', pids]));
  const picked = agentCandidates(rows, args, new Set([process.pid, ...officePids]));
  if (!picked.length) return [];
  const cwds = await workingDirs(picked.map((r) => r.pid));
  const out: AgentProcess[] = [];
  for (const r of picked) {
    const cwd = cwds.get(r.pid);
    if (!cwd) continue;
    const provider = providerOf(r.comm)!;
    out.push({
      id: guestId(r.pid, r.lstart),
      pid: r.pid,
      tty: `/dev/${r.tty}`,
      provider,
      cwd: await realpath(cwd).catch(() => cwd),
      startedAt: r.startedAt,
      resume: provider === 'droid' ? resumedSession(args.get(r.pid)) : undefined,
    });
  }
  return out;
}

/** Where each process works: /proc on Linux, lsof elsewhere (macOS has no /proc). */
async function workingDirs(pids: number[]): Promise<Map<number, string>> {
  if (process.platform === 'linux') {
    const out = new Map<number, string>();
    await Promise.all(
      pids.map(async (pid) => {
        const cwd = await readlink(`/proc/${pid}/cwd`).catch(() => undefined);
        if (cwd) out.set(pid, cwd);
      }),
    );
    return out;
  }
  return parseLsofCwd(await run('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fn']));
}

/** A floor, as far as matching a working directory to it goes. */
export interface FloorDir {
  id: string;
  /** Its checkout, symlinks resolved. */
  dir: string;
  /** The home folder's floor: it holds every other folder, so only the folder itself is it. */
  home?: boolean;
}

const inside = (dir: string, cwd: string) => cwd === dir || cwd.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

/**
 * The floor a working directory belongs to: the floor whose checkout it is, or the innermost floor
 * whose checkout it's somewhere inside (`src/server`, a worktree under `.droid-office/worktrees/`).
 * The home folder's floor is only the home folder itself. None when it's in no floor's checkout.
 */
export function floorFor(cwd: string, floors: readonly FloorDir[]): string | undefined {
  let best: FloorDir | undefined;
  for (const f of floors) {
    if (cwd === f.dir) return f.id;
    if (f.home || !inside(f.dir, cwd)) continue;
    if (!best || f.dir.length > best.dir.length) best = f;
  }
  return best?.id;
}

/**
 * Splits a floor's agent processes into the ones started by hand in a worker's own folder (its
 * worktree or workspace), which are that worker's (`outside`, by worker id), and the rest, the guests.
 * `workers` are the floor's workers with their folders; one working in the floor's own checkout has none.
 */
export function attribute(procs: readonly AgentProcess[], workers: readonly { id: string; folder?: string }[]): { guests: AgentProcess[]; outside: Map<string, OutsideProcess[]> } {
  const outside = new Map<string, OutsideProcess[]>();
  const guests: AgentProcess[] = [];
  for (const p of procs) {
    // The innermost folder wins: a meeting's worktree inside a workspace, say.
    let owner: { id: string; folder?: string } | undefined;
    for (const w of workers) if (w.folder && inside(w.folder, p.cwd) && (!owner || w.folder.length > (owner.folder?.length ?? 0))) owner = w;
    if (!owner) {
      guests.push(p);
      continue;
    }
    const list = outside.get(owner.id) ?? [];
    list.push({ pid: p.pid, tty: p.tty, provider: p.provider });
    outside.set(owner.id, list);
  }
  return { guests, outside };
}

/** How a droid session's transcript says it's doing, and what it's on. */
export interface TranscriptState {
  /** idle: no prompt yet; working: a turn has started and not ended; done: its last turn ended. */
  status: 'idle' | 'working' | 'done';
  /** The session's title, as droid named it. */
  title?: string;
  /** The last thing it was asked. */
  prompt?: string;
}

/** A user message's own text, not the context droid adds around it (system reminders, hook output). */
function userText(entry: Record<string, any>): string | undefined {
  const m = entry.message;
  if (entry.type !== 'message' || m?.role !== 'user' || !Array.isArray(m.content)) return undefined;
  if (typeof entry.id === 'string' && /^(context-|__internal__)/.test(entry.id)) return undefined;
  const text = m.content
    .filter((c: any) => c?.type === 'text' && typeof c.text === 'string' && !c.text.trimStart().startsWith('<system-reminder>'))
    .map((c: any) => c.text)
    .join('\n')
    .trim();
  return text || undefined;
}

/**
 * Reads a droid session transcript (`<session>.jsonl`): `head` is the start of the file, `tail` its
 * end (`partial` when the tail starts mid-line). A turn ends with an `agent_turn_outcome` line;
 * between a prompt (or the agent's reply) and that, the session is mid-turn. It says nothing about
 * a permission prompt or question: a turn waiting on one reads as still working.
 */
export function transcriptState(head: string, tail: string, partial = false): TranscriptState {
  let title: string | undefined;
  try {
    const first = JSON.parse(head.split('\n', 1)[0]);
    if (first?.type === 'session_start' && typeof first.title === 'string' && first.title.trim()) title = first.title.trim();
  } catch {
    // no complete first line in what was read
  }
  const lines = tail.split('\n');
  if (partial) lines.shift();
  let status: TranscriptState['status'] = 'idle';
  let prompt: string | undefined;
  let settled = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: Record<string, any>;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const text = userText(entry);
    if (text && prompt === undefined) prompt = text;
    if (!settled) {
      if (entry.type === 'agent_turn_outcome') {
        status = 'done';
        settled = true;
      } else if (text || (entry.type === 'message' && entry.message?.role === 'assistant')) {
        status = 'working';
        settled = true;
      }
    }
    if (settled && prompt !== undefined) break;
  }
  return { status, title, prompt };
}

/**
 * Which droid session each droid guest is in. One started with `--resume <id>` is in that one.
 * Otherwise a session is tied to a guest only when it can't be anyone else's: the one guest without
 * a session in that folder gets the session there written most recently since it started. With two
 * or more in one folder, there's no telling whose transcript is whose, so none of them gets one.
 * `files` are each folder's session transcripts; `taken` the sessions of the office's own workers.
 */
export function assignSessions(guests: readonly { id: string; cwd: string; startedAt: number; resume?: string }[], files: ReadonlyMap<string, readonly { id: string; mtime: number }[]>, taken: ReadonlySet<string>): Map<string, string> {
  const out = new Map<string, string>();
  const claimed = new Set(taken);
  for (const g of guests) {
    if (g.resume && !claimed.has(g.resume) && files.get(g.cwd)?.some((f) => f.id === g.resume)) {
      out.set(g.id, g.resume);
      claimed.add(g.resume);
    }
  }
  const byCwd = new Map<string, typeof guests>();
  for (const g of guests) if (!out.has(g.id)) byCwd.set(g.cwd, [...(byCwd.get(g.cwd) ?? []), g]);
  for (const [cwd, here] of byCwd) {
    if (here.length !== 1) continue;
    const g = here[0];
    const pick = (files.get(cwd) ?? []).filter((f) => !claimed.has(f.id) && f.mtime >= g.startedAt - START_SLACK_MS).sort((a, b) => b.mtime - a.mtime)[0];
    if (!pick) continue;
    out.set(g.id, pick.id);
    claimed.add(pick.id);
  }
  return out;
}

/** The folders droid keeps a working directory's sessions in, as it has spelled them. */
function sessionDirs(root: string, cwd: string): string[] {
  return [...new Set([cwd.replace(/[\\/:]/g, '-'), cwd.replace(/[^a-zA-Z0-9-]/g, '-')])].map((d) => path.join(root, d));
}

async function sessionFiles(root: string, cwd: string): Promise<{ id: string; mtime: number; file: string }[]> {
  for (const dir of sessionDirs(root, cwd)) {
    const names = await readdir(dir).catch(() => undefined);
    if (!names) continue;
    const files = await Promise.all(
      names
        .filter((n) => n.endsWith('.jsonl') && SESSION_ID.test(n.slice(0, -6)))
        .map(async (n) => {
          const file = path.join(dir, n);
          const s = await stat(file).catch(() => undefined);
          return s ? { id: n.slice(0, -6), mtime: s.mtimeMs, file } : undefined;
        }),
    );
    return files.filter((f) => !!f);
  }
  return [];
}

/** The start and the end of a file. */
async function readEnds(file: string, size: number): Promise<{ head: string; tail: string; partial: boolean }> {
  const fh = await open(file, 'r');
  try {
    const headBuf = Buffer.alloc(Math.min(HEAD_BYTES, size));
    await fh.read(headBuf, 0, headBuf.length, 0);
    const from = Math.max(0, size - TAIL_BYTES);
    const tailBuf = Buffer.alloc(size - from);
    await fh.read(tailBuf, 0, tailBuf.length, from);
    return { head: headBuf.toString('utf8'), tail: tailBuf.toString('utf8'), partial: from > 0 };
  } finally {
    await fh.close();
  }
}

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/** How long ago, roughly: "just now", "3 min ago", "2 h ago". */
function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 30) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/**
 * What a guest's terminal window shows: it has no terminal in the office, so this says plainly that
 * it runs elsewhere, where, and what the office does and doesn't know about it.
 */
export function guestBanner(info: WorkerInfo, now = Date.now()): string {
  const g = info.guest!;
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
  const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
  const state =
    g.seen === 'process'
      ? `running — there's no ${g.provider === 'droid' ? 'session transcript the office can tie to this process' : 'transcript the office reads for this CLI'}, so it doesn't know whether it's working or waiting`
      : info.status === 'done'
        ? `done — its last turn ended ${ago(g.writtenAt ?? now, now)} (from its transcript)`
        : info.status === 'working'
          ? `working — mid-turn by its transcript, last written ${ago(g.writtenAt ?? now, now)}. A permission prompt or question looks the same from here`
          : 'ready — no prompt in its transcript yet';
  const model = info.activeModel ? `${info.activeModel}${info.activeEffort ? ` · ${info.activeEffort}` : ''}` : undefined;
  const lines = [
    bold(`${info.name} is a ${PROVIDER_LABEL[g.provider]} session running outside the office.`),
    '',
    `  Process   pid ${g.pid} on ${g.tty}, started ${new Date(g.startedAt).toLocaleString()}`,
    `  Folder    ${g.cwd}`,
    ...(model ? [`  Model     ${model}`] : []),
    ...(info.task?.name && g.seen === 'transcript' ? [`  Session   ${info.task.name}`] : []),
    ...(info.prompt ? [`  Asked     ${clip(info.prompt, 200)}`] : []),
    `  Status    ${state}`,
    '',
    dim('The office only watches this process: nothing from its terminal is shown here, and nothing'),
    dim('typed here reaches it. To work with it, switch to that terminal. It goes home when it exits.'),
  ];
  return `${lines.join('\r\n')}\r\n`;
}

const label = (p: GuestProvider) => PROVIDER_LABEL[p];

/** What the office does to its own workers and never to a guest, which it only watches (see guests.ts). */
export const GUEST_REFUSED = new Set<ClientMsg['t']>([
  'worker.resume',
  'worker.kill',
  'worker.shoot',
  'worker.revive',
  'worker.worktree',
  'worker.rebuild',
  'worker.prompt',
  'worker.pr',
  'changes.watch',
  'changes.diff',
  'changes.commit',
  'changes.discard',
  'changes.pr',
]);
/** Why a guest can't be sent home, prompted or shot: the office didn't start it and won't touch it. */
export function guestRefusal(w: WorkerInfo, t: ClientMsg['t']): string {
  const g = w.guest!;
  const where = `pid ${g.pid} on ${g.tty}`;
  if (t === 'worker.kill') return `${w.name} runs outside the office (${where}): the office never stops a process it didn't start. Quit it in its own terminal and it goes home by itself`;
  if (t === 'worker.prompt') return `${w.name} runs outside the office (${where}): type to it in its own terminal`;
  if (t === 'worker.shoot' || t === 'worker.revive') return `${w.name} is a guest from outside the office (${where}): the office leaves it alone`;
  return `${w.name} runs outside the office (${where}): the office only watches it`;
}

interface Guest {
  info: WorkerInfo;
  proc: AgentProcess;
  /** The transcript as last read, so an unchanged one isn't read again. */
  read?: { file: string; mtime: number; state: TranscriptState };
  /** What was last sent, to tell whether anything changed. */
  sent: string;
  /** Scans in a row that didn't find its process. */
  missed: number;
}

/** What guests.json keeps of a guest, so it's back at the same desk, with the same name, after a restart. */
interface SavedGuest {
  id: string;
  deskId: string;
  name: string;
  color: string;
  acked: boolean;
  waitingSince?: number;
}

export interface GuestEvents {
  update(info: WorkerInfo): void;
  remove(id: string): void;
  /** A redrawn banner for the connections that have the guest's window open. */
  data(id: string, data: string, connectionIds: string[]): void;
}

export interface GuestSeating {
  /** Whether one of the office's own workers sits there. */
  deskTaken(deskId: string): boolean;
  /** The office's own workers' names, which a guest doesn't take. */
  names(): Iterable<string>;
  /** Names and colors to pick from. */
  pool: { names: readonly string[]; colors: readonly string[] };
}

/**
 * A floor's guests (see the top of this file). Each sits at a desk or bean bag of its own, which the
 * office's hires and the queue then treat as taken. A guest is never in the WorkerManager: it isn't
 * counted against the worker limit, handed tasks, prompted, sent home or pruned.
 */
export class Guests {
  private guests = new Map<string, Guest>();
  private subscribers = new Map<string, Set<string>>();
  private saved = new Map<string, SavedGuest>();
  private savedJson = '';
  private file: string;
  private reader: DroidSessionReader;
  private stopped = false;

  constructor(
    dataDir: string,
    private seating: GuestSeating,
    private events: GuestEvents,
    private sessionsRoot = DROID_SESSIONS_DIR,
  ) {
    this.file = path.join(dataDir, 'guests.json');
    this.reader = new DroidSessionReader(sessionsRoot);
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, 'utf8'));
        if (Array.isArray(raw)) {
          for (const s of raw) if (typeof s?.id === 'string' && typeof s.deskId === 'string' && typeof s.name === 'string') this.saved.set(s.id, s);
        }
      }
    } catch {
      // unreadable: guests just pick new desks
    }
  }

  list(): WorkerInfo[] {
    return [...this.guests.values()].map((g) => g.info);
  }

  get(id: string): WorkerInfo | undefined {
    return this.guests.get(id)?.info;
  }

  deskTaken(deskId: string): boolean {
    for (const g of this.guests.values()) if (g.info.deskId === deskId) return true;
    return false;
  }

  names(): string[] {
    return [...this.guests.values()].map((g) => g.info.name);
  }

  /**
   * The floor's guests are now `procs`: newcomers sit down, guests whose process is gone leave, and
   * the rest are brought up to date from their transcripts. `sessions` are the office's own
   * workers' session ids here, which are never a guest's.
   */
  async sync(procs: readonly AgentProcess[], sessions: ReadonlySet<string>): Promise<void> {
    if (this.stopped) return;
    const now = new Map(procs.map((p) => [p.id, p]));
    for (const [id, g] of this.guests) {
      const p = now.get(id);
      if (p && p.cwd === g.proc.cwd) {
        g.proc = p;
        g.missed = 0;
        continue;
      }
      // One scan that didn't see it (lsof timing out, say) isn't it leaving.
      if (!p && ++g.missed < MISSES_TO_LEAVE) continue;
      this.guests.delete(id);
      this.subscribers.delete(id);
      this.events.remove(id);
    }
    const fresh = new Set<string>();
    for (const p of procs) {
      if (this.guests.has(p.id)) continue;
      const g = this.seat(p);
      if (!g) continue;
      this.guests.set(p.id, g);
      fresh.add(p.id);
    }
    const droids = [...this.guests.values()].filter((g) => g.proc.provider === 'droid');
    const files = new Map<string, { id: string; mtime: number; file: string }[]>();
    for (const cwd of new Set(droids.map((g) => g.proc.cwd))) files.set(cwd, await sessionFiles(this.sessionsRoot, cwd));
    const sessionOf = assignSessions(
      droids.map((g) => ({ id: g.info.id, cwd: g.proc.cwd, startedAt: g.proc.startedAt, resume: g.proc.resume })),
      files,
      sessions,
    );
    await Promise.all(
      [...this.guests.values()].map(async (g) => {
        const id = sessionOf.get(g.info.id);
        const file = id ? files.get(g.proc.cwd)?.find((f) => f.id === id) : undefined;
        await this.refresh(g, file, fresh.has(g.info.id));
      }),
    );
    if (this.stopped) return;
    for (const g of this.guests.values()) {
      const json = JSON.stringify(g.info);
      if (json === g.sent) continue;
      g.sent = json;
      this.events.update({ ...g.info });
      const subs = this.subscribers.get(g.info.id);
      if (subs?.size) this.events.data(g.info.id, `\x1b[2J\x1b[3J\x1b[H${guestBanner(g.info)}`, [...subs]);
    }
    this.persist();
  }

  /** A desk for a newcomer: the one it had before a restart if that's still free, else the first free seat. */
  private seat(p: AgentProcess): Guest | undefined {
    const taken = (id: string) => this.seating.deskTaken(id) || this.deskTaken(id);
    const before = this.saved.get(p.id);
    const deskId = before && !taken(before.deskId) ? before.deskId : nextFreeSeat(taken)?.id;
    if (!deskId) return undefined;
    const used = new Set([...this.seating.names(), ...this.names()]);
    const { names, colors } = this.seating.pool;
    const name = before && !used.has(before.name) ? before.name : (names.find((n) => !used.has(n)) ?? `Guest ${this.guests.size + 1}`);
    const info: WorkerInfo = {
      id: p.id,
      kind: 'agent',
      deskId,
      name,
      color: before?.color ?? colors[p.pid % colors.length],
      status: 'idle',
      acked: before?.acked ?? true,
      waitingSince: before?.waitingSince,
      createdBy: 'outside the office',
      createdAt: p.startedAt || Date.now(),
      cols: 100,
      rows: 30,
      open: false,
      guest: { pid: p.pid, tty: p.tty, provider: p.provider, cwd: p.cwd, startedAt: p.startedAt, seen: 'process' },
    };
    return { info, proc: p, sent: '', missed: 0 };
  }

  /** Brings a guest up to date from its transcript (a droid session tied to it), or as just a running process. */
  private async refresh(g: Guest, file: { id: string; mtime: number; file: string } | undefined, fresh: boolean) {
    const { info, proc } = g;
    const was = info.status;
    let state: TranscriptState | undefined;
    if (file) {
      if (g.read?.file === file.file && g.read.mtime === file.mtime) state = g.read.state;
      else {
        try {
          const s = await stat(file.file);
          const ends = await readEnds(file.file, s.size);
          state = transcriptState(ends.head, ends.tail, ends.partial);
          g.read = { file: file.file, mtime: file.mtime, state };
        } catch {
          state = undefined;
        }
      }
    }
    const guest: GuestInfo = { pid: proc.pid, tty: proc.tty, provider: proc.provider, cwd: proc.cwd, startedAt: proc.startedAt, seen: state ? 'transcript' : 'process', ...(state && file ? { writtenAt: Math.round(file.mtime) } : {}) };
    info.guest = guest;
    const status: WorkerStatus = state?.status ?? 'idle';
    if (status === 'done') {
      const since = Math.round(file!.mtime);
      // Finished before the office saw it (or before a restart, when it was looked at then): nobody is left to tell.
      if (was !== 'done' || info.waitingSince === undefined) {
        const before = this.saved.get(info.id);
        info.acked = fresh ? (before?.waitingSince === since ? before.acked : true) : info.open;
        info.waitingSince = since;
      }
    } else {
      info.acked = true;
      info.waitingSince = undefined;
    }
    info.status = status;
    const where = `outside the office · ${label(proc.provider)} · pid ${proc.pid}`;
    if (state) {
      info.prompt = state.prompt;
      info.activity = state.prompt ? clip(state.prompt, 80) : status === 'idle' ? 'Ready for a first prompt' : undefined;
      info.task = { name: clip(state.title ?? state.prompt ?? `${label(proc.provider)} session`, 60), summary: where };
      const model = await this.reader.read(file!.id, proc.cwd);
      info.activeModel = model?.model;
      info.activeEffort = model?.effort;
    } else {
      info.prompt = undefined;
      info.activity = 'Running outside the office — its state is not known here';
      info.task = { name: `${label(proc.provider)} outside the office`, summary: `pid ${proc.pid} on ${proc.tty}` };
      info.activeModel = undefined;
      info.activeEffort = undefined;
    }
  }

  /** Someone opened a guest's window: it gets the banner (it has no terminal here), and a finished turn counts as seen. */
  attach(id: string, clientId: string): { data: string; cols: number; rows: number } | undefined {
    const g = this.guests.get(id);
    if (!g) return undefined;
    let subs = this.subscribers.get(id);
    if (!subs) {
      subs = new Set();
      this.subscribers.set(id, subs);
    }
    subs.add(clientId);
    if (!g.info.open || !g.info.acked) {
      g.info.open = true;
      g.info.acked = true;
      g.sent = JSON.stringify(g.info);
      this.events.update({ ...g.info });
      this.persist();
    }
    return { data: guestBanner(g.info), cols: g.info.cols, rows: g.info.rows };
  }

  detach(id: string, clientId: string) {
    const subs = this.subscribers.get(id);
    if (!subs?.delete(clientId)) return;
    if (subs.size) return;
    this.subscribers.delete(id);
    const g = this.guests.get(id);
    if (!g) return;
    g.info.open = false;
    g.sent = JSON.stringify(g.info);
    this.events.update({ ...g.info });
  }

  detachAll(clientId: string) {
    for (const id of [...this.subscribers.keys()]) this.detach(id, clientId);
  }

  private persist() {
    const saved: SavedGuest[] = [...this.guests.values()].map(({ info }) => ({ id: info.id, deskId: info.deskId, name: info.name, color: info.color, acked: info.acked, waitingSince: info.waitingSince }));
    const json = JSON.stringify(saved, null, 2);
    if (json === this.savedJson) return;
    this.savedJson = json;
    this.saved = new Map(saved.map((s) => [s.id, s]));
    try {
      writeFileSync(this.file, json, { mode: 0o600 });
    } catch {
      // disk trouble: guests just pick their desks again after a restart
    }
  }

  /** The floor is closing. guests.json stays, so they're back at their desks if the office comes back while they run. */
  stop() {
    this.stopped = true;
    this.subscribers.clear();
  }
}

/** A floor, for the scanner: where it is, and its guests to hand its processes to. */
export interface ScannedFloor extends FloorDir {
  syncGuests(procs: AgentProcess[]): Promise<void>;
}

/**
 * One scan for the whole building, every few seconds: each floor gets the agent processes working
 * in its checkout (see floorFor). A process working in no floor's checkout is nobody's guest.
 */
export class GuestScanner {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private floors: () => ScannedFloor[],
    /** The office's own processes (its workers' terminals): nothing under them is a guest. */
    private officePids: () => Iterable<number>,
    private scan: (officePids: Iterable<number>) => Promise<AgentProcess[]> = scanAgents,
  ) {}

  start() {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), SCAN_MS);
  }

  stop() {
    clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const floors = await Promise.all(this.floors().map(async (f) => ({ ...f, sync: f.syncGuests, dir: await realpath(f.dir).catch(() => f.dir) })));
      const procs = await this.scan(this.officePids());
      const per = new Map<string, AgentProcess[]>(floors.map((f) => [f.id, []]));
      for (const p of procs) {
        const id = floorFor(p.cwd, floors);
        if (id) per.get(id)!.push(p);
      }
      await Promise.all(floors.map((f) => f.sync(per.get(f.id) ?? []).catch(() => undefined)));
    } catch {
      // ps or lsof missing or failing: try again next time
    } finally {
      this.running = false;
    }
  }
}

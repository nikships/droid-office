// Cloud workers: office workers whose Droid session runs on one of the account's Factory computers
// instead of in a terminal on this machine (see src/server/factory/cloud.ts). The office drives the
// session through Factory's Sessions API with its key: it has no PTY, worktree or hooks here.

import type { WorkerAction, WorkerStatus } from './protocol.js';
import { toolAction } from './actions.js';

/** What a cloud worker's WorkerInfo carries about where its session runs. */
export interface CloudWorker {
  computerId: string;
  /** The computer's name when it was hired, like `orb`. */
  computerName: string;
  /** Its provider: `e2b` for one Factory runs, `byom` for the owner's own machine. */
  provider?: string;
  /** The folder the session started in on that computer; unset for its home folder. */
  cwd?: string;
  /** The autonomy level its session runs at (sessionSettings.autonomyLevel). */
  autonomy: CloudAutonomy;
  /** Why it can't work right now (its session is gone, its computer was deleted…), shown on its desk and card. */
  error?: string;
}

/** The cloud slice of FactoryState: when the office last read its cloud workers' sessions, and why the last read failed. */
export interface FactoryCloudState {
  fetchedAt: number;
  error?: string;
}

export function emptyCloud(): FactoryCloudState {
  return { fetchedAt: 0 };
}

export type CloudAutonomy = 'off' | 'low' | 'medium' | 'high';
const AUTONOMY: readonly CloudAutonomy[] = ['off', 'low', 'medium', 'high'];

/**
 * The autonomy a cloud worker runs at: the office's own `--auto <level>` for its workers (from
 * `--agent-args`), else high. Nobody can answer a permission prompt for a session on a Factory
 * computer from the office, so a cloud worker never asks.
 */
export function officeAutonomy(agentArgs: readonly string[]): CloudAutonomy {
  for (let i = 0; i < agentArgs.length; i++) {
    const a = agentArgs[i];
    if (a === '--skip-permissions-unsafe') return 'high';
    const level = a === '--auto' ? agentArgs[i + 1] : a.startsWith('--auto=') ? a.slice('--auto='.length) : undefined;
    if (level && (AUTONOMY as readonly string[]).includes(level) && level !== 'off') return level as CloudAutonomy;
  }
  return 'high';
}

/** A computer as the hire dialog and the server need it (from the computers slice). */
export interface CloudComputer {
  id: string;
  name: string;
  providerType: string;
  status: string;
  remoteUser?: string;
}

/** Only an active computer can take a session. */
export const canHost = (c: Pick<CloudComputer, 'status'>) => c.status === 'active';

/** Where `~` is on a computer, when the office can tell: a managed (e2b) one is Linux with its user's home in /home. */
export function computerHome(c: Pick<CloudComputer, 'providerType' | 'remoteUser'>): string | undefined {
  if (c.providerType === 'byom' || !c.remoteUser || !/^[\w.-]+$/.test(c.remoteUser)) return undefined;
  return `/home/${c.remoteUser}`;
}

/** The longest folder the API takes. */
export const CWD_MAX = 4096;

/**
 * The folder to start a session in, from what was typed: '' (or `~`) is the computer's home folder,
 * which the API picks when it's left out; `~/x` is under the home folder where the office knows it.
 * A string is why it can't be used.
 */
export function sessionCwd(typed: string, c: Pick<CloudComputer, 'name' | 'providerType' | 'remoteUser'>): { cwd?: string } | string {
  const t = typed.trim();
  if (!t || t === '~' || t === '~/') return {};
  if (t.length > CWD_MAX) return 'That folder is too long';
  if (/\p{Cc}/u.test(t)) return 'That folder has control characters in it';
  if (t.startsWith('~/')) {
    const home = computerHome(c);
    if (!home) return `Type the full path on ${c.name}, or leave the folder empty for its home folder`;
    return { cwd: `${home}/${t.slice(2).replace(/\/+$/, '')}` };
  }
  if (!t.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(t)) return `Type the full path on ${c.name} (or ~/…), or leave it empty for its home folder`;
  return { cwd: t };
}

/** A session's page in Factory's web app. */
export const cloudSessionUrl = (sessionId: string) => `https://app.factory.ai/sessions/${encodeURIComponent(sessionId)}`;

/** The badge a cloud worker wears on its card, its desk hint and the Workers panel: ☁ and its computer. */
export const cloudBadge = (c: Pick<CloudWorker, 'computerName'>) => `☁ ${c.computerName}`;

/**
 * What the office remembers of a cloud worker's turns between polls, to tell a turn that ended from
 * one that hasn't started yet: right after a message is sent, Factory can still say `idle` with the
 * old message count for a few seconds.
 */
export interface CloudTurn {
  /** When the office last sent it a message (ms), until the turn it started has been seen to end. */
  sentAt?: number;
  /** Its message count when that message went. */
  countAtSend?: number;
  /** It has been seen pending or running since the last message (or since the office started watching). */
  seenBusy?: boolean;
}

/** How long a sent message may go unseen (still idle, no new messages) before the turn counts as over anyway. */
export const SEND_SETTLE_MS = 90_000;

/**
 * A cloud worker's status from its session's `{status, messageCount}`: pending or running is
 * working; idle after a turn (one the office started, or anyone did) is done; idle with nothing
 * sent is ready for a first prompt. `undefined` keeps the status it has (idle, with no turn seen).
 */
export function cloudStatus(session: { status: string; messageCount?: number }, turn: CloudTurn, now: number): { status?: WorkerStatus; turn: CloudTurn } {
  if (session.status === 'running' || session.status === 'pending') return { status: 'working', turn: { ...turn, seenBusy: true } };
  if (turn.sentAt !== undefined) {
    const moved = (session.messageCount ?? 0) > (turn.countAtSend ?? 0);
    if (turn.seenBusy || moved || now - turn.sentAt >= SEND_SETTLE_MS) return { status: 'done', turn: {} };
    return { status: 'working', turn };
  }
  if (turn.seenBusy) return { status: 'done', turn: {} };
  return { turn };
}

/** A content block of a message as GET /sessions/{id}/messages has it. */
interface RawBlock {
  type?: unknown;
  name?: unknown;
  input?: unknown;
  text?: unknown;
}

/** One line for a tool call, the way a local worker's card says it: "Execute: npm test". */
export function toolActivity(name: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const detail = [i.command, i.file_path, i.path, i.pattern, i.url, i.query, i.description, i.summary].find((v) => typeof v === 'string' && v.trim());
  const line = detail ? `${name}: ${String(detail).replace(/\s+/g, ' ').trim()}` : name;
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/**
 * What a cloud worker is doing, from its newest messages (newest first, as the API pages them): its
 * latest tool call, as an activity line and the action the character acts out. Undefined when the
 * newest assistant message has no tool call (it's writing its answer).
 */
export function latestTool(messages: readonly unknown[]): { activity: string; action?: WorkerAction } | undefined {
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const { role, content } = m as { role?: unknown; content?: unknown };
    if (role !== 'assistant' || !Array.isArray(content)) continue;
    const calls = (content as RawBlock[]).filter((b) => b && b.type === 'tool_use' && typeof b.name === 'string');
    const call = calls.at(-1);
    if (!call) return undefined;
    const name = call.name as string;
    return { activity: toolActivity(name, call.input), action: toolAction(name, call.input) };
  }
  return undefined;
}

/** The text of the newest assistant message that has some, for a worker's card once it's done. */
export function latestReply(messages: readonly unknown[]): string | undefined {
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const { role, content } = m as { role?: unknown; content?: unknown };
    if (role !== 'assistant' || !Array.isArray(content)) continue;
    const text = (content as RawBlock[])
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) return text;
  }
  return undefined;
}

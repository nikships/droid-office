import { homedir } from 'node:os';
import type { DroidSlashCommand } from '../shared/slash-commands.js';
import { askDroid, DROID_LIST } from './droid-rpc.js';

export const DROID_COMMANDS_TTL_MS = 60_000;
const NAME = /^[a-z0-9][a-z0-9._:-]{0,63}$/i;
const MAX_COMMANDS = 500;

/** Asks droid for the skills and custom commands it offers in `cwd`. */
export type DroidCommandLister = (command: string, cwd: string) => Promise<DroidSlashCommand[]>;

const line = (v: unknown, max: number) => (typeof v === 'string' ? v.split('\n')[0].trim().slice(0, max) : '');

/**
 * Droid's `droid.list_commands` and `droid.list_skills` results as slash commands: its custom
 * commands, then the skills a user can invoke (project, personal, then Factory's), each name once.
 * A disabled skill or one only the model may use is left out.
 */
export function parseDroidCommands(commands: unknown, skills: unknown): DroidSlashCommand[] {
  const out: DroidSlashCommand[] = [];
  const seen = new Set<string>();
  const add = (e: unknown, source: DroidSlashCommand['source']) => {
    if (!e || typeof e !== 'object') return;
    const r = e as Record<string, unknown>;
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    if (!NAME.test(name) || seen.has(name.toLowerCase()) || out.length >= MAX_COMMANDS) return;
    if (source === 'skill' && (r.enabled === false || r.userInvocable === false)) return;
    seen.add(name.toLowerCase());
    const hint = line(r.argumentHint, 80);
    out.push({ name, description: line(r.description, 300), source, ...(hint ? { argumentHint: hint } : {}) });
  };
  const list = (v: unknown, key: string) => {
    const arr = v && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined;
    return Array.isArray(arr) ? arr : [];
  };
  for (const c of list(commands, 'commands')) add(c, 'command');
  for (const s of list(skills, 'skills')) add(s, 'skill');
  return out;
}

export const listDroidCommands: DroidCommandLister = async (command, cwd) => {
  const [commands, skills] = await askDroid(command, cwd, [DROID_LIST.commands, DROID_LIST.skills]);
  if (commands === undefined && skills === undefined) throw new Error('droid refused to list its commands');
  return parseDroidCommands(commands, skills);
};

export interface DroidCommandCatalogueOptions {
  /** The droid binary to ask, or how to find it now (it may be installed after the office starts). */
  command?: string | (() => string);
  lister?: DroidCommandLister;
  now?: () => number;
}

export interface DroidCommandCatalogue {
  /** The slash commands droid offers in a worker's folder; empty when droid can't say. */
  get(cwd?: string): Promise<DroidSlashCommand[]>;
  /** Drops every cached list (Droid was installed or replaced). */
  forget(): void;
}

/**
 * The skills and custom commands a worker's droid offers, per folder: a project's own skills and
 * commands live in it, and a worktree can add or change them. Cached briefly, since they change
 * when the owner edits them, not while a menu is open.
 */
export function createDroidCommandCatalogue(options: DroidCommandCatalogueOptions = {}): DroidCommandCatalogue {
  const { command = 'droid', lister = listDroidCommands, now = Date.now } = options;
  const cached = new Map<string, { commands: DroidSlashCommand[]; expiresAt: number }>();
  const pending = new Map<string, Promise<DroidSlashCommand[]>>();
  return {
    get(cwd = homedir()) {
      const hit = cached.get(cwd);
      if (hit && now() < hit.expiresAt) return Promise.resolve(hit.commands);
      const running = pending.get(cwd);
      if (running) return running;
      const load = lister(typeof command === 'function' ? command() : command, cwd)
        .then((commands) => {
          cached.set(cwd, { commands, expiresAt: now() + DROID_COMMANDS_TTL_MS });
          return commands;
        })
        .catch(() => [] as DroidSlashCommand[])
        .finally(() => pending.delete(cwd));
      pending.set(cwd, load);
      return load;
    },
    forget() {
      cached.clear();
    },
  };
}

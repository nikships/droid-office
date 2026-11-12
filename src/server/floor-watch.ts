import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { DESK_BY_ID, type DeskDef } from '../shared/layout.js';
import type { WorkerInfo } from '../shared/protocol.js';
import { isAsleep } from '../shared/status.js';
import { workspaceOf } from './worktrees.js';

export interface FloorTreeContext {
  id: string;
  name: string;
  dir?: string;
  /** Current branch of the floor's main checkout (undefined on plain non-git folders). */
  branch?: string;
  /** Floor's default or selected base branch (such as main or master). */
  baseBranch?: string;
  plain?: boolean;
}

export interface RosterTreeWarning {
  kind: 'shared_tree' | 'on_main_branch';
  floor: string;
  floorName: string;
  cwd?: string;
  branch?: string;
  workers: { id: string; name: string }[];
  message: string;
}

export interface OtherFloorWorker {
  id: string;
  name: string;
  floor: string;
  floorName?: string;
  desk: string;
  kind: WorkerInfo['kind'];
  status: WorkerInfo['status'];
  task?: string;
  doing?: string;
  cwd?: string;
  branch?: string;
  sharedCheckout?: true;
  pr?: { number: number; url: string };
  lead?: { id: string; name: string };
  warnings?: string[];
}

function canonicalTreeKey(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

/** Reads a checkout's live branch from `.git/HEAD` without spawning git; returns undefined when missing or detached. */
export function readHeadBranch(dir: string): { found: true; branch?: string } | { found: false } {
  try {
    const dotGit = path.join(dir, '.git');
    let gitDir = dotGit;
    if (statSync(dotGit).isFile()) {
      const pointer = readFileSync(dotGit, 'utf8').trim();
      const match = /^gitdir:\s*(.+)$/.exec(pointer);
      if (!match) return { found: false };
      gitDir = path.resolve(dir, match[1]);
    }
    const head = readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return { found: true, ...(ref?.[1] ? { branch: ref[1] } : {}) };
  } catch {
    return { found: false };
  }
}

/** Working directory, active branch, and whether a local agent sits directly in the floor's shared checkout. */
export function workerLocation(w: WorkerInfo, floor: FloorTreeContext): { cwd?: string; branch?: string; sharedCheckout?: true } {
  if (w.remote) return {};
  if (w.cloud) return w.cloud.cwd ? { cwd: w.cloud.cwd } : {};
  const rel = workspaceOf(w);
  const cwd = floor.dir ? (rel ? path.resolve(floor.dir, rel) : path.resolve(floor.dir)) : undefined;
  let branch: string | undefined;
  if (w.worktree) {
    const live = cwd ? readHeadBranch(cwd) : { found: false as const };
    branch = live.found ? (live.branch ?? w.worktree.branch) : w.worktree.branch;
  } else if (!floor.plain) {
    const live = floor.dir ? readHeadBranch(floor.dir) : { found: false as const };
    branch = live.found ? live.branch : floor.branch;
  }
  const sharedCheckout = !w.worktree && !floor.plain && w.kind === 'agent' ? (true as const) : undefined;
  return {
    ...(cwd ? { cwd } : {}),
    ...(branch ? { branch } : {}),
    ...(sharedCheckout ? { sharedCheckout } : {}),
  };
}

/** Live local agent sessions can edit files and switch/commit git state in their working tree. */
export function isLiveWriter(w: WorkerInfo): boolean {
  return w.kind === 'agent' && !w.remote && !w.cloud && !isAsleep(w.status);
}

export function isProtectedBaseBranch(branch: string | undefined, baseBranch?: string): boolean {
  if (!branch) return false;
  if (branch === 'main' || branch === 'master') return true;
  return Boolean(baseBranch && branch === baseBranch);
}

/**
 * Flags live agent writers sharing one working tree (such as two workers in the floor checkout with
 * no worktree) or sitting directly on main / the floor's base branch.
 */
export function analyzeCheckoutSafety(floors: readonly (FloorTreeContext & { workers: readonly WorkerInfo[] })[]): {
  perWorker: Map<string, string[]>;
  warnings: RosterTreeWarning[];
} {
  const perWorker = new Map<string, string[]>();
  const warnings: RosterTreeWarning[] = [];
  const addWorkerWarning = (id: string, text: string) => {
    let list = perWorker.get(id);
    if (!list) {
      list = [];
      perWorker.set(id, list);
    }
    list.push(text);
  };

  type WriterEntry = { w: WorkerInfo; floor: FloorTreeContext; cwd?: string; branch?: string };
  const byTree = new Map<string, WriterEntry[]>();
  const onBase = new Map<string, WriterEntry[]>();

  for (const floor of floors) {
    if (floor.plain) continue;
    for (const w of floor.workers) {
      if (!isLiveWriter(w)) continue;
      const loc = workerLocation(w, floor);
      const entry: WriterEntry = { w, floor, cwd: loc.cwd, branch: loc.branch };
      const treeKey = loc.cwd ? `dir:${canonicalTreeKey(loc.cwd)}` : w.worktree ? `wt:${floor.id}:${w.worktree.path}` : `checkout:${floor.id}`;
      let group = byTree.get(treeKey);
      if (!group) {
        group = [];
        byTree.set(treeKey, group);
      }
      group.push(entry);

      if (isProtectedBaseBranch(loc.branch, floor.baseBranch)) {
        const baseKey = `${floor.id}:${loc.branch}`;
        let baseGroup = onBase.get(baseKey);
        if (!baseGroup) {
          baseGroup = [];
          onBase.set(baseKey, baseGroup);
        }
        baseGroup.push(entry);
      }
    }
  }

  for (const entries of byTree.values()) {
    if (entries.length < 2) continue;
    const first = entries[0];
    const shownTree = first.cwd ?? `${first.floor.name} checkout`;
    const noWorktree = entries.every((e) => !e.w.worktree);
    const branches = [...new Set(entries.map((e) => e.branch).filter((b): b is string => !!b))];
    const commonBranch = branches.length === 1 ? branches[0] : undefined;
    warnings.push({
      kind: 'shared_tree',
      floor: first.floor.id,
      floorName: first.floor.name,
      ...(first.cwd ? { cwd: first.cwd } : {}),
      ...(commonBranch ? { branch: commonBranch } : {}),
      workers: entries.map((e) => ({ id: e.w.id, name: e.w.name })),
      message: `${entries.map((e) => `${e.w.name} (${e.w.id})`).join(', ')} share working tree ${shownTree}${noWorktree ? ' without isolated worktrees' : ''}${commonBranch ? ` on ${commonBranch}` : ''}.`,
    });
    for (const entry of entries) {
      const others = entries.filter((o) => o.w.id !== entry.w.id);
      addWorkerWarning(entry.w.id, `Shares working tree ${shownTree}${!entry.w.worktree ? ' (no worktree)' : ''} with ${others.map((o) => `${o.w.name} (${o.w.id})`).join(', ')}`);
    }
  }

  for (const entries of onBase.values()) {
    const first = entries[0];
    const branch = first.branch!;
    const allShared = entries.every((e) => !e.w.worktree);
    warnings.push({
      kind: 'on_main_branch',
      floor: first.floor.id,
      floorName: first.floor.name,
      ...(allShared && first.cwd ? { cwd: first.cwd } : {}),
      branch,
      workers: entries.map((e) => ({ id: e.w.id, name: e.w.name })),
      message: `${entries.map((e) => `${e.w.name} (${e.w.id})`).join(', ')} ${entries.length === 1 ? 'is' : 'are'} on ${branch}${allShared ? ` in shared checkout${first.cwd ? ` (${first.cwd})` : ''} without a worktree` : ''}.`,
    });
    for (const entry of entries) {
      addWorkerWarning(entry.w.id, !entry.w.worktree ? `On ${branch} in shared checkout${entry.cwd ? ` (${entry.cwd})` : ''} with no worktree` : `Sitting on base branch ${branch}${entry.cwd ? ` (${entry.cwd})` : ''}`);
    }
  }

  return { perWorker, warnings };
}

/** Snapshot of floor workers outside the caller's own team/watched set, so team_status never leaves a lead blind to active floor work. */
export function buildOtherFloorWorkers(floor: FloorTreeContext & { workers: readonly WorkerInfo[] }, callerId: string, inTeamIds: ReadonlySet<string>, leadNames?: ReadonlyMap<string, string>): OtherFloorWorker[] {
  const { perWorker } = analyzeCheckoutSafety([floor]);
  return [...floor.workers]
    .filter((w) => w.id !== callerId && !inTeamIds.has(w.id) && !w.remote)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((w): OtherFloorWorker => {
      const loc = workerLocation(w, floor);
      const warnings = perWorker.get(w.id);
      return {
        id: w.id,
        name: w.name,
        floor: floor.id,
        ...(floor.name ? { floorName: floor.name } : {}),
        desk: DESK_BY_ID.get(w.deskId)?.label ?? w.deskId,
        kind: w.kind,
        status: w.status,
        ...(w.task ? { task: w.task.summary ? `${w.task.name}: ${w.task.summary}` : w.task.name } : w.title ? { task: w.title } : {}),
        ...(w.activity ? { doing: w.activity } : {}),
        ...loc,
        ...(w.pr ? { pr: w.pr } : {}),
        ...(w.lead ? { lead: { id: w.lead, name: leadNames?.get(w.lead) ?? w.lead } } : {}),
        ...(warnings?.length ? { warnings } : {}),
      };
    });
}

export function formatOtherFloorWorkers(workers: readonly OtherFloorWorker[], verbose = true): string[] {
  if (!workers.length) return [];
  const header = 'Other workers on floor (not in your team; call team_watch to follow):';
  if (!verbose) {
    return [
      header,
      ...workers.map(
        (w) =>
          `  ${w.name} (${w.id}), ${w.desk}, ${w.status}${w.cwd ? `, ${w.cwd}${w.sharedCheckout ? ' (no worktree)' : ''}` : ''}${w.branch ? `, branch ${w.branch}` : ''}${w.pr ? `, PR ${w.pr.url}` : ''}${w.warnings?.length ? ` [Warning: ${w.warnings.join('; ')}]` : ''}`,
      ),
    ];
  }
  return [
    header,
    ...workers.map((w) =>
      [
        `  ${w.name} (${w.id})${w.floorName ? ` on ${w.floorName}` : ''}${w.lead ? ` [subagent of ${w.lead.name}]` : w.kind === 'shell' ? ' [shell]' : w.kind === 'cloud' ? ' [cloud]' : ''}, ${w.desk}, ${w.status}`,
        ...(w.task ? [`    Task: ${w.task}`] : []),
        ...(w.doing ? [`    Doing: ${w.doing}`] : []),
        ...(w.cwd ? [`    Directory: ${w.cwd}${w.sharedCheckout ? ' (shared checkout, no worktree)' : ''}`] : []),
        ...(w.branch ? [`    Branch: ${w.branch}${w.pr ? `, PR ${w.pr.url}` : ''}`] : w.pr ? [`    PR: ${w.pr.url}`] : []),
        ...(w.warnings?.length ? [`    Warning: ${w.warnings.join('; ')}`] : []),
      ].join('\n'),
    ),
  ];
}

function baseWorkerName(name: string): string {
  return name.replace(/ 🐚$/, '');
}

/**
 * Picks a worker name unique across all live workers in the building (and all workers on the same
 * floor), preferring names unused even by asleep workers on other floors before reusing an asleep name.
 */
export function pickUniqueWorkerName(pool: readonly string[], sameFloorNames: Iterable<string>, otherLiveNames: Iterable<string> = [], otherAllNames: Iterable<string> = []): string {
  const mustAvoid = new Set<string>();
  for (const name of sameFloorNames) {
    mustAvoid.add(name);
    mustAvoid.add(baseWorkerName(name));
  }
  for (const name of otherLiveNames) {
    mustAvoid.add(name);
    mustAvoid.add(baseWorkerName(name));
  }
  const preferAvoid = new Set(mustAvoid);
  for (const name of otherAllNames) {
    preferAvoid.add(name);
    preferAvoid.add(baseWorkerName(name));
  }
  const completelyFree = pool.find((n) => !preferAvoid.has(n));
  if (completelyFree) return completelyFree;
  const liveFree = pool.find((n) => !mustAvoid.has(n));
  if (liveFree) return liveFree;
  for (let k = 1; ; k++) {
    const candidate = `Worker ${k}`;
    if (!preferAvoid.has(candidate)) return candidate;
  }
}

export function pickUniqueForkName(sourceName: string, sameFloorNames: Iterable<string>, otherLiveNames: Iterable<string> = [], otherAllNames: Iterable<string> = []): string {
  const mustAvoid = new Set([...sameFloorNames, ...otherLiveNames]);
  const preferAvoid = new Set([...mustAvoid, ...otherAllNames]);
  const stem = `${sourceName} ⑂`;
  if (!preferAvoid.has(stem)) return stem;
  for (let n = 2; ; n++) {
    const candidate = `${stem} ${n}`;
    if (!preferAvoid.has(candidate)) return candidate;
  }
}

/**
 * Picks a free seat on this floor, avoiding seats occupied by live workers on other floors whenever
 * any cross-floor-unique seat remains available.
 */
export function pickUniqueSeat(choose: (taken: (id: string) => boolean) => DeskDef | undefined, occupiedHere: (id: string) => boolean, occupiedLiveElsewhere?: (id: string) => boolean): DeskDef | undefined {
  if (occupiedLiveElsewhere) {
    const unique = choose((id) => occupiedHere(id) || occupiedLiveElsewhere(id));
    if (unique) return unique;
  }
  return choose(occupiedHere);
}

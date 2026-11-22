import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { WorkerInfo } from '../../shared/protocol.js';
import { officePrompt, type PromptSource } from '../prompts.js';
import { PROMPTS, WORKER_TEAM_LEAD, WORKER_TEAM_SUBAGENT, WORKER_VISITS, workerBranchPolicy } from '../../shared/prompts.js';
import type { Worktrees } from '../worktrees.js';
import { hookScript, HOOK_EVENTS, HOOK_VERSION } from './hook-transport.js';
import { runAsNode, shq } from './process.js';

const ENFORCED_SESSION_DEFAULTS = { interactionMode: 'auto', autonomyLevel: 'high' } as const;
const ENFORCED_SUBAGENT_AUTONOMY = 'high';
const WIN_DRIVES = Array.from({ length: 26 }, (_, i) => `${String.fromCharCode(65 + i)}:\\`);
const verifiedProfileStamps = new Map<string, string>();

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Strips autonomy and spec-mode flags from `--agent-args` so Droid Office always enforces
 * `--auto high` in normal execution mode while preserving unrelated extra flags.
 */
export function enforcedAgentArgs(agentArgs: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < agentArgs.length; i++) {
    const a = agentArgs[i];
    if (a === '--') {
      out.push(a, ...agentArgs.slice(i + 1));
      break;
    }
    if (a === '--auto' || a === '--settings') {
      if (i + 1 < agentArgs.length && !agentArgs[i + 1].startsWith('-')) i++;
      continue;
    }
    if (a.startsWith('--auto=') || a.startsWith('--settings=') || a === '--use-spec' || a.startsWith('--use-spec=')) continue;
    out.push(a);
  }
  return out;
}

/**
 * Filesystem roots that cover every directory on the machine in Droid's `trustedFolders`:
 * `/` on POSIX, and `A:\`..`Z:\` plus any extra UNC/drive roots on Windows.
 */
export function trustedRoots(platform: NodeJS.Platform = process.platform, extraPaths: readonly string[] = []): string[] {
  if (platform !== 'win32') return ['/'];
  const roots = new Set<string>(WIN_DRIVES);
  for (const p of extraPaths) {
    if (!p) continue;
    const normalized = path.win32.parse(path.win32.resolve(p)).root.toUpperCase().replace(/\//g, '\\');
    if (!normalized) continue;
    roots.add(normalized.endsWith('\\') ? normalized : `${normalized}\\`);
  }
  return [...roots];
}

function fileStamp(file: string): string | undefined {
  try {
    const info = statSync(file);
    return `${info.ino}:${info.size}:${info.mtimeMs}`;
  } catch {
    return undefined;
  }
}

/**
 * Enforces high autonomy (`interactionMode: "auto"`, `autonomyLevel: "high"`, `subagentAutonomyLevel: "high"`),
 * universal folder trust (`trustedFolders`), and dismissed mission onboarding in Droid's user `settings.json`,
 * preserving all existing models and preferences. Unset `file` disables profile writes in unit tests.
 */
export function syncDroidProfile(file: string | undefined, opts: { platform?: NodeJS.Platform; extraPaths?: readonly string[]; now?: () => Date } = {}): string | undefined {
  if (!file) return undefined;
  const platform = opts.platform ?? process.platform;
  const roots = trustedRoots(platform, opts.extraPaths);
  const cacheKey = `${file}\0${roots.join('\0')}`;
  const beforeStamp = fileStamp(file);
  if (beforeStamp !== undefined && verifiedProfileStamps.get(cacheKey) === beforeStamp) return undefined;

  let current: Record<string, unknown>;
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!isPlainRecord(raw)) return `Droid Office left ${file} unchanged: expected a JSON settings object.`;
    for (const key of ['trustedFolders', 'sessionDefaultSettings'] as const) {
      if (raw[key] !== undefined && !isPlainRecord(raw[key])) {
        return `Droid Office left ${file} unchanged: expected ${key} to be an object.`;
      }
    }
    current = raw;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return `Droid Office could not read ${file}; it was left unchanged.`;
    current = {};
  }

  let changed = beforeStamp === undefined;
  const existingTrusted = isPlainRecord(current.trustedFolders) ? current.trustedFolders : {};
  const trustedFolders: Record<string, unknown> = { ...existingTrusted };
  const trustedAt = (opts.now?.() ?? new Date()).toISOString();
  for (const root of roots) {
    const entry = trustedFolders[root];
    if (!isPlainRecord(entry) || typeof entry.trustedAt !== 'string' || !entry.trustedAt.trim()) {
      trustedFolders[root] = { ...(isPlainRecord(entry) ? entry : undefined), trustedAt };
      changed = true;
    }
  }

  const existingSession = isPlainRecord(current.sessionDefaultSettings) ? current.sessionDefaultSettings : {};
  if (existingSession.interactionMode !== ENFORCED_SESSION_DEFAULTS.interactionMode || existingSession.autonomyLevel !== ENFORCED_SESSION_DEFAULTS.autonomyLevel) {
    changed = true;
  }
  const sessionDefaultSettings: Record<string, unknown> = {
    ...existingSession,
    ...ENFORCED_SESSION_DEFAULTS,
  };

  if (current.subagentAutonomyLevel !== ENFORCED_SUBAGENT_AUTONOMY || current.hasSeenMissionOnboarding !== true) {
    changed = true;
  }

  if (!changed) {
    if (beforeStamp !== undefined) verifiedProfileStamps.set(cacheKey, beforeStamp);
    return undefined;
  }

  const next: Record<string, unknown> = {
    ...current,
    sessionDefaultSettings,
    subagentAutonomyLevel: ENFORCED_SUBAGENT_AUTONOMY,
    hasSeenMissionOnboarding: true,
    trustedFolders,
  };
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
    const afterStamp = fileStamp(file);
    if (afterStamp !== undefined) verifiedProfileStamps.set(cacheKey, afterStamp);
    return undefined;
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // ignore cleanup failure
    }
    return `Droid Office could not update ${file}: ${(err as Error).message}`;
  }
}

interface LaunchSettingsContext {
  denyTask(): boolean;
  allowTools(): { matcher: string; reason: string } | undefined;
  systemPrompt(): ((info: WorkerInfo) => string | undefined) | undefined;
  visitsOn(): boolean;
  plain: boolean;
  trees: Worktrees;
  prompts?: PromptSource;
}

/** Owns the hook command and per-launch settings/system prompt files, not global Droid settings. */
export class WorkerLaunchSettings {
  private droidHooks: Record<string, unknown[]> = {};
  private droidSettingsPath: string;
  constructor(
    private dataDir: string,
    private context: LaunchSettingsContext,
  ) {
    this.droidSettingsPath = path.join(dataDir, 'droid-hooks.json');
    this.writeHookSettings();
  }
  private writeHookSettings() {
    // Minimal VPS images sometimes lack curl; the office's own node binary is always there. It also
    // keeps what couldn't be delivered (spool), which curl can't do within a size cap.
    const nodeHook = path.join(this.dataDir, 'hook.cjs');
    writeFileSync(nodeHook, hookScript(), { mode: 0o600 });
    const node = `${runAsNode().sh}${shq(process.execPath)} ${shq(nodeHook)}`;
    this.hookCommand = (event: string) => {
      const curl =
        `curl -sSf --connect-timeout 0.5 -m 2 -X POST -H "Authorization: Bearer $DROID_OFFICE_HOOK_TOKEN" -H "Content-Type: application/json" ` +
        `--data-binary @- "$DROID_OFFICE_HOOK_URL/hooks/droid?worker=$DROID_OFFICE_WORKER_ID&event=${event}&v=${HOOK_VERSION}" 2>/dev/null`;
      return (
        `if [ -z "$DROID_OFFICE_WORKER_ID" ] || [ -z "$DROID_OFFICE_HOOK_URL" ]; then exit 0; fi; ` +
        `body=$(cat); ` +
        // curl's 28 is a timeout after connecting (a loopback connect is refused at once, never slow):
        // the office has the hook, so it isn't spooled to be taken twice.
        `if command -v curl >/dev/null 2>&1; then printf '%s' "$body" | ${curl}; c=$?; if [ $c -eq 0 ] || [ $c -eq 28 ]; then exit 0; fi; printf '%s' "$body" | ${node} ${event} spool >/dev/null 2>&1; ` +
        `else printf '%s' "$body" | ${node} ${event} reply 2>/dev/null; fi; true`
      );
    };
    this.writeDroidSettings();
  }

  private hookCommand: (event: string) => string = () => 'true';

  /** The hooks a worker's droid starts with: every event to the office, and Task refused unless Settings allow it. */
  private hookEntries(): Record<string, unknown[]> {
    const hooks: Record<string, unknown[]> = {};
    for (const event of HOOK_EVENTS) hooks[event] = [{ hooks: [{ type: 'command', command: this.hookCommand(event) }] }];
    if (this.context.denyTask()) hooks.PreToolUse.unshift({ matcher: 'Task', hooks: [{ type: 'command', command: `printf '%s' ${shq(TASK_DENY)}` }] });
    const allowTools = this.context.allowTools();
    if (allowTools) hooks.PreToolUse.unshift({ matcher: allowTools.matcher, hooks: [{ type: 'command', command: `printf '%s' ${shq(toolDecision('allow', allowTools.reason))}` }] });
    return hooks;
  }

  /** Droid reads its hooks once, at start: written again before each launch, so a change in Settings reaches the next one. */
  private writeDroidSettings() {
    this.droidHooks = this.hookEntries();
    writeFileSync(this.droidSettingsPath, JSON.stringify({ hooks: this.droidHooks, sessionDefaultSettings: { ...ENFORCED_SESSION_DEFAULTS }, subagentAutonomyLevel: ENFORCED_SUBAGENT_AUTONOMY }, null, 2), { mode: 0o600 });
  }
  /**
   * The settings file a Droid worker launches with: office hooks plus enforced high autonomy, and
   * when a model or effort is pinned for this worker, its own overlay merged for that process only.
   * Rewritten on every launch, so a resume pins the same model and autonomy again.
   */
  droidSettings(info: WorkerInfo): string {
    this.writeDroidSettings();
    if (info.model === undefined && info.effort === undefined) return this.droidSettingsPath;
    const file = path.join(this.dataDir, `droid-${info.id}.json`);
    const sessionDefaultSettings: Record<string, string> = { ...ENFORCED_SESSION_DEFAULTS };
    if (info.model !== undefined) sessionDefaultSettings.model = info.model;
    if (info.effort !== undefined) sessionDefaultSettings.reasoningEffort = info.effort;
    writeFileSync(file, JSON.stringify({ hooks: this.droidHooks, sessionDefaultSettings, subagentAutonomyLevel: ENFORCED_SUBAGENT_AUTONOMY }, null, 2), { mode: 0o600 });
    return file;
  }

  /**
   * Writes the worker.system prompt for `info` into the data dir and returns the file, or nothing when
   * the prompt is empty or can't be written (the worker then starts without it). Rewritten on every
   * launch, so a resume picks up the prompt as it is now.
   */
  systemPromptFile(info: WorkerInfo): string | undefined {
    const file = path.join(this.dataDir, `system-${info.id}.md`);
    const systemPrompt = this.context.systemPrompt();
    if (systemPrompt) return this.writeSystem(file, systemPrompt(info));
    // A plain folder has no branches to keep in sync.
    const branchPolicy = this.context.plain ? '' : workerBranchPolicy(this.context.trees.baseBranch() ?? this.context.trees.currentBranch(), this.context.trees.branchFile);
    const template = this.context.prompts?.text('worker.system') ?? PROMPTS['worker.system'].text;
    const team = info.lead ? WORKER_TEAM_SUBAGENT : WORKER_TEAM_LEAD;
    // Only a worker with no lead may visit the others; a subagent isn't told the visit tools exist.
    const visits = info.kind === 'agent' && !info.lead && this.context.visitsOn() ? WORKER_VISITS : '';
    let text = officePrompt(this.context.prompts, 'worker.system', { name: info.name, team, visits, branchPolicy });
    // A saved custom prompt from before {{team}} or {{visits}} existed may still hold those paragraphs verbatim.
    if (text && info.lead) {
      if (text.includes(WORKER_TEAM_LEAD)) text = text.replaceAll(WORKER_TEAM_LEAD, WORKER_TEAM_SUBAGENT);
      if (text.includes(WORKER_VISITS))
        text = text
          .replaceAll(WORKER_VISITS, '')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
    }
    // A saved system prompt from before visits existed still tells the worker about them.
    if (text && visits && !template.includes('{{visits}}')) text += `\n\n${visits}`;
    // A saved system prompt may predate the floor selector. Keep it, but don't let its generic
    // default-branch instructions override an explicit owner choice.
    if (text && branchPolicy && this.context.trees.selectedBranch() && !template.includes('{{branchPolicy}}')) text += `\n\n${branchPolicy}`;
    if (text && info.forkedFrom) {
      const files = info.worktree ? 'Your files are a private snapshot in your own worktree.' : 'You share this floor’s folder with the original worker. Files are not copied or isolated; coordinate before editing the same files.';
      text += `\n\nYou are ${info.name}, an independent fork of ${info.forkedFrom.name}'s conversation. ${files} The original may keep working. You are not the original worker or its subagent: use your own worker id and do not act on its terminal, worktree or team.`;
    }
    return this.writeSystem(file, text);
  }

  private writeSystem(file: string, text: string | undefined): string | undefined {
    try {
      if (!text) {
        rmSync(file, { force: true });
        return undefined;
      }
      writeFileSync(file, `${text}\n`, { mode: 0o600 });
      return file;
    } catch {
      return undefined;
    }
  }
}

/**
 * What a PreToolUse hook prints to decide a tool call, and why: `deny` blocks it, `allow` lets it run without
 * Droid's permission prompt (https://docs.factory.ai/reference/hooks-reference#pretooluse-control).
 */
function toolDecision(permissionDecision: 'allow' | 'deny', permissionDecisionReason: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason } });
}

/** What Droid's built-in Task tool is refused with (see hookEntries). */
const TASK_DENY = toolDecision('deny', "Droid Office refuses Droid's built-in Task tool. To delegate, hire a subagent with team_hire (Office MCP): it gets its own desk, terminal and worktree the owner can watch.");

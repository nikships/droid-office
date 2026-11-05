import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ClientMsg } from '../../shared/protocol.js';
import { AUTO_DESK, GH_COMMENT_MAX, GH_LABEL_MAX } from '../../shared/protocol.js';
import { PROMPT_IDS, PROMPT_MAX } from '../../shared/prompts.js';
import type { OfficeMcpServer } from './index.js';
import { officeError } from './index.js';
import { findWorker, pickFloor, remoteOnly, ownerResult, type OwnerAction, type OwnerOffice } from './owner.js';
import { choice, cloud, decor, effort, floorRef, id, images, labelSettings, menu, model, provider, repo, subagentSettings, text, workerRef } from './owner-schemas.js';

type Input<A extends OwnerAction> = Omit<Extract<ClientMsg, { t: A }>, 't' | 'request' | 'requestId' | 'requestFloor' | 'floor'> & { floor?: string };
type Scope = 'global' | 'floor' | 'worker' | 'targetFloor';
type Effect = 'read' | 'write' | 'delete';

/**
 * Every entry is a separate MCP tool, not a model-facing action dispatcher. Its schema is checked
 * against the wire message at compile time; the bridge still applies the owner's runtime checks.
 */
function tool<A extends OwnerAction>(action: A, name: string, description: string, inputSchema: z.ZodObject & z.ZodType<Input<NoInfer<A>>>, scope: Scope, effect: Effect = 'write', external = false) {
  return {
    action,
    name,
    description,
    inputSchema,
    scope,
    annotations: { readOnlyHint: effect === 'read', destructiveHint: effect === 'delete', idempotentHint: effect === 'read', openWorldHint: external },
  };
}

const floor = { floor: floorRef.optional() };
const worker = { workerId: workerRef, ...floor };
const number = z.number().int().positive();
const kind = z.enum(['issue', 'pull']).describe('Issue or pull/merge request.');
const label = z.string().min(1).max(GH_LABEL_MAX);
const on = z.boolean().describe('True enables this setting; false disables it.');
const data = z
  .string()
  .min(1)
  .max(64 * 1024)
  .describe('Literal terminal input, including control characters. Include \\r to press Enter. This can execute commands or answer permission prompts.');

function proxyTool(name: string, operation: 'install' | 'start' | 'open', description: string) {
  const entry = tool('subscriptions.proxy', name, description, z.strictObject({ action: z.literal(operation) }), 'global', operation === 'install' ? 'delete' : 'write', operation === 'install');
  return { ...entry, inputSchema: z.strictObject({}), fixed: { action: operation } };
}

export const OWNER_TOOLS = [
  tool(
    'floor.reorder',
    'office_floor_reorder',
    'Move a floor before another in elevator order, or to the end. Does not move its workers or files.',
    z.strictObject({ floor: floorRef, before: floorRef.nullable().describe('Floor to place this one before; null puts it last.') }),
    'targetFloor',
  ),
  tool(
    'floor.repos',
    'office_repositories_list',
    'List local checkouts eligible to become office floors. Does not clone or add them.',
    z.strictObject({ refresh: z.boolean().optional().describe('Rescan the workspace instead of using its cached list.') }),
    'global',
    'read',
  ),
  tool(
    'floor.folders',
    'office_folders_list',
    'List subfolders on the office machine, with checkout and eligibility information.',
    z.strictObject({ dir: z.string().min(1).max(1024).optional().describe('Absolute folder path; omit for the workspace folder.') }),
    'global',
    'read',
  ),
  tool('floor.branches', 'office_floor_branches', 'List the selected floor’s local/origin branches and its current and default base.', z.strictObject({ ...floor }), 'targetFloor', 'read'),
  tool(
    'floor.branch',
    'office_floor_branch_set',
    'Safely change the selected floor’s worker base branch. Existing work or workers can prevent switching.',
    z.strictObject({ ...floor, branch: id.nullable().describe('Existing local or origin branch; null restores the repository default.') }),
    'targetFloor',
  ),
  tool(
    'floor.add',
    'office_floor_add',
    'Add an existing folder as a floor. Git checkouts must be in the workspace; plain folders may be elsewhere. Does not clone or move files.',
    z.strictObject({ dir: z.string().min(1).max(1024).describe('Absolute existing folder on the office machine.') }),
    'global',
  ),
  tool('floor.remove', 'office_floor_remove', 'Remove a floor from the building. Its folder stays on disk and external desks are rehomed. Home cannot be removed.', z.strictObject({ floor: floorRef }), 'targetFloor', 'delete'),
  tool(
    'floor.projectsDir',
    'office_workspace_set',
    'Change where the office searches for repositories. This is an office-wide setting.',
    z.strictObject({ dir: z.string().max(1024).describe('Absolute workspace folder; empty string restores the default.') }),
    'global',
  ),
  tool(
    'worker.spawn',
    'office_worker_spawn',
    'Hire an independent worker, shell or cloud worker on a floor. For a subagent that reports to you, use team_hire instead. Cloud hires can incur charges.',
    z
      .strictObject({
        ...floor,
        deskId: id.max(32).default(AUTO_DESK).describe(`Seat id, or ${AUTO_DESK} for the first free seat.`),
        prompt: text.optional(),
        worktree: z.boolean().optional().describe('Use an isolated Git worktree for a local agent.'),
        kind: z.enum(['agent', 'shell', 'cloud']).default('agent'),
        model: model.optional(),
        effort: effort.optional(),
        issue: number.optional().describe('Issue to assign to this worker on the floor’s forge.'),
        repos: z.array(id).optional().describe('Additional open repository floor ids for a multi-repository worker.'),
        images: images.optional(),
        cloud: cloud.optional().describe('Required for kind cloud; choose a Factory computer or environment.'),
      })
      .refine((a) => (a.kind === 'cloud') === (a.cloud !== undefined), 'Supply cloud exactly when kind is cloud.'),
    'floor',
    'write',
    true,
  ),
  tool(
    'worker.fork',
    'office_worker_fork',
    'Fork an idle or done worker’s conversation and work into a new worker. Git floors copy committed and uncommitted work into a new worktree; plain floors share files.',
    z.strictObject({ ...worker, prompt: text.optional() }),
    'worker',
  ),
  tool('worker.resume', 'office_worker_resume', 'Resume an existing stopped or sleeping worker’s saved session.', z.strictObject({ ...worker }), 'worker'),
  tool(
    'worker.shoot',
    'office_worker_shoot',
    'Apply the office’s shot effect to a worker. A fully charged superShot dismisses it and deletes owned worktrees and branches, including unpushed work. Prefer office_send_home with cleanup keep for ordinary dismissal.',
    z.strictObject({ ...worker, superShot: z.boolean().default(false).describe('True requests destructive charged-shot dismissal. Use only when the owner explicitly requested it.') }),
    'worker',
    'delete',
  ),
  tool('worker.worktree', 'office_worker_worktree', 'Inspect any worker’s worktree, including uncommitted files and commits on no remote. Does not modify it.', z.strictObject({ ...worker }), 'worker', 'read'),
  tool(
    'worker.rebuild',
    'office_worker_rebuild',
    'Recreate a lost worker’s worktree and restart it from its recoverable branch.',
    z.strictObject({ ...worker, all: z.boolean().default(false).describe('True rebuilds every lost worker on this worker’s floor, not just the named worker.') }),
    'worker',
  ),
  tool(
    'worker.prompt',
    'office_worker_prompt',
    'Send a prompt to any worker as the owner. Use team_message for your own subagents and visit_message for peer coordination. This is not raw terminal input.',
    z.strictObject({ ...worker, prompt: text.min(1), issue: number.optional(), images: images.optional(), queue: z.boolean().default(false).describe('Queue behind the current turn using Ctrl+Enter instead of sending immediately.') }),
    'worker',
    'write',
    true,
  ),
  tool(
    'worker.answer',
    'office_worker_answer',
    'Answer a worker’s currently displayed menu as the owner. Supply its exact menu snapshot; changed menus are refused. Unlike question_answer, this is owner-level terminal control.',
    z
      .strictObject({
        ...worker,
        menu,
        choice: number.optional().describe('One displayed option number; not with choices or text.'),
        choices: z.array(number).optional().describe('Complete set of checkbox option numbers; may accompany text.'),
        text: text.optional().describe('Typed answer, optionally accompanying checkbox choices.'),
      })
      .refine((a) => (a.choice !== undefined ? a.choices === undefined && a.text === undefined : a.choices !== undefined || a.text !== undefined), 'Send one choice, checkbox choices, or text; do not combine choice with the others.'),
    'worker',
    'delete',
  ),
  tool('worker.pr', 'office_worker_pr_create', 'Push a worker’s branch and create a pull/merge request drafted from its task. Publishes to the floor’s forge.', z.strictObject({ ...worker }), 'worker', 'write', true),
  tool('worker.interrupt', 'office_worker_interrupt', 'Interrupt any worker’s current turn without dismissing it. Sends Escape locally or interrupts its Factory session.', z.strictObject({ ...worker }), 'worker', 'delete', true),
  tool(
    'thread.read',
    'office_worker_thread',
    'Read one page of any local or cloud agent’s conversation. Does not attach or type into its terminal. Returns a bounded snapshot and pagination information.',
    z.strictObject({ ...worker, before: z.number().int().nonnegative().optional().describe('Exclusive entry sequence for older history; omit for the newest page.') }),
    'worker',
    'read',
    true,
  ),
  tool(
    'term.input',
    'office_terminal_write',
    'Send raw input to any worker’s terminal as the owner. Can run commands, interrupt work or approve prompts. Prefer office_worker_prompt for normal instructions.',
    z.strictObject({ ...worker, data }),
    'worker',
    'delete',
    true,
  ),
  tool(
    'station.open',
    'office_station_open',
    'Start or wake a floor’s board agent and return its worker id. Does not open a terminal stream for this bot.',
    z.strictObject({ ...floor, deskId: id.max(32).describe('Board station id, such as station-lead, station-issues, station-pulls or station-actions.') }),
    'floor',
  ),
  tool(
    'station.prompt',
    'office_station_prompt',
    'Send a prompt to a board agent, hiring or waking it if needed. Model and effort only apply when hiring.',
    z.strictObject({ ...floor, deskId: id.max(32), prompt: text.min(1), model: model.optional(), effort: effort.optional(), images: images.optional() }),
    'floor',
  ),
  tool(
    'shell.input',
    'office_shell_write',
    'Send raw input to the selected floor’s boss shell as the owner. May execute arbitrary commands. Read it first with office_look name office-shell.',
    z.strictObject({ ...floor, data }),
    'floor',
    'delete',
    true,
  ),
  tool('gh.refresh', 'office_forge_refresh', 'Refresh the selected floor’s issue and pull/merge request boards from its forge.', z.strictObject({ ...floor }), 'floor', 'read', true),
  tool(
    'gh.merge',
    'office_pull_merge',
    'Merge a pull/merge request on the selected floor’s forge, or enable automatic merging. This changes the remote repository.',
    z.strictObject({
      ...floor,
      number,
      method: z.enum(['squash', 'merge', 'rebase']),
      deleteBranch: z.boolean().default(false).describe('Delete the remote source branch after merging.'),
      auto: z.boolean().default(false).describe('Enable automatic merge when required checks pass instead of merging immediately.'),
    }),
    'floor',
    'delete',
    true,
  ),
  tool(
    'gh.comment',
    'office_forge_comment',
    'Post a comment on an issue or pull/merge request using the owner’s forge account.',
    z.strictObject({ ...floor, kind, number, body: z.string().min(1).max(GH_COMMENT_MAX) }),
    'floor',
    'write',
    true,
  ),
  tool(
    'gh.close',
    'office_forge_close',
    'Close an issue or close a pull/merge request without merging it. Optional comment is posted publicly to that repository.',
    z.strictObject({
      ...floor,
      kind,
      number,
      comment: z.string().max(20_000).optional(),
      reason: z.enum(['completed', 'not planned']).optional().describe('Issue closing reason.'),
      deleteBranch: z.boolean().default(false).describe('Also delete the pull/merge request’s remote source branch.'),
    }),
    'floor',
    'delete',
    true,
  ),
  tool(
    'gh.labels',
    'office_forge_labels',
    'Add and remove labels on an issue or pull/merge request using the owner’s forge account.',
    z.strictObject({ ...floor, kind, number, add: z.array(label).default([]), remove: z.array(label).default([]) }),
    'floor',
    'write',
    true,
  ),
  tool('gong', 'office_gong_ring', 'Ring the gong on the selected floor.', z.strictObject({ ...floor }), 'floor'),
  tool('pipelines.refresh', 'office_pipelines_refresh', 'Refresh the floor’s GitHub Actions runs or GitLab pipelines.', z.strictObject({ ...floor }), 'floor', 'read', true),
  tool('pipelines.detail', 'office_pipeline_detail', 'Read a pipeline or workflow run’s jobs and steps.', z.strictObject({ ...floor, id: number }), 'floor', 'read', true),
  tool(
    'pipelines.rerun',
    'office_pipeline_rerun',
    'Rerun a completed workflow or pipeline. Can incur CI costs.',
    z.strictObject({ ...floor, id: number, failed: z.boolean().describe('True reruns failed jobs only; false reruns the whole run.') }),
    'floor',
    'write',
    true,
  ),
  tool('pipelines.cancel', 'office_pipeline_cancel', 'Cancel a queued or running workflow/pipeline.', z.strictObject({ ...floor, id: number }), 'floor', 'delete', true),
  tool(
    'pipelines.run',
    'office_pipeline_run',
    'Start a workflow or pipeline on a Git ref. Can execute deployment workflows and incur CI costs.',
    z.strictObject({
      ...floor,
      workflow: id.max(200).describe('GitHub workflow id/name; use pipeline on GitLab.'),
      ref: id.max(255).describe('Branch or tag to run.'),
      inputs: z
        .record(z.string().regex(/^[\w.-]{1,100}$/), z.string().max(2000))
        .refine((value) => Object.keys(value).length <= 50, 'At most 50 workflow inputs.')
        .optional()
        .describe('Workflow inputs, or GitLab pipeline variables, as string values.'),
    }),
    'floor',
    'write',
    true,
  ),
  tool('leaveOnMerge.set', 'office_leave_on_merge_set', 'Set office-wide automatic dismissal after a worker’s PR merges. Enabled cleanup deletes its worktree and branch after it rests.', z.strictObject({ on }), 'global', 'delete'),
  tool('freshMain.set', 'office_fresh_main_set', 'Set whether fresh workers start from the latest default branch or the checkout’s current branch.', z.strictObject({ on }), 'global'),
  tool('autoHeal.set', 'office_auto_heal_set', 'Set whether a failed pipeline wakes this floor’s Pipeline agent to diagnose it and hire a fix worker.', z.strictObject({ ...floor, on }), 'floor'),
  tool(
    'models.hide',
    'office_model_visibility_set',
    'Hide or show a model in every device’s picker. Does not block model use or alter workers.',
    z.strictObject({ id: id.nullable().describe('Exact model id; null with hidden false shows all models.'), hidden: z.boolean() }).refine((a) => a.id !== null || !a.hidden, 'A null id only supports hidden false.'),
    'global',
  ),
  tool('workerLabels.set', 'office_worker_labels_set', 'Replace the office-wide worker-label generation settings. Custom label scripts execute as the owner.', z.strictObject({ settings: labelSettings }), 'global', 'delete', true),
  tool(
    'subagents.set',
    'office_subagents_set',
    'Replace the office-wide Subagents settings. Setting officeMcp false immediately cuts off this bot’s access. External bots retain owner-level hiring while MCP is enabled.',
    z.strictObject({ settings: subagentSettings }),
    'global',
    'delete',
  ),
  tool(
    'prompts.set',
    'office_prompt_set',
    'Replace one office-authored prompt, or restore its default. Affects future uses of that prompt.',
    z.strictObject({ id: z.enum(PROMPT_IDS), text: z.string().max(PROMPT_MAX).nullable().describe('Replacement prompt; null restores the default.') }),
    'global',
  ),
  tool('prompts.agent', 'office_default_agent_set', 'Set the default model and effort for newly hired workers; null restores the office’s configured agent.', z.strictObject({ choice: choice.nullable() }), 'global'),
  tool('worktreeSetup.get', 'office_worktree_setup_get', 'Read how new worktrees on the selected floor are prepared.', z.strictObject({ ...floor }), 'floor', 'read'),
  tool(
    'worktreeSetup.set',
    'office_worktree_setup_set',
    'Replace this floor’s worktree setup command and copied files. The command runs as the owner in future worktrees.',
    z.strictObject({
      ...floor,
      setup: z
        .strictObject({
          setup: z.string().max(2000).describe('Shell setup command; empty means no command.'),
          copy: z.array(z.string().trim().min(1).max(300)).max(50).describe('Repository-relative ignored files or folders to copy into new worktrees.'),
        })
        .nullable()
        .describe('Null restores repository-defined or detected setup.'),
    }),
    'floor',
    'delete',
    true,
  ),
  tool(
    'machine.limit',
    'office_worker_limit_set',
    'Set the building-wide worker capacity. The startup ceiling still applies.',
    z.strictObject({ limit: z.number().int().positive().nullable().describe('Maximum workers, or null to remove the user-set limit.') }),
    'global',
  ),
  tool(
    'jira.connect',
    'office_jira_connect',
    'Replace the office’s Jira Cloud connection. Sends the provided credential to that Jira site.',
    z.strictObject({ site: z.string().min(1).max(300).describe('Jira Cloud site hostname or URL.'), email: z.email().max(254), token: z.string().min(1).max(2000).describe('Owner-authorized Jira API token.') }),
    'global',
    'delete',
    true,
  ),
  tool('jira.disconnect', 'office_jira_disconnect', 'Forget the office’s Jira connection.', z.strictObject({}), 'global', 'delete'),
  tool('jira.epic', 'office_jira_epic_set', 'Choose the Jira epic shown on this floor.', z.strictObject({ ...floor, key: z.string().max(40).describe('Epic key; empty string removes the selected epic.') }), 'floor', 'write', true),
  tool('jira.refresh', 'office_jira_refresh', 'Refresh the selected floor’s Jira tab.', z.strictObject({ ...floor }), 'floor', 'read', true),
  tool(
    'factory.connect',
    'office_factory_connect',
    'Replace the office’s Factory connection with an owner-authorized API key.',
    z.strictObject({ key: z.string().min(1).max(600).describe('Factory API key. Do not put it in progress notes or artifacts.') }),
    'global',
    'delete',
    true,
  ),
  tool('factory.disconnect', 'office_factory_disconnect', 'Forget the office’s Factory key and the data read with it.', z.strictObject({}), 'global', 'delete'),
  tool(
    'factory.refresh',
    'office_factory_refresh',
    'Refresh one Factory feature, or recheck the key and refresh all features.',
    z.strictObject({ feature: z.enum(['computers', 'environments', 'sessions', 'ci', 'wiki', 'cloud']).optional() }),
    'global',
    'read',
    true,
  ),
  tool('setup.check', 'office_setup_check', 'Recheck Droid installation/sign-in and DroidProxy status.', z.strictObject({}), 'global', 'read', true),
  tool('setup.droid.install', 'office_droid_install', 'Install or update Droid on the office machine. Downloads and runs the installer.', z.strictObject({}), 'global', 'delete', true),
  tool('setup.droid.signIn', 'office_droid_sign_in', 'Start Droid’s Factory sign-in on the office machine. The owner may need to complete browser/device-code authorization.', z.strictObject({}), 'global', 'write', true),
  tool('setup.droid.signInCancel', 'office_droid_sign_in_cancel', 'Cancel a pending Droid sign-in.', z.strictObject({}), 'global', 'delete'),
  tool('setup.onboarded', 'office_onboarding_set', 'Mark the welcome as completed, or request that it be shown again.', z.strictObject({ done: z.boolean().describe('True marks onboarding complete; false shows it again.') }), 'global'),
  proxyTool('office_proxy_install', 'install', 'Install or update DroidProxy on the office machine.'),
  proxyTool('office_proxy_start', 'start', 'Start the installed DroidProxy service.'),
  proxyTool('office_proxy_open', 'open', 'Open DroidProxy’s own settings window on the office machine.'),
  tool('subscriptions.connect', 'office_subscription_connect', 'Start connecting a subscription account. Opens browser sign-in or device-code authorization for the owner.', z.strictObject({ provider }), 'global', 'write', true),
  tool('subscriptions.connectCancel', 'office_subscription_connect_cancel', 'Cancel a pending subscription-provider sign-in.', z.strictObject({ provider }), 'global', 'delete'),
  tool('subscriptions.disconnect', 'office_subscription_disconnect', 'Forget one connected subscription account.', z.strictObject({ provider, account: id.describe('Exact account id from the subscription state.') }), 'global', 'delete'),
  tool('subscriptions.provider', 'office_subscription_provider_set', 'Enable or disable the models supplied by one subscription provider.', z.strictObject({ provider, enabled: z.boolean() }), 'global'),
  tool('subscriptions.models', 'office_subscription_models_sync', 'Replace DroidProxy-managed model entries in Droid’s settings with the current catalogue.', z.strictObject({}), 'global'),
  tool('subscriptions.refresh', 'office_subscriptions_refresh', 'Recheck DroidProxy and subscription accounts.', z.strictObject({}), 'global', 'read', true),
  tool(
    'changes.diff',
    'office_changes_diff',
    'Read one changed file’s diff from any worker’s checkout. Unlike worker_diff, this is one file and may target workers outside your team.',
    z.strictObject({ ...worker, path: z.string().min(1).max(4096).describe('Repository-relative changed file path.'), repo }),
    'worker',
    'read',
  ),
  tool(
    'changes.commit',
    'office_changes_commit',
    'Commit the changes in a worker’s checkout with the supplied message.',
    z.strictObject({ ...worker, message: z.string().trim().min(1).max(5000).describe('Commit message.'), repo }),
    'worker',
  ),
  tool(
    'changes.discard',
    'office_changes_discard',
    'Permanently discard uncommitted changes in a worker’s checkout. Omit path only when the owner explicitly asked to discard all changes.',
    z.strictObject({ ...worker, path: z.string().min(1).max(4096).optional().describe('Repository-relative file; omit to discard every uncommitted change.'), repo }),
    'worker',
    'delete',
  ),
  tool(
    'changes.pr',
    'office_changes_pr_create',
    'Push a worker’s changes and open a pull/merge request with an explicit title and description.',
    z.strictObject({ ...worker, title: z.string().trim().min(1).max(300), body: z.string().max(20_000), repo }),
    'worker',
    'write',
    true,
  ),
  tool('upgrade.check', 'office_upgrade_check', 'Check for a source-office upgrade. Packaged Mac app updates use a separate mechanism.', z.strictObject({}), 'global', 'read', true),
  tool('upgrade.start', 'office_upgrade_start', 'Start an available source-office upgrade, build and restart. This can interrupt the office and this MCP connection.', z.strictObject({}), 'global', 'delete', true),
  tool('decor.add', 'office_picture_add', 'Hang an image on a wall of the selected floor.', z.strictObject({ ...floor, decor }), 'floor', 'write', true),
  tool(
    'decor.update',
    'office_picture_update',
    'Change an existing wall picture’s placement, frame, title or image.',
    z.strictObject({ ...floor, id: id.max(32), decor: decor.partial().refine((a) => Object.keys(a).length > 0, 'Supply at least one picture field.') }),
    'floor',
    'write',
    true,
  ),
  tool('decor.remove', 'office_picture_remove', 'Remove a wall picture from the selected floor.', z.strictObject({ ...floor, id: id.max(32) }), 'floor', 'delete'),
  tool(
    'jukebox.play',
    'office_jukebox_play',
    'Play a built-in tune or an audio stream; with neither, resume the office jukebox.',
    z.strictObject({ track: id.optional().describe('Built-in tune id.'), url: z.url().optional().describe('HTTP(S) audio-stream URL.') }).refine((a) => !a.track || !a.url, 'Choose track or url, not both.'),
    'global',
    'write',
    true,
  ),
  tool('jukebox.skip', 'office_jukebox_skip', 'Skip to the next jukebox tune.', z.strictObject({}), 'global'),
  tool('jukebox.stop', 'office_jukebox_stop', 'Stop the office jukebox.', z.strictObject({}), 'global'),
  tool('whiteboard.ping', 'office_whiteboard_ping', 'Ask any worker to read its floor’s Whiteboard. Does not modify cards or send an arbitrary prompt.', z.strictObject({ worker: workerRef, ...floor }), 'worker'),
] as const;

export function registerOwnerTools(server: OfficeMcpServer, owner: OwnerOffice): void {
  for (const entry of OWNER_TOOLS) {
    server.tool(entry, remoteOnly, async (input, caller, signal) => {
      const args: Record<string, unknown> = { ...input, ...('fixed' in entry ? entry.fixed : {}) };
      const ref = typeof args.floor === 'string' ? args.floor : undefined;
      delete args.floor;
      let floor: string | undefined;
      if (entry.scope === 'worker') {
        const key = entry.action === 'whiteboard.ping' ? 'worker' : 'workerId';
        const found = findWorker(owner.floors(), String(args[key]), ref);
        if (typeof found === 'string') return officeError(found);
        args[key] = found.worker.id;
        floor = found.floor.id;
      } else if (entry.scope !== 'global') {
        const picked = pickFloor(owner.floors(), ref ?? caller.floor.id);
        if (typeof picked === 'string') return officeError(picked);
        floor = picked.floor.id;
      }
      if (entry.scope === 'targetFloor') args.floor = floor;
      if (entry.action === 'floor.reorder' && typeof args.before === 'string') {
        const before = pickFloor(owner.floors(), args.before);
        if (typeof before === 'string') return officeError(before);
        args.before = before.floor.id;
      }
      if (entry.action === 'thread.read' || entry.action === 'floor.branches' || entry.action === 'floor.branch') args.request = randomUUID();
      if (signal.aborted) return officeError('Cancelled before taking the action.');
      const result = await owner.act(caller.worker, { ...args, t: entry.action }, { floor, signal });
      return ownerResult(entry.name, result);
    });
  }
}

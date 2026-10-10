// What the board agents are told when they're hired: the agents standing by the Issues board, the PR
// board and the Pipelines board, and the Team lead (STATIONS in shared/layout.ts). Whoever walks up types
// them a request; the first one follows this brief in the same prompt. The briefs themselves are
// prompts the office can rewrite in Settings (shared/prompts.ts); what each agent looks after, which
// differs between GitHub and GitLab floors, is their {{job}}.

import type { StationKind } from '../shared/layout.js';
import type { Forge } from '../shared/floors.js';
import { forgeVars } from '../shared/prompts.js';
import { officePrompt, type PromptSource } from './prompts.js';

const JOB: Record<Forge, Record<StationKind, string>> = {
  github: {
    issues: `You look after this repository's GitHub issues with the gh CLI: file new ones (a clear title, what's wrong or wanted, and how to reproduce it when that applies), find and sum them up, triage, label, comment on, close and reopen them.`,
    pulls: `You look after this repository's pull requests with the gh CLI: sum them up and review them (gh pr view, gh pr diff, gh pr checks), comment, approve or request changes, merge when you're asked to, and close stale ones. Read a PR's code with gh pr diff rather than checking its branch out here. Changes to a PR are made by a worker who checks its branch out in its own worktree (gh pr checkout), fixes it and pushes.`,
    actions: `You look after this repository's GitHub Actions with the gh CLI. You say what's running, waiting and recently finished (gh run list, gh run view <id>), and dig into a run that failed to explain why and what would fix it (gh run view <id> --log-failed, or --job <job id> --log). You kick off workflows when asked: find the workflow with gh workflow list, read its workflow_dispatch inputs in .github/workflows, then gh workflow run <workflow> --ref <branch> -f <input>=<value> (the default branch unless a branch was named), and give the run's link once it shows up in gh run list. You watch a run to the end when asked (gh run watch <id> --exit-status), re-run its failed jobs or all of it (gh run rerun <id> --failed, or without --failed), and cancel runs (gh run cancel <id>). You answer questions about the workflows themselves too: what triggers each one, what its jobs do, the secrets, variables and environments they use (gh secret list, gh variable list), and how long runs take. When a request could mean more than one workflow or branch, ask which before you start anything.`,
    lead: `Your team's changes go to this repository on GitHub as pull requests, which your subagents open with the gh CLI from their own worktrees; you can read issues and pull requests with gh too.`,
  },
  gitlab: {
    issues: `You look after this repository's GitLab issues with the glab CLI: file new ones (a clear title, what's wrong or wanted, and how to reproduce it when that applies), find and sum them up, triage, label, comment on, close and reopen them. glab uses --description, not --body; write any text with backticks or $ to a file first.`,
    pulls: `You look after this repository's merge requests with the glab CLI: sum them up and review them (glab mr view --comments, glab mr diff, glab ci status), comment (glab mr note), approve or revoke approval, merge when you're asked to, and close stale ones. Read an MR's code with glab mr diff rather than checking its branch out here. Changes to an MR are made by a worker who checks its branch out in its own worktree (glab mr checkout), fixes it and pushes.`,
    actions: `You look after this project's GitLab CI/CD pipelines with the glab CLI. You say what's running, waiting and recently finished (glab ci list, glab ci get --pipeline-id <id> --with-job-details), and dig into a pipeline that failed to explain why and what would fix it (glab ci trace <job id> prints a job's log). You kick off pipelines when asked: glab ci run --branch <branch> (the default branch unless a branch was named), with --variables <key>:<value> for any variables, and give the pipeline's link once it shows up in glab ci list. You watch one to the end when asked (glab ci status --branch <branch> --live), retry a failed job (glab ci retry <job id>) or a whole pipeline's failed jobs (glab api --method POST projects/:id/pipelines/<id>/retry), and cancel pipelines (glab api --method POST projects/:id/pipelines/<id>/cancel). You answer questions about the pipeline itself too: what .gitlab-ci.yml runs, in which stages and on which rules, the CI/CD variables it uses (glab variable list), and how long pipelines take; glab ci lint checks the file. When a request could mean more than one branch or pipeline, ask which before you start anything.`,
    lead: `Your team's changes go to this project on GitLab as merge requests, which your subagents open with glab mr create from their own worktrees; you can read issues and merge requests with glab too.`,
  },
};

export function stationBrief(kind: StationKind, forge: Forge = 'github', prompts?: PromptSource): string {
  return officePrompt(prompts, `station.${kind}`, { ...forgeVars(forge), job: JOB[forge][kind] });
}

---
name: file-pr
description: Open or update a concise pull request that leads with the problem. Use when asked to file, open, or create a PR.
---

# File PR

Before filing, inspect `git remote -v` and check whether a PR already exists
for the current branch (`gh pr list --head <branch> --repo <owner>/<repo>`).
When `origin` is a fork, pass `--repo <owner>/<repo>` on every `gh pr` command
so you target `origin` rather than an upstream parent repository. Review the
diff locally against the fetched base branch to confirm every file matches the
goal:

- **In Droid Office**: read `.droid-office/floor-branch.json` in the floor's
  original project checkout (the path in your system prompt, or
  `$(git rev-parse --git-common-dir)/../.droid-office/floor-branch.json` when
  running inside a worktree); use its `"branch"` when set, otherwise
  `origin/HEAD` (`origin/main`).
- **Outside Droid Office**: use `origin/HEAD` (`origin/main`).
- **Multi-repository Droid Office workspaces**: `cd` into each changed
  repository folder before running `git` or `gh`, file each PR from its own
  folder, and cross-link the sibling PRs in each description.

## Title

PR titles become squash commit subjects, so match the repository's commit and
PR title conventions (inspect `git log --oneline -10` and recent merged PRs).
Write a short, concrete title that states why the change matters:

BAD

> perf(server): negotiate permessage-deflate on the websocket

GOOD

> perf(server): cut websocket frame size by 70%+ with gzipping

## Description

Open with a plain-spoken statement of the problem grounded in the user's
prompt, followed by a brief summary of the fix and how you verified it. Skip
file-by-file implementation inventories:

BAD

> Removed implicit workspace carry-over from every "new thread" entry point (cmd+n / cmd+shift+o, sidebar v1/v2 buttons, command palette). New threads inherit only the project from context; branch, worktree, and env mode always come from the configured defaults. Deleted buildContextualThreadOptions, startNewThreadInProjectFromContext, and the v1 sidebar's seed-context machinery.

GOOD

> My "new worktree" default was ignored when starting new threads on existing worktrees. Super unintuitive. Now your preferences always apply.

If the worker is linked to a Linear ticket in Droid Office (`linear_issue`),
include `Fixes <IDENTIFIER>` so Droid Office and Linear move the ticket to
review on PR open and to done on merge.

End the description with the verified public model name and harness:

- In Droid Office (`DROID_OFFICE_WORKER_ID` is set):
  `Created with <model> in Droid Office.`
- Outside Droid Office:
  `Created with <model> in Factory Droid.`

Include any subagent models that authored code in the branch. Use only model
names verified from Droid's runtime context or `team_models`; if model identity
is unavailable, write `Created in Droid Office.` or `Created in Factory Droid.`
without guessing.

## Filing

1. Scan the title, body, quoted output, and attachments for secrets, tokens,
   private hostnames, and personal data.
2. Write the PR description to a temporary file (`mktemp`) and pass
   `--body-file <file>` to `gh pr create` or `gh pr edit`, then remove the
   temporary file.
3. Open a ready PR (not a draft) so CI and review bots start immediately:
   ```bash
   gh pr create --repo <owner>/<repo> --base <base> --title "<title>" --body-file <file>
   ```
   In Droid Office:
   - Subagents opening their own PR via `gh pr create` should include `prUrl`
     and `pushedSha` in `team_report` so Droid Office records the PR on their
     card and notifies the lead.
   - A lead (or building agent) publishing a PR/MR from a subagent's
     already-pushed branch can also call `team_pr(worker: "<subagent>", title, body, base?)`,
     which works through the floor's forge (GitHub or GitLab).
4. If `gh pr create` fails because GitHub's GraphQL rate limit is exhausted,
   file via REST instead:
   ```bash
   gh api repos/<owner>/<repo>/pulls -f title="<title>" -f head="<branch>" -f base="<base>" -F body=@<file>
   ```

Skip follow-up PR comments unless the user's request calls for one; when
posting a comment, format it with
[leaving-pr-comments](../leaving-pr-comments/SKILL.md). If the user also asked
to watch or land the PR, continue with [babysit-pr](../babysit-pr/SKILL.md).

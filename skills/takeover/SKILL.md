---
name: takeover
description: Finish someone else's pull request, branch, or agent session while preserving contributor credit. Use when asked to take over existing work.
---

# Takeover

Take ownership of finishing the original goal while preserving every original
contributor's credit. Evaluate inherited code critically instead of defending
mistakes just because another person or agent wrote it first.

## 1. Reconstruct the handoff

Locate and inspect the full context before editing:

- **Pull request or branch**: read the PR description, commits, full diff,
  inline review threads, CI failures, and the user's later steering
  (`gh pr view`, `gh api`). Check `git remote -v` and pass `--repo <owner>/<repo>`
  on forks.
- **Droid Office worker or subagent**:
  - **Subagent or dismissed subagent**: inspect structured state first with
    `worker_log(worker: ..., tail: 0)`, then read `worker_diff` and
    `team_report_get` (and `worker_log` with terminal lines only when needed).
    Branch from its committed state via `team_hire(from: "worker:<name>")` (or
    its absolute worktree path, which also works on dismissed-but-kept
    subagents) when delegating, or inspect its worktree path directly to
    account for any uncommitted or untracked files — `from` pins committed HEAD
    only.
  - **Independent floor worker**: list active desks and paths with
    `visit_roster` (or `office_roster` from Mission Control), then read its
    state with `visit_look` (or `office_look(..., lines: 0)` and
    `office_worker_thread` from Mission Control).
  - **Forked worker**: if your system prompt marks you as a fork of another
    worker, you already hold a private snapshot; never mutate the original
    worker's terminal, team, or worktree.
  - **Linear ticket**: if the inherited work belongs to a Linear ticket, inspect
    `linear_issue` and link/update it (`linear_start` / `linear_comment`) so
    ticket tracking stays current.
- **Standalone Droid session**: find and inspect prior session history with
  `droid search "<query>" --json` (or fork interactively with
  `droid --fork <session-id>`).

Resolve the handoff to exact commits, branches, and any uncommitted work. Treat
prior status reports as context to verify, never as proof.

## 2. Continuation branch and contributor credit

- **Replacement PR**: cherry-pick or branch from the original commits onto a
  fresh branch (in a clean worktree when the current checkout is shared or
  dirty) and add your fixes as separate commits. Switch to in-place or stacked
  updates only when the user explicitly asked for them. Leave the source PR and
  unrelated files untouched unless authorized.
- **Credit**: preserve original Git commit authors and existing `Co-Authored-By:`
  trailers. Credit original contributors and link the source PR in the PR
  description. When a repo squash-merges, carry verified human `Co-Authored-By:`
  trailers into the squash commit message using real identities from Git
  history, never guessed emails. Model attribution (`Created with ...`) is
  separate from and never replaces human contributor credit.

## 3. Modernize, simplify, and prove

Run [modernize](../modernize/SKILL.md) to align the branch with the current base
branch and architecture. Rework whatever is needed to satisfy the original goal
cleanly, cutting accidental complexity without dropping intended behavior.
Re-check the source PR before shipping in case new commits or review notes
landed while you worked.

Verify the fix directly: reproduce the original bug when applicable, run the
repository's CI gates (lint, typecheck, tests), and exercise real UI or runtime
paths rather than trusting mocked tests alone. State explicitly anything you
could not verify.

## 4. Ship and report

When the requested finish includes a PR:

1. File or update it with [file-pr](../file-pr/SKILL.md) (`--body-file`).
2. Watch CI and review bots through [babysit-pr](../babysit-pr/SKILL.md) rather
   than stopping at PR creation.
3. Format any PR comments or thread replies with
   [leaving-pr-comments](../leaving-pr-comments/SKILL.md).
4. Merge or close the superseded PR only when explicitly authorized.

Finish by reporting what you inherited, what you changed, how you proved it,
how contributor credit was preserved, and any remaining decision for the user.

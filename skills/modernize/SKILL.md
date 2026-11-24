---
name: modernize
description: Rebase an older pull request onto its current base and decide whether it still belongs. Use when asked to modernize or rebase a stale PR.
---

# Modernize

Modernize the idea, not just the branch. A clean Git rebase does not prove that
an older pull request still belongs in the codebase.

## Guardrails

- Fetch the latest `origin` refs for the PR's base branch, head branch, and
  related branches before evaluating anything. Check `git remote -v` and pass
  `--repo <owner>/<repo>` explicitly when `origin` is a fork.
- Protect active checkouts and user work:
  - **In Droid Office**: read `.droid-office/floor-branch.json` in the floor's
    original project checkout (not inside a worktree) and never switch or dirty
    a shared floor checkout. Work in your assigned task worktree if it already
    owns the PR branch, or create a disposable `git worktree add` inside a temp
    directory (`mktemp -d`, never inside `.droid-office/worktrees/`, which Droid
    Office manages for worker seats) and remove it with `git worktree remove`
    before finishing. Leads delegating modernization can also use
    `team_hire(task: { ..., prNumber, baseBranch })` for a managed worktree.
  - **In standalone Droid**: create a temporary `git worktree add` whenever the
    current checkout is dirty or checked out to another task, and remove it
    when done.
- Modernizing authorizes rebasing and updating the PR branch only. Leave
  merging, closing, retargeting the base branch, and scope expansion to
  explicit user instruction.
- Push rebased commits exclusively with
  `--force-with-lease=<branch>:<observed-head-sha>`. Never run an unqualified
  `--force`.
- Skip PR comments unless the user asked for one; format any requested comment
  with [leaving-pr-comments](../leaving-pr-comments/SKILL.md) via `--body-file`.

## 1. Establish the PR's intent

Resolve the PR (`gh pr view <n> --repo <owner>/<repo> --json ...`) and record
its URL, state, base branch, head repository and branch, head SHA, author,
checks, and review threads. Read the title, description, linked issues, commit
messages, review threads, and full diff. State the smallest coherent problem
the PR set out to solve before judging its code.

Fetch the remote base and PR head, and record `git merge-base` so you can
inspect the PR's changes and subsequent base-branch changes separately.

## 2. Check what changed around it

Inspect commits and diffs landed on the base branch since the PR diverged, and
search recent merged and open PRs (`gh pr list --state all --search ...`) when
paths or behavior suggest a replacement.

Look past textual conflicts for conceptual drift:

- Has the user-facing problem already been solved another way?
- Did APIs, types, schemas, dependencies, or module boundaries move?
- Do both the base branch and the PR now claim ownership of the same invariant?
- Was the touched subsystem deleted, consolidated, or intentionally simplified?
- Would landing this PR revive retired behavior or introduce two competing paths?
- Does the remaining benefit still outweigh its maintenance surface?

## 3. Choose a disposition before pushing

Pick one disposition grounded in observed evidence:

- **`MODERNIZE`**: the goal remains valuable and the approach still fits current
  architecture. Rebase, resolve conflicts, verify, and update the branch.
- **`REWORK`**: the goal remains valuable, but a mechanical rebase preserves the
  wrong design. Outline the smallest clean rewrite and stop before pushing
  unless the user also asked for that rework (or ask via `AskUser` /
  `team_report(question: true)`).
- **`CLOSE`**: the PR is superseded, obsolete, or no longer worth landing. Cite
  the exact commits or PRs that replace or invalidate it and stop without
  rebasing or closing the PR unless closure was explicitly authorized.

## 4. Rebase without losing intent (`MODERNIZE`)

1. Check out a disposable local worktree (`mktemp -d`) at the recorded PR head
   SHA.
2. Rebase onto the freshly fetched `origin/<base>`.
3. Resolve conflicts using the PR's goal and the base branch's current
   invariants. If a conflict exposes a product or architectural contradiction,
   abort the rebase and reclassify as `REWORK` or `CLOSE` instead of guessing.
4. Run `git range-diff <old-base>...<old-head> <new-base>...HEAD` and inspect
   the full `git diff <new-base>...HEAD` to confirm intentional behavior survived
   and retired base-branch code stayed gone.
5. Run the repository's covering checks (typecheck, lint, focused tests),
   separating regressions from pre-existing or environment issues.
6. Push with `git push --force-with-lease=<branch>:<old-head-sha> origin HEAD:<branch>`.
   If the lease rejects the push, fetch and inspect the new remote commits
   rather than overwriting them.
7. Remove any temporary worktree you created (`git worktree remove`).

## 5. Report

Lead with `MODERNIZE`, `REWORK`, or `CLOSE` and a one-sentence reason, then
cover:

- Base-branch changes that affect the PR
- Conceptual conflicts found (or confirmation that none exist)
- Rebase, `range-diff`, and `--force-with-lease` outcome (when `MODERNIZE`)
- Checks run and results, separating verified facts from judgment
- Remaining decisions or next steps, linking the PR

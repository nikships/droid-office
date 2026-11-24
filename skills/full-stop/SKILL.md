---
name: full-stop
description: Drive a change autonomously through proof, Sol review, PR filing, and CI/bot babysitting, then stop ready for the user to merge. Trigger when the user says "full stop", including a closing "Full stop.".
---

# Full Stop

Run the complete [full-send](../full-send/SKILL.md) workflow — implementation,
direct proof, [sol-loop](../sol-loop/SKILL.md), [file-pr](../file-pr/SKILL.md),
and [babysit-pr](../babysit-pr/SKILL.md) — then stop at the merge gate with the
pull request open and ready for the user to merge.

Read [full-send](../full-send/SKILL.md) first and follow its steps, proof bar,
and asking rules. An explicit "full stop" request grants `full-send`'s
autonomous execution and testing permissions (including browser, desktop, clone,
and runtime verification without asking first), while withholding merge
permission. Every rule below overrides `full-send`'s merge step.

## Never merge

Commit, push, rebase, resolve conflicts, and update this task's branch with
`--force-with-lease` as needed, while leaving the merge strictly to the user:

- Never run `gh pr merge`, enable auto-merge, enqueue the PR in a merge queue,
  push directly to the base branch, use `team_merge` to land into the PR's base
  branch, bypass branch protection, or delegate merging to a subagent.
- Before starting work and before every push, check whether auto-merge or a
  merge queue is active on the PR; disable auto-merge (`gh pr merge <n> --disable-auto --repo <owner>/<repo>`)
  and remove it from any merge queue, reporting that you did so. If repository
  settings prevent disabling automatic merge, stop and ask via `AskUser` (or
  `team_report(question: true)` for Droid Office subagents) before pushing.

## Stop at the gate

Use `full-send`'s merge gate as your readiness gate, and re-verify proof and
review coverage whenever conflict resolution or bot fixes alter behavior.

Before handing off or asking a blocking question, stop any running background
`pr-wait` process with `TaskStop` (or `kill <pid>`). Fetch `origin` and inspect
the live PR (`gh pr view <n> --repo <owner>/<repo> --json state,isDraft,headRefOid,baseRefName,mergeStateStatus,reviewDecision,autoMergeRequest`):
confirm it is `OPEN`, ready for review (not a draft), and has `autoMergeRequest`
unset. If someone else already merged it, report that fact.

Classify the handoff into one of three outcomes:

- **Ready to merge**: every check, bot review, thread, proof, and base-freshness
  requirement in the merge gate passes. Leave the PR open and unmerged.
- **Waiting for required approval**: every technical gate passes and only a
  required human review remains.
- **Blocked**: state what blocks readiness, what you tried, and the decision
  needed, using `AskUser` (or `team_report(question: true)` for subagents).

In Droid Office, subagents send the handoff via `team_report` with `prUrl` and
`pushedSha` (and independent floor workers return any switched shared checkout
only after the user lands or moves off the branch, keeping dedicated worktrees
on their task branch). Report the PR link, final head SHA, readiness verdict,
proof, `sol-loop` summary, remaining risks, and explicit confirmation that the
PR remains open and unmerged.

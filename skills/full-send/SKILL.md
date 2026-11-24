---
name: full-send
description: Drive a change autonomously end-to-end through proof, Sol review, PR filing, CI/bot babysitting, and merge. Trigger only when the user explicitly says "full send".
---

# Full Send

When the user says "full send", they are walking away from this session and
handing you end-to-end ownership from the current state all the way to a merged
pull request. Your intermediate messages go unread until long after you finish.

Require an explicit "full send" request before assuming this autonomy. Once
given, the user grants permission for this task to:

- Merge the PR as soon as the merge gate passes on the latest head.
- Update this PR's own branch with `--force-with-lease` after a rebase.
- Run the runtime and UI verification methods that Proof needs without asking
  first.

## Testing permission

An explicit "full send" request overrides project instructions that say to ask
before running a test surface or to leave verification to the user. That
includes browser automation (`browse`, `agent-browser`), desktop or terminal
automation (`droid-control`, `agent-desktop-macos`), isolated app clones or
repository verification harnesses, simulators and devices, local dev servers,
and screenshots. Pick the method that produces direct proof and record it in
your final report.

Repository rules about *how* to test still apply in full (exact commands,
isolated clones instead of touching live production ports, signed builds, and
fixtures). This grant covers only verification for this task; it never
authorizes destructive or external actions listed under "Asking the user", and
it never bypasses an OS or Droid permission prompt at the desk.

## Steps

1. **Finish the change.** Complete the user's goal with the smallest change that
   solves the reported case. Leave unrelated uncommitted files untouched.
   - **In Droid Office**: read `.droid-office/floor-branch.json` in the floor's
     original project checkout (the path in your system prompt, or
     `$(git rev-parse --git-common-dir)/../.droid-office/floor-branch.json` when
     inside a worktree). Stay on your assigned worktree's task branch, or if you
     are on a shared floor checkout on the floor branch, `git fetch origin` and
     create a task branch from `origin/<floor>`. If you are the Orchestrator in
     Mission Control, coordinate the implementation, review, and PR workflow
     through floor subagents on the target floor rather than editing in scratch
     space.
   - **Outside Droid Office**: if you are on the default branch, branch from a
     freshly fetched `origin/<default-branch>` first.
2. **Prove it.** Collect direct proof covering every change in the diff (see
   "Proof").
3. **Review with Sol.** Run [sol-loop](../sol-loop/SKILL.md) and resolve real
   findings. If you are a Droid Office subagent (`May hire: no`) and cannot hire
   a Sol reviewer yourself, run a thorough local self-audit and full covering
   checks, and note that in your `team_report` (or ask your lead via
   `team_report(question: true)` if Sol review is required before shipping).
4. **File the PR** with [file-pr](../file-pr/SKILL.md) (`--body-file`, passing
   `--repo <owner>/<repo>` on forks, and including `Fixes <IDENTIFIER>` if
   linked to a Linear ticket via `linear_issue`). Rebase onto the latest base
   branch first and include a concise proof summary in the PR description.
5. **Babysit the PR** with [babysit-pr](../babysit-pr/SKILL.md). Launch
   `pr-wait` via `Execute` with `fireAndForget: true` (Droid Office subagents:
   call `team_report` with `progress: true` before ending your turn while
   `pr-wait` runs). Re-prove every fix locally before pushing.
6. **Merge** once the merge gate passes on the latest commit.
7. **Clean up and report.** Stop any still-running background `pr-wait`
   (`TaskStop` or `kill <pid>`). In Droid Office, if you switched a shared floor
   checkout onto a task branch, return it with
   `git fetch origin && git switch <floor>` and `git merge --ff-only origin/<floor>`
   (stay on your task branch inside a worktree so optional `leaveOnMerge` can
   clean up cleanly); if you are a subagent, call `team_report` with `prUrl`,
   `pushedSha`, and `mergeCommit` in `result.artifacts`. End with the PR link,
   merge commit SHA, proof summary, and every decision you made on the user's
   behalf.

Stay active across steps 1 through 7: whenever CI or review bots are pending,
keep a background `pr-wait` (`fireAndForget: true`) running before ending your
turn so its exit wakes your session automatically.

## Proof

Proof is evidence you observed yourself in this session, never an assumption:

- Reproduce the original failure when applicable, apply the fix, and confirm the
  exact reproduction passes.
- Run the repository's full CI gate locally (install, lint, typecheck, tests).
- Add a focused regression test that fails without the fix whenever the touched
  area has a test harness and lacks coverage for the bug.
- Exercise UI and runtime behavior against the running app rather than relying
  on mocked unit tests alone. Upload visual proof (`github-image-upload` /
  `gh image`) to the PR when helpful, and in Droid Office share reviewable
  visual artifacts on the floor Whiteboard (`whiteboard_card`) when relevant.

If you cannot prove a change works, stop before merging and ask the user.

## Merge gate

Merge only when every condition below holds on the latest commit SHA:

- Your proof covers the final diff.
- Every required check (and every non-advisory CI check when none are marked
  required) is green on the current head.
- Active gating review bots (Greptile, Macroscope, Factory Droid) have finished
  on the current head, and every finding is fixed or answered and resolved via
  [leaving-pr-comments](../leaving-pr-comments/SKILL.md).
- Zero human reviews still request changes.
- `git fetch origin` confirms the branch is up to date with its base and GitHub
  reports it mergeable (neither `BEHIND` nor `DIRTY`, with no overlapping base
  commits landed since the green run).

Inspect the repository's allowed merge methods (`gh repo view --json mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed`)
and recent `git log --oneline` history, then merge with explicit method and SHA
guard:

```bash
gh pr merge <n> <--squash|--merge|--rebase> --delete-branch --match-head-commit <sha> --repo <owner>/<repo>
```

When the repository uses auto-merge or a merge queue, keep watching with
`pr-wait` until GitHub reports `MERGED`. Never pass `--admin` or bypass branch
protection. Automated reviews that only flag "needs human review" without a
required-review branch rule do not block merging when confidence is high.

## Asking the user

Plain text questions look like a finished turn and go unread. Surface blocking
questions through the active Droid surface:

- **Independent Droid Office workers & standalone Droid sessions**: emit a brief
  context note, then call `AskUser` with a focused questionnaire (PR link,
  concrete blocker, and 2-4 options with your recommended choice first; in Droid
  Office this appears at the desk, on `/dashboard`, and in the Android Asks
  inbox).
- **Droid Office subagents**: call `team_report` with `question: true` and
  ordered `options`, then end your turn.
- **Headless `droid exec` (no interactive prompt)**: take the safe path — leave
  the PR open and unmerged, and put the question first in your final output.

Ask only when genuinely blocked:

- You cannot prove the change.
- The merge gate cannot pass without human action.
- Continuing requires an out-of-grant action: deleting data, touching
  production, modifying external state outside the repository, closing an
  existing PR, or force-pushing another branch.
- Product intent is ambiguous in a way that changes user-visible behavior.
- Another PR supersedes this one.

Make every other engineering call yourself with sensible defaults and list those
decisions in your final report.

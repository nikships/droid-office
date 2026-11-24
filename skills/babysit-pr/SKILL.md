---
name: babysit-pr
description: Watch a GitHub pull request through CI and review bots and fix real findings. Use when asked to babysit, watch, or monitor a PR until green or ready.
---

# Babysit PR

Monitor one pull request through CI checks, review bots, and human reviews until
the latest head is ready to merge or hits a blocker you need the user to
resolve.

## Waiting with `pr-wait`

Run a single watcher per PR using `scripts/pr-wait` next to this `SKILL.md`
(when bundled by Droid Office, `~/.factory/skills/babysit-pr/scripts/pr-wait`).
Every watcher on a GitHub account shares one API rate limit, so avoid custom
`sleep` loops or `gh pr checks --watch` wrappers.

1. **Handle what is already on the PR first.** Inspect current check failures,
   comments, and unresolved review threads before starting a wait.
2. **Start `pr-wait` in the background** via `Execute` with
   `fireAndForget: true`:
   ```bash
   ~/.factory/skills/babysit-pr/scripts/pr-wait <pr> [--repo owner/name] [--until ready|green|any-change]
   ```
   (Use the actual path of `scripts/pr-wait` beside this `SKILL.md` if installed
   elsewhere.) Pass `--repo <owner>/<repo>` or the full PR URL explicitly when
   `origin` is a fork or you are working in a multi-repository Droid Office
   workspace. Save the returned background job `pid` / `task_id`.
3. **End your turn cleanly while `pr-wait` runs:**
   - **Droid Office subagents** (`office_whoami` shows `subagent of <lead>`):
     call `team_report` with `progress: true` naming the PR URL and head SHA you
     are watching, then end your turn. Your background job wakes you when
     `pr-wait` exits; send your final `team_report` (without `progress`) only
     after the task finishes.
   - **Independent Droid Office workers & standalone Droid sessions**: end your
     turn quietly without status narration ("still waiting"). Droid wakes your
     session automatically with `pr-wait`'s output when it exits.
4. **Ownership rule**: only the session that owns the PR runs `pr-wait`. Review
   delegates (`sol-loop`, `council`) never watch PRs, and Droid Office leads
   already receive subagent PR open/merge/close events through `team_status`
   and `team_watch`.
5. **Clean up before stopping early**: before handing off to the user, calling
   `AskUser`, or sending a final `team_report`, stop any still-running
   `pr-wait` job with `TaskStop` (or `kill <pid>`).

### `--until` modes and exit codes

- `ready` (default): required checks green, active gating review bots
  (Greptile, Macroscope, Factory Droid) finished on the current head when the
  repo uses them, no human `CHANGES_REQUESTED` on the current head, zero
  unresolved threads, and merge state neither `BEHIND` nor `DIRTY`.
- `green`: required checks green only.
- `any-change`: exit `0` on the first new event.

Exit `0` means the `--until` gate passed or the PR merged. Exit `1` means the
PR needs action (failed check, `DIRTY`, `BEHIND`, unresolved threads, changes
requested on the current head, or PR closed). Exit `2` means bad input or
another `pr-wait` PID already holds the per-PR lock.

Restart `pr-wait` after pushing a fix, after handling an exit `1`, and after
resuming a session. `pr-wait` persists seen events in `~/.local/state/pr-wait/`
so events between runs are still reported once.

## GitHub rate limits

`gh pr create`, `gh pr view`, `gh pr checks`, and `pr-wait` use GraphQL. When
GraphQL quota runs low (`gh api rate_limit --jq .resources.graphql`), fall back
to REST, which has its own bucket:

- PR state: `gh api repos/<owner>/<repo>/pulls/<n>`
- Checks: `gh api repos/<owner>/<repo>/commits/<sha>/check-runs`

## Triaging reviews and CI

Act only on checks and review comments targeting the current head or still
open. Verify every bot claim against the code before editing:

- Fix real bugs in the intended scope and prove each fix locally before pushing.
- Separate real test failures from runner or network flakes before re-running.
- If the repository contains `.macroscope/check-run-agents/*.md`, read those
  rules before answering a Macroscope finding.
- Treat CodeRabbit as advisory: inspect its findings, fix real bugs, and never
  hold readiness waiting on it.
- Reply with a clear reason and resolve threads for false positives or
  out-of-scope nits. Format every comment posted on the user's behalf with
  [leaving-pr-comments](../leaving-pr-comments/SKILL.md) using `--body-file`.
- Attach visual proof (`github-image-upload` / `gh image`, and `whiteboard_card`
  in Droid Office when helpful) when UI or runtime behavior changes.

Guard PR size across rounds. Review loops bloat diffs one "cheap" guard at a
time: decline extra edge-case scaffolding, speculative abstractions, and minor
micro-optimizations with a one-line reason, list them as follow-ups, and prefer
fixes that delete or narrow code.

## Base freshness and merging

Rebase onto a freshly fetched base branch (`--force-with-lease`) whenever
`pr-wait` reports `DIRTY`, `BEHIND`, or base commits touching this PR's files.
If another merged PR makes this PR obsolete, stop watching and ask the user via
`AskUser` (or `team_report(question: true)` for subagents) before closing it.

Stop when `pr-wait` exits `0`. Merge only when the user explicitly authorized
merging; otherwise report that the PR is ready. Immediately before an
authorized merge, run `git fetch origin`, re-verify the head SHA and merge
state, and pass `--match-head-commit <sha>` on `gh pr merge` so you never merge
a `BEHIND`, `DIRTY`, or unverified head.

Once merged in Droid Office, follow the floor branch policy: return a switched
shared floor checkout with `git fetch origin && git switch <floor>` (and
`git merge --ff-only origin/<floor>` when `origin` has it), or stay on your task
branch inside a dedicated worktree so optional auto-cleanup (`leaveOnMerge`) can
run safely once you finish.

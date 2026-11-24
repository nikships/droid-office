---
name: sol-loop
description: Run an adversarial code-review loop with OpenAI GPT Sol until both agents agree. Use when the user says "sol loop" or asks for a Sol review loop.
---

# Sol Loop

Run an adversarial code-review loop with OpenAI's GPT Sol before or after filing
a pull request, applying the smallest changes that make the diff genuinely
correct while pushing back against scope creep.

## Budget

- **Default**: 3 rounds total. Round 1 reviews the full scoped diff; Round 2+
  checks only changed code and open findings.
- **Extended (up to 5 rounds)**: only for security, permissions, auth, data
  loss, or concurrency/state changes while an evidence-backed `blocker` or
  `should` remains open, or when the user asks.
- **Early exit**: stop as soon as a round returns `APPROVE` or only nits.
  Declined nits and comment, doc, or formatting-only edits need no new round.
- **Single reviewer**: run one Sol reviewer at a time, and instruct it never to
  spawn subagents.
- **Ledger**: track stable finding IDs (`S1`, `S2`, ...), severity, outcome, and
  token/cost usage only when the runtime exposes it. Never guess usage.

## 1. Scope

Run `git -C "<abs-checkout>" status --short` (where `<abs-checkout>` is your
current checkout or worktree path). Preserve unrelated uncommitted changes
without stashing, discarding, or sweeping them into the diff. Scope the review
to the intended paths when they separate cleanly; otherwise stop and ask with
`AskUser` (or `team_report(question: true)` for Droid Office subagents).

Resolve the base commit after `git -C "<abs-checkout>" fetch origin`:

- **Existing PR**: `gh pr view <n> --repo <owner>/<repo> --json baseRefName,headRefOid`.
  Switch branches only when the working tree is clean and you are not on a
  shared Droid Office floor checkout. Confirm `HEAD` matches the PR head or is
  ahead only by this change. Base:
  `git -C "<abs-checkout>" merge-base HEAD origin/<baseRefName>`.
- **Local branch**: in Droid Office, read `.droid-office/floor-branch.json` in
  the floor's original project checkout (the path in your system prompt, or
  `$(git -C "<abs-checkout>" rev-parse --git-common-dir)/../.droid-office/floor-branch.json`)
  to find `<base>`; otherwise use `origin/HEAD` (`origin/main`). Base:
  `git -C "<abs-checkout>" merge-base HEAD origin/<base>` (or `HEAD` when no
  remote exists and only uncommitted changes are in scope).

Use one consistent diff command across every round
(`git -C "<abs-checkout>" diff <base> [-- <paths>]` plus
`git -C "<abs-checkout>" status --short` for untracked files in scope). Write a
1-2 sentence statement of intent and out-of-scope boundaries, and run covering
checks first so you never hand Sol broken code. Note pre-existing or missing
checks in the brief.

## 2. Start Sol

Never substitute a non-Sol model. If no Sol route can run, stop and report the
blocker. Keep scoped files untouched while Sol is reviewing, and never treat a
timeout, crash, or empty reply as approval.

### In Droid Office (`droid-office` MCP available)

1. Check `office_whoami` if your role is unknown. Subagents cannot hire
   (`May hire: no`): if you are a subagent, ask your lead via
   `team_report(question: true)` to run or hire the Sol review rather than
   calling CLI or `Task` subagents (Droid Office refuses `Task` by default).
2. Check `team_status` and dismiss any finished subagents first if you are at
   your per-lead limit.
3. Call `team_models(only: "available")` once. Pick the latest runnable GPT Sol
   model ID unless the user named a version, honoring `Owner's note`,
   `cannotRun`, cooldowns, Factory Standard / Droid Core windows and overage
   mode, and DroidProxy subscription quotas/pace (preferring a healthy
   zero-credit DroidProxy Sol route when available, otherwise native Factory
   Sol). If **Settings → Subagents & visits → Models leads can pick** excludes
   Sol or Subagents are disabled, stop and report that exact setting rather than
   substituting another model.
4. Call `team_hire` with `worktree: false` (omit `from`, `baseBranch`, and
   `branch`), `model: <sol-id>`, `effort: "high"` (unless the user asked for
   another effort), and the Round 1 brief below. Save the hired worker's
   name/ID.
   - **Important**: `worktree: false` starts the subagent in the floor's main
     checkout, not your private worktree, so always pass your exact absolute
     `<abs-checkout>` path in the brief and `git -C "<abs-checkout>"` commands.
   - **Orchestrator / building agents**: pass `floor` (or `task.repo`) on
     `team_hire` and point `<abs-checkout>` at the target floor or worker
     worktree path.
5. End your turn when `Wake the lead: on`, or call `team_wait` when wake notes
   are off. Never poll in a `sleep` loop. When woken, read the full review with
   `team_status` / `team_report_get`. If Sol hits a rate limit or cooldown on
   one route while another Sol route is healthy, switch it with `worker_model`
   (for example `droidproxy sol` or `Sol`) to keep its review session intact.

### In standalone Droid (`DROID_OFFICE_WORKER_ID` unset)

1. If `AGENTS.md` routes subagents through `rex-subagents` and `$REX_SESSION` is
   set, launch one read-only Sol pane via `rex-subagents` and reuse that pane
   for Round 2+.
2. Otherwise, if a read-only custom droid in `.factory/droids/` or
   `~/.factory/droids/` explicitly pins a runnable Sol `model:`, invoke it with
   `Task` and save `task_id` for `resume`.
3. Otherwise, inspect `droid exec --help` (and `~/.factory/settings.json` for
   configured `custom:*sol*` routes) to pick the latest runnable Sol ID, write
   the brief to a temp file, and run read-only `droid exec`:
   ```bash
   droid exec --cwd "<abs-checkout>" -m <sol-id> -r high -o json -f <brief-file>
   ```
   `droid exec` with no `--auto` flag enforces read-only mode while allowing
   `git diff`, `git status`, and file reads, and exits non-zero if `<sol-id>` is
   unavailable. Save `session_id` (and `usage` if returned) from the JSON
   output.

### Round 1 brief

```text
Review only. Do not edit, commit, push, comment on PRs, or spawn subagents.
Repo: <abs-checkout> Base: <sha> Intent: <intent> Out of scope: <scope> Checks: <results>
See: git -C "<abs-checkout>" diff <base> [-- <paths>]; git -C "<abs-checkout>" status --short (read untracked files in scope using absolute paths under <abs-checkout>).
Read surrounding code. Find real bugs, broken callers, and mismatches with intent.
Skip style unless it hides a bug. Hold to the smallest change. Flag extra code,
tests, or guards the intent does not need. Other paths, rare edge cases, minor
perf, extra compatibility: nits.
blocker = intended case wrong. should = real bug callers will hit, in intent. nit = rest.
In Droid Office, finish with team_report containing this exact format:
VERDICT: APPROVE or CHANGES
S1 [blocker|should|nit] <file>:<line> <claim>. Fix: <suggestion> (keep stable IDs)
```

## 3. Answer findings

Verify every claim and severity against the source yourself; reclassify other
paths, rare cases, and minor costs as `nit` regardless of the label Sol chose:

- **Agree**: make the smallest fix, preferring deletion or narrowing over new
  locks, caches, helpers, or options. Add one focused test that fails without
  the fix when the repository has tests for that surface.
- **Disagree**: state why with concrete evidence (`file:line`, test, command
  output).
- **Out of scope or nit**: decline in one line and record as a follow-up.

Update the ledger, re-run checks, and inspect
`git -C "<abs-checkout>" diff --shortstat <base>`. If fixes bloated the diff,
trim before continuing. Never concede a bogus finding just to exit the loop.

## 4. Next round

Run another round only when budget remains and either a `blocker`/`should` stays
open, behavior code changed, or no `APPROVE` covers the current behavior diff.

Send the follow-up brief (Round 1 context, the ledger with `fixed:` /
`disagree:` / `declined:` + evidence, the full `git -C "<abs-checkout>"` base
diff command, and the delta since last round) to the **same** Sol reviewer:

- **Droid Office**: `team_message(worker: <sol-worker>, text: ...)`
- **Custom droid**: `Task(resume: <task_id>, ...)`
- **`droid exec`**: `droid exec --cwd "<abs-checkout>" -s <session_id> -m <sol-id> -r high -o json -f <followup-file>`
- **Rex**: follow-up message in the Sol pane

Instruct Sol to inspect open IDs and changed code only, marking each prior ID
`resolved` or `still open: <reason>`. If the reviewer died or errored, dismiss
or stop it, confirm it exited, and start a fresh Sol seeded with the ledger.

## 5. Stop, clean up, and ship

In Droid Office, record `team_review` and `team_dismiss` on the Sol subagent as
soon as the loop ends.

- **Agreed**: `APPROVE` on the current behavior diff, zero open `blocker` or
  `should` items, and checks green.
- **Stuck**: a finding stays disputed after two replies, or the round budget
  ends. Budget exhaustion is not approval: summarize both sides in 2-3 lines
  each via `AskUser` (or `team_report(question: true)` for subagents) so the
  user decides.

Push only when the user asked to push, file, or ship. When updating or filing a
PR description (`--body-file`), add directly above the `Created with ...` line:

`Reviewed with sol-loop: <N> rounds with <model>. Sol verdict: approved`

Append `on <effort>` only when verified. Report the round count, model, what
Sol changed, diff stat before/after, fixed vs declined items with reasons,
verified usage (or state that usage was not exposed), and whether you pushed.

---
name: council
description: Convene three flagship models from distinct providers to review or advise in parallel until they converge. Use when the user says "council".
---

# Council

Before convening a council review, resolve outstanding PR comments, fix issues
you already know about, and run covering checks so delegates audit your best
implementation rather than known defects. Skip pre-fixes only when the user
wants to discard the current implementation and explore replacement designs.

## Roster

Convene three delegates from **three distinct model providers** at `high`
reasoning effort (or the highest effort a chosen model supports). Honor any
council roster or `non-blocking` markers in `AGENTS.md` or the user's prompt.
Otherwise pick the strongest runnable model from each of three separate
providers using the live model catalogue (`team_models` in Droid Office, or
`droid exec --help` outside Droid Office) rather than guessing stale model IDs.

If fewer than three providers are runnable, a named council member cannot run,
or Droid Office settings cap subagents below three, stop and report which model,
provider, or setting blocks the council instead of silently substituting or
shrinking the roster.

## Running the delegates

Give every delegate the user's goal, exact absolute repository/worktree path,
base SHA, intent, check results, and read-only review instructions (forbidding
file edits, commits, PR comments, and nested subagents). Always instruct
delegates to run `git -C "<abs-repo>" diff <base>` and
`git -C "<abs-repo>" status --short` against that exact path. For code reviews,
ask each delegate for a score out of 10.

### In Droid Office (`droid-office` MCP available)

1. Check `office_whoami` if your role is unknown. Subagents cannot hire
   (`May hire: no`): if you are a subagent, escalate via
   `team_report(question: true)` so your lead runs the council rather than
   invoking CLI or `Task` subagents (Droid Office refuses `Task` by default).
2. Check `team_status` and dismiss any finished subagents first so you have
   three free team slots under **Settings → Subagents & visits → Team size**.
3. Call `team_models(only: "available")` once. Pick exact runnable model IDs
   from three distinct `provider` families, honoring `Owner's note`,
   `cannotRun`, cooldowns, Factory Standard / Droid Core windows and overage
   mode, DroidProxy subscription quotas/pace, and benchmarks. Respect
   **Settings → Subagents & visits → Models leads can pick** if restricted.
4. Hire all three delegates in parallel via `team_hire` with `worktree: false`
   (omit `from`, `baseBranch`, and `branch`), explicit `model`, and
   `effort: "high"` (when supported).
   - **Important**: `worktree: false` starts subagents in the floor's main
     checkout, not your private worktree, so always pass your exact absolute
     checkout/worktree path (`pwd`) in the brief and tell delegates to use
     `git -C "<abs-checkout>"` and absolute file paths under it.
   - **Orchestrator / building agents**: pass `floor` (or `task.repo`) on each
     `team_hire` call and point delegates at the target checkout or worker
     worktree path.
   - Tell each delegate to return its review and `/10` score through
     `team_report`.
5. End your turn when `Wake the lead: on`, or call `team_wait` when wake notes
   are off. If a delegate hits a rate limit or cooldown mid-council and another
   healthy route exists for that same provider, switch it with `worker_model`
   instead of losing its review context.

### In standalone Droid (`DROID_OFFICE_WORKER_ID` unset)

1. If `AGENTS.md` routes subagents through `rex-subagents` and `$REX_SESSION` is
   set, open three read-only provider panes in parallel via `rex-subagents`.
2. Otherwise, if three read-only custom droids in `.factory/droids/` or
   `~/.factory/droids/` pin runnable models from three distinct providers,
   launch all three in one message via `Task` (saving each `task_id` for
   `resume`).
3. Otherwise, inspect `droid exec --help` to confirm runnable models across
   three providers, write the review brief to a temp file, and launch three
   parallel background `Execute` jobs (`fireAndForget: true`) running read-only
   `droid exec`:
   ```bash
   droid exec --cwd "<abs-repo>" -m <model-id> -r high -o json -f <brief-file>
   ```
   Save each returned `session_id` from JSON output for Round 2+ (`-s <session_id>`).

## Acting on results and iterating

Work incrementally as results arrive:

- When one delegate finishes (`team_status` / `team_report_get` in Droid Office,
  or background job wakeup in standalone Droid), verify its claims against the
  code immediately and plan your fixes while remaining blocking delegates run.
- Keep the reviewed checkout/worktree unedited while any delegate is still
  actively reviewing it.
- If the user's instructions mark a delegate as non-blocking, proceed as soon as
  all blocking delegates report; treat a late non-blocking reply as advisory
  feedback and omit its score from the table.

Once the round's active reviewers finish, synthesize agreements, disagreements,
and next steps. Fight scope creep: fix real bugs and design flaws within the
goal, push back on speculative bloat with evidence, re-run checks, and start a
fresh round (via `team_message(workers: [...])`, `Task(resume: ...)`, or
`droid exec -s <session_id>`) whenever you make behavior changes. Count each
full review pass as one round and loop until all blocking delegates agree.

In Droid Office, record `team_review` and `team_dismiss` on all three council
subagents as soon as the council concludes.

## Recording council scores

When the work produces or updates a pull request, edit the PR description via
`--body-file` (never post a separate PR comment for this) and place this
section directly above the `Created with ...` attribution line:

```markdown
## Council review

Rounds: 2

| Delegate | Round 1 | Round 2 |
| --- | --- | --- |
| Claude Opus 5.5 | 7/10 | 9/10 |
| GPT-6.1 Sol | 8/10 | 10/10 |
| Gemini 3.1 Pro | 7/10 | 9/10 |
```

Write `no score` when a delegate omits a score rather than inventing one. When
there is no PR, include the same table in your final reply (and in Droid Office,
optionally share an architectural council synthesis via `whiteboard_card` when
helpful).

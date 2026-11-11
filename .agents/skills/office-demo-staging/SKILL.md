---
name: office-demo-staging
description: Stage a busy Droid Office with real GitHub issues, worktree-isolated workers, and cued states (`working`, `needs_input`, confetti, PRs), then tear down every staged resource. Use only for owner-requested demos or demo cleanup.
---

# Staging a demo office

Populates an office from an active [`office-choreography`](../office-choreography/SKILL.md) session (`boot.sh` first) for live demos or [`office-video-capture`](../office-video-capture/SKILL.md) shoots, logging every created issue and worker to `$CAPTURE_DIR/stage.log` so `cleanup.sh` removes only staged items.

## Ground rules

- **Owner-requested demos only:** run tests, bug repros and PR proof on an unpopulated [`office-clone`](../office-clone/SKILL.md) instead. Confirm the target repository, issue count and cleanup plan with the owner before opening GitHub issues or hiring workers.
- **Worktree isolation:** `boot.sh` sets `droid-office.worktree=1` and `hire.sh` checks the worktree box (`hire.sh` aborts when a floor's checkout is detached unless `ALLOW_NO_WORKTREE=1` is set). Handing a carried issue card to a desk uses only the tab pref; if a worker ever starts in the owner's checkout by mistake, stop it, save `git diff > patch`, restore only the files it touched, switch back to the prior branch, and delete its branch.
- **Staged-worker scope:** prompt, film or dismiss only workers you staged (unless the owner approves touching theirs), and instruct staged workers to stay inside their worktree.

## 1. Open demo issues

```bash
D=.agents/skills/office-demo-staging/scripts
$D/demo-issues.sh nikships/droid-office .agents/skills/office-demo-staging/references/demo-issues.tsv
```

Each TSV row is `title<TAB>labels<TAB>body` using existing repo labels (`bug`, `enhancement`, `documentation`, `good first issue`); assign one or two (`gh issue edit N --add-assignee <owner>`) to render card avatars.

## 2. Hire workers at desks

```bash
$D/hire.sh desk-4 "Haiku 4.5" "Work on GitHub issue #160 in nikships/droid-office (read it with gh issue view 160). Implement it inside this worktree, run lint and relevant tests, then commit and open a pull request closing #160."
$D/hire.sh desk-1 "Opus 5.5"  "Work on GitHub issue #157 …"
```

Pick adjacent free desks (`office.list()`, `office.state().workers`) with distinct models so one camera angle shows varied desk badges. Space hires ~20s apart so worktree setup (`npm ci`) does not thrash; inspect dialog mismatches with `agent-browser snapshot -i`.

## 3. Cue states on camera

| Camera state | Trigger |
| --- | --- |
| Working, terminal scrolling | Fresh hire during its first minutes |
| Acting out tools | Read-only review prompt naming files and a test to run |
| `needs_input` jump | Append `"then ask me which option I prefer with AskUser"` |
| Done confetti | Send a `done` worker a one-line follow-up via `send.sh` (`working` → `done`) |
| PRs and CI on boards | Workers opening PRs populate Pull requests and Pipelines boards |

```bash
$D/send.sh Widget "Reply in one short sentence confirming PR #164 is ready."
$D/wait-status.sh Widget done 180 --via working        # short-eval shell poll; start recording before the flip
```

## 4. Tear down and verify

```bash
$D/cleanup.sh nikships/droid-office          # dry run: lists staged workers, PRs and issues
$D/cleanup.sh nikships/droid-office --yes    # kills workers (cleanup: 'all'), closes PRs (--delete-branch) and issues
```

(`send-home.sh <name>...` dismisses individual workers, including `needs_input`.)

Teardown is complete when `cleanup.sh --yes` finishes, `git worktree list` and `git branch --list 'office/*'` contain nothing newer than `stage.log`, `lsof -nP -iTCP -sTCP:LISTEN` shows no stray worker servers, `git status` in the main checkout is untouched, and `agent-browser close` has closed the capture tab (keep `stage.log` and move scripts).

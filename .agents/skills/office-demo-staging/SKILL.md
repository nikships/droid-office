---
name: office-demo-staging
description: Set up a believable, real Droid Office demo and tear it down afterwards. Opens demo GitHub issues, hires real droid workers in their own worktrees on chosen models, prompts them, waits for the states worth showing (working, acting out a tool, needs_input jump, done confetti, a pull request on the boards), and then closes exactly the issues, PRs, branches, worktrees and workers it made. Use before a live demo, a recording or screenshots that need a busy office, or whenever demo workers or issues need cleaning up.
---

# Staging a demo office

A demo looks best with real work in it: issues on the wall, workers at desks on different models, terminals scrolling, pull requests and CI on the boards. These scripts set that up from the [`office-choreography`](../office-choreography/SKILL.md) session (run its `boot.sh` first). They work the same for a live demo and for one you record with [`office-video-capture`](../office-video-capture/SKILL.md). They log everything they create to `$CAPTURE_DIR/stage.log`, so `cleanup.sh` can undo exactly that and nothing else.

## Ground rules

- **Only for a demo the owner asked for.** Tests, bug repros and pull-request proof never stage anything: they run on a clone of the owner's real office ([`office-clone`](../office-clone/SKILL.md)) and show what is really there.

- **Ask before you write to GitHub or the owner's office.** Opening issues and hiring workers are outside-world writes. Agree on the repository and how many issues, and agree to clean up afterwards.
- **Every hire gets a worktree.** `boot.sh` sets the tab's `droid-office.worktree` pref, and `hire.sh` ticks the dialog's worktree box. Handing a carried issue card to a desk hires at once with **only** the tab's pref. If you hire without the pref, the worker edits and branches in the owner's checkout. If that happens, stop the worker and save its diff (`git diff > patch`). Then restore only the files it touched, switch back to the branch the checkout was on, and delete the branch it made. Never touch changes that were there before.
- **Leave the owner's workers alone.** Don't prompt them, send them home, or film their terminals unless the owner says so. All the scripts take explicit names or desks.
- **Workers run real tools.** A worker may start servers, run tests or push. Tell workers to stay inside their worktree. Afterwards, check that nothing is left listening that a worker started (`lsof -nP -iTCP -sTCP:LISTEN`), and tell the owner about any surprises.

## 1. Issues on the wall

```bash
D=.agents/skills/office-demo-staging/scripts
$D/demo-issues.sh nikships/droid-office .agents/skills/office-demo-staging/references/demo-issues.tsv
```

The TSV has one issue per row: `title<TAB>labels<TAB>body`, and the labels must already exist. The example file holds ten small, plausible Droid Office issues (jukebox shuffle, coffee meter pulse, fire-pole help, and so on). Mix in `bug`, `enhancement`, `documentation` and `good first issue` labels so the cards vary. Assigning one or two to the owner (`gh issue edit N --add-assignee <owner>`) puts avatars on the cards.

## 2. Workers at desks

```bash
$D/hire.sh desk-4 "Haiku 4.5"  "Work on GitHub issue #160 in nikships/droid-office (read it with gh issue view 160). Implement it, run lint and the relevant tests, then commit and open a pull request that closes #160."
$D/hire.sh desk-1 "Opus 5.5"   "Work on GitHub issue #157 …"
```

- `hire.sh` refuses to hire when the dialog offers no worktree, which happens on a floor whose checkout isn't on a git branch. Set `ALLOW_NO_WORKTREE=1` only when it's fine for the worker to work in that folder itself.
- Pick free desks next to each other (`office.list()`, `office.state().workers`) so one side view shows several workers. Give each worker a different model; the desk labels show the model.
- Space hires about 20 s apart, because each new worktree runs the floor's setup (`npm ci` here).
- If a hire fails or the model list differs, read the dialog with `agent-browser snapshot -i`.

## 3. Cue a state for the camera

| Want on camera | How |
| --- | --- |
| Working, terminal scrolling | Any fresh hire. The first minutes are the busiest |
| Acting out a tool | A read-only review prompt ("read README, guide, X.ts, run the X test…"). The worker acts out each tool call |
| Needs-you jump | End the prompt with "then ask me which option I prefer with AskUser". The worker jumps when its status turns `needs_input` |
| Confetti | Send a worker that is `done` a one-line prompt (`send.sh Widget "Reply with one short sentence confirming PR #164 is ready."`). It goes working → done again |
| PR and CI on the boards | Workers that open PRs. The Pull requests and Pipelines boards fill in as checks run |

```bash
$D/send.sh Widget "…"                                  # prompt a worker (P dialog, SEND)
$D/wait-status.sh Widget done 180 --via working        # block in the shell until the flip
```

When you record, start before the state flips. Never wait inside one long page eval, because it drops the browser connection. `wait-status.sh` polls with short evals.

## 4. Tear it down

```bash
$D/cleanup.sh nikships/droid-office          # dry run: lists workers, PRs, issues it will close
$D/cleanup.sh nikships/droid-office --yes
```

The script does three things:
- It sends the staged workers home over the office WebSocket (`worker.kill` with `cleanup: 'all'`), which removes their worktree folders and local branches.
- It closes their PRs with `--delete-branch`. A PR counts only when its head branch is `office/<name>-*` and it was opened after the log started.
- It closes the staged issues as "not planned" with a comment.

Use `send-home.sh <name>...` alone to dismiss one worker. A worker waiting on a question is sent home fine; you don't need to answer it first.

Afterwards:
- Run `git worktree list` and `git branch --list 'office/*'` to confirm that only branches older than the log remain.
- Run `git status` in the main checkout and confirm that the owner's changes are untouched.
- Close the capture tab (`agent-browser close`).
- Keep `stage.log` and your scripts.

# Hire a worker

The owner walks to a free desk and hires a worker there: a Droid with a task and model, or a plain Shell. The worker sits down, its terminal runs live, the web companion lists it, and the owner can send it home to free the desk.

## Sub-features

- `hire-shell` hires a Shell at a free desk with B.
- `hire-run` runs a command in a Shell through its P window (`🐚 Run in <name>`).
- `hire-terminal` opens the worker's live terminal with E and shows the command's output.
- `hire-companion` lists the worker in the web companion at `/dashboard`.
- `hire-send-home` sends the worker home with X and frees the desk.
- `hire-droid-dialog` opens the Droid hire window (`✨ Hire a worker at <desk>`, `✨ New task at <desk>`) with E or P at a free desk.

## How to get to it (user POV)

- Stand at a free desk and press B (Shell), E (hire a Droid) or P (hire with a task).
- At a Shell's desk, press P to run a command, E to open its terminal, X to send it home.
- In the web companion, the **Shell** and **Hire Droid** buttons in the sidebar, and each worker's row.
- On Android, the hire screen (see [Android Workers list](./android-workers.md)).

## Driving it with drive.sh and window.office

Preconditions:

- `doctor.sh "$RUN"` passes.
- The current floor has a free desk. The steps file picks the first desk in `office.list()` with no worker.

- **Full journey.** Run `.agents/skills/verify-droid-office/scripts/drive.sh "$RUN" .agents/skills/verify-droid-office/scripts/steps/hire-shell.mjs hire-shell`. Exit code `0`. The transcript has one `step` line per check below, and `$EVIDENCE/hire-shell/proof.json` records them.
- **Hire a Shell.** `office.goTo(desk)`, then `office.interact('B')`. Within 30 s, `office.state().workers` has an entry at that desk with `kind: "shell"`. `02-shell-hired.png` shows the desk prompt `<name> · READY  E OPEN TERMINAL  C CHANGES  P RUN COMMAND  X SEND HOME`.
- **Run a command.** `office.interact('P')` opens `[role=dialog][aria-label="🐚 Run in <name>"]`. Fill `textarea[aria-label=Prompt]` with `echo <marker> | tee $VERIFY_OUT/shell-wrote.txt` and click `button[type=submit]` (`Run ▶`). The window closes, and `shell-wrote.txt` holds the marker within 15 s.
- **Read the terminal.** `office.interact('E')` resolves with `terminal.workerId` equal to the worker's id and a modal labelled `<name> terminal`. `.xterm-rows` contains the marker. Shot `04-terminal.png`.
- **Second view.** Open `/dashboard` in a second page. `button.dash-row-open[data-worker="<id>"]` appears, with an `aria-label` that starts `Open <name>, ready: echo <marker>`. Shot `05-web-companion.png` shows the command and its output in the companion's terminal pane.
- **Send home.** `office.goTo(desk)`, `office.interact('X')` opens `[role=alertdialog][aria-label="Send <name> home?"]`. Click its `Send home` button. The worker leaves `state().workers` within 30 s. Shot `07-desk-free.png`.
- **Droid hire window.** At a free desk, `office.interact('P')` opens `[role=dialog][aria-label="✨ New task at <desk label>"]` with a model picker and a `Hire & start` submit. Close it with `office.closeAll()` unless the owner asked for a real Droid hire.

## Gotchas

- A Droid hire in a clone or a fresh office runs `droid` under the scratch `HOME`, with no Droid sign-in. Open the window freely. Finish a Droid hire only when the owner asks, and send it home afterwards.
- A worker with a worktree gets the send-home sheet with cleanup choices, not the `Send <name> home?` confirm. A Shell never has a worktree.
- The office refuses a hire at its worker limit with a toast. The steps file then times out waiting for the worker. Read `02-shell-hired.png`.
- Names are random (`Pixel 🐚`). Always look the worker up by desk or id, never by a fixed name.
- The first seconds after a load show `COMPILING SHADERS`. It does not block input, but it is in early shots.
- Without `local-storage.json`, the office opens on the character picker and `office-run.mjs` times out. `launch.sh --fresh` writes a test profile. A clone gets the owner's.

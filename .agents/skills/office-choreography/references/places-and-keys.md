# Places, positions and keys

The positions below come from `office.state().player` on commit `208c6a6`. Desks, walls, the pole and the places are defined in `src/shared/layout.ts`. After a layout change, `goTo` the target and read the position again before reusing a number.

## Facing

`state().player.facing` is a yaw in radians. Forward at facing f is `(sin f, cos f)` in x/z:
- facing π looks toward −z (the back wall with the boards);
- facing π/2 looks toward +x;
- facing 0 looks toward +z.

`lookPitch` goes positive when you look up. One pixel of drag is 0.005 rad, which is how `__look` converts angles. `__yawTo(x, z)` gives the facing that points at a spot.

## Places

| What | How to get there, where you land | Notes |
| --- | --- | --- |
| Issues board | `goTo('issues')` → (−11.7, −11.32), facing π, pitch 0.43 | Hold S for 1.1 s to back off to z ≈ −6.3 with the cards filling the view |
| Other boards | `goTo('pulls' \| 'actions' \| 'ci' \| 'computers')` | Hold S for 0.65 s to fit a whole board in view |
| Centre aisle | (−6.0, 9.6) to (−6.0, 2.3) | A potted plant sits just past z 2.3 |
| Aisle by the desks | (−3.1, 2.26), facing π | Desks and laptops fill the background |
| End of desk row 1/2/4 | From `goTo('desk-1')`, route via (−11.6, −6.4) → (−14.4, −6.4) → (−14.4, −4.9), then `__look(Math.PI/2, -0.14)` | Walking straight there gets stuck on a chair |
| Beside desk 4 | About (−6.9, −3.43), `__look(-Math.PI/2, -0.1)` | |
| A desk | `goTo('desk-6')` → in front of it, facing the laptop | E opens the worker's terminal, or the hire dialog when the desk is empty |
| Elevator | `goTo('elevator')` → (8.5, −11) | `open('elevator')` shows the panel. `ride(floor)` resolves when the doors open |
| Fire pole | `POLES` in layout.ts: (6.8, 1.6), with the railing gap toward −z | E slides one floor down. On the bottom floor it only twirls |
| Rooftop | `goTo('roof')` → (8.5, −11.87). Walk out to (8.5, −5) for the skyline | The sidearm can't come out on the roof |

Use `goTo(floorId)` or `ride(floorId)` to change floors. `state().floors` lists them, but not in stacking order. The pole tells you: if E only twirls, you are on the bottom floor, so ride up one and slide from there.

## Keys

`__tap(code, key)` and `__hold(codes, ms)` dispatch window key events, exactly like a keyboard. Desk keys also work through `office.interact(key)` at a `goTo` target.

| Key | Effect |
| --- | --- |
| W A S D, Shift | Move and run. `__walkTo` steers for you |
| Space | Jump |
| E | Use what the crosshair is on: take an issue card, open a terminal, hand a card to a desk (this hires a worker at once), slide the pole, ride the elevator |
| Q | Put a carried card back on the board |
| P · R · X · B · C · O at a desk | Prompt, review, send home, and the desk's other actions (the `#hint` line names them) |
| 7 | Draw or holster the sidearm. Settings → You picks the wand or the .44 Magnum; check `state().player.sidearm` |
| 1–6 | With the wand out: Lumos, Swish and flick, Sparkler, Ship it (confetti), Run the build, Protego. With nothing drawn, they play hand emotes |
| G | Emote wheel |
| Esc | Close the top window or leave a zoom |

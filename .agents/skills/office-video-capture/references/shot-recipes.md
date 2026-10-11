# Shot recipes

These takes worked on the `droid-office` floor. The move files are in `office-choreography/scripts/moves/`. Positions and keys are in `office-choreography/references/places-and-keys.md`.

## Ready-made takes

`rec.sh <name> $M/<move>.setup.js $M/<move>.js`, with `M=.agents/skills/office-choreography/scripts/moves`.

| Take | Move | `MOVE_ARG` | FPS | Length and usable part |
| --- | --- | --- | --- | --- |
| Aisle dolly (establishing) | `aisle-dolly` | | 60 | 3.4 s. Play at 0.44–0.5× |
| Card grab, carry and hire | `card-grab` | `#153\|desk-3` | 30 | Card in hand at ~2.5 s. The droid boots at the desk at ~7.5 s |
| Step into a terminal | `terminal` | desk or worker | 60 | Opens in one frame. ~2.4 s usable |
| Terminal B-roll | `terminal-hold.setup` + `hold` | desk, then ms | 30 | Static. Run the setup alone first, then `MOVE_ARG=3000` for the hold |
| Board pan | `board-pan` | `issues` `pulls` `actions` `ci` `computers` | 60 | ~3.9 s |
| Elevator panel and ride | `elevator-ride` | floor id | 30 | Panel at 0.5–3.5 s. Doors open at 5–6 s |
| Fire pole slide | `pole-slide` | | 30 | 8.6 s. Start on a floor with another floor below it |
| Arcade | `arcade` | | 30 | 9.8 s |
| Rooftop skyline pan | `roof-pan` | | 30 | ~4.5 s |
| Wand draw and spells | `wand` | | 30 | 12.8 s. Ship-it confetti at 5–6.5 s |

## Worker takes

Stage the workers first ([`office-demo-staging`](../../office-demo-staging/SKILL.md)). Then frame a side view along their desk row (see the places table).

- **Confetti (working → done).** Send a worker that is already done a one-line prompt. Record with `hold.js` and `MOVE_ARG=20000`, and watch for the flip from a second shell with `wait-status.sh <name> done 120 --via working`. The confetti lands 4–6 s after done.
- **Acting out a tool, and the needs-you jump.** Give a worker a read-only review prompt that ends with an AskUser question, and record the side view for about 30 s. It acts out each tool call, then jumps when its status turns `needs_input`.
- **Live terminals.** Use `terminal-hold` at each staged worker's desk. Film the owner's own workers only with their OK.

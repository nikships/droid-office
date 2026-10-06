# Spec: .44 Magnum, worker Darwin Awards

## Summary

Pressing `7` toggles a realistic silver .44 Magnum in your right hand.
Click shoots. One shot drops a worker: it falls out of its chair and
bleeds out on the floor. No menu opens. Walk up and press **E** within
30 seconds to revive it with its session untouched. Otherwise medics
collect it and its owned worktrees and branches are deleted.

## Behavior

### Draw and holster (`7`)

- `7` toggles the gun on and off. Both draw and holster get an animation
  and a sound (slide click out, soft click away).
- The gun lives in the right hand. The left hand keeps its mug, drink,
  or smoke.
- Blocked with a "hands full" toast while carrying an issue card, book,
  or basketball, and while golfing, climbing, or hanging a picture.
- While drawn, the crosshair turns red and the hint bar reads
  `Click: fire · 7: holster`.
- First person shows the gun in `Hands`; third person shows it in your
  character's raised right hand (same pattern as the golf club prop).
- `1-6` are emotes, so `7` is free.

### Firing

- Click fires.
- Hit test is a raycast from the camera through the crosshair (first
  person) or mouse (third): the nearest worker whose model the ray hits
  first wins.
- Anything solid in front blocks the shot, so line of sight is required.
  Range covers the whole floor.
- Workers only. Never players, never yourself.
- A miss cracks against the wall or floor with an impact puff and sound.
  Nothing dies.
- One shot kills (visually). Muzzle flash, loud synthesized shot, one
  shell of recoil.

### Bleed-out and revival

- The shot worker tumbles out of its chair onto the floor, lands with a
  thud, and a realistic blood pool spreads under it. Status light out,
  face gone slack.
- Session keeps running, laptop stays on, desk stays occupied.
- `worker.shoot` starts a persisted, server-owned 30-second deadline.
- Within 2.4 metres of the body, **E** sends `worker.revive`. The nearby
  hint shows the remaining seconds even with the gun drawn.
- Revival returns the worker to its seat, with session untouched and
  blood gone. Escape does not revive it.

### Deadline expiry

- The server stops the session and deletes its owned worktrees and branches,
  including uncommitted changes and unpublished commits. No cleanup choices.
  Pre-existing branches and shared meeting worktrees retain their ownership protection.
- When `worker.remove` arrives, clients route the worker to the
  medic sequence instead of the walk-out: two white-uniform paramedics
  walk in from the elevator with a stretcher, load the body (~4.8s, blood
  pool drains as it lifts), carry it to the elevator, and fade.
- Laptop shuts and shrinks as it does today.
- Blood pool is gone with the body. No permanent stain.

### Edge cases

- Multiple bodies have independent deadlines; repeated shots do not extend them.
- Floor switches, disconnects, reloads and server restarts do not cancel deadlines.
- Revival at or after the deadline is refused; collected bodies cannot be revived.
- Weird positions (meeting table, beanbag, mid-arrival, upstairs floors):
  fall to the floor the same way everywhere.
- Upstairs floors: medics use the elevator, never the balcony parachute.

## Components

| File | Change |
| --- | --- |
| `src/client/world/gun.ts` (new) | Silver .44 Magnum mesh (three.js primitives), muzzle-flash helper |
| `src/client/world/hands.ts` | `holdGun(on)`, `fireGun()` recoil on the right arm |
| `src/client/world/character.ts` | `Person.setGun/fire` (third-person arm + prop); `Worker.die/revive` visual states |
| `src/client/world/casualties.ts` (new) | `Casualties` class mirroring `Departures`: fall, blood pool, medics + stretcher, revive-to-seat |
| `src/client/main.ts` | Gun toggle, firing, shared casualty synchronization, nearby E revival and countdown hint, medic removal routing |
| `src/shared/protocol.ts` | Revival duration, worker deadline, shoot and revive actions |
| `src/server/workers.ts`, `src/server/worktrees.ts`, `src/server/server.ts` | Persisted deadlines, session-preserving revival and gun-specific owned-resource cleanup |
| `src/client/sound.ts` | `gunshot`, `gunDraw`, `gunHolster`, body thud, medic siren sting (Web Audio synth, same patterns as `thunder`/`gong`) |
| `docs/guide.md` | `7` row in Controls plus a short section |
| `tests/casualties.test.ts` (new) | State-machine and timeline unit tests (Node-loadable, like other world modules) |

Out of scope: kill confirmations for other players,
persistent blood.

## Validation

`npm run lint`, `npm run typecheck`, `npm test`, plus a manual in-office
shoot/revive/kill pass.

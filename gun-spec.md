# Spec: worker sidearms

`7` draws the droid wand by default. Settings → You → **What 7 puts in your hand**
can select the .44 Magnum instead. Both sidearms use the same targeting and worker actions.

## Normal hits

- One normal shot or wand bolt opens the hit worker's terminal for the user who fired it.
- The worker stays at its desk with its task and session untouched. Repeated normal hits
  only reopen that same terminal.
- This includes the Pipeline agent, Team lead, Issues agent and PR agent, even before
  their first task. `station.open` starts their session without inventing an owner task;
  `worker.open` opens it only in the requesting window.
- Guest and cloud workers open their usual views.
- A registered laptop screen or other interactive display still opens its usual UI.
- The nearest visible solid blocks the shot. There is no reach limit.
- There is no downed state, fall, bleed-out, blood pool, spell circle, revival deadline,
  revive action or revive key. Old saved deadlines are ignored on restore.

## Charged hits

Hold the primary button for 0.75 seconds and release to fire a charged shot.

- A charged worker-body hit immediately stops and dismisses a local worker.
- Its owned worktrees and branches are deleted, including uncommitted changes and
  unpublished commits. Pre-existing branches keep their ownership protection.
- `worker.remove` carries `shot: true`, so all windows render a white-gold beam and
  vertical heavenly ascent instead of the ordinary send-home walk.
- The laptop shuts and shrinks; the worker, laptop and beam resources are released once.
- There is no revival window.
- Guests and cloud workers cannot be dismissed this way.
- Screen hits still open their UI, and visible furniture still blocks shots.
- Holstering, switching sidearms or spells, opening a window, Escape and losing focus
  cancel a held charge without firing.

See [Heavenly ascent](docs/heavenly-ascent.md) and the [feature guide](docs/guide/features.md).

## Controls and effects

- `7` draws or holsters the selected sidearm.
- Wand spells use `1–5` and the G wheel: Lumos, swish and flick, Sparkler, Ship it,
  Run the build. The former Protego revival spell and `6` binding are removed.
- Magnum tricks remain on `1–6` and the G wheel.
- Misses retain their dust or fizzling spell effects. Charged hits retain their effects,
  recoil, charge ring, sound and Mac trackpad haptics.
- Players and the user are never shot targets.

## Validation

`tests/worker-shot.test.ts` covers harmless normal shots, charged cleanup, old-state
restoration and pre-made session opening. `tests/gun-hit.test.ts` covers visible targeting,
blockers, screens and idle pre-made models. The casualty and wand tests cover immediate
ascent, resource cleanup and the five-spell menu.

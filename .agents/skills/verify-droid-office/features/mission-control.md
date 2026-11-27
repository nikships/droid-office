# Mission Control

The Orchestrator and external Tailscale bots are building agents, visible in Mission Control on every floor without occupying desks. The Orchestrator plans and delegates code changes through the building-wide MCP surface; its session, settings and team stay the same when the owner changes floors.

## Sub-features

- `mission-entry` opens the Orchestrator from its room, the menu and the M shortcut.
- `mission-companion` opens the pinned Orchestrator row in the web/Mac companion.
- `mission-intro` shows the dispatch schematic and suggested prompts in an empty conversation on web and Android. Choosing a prompt only fills the draft.
- `mission-shared` carries the same agent across floors and broadcasts on/off changes to both pages.
- `mission-bots` shows real external bots at the table and in the companion, with status and team rather than a nonexistent terminal.
- `mission-turn` sends a prompt, shows live work, answers a question and interrupts a turn.
- `mission-team` hires onto a named floor and delivers the report back to the resting Orchestrator.
- `mission-android` shows Home, the conversation, Asks and notification navigation on Android.

## How to get to it (user POV)

- Walk into Mission Control, under the boss office. E at the Orchestrator opens its prompt; O opens its terminal; X stops its turn.
- Press M anywhere, choose Orchestrator in the menu or find it in the palette.
- In the web/Mac companion, pick the pinned Orchestrator row or press ⌘O.
- Settings → Orchestrator controls on/off, model, effort, the brief and New conversation.
- Android Home → Mission Control opens the Orchestrator or a bot. Me → Orchestrator opens its settings.
- Settings → Phone & web → Tailscale MCP manages external bots.

## Driving it with window.office, Playwright and adb

Preconditions:

- The baseline launch and doctor checks pass. Use a clone of the owner's office.
- Live prompts require the owner's credit approval and a signed-in clone; follow office-clone's sign-in instructions. Use short, local-only tasks and native Factory Haiku 5.5 (`claude-haiku-5-5`, 0.04x) or DroidProxy Luna 6 / Haiku 5.5 (never legacy Haiku 4.5 at 0.4x).
- Bots must be real provisioned identities. Record a missing bot path as skipped rather than inserting fake state.

- **Entry and shared settings.** Run `scripts/drive.sh "$RUN" .agents/skills/verify-droid-office/scripts/steps/mission-control.mjs mission-control`. It captures the room, the E window, the M/menu entry, Settings, the companion and a floor change. It turns the Orchestrator off and on through Settings, checks that both pages agree, and restores the original setting. The drive never sends an agent prompt.
- **Empty intro.** On a signed-in clone with no Orchestrator conversation, open the pinned row. In the web companion check that `.wt-scroll` opens at scrollTop 0 and `.orc-intro` shows all four example buttons. Click each and compare the `Message to Orchestrator` textbox to the card text without sending. Emulate `prefers-reduced-motion: reduce` and check that the mark and bus stop. On a signed-out clone, verify the reason is visible, all four buttons are disabled, and the mark and bus are static. On Android, open Home → Mission Control → Orchestrator, then tap Model fan-out and check the draft without sending.
- **Mac runtime.** Run `scripts/drive.sh "$RUN" .agents/skills/verify-droid-office/scripts/steps/mission-control-native.mjs mission-control-native --native`. It exercises the same scene, entry points, settings and floor change in the isolated Electron app. The companion check stays in the browser drive because Electron cannot create a tab through `Target.createTarget`; these page screenshots are not native-display or performance proof.
- **Live turn.** In the companion, send “Ask me one two-choice question; hire nobody.” Observe starting/working, answer the real question from the pane, and require its reply in Thread. Send a follow-up while working and Stop a separate turn. Capture the action and result, not just the final transcript.
- **Team.** Ask it to hire one cheap worker on a named cloned floor for a read-only count, with no pushes or forge writes. Require the worker in the floor list and the building agent's team, live room dashes, a report and the Orchestrator's follow-up. Send the helper home afterwards.
- **Bots.** Go to the bot by id with `office.goTo(id)`, then E. Require its card to say it runs externally, and check the same identity/team in the companion. `office.state().workers` must not contain it.
- **Android.** Use the handles in `android/app/src/main/java/ai/factory/droidoffice/core/Tags.kt` for Home, the Orchestrator, Asks and the settings sheet. Answer a real question, background the app for the completion notification, then tap it and require the same thread.
- **Evidence.** Keep numbered shots and `proof.json`; list entry points that were not exercised. The scripted drive writes its assertions and skipped bot path there.

## Gotchas

- A scratch HOME without Droid sign-in is a valid blocked state, not proof of a working session.
- A floor worker and a building agent have different MCP permissions. `office_move` and visit tools are absent from the building surface; hires explicitly name a floor/repository.
- The Orchestrator's PTY host lives under the office's `orchestrator/.droid-office/` directory. Stop it during cleanup as well as floor hosts.
- New conversation preserves its team. Turning it off stops only its own session.
- Wait for finite pane entrance animations before a companion screenshot; a visible DOM node can still be at zero opacity.

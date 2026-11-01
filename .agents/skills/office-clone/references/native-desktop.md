# Native desktop checks on macOS

Use `agent-desktop` for the OS layer, alongside the existing Office APIs:

| What needs proof | Driver |
| --- | --- |
| 3D movement, desks, floors, camera and scene state | `window.office`, then the choreography rig where needed |
| HTML controls and layout, including the offscreen office page | Playwright in `office-run.mjs` |
| Native menu bar, sheets, alerts and window metadata | `agent-desktop`, via the optional `desktop` helper |
| Actual display pixels, native HDR, pacing or temperatures | Existing native frame/thermal tools, not a DOM shot or AX result |

## Check the installed contract

Load `agent-desktop-macos` and read the installed core docs before using it:

```bash
agent-desktop skills get desktop
agent-desktop skills get platform
agent-desktop status
agent-desktop permissions
agent-desktop snapshot --help
```

`status` reports supported surfaces and nested permission states. The runner checks Accessibility before launching the clone. Screen Recording is additionally required for `desktop.shot()`, not for AX observations. If a required permission is denied, run `agent-desktop permissions --guide`, then recheck; only the owner can approve the system grant. Do not restart or relaunch their app to recover.

## One isolated run

Build, clone and start the real office as described in [office-clone](../SKILL.md). Then:

```bash
node .agents/skills/office-clone/scripts/office-run.mjs "$T" native-steps.mjs \
  --source /absolute/path/to/built-checkout --desktop --out "$T/native-proof"
```

```js
// native-steps.mjs
export default async ({ desktop, log, shot }) => {
  // A known target is cheaper than dumping the whole menu bar.
  const found = await desktop.find({
    surface: 'menubar', role: 'menuitem',
    name: 'Switch to Office Companion', exact: true,
  });
  if (found.matches.length !== 1 || !found.matches[0].ref_id) {
    throw new Error('Expected one native Switch to Office Companion item');
  }
  log(await desktop.get(found.matches[0].ref_id, 'title'));
  await shot('office-page'); // browser pixels, deliberately not native display proof
};
```

Do not click **Switch** in this example: it destroys the current page, invalidating the runner's Playwright helpers. A workflow that tests mode switching must handle the replacement page explicitly.

### Helper contract

- `desktop.windows()` returns only windows belonging to the launched PID, including hidden utility/offscreen windows. Automatic selection considers **visible** windows only. If several qualify, it fails rather than guessing. Pass `{ windowId }` to an observation, or the second argument to `shot`, to disambiguate.
- `desktop.snapshot({ windowId?, surface?, root?, skeleton?, timeoutMs? })` returns AX data, with interactive refs and compact wrappers. Default observation budget is 3000 ms. A cold Chromium renderer may need an explicit `timeoutMs: 25000`. Check `complete` and drill into a returned `root` when truncated. Do not skeleton menus, sheets or alerts; the helper disables skeleton mode for a surface.
- `desktop.find({ windowId?, surface?, root?, role?, name?, value?, text?, exact?, timeoutMs? })` returns at most **two** matches, enough to detect ambiguity. Default budget is 5000 ms. Require a single addressable match before acting. `root` cannot combine with `surface` or `windowId`.
- `desktop.get(ref, property = 'text')` and `desktop.is(ref, property = 'visible')` return the CLI's data, not a flattened string or boolean.
- `desktop.click(ref)`, `desktop.select(ref, value)` and `desktop.setValue(ref, value)` use **semantic, headless** delivery only. They accept only refs observed by this helper's session. A value write does not prove application-level commit or that every DOM callback ran.
- `desktop.shot(name, windowId?)` captures that native window to `<out>/<name>.png` and returns the CLI's data. It does not capture an arbitrary screen or silently fall back to a browser screenshot.
- Every call returns the CLI's `data`. A structured CLI error throws with `code`, `details` and `disposition` preserved. There are **no automatic retries**. Read `disposition.retry`: only `safe` permits a repeat. For uncertain delivery, observe what actually happened first.
- The runner owns cleanup. It exports `<out>/desktop-*/trace.html` and ends the session before quitting only its own app. Session state and raw snapshots are local artifacts, not files to commit or upload.

Take a fresh snapshot or find after a UI change; old refs are not durable selectors. A successful AX call is not proof of the intended effect. Re-read the affected region or assert on live Office state. While a menu, sheet or alert is open, observe that surface rather than acting on the window behind it.

## Current boundaries

The native 3D office uses a Metal presenter with a hidden Chromium page. In the real-clone check, the visible presenter's AX window snapshot timed out even though its native menu bar was readable. This is not a permission failure and does not mean the office has no controls. Keep browser automation for the HTML page and `window.office` for the scene; do not keep increasing AX timeouts.

Window capture can fail when the native full-screen window is off the current Space, even with Screen Recording granted. Preserve the failure; don't focus the window or substitute page pixels and call that native proof. A display/input test that needs focus or real pointer/keyboard events requires explicit owner permission. This helper deliberately has no `--headed`, coordinates, key holds, clipboard or app-lifecycle fallback.

For the **already-running installed app**, use the accessibility path without restarting it or adding a CDP port. Read `agent-desktop list-windows --app "Droid Office"` and choose its exact window ID; do not assume the development app is named Droid Office (the source run reports Electron). Observe with `snapshot --window-id <id>` or a scoped `find`. Do not move the owner's player or mutate their app unless the task calls for it.

`agent-desktop` does not record video. Keep the existing recorder for scene footage, and native capture tools for OS menus, HDR or display proof. Native cursor overlays are presentation only, not evidence that a real pointer moved.

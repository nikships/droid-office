# Finder integration

The Mac app bundles a FinderSync extension and a native Keychain bridge. Finder is a presenter, not an agent: it never runs git, mutates selected files or supplies orchestration instructions.

## Floors and dispatch

- Resolve real paths first, then walk from each directory (or a file's parent) to the nearest `.git` directory or file.
- Reuse the canonical checkout's existing floor. Register unknown repositories persistently in the office's existing `.droid-office/floors.json`, including explicitly selected checkouts outside the workspace folder. No checkout is cloned or moved.
- Name a new floor after its directory, qualify collisions with the parent directory, then a numeric suffix when necessary.
- Group non-git targets on Home. Limit selections to 100 targets and five groups.
- Keep normal Team lead, worker and worktree ownership. Finder does not create its own lead, brief, branch convention or worktree lifecycle. The standard lead chooses and hires its team using `office-workers`.
- Submit the user's task followed by quoted canonical paths to `station-lead`. An absent lead starts with its standard brief; an existing lead keeps its conversation. Busy leads and unanswered CLI dialogs reject dispatch visibly.
- Apply a chosen model when a ready lead resumes, preserving the conversation. Remember only successful explicit Finder model choices per floor in the office's `finder.json`.

Opening the resolve preview can register a floor. Cancelling the task does not remove that persistent floor.

## Local API

These routes exist only on the existing hook listener bound to `127.0.0.1`, not on the LAN-facing companion listener.

All routes require `X-Droid-Office-Token`, a literal `127.0.0.1` Host and a loopback peer. Browser Origin and Fetch Metadata requests are refused. Tokens are compared through fixed-length SHA-256 digests using `timingSafeEqual`. JSON requests are bounded to 512 KiB.

| Route | Result |
| --- | --- |
| `GET /api/finder/status` | Authenticated liveness check |
| `POST /api/finder/resolve` with `paths` | `groups`, visible `models` and `defaultModel` |
| `POST /api/finder/dispatch` with `paths`, `prompt`, optional `model` and unique `requestId` | `dispatches` and per-floor `errors` |

Use `model: "floor-default"` to use the floor's remembered explicit Finder model choice. Without a remembered choice, an existing lead keeps its current model; only a new lead uses the normal office/Droid default. Explicit model IDs must appear in the visible model catalogue; normal subscription and worker-capacity gates still apply.

Dispatch receipts are retained for that daemon run. Reusing a request ID with the same payload returns the original result; changing its payload is rejected. Partial success is explicit and must not be retried as a new whole-batch request. A transport failure is ambiguous: inspect the Team lead before sending another task. No task is stored for delivery after an offline period.

## Native boundary

The Mac app supplies `--finder-bridge <signed helper executable>` only when it owns the packaged daemon. Source and isolated test runs do not enable it automatically.

Once the daemon is ready, it calls the bridge with `--publish http://127.0.0.1:<hook-port>/`. The bridge owns the shared Keychain item, preserving its random token while updating the endpoint. Its JSON response is consumed privately by the daemon, never written to a state file, environment variable or log. Missing Keychain/signing access fails closed.

The sandboxed extension cannot read the selected items, so macOS refuses to open them as documents with the prompt. It starts one prompt process per dispatch with `--dispatch <absolute paths>` instead. The prompt only needs the path text; the daemon does the file checks. A prompt process exits when its last window closes.

Keychain items normally survive application deletion and reinstall. Reinstall is not treated as a reliable token-rotation event; the integration never silently destroys a stored credential.

Finder Extensions require explicit owner activation in System Settings. The extension must not silently enable itself. A native activation notice and a menu entry provide the route to the system controls.

The extension excludes system and Library directories, Trash, Time Machine and network volumes. The server checks canonical paths again so a symlink cannot bypass directory exclusions.

A successful dispatch closes the prompt after macOS accepts its notifications. If notifications are denied or unavailable, the prompt retains **Open Thread** links instead. Partial failures remain visible and are never automatically replayed.

## Thread navigation

Each accepted floor dispatch returns a companion URL and a `droid-office://thread/<worker>?floor=<floor>` link. The app validates protocol links and opens a sandboxed companion window. The companion follows the floor before selecting the worker and uses Thread for that visit without changing the owner's saved default view.

The lead's collapsible **Team activity** section includes local child workers' status, recent conversation and tool activity, including patch arguments and results. Each child has **Open thread** drill-down. Reads run only while the section is expanded, connected and visible, rotating through at most six cached children with one child read per second in total. This leaves two of the server reader's eight cache slots for the lead and history or drill-down. Each child retains at most forty entries and 96,000 serialized characters, with large fields visibly truncated. Unchanged snapshots and timer ticks do not repaint the rollup. It uses the existing read-only thread protocol and never resizes a child's terminal.

## Validation

### Developer ID profiles

Distribution needs two current Developer ID provisioning profiles for team `NW6B3R27LQ`:

| Bundle identifier | Local signing input | Release secret (base64 profile) |
| --- | --- | --- |
| `com.nikships.droid-office.finder-bridge` | `native/mac/build/signing/FinderBridge.provisionprofile` | `FINDER_BRIDGE_PROFILE_BASE64` |
| `com.nikships.droid-office.finder-sync` | `native/mac/build/signing/FinderSync.provisionprofile` | `FINDER_SYNC_PROFILE_BASE64` |

Both profiles must authorize the app group `group.com.nikships.droid-office` and shared Keychain group `NW6B3R27LQ.group.com.nikships.droid-office`. They must allow Developer ID distribution to all devices, be unexpired, and omit debug access. The signing hook validates these capabilities, embeds each profile and signs each native bundle before the outer Electron app. Signing inputs stay under the ignored build directory.

The Electron process does not read the shared Keychain item and needs no restricted Keychain entitlement. Its existing hardened-runtime entitlements remain unchanged. Explicit `mac.identity=null` supports unsigned CI builds; signed packaging refuses missing or invalid profiles rather than shipping a silently broken extension.

### Checks

Focused checks:

```bash
node --import tsx --test tests/finder.test.ts tests/building.test.ts tests/config.test.ts tests/desktop-tray.test.ts
node --import tsx --test --test-name-pattern='Finder dispatch' tests/workers.test.ts
npm run typecheck
node --import tsx --test tests/finder-native.test.ts
```

The full native build is part of `npm run build`. Signed Finder activation and shared Keychain access must be verified in a correctly provisioned Mac app; an unsigned compile is not evidence that those capabilities work.

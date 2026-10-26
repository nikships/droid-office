# Setup and Subscriptions

Someone who has never used Droid or Factory downloads Droid Office, opens it, and is hiring workers a few minutes later, on the Claude or ChatGPT plan they already pay for, without having to know what Droid or DroidProxy is. This is the plan for that work and the contract its pieces follow. Status: **implemented** (nikships/droid-office#293). Subscriptions need DroidProxy 1.8.180 or later, the first release with the control API.

Three things stand between a fresh Mac and a first worker, and the office does each one itself:

1. **Droid**, Factory's coding agent, which every worker is. The office downloads, verifies and installs it.
2. **A Factory account**, which Droid needs. The office runs Droid's own sign-in and shows its code; the owner signs in or creates an account in the browser.
3. **Subscriptions** (optional, macOS on Apple silicon): the owner's Claude, ChatGPT and other plans, served to Droid by [DroidProxy](https://github.com/nikships/droidproxy), a small menu-bar app. The office installs and drives DroidProxy, connects accounts and puts their models into Droid.

## The owner's decisions

- The office's word for it is **Subscriptions**: the welcome step and the ⚙️ Settings pane are called that, and DroidProxy is named underneath as the app that does it.
- No policy bans on models. Every model the owner enabled stays usable, by them and by leads hiring subagents. The office refuses a model only when a worker on it can't run: its provider has no signed-in account, the provider is switched off, every account is out of quota, or DroidProxy isn't installed. That applies to every hire: the owner's own, board agents, and `office-workers hire`.
- Quota comes from DroidProxy's usage data (the same as `GET /droidproxy/usage`). When nobody can tell (an older DroidProxy, a provider with no usage API, DroidProxy not answering for a while), the model is not refused.
- Droid sign-in is required, and the welcome never promises it is free: Factory has paid plans, and the copy says "sign in, or create an account".

## The welcome

A fresh office opens the welcome by itself once the page has loaded, while `SetupState.onboarded` is false and the office knows where Droid stands: missing, or its sign-in known (`needsWelcome` in `src/shared/setup.ts`). The first check after a start that can tell decides an office with no `setup.json` and writes it: Droid installed and signed in is an office that already worked, `onboarded: true`, and it never sees the welcome; anything else is a fresh office, `onboarded: false`. Signing in later doesn't change it, so a reload or a restart in the middle brings the welcome back at its next step instead of losing Subscriptions and Ready. It is done (`setup.onboarded`) when the owner presses **Start**, or closes it once Droid can run; closed before that, it stays shut in that tab and opens again on the next load. The ☰ menu opens it again at any time, and so does anything that finds Droid missing.

It is one window with four steps down the side, each a ✓ once done, and the current one on the right. Every step reads only `store.setup` and `store.subscriptions`, so a step finished in another tab, by the server, or in DroidProxy's own window shows as done here too.

1. **Droid**: what it is in one line, Install, a progress bar, then the version. Where the office can't install it (`canInstall` false: Windows, an odd architecture), the one-line manual install and Check again.
2. **Factory account**: Sign in. The office starts Droid's sign-in and the step shows the code large, with Open sign-in page (the page with the code filled in), Cancel, and a waiting line. Then "Signed in as …".
3. **Subscriptions** (only where `proxy.phase !== 'unsupported'`): Claude and ChatGPT as two big choices, the other providers behind "More". Connect installs and starts DroidProxy when it has to (the server does that in order), then opens the provider's sign-in in the browser on the office's Mac, or shows a device code. A connected account shows its email and how much of each usage window is left. Skip is always there.
4. **Ready**: the model new workers start on, preselected to the best one that can run (`readyModel`: a just-connected subscription's flagship, else the office's current default, else Claude's or ChatGPT's, then any subscription's), in a `modelPicker`. Start sets it as the office's default worker, closes the window (which sends `setup.onboarded`) and tells the owner how to hire.

## Droid (`src/server/setup/`)

- **Where it is.** `resolveAgent` in `workers.ts`: the agent command on PATH or the login shell's, else `~/.local/bin/droid` (where Droid's installer puts it, which the Mac app's PATH lacks). After an install, `agentChanged(path)` points every floor (`WorkerManager.setAgentPath`), the task namer and the model catalogue at it.
- **Version.** `droid --version`. The newest release is `https://downloads.factory.ai/factory-cli/LATEST` (a bare version), read at start and every 6 hours.
- **Install and update** do what `curl -fsSL https://app.factory.ai/cli | sh` does, in Node, with more checks: download `https://downloads.factory.ai/factory-cli/releases/<version>/<darwin|linux>/<arm64|x64|x64-baseline>/droid` (x64 without AVX2 is `x64-baseline`) and its `.sha256`, compare the SHA-256, on macOS check `codesign --verify --strict` and that `codesign -dv` names `TeamIdentifier=SW6TL4V6Q5` (Factory's Developer ID), `chmod 755`, then write it to `~/.local/bin/droid` through a temp file in the same folder and a rename, so a running worker keeps the binary it started with. Progress goes out as `droid.progress`. The office never edits shell profiles and never kills running droids.
- **Signed in.** `droid doctor --json --checks auth`, which exits 0 signed in or not: signed in when every `auth.*` result but `auth.workosRefresh` (a network probe that passes either way) passes, signed out when one doesn't (`auth.verify` warns "no usable credentials found"), unknown when there's no `auth.verify`. The account is the masked email `auth.verify` names ("authenticated as n***@gmail.com"). Checked at start, after an install, every 30 minutes, on `setup.check`, and every 3 seconds during a sign-in.
- **Sign-in.** Droid has no sign-in command: its TUI opens on "Please login with your Factory account to continue" with `> Login` selected, and Enter starts a device flow that prints "please visit https://auth.factory.ai/device and enter code XXXX-XXXX" and runs `open https://auth.factory.ai/device?user_code=XXXX-XXXX`. The office runs `droid` in a PTY (`@lydell/node-pty`, in a temp folder), presses Enter once the Login menu shows, and gets the code and URL two ways: from the screen text, and from a shim `open` (first on that process's PATH, with `xdg-open` and `$BROWSER` for Linux) that records its argument instead of opening anything. Droid 0.249.0 on macOS calls the `open` on its PATH. The client opens the URL in the owner's browser, so it works from a browser on another machine too. Once `doctor` says signed in, the PTY is killed. A sign-in times out after 15 minutes. If Droid shows something the office doesn't recognize, it stops and says to run `droid` in a terminal.
- **State file.** The office's `.droid-office/setup.json`: `{ "onboarded": true, "at": <ms> }`, or `false` while a fresh office is still in its welcome.
- **Another agent command.** With `--agent` naming something other than `droid`, the office runs that and never installs a droid beside it (`canInstall` is false).

## Subscriptions (`src/server/subscriptions/`)

- **Where DroidProxy is.** Only on macOS arm64; anywhere else the phase is `unsupported` and nothing else here runs. Installed means `/Applications/DroidProxy.app` or `~/Applications/DroidProxy.app` with `CFBundleIdentifier` `com.droidproxy.app`; its version is `CFBundleShortVersionString`. Running means its control API answers (see below). Running but without a control API is `outdated`.
- **Install and update.** The newest release is `GET https://api.github.com/repos/nikships/droidproxy/releases/latest` (`tag_name` `v1.8.179`; assets `DroidProxy-arm64.zip` and `DroidProxy-arm64.zip.sha256`), read at start and every 6 hours. The office downloads the zip, checks its SHA-256, unpacks it with `ditto -x -k` into a temp folder, checks `codesign --verify --deep --strict`, `TeamIdentifier=NW6B3R27LQ` and `spctl -a -t exec` (notarized), quits a running DroidProxy (`osascript -e 'quit app id "com.droidproxy.app"'`), replaces the app (in `/Applications` when it can write there, else `~/Applications`) and starts it. DroidProxy keeps its own Sparkle updates; the office's update is the same release, checked the same way.
- **Starting it.** `open -g -a <app> --args --launched-by droid-office`: in the background, and DroidProxy opens no window of its own when started that way. The office starts it when the owner asks, when a connect needs it, at office start when Droid's settings already have DroidProxy models, and when a hire on one of its models finds it stopped.
- **Polling.** While running: `GET /status` and `GET /models` on the control API and `GET /droidproxy/usage` (account windows) every 60 seconds, every 2 seconds while a connect is in flight. Stopped or missing: look again every 30 seconds. Never block a WebSocket handler on DroidProxy; keep the last good state with `checkedAt`.
- **Connect.** `subscriptions.connect` installs and starts DroidProxy first when it has to, then `POST /connect`. The account shows up in `/status` when the sign-in finishes. After the first account of a provider connects, and while Droid has none of DroidProxy's models (at most every 10 minutes), the office runs `POST /factory-models` and calls `modelsChanged()`. Models that are only stale wait for Update models, since the owner may have taken some out on purpose.
- **Availability** is `/models` turned into `SubscriptionsState.availability`. A state older than 5 minutes counts as unknown. DroidProxy installed but not answering is `proxy-down` with `installed: true` (the gate starts it and lets the hire through); a DroidProxy model in Droid's settings with no DroidProxy installed is `proxy-down` with `installed: false`.

## DroidProxy's control API (version 1)

DroidProxy implements this in nikships/droidproxy; the office is its only client. It is served by ThinkingProxy on DroidProxy's port (8317), under `/droidproxy/control/`.

**Discovery.** At launch DroidProxy writes `~/.droidproxy/control.json` (folder mode 0700, file 0600, temp file and rename): `{ "api": 1, "port": 8317, "token": "<64 hex chars>", "version": "1.8.180", "pid": 1234 }`. The token is new at every launch. The office reads the file before each call and again after a 401.

**Every request** carries `Authorization: Bearer <token>`. DroidProxy answers 403 to a request that comes from anything but a loopback address (ThinkingProxy may listen on every interface), carries an `Origin` header, or names a `Host` other than `127.0.0.1:<port>` or `localhost:<port>`; 401 to a missing or wrong token (compared in constant time). Bodies are JSON (`Content-Type: application/json`, at most 64 KiB); a POST without that content type is 415. Errors are `{ "error": "<words for the owner>" }`. Nothing here is logged with its token.

| Call | Does | Answers |
| --- | --- | --- |
| `GET /status` | Everything but usage | `{ "api": 1, "version", "backend": { "running" }, "providers": [Provider], "factory": { "installed", "available", "stale" } }` |
| `POST /connect` `{ "provider" }` | Starts the provider's sign-in, as its Connect button does (a browser OAuth on this Mac, or a device code) | 202 `{ "connecting": Connecting }`; 409 when one is already running; 400 for a provider whose `connect` is `app` |
| `POST /connect/cancel` `{ "provider" }` | Stops it | 200 `{}` |
| `POST /accounts/remove` `{ "provider", "account" }` | Forgets an account (its auth file), as the app's remove does. The office names it by id; an email that names several (Claude seats in more than one organization) is refused | 200 status; 404 unknown; 409 ambiguous |
| `POST /providers` `{ "provider", "enabled" }` | The provider switch (hot reload) | 200 status |
| `POST /factory-models` `{}` | Puts DroidProxy's models into `~/.factory/settings.json`, as "Add models to Droid" does, backup and all | 200 `{ "installed": 14, "backup": "<path>" \| null }` |
| `GET /models` | Whether each of its models can run now | `{ "generated_at", "models": [{ "id", "name", "provider", "availability": Availability }] }` |
| `POST /open` `{}` | Brings up DroidProxy's settings window | 200 `{}` |

- `Provider`: `{ "key": "claude", "name": "Claude", "enabled": true, "connect": "browser" | "device" | "app", "accounts": [{ "id", "label", "expired", "disabled" }], "connecting": Connecting | null }`.
- `Connecting`: `{ "started_at": ISO, "user_code": string | null, "verification_uri": string | null, "error": string | null }`. `error` stays until the next connect, so the office can say why it failed.
- `Availability`: `{ "state": "ok" }`, `{ "state": "exhausted", "until": ISO | null, "window": "5-hour", "account": "a@b.com" | null }`, `{ "state": "signed-out" }`, `{ "state": "disabled" }` or `{ "state": "unknown" }`.
- `factory.stale`: the models in Droid's settings differ from what DroidProxy would put there now (a model added or renamed, a provider switched).

How DroidProxy judges a model, from the same cached usage as `/droidproxy/usage`:

1. Its provider switched off: `disabled`.
2. No account of its provider that isn't expired or disabled: `signed-out`.
3. Any such account with every window that covers this model above 0% left, or with no usage to go by: `ok`, or `unknown` when no account of the provider has usage at all.
4. Otherwise `exhausted`, with the window and reset of the account that comes back first.

A window covers a model unless it is named for another model family: Claude's "Weekly (Opus)" covers only Opus models, "Weekly (Sonnet)" only Sonnet. Providers DroidProxy has no usage for are `unknown` once signed in.

## Where a model is refused

| Where | What happens |
| --- | --- |
| `WorkerManager.spawn` (`modelGate`) | Every hire of an agent: the owner's, board agents', subagents'. Refused with `availabilityWords`: "Can't hire on GPT 6.1 Sol: out of quota, back in 3 h 10 min (5-hour). Pick another model." |
| `office-workers models` | Each model that can't run says why on its own line, and the default too. |
| `office-workers hire` | A model that can't run, named or the default, is refused before a desk is taken, naming the ones that can. |
| Model pickers (web and Android) | Shown dimmed with the reason and not pickable; a stopped DroidProxy only shows a note. |

## The UI

- **Compute wall**: a third screen to the right of Droid Computers shows every connected DroidProxy account, remaining quota for each reported window, reset countdowns and local reset dates. Paused, expired, unreported and cached usage have separate states. Account sample timestamps, not control-status checks, establish freshness; an elapsed reset waits for confirmation. More than two windows continue on additional cards; complete pages rotate every 20 seconds beyond six cards. The wider bezel sits above the exit sign and windows; the rack stays put.
- **Welcome**: `src/client/ui/welcome.ts`, opened from `main.ts` and the ☰ menu.
- **⚙️ Settings → Connections**, with Factory and Jira: "DroidProxy" (what it is, its phase and version, Install / Update / Start / Open DroidProxy), "Accounts" (each provider: switch, its accounts with a usage bar per window and when it resets, Connect / Add another / Remove, a connect in flight with its code), "Models in Droid" (how many, Update models when stale). Off a Mac with Apple silicon, those groups say Subscriptions need DroidProxy on a Mac and stop there.
- **⚙️ Settings → Workers → "Droid"**: version and Update to …, signed in as … or Sign in, Check again.
- **Model pickers**: `PickerModel` carries why a model can't run; the picker shows it and won't pick it. When no subscription is connected on a Mac, the picker's footer offers "Use your Claude or ChatGPT plan" (opens Settings → Connections).
- **Android**: the hire sheet's model list does the same as the web picker, from the welcome's `subscriptions` and the `subscriptions` message.

## Security

- Every binary the office installs is checked twice: its published SHA-256, and on macOS its Developer ID team (Factory `SW6TL4V6Q5`, DroidProxy `NW6B3R27LQ`) and, for DroidProxy, notarization. A failed check deletes the download and says which check failed.
- Downloads come only from `downloads.factory.ai` and from the `nikships/droidproxy` releases on GitHub, over HTTPS, redirects included.
- The control API token never leaves the office's server: not in a message, a log line or an error.
- The sign-in PTY gets the office's own environment (`childEnv`) and a temp folder; its `open` shim only writes a file in that folder.

## Shape of the code

| Where | What |
| --- | --- |
| `src/shared/setup.ts` | `SetupState`, `DroidCliState`, `needsWelcome`, `droidReady`, `compareVersions`. |
| `src/shared/subscriptions.ts` | `SubscriptionsState`, `ModelAvailability`, `cannotRun`, `availabilityWords`, `providerName`. |
| `src/server/setup/` | `index.ts` (`mountSetup`), the Droid installer, its sign-in, `setup.json`. |
| `src/server/subscriptions/` | `index.ts` (`mountSubscriptions`), the DroidProxy installer, the control API client, availability and the gate. |
| `src/server/team.ts`, `bin/office-workers.js` | `office-workers models` and `hire` with availability. |
| `src/client/ui/welcome.ts`, `subscriptions-settings.ts`, `droid-settings.ts` | The welcome and the two Settings cards. |
| `src/client/ui/models.ts`, `model-search.ts`, `model-picker.ts`, `subagent-models.ts` | Availability in pickers. |
| `android/` | Availability in the hire sheet. |
| nikships/droidproxy `src/Sources/` | The control API, the controller it shares with the settings window, `/models`. |

## Testing

Unit tests stub the network and the binaries (`fetchImpl`, a fake `droid` and a fake control API), because CI has neither. The installers are tested on a real download in the owner's clone: Droid into a throwaway `HOME`, DroidProxy only with the owner's go-ahead (it replaces their app). The welcome is checked end to end in a clone of the owner's office whose `HOME` has no Droid, and Subscriptions against the owner's real DroidProxy and accounts.

# Setup and Subscriptions

Someone who has never used Droid or Factory downloads Droid Office, opens it, and is hiring workers a few minutes later, on the Claude or ChatGPT plan they already pay for, without having to know what Droid or DroidProxy is. This is the plan for that work and the contract its pieces follow. Status: **implemented** (nikships/droid-office#293). Subscriptions need DroidProxy 1.8.180 or later, the first release with the control API.

Three things stand between a fresh Mac and a first worker, and the office does each one itself:

1. **Droid**, Factory's coding agent, which every worker is. The office downloads, verifies and installs it.
2. **A Factory account or Airgapped mode**. Sign in through Droid's own device flow, or use local/BYOK models without an account.
3. **Subscriptions** (optional, macOS on Apple silicon): the owner's Claude, ChatGPT and other plans, served to Droid by [DroidProxy](https://github.com/nikships/droidproxy), a small menu-bar app. The office installs and drives DroidProxy, connects accounts and puts their models into Droid.

## Factory subscription limits

Factory's own Standard and Droid Core token windows are a separate quota source from DroidProxy. The office reads them through its Factory connection on every supported platform, even without DroidProxy installed. See [Factory limits and overage](factory.md#limits-and-overage) for the API and eligibility rules.

Quota rings and subscription sheets show three nested windows (5-hour, Weekly, Monthly) for each Factory tier, reset times, Extra Usage balance and the active overage preference. Settings → Connections → Factory and Thread `/limits` open the same limits controls; Android's subscription sheet mirrors them. Hosted model pickers and all hire paths explain exhausted tiers or inactive subscriptions with countdowns and runnable alternatives. BYOK and DroidProxy models keep their existing eligibility. Unreadable/unconnected limits never refuse a hire.

`team_models` and `models_list` prepend Factory Standard and Factory Droid Core to `Subscription quotas:` (including `only: "quotas"`), with remaining windows, overage mode, balance and cooldowns. Hosted models expose `factoryUsage`, `cannotRun` and `cooldown`; the text names the tier on the model's line (`plan: Factory Standard`) instead of repeating its windows. Worker inspections combine the same limits with live retries, rate limits and 402 exhaustion into `modelStatus`, including reset timestamps/countdowns and an overage hint. Lead and Orchestrator guidance weighs both Factory tiers alongside DroidProxy quotas and credit multipliers.

## The owner's decisions

- The office's word for it is **Subscriptions**: the welcome step and the ⚙️ Settings pane are called that, and DroidProxy is named underneath as the app that does it.
- No policy bans on models. Every model the owner enabled stays usable, by them and by leads hiring subagents. The office refuses a model only when a worker on it can't run: its provider has no signed-in account, the provider is switched off, every account is out of quota, or DroidProxy isn't installed. That applies to every hire: the owner's own, `team_hire` in the [Office MCP](office-mcp.md).
- Quota comes from DroidProxy's usage data (the same as `GET /droidproxy/usage`). When nobody can tell (an older DroidProxy, a provider with no usage API, DroidProxy not answering for a while), the model is not refused.
- Factory account mode requires sign-in and never promises it is free. Airgapped mode requires at least one usable configured custom model instead.

## Airgapped (no-account) mode

Choose **Use without an account (airgapped)** on the welcome's Factory step, or switch **Airgapped mode** in **Settings → Connections → Droid** at any time. The facts line says **airgapped · no Factory account**, even when credentials already exist. Turning it off restores normal sign-in checks and the **Sign in** button when needed. Neither Droid credentials nor the Office Factory API key are deleted.

This is an Office setting, not Droid's enterprise airgap build. Office persists `airgapped` beside `onboarded` in office-wide `.droid-office/setup.json`; old files default to account mode. `setup.check` skips Factory auth probes while enabled and reports the installed Droid and usable custom-model ids. Onboarding does not finish until a usable custom model is selected. Connect DroidProxy, or add a `customModels` entry to `~/.factory/settings.json`, then press **Check again**. A configured model whose subscription cannot run does not count; unknown quota does not refuse a model.

Worker pickers and Office MCP discovery offer custom models only. Hosted/Router models, stale hosted defaults and fabricated custom ids are refused by the worker model gate, including resumes and model changes. Choose a custom model as the office default in **Settings → Models** if a saved default was Factory-hosted. No settings in Droid's own profile are rewritten.

The agent loop, workers, MCP, skills, hooks and local/BYOK model endpoints remain available. Factory-hosted models and Router, billing/usage, session sync/sharing, Slack, built-in web search/URL fetch and readiness reports need Factory and are unavailable. Office pauses its Factory connection and hides its account/usage slices, disables Factory API routes and cloud actions with an explanation, and keeps the saved key for switching back. Factory-backed worker labels are unavailable; OpenAI-compatible label endpoints still work.

**Not network-silent:** the public Droid build may still attempt telemetry, feature flags, billing-limit checks and custom-model usage recording. Office's install/update checks still use the network. This switch is not a firewall or sandbox, and does not change Droid itself or stop already-running turns. External network/filesystem policy is needed for isolation; overriding `HOME` alone does not prevent access to the real Factory cache. The optional network-blocking hardening is not implemented here.

Implementation was checked against the installed public Droid **1.7.1**, the issue's tested release, and the current [enterprise airgap documentation](https://docs.factory.com/enterprise/airgapped-deployment). That dedicated build is not publicly distributed. A real BYOK turn still requires a configured reachable model endpoint; unit tests cover Office's setup and launch gates, not model inference.

## The welcome

A fresh office opens the welcome by itself once the page has loaded, while `SetupState.onboarded` is false and the office knows where Droid stands: missing, or its sign-in known (`needsWelcome` in `src/shared/setup.ts`). The first check after a start that can tell decides an office with no `setup.json` and writes it: Droid installed and signed in is an office that already worked, `onboarded: true`, and it never sees the welcome; anything else is a fresh office, `onboarded: false`. Signing in later doesn't change it, so a reload or a restart in the middle brings the welcome back at its next step instead of losing Subscriptions and Ready. It is done (`setup.onboarded`) when the owner presses **Start**, or closes it once Droid can run; closed before that, it stays shut in that tab and opens again on the next load. The ☰ menu opens it again at any time, and so does anything that finds Droid missing.

It is one window with four steps down the side, each a ✓ once done, and the current one on the right. Every step reads only `store.setup` and `store.subscriptions`, so a step finished in another tab, by the server, or in DroidProxy's own window shows as done here too.

1. **Droid**: what it is in one line, Install, a progress bar, then the version. Where the office can't install it (`canInstall` false: Windows, an odd architecture), the one-line manual install and Check again.
2. **Factory account**: Sign in, or **Use without an account (airgapped)**. Sign-in shows the device code and browser link. Airgapped mode completes this stage without sign-in and explains available features and network limitations.
3. **Subscriptions** (only where `proxy.phase !== 'unsupported'`): Claude and ChatGPT as two big choices, the other providers behind "More". Connect installs and starts DroidProxy when it has to (the server does that in order), then opens the provider's sign-in in the browser on the office's Mac, or shows a device code. A connected account shows its email and how much of each usage window is left. Skip is always there.
4. **Ready**: the model new workers start on, preselected to the best one that can run (`readyModel`: a just-connected subscription's flagship, else the office's current default, else Claude's or ChatGPT's, then any subscription's), in a `modelPicker`. Start sets it as the office's default worker, closes the window (which sends `setup.onboarded`) and tells the owner how to hire.

## Droid (`src/server/setup/`)

- **Where it is.** `resolveAgent` in `workers.ts`: the agent command on PATH or the login shell's, else `~/.local/bin/droid` (where Droid's installer puts it, which the Mac app's PATH lacks). After an install, `agentChanged(path)` points every floor (`WorkerManager.setAgentPath`), the task namer and the model catalogue at it.
- **Version.** `droid --version`. The newest release is `https://downloads.factory.ai/factory-cli/LATEST` (a bare version), read at start and every 6 hours.
- **Install and update** do what `curl -fsSL https://app.factory.ai/cli | sh` does, in Node, with more checks: download `https://downloads.factory.ai/factory-cli/releases/<version>/<darwin|linux>/<arm64|x64|x64-baseline>/droid` (x64 without AVX2 is `x64-baseline`) and its `.sha256`, compare the SHA-256, on macOS check `codesign --verify --strict` and that `codesign -dv` names `TeamIdentifier=SW6TL4V6Q5` (Factory's Developer ID), `chmod 755`, then write it to `~/.local/bin/droid` through a temp file in the same folder and a rename, so a running worker keeps the binary it started with. Progress goes out as `droid.progress`. The office never edits shell profiles and never kills running droids.
- **Signed in.** `droid doctor --json --checks auth`, which exits 0 signed in or not: signed in when every `auth.*` result but `auth.workosRefresh` (a network probe that passes either way) passes, signed out when one doesn't (`auth.verify` warns "no usable credentials found"), unknown when there's no `auth.verify`. The account is the masked email `auth.verify` names ("authenticated as n***@gmail.com"). Checked at start, after an install, every 30 minutes, on `setup.check`, and every 3 seconds during a sign-in.
- **Sign-in.** Droid has no sign-in command: its TUI opens on "Please login with your Factory account to continue" with `> Login` selected, and Enter starts a device flow that prints "please visit https://auth.factory.ai/device and enter code XXXX-XXXX" and runs `open https://auth.factory.ai/device?user_code=XXXX-XXXX`. The office runs `droid` in a PTY (`@lydell/node-pty`, in a temp folder), presses Enter once the Login menu shows, and gets the code and URL two ways: from the screen text, and from a shim `open` (first on that process's PATH, with `xdg-open` and `$BROWSER` for Linux) that records its argument instead of opening anything. Droid 0.249.0 on macOS calls the `open` on its PATH. The client opens the URL in the owner's browser, so it works from a browser on another machine too. Once `doctor` says signed in, the PTY is killed. A sign-in times out after 15 minutes. If Droid shows something the office doesn't recognize, it stops and says to run `droid` in a terminal.
- **Sign-in cleanup.** Completion and cancellation wait for the sign-in process to exit before removing its temporary working folder, so final writes cannot race deletion. The existing two-second SIGKILL fallback still applies when SIGTERM is ignored.
- **State file.** The office's `.droid-office/setup.json`: `{ "onboarded": true, "airgapped": false, "at": <ms> }`. Writes are atomic and serialized so concurrent welcome completion and mode changes cannot overwrite one another.
- **Another agent command.** With `--agent` naming something other than `droid`, the office runs that and never installs a droid beside it (`canInstall` is false).

## Subscriptions (`src/server/subscriptions/`)

- **Where DroidProxy is.** Only on macOS arm64; anywhere else the phase is `unsupported` and nothing else here runs. Installed means `/Applications/DroidProxy.app` or `~/Applications/DroidProxy.app` with `CFBundleIdentifier` `com.droidproxy.app`; its version is `CFBundleShortVersionString`. Running means its control API answers (see below). Running but without a control API is `outdated`.
- **Install and update.** The newest release is `gh api repos/nikships/droidproxy/releases/latest` (`tag_name` `v1.8.179`; assets `DroidProxy-arm64.zip` and `DroidProxy-arm64.zip.sha256`), read with the owner's signed-in `gh` at start and every 6 hours (never GitHub's unauthenticated REST API). The office downloads the zip, checks its SHA-256, unpacks it with `ditto -x -k` into a temp folder, checks `codesign --verify --deep --strict`, `TeamIdentifier=NW6B3R27LQ` and `spctl -a -t exec` (notarized), quits a running DroidProxy (`osascript -e 'quit app id "com.droidproxy.app"'`), replaces the app (in `/Applications` when it can write there, else `~/Applications`) and starts it. DroidProxy keeps its own Sparkle updates; the office's update is the same release, checked the same way.
- **Starting it.** `open -g -a <app> --args --launched-by droid-office`: in the background, and DroidProxy opens no window of its own when started that way. The office starts it when the owner asks, when a connect needs it, at office start when Droid's settings already have DroidProxy models, and when a hire on one of its models finds it stopped.
- **Polling.** While running: `GET /status` and `GET /models` on the control API every 60 seconds, every 2 seconds while starting or a connect is in flight, plus a throttled on-demand recheck (at most every 15 seconds via `subscriptions.recheck`) when a lead calls `team_models` or inspects a worker retrying a subscription model. `GET /droidproxy/usage` (account windows) has a separate five-minute minimum between attempts, including failures, manual refreshes and on-demand rechecks; intervening checks keep the original sample timestamps. DroidProxy's shared per-account quota cache must cover both `/models` and `/usage`, including simultaneous requests: `/models` also reads upstream quota. Claude quota reads are at least five minutes apart with jitter, persistent 429 backoff and `Retry-After`; status checks do not spend that budget. Stopped or missing: look again every 30 seconds. Never block a WebSocket handler on DroidProxy; keep the last good state with `checkedAt`.
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

## What a plan has left, for whoever picks the model

`team_models` and `models_list` prepend a compact per-provider `Subscription quotas:` summary (`quotas`: 5-hour and weekly remaining percentages, reset countdowns and ISO timestamps, runnable model counts, and active cooldowns; `team_models` accepts `only: "quotas" | "subscriptions" | "available" | "all"`), and tag each model's line with the row it draws on (`plan: ChatGPT`, `plan: Factory Standard`), so a plan's numbers are said once however many models share it. A lead can prefer a plan with plenty of quota (it costs no Factory credits) and keep a nearly spent one off long tasks. Subscription models keep their structured `usage` and `cooldown` in the tool result. Worker inspection tools (`office_look`, `worker_log`, `team_status`) combine live terminal retry detection (`Retrying the model request...`, `429 model_cooldown`, `usage_limit_reached`) with DroidProxy model availability and usage windows so a worker blocked on subscription quota surfaces `modelStatus` (`cooldown`, window, reset countdown and ISO timestamp) instead of looking hung. It is `TeamModel.usage` (`ModelUsage` in `src/shared/subscriptions.ts`), worked out once by `modelUsage` from the same provider slice the Subscriptions panel reads; `summarizeProviderQuotas` folds it into the provider's row and `modelPlanName` names that row on each model. The rules below shape both the structured `usage` and the row.

- The provider comes from `modelProviders`; only its accounts that are signed in, not expired and not switched off count.
- **Several accounts: the account with the most left.** DroidProxy serves a request while any account has quota, and marks a model exhausted only when every account is out, so the best account is what a hire can count on. "Most left" is the highest of an account's lowest window. The line shows that one account's windows (never the best of each window mixed from two accounts) and says `best of N accounts` when there are several.
- Windows named for another model family (`Weekly (Opus)` on a Sonnet model) are left out, as DroidProxy judges them.
- A sample older than 10 minutes says how old it is (`read 40 min ago`). A reset time already past says `reset due since …`. Times print to the second (`2026-11-16T19:55:10Z`).
- No account with usage: `usage couldn't be read (the reason DroidProxy gave)`.
- A model that can't run keeps its `Cannot run:` and `Cooldown resets at:` lines; a signed-out or switched-off provider has no usable account, so no usage. Models that are neither subscription nor Factory-tier models have no `plan:` tag.

## Pace

A percentage alone doesn't say how far it goes: the same 15% is days of work on one plan tier and minutes on another, and nobody, lead or office, is told which tier an account is on. The office measures it instead (`UsagePaceTracker`, `src/server/subscriptions/pace.ts`).

- **Busy time.** Every 10 seconds, and at every look at DroidProxy, the office records which office workers are busy on a turn (`status: 'working'`, local agents on every floor and Mission Control) and the subscription model each runs (`activeModel`, else `model`). The time since the previous look counts for whoever was busy then, at most 3 minutes per gap, so a sleeping Mac adds nothing.
- **Usage.** Each new usage sample (an account's `usageUpdatedAt` moved; for an account without one, a percentage or reset time moved) closes an interval for its provider: the busy milliseconds per model since the last sample, and the percentage points each window rose, summed over the provider's live accounts. A window that reset in between (its percentage fell, or its reset time passed) is left out of that interval. Usage that lands while nobody is busy goes to the interval just before when there was one (usage often arrives a sample late), and is ignored otherwise (the owner working outside the office).
- **History.** Intervals with busy time from the last 7 days, in office-wide `.droid-office/usage-pace.json`.
- **Rate.** Per window: points used over busy worker-hours on the models that window meters (only Opus time counts for `Weekly (Opus)`). A model gets its own rate once intervals where it had at least 90% of the provider's busy time add up to half a worker-hour; until then it gets the provider's rate over all its models. Fewer than half a worker-hour in total, or for every window, is `learning`.
- **Worker-hours left.** What is left of the window across all live accounts (DroidProxy moves on to the next account when one runs out) divided by the rate. A model's pace leaves out a window named for another family (`Weekly (Opus)` on Sonnet); the provider's pace lists every window.
- **Where it shows.** `ModelUsage.pace` (this model) and `providerPace` (the provider). The provider's line in `Subscription quotas:` ends with `pace: 5-hour ~9% per worker-hour (about 10 worker-hours left), Weekly ~1.5% per worker-hour (about 23 worker-hours left); measured over 3.2 worker-hours on all Claude models in the last 7 days`, or `pace: still learning: …`. A model with a rate of its own adds `Pace on this model: …` under its line. Rates are per busy worker: three workers at once go three times as fast, which lead and Orchestrator guidance says.

## Benchmarks

**⚙️ Settings → Connections → Model benchmarks → Artificial Analysis** connects an [Artificial Analysis](https://artificialanalysis.ai) Data API key (`Benchmarks`, `src/server/benchmarks.ts`; office-wide `.droid-office/artificial-analysis.json`, mode 0600, with the last read; the key never reaches a client, a log line or an error). A free key is enough.

- **Reading.** `GET https://artificialanalysis.ai/api/v2/language/models/free?page=N` (header `x-api-key`) until `pagination.has_more` is false, at most 10 pages (about 4 today, of the free tier's 100 requests a day). Connecting reads it at once and keeps the key only if that works. After that the office reads it again once it is a day old (looking every hour, never more than once an hour after a failure), or on **Read now**. A failed read keeps the benchmarks from before and shows why (`401` rejected key, `429` with the wait from `Retry-After`). Airgapped mode reads nothing; turning it on stops a read before its next page. A connect or disconnect while a read is under way wins: the older read saves nothing.
- **Shape.** Each row's name is a family plus a reasoning setting in parentheses (`Claude Opus 5.5 (High, Default Fallback)`); rows group by family with one `BenchmarkVariant` per effort (`low` … `max`, `reasoning`, `non-reasoning`): Intelligence Index, Engineering index, dollars per Intelligence Index task (`artificial_analysis_intelligence_index_cost.cost_per_task.total_cost`) and output tokens per second. The first word in the parenthesis is the effort; the rest (`Default Fallback`) is Artificial Analysis's note on how it ran that effort and is dropped. A parenthesis that isn't a setting (`Gemini 1.5 Pro (Sep '24)`) stays part of the name. Rows with neither score are dropped. Artificial Analysis publishes no Coding or Agentic index any more.
- **Matching rules** (`matchBenchmark`, `readModelName`). A Droid model's display name (its id when Droid gives none) matches the family whose name reads the same after dropping `Gateway:` prefixes (`DroidProxy: Antigravity:`, `custom:droidproxy:`), a reasoning-effort suffix (`(High)`), case, hyphens and a leading brand word (`DroidProxy: Opus 5.5` is `Claude Opus 5.5`, `DroidProxy: GPT 6.1 Sol` is `GPT-6.1 Sol`). An id reads as a name (`gemini-4-carbon`; `claude-opus-5-5` is version 5.5; a trailing `-high` is the effort, while `-max` stays, since names such as Qwen3 Max end in it). Only when exactly one family fits: the name without trailing parentheses that aren't an effort (`Gemini 4 Carbon (Interactions proxy)`), a family Artificial Analysis still calls `Preview`, or the same words in another order (`Haiku 4.5` is `Claude 4.5 Haiku`). Versions must match exactly (`Opus 5` is not `Opus 5.5`), and a dated family matches only a name with its date.
- **Gemini Decisions fallback.** With [Gemini Decisions](guide/how-it-works.md) connected (`GeminiDecisionsStore`) and not airgapped, a name no rule matches is queued the first time `forModel` sees it; a second later one `POST /v1beta/decisions` asks about every queued name, one `choice` question each over every family plus `none`, the name repeated in its instructions since questions can't see their keys. An answer counts only at probability 0.8 or more, and only when the family's version numbers are the name's (`PostHog Claude Opus 5.5` can be `Claude Opus 5.5`, never `Claude Opus 5`); anything else is saved as no match, since a wrong family is worse than none. Answers are cached in `artificial-analysis.json` (`aliases`, keyed by name with a fingerprint of the family list, at most 200), so `team_models` never waits on the network. A refresh that lists other families asks again about every cached name in one request; a failed request saves nothing and that name waits an hour. Without Gemini Decisions the rules alone answer and nothing is asked.
- **Where it shows.** `TeamModel.benchmarks`, printed by `benchmarkWords` as `Benchmarks: medium* 46.3/52.1 $0.36 · low 34.8/42.6 $0.16 · high 50.3/55.4 $0.59 …` (intelligence/engineering and dollars per task) for the efforts the model takes, default first and starred. `team_models` and `models_list` say once above the models where the numbers come from and what they mean, that `*` marks the default effort (also on the model's `effort low/medium*/high` list) and that `plan:` names the quota row (attribution is a condition of the API). Dollars per task are what one task costs at the creator's API prices (tokens spent times price), not plan quota; [Pace](#pace) measures how fast a plan runs out. A model measured at one unnamed setting prints just its numbers.
- **What the numbers are.** They are Artificial Analysis's own, row for row: Claude Sonnet 5.5 really scores 25.6, 30.8, 41.5, 49.9 and 54.5 from `low` to `max` (its model page rounds High to 42), so at its `high` default it sits below Opus 5.5 and GPT-6.1 Sol at theirs (`tests/benchmarks.test.ts` keeps those rows).

## Where a model is refused

| Where | What happens |
| --- | --- |
| `WorkerManager.spawn` (`modelGate`) | Every hire of an agent: the owner's, subagents'. Refused with `availabilityWords`: "Can't hire on GPT 6.1 Sol: out of quota, back in 3 h 10 min (5-hour). Pick another model." |
| `team_models` | Each model that can't run says why on its own line, and the default too. A subscription or Factory-tier model names its quota row (`plan: ChatGPT`, above), and gets its own "Pace on this model" once measured ([Pace](#pace)). |
| `team_hire` | A model that can't run, named or the default, is refused before a desk is taken, naming the ones that can. |
| Model pickers (web and Android) | Shown dimmed with the reason and not pickable; a stopped DroidProxy only shows a note. |

## The UI

- **Compute wall**: a third screen to the right of Droid Computers shows every connected DroidProxy account, remaining quota for each reported window, reset countdowns and local reset dates. Paused, expired, unreported and cached usage have separate states. Account sample timestamps, not control-status checks, establish freshness; an elapsed reset waits for confirmation. More than two windows continue on additional cards; complete pages rotate every 20 seconds beyond six cards. The wider bezel sits above the exit sign and windows; the rack stays put.
- **Welcome**: `src/client/ui/welcome.ts`, opened from `main.ts` and the ☰ menu.
- **⚙️ Settings → Connections**, with Factory, Jira and Linear: "DroidProxy" (what it is, its phase and version, Install / Update / Start / Open DroidProxy), "Accounts" (each provider: switch, its accounts with a usage bar per window and when it resets, Connect / Add another / Remove, a connect in flight with its code), "Models in Droid" (how many, Update models when stale). Off a Mac with Apple silicon, those groups say Subscriptions need DroidProxy on a Mac and stop there.
- **⚙️ Settings → Connections → "Droid"**: version and Update to …, account or airgapped status, Airgapped mode toggle, Sign in in account mode, and Check again.
- **Companion Subscriptions** (the web companion's top bar, Android's Me → Subscriptions): read-only. DroidProxy is one line (version and how many models are in Droid, else its phase). Each account of a provider that is on is a quota ring with the provider's logo inside, one arc per usage window, grouped under the provider. Hovering, focusing or tapping a ring shows each window's quota left and when it resets (a tooltip on the web, a detail panel on Android); the ring's accessible name reads every window. Providers that are switched off, or on with nobody signed in, are one muted line each. Accounts are managed in Settings → Connections on the office's Mac (`subscriptions-rings.ts`, `SubscriptionsSheet.kt`).
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
| `src/shared/subscriptions.ts` | `SubscriptionsState`, `ModelAvailability`, `cannotRun`, `availabilityWords`, `providerName`, `UsagePace`, `paceWords`. |
| `src/server/setup/` | `index.ts` (`mountSetup`), the Droid installer, its sign-in, `setup.json`. |
| `src/server/subscriptions/` | `index.ts` (`mountSubscriptions`), the DroidProxy installer, the control API client, availability and the gate, `pace.ts` (`UsagePaceTracker`). |
| `src/shared/benchmarks.ts`, `src/server/benchmarks.ts`, `src/client/ui/benchmarks-settings.ts` | Artificial Analysis benchmarks: names and words, reading and the key, the Settings card. |
| `src/server/team.ts`, `src/server/office-mcp/team.ts` | Team tools with model availability. |
| `src/client/ui/welcome.ts`, `subscriptions-settings.ts`, `droid-settings.ts` | The welcome and the two Settings cards. |
| `src/client/ui/models.ts`, `model-search.ts`, `model-picker.ts`, `subagent-models.ts` | Availability in pickers. |
| `android/` | Availability in the hire sheet. |
| nikships/droidproxy `src/Sources/` | The control API, the controller it shares with the settings window, `/models`. |

## Testing

Unit tests stub the network and the binaries (`fetchImpl`, a fake `droid` and a fake control API), because CI has neither. Pace (`tests/usage-pace.test.ts`, and end to end through `mountSubscriptions` in `tests/subscriptions-state.test.ts`) and benchmarks (`tests/benchmarks.test.ts`, rows trimmed from the owner's free-tier read, with Gemini Decisions answers stubbed in the API's shape) run on the fake clock. The installers are tested on a real download in the owner's clone: Droid into a throwaway `HOME`, DroidProxy only with the owner's go-ahead (it replaces their app). The welcome is checked end to end in a clone of the owner's office whose `HOME` has no Droid, and Subscriptions against the owner's real DroidProxy and accounts.

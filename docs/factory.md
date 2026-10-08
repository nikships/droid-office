# Factory in Droid Office

The office can be connected to [Factory](https://factory.ai) with a Factory API key. With it, the office shows Factory on its wall boards and acts on Factory: cloud computers (Droid Computers), Droid sessions and their credits, CI automations, AutoWiki, and cloud workers (office workers whose Droid session runs on a Factory computer). It is a real feature, polished and complete, not a demo.

This is the plan for that work and the contract every Factory feature follows. Status: **in progress**. The foundation (the connection, the API client, the feature registry, the Settings pane) is built; the features themselves are being built on it.

## The owner's decisions

- Build all of it: the compute wall and the Computers window, the Sessions & credits board with credits per office worker, the CI automations board, AutoWiki on the bookshelf, and cloud workers.
- Actions are full: create and delete computers, start cloud sessions, open CI workflow PRs and start wiki runs, along with the safe ones (wake or restart, refresh, send a message, interrupt).
- Only non-enterprise features. Service accounts (402, "requires a Teams plan") are out. Enterprise controls history and org admin (invites, removing members, credit limits) are of little use in a single-owner office: at most a small read-only org and limits line, and no admin UIs.
- The basketball hoop is gone. Its west-wall slot, between the exit door and the kitchen, is for the expanded compute wall.
- The key is entered in ⚙️ Settings → **Factory**, the office's own Settings window, which the Mac app shows and which works in a browser too.

## Factory's public API

- Base URL `https://api.factory.ai`, every path under `/api/v0`, header `Authorization: Bearer <key>`. Docs: <https://docs.factory.com/api-reference>. The live OpenAPI spec also has endpoints the docs pages don't show: `GET/PATCH /organization/computer-secrets`, `GET /sessions/{id}/children` and `GET /wiki/upload-access?repoUrl=`.
- Several response schemas in the spec are empty (`{}`): CI jobs, runs and scan, and every wiki answer. The shapes in `src/shared/factory-*.ts` come from real answers instead. Where the account had no data yet (CI runs, wiki runs), a parsed item keeps the fields it most likely has and `raw`, the item as the API sent it.
- Tests use an injected fake `fetch` and fake keys like `fk-test-…`. Never commit a real key, or put one in a test, fixture, log line, PR body or commit message.

What a key reaches, from the owner's account:

| Group | Access | Notes |
| --- | --- | --- |
| Computers | ✓ | A managed computer (`providerType` `e2b`) and a BYOM one (`byom`). `GET /computers/{id}/metrics` is an array of 5-minute samples `{timestamp, cpuUsedPct, cpuCount, memUsed, memTotal, diskUsed, diskTotal}` going back about four days; a BYOM computer answers 400 "Metrics are not supported for BYOM computers", and a managed one that's asleep answers `[]` for a recent `?start=`. Providers: `["e2b"]`. |
| Sessions | ✓ | List items: `sessionId`, `title`, `status` (`idle`, `pending`, `running`), `messageCount`, `createdAt`, `updatedAt`, `computerId?`, `artifacts[]` (pull requests and so on). `factoryCredits` is only on `GET /sessions/{id}`. The office's own workers' sessions are in this list (`WorkerInfo.sessionId` matches `sessionId`), so credits per worker work. |
| CI automations | ✓ | The scan finds the Droid workflows across the account's repositories (`templateId` like `code-review`, triggers, model, cron, `droidActionInputs`) and says how long it caches (`cacheTtlMs`, 30 minutes; `?forceRefresh=true` skips it); `repositories` lists about a hundred (`?owner=` narrows it). `jobs` lists the workflow PRs opened through `POST /automations/ci/edit`, whose body is not documented (see [CI automations](#ci-automations)). `runs` was empty for this account. |
| Wiki | ✓ | The request body of `POST /wiki` is not documented. |
| Organization | ✓, thin | Users, no credit limits, no enterprise history; computer secrets by name only. |
| Service accounts | ✗ | 402, Teams plan. Out of scope. |

How the API behaves, and what the office does about it:

- `GET /sessions` (and sometimes `GET /sessions/{id}`) **hangs 30 to 90 seconds on a cold call**, then answers in about a second. The client gives calls under `/sessions` 60 seconds and everything else 20, and tries a GET once more after a timeout or a network error. Always pass `limit` (at most 100). Never block a WebSocket handler or a page on Factory: keep showing the last good data with its age.
- Poll politely: computers every minute, metrics every few minutes (they're 5-minute samples), sessions every 90 seconds, CI and wiki every 5 minutes. Faster only while someone looks at the board or window, or while something is in flight (a computer provisioning, a cloud session running).
- Errors are `{detail, status, title}`. 401 is a bad key, 402 a plan, 403 a role. A 429 may carry `Retry-After`.
- Undocumented request bodies (CI edit, wiki create): find them with deliberately invalid requests (an empty body, missing fields) and read the validation errors; the `droid` CLI bundle may show the shape too. Don't run a real write against the live account (create or delete a computer, open a CI PR, start a wiki run, start a cloud session that costs credits) without the owner's go-ahead. Reads are free to run.

## Shape of the code

| Where | What |
| --- | --- |
| `src/server/factory/api.ts` | `FactoryApi`: fetch with the Bearer key, JSON, query params, per-request timeouts, one retry for GETs, `FactoryError {status, title, detail, retryAfter?, timedOut}`, the key redacted from every message. Small raw readers for the GETs the probe and the first pollers use. |
| `src/server/factory/office.ts` | `FactoryOffice`: the key in the office's `.droid-office/factory.json` (mode 0600, temp file and rename), the probe, whose key it is, rejected, disconnect. |
| `src/server/factory/feature.ts` | The contract: `FactoryFeature`, `FeatureHost`, `FactoryRoute`, `FactoryRequest`, the `SliceFeature` base class and the route helpers. |
| `src/server/factory/registry.ts` | `FactoryRegistry`: runs the pollers, keeps the watches, broadcasts, dispatches routes. |
| `src/server/factory/index.ts` | `mountFactory`: makes the connection and the registry, registers every feature, handles the `factory.*` messages. server.ts calls only this. |
| `src/server/factory/<feature>.ts` | One module per feature: `computers.ts`, `sessions.ts` (with `credits.ts`, its ledger), `ci.ts`, `wiki.ts`, `cloud.ts`. |
| `src/server/factory/new-session.ts` | `whileNew`: a write to a session made in the last 30 seconds tries again after a 404 (see [Droid sessions](#droid-sessions)). |
| `src/shared/factory.ts` | `FactoryState`, `FactoryConnection`, the probe's groups and capabilities. |
| `src/shared/factory-<feature>.ts` | Each feature's slice type and the parsers that turn the API's answers into it. |
| `src/client/factory.ts` | `factoryFetch`, `watchFactory`, `refreshFactory`, `onFactorySetup`. `store.factory` (topic `'factory'`) in `src/client/state.ts` holds the state. |
| `src/client/ui/factory-settings.ts` | ⚙️ Settings → Factory → *Factory API key*. |
| `src/client/ui/factory-*.ts`, `src/client/world/factory-*.ts` | A feature's windows, and its wall textures and meshes. |

The key is the building's, like the Jira connection: browsers never get it. They get `FactoryConnection`: whether it's connected, the fingerprint (`fk-…` and the last four), whose key it is (name and email), the organization's member count, who connected it and when, what it can reach, when it was last checked, and whether Factory has rejected it since. The key never goes into a worker's environment or a log, and error messages are scrubbed of it.

### The connection

`connect(key, by)` checks the key with one cheap GET per group, all at once: computers (`/computers/providers`), sessions (`/sessions?limit=1`), CI (`/automations/ci/repository-owners`, which also says whether Factory's GitHub integration is connected), wiki (`/wiki`), organization (`/organization/users`) and service accounts (`/service-accounts`, expected to be a 402). Alongside, `/computers` says whose key it is: the human `ownerId` of its computers, matched against the organization's users, else the only user there is. The answer (`factory.setup`) goes out once everything but sessions is back; the sessions group reads *checking* until its slow call lands. A key every answering group turns down with a 401 is refused; so is a key nobody answered for.

Each group comes out `ok` (with what it found, like "GitHub connected"), `denied` (with why: "Needs a Teams plan", "Key rejected"), `checking` or `error` (a timeout or a 5xx). The office checks the saved key again at every start and on **Check again**; while it does, every group reads *checking* until its own probe answers, and `connection.checking` stays set until the last one (usually sessions) has. A 401 on any later call marks the key *rejected*: Settings says so, `client()` returns nothing, and every feature stops polling until the key is checked again or replaced. Disconnecting deletes `factory.json` and resets every feature's slice. Replacing the key with another one resets them too.

### Messages

| Message | What it does |
| --- | --- |
| `welcome.factory`, `{ t: 'factory', state }` | Every connection gets the whole `FactoryState`, at arrival and on every change (coalesced: at most a few broadcasts a second). A poll that read the same data doesn't go out: broadcasts compare the state with every `fetchedAt` reduced to read-or-not, and a state that differs only there goes out once `HEARTBEAT_MS` (a minute) after the last one, so ages stay right. |
| `factory.connect {key}` | Checks and saves a key; answered to the sender with `factory.setup {ok, error?}`. |
| `factory.disconnect` | Forgets the key and every feature's data. |
| `factory.refresh {feature?}` | Polls one feature now; without one, checks the key again and polls every feature. |
| `factory.watch {feature, on}` | A board or window of the feature opened or closed in that tab. Dropped when the connection closes. |

## The feature contract

A Factory feature is one slice of `FactoryState`, a poller that fills it, and HTTP routes for its actions and on-demand reads. It touches only its own modules plus a line in `mountFactory`, and its client code. To add one, or grow one of the four that are there:

1. **Its slice type** in `src/shared/factory-<feature>.ts`: `fetchedAt` (ms, 0 before the first read; name any other time a poll stamps `fetchedAt` too, so a poll that read nothing new doesn't make a broadcast), `error?` (why the last read failed, shown beside the last good data), and the data. Put the parsers from the API's raw answers there too, so the server and the client share them. Add the slice to `FactoryState` and `emptyFactoryState` in `src/shared/factory.ts` (and its id to `FactoryFeatureId` and `FACTORY_FEATURES`, for a new feature).
2. **Its server module** in `src/server/factory/<feature>.ts`, implementing `FactoryFeature` (`feature.ts`), usually by extending `SliceFeature`:

   ```ts
   export class ComputersFeature extends SliceFeature<'computers'> {
     readonly interval = 60_000; // between polls normally
     readonly fastInterval = 15_000; // while watched or busy
     readonly routes: readonly FactoryRoute[] = [
       { method: 'POST', path: '/:id/restart', handle: async ({ api, params, by }) => { … } },
     ];
     constructor(host: FeatureHost) {
       super('computers', host, emptyComputers);
     }
     busy() {
       return this.slice.items.some((c) => c.status === 'provisioning');
     }
     async poll(api: FactoryApi) {
       const r = await api.computers();
       this.set({ items: …, fetchedAt: Date.now(), error: undefined });
     }
   }
   ```

   - `poll(api)` reads Factory and calls `this.set(…)`, which tells the registry the slice changed. It throws when the read failed; the registry then calls `failed(err)` (which keeps the data and sets `error`) and backs off. Clear `error` on success.
   - `busy()` (optional) is "something is in flight": it polls at `fastInterval` until it isn't.
   - `reset()` forgets everything (disconnect, another key). `SliceFeature` puts the empty slice back.
   - `host.pollSoon()` polls again now, past the interval and any backoff, after an action changes something. `host.toast(text)` tells everyone, and `host.api()` is the API outside a poll.
3. **Register it** in `mountFactory` (`src/server/factory/index.ts`): `registry.register((host) => new ComputersFeature(host))`.
4. **Its routes** are served at `/api/factory/<feature><path>`, behind the office's access gate like every `/api/*` route. `path` may have `:name` segments, which arrive in `params`. `handle` resolves to the JSON to answer with (200), and gets `api`, `params`, `query`, `json()` (the body, a 400 when it isn't JSON, at most 256 KB unless the route sets a bigger `bodyMax` in bytes) and `by` (the page's player name). Throw `badRequest(…)`, `notFound(…)` or an `HttpError` for anything else; a `FactoryError` passes through as the right status with its message (a 401 from Factory answers 502 and marks the key rejected). A route runs only while the office is connected (409 otherwise). Anything but a GET needs the office's own page or a paired phone, so a web page can't drive Factory through the owner's loopback (403).
5. **Its client code**: read `store.factory.<feature>` and listen for `'factory'`. Call `watchFactory('<feature>')` when its board or window opens and the function it returns when it closes, so the feature polls fast meanwhile. Call actions with `factoryFetch('<feature>', '/path', { method: 'POST', body })`, which throws an `Error` with the server's message. `factoryCan(store.factory.connection, '<group>')` says whether to offer the feature at all.

The registry polls a feature only while the office is connected and the key isn't rejected. Features start 1.5 seconds apart after connecting. A feature never has two polls running. After a failure it waits one interval, then twice that, doubling up to 15 minutes; after a 429 at least the `Retry-After` and a minute, doubling. A poll that was in flight when the connection changed is thrown away.

The four first versions, for their owners to grow:

| Feature | Polls | Slice | Routes |
| --- | --- | --- | --- |
| `computers` | 60 s, 15 s fast; busy while one is provisioning or waking | The list with provisioning steps and cloned repositories (no relay URLs or keys), the providers (every 30 minutes), the computer secrets' names (every 5 minutes; `secretsError` when that read fails, which doesn't fail the poll), which computer is this machine (`here`), the ones waking, and for each managed computer the latest sample and six hours of history (read every 3 minutes from just after the last sample, every minute while it wakes) | `POST ''`, `POST /bulk`, `GET /repositories`, `GET`/`PATCH /secrets`, `GET /:id`, `GET /:id/metrics?hours=` (1 to 96), `PATCH /:id`, `DELETE /:id` (`confirm` = its name), `POST /:id/restart` (`resume` or `reboot`), `/:id/refresh`, `/:id/install-deps`, `/:id/activity` |
| `sessions` | 90 s, 20 s fast; busy while a session on a Factory computer runs | The last ~100 sessions with their credits, the office's own workers' sessions, the credits ledger's week (see [Droid sessions](#droid-sessions)) | Create, read, message, interrupt, change, delete; messages and children (see [Droid sessions](#droid-sessions)) |
| `ci` | 5 min, 60 s fast; busy for 3 minutes after an edit | Whether GitHub is connected, the GitHub owners, the scan's workflows (read again only once its `cacheTtlMs` runs out) and its time, the newest 50 runs, the workflow PRs; a read that fails keeps its part of the last data | `GET /repositories?owner=&fresh=1` (kept 10 minutes), `POST /rescan`, `POST /edit` |
| `wiki` | 5 min, 60 s fast | The latest wiki runs | `GET /upload-access?repoUrl=` |
| `cloud` | each working cloud worker's session every 4 s, each resting one's every minute; busy while one works | When its last read was, and why it failed; the workers themselves are each floor's (`cloud-workers.json`) and go out as `worker.update` | `POST /hire`, `POST /:workerId/message`, `POST /:workerId/interrupt` |

### Cloud workers

What the live tests on `orb` showed: a managed computer's home folder is `/home/<remoteUser>` (`/home/factory-user`), which is the session's folder when `cwd` is left out; no repositories are cloned there by Factory. `POST /sessions` took about 16 seconds and the first `POST /sessions/{id}/messages` about 23. Right after a message, `GET /sessions/{id}` can still say `idle` with the old `messageCount`. `GET /sessions/{id}` doesn't return `sessionSettings`. `DELETE /sessions/{id}` answers 204; in the first tests the session still read 200 and stayed in the list afterwards, and in later ones it was gone from the list and read 404 at once, so the office drops a session it deleted from the slice itself (`SessionsFeature.forget`, also when a cloud worker goes home with its session) rather than wait for the list. Factory lists a new message many seconds late, 20 or more after it was made: a session can read `idle` while its reply isn't listed yet, and the newest message listed can still be the last turn's reply. So a cloud worker's turn counts as answered only by a reply made after the message went (`answeredByAssistant(messages, since)`), a turn that ended before its reply was listed reads the tail for up to 90 seconds more (`replyBy`), and the transcript goes on reading after a session stops until a new reply is in (at most 90 seconds).

### CI automations

The board on the north wall past the gong (`world/factory-ci.ts`, `BOARDS.ci` in `layout.ts`) and the CI automations window (`ui/factory-ci.ts`) read the `ci` slice; the grouping by repository, this floor first (matched without case), and each workflow's latest run are `groupCi` in `src/shared/factory-ci.ts`. A run belongs to a workflow by repository and file, or by name when it has no file.

`POST /automations/ci/edit` adds, changes or removes a Droid workflow by opening a pull request in the repository. Its body, found from its validation errors and the Factory web app:

```json
{
  "action": "create",
  "automationName": "Droid Code Review",
  "factoryAutomationId": "<a new UUID>",
  "modeId": "code-review",
  "repos": [{ "repoFullName": "owner/repo", "filePath": ".github/workflows/droid-review.yml" }],
  "changes": { "name": "Droid Code Review", "yamlParams": "automatic_review: true\n", "customPrompt": "", "schedule": "", "githubEvents": ["pull-request"] }
}
```

- `action` is `create`, `edit` or `delete`; a delete needs only `repos`. Without `action` and a repository the answer is 400 "Provide action ("edit"|"delete"|"create") and at least one repo."; an edit without `changes` answers "Edit action requires a `changes` payload."
- `yamlParams` are the droid-action's inputs, as YAML lines (`automatic_review`, `review_depth: deep|shallow`, `automatic_security_review`, `review_model`, `reasoning_effort`). A Droid job of your own has `customPrompt`, and its model and effort as `customCIModel` and `customCIReasoningEffort`. `schedule` is a 5-field cron or `''`; `githubEvents` are `pull-request`, `pr-opened`, `comment-added`, `push`, `label-change` and `checks-completed`.
- Factory's file names: `droid-review.yml` for code review, `factory-<name in kebab case>.yml` for a job of your own (`droid-wiki-refresh.yml` and `deep-security-review.yml` for its wiki and security templates, which the office doesn't add).
- The answer has one `sessions` entry per repository: `{repoFullName, sessionId, prUrl}` once it opened a PR, `message` when there was nothing to do (deleting a file that isn't there: "Automation deleted"), or `error` ("Invalid repo target" for a delete without `filePath`). It still answers 200 then; the office answers 422 with the error. Factory's YAML has `workflow_dispatch` always on and uses `Factory-AI/droid-action@main`.
- The office checks every field before it goes (`ciEditProblem`): a GitHub `owner/repo`, a file under `.github/workflows/`, known events, a cron, and a model and effort that are one id each, since they go into the YAML as written. Factory changes only the files its own templates write, so the window offers Change for `droid-review.yml` and `factory-*.yml`, and Remove for any workflow.

### Computers: the compute wall and the Computers window

Built. The west-wall board (`COMPUTE_WALL` in `src/shared/layout.ts`, drawn by `src/client/world/factory-computers.ts`) is two canvases in one bezel: this machine on its south end (the old machine monitor, still fed by `/api/machine`) and the fleet on the rest. Each is redrawn only when what it shows changes (its data as a JSON key, ages rounded to the minute), so the machine's frequent updates never re-upload the fleet's bigger texture. The fleet screen's states: not connected (how to connect), no access, reading, and the computers, with the last good list and its age when Factory is down or the key is rejected. One to six computers get big tiles (status, provider, the provisioning step, CPU/MEM/DISK bars and six-hour sparklines); seven to twelve go to compact rows, and past twelve the last row says how many more. The Droid rack under it (`factory-props.ts`) gets a cube per computer, lit by its phase. The wall polls fast while you're within 12 m of it.

The Computers window (`src/client/ui/factory-computers.ts`) is E at the wall, ☰ → Computers or the palette. Phases (`computerPhase` in `src/shared/factory-computers.ts`): *provisioning* (with `currentStep`), *error*, *waking* (a restart that resumed it, until its first sample), *asleep* (managed, no sample for 20 minutes) and *active*. Deleting a computer takes its name typed out, and the route checks it too. Factory's computer file upload and download endpoints are left out: the office has nothing to send a computer that a session can't fetch itself.

### Droid sessions

`src/server/factory/sessions.ts`, `src/server/factory/credits.ts` and `src/shared/factory-sessions.ts`; drawn by the lounge TV (`src/client/world/factory-tv.ts`), the 🛰️ Sessions window (`src/client/ui/factory-sessions.ts`) and the transcript (`src/client/ui/factory-transcript.ts`).

**Polling.** `GET /sessions?limit=50` every poll, and the page after it (`cursor`) every 10 minutes, so the slice has the last ~100. The list's `status` lags (a session that runs can read `idle` there), and it has no credits: both come from `GET /sessions/{id}`, read at most 24 times a poll, three at once. A session is read when the office hasn't yet, when the list's `updatedAt` passed the one it read, every 15 seconds while it runs or is pending, and every minute while its office worker works; running ones first, then the office's workers' (even ones past the list), then the newest. A failed read waits 2 minutes (a 404, 15) and doesn't fail the poll; a 401 does. Every per-read time is called `fetchedAt`, so a poll that read nothing new doesn't broadcast.

**The slice** (`FactorySessionsState`): `items` (the list, each with what its own read said: `credits`, settings, a fresher `status` and its `fetchedAt`), `hasMore`, `fetchedAt`, `error`, `office` (every floor's workers — desk and cloud — and guests with a session, by session id: `workerId`, `name`, `floor`, `color`, `credits`; cloud workers come from `floor.everyone()`, since they aren't in the `WorkerManager`) and `credits` (the ledger's last 7 days, `today`, `week`, `since` and the 5 sessions that spent the most). `sessionCredits(slice, sessionId)` and `creditsNote(…)` ("⚡ 841k credits", or '') are what a worker's hint, row and terminal show.

**The credits ledger** is the office's `.droid-office/factory-credits.json` (written whole, temp file and rename): each session's total as last read, and per day what each total grew by. A session's first read puts all its credits on the day it was last active (`updatedAt`), and that part of the day is `guessed` (some of it may have been spent earlier); a day with a guessed part, or before `since` (when the office started counting), is `estimated`. The TV hatches the guessed part of each bar and puts ≈ on a total that has one. Kept 31 days; deleted when the office disconnects or takes another account's key.

**Routes**, under `/api/factory/sessions`. Bodies are JSON; anything but a GET needs the office's own page or a paired phone.

| Route | Body or query | Answers |
| --- | --- | --- |
| `GET ''` | `?limit=` (1-100), `?cursor=` | `{sessions, hasMore, nextCursor?}`: older sessions than the slice keeps |
| `POST ''` | `{computerId, computerName?, cwd?, model?, reasoningEffort?, interactionMode?, autonomyLevel?, prompt?, images?}` | `{session, messageId?, status?, error?}`. Creates the session on that Factory computer (`POST /sessions`), then sends `prompt` (and `images`) as its first message. `error` says the session started but the message didn't go. Toasts "started a Droid session on …". |
| `GET /:id` | | `{session, credits?}`, read fresh (and counted in the ledger) |
| `PATCH /:id` | `{model?, reasoningEffort?, interactionMode?, autonomyLevel?}` | `{session}` |
| `DELETE /:id` | | `{ok: true}`; it leaves the slice at once. Toasts. |
| `GET /:id/messages` | `?limit=` (1-100, 30), `?cursor=`, `?role=user\|assistant\|tool` | `{messages, hasMore, nextCursor?}`: one page, **oldest first**; the first page is the newest, `nextCursor` goes back. System and hidden messages are left out. |
| `POST /:id/messages` | `{text, images?: [{data, mediaType}]}` (base64, PNG/JPEG/GIF/WebP, at most 6, 16 MB in all) | `{messageId, status, queued?}`: `queued` when it was busy and the message waits for its turn to end. The session reads `running` until the next read says otherwise. |
| `POST /:id/interrupt` | | `{status}` |
| `GET /:id/children` | | `{sessions}`: its Task subagents |

**Just-made sessions.** Factory 404s a session it has just made for a few seconds. Polls wait that out (a 404 for a session the office hasn't read yet waits 15 minutes in the Sessions feature, and a cloud worker's counts as gone only once it was read before or is 3 minutes old, `NEW_SESSION_GRACE_MS`). Writes and the routes' own reads go through `whileNew` (`new-session.ts`): for a session made in the last 30 seconds (`NEW_SESSION_MS`; by the office's clock when it made it, else its worker's `createdAt`, else Factory's `createdAt`), a 404 is tried again after 1, 2, 3 and 4 seconds before it counts. That covers changing its settings, its first and later messages, interrupting, `GET /:id` and deleting, in the Sessions routes and for cloud workers (their messages, Interrupt and sending one home). A 404 on deleting an older session means it's gone already, which is what was asked; on a just-made one that never turned up, the Sessions route answers 409 and asks to try again. The transcript shows "Starting…" rather than an error while a just-made session 404s (`starting` in `mountTranscript`), and tries again every few seconds.

Settings take the API's values (`SESSION_EFFORTS`, `SESSION_MODES`, `SESSION_AUTONOMY`); anything else is a 400. A message is `FactoryMessage {id, role, createdAt, seq?, blocks, isError?, model?}`, its `blocks` cut down by `messageOf`: `text`, `thinking`, `tool_use {id, name, input}`, `tool_result {toolUseId, text, isError, images?}`, `image {mediaType, data?}` (no `data` past 1.5 MB of base64) and `document {name}`; long text and outputs are cut, with a note. `sessionWebUrl(id)` is the session in the Factory web app (`https://app.factory.ai/sessions/<id>`, the pattern droid's own share command prints).

**The transcript component** (`src/client/ui/factory-transcript.ts`), for any window that shows a session:

```ts
const t = mountTranscript({
  sessionId,
  live: () => isLive(session), // reads the newest every 3 s while it runs
  starting: () => justMade(session), // a 404 reads "Starting…" and is tried again
  empty: () => 'Waiting for a prompt', // with no messages (default "No messages yet")
  pageSize: 30,
});
pane.append(t.element); // a scrolling flex column: give it room to grow
await t.refresh();      // read the newest now and follow the bottom, after sending a message say
t.dispose();            // when the window closes
```

It reads the newest page at once, pages back with **Load earlier messages**, and while `live()` says the session runs (and after it stops, until a new reply is listed or 90 seconds pass) reads the newest every 3 seconds, following the bottom unless you scrolled up. A `refresh()` asked for while a read is on its way runs again after it. Text is markdown through `markdown.ts`; thinking and tool results are folded; a tool call is one line (`toolLine`: "Execute: npm test") that opens onto its input and result, marked ✓, ✖ or … while it waits; pictures are thumbnails that enlarge on a click. Only messages that changed are drawn again, so what you opened stays open.

## The pieces

The work is split into pieces with their own branches, each merged into the `feat/factory` integration branch, and that into `main` at the end.

- **Phase 1.** *Foundation*: the connection, the API client, `FactoryState`, the registry and its routes, the client store and fetch helper, Settings → Factory, this document and the guide's bullets. *Hoop removal*: the basketball hoop, ball and court, gone.
- **Phase 2**, in parallel. *Compute wall and Computers window*: the machine monitor grows into a big west-wall board in the hoop's old slot, with this machine and every Factory computer (status, provider, CPU, memory and disk now and recently), and a Computers window to list, inspect and act on them (create, bulk create, rename, restart or wake, refresh credentials, retry dependencies, delete with a confirm, computer secret names). *Sessions and credits*: the lounge TV becomes the Factory sessions dashboard (running sessions, recent ones, credits today and over 7 days, the top spenders), a Sessions window (list, filter, detail, transcript, send a message, interrupt, delete), and credits per office worker. *CI automations board*: a board on the north wall's north-east corner past the gong, with the Droid workflows per repository, recent runs and this floor's repository highlighted, and a window to see a workflow and open a workflow PR through `POST /automations/ci/edit`. *AutoWiki on the bookshelf*: the floor's AutoWiki next to its Markdown docs (runs and history for the floor's repository, pages, search, export, generate a run, privacy, delete).
- **Phase 3.** *Cloud workers*: a hire option that runs a worker's Droid session on a Factory computer (the Sessions API: create with model, effort, autonomy and folder, send a prompt, poll its status, interrupt). It sits at a desk with a cloud badge; its window is the transcript and a prompt box, not a terminal.

Rules every piece follows:

- Match the codebase: comments that say why in plain sentences, its naming, Biome's format, and no new dependency unless it's truly needed.
- Keep wiring into the big shared files (`src/client/main.ts`, `src/client/world/office.ts`, `src/shared/layout.ts`, `src/shared/protocol.ts`, `src/server/server.ts`, `docs/guide.md`) small, one block per file where possible: the logic goes in the feature's own module, which exports one mount or register function.
- Status and feedback on actions use the office's toasts and its windows' inline errors.
- The boards use the Factory look the office already has (`world/machine.ts`, `world/factory-props.ts`): near-black panels, mono type, letter-spaced labels, the orange `#ee6018` accent, green, amber and red load colors, and the pinwheel glyph from `toon.ts`.
- Tests are `tests/factory-<piece>.test.ts` with a fake `fetch`. `npm run test:coverage` has floors, so new code needs real tests.
- The guide gets a "What's inside" and a "How it works" bullet for what each piece builds, and this document stays current.
- Prefer no new environment variable; `.env.example` lists any there is.

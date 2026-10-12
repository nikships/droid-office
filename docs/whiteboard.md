# The Whiteboard

The **🧑‍🎨 Whiteboard** replaces the Services board. It is one shared surface per floor where agents and the owner work on the same things. Agents put artifacts on it: live HTML pages, images and interactive forms. The owner opens them, uses them, and marks them up with comments, sticky notes and pictures. Later, the owner tells an agent "I marked up the board, take a look". The agent reads the whole board as it is now, with everything that changed since it last looked marked. Then it changes whatever it likes.

There is no "send feedback" step, no queue and no delivery receipts. The board is shared state. Either side changes it at any time, and either side reads all of it at any time.

Status: **implemented**, apart from the renderer checks on Linux, Windows, the EC2 box and the signed Mac app, which haven't been run yet (see [Acceptance results](#acceptance-results)). This was the requirements and plan document, kept current while the work was done, the way [factory.md](factory.md) was kept.

## The owner's decisions

- **Services is removed entirely**: the wall board, the window, the port scan, the tunnel relay and their docs. The Whiteboard takes its wall slot on the east wall, north of the lounge TV.
- **Native to the office.** [Lavish](https://github.com/kunchenguid/lavish-axi) was the starting idea, not a spec: no Lavish dependency, no Lavish file format, no copying its flows.
- **A feed of artifacts, and each one opens into its own surface.** The board is a grid of cards. Opening one shows it large, with its marks on it.
- **What agents push:** full HTML artifacts (any JavaScript, any network access), images and screenshots, and interactive forms whose values agents read back.
- **What the owner does on an artifact:** pin comments to an element or a spot, fill in its forms and press its buttons, and add sticky notes and pictures. There is no freehand pen.
- **What the owner creates:** a blank canvas card (for stickies, pictures and comments), and their own pasted or uploaded HTML as an artifact.
- **Agents are not limited.** Anything the owner can do on the board, an agent can do through its command, and more: push, update in place, rename, delete, reply to and resolve comments, add, move, edit, reattach or remove stickies and pictures, read and set form and artifact state, and choose what the wall shows.
- **One board per floor.** Every agent on that floor reads and edits every card (see [Which agents](#which-agents) for what "agent" covers). An agent cannot reach another floor's board.
- **Feedback is never sent.** The owner tells an agent to look. The window has one helper for that: a **Ping a worker** button. You pick an active worker on the floor, and the office types a line into its terminal telling it to read the board. There is no blocking `wait` command.
- **The wall mirrors the window.** If you left the board on the grid, the wall shows the grid of thumbnails. If you left it on one artifact (opened it, did something, walked away without going back to the grid), the wall keeps that artifact up large, live.
- **You work on artifacts in a full-size window inside the office**, like the PR or terminal window. There is no separate browser page.
- **Only the current state is kept.** There are no versions and no change log. The "changed since you last looked" marks come from revision stamps, not history (see [Reading the board](#reading-the-board)).
- **Agents learn about it from a Droid skill the office installs and keeps up to date**, like `droid-office-subagents`.
- **Not in scope:** the phone view, the Android app, agents working across floors, and cloud workers (see [Which agents](#which-agents)).
- **The bar is a polished, complete feature**, not a first pass to iterate on. Every decision below picks the better behavior over the simpler one.

## Decisions made for the owner

The owner left these to the implementer. Each one is a decision, with its reason.

| Question | Decision | Why |
| --- | --- | --- |
| Where does an artifact's HTML live? | The office's board store is the source of truth, and a read always returns the stored HTML. An agent pushes content through the command (stdin or `--file`). It can also `--link` a file in its worktree: the office watches it and updates the card when it changes. The link is extra metadata, never the content itself. See [Content, assets and links](#content-assets-and-links). | Agents are best at editing files with their normal tools, so linking makes iterating cheap. The store stays authoritative, so the board survives a worktree being deleted, and owner-made cards need no file. |
| What does a read return? | The full current state every time. Each object carries `changed: true` when someone other than the reader changed it after the reader last read that card. | The agent always has the whole picture and can still find the owner's new marks at once. Diff-only reads lose context. |
| How do artifacts hold state? | Both mechanisms. Plain HTML form fields are captured and restored by themselves. A small JavaScript API (`whiteboard.state`, `whiteboard.on`, `whiteboard.action`) is there for anything richer. Both write into the same per-card `state` object, which agents read and write too. | A plain `<form>` "just works" for a quick question. A rich artifact (a kanban board, a design picker, a game) keeps any JSON it likes. |
| Who renders HTML to images? | The office server, with one pinned headless Chromium, on every platform including the Mac app. There is no browser-side fallback and no Electron-specific backend. See [Rendering](#rendering). | Agents read the board while the owner is away, so images can't depend on an open page. A page can't faithfully screenshot a live sandboxed iframe (canvas, WebGL, cross-origin images). One backend everywhere also avoids a new channel between the Mac app and a server it may not have started. |
| How is artifact code isolated? | A sandboxed iframe with an opaque origin and full network access. It never runs on the office's origin and never sees the office's token. It talks to the window only through a bridge bound to that one frame and card. See [Isolation](#isolation). | Network access as the owner asked, while an artifact can't reach the office, its token or other cards. |
| How does the window lay out artifacts? | At one canonical layout width (1280 CSS pixels), the coordinate system every mark uses. The window shows it at **Fit** (scaled to the window) or **100%**, with zoom and pan in between. The renderer uses the same width and captures the full page. | What the owner sees, what the wall shows and the PNG an agent reads share one layout, so marks sit in the same place in all three, and zoom keeps form text readable in a small window. |
| How do marks stay attached when an artifact changes? | Each comment, sticky or picture on an artifact is anchored to an element (a `data-wb-id` if the author gave one, else a CSS path plus a text quote), with an offset inside that element. Its canonical page coordinate is the fallback. After a content change or a layout change, the office re-anchors each mark. A mark it can't place is shown as **detached**, never dropped, and the owner or an agent can **reattach** it. Re-anchoring tries, in order: the `data-wb-id`; the CSS path, if its element still holds the quote; any element holding the quote (the smallest, nearest one with the same tag); the CSS path, if its text is a light edit of the quote; and one element of the same tag whose text is a light edit of it. A light edit keeps at least 85% of the quote's words in order, and every one of its rarer words; a quote under four words must match in full. Anything less detaches. | Agents update artifacts constantly, and marks have to survive that. A mark on the wrong element is worse than a detached one: siblings like "Option A" and "Option B" read alike, so a near match has to be close and unique. |
| What happens to focus when a card's content changes under the owner? | The frame reports its focused field, its caret and any value not saved yet. The reload waits until the owner has stopped typing for a second and no IME composition is open. The new page gets focus back on the same field, with the caret and the unsaved value, which the window also saves. Closing the window or opening another card saves an unsaved value the same way. | An agent updating a form while the owner fills it in must not cost them a keystroke or their place. |
| How does Esc work inside an artifact? | Esc in the frame is passed to the window once the artifact has had its turn: an artifact that calls `preventDefault()` keeps it (to close its own popup), and an Esc during an IME composition stays in the field. Otherwise it closes the top of the window stack, as anywhere in the office. | The frame is another origin, so the office's key handling never sees its keys. |

## Which agents

The board's command and the ping work for the office's own workers on the floor: any agent at a desk, the Team lead, and every subagent. These have a terminal the office owns, the command on their PATH, and a hook token.

Two kinds of desk occupant are excluded, and the window and the guide say so:

- **Guests** (agents started by hand in a floor's checkout) have no hook token and no terminal the office can type into. A droid guest becomes a full worker through the existing **Bring it in** action, and from then on it uses the board like any worker. The ping picker lists guests as unavailable, with that hint.
- **Cloud workers** run on a Factory computer, which has neither the office's command on its PATH nor a route to the office's hook address. The owner confirmed they are **out of scope for now**. Including them later needs a floor-scoped command and transport that reaches the office from a Factory computer, plus a cloud ping.

## What the owner sees

### On the wall

- The east-wall slot is where the Services board was (`BOARDS.services` in `src/shared/layout.ts`, renamed `whiteboard`), with the label `WHITEBOARD`. It is 6 m wide and 4.8 m tall, as tall as the wall allows under the ceiling purlin over it.
- **Grid view:** up to nine thumbnails (3×3), each with its title, its author's color and name, and a dot when it changed since the owner last opened it. When there are more cards, the last tile reads `+N`. An empty board says how to start: ask a worker to put something on it.
- **Artifact view:** the selected card fills the wall, blown up and readable: the region of the page the owner last looked at in the window (their scroll and zoom, cropped to the wall's 5:4 shape), or the top of the page at a readable scale if they never did. It comes from the latest render, with stickies, pictures and comment pins drawn on it, and refreshes when the card or its marks change. Agents still get the full page.
- Walking up and pressing **E** opens the window on whatever the wall shows.

### What the wall shows

- Each floor keeps one persisted **selection**: the grid, or one card. It survives restarts.
- The last explicit navigation sets it: the owner opening a card or going **Back to grid**, or an agent's `show`. Closing the window, or walking away, leaves it where it was.
- With two office tabs open, the last navigation in either one wins. An agent's `show` never yanks an open window to another card: the window shows a toast ("Pixel put *Pricing draft* on the wall") with a button to open it.
- Deleting the selected card sets the selection back to the grid.

### The window

- A `.full` window, opened from the wall, the **☰** menu (`whiteboard`, with a count of cards changed since you looked) and `office.open('whiteboard')`.
- **Grid:** cards newest-first, with their thumbnail, title, author, an "updated 2m ago" time and a changed dot. Actions: **New canvas**, **Add HTML** (paste, or upload a `.html` file or a folder with its assets), and **Ping a worker**.
- **Artifact:** the card large in its sandbox, a toolbar and a side panel.
  - Modes: **Use** (the default: click, type, press the artifact's buttons) and **Mark up** (a click pins a comment; drag places a sticky). One key toggles them, shown as a `.key`.
  - Navigation: pinch to zoom at the pointer and two-finger pan in both axes, over a live HTML page as well as its marks or a canvas. Ctrl/Cmd + scroll zooms; Shift + scroll pans sideways. Gestures are accumulated once per animation frame without rounding the transform, and old frame layout acknowledgements cannot rewind an in-flight scroll. Nested scrolling areas remain native until their edge.
  - Pan: **Pan** (**H**) drags anywhere without interacting with the page or moving marks. **Space** holds temporary pan (except while typing or activating a button); a middle-button drag pans in any mode. Pointer release, cancellation and focus loss clear drag cursors.
  - Zoom controls: **Fit** (**0**, page width, or all canvas marks with 80 pixels of room), **100%** (**1**), zoom in/out (**+**/**−**). Navigation shortcuts also cross the sandbox bridge when the page hasn't handled them and the owner isn't typing. The view is remembered per card, and the wall shows what you were looking at. The renderer's canvas image uses a 48-pixel margin instead; the two insets stay different, and each caller passes its own.
  - Workspace: **Marks** hides or shows the side panel, letting the viewport fill the window; a quiet on-surface hint makes the trackpad and Space gestures discoverable.
  - **Comment:** pinned to an element or a spot. It's a thread: the owner and agents add replies, and either side resolves or reopens it. Each message shows its author (a worker's name with its color dot, or "You").
  - **Sticky note:** text in one of a few colors. Move it, resize it, edit it, delete it.
  - **Picture:** paste, drop or pick a PNG, JPEG, WebP or GIF, placed like a sticky.
  - **Side panel:** every comment thread, sticky and picture on the card, the detached ones (each with **Reattach**: click the new spot), and what changed since you last looked.
  - Header: title (editable), author, link status for a linked card (**Linked**, or **Link broken** with the reason), **Back to grid**, **Delete**, and **Copy for agent** (copies a one-line reference to the card for a prompt).
- **Canvas card:** a large pannable, zoomable blank surface with the same stickies, pictures and comments, and no HTML.
- **Live:** an agent's change shows at once. A content change re-renders the artifact and keeps your scroll position. A state change goes into the running artifact without a reload. A change to marks just moves the marks. See [Concurrent edits](#concurrent-edits-and-reconnects) for what happens while you type.
- **Offline:** while the office connection is down, the window says so, keeps your edits, and sends them once it reconnects. Nothing you did is lost or applied twice.
- Built from the UI kit (`src/client/ui/AGENTS.md`). Checked at 1440×900 and 1024×700, including Esc, the stack, and walking away with an artifact open.

### Ping a worker

- A picker of the floor's workers (name, color, status), with each one's eligibility.
- **Idle, done or asleep:** the office types the line in (an asleep worker is resumed with it), as `office-workers send` does.
- **Working:** a Droid agent gets the line queued behind its current turn (the `queue` flag of `WorkerManager.prompt`, which sends Ctrl+Enter). Another agent kind that can't queue is shown as busy: ping it when it's free.
- **Starting, waiting on an answer in its terminal (`needs_input`), or down:** not eligible, with the reason. The office never types into a permission prompt, an AskUser dialog, a plain shell, or a guest.
- If a worker's status changes while the picker is open, the picker updates. A ping that becomes ineligible on the way fails with an inline reason.
- The line is an editable office prompt (`src/shared/prompts.ts`), for example "The owner updated the Whiteboard. Run `office-whiteboard read` and look at what changed."

## What agents get

### The command

`office-whiteboard`, a plain-Node command in `bin/` next to `office-workers`. It goes on every worker's PATH and authenticates with the same `DROID_OFFICE_HOOK_URL`, `DROID_OFFICE_WORKER_ID` and `DROID_OFFICE_HOOK_TOKEN`. Every subcommand is a shortcut for one or more operations of a single `apply` API, so nothing the board can hold is out of an agent's reach.

| Command | What it does |
| --- | --- |
| `office-whiteboard read [<card>…] [--json] [--png <dir>]` | The whole board, or the cards named: each card's metadata, stored HTML, link status, state, comment threads, stickies and pictures (with file paths), and the `changed` marks. `--png` writes a render of each card, marks included, and says how fresh it is. Moves this agent's read point for the cards returned only. |
| `office-whiteboard push --title "…" [--file f \| --link f] [--image f]` | A new card from stdin, a file (with its local assets), a linked file, or an image. Prints the card id. |
| `office-whiteboard update <card> [--file f \| --title "…"]` | Replaces a card's content or title in place. Marks re-anchor. A linked card refuses a content update until it is unlinked. |
| `office-whiteboard link <card> <file>`, `unlink <card>` | Links a card to a file, or keeps its current content and stops watching. |
| `office-whiteboard rm <card>` | Deletes a card. |
| `office-whiteboard state <card> [get [<path>] \| set <json> \| merge <json> \| del <path>]` | Reads or writes the card's state (form fields and the JavaScript API's data). See [Concurrent edits](#concurrent-edits-and-reconnects) for exactly what each one does. |
| `office-whiteboard comment <card> add\|reply\|resolve\|reopen\|rm …` | Comment threads, anchored to a `data-wb-id`, a selector or a point. |
| `office-whiteboard sticky <card> add\|edit\|move\|reattach\|rm …`, `picture <card> add\|move\|reattach\|rm …` | Stickies and pictures, as the owner places them. |
| `office-whiteboard show [<card> \| --grid]` | Sets what the wall shows. |
| `office-whiteboard apply <<'EOF' [ops…] EOF` | Any list of operations as JSON, applied all at once or not at all. |
| `office-whiteboard help` | The whole guide, including the artifact JavaScript API. |

Output is short readable text by default, with `--json` for exact structures. Errors say what to do next. An operation that fails validation changes nothing and says which operation failed and why.

### Reading the board

- The board has one revision counter. Every accepted change stamps each **independently editable piece** it touches with the new revision and its author. The pieces are:
  - a card's title, and its content;
  - each state leaf;
  - each comment message, and each thread's resolved flag and anchor;
  - each sticky's text, color, position and size, and anchor;
  - each picture's file, position and size, and anchor.

  Editing one piece never clears another piece's stamp. A write that doesn't change a value keeps the old stamp.
- **Removals** leave a small tombstone (the piece's id and kind, the revision and the author), so a deletion still shows as a change. Tombstones hold no content. One is dropped once every reader's read point for that card has passed it, or after 30 days.
- Each reader has a **read point per card** (the owner has one per card too). `read` returns the board as of one snapshot revision. After the whole result, including any requested PNGs, has been returned, it moves the reader's read point to that revision for the cards it returned, and only those. A read that fails moves nothing.
- A piece is `changed` for a reader when its stamp is newer than the reader's read point for that card, and someone else made the change. A card with any changed piece or tombstone is changed.
- That is all the "history" there is. Old content is never kept.

### The artifact JavaScript API

The office injects a small script into every artifact's sandbox:

- `whiteboard.state.get(path?)`, `whiteboard.state.set(value)`, `whiteboard.state.merge(obj)`, `whiteboard.state.del(path)`, and `whiteboard.on('state', fn)` when the owner or an agent changes it.
- `whiteboard.action(name, data?)` records the last press of a named action (`{ name, data, at }`) in the card's state. A `<button data-wb-action="approve">` does that with no script.
- Form fields with a `name` or `id` are saved into `state.fields` and restored on load, with no script.
- `whiteboard.card` holds the card's id, title and author.
- `whiteboard.rendering` is `true` when the renderer loaded the card. Then writes are dropped, and an artifact can skip side effects such as analytics or one-time network calls.

### The skill

`droid-office-whiteboard`, written to the user's Factory skills folder and kept up to date by the office exactly like `droid-office-subagents` (`src/server/subagents.ts`, `syncSkill`). Its description applies it only when `DROID_OFFICE_WORKER_ID` is set. It covers:

- When to use the board: anything visual, a plan to review, a choice to make, or a form for the owner to fill in.
- Read before you change anything, and `changed` marks the owner's new input.
- The JavaScript API.
- Good artifact habits: a `data-wb-id` on elements people will comment on, a layout that works at 1280 pixels wide, and no secrets in artifacts, since they have network access.

A toggle in ⚙️ Settings turns the skill on and off, like the subagents skill.

## Content, assets and links

- **Stored HTML is the content.** A card's HTML and its assets live in the store. A read returns them, whatever happened to a linked file.
- **Assets:** `push --file` and `link` collect the local files the HTML references by relative path in markup and CSS (images, stylesheets, scripts, fonts, and `url()` inside CSS), within the file's folder and size limits. They become card assets with their relative paths kept, and the card is served with its folder as its base, so the HTML needs no rewriting. Remote URLs stay as they are. A reference that can't be collected (outside the folder, too large, missing) is listed in the command's output and in a read.
- **Packages:** for anything loaded at run time (ES module imports, `fetch('./data.json')`), `push --dir <folder>` and `link --dir <folder>` take the whole folder, with `index.html` (or `--entry`) as its page, within the limits. The owner's folder upload works the same way. There is no JavaScript dependency crawler.
- **Links:** the office watches the linked file and its collected assets, debounced, and treats an atomic replace (write a temp file, then rename) as a change. A change updates the card's content.
  - If the file disappears or can't be read, the card keeps its last good content and its link shows **broken**, with the reason. The link recovers by itself if the file comes back.
  - An agent's `update` of a linked card's content is refused until `unlink`, so one source never silently undoes the other.
  - Deleting a worker's worktree breaks its links, and nothing more.
- **Owner HTML:** pasted HTML has no assets. An uploaded file or folder collects its assets as above.

## Isolation

- **The frame:** `<iframe sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads">`, never `allow-same-origin`, and an `allow` list that grants nothing (no camera, microphone, display capture, geolocation or clipboard read). Its document comes from the office's card route, so its origin is opaque.
- **Card routes** are reached with a card-scoped, unguessable capability in the path, never the office's token or a hook token. They answer with `Content-Security-Policy: sandbox …` (the same flags) and `X-Content-Type-Options: nosniff`, so opening a card URL directly in a tab still runs it sandboxed, never on the office's origin. A card's capability reaches that card's assets only.
- **CORS:** an opaque-origin page needs CORS for module scripts, fonts and `fetch`. Card asset routes answer GET and HEAD with `Access-Control-Allow-Origin: *` and no credentials. No other office route gets CORS, and none accepts a card capability.
- **The bridge:** the window accepts a message only from the `contentWindow` of the iframe it made for that card, checks a per-load nonce, and applies only that card's state and actions. An artifact can't address another card, the board or the office.
- **The renderer** loads each card the same way, in a fresh browser context per render, with every permission denied but one: local network access for its harness page, so a card reaches the owner's localhost and LAN as it does in the window. The office's own addresses and ports are blocked outright in a render. Chromium's own OS sandbox is on (`chromiumSandbox: true`; Playwright's default is off), and the office never falls back to `--no-sandbox`. Where the host can't run it, rendering fails with an error that says how to fix it. On Ubuntu 23.10 and later, that fix is an AppArmor profile for the browser, which `deploy/provision.sh` installs.
- **Guard tests:** the static `tests/no-media.test.ts` keeps passing. A new runtime test loads hostile artifacts in the sandbox and the renderer, and checks they can't read the office token or storage, reach another card, post accepted messages for another card, or get media permissions.

## Concurrent edits and reconnects

- **One order:** the server applies operations in the order it accepts them. Each one gets its revision, and every client and agent sees the same result.
- **Atomic batches:** an `apply` batch, including the content and assets it references, is written in full or not at all. A batch that fails validation changes nothing.
- **Immutable files:** every file the board holds (a card's HTML, each asset, each picture) is a content-addressed blob in `blobs/<sha256>`, written once and never overwritten. A card maps its relative paths to blob hashes. A commit writes its new blobs and fsyncs them and the `blobs` folder first. Then it writes `board.json` (with those references and the operation record) through a temp file, an fsync and a rename, then fsyncs the folder. A crash at any point leaves the old board or the new one, each with every file it references.
- **Snapshot leases:** a read or a render works from a snapshot, which holds a lease on every blob its path-to-hash map names until it finishes. While it runs, its asset routes serve from that pinned map, not the live card. Pruning (at start, and after commits) deletes only blobs that neither the board nor a live lease references, so an update or a deletion during a slow PNG read can't pull files out from under it.
- **Acknowledged writes:** each client (an office tab, or one `office-whiteboard` run) gets a server-issued epoch and numbers its operations in sequence. The server's operation record, committed in the same `board.json` write, keeps each recent epoch's highest applied sequence number, bounded by age and count. It acknowledges an operation only after that commit, so a retry after a crash between commit and acknowledgement is recognised and applied once.
- **Expired retries:** a retry whose epoch the record no longer holds can't be proved new or old, so it is never reapplied and never silently given a new number. The server rejects it as expired. The window keeps those edits as a local draft and offers to reapply them after showing the board as it is now. The command says the same and exits non-zero.
- **Reconnects:** the window queues its operations while the connection is down (today `net.ts` drops them silently, and this changes that). On reconnect it resyncs the board, then resends what wasn't acknowledged.
- **State semantics:** state is a JSON object, and every state write names a path. `set` replaces the value at its path (the root for a whole-state replace). `merge` sets each leaf of the object it's given, recursing into objects and replacing arrays whole. `del` removes a path. Each leaf is a piece with its own stamp, so two writers to different leaves never collide, and the same leaf is last writer wins.
- **Typing:** a form field the owner is focused on, including an IME composition, keeps the owner's value. A remote write to that field's leaf is held and shown as a small "changed by Pixel" marker. When the field loses focus, or after a second without typing, the owner's last value is written. That means the owner's typing wins over a write that arrived while they typed, and any later remote write wins as usual.
- **Content reload while typing:** a content change waits until the focused field has been idle for a second and no IME composition is open, then reloads (a banner offers **Reload now**). Field values come back from state, and focus, the caret and scroll are kept where the element still exists. What was typed and not yet saved goes into the new page and into state.

## Rendering

- **The backend:** a headless Chromium driven by `playwright-core`, pinned to the version that `playwright-core` release expects. The same backend runs on macOS (the Mac app included), Linux and Windows.
- **Installation:** the browser download and the system libraries are separate steps.
  - The **browser** goes into one shared cache folder that every install and launch uses (`PLAYWRIGHT_BROWSERS_PATH`, set by the office). Its download needs no admin rights. The Mac app, the only supported production install, runs it on first launch through the bundled `playwright-core` CLI with `runAsNode`. Developer checkouts can use `droid-office browser install`. The office runs it on first use as a backstop, with progress in the window.
  - The **system libraries** Chromium needs on Linux developer checkouts are installed only where admin rights are already in use: `deploy/provision.sh` runs `playwright-core install-deps chromium`. The renderer never calls `sudo` or `su`. When libraries are missing, the board says which command installs them.
  - The guide lists the Linux distributions Playwright has library lists for; these are developer platforms, not production install targets.
  - A failed download or missing libraries never stop the office from starting: the board says renders are unavailable and why.
- **How a render runs:** one engine serves the whole office (one browser, one queue, one status), and each floor's store gets its own view of it. A render loads a harness page on an internal origin, answered by the renderer itself and never the network, which frames the card exactly as the window does (the same sandbox, the card's files from the pinned snapshot, the bridge with `rendering: true`). Then it grows the frame to the page's height, asks the bridge where each anchor is, and draws the marks over the frame.
- **What it renders:** a card at the canonical width, full-page height, with its state and its marks drawn on top, from a snapshot taken at one revision.
  - Images are at device scale 1: PNG tiles 1280×2048, top to bottom, at most 8 (a 16384-pixel cap, stated in the read), and a 640×400 thumbnail of the top 1280×800.
  - Each image lists where it drew every mark (pins by their center), so the wall and the window can crop a region without measuring the page again. A tile's index is `floor(y / 2048)`.
  - A canvas card is rendered at the bounds of its items plus a 48-pixel margin, scaled down if it is wider than 4096 pixels. Its image says the canvas point at its top left and the scale.
  - The render status gives the page size, the tile height, the cap, and a canvas's origin and scale. The wall cuts the owner's last view out of the tiles with those, so a canvas lines up from its origin and a view past a capped page's last tile slides back onto it.
  - A comment pin on a resolved thread is dimmed. A mark whose element is gone is drawn dashed at its last point, and the render tells the store, which records it as detached (and attached again once its element is back).
- **Cache and order:** a render's key is the card's content revision, state revision, marks revision and the viewport. Renders are debounced per card, with a bounded queue and a few running at once. A finished render is kept only if nothing newer finished first, so a slow old render never overwrites a newer image.
- **Settling:** the renderer waits for fonts, network quiet and a quiet period of DOM changes, with a hard timeout. A render that times out keeps the last good image and records the error.
- **Images live in memory:** the office renders every card again when it starts, and the board's own data is never rewritten for a render. While the renderer is unavailable, the render routes still serve the last image with its revision and age, marked not current.
- **Freshness:** a read's `--png` is pinned to the read's own snapshot revision. A cached image for exactly that snapshot is used. Otherwise the renderer renders that in-memory snapshot, with a timeout, so the image always matches the metadata and state in the same read, even while the card keeps changing. Changes after the snapshot stay unread. If no renderer is available or the render fails, the read says so explicitly, with the reason and the revision and age of the last image it has. It never returns a stale image as current, and it doesn't move the read point.
- One pipeline makes the wall texture, the grid thumbnails and every PNG an agent reads.

## Lifetimes

- **Authors** are stored as a snapshot (worker id, name and color) when they act, so a card or comment from a dismissed worker still shows who made it.
- **Floors:** taking a floor off the building stops its watchers, renders and timers, and deletes nothing. Adding the floor back loads its board as it was.
- **Restarts:** the board, every read point, the selection and the links come back. The watchers restart and pick up changes made while the office was down.
- **Limits**, as constants with tests: HTML size per card, asset size per file and per card, total storage per floor, card count, comment length, state size. A write over a limit is refused with the limit in the message.

## Shape of the code

- `src/shared/whiteboard.ts`: the types (board, card, piece, mark, thread, anchor, state, selection), the operations, and one pure `applyOps(board, ops, actor, rev)` reducer that the server and the client both use, with the limits and the `changed` logic. `src/shared/whiteboard-marks.ts` is the marks: where each sits (its anchor's point plus its box), the canvas bounds for a margin the caller passes (the window's 80, the renderer's 48), the operations a finished drag or a reattach sends, and the change list, which phrases `changesFor`'s pieces. The window's surface sends those drag and reattach operations, and writes single operations (add, edit, reply, resolve, delete) as `Op` literals. The renderer paints the placement records.
- `src/server/whiteboard.ts`: the per-floor store in the floor checkout's `.droid-office/whiteboard/` (`board.json` with the operation record, `key` for the HMAC card and epoch capabilities, and content-addressed `blobs/<sha256>`), crash-safe writes (blobs, then a temp file, then a rename), epochs, leases and pinned snapshots, the agents' `{ load }` content and `card.linkTo` / `card.unlink`, links and watchers, the card route's responses, limits and pruning, and the `WhiteboardRenderer` interface the renderer plugs into (`NoRenderer` until then). `whiteboard-assets.ts` reads pages, packages and pictures from disk; `whiteboard-sdk.ts` is the script injected into every page; `whiteboard-agent.ts` answers `office-whiteboard`; `whiteboard-skill.ts` writes the `droid-office-whiteboard` skill (state in the office's `whiteboard-skill.json`).
- `src/server/whiteboard-render.ts`: the renderer (`RenderEngine`, and the `FloorRenderer` each floor's store calls), its install, queue and cache, and the broadcasts `whiteboard.rendered` (per floor and card) and `whiteboard.renderer` (status). The office starts it only when the CLI runs it; a server started without `renders` (the tests) keeps `NoRenderer`.
- `src/server/server.ts`: an `/office/whiteboard` route for agents (hook token, like `/office/workers`), the card route `/whiteboard/c/<cap>/<path>`, `/api/whiteboard/file` and `/api/whiteboard/blob` for the window, the render routes (`/api/whiteboard/render`, `/api/whiteboard/render/status`), the WebSocket messages and Ping a worker.
- `src/shared/protocol.ts`: `ServerMsg` `whiteboard` (snapshots, patches, acknowledgements and rejections) and `whiteboardSkill`, and `ClientMsg` `whiteboard.apply`, `whiteboard.sync`, `whiteboard.ping` and `whiteboardSkill.set`. Every reader and handler is updated in the same change. `src/shared/whiteboard-ping.ts` says whether a worker can be pinged.
- `src/client/whiteboard-sync.ts` (the window's board: optimistic batches, the queue while offline, resends in each batch's epoch, drafts of expired batches), `src/client/ui/whiteboard.ts` (the window), the sandbox bridge, and `src/client/world/boards.ts` (`WhiteboardTexture`, replacing `ServicesBoardTexture`).
- `bin/office-whiteboard.js`, written onto every worker's PATH the way `writeOfficeCommand` writes `office-workers`.

## Removing Services

In one change, before the Whiteboard takes the slot:

- **Server:**
  - Remove `src/server/services.ts`, `src/server/relay.ts` and their wiring in `server.ts`: the port scan, the `services` state, and the tunnel relay for HTTP and WebSockets.
  - `WorkerManager.owners()` stays, because `GuestScanner` uses it for the workers' PIDs. Replace it with a pid list (or move its type), so it no longer imports the deleted file.
- **Protocol and client:**
  - Remove `ServiceInfo`, `ServicesState` and the `services` message from `protocol.ts`, and `store.services`.
  - Remove `src/client/ui/services.ts` and `ServicesBoardTexture`.
  - Remove the `services` entries from `main.ts`, `automation.ts`, the `InteractKind` in `src/client/world/office.ts`, and the menu subscription in `src/client/ui/menu.ts`, plus its CSS.
- **Config and deploy:**
  - Remove `DROID_OFFICE_PUBLIC_HOST` and `Config.publicHost`, and its entry in `.env.example`, in the same change (`tests/env-example.test.ts` checks it).
  - Remove the `PUBLIC_HOST` chain in `deploy/aws.sh` (the export to provisioning) and `deploy/provision.sh` (its header and the line that writes the variable), and the `aws.sh service` command with `service_tunnel`.
- **Docs and skills:**
  - In `docs/guide.md`, remove every Services mention: the floor bullet, the quiet-screen menu list, the Services board bullet, "Reviewing what workers build", the `aws.sh service` line, the "How it works" diagram line and bullet, and `services` in the `office.open` list.
  - Remove it from `.agents/skills/office-3d-testing/SKILL.md`.

## Order of work

1. Remove Services (above). Lint, typecheck and tests pass.
2. The shared model and reducer, with thorough tests: operations, atomic batches, anchors, per-piece stamps and per-card read points, state paths and merge, limits.
3. The server store, the agent route, `office-whiteboard`, links and assets, and the skill. Test them end to end against a real server, including crashes between writes and retried operation ids. (Done, with the window's sync module, the render routes against `NoRenderer`, the Settings toggle and Ping a worker.)
4. The window: the grid, the sandbox and bridge, forms and state, Use and Mark up, comments, stickies, pictures, reattach, canvas cards, owner HTML, live updates, offline queueing, the selection, Ping a worker. (Done, in `src/client/ui/whiteboard*.ts`.)
5. The renderer: install, queue and cache, tiles, PNGs for agents, thumbnails. (Done, with the runtime isolation test.)
6. The wall: the grid and artifact views, the selection, **E** to open, the automation API kind (`whiteboard`). (Done, in `src/client/world/whiteboard-wall.ts`.)
7. `docs/guide.md`: a feature bullet, a "How it works" bullet, and the whiteboard folder in its State bullet. Also `.env.example` if a variable is added, and the full CI checks from the root `AGENTS.md`. (Done; the README has a line too.)

## Acceptance checks

The work is done when each of these passes, by test where it can be automated and by hand in the running office where it can't:

- **Isolation:** hostile artifacts can't read the office token or storage, reach another card or the board, get accepted bridge messages for another card, or get media permissions, in the window or the renderer. A card URL opened directly still runs sandboxed.
- **Forms and state:** plain form fields and API state survive a reload, a content update, an agent's write and a restart. Typing (IME included) is never overwritten mid-edit.
- **Reading:** partial reads, and writes between reads, never hide another author's unread change. The owner edits a sticky's text and an agent then moves it: the text still shows as changed to that agent. Removals show as changes. A `--png` read returns an image of its own snapshot while the card keeps changing. `changed` marks are right for the owner and for two agents.
- **Concurrency and recovery:** duplicate retries apply once, including a retry after a crash between the commit and the acknowledgement. Edits made while offline arrive once. A retry whose epoch has expired, by age or by count, is rejected and kept as a draft, never applied twice. An update and a card deletion during a slow `--png` read still render that read's snapshot. Killing the office at any point in a commit (blobs, `board.json`, the rename) leaves a consistent board whose files all exist.
- **Assets:** a linked page with relative images and CSS, and a `--dir` package with an ES module import and a `fetch('./data.json')`, work in the window and in the renderer.
- **Links:** edit, atomic replace, delete and restore of a linked file, an update refused while linked, unlink, and a deleted worktree.
- **Anchoring:** marks survive typical agent rewrites. Detached marks show up and reattach. Marks are in the same place in the window, on the wall and in the PNG.
- **Lifetimes:** a dismissed author, a floor removed and added back, and the selection after a restart and after deleting the selected card.
- **Ping:** each status in the picker, a Droid agent queued mid-turn, refusals for `needs_input`, starting, down and guests.
- **Renderer:** it installs and renders, with Chromium's sandbox on, in the packaged signed Mac app and developer source checkouts on macOS, Linux (including Ubuntu 24.04 EC2 through `deploy/aws.sh`) and Windows. Where the sandbox can't run, or the browser or libraries are missing, the office still starts and the failure is reported, never silent.
- **UI:** the window at 1440×900 and 1024×700, Fit and 100% on a long artifact, the wall's blown-up view of that long artifact at the owner's last viewport, and Esc, the stack, and walking away mid-edit.

### Acceptance results

From the integration pass. "By test" names the suite in `tests/`; "by hand" was a scratch office on macOS (Chromium headless shell 1248, sandbox on) with two shell workers and two agent workers driving `office-whiteboard` through their hook tokens, and the window at 1440×900 and 1024×700.

| Check | Result |
| --- | --- |
| Isolation | Passed by test (`whiteboard-isolation`: the window, the renderer and a card URL in a tab of its own; `whiteboard-browser`: no permissions, storage or service workers in a fresh context). |
| Forms and state | Passed by test (`whiteboard-sdk`: focus, caret and unsaved typing through content reloads, a held remote write, an IME composition, typing and then closing at once; `whiteboard-model`: frame writes become state operations on their own card). Passed by hand: text, textarea, checkbox, select, radio, a `data-wb-action` button and API state, through a tab reload, a content update while typing (focus and caret kept), an agent's `state merge`, an office restart, and closing with Esc or ✕ right after typing. |
| Reading | Passed by test (`whiteboard-model`: partial reads, the sticky text-then-move case, tombstones, the owner and two agents; `whiteboard-render` and `whiteboard-agent`: a `--png` read of its own snapshot through an update and a deletion). By hand, owner marks showed as changed to an agent. |
| Concurrency and recovery | Passed by test (`whiteboard-store`: retries, expired epochs by age and count, a kill at each commit point, pinned snapshots; `whiteboard-sync`: offline batches, drafts). |
| Assets | Passed by test (`whiteboard-store`, `whiteboard-render`). Passed by hand: a `--link` page with CSS and an image, and a `--dir` package with a module import and `fetch('./data.json')`, in the window and in `--png`. |
| Links | Passed by test (`whiteboard-store`, a deleted worktree included). Passed by hand: edit, atomic replace, delete (**Link broken** with the reason) and restore, a refused `update`, and `unlink`. |
| Anchoring | Passed by test (`whiteboard-sdk`, 13 rewrites; numbers under [Risks](#risks-and-open-questions); `whiteboard-model` and `whiteboard-render`: detach and reattach, and marks drawn where the SDK places them). Passed by hand: a pin and a sticky far down a 6981-pixel page sit in the same place in the window, on the wall and in the PNG, and canvas stickies at negative points line up on the wall. |
| Lifetimes | Passed by test (`whiteboard-model`, `whiteboard-store`). Passed by hand: a dismissed author's card still says who made it, a floor removed and added back keeps its board and selection, the selection survives a restart, and deleting the selected card puts the wall on the grid. |
| Ping | Passed by test (`whiteboard-sync`: every status, kind and condition; `whiteboard-e2e`: refused while starting, typed when idle, queued behind a working turn). By hand, the picker refused plain shells and two workers in `needs_input`, each with its reason. |
| Renderer | Passed by test on macOS from a checkout (`whiteboard-browser`: a real launch with the sandbox on; `whiteboard-render`: install progress, failed downloads, a browser that can't start, no renderer). **Not run:** the packaged signed Mac app, fresh Linux and Windows source checkouts, and an Ubuntu 24.04 EC2 checkout through `deploy/aws.sh`. |
| UI | Passed by hand at 1440×900 and 1024×700: the grid, Fit and 100% on a long page, the wall's view of it at the last viewport (top and bottom of the page, across tile seams), Esc from inside the frame and on the stack (the ping picker first, then the window), and walking away mid-edit. Passed by test (`whiteboard-window`, `whiteboard-wall`: the view and region math). |
| Viewport navigation | Passed by test (`whiteboard-sdk`, real Chromium wheel/Ctrl-wheel and pointer input): pointer-anchored pinch, two-axis pan, fractional gesture bursts, stale layout acknowledgements, middle-button drag, Pan while marking up, temporary Space-pan, form typing, navigation shortcuts inside HTML, nested-scroll handoff, remembered views, and canvas navigation. `whiteboard-window` checks subpixel anchors and device delta normalization; `whiteboard-model` checks bridge validation. |

## Risks and open questions

- **Chromium on every install:** the headless shell build, about 100 MB to download and 200 MB on disk, and its system libraries on Linux developer checkouts. Check that the Mac app starts promptly and that no network doesn't stop the office (the board then says renders are unavailable).
- **The Mac app and a downloaded browser:** check that a Chromium the signed app downloads at runtime launches cleanly under Gatekeeper, with no quarantine prompt.
- **Anchoring quality:** agents rewrite whole artifacts often. `tests/whiteboard-sdk.test.ts` measures it on 13 typical rewrites (the same page pushed again; sections removed, renumbered, reordered, added at the top and wrapped in new divs; a renamed heading and an edited sentence; a reworded title; a rewrite from scratch; near-identical options removed or reordered; and `data-wb-id` sections reordered or given new ids), 198 pins in all. 168 stay on their element, 28 detach because their element is gone, 2 (1%) detach though their element is still there (a heading and a title reworded past a light edit), and none lands on the wrong element. The earlier matcher, on the same set, detached 24 pins whose element was still there. A mark that detaches is drawn at its last point, so a detached pin can look as if it sits on whatever moved into that spot. The window lists it under detached, with **Reattach**.
- **Sandbox and network:** an artifact with network access can send out anything it shows. It cannot reach the office's token or other cards. Say this plainly in the skill and the guide.
- **Chromium's sandbox on Linux:** recent Ubuntu releases restrict the unprivileged user namespaces it needs. The AppArmor profile in `deploy/provision.sh` covers the EC2 box. A hand-installed Linux office may need the same profile, and the error says so.

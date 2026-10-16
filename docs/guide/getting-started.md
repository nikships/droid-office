# Getting started

## Requirements

For the production Mac app:

- **An Apple Silicon Mac.** The app includes its own Node.js runtime; no separate Node.js install is needed.
- The **[Droid CLI](https://docs.factory.ai/cli/getting-started/quickstart)** (`droid`), installed, signed in and configured as the user that runs the office. Every worker and board agent is a Droid session.
- **git**, plus the **GitHub CLI** (`gh`) logged in (`gh auth login`) for GitHub projects' issue and PR boards, and the **GitLab CLI** (`glab`) logged in (`glab auth login`) for GitLab projects. A GitLab floor's PR board shows its merge requests, and its workers open merge requests with `glab`. Self-managed GitLab instances work once `glab auth login --hostname <host>` has signed in to them.
- **Chromium**, for the Whiteboard's renderer: about 100 MB to download and 200 MB on disk, downloaded for you (see [Chromium for the Whiteboard](#chromium-for-the-whiteboard)). The office runs without it.
- `curl` is optional. The status hooks use it when it's there and fall back to Node when it isn't.

Developer checkouts also need **Node.js 20+** and npm. The source can run on macOS, Linux and Windows, but those checkouts are not supported production installations.

## Install & run

**The Mac app release is the only supported production install.** Download `Droid-Office-<version>-arm64.dmg` from the [latest release](https://github.com/nikships/droid-office/releases/latest), open it, and drag **Droid Office** into Applications. Launch the app to start your office. It keeps itself up to date; see [The Mac app](#the-mac-app) for first launch, logs and updates.

Command-line installers and standalone server release tarballs are no longer provided or supported. Developers can clone the repository and run or modify it themselves; see [Development](development.md).

### Running a developer checkout

To run the built source without Vite:

```bash
git clone https://github.com/nikships/droid-office.git
cd droid-office
npm ci              # builds the client, server and desktop app
npm run start       # runs the built office from this checkout
```

The command examples below use `droid-office` as shorthand for `node bin/droid-office.js` from the checkout. They are developer tools, not a production installation method.

The first time the checkout starts in a terminal, it walks you through setting up before it opens:

1. **Which folder your projects are in.** It suggests a code folder you already have (`~/Workspace`, `~/code`, `~/repos`…), else your home folder. The office looks for git projects in it and its subfolders, and never clones or copies anything.
2. **Your first project.** It lists the git projects it found, most recently active first. Pick one by number, type its full path, or type a word to search. It becomes the first floor, and you can add more the same way.

Press Enter to skip any step: the elevator in the office asks for your first project too. Run `droid-office setup` to go through it again while the office is stopped, or `droid-office setup --projects ~/Workspace --project ~/Workspace/my-project` to do the same without questions, from a script.

It prints the URL for this machine's browser, which needs no login, and — unless bound to loopback — a join URL and QR code for other devices on your Wi-Fi (see [Access](#access) below).

The office keeps its data in `~/droid-office` (`--home` or `DROID_OFFICE_HOME` to move it) and opens your existing checkouts as floors where they are. To make it look for them in another folder, like `~/Workspace`, pick the **Workspace folder** in ⚙️ Settings → **Building**, or with **Change folder** in the elevator's add-a-project panel (or start with `--projects` or `DROID_OFFICE_PROJECTS`). The folder has to exist. Floors you already have stay where they are when it moves. The list of floors is `~/droid-office/.droid-office/floors.json`. Each floor keeps its workers, pictures and worktrees in its own checkout's `.droid-office/`.

Every setting the office reads from the environment is listed, with its default, in [`.env.example`](../../.env.example). The office doesn't load `.env` files: export the settings in the shell that starts it, or set them as `Environment=` lines in a developer checkout's systemd unit. A command-line flag wins over its environment variable.

You can also start the office in a project, `droid-office ~/code/my-project`: that project becomes a floor, and the office keeps its data in `~/code/my-project/.droid-office` as it did before there were floors. An office that already ran in a project carries on in it when you start `droid-office` there again. You can take that project off the building in the elevator like any other floor.

### Chromium for the Whiteboard

The Whiteboard draws its cards with a headless Chromium, driven by `playwright-core` and pinned to the revision that release expects. Its sandbox is always on: the office never starts it with `--no-sandbox`. Two things have to be in place, and neither stops the office from starting. If one is missing, the board says renders are unavailable and why.

- **The browser** (about 100 MB to download, 200 MB on disk) goes into one folder every install and launch shares: `~/Library/Caches/droid-office/browsers` on macOS, `$XDG_CACHE_HOME/droid-office/browsers` (default `~/.cache/droid-office/browsers`) on Linux, and `%LOCALAPPDATA%\droid-office\browsers` on Windows. `DROID_OFFICE_BROWSERS_PATH` moves it. It needs no admin rights. The Mac app downloads it in the background at launch and again after an update that pins a new revision (`~/Library/Logs/Droid Office/browser.log`). Developer checkouts can run `droid-office browser install` to download it by hand and `droid-office browser status` to check whether it's there. The office also downloads it on first use; a failed download leaves the office running and reports why renders are unavailable.
- **On Linux developer checkouts, its system libraries** need admin rights. As an admin, run `sudo node <checkout>/node_modules/playwright-core/cli.js install-deps chromium` (the error the board shows names the exact command for your checkout). `deploy/provision.sh` does this on the AWS box. Playwright has library lists for Ubuntu 22.04 and 24.04 and Debian 12 and 13, on x64 and arm64. macOS (Intel and Apple Silicon) and Windows 10 and 11 on x64 need nothing more. These source platforms are not production install targets.
- **On Ubuntu 23.10 and later**, AppArmor stops unprivileged programs from using the user namespaces Chromium's sandbox needs, and it fails with *No usable sandbox*. With admin rights, `droid-office browser apparmor-profile | sudo tee /etc/apparmor.d/droid-office-chromium` followed by `sudo apparmor_parser -r /etc/apparmor.d/droid-office-chromium` installs a profile for that browser alone. `deploy/provision.sh` installs it on the AWS box.

### The Mac app

On a Mac with Apple Silicon, **Droid Office.app** does all of this for you: it starts the office, opens it full screen, and updates itself. Download `Droid-Office-<version>-arm64.dmg` from the [latest release](https://github.com/nikships/droid-office/releases/latest), open it and drag **Droid Office** into Applications. It's signed with a Developer ID and notarized by Apple, so it opens without a warning. It needs no Node.js of its own (the office runs on the app's built-in Node), but it does need `droid`, `git` and, for the GitHub boards, `gh` signed in (`gh auth login`).

- **The first launch** asks where your office lives: `~/droid-office` (what `droid-office` opens with no folder), or a folder you pick. Pick a folder an office already ran in to carry on with its floors and workers. **Office → Change Office Folder…** switches later. The app remembers the choice in `~/Library/Application Support/com.nikships.droid-office/settings.json`, which can also set `"port"` (default 4600).
- **Starting.** The app starts the office with `droid-office --home <folder>`, or `droid-office <folder>` for a checkout an office was started in as a project, on port 4600, and shows it once it answers. If an office already answers on that port (a `droid-office` in a terminal, say), the app opens that one instead of starting a second. If something else holds the port, it takes the next free one. The office and its workers get your login shell's environment, as they would from a terminal, rather than the bare one macOS gives apps: its `PATH`, and everything else your shell profile exports (`JAVA_HOME`, API keys, `LANG`…). Without a locale from anywhere, they get `LANG=en_US.UTF-8`.
- **Opened from the disk image or Downloads**, the app offers to move itself into Applications. macOS runs it from a read-only copy there, so it can't update itself, and workers' terminals stop working once the disk image is ejected.
- **Full screen.** The window opens full screen. **Ctrl+Cmd+F** (or **View → Toggle Full Screen**) leaves it and goes back. Links to issues, pull requests and docs open in your browser; **Office → Open in Browser** opens the office itself there too.
- **Quitting** works like restarting the office: workers keep running in their terminal host, and opening the app again within 30 minutes picks them back up. Closing the window leaves the app and the office running; click the Dock icon to bring it back. The office's output goes to `~/Library/Logs/Droid Office/office.log` (**Office → Show Office Log**). Once the window is up, the app writes what Electron says it draws with (`app.getGPUInfo('complete')` and `app.getGPUFeatureStatus()`: the GPU, ANGLE's backend such as Metal, Skia's backend, and each GPU feature's status) to `gpu.log` beside it; **Office → Show GPU Report** writes it again and shows it.
- **Updates.** Every release on `main` comes with the app (see [Releases](development.md#releases)). The app checks for a newer one at launch and every 30 minutes. When there is one, a single **Software Update** sheet opens on the office window: **Install and Restart** downloads it with a progress bar right there (**Cancel** or Esc stops the download), then the app restarts into it. Restarting keeps your workers running. **Later** closes the sheet without downloading anything, and the background checks don't offer that version again until the next launch. **Droid Office → Check for Updates…** checks now and opens the same sheet, which says so when you're up to date or the check failed (with **Try Again**). It reads the public releases of `nikships/droid-office`, so it needs no GitHub login. What it did is in `~/Library/Logs/Droid Office/updates.log`.

### Open the running office in a browser app window

In Chrome or Edge, open an already-running office and choose **Install** in the address bar, or **⋮ → Cast, save and share → Install page as app**. This only creates a browser window shortcut, not a Droid Office installation. The Mac app (or a developer checkout) still needs to be running. The shortcut has no offline mode and needs HTTPS with a certificate your browser trusts, or `localhost` (including an SSH tunnel).

### Access

There are no office passwords, accounts, sessions or login pages. Each start mints a random LAN token, kept in memory and never written to disk; starting the office prints the join URL and a QR code of it in the terminal. Requests from the office's own machine (loopback) connect freely with no token. Every other HTTP request and WebSocket connection must carry the token as `?t=<token>`; a missing or wrong token is refused.

To connect another browser on your network, use the printed link or scan the terminal's QR code: that is the join URL, token included. The token changes on every start, so after a restart, scan the new code. To keep the office to this machine only, start with `--host 127.0.0.1`: there is then no join URL at all.

A paired phone (see [Droid Office for Android](android.md)) carries a **device token** instead. It opens the office the way the LAN token does, for every page, API and the WebSocket, but it keeps working across restarts until you forget the phone. The phone sends it as `Authorization: Bearer <token>` (or `?d=<token>`). The office keeps only its SHA-256, in its own `.droid-office/devices.json`. A device token that was forgotten is refused everywhere, even on loopback, so the phone knows to pair again.

An office that ran before this had a shared password and per-person accounts. Those are gone: the old `accounts.json` is left unread on disk (in the office's `.droid-office/`, next to `config.json`), and so is the old `chat.jsonl`. Delete them yourself if you want them gone; the office never reads, writes or serves them.

```
droid-office [dir] [options]

      --home <dir>        Where the office keeps its data without a [dir] (default ~/droid-office)
      --projects <dir>    Where the office looks for existing git checkouts to add as floors (default a
                          code folder in your home folder, else the home folder; also settable from ⚙️ Settings → **Building**)
  -p, --port <n>          Port (default 4600, env PORT)
  -H, --host <addr>       Bind address (default 0.0.0.0; 127.0.0.1 keeps the office on this machine)
      --agent <cmd>       The Droid command (default "droid", env DROID_OFFICE_AGENT)
      --agent-args <str>  Extra args for Droid, e.g. "--auto medium"
      --tls-cert <file>   Serve HTTPS with this cert…
      --tls-key <file>    …and key
      --self-signed       Serve HTTPS with a generated self-signed cert
      --trust-proxy       Trust X-Forwarded-* (behind Caddy/nginx)
      --max-workers <n>   Run at most n workers at once, across every floor (env DROID_OFFICE_MAX_WORKERS)
      --webhook <url>     Post to this Slack / Discord webhook when a worker needs input or finishes
      --city <name>       Put the office in a real city: its sun and live weather (open-meteo.com)
      --weather <kind>    Pin the weather: clear, cloudy, rain, storm, snow or fog

droid-office setup [--projects <dir>] [--project <dir>]... [--home <dir>]

  The first-start walkthrough again: the workspace folder, and which of the
  git checkouts in it are floors. With --projects / --project it asks nothing.
  Run it while the office is stopped.

droid-office prune [dir] [-n|--dry-run] [-f|--force]

  Removes leftover worker worktrees under .droid-office/worktrees/ and their
  office/* branches, in one floor's checkout (dir). Anything with uncommitted changes or unpushed commits is
  kept unless --force is given. A worker across several projects has worktrees of them in its
  own floor's workspace: prune each project to clear those out.
```

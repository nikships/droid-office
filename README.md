<div align="center">

<img src="docs/hero.jpg" alt="A cutaway of the office building at night: five floors of desks with AI droids at glowing terminals, a glass elevator on the side, a fire pole through the floors and a rooftop bar" width="100%">

# Droid Office

### Your AI agents deserve a desk.

**A 3D office in your browser where you hire Factory Droids, walk over to their desks and step into their live terminals.**

[![License](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/nikships/droid-office?style=for-the-badge)](https://github.com/nikships/droid-office/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/nikships/droid-office/release.yml?branch=main&style=for-the-badge&label=CI)](https://github.com/nikships/droid-office/actions/workflows/release.yml)

</div>

---

## Stop babysitting tabs

Five agents in five terminals is a mess. You lose track of who is stuck, who finished and who is waiting on you.

Droid Office turns that into a place. Every agent sits at a desk with a laptop showing its real terminal. A droid that needs you jumps up and dings. A droid that is done does a little spin and throws confetti. You see the whole picture from across the room.

<img src="docs/desk.jpg" alt="A robot droid at its desk with a green terminal, confetti bursting because it just finished" width="100%">

## What you get

- **A desk for every agent.** Walk up, press **E**, pick a model, and a Droid sits down. Its live terminal opens on the laptop in front of it.
- **One terminal, every window.** Open the same live session in a second browser tab; it keeps streaming in each, with full scrollback.
- **A floor per project.** Ride the elevator, pick one of the git projects you already have, and the office opens a new floor in it, right where it is. Nothing is cloned. Each floor has its own desks, boards, task queue and droids.
- **Boards you can touch.** Issues and pull requests hang on the wall. Take a card off the board, carry it across the room, and hand it to a droid.
- **A task queue that works while you don't.** Queue tasks and walk away. Each one gets a fresh droid on its own git branch, and the PR shows up on the board when it's ready.
- **Meetings between agents.** Seat two to five droids at the glass meeting table for a debate, a lead-and-team split, a red-versus-blue attack on your change, or a review panel that posts one merged review on the PR.
- **A place worth being in.** A rooftop bar, an arcade cabinet, a jukebox, and weather outside the windows that follows a real city if you ask.

<img src="docs/meeting.jpg" alt="Robot droids around a glass meeting table with a whiteboard of diagrams behind them" width="100%">

## Why Droid Office

This started as a fork of [agent-office](https://github.com/AgentSystemLabs/agent-office) and went its own way. It's built for teams that live in Factory.

### Droid is the star
Every droid is a Droid session. Hire a droid on any model you've configured — including your custom models — at the reasoning effort you choose. The office remembers your pick per desk and keeps it with the droid across restarts. It shows you when a Droid is working, waiting on you or done.

### GitLab is a first-class citizen
A floor can be a GitLab project, on gitlab.com or your own host. Merge requests fill the PR board, droids open them with `glab`, and every prompt the office sends speaks GitLab.

### Jira on the wall
Connect Jira Cloud once with a read-only token, give a floor an epic, and its tickets appear as a **Jira** tab on the board. Hand any ticket to a droid with one click. The office never writes to Jira.

### Built like a Factory
A dark, industrial look in Factory orange. Install it as an app from Chrome or Edge, and it asks before a stray Cmd+W closes your office.

### Always improving
Every new feature that ships in the original project is brought over, adapted to this fork and its Droid and GitLab work. The latest additions: rewrite every prompt the office sends, set a default droid, edit and filter issues by label on the boards, keep droids running through upgrades, send droids home when their PR merges, and browse your project's docs at the office bookshelf.

<img src="docs/rooftop.jpg" alt="The rooftop bar at night with a fire pit, a DJ robot, robots with drinks, looking over the city" width="100%">

## Get started in a minute

You need Node.js 20+, `git`, and the [Droid CLI](https://docs.factory.ai/cli/getting-started/quickstart) (`droid`) signed in. For the boards, sign in to `gh` for GitHub or `glab` for GitLab.

**The Mac app (Apple Silicon)**

Download `Droid-Office-<version>-arm64.dmg` from the [latest release](https://github.com/nikships/droid-office/releases/latest) and drag **Droid Office** into Applications. It starts the office itself, opens it full screen and keeps itself up to date. Node.js isn't needed; `droid`, `git` and `gh` are. See [the Mac app](docs/guide.md#the-mac-app).

**macOS and Linux**

```bash
curl -fsSL https://raw.githubusercontent.com/nikships/droid-office/main/install.sh | bash
```

**Windows (PowerShell)**

```powershell
irm https://raw.githubusercontent.com/nikships/droid-office/main/install.ps1 | iex
```

That installs the latest release and starts the office. It asks which folder your projects are in and lets you pick your first one. It uses your existing checkouts where they are and never clones anything. There is no login: your browser on the same machine opens straight in, and the terminal prints a link and QR code for another browser on your Wi-Fi. Run the same line again any time to update.

## Your office in your pocket

**Droid Office for Android** keeps you at your desks when you're away from them. Install `Droid-Office-<version>.apk` from the [latest release](https://github.com/nikships/droid-office/releases/latest), then scan the code from ⚙️ Settings → **Phone** in the office. On your Wi-Fi, or from anywhere over Tailscale, you see every droid on every floor, hire new ones, watch their live terminals and prompt them. A droid that needs you or finishes buzzes your phone, and you answer it right from the notification.

<p>
  <img src="android/docs/home.jpg" alt="The Android app listing the office's droids by floor" width="32%">
  <img src="android/docs/worker.jpg" alt="A droid's live terminal on the phone, with a composer and quick keys" width="32%">
  <img src="android/docs/notification.jpg" alt="Phone notifications that a droid is done and another needs you, with a reply box" width="32%">
</p>

## Take it further

| Guide | What's in it |
| --- | --- |
| [The full guide](docs/guide.md) | Every feature, controls, running it on AWS in one command or on your own server, and how it all works |
| [Droid Office for Android](android/README.md) | Installing and pairing the phone app, how it connects over Wi-Fi and Tailscale, and building it |

## Credits and license

Droid Office began as a fork of [AgentSystemLabs/agent-office](https://github.com/AgentSystemLabs/agent-office), whose authors built the office, the desks, the terminals and the boards. It's released under the same [MIT license](LICENSE).

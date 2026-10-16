# Droid Office guide

A cartoon 3D office that is yours alone: you are the only person in it. A loading screen covers the page until the office has drawn, then it fades away. Sit a Droid worker at any empty desk, watch its terminal on the laptop in front of it, and jump into that terminal yourself. Issues and pull requests hang on cork boards on the wall. There are no passwords, accounts, invites, chat or voice: your browser on the office's own machine opens straight in, and another browser on your network joins using the link or QR code the office prints when it starts (see [Install & run](getting-started.md#install--run)).

Every project is **a floor of the building**. Ride the elevator, pick one of the git projects you already have on the office's machine, and the office opens a new floor for it, painted its own colors. It works in your checkout right where it is: it never clones or copies a repository. Every worker, terminal and board on a floor works in that project's checkout.

Install the [Mac app release](getting-started.md#the-mac-app) for production use. Developers can [clone and run the source](development.md).

## Chapters

- **[Getting started](getting-started.md)**: Requirements, installation, running the Mac app or a developer checkout, and network access.
- **[Features](features.md)**: The complete tour of what's inside—floors, workers, boards, shells, terminals, the Whiteboard, compute wall, and more.
- **[Controls](controls.md)**: Quick reference table of keyboard and mouse controls, wand spells, and gun tricks.
- **[Droid Office for Android](android.md)**: Companion phone app for viewing terminals, prompting workers, and checking the Whiteboard.
- **[Models and prompts](models-and-prompts.md)**: Choosing models, Droid CLI configuration, and customizing prompts.
- **[Deployment](deployment.md)**: Hosting developer checkouts remotely with one command on AWS EC2 or on a VPS.
- **[How it works](how-it-works.md)**: Subsystem architecture, status hooks, worktrees, PTYs, render loops, and state files.
- **[Security notes](security.md)**: Authentication model, LAN tokens, device tokens, and proxy considerations.
- **[Development](development.md)**: Developing from source, source hot reload, the `window.office` automation API, and releases.

## License

[MIT](../../LICENSE)

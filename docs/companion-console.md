# Companion management console

## Scope

The web companion and React Native Android app manage the office without an overhead 3D scene. The first-person desktop office remains unchanged.

The selected floor is the working scope. The roster includes local workers, subagents, kiosk agents, shells, guests and cloud workers. Each type exposes only supported actions. `WorkerInfo.lead` determines supervision; team badges and conversation forks do not create a parent relationship. Removing a lead never implicitly dismisses its children.

Agent rows show name, task, status, parent, model, reasoning effort, current activity and work duration. Groups begin expanded, can collapse and summarize their children's status. Search and filters preserve enough parent context to identify matching children.

On wide screens the roster stays available beside one to four distinct pinned worker panes. Dividers resize the workspace; one pane can take focus without discarding the others. A phone shows one conversation with a quick worker switcher and previous/next controls. New local Droid panes open in Thread; Raw TTY remains available.

The web and native workspaces share the Factory dark product treatment: flat near-black surfaces, hairline borders, 3px corners, uppercase monospace controls and orange numbered section labels. Primary actions invert to off-white rather than orange fills. Live counts summarize the current floor; worker colors remain small identity markers.

The roster separates task, activity, model and supervision metadata. Wide screens keep the tool rail and roster beside the pane workspace. Phones separate worker navigation from conversation actions, and show a grouped tool directory instead of a strip of decorative icons. Thread messages, explicit-submit questions, hire and confirmation surfaces follow the same tokens. The desktop first-person office is unchanged.

## State and lifecycle

- Store pane identities, layout and focus per office and floor. Restore only workers still present after the authoritative floor snapshot.
- Preserve unsent text and attachments when switching floors. A connection loss clears unsent state on every floor. Reconnecting restores pane descriptors, never pending sends, permission answers or mutations.
- Already-submitted messages in Droid's queue are not unsent drafts. Clearing local drafts must not clear that queue.
- Capture connection, floor and worker/session identity before asynchronous reads, uploads or actions. A later completion cannot target a new floor, session or connection.
- Use one connection and reference-count terminal subscriptions. Closing Thread, TTY or Changes must not detach another consumer of the same worker.
- Terminal input and resizing belong to the focused, ready pane. Passive and hidden panes must not resize another user's terminal. Thread does not resize PTYs.
- Bound thread polling, histories and child activity reads. Dispose subscriptions, timers and observers on floor changes and view removal.
- Preserve action receipts, uncertain results, destructive confirmations and worktree cleanup inspection. Never report a socket send as confirmed completion.

## Android

React Native owns the agent workspace. Pure TypeScript roster, workspace, thread and command logic is shared where practical.

The native Android layer retains secure token storage, connection routing, private-address enforcement, pairing, notifications, foreground service and intent handling. The existing native terminal input implementation remains available through a native view. Tokens and unrestricted native capabilities are not exposed to web content.

Larger office management tools reuse the authored web components in a bundled, restricted local host. Their native transport uses the same office connection and constrained HTTP operations. It must not load the remote dashboard as an unrestricted WebView or relax server origin checks.

## Management coverage

The companions provide remotely safe access to worker lifecycle and hire controls, Whiteboard, issues and pull requests, pipelines and CI, changes, repository documentation and wiki, computers and cloud sessions, floor management, subscriptions, host updates and non-spatial settings.

Existing host-only restrictions remain. Unavailable operations explain their restriction rather than silently failing or opening an inert control. Spatial rendering, character movement and game controls remain in the first-person office.

There are no new broadcast, bulk-destructive or manual reparenting operations.

## Removal boundary

Remove companion-only map source, Android map assets and bridge, camera controls, map preferences, build generator, generated-output checks and obsolete documentation. Keep first-person scene models, shared layout, fonts and prop assets.

## Acceptance

- [x] Shared roster and workspace logic, including missing leads, all worker types, filtering, pane limits and stale saved state.
- [ ] Four live panes, independent content, safe focus/sizing and shared attachment disposal.
- [ ] Floor navigation restores panes and drafts; disconnect clears unsent drafts across all floors and never replays actions.
- [ ] Android React Native startup, pairing, office switching, notifications, deep links, photo upload and terminal keyboard.
- [ ] Shared management tools open, receive responses and preserve existing action eligibility and confirmations.
- [x] Companion bundles contain no overhead map or three.js dependency.
- [x] Existing first-person terminal behavior remains intact.
- [ ] Root install/build, lint, typecheck and coverage checks pass; Android unit tests, lint and release build pass.
- [ ] Runtime checks use the owner's real-office clone and temporary local test workers. Android checks use emulators, not physical devices.
- [ ] Open code review findings are resolved. The pull request targets the floor base in `nikships/droid-office` and remains unmerged.

No demonstration video is part of this change.

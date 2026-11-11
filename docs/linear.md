# Linear

Status: implemented. One Linear workspace belongs to the office; each floor chooses a team and optionally a project. Workers use the connected account to read and change tickets. Unlike Jira, this integration writes to the service.

## Connect and choose work

In **Settings → Connections → Linear**, paste a personal API key from Linear's **Settings → Account → Security & access → Personal API keys**. The office checks the key and reads its workspace and teams. Pick this floor's team and, optionally, a project. If no team was picked, the office guesses a team only when exactly one team's name or key matches the floor or repository name. Even a workspace with one team is not guessed without a name match. Disconnecting stops every floor's Linear board and autopilot.

The issue board's **Linear** tab shows the team's tickets, narrowed to the chosen project if there is one. It reads up to 300 open tickets and tickets completed in the last 14 days. Columns group Triage and Backlog into **Backlog**, unstarted states into **Todo**, started states into **In Progress**, and completed states into **Done**. Canceled and duplicate tickets are not shown. Open columns sort by priority, then Linear's order; Done sorts by most recently updated. Cards show the identifier and link, title, state, worker, labels, priority, assignee, estimate and update time where present.

Open a card for its description, sub-issues, links and comments. **Hand to a worker** gives the ticket and its prompt to a worker; when a worker already holds it, **Go to** opens that worker instead. The **New ticket** form takes a title, Markdown description, priority and Todo or Backlog, with an option to write another. The board's autopilot button turns it on or off; configure its options in Settings. The 3D wall board also has a Linear tab; select it and interact with a ticket to open its window.

## Ticket lifecycle

Taking a ticket links it to a worker. The office moves it to the team's first started state not named review (or its first started state), unless it is already started or completed, and assigns it to the connected account only if it is unassigned. Existing assignees are left alone. When the worker's pull request opens, the office attaches its URL and moves the ticket to the first started state with “review” in its name, if one exists. A merge moves it to the first completed state, adds a comment naming the worker and PR, and shows a toast. These stages use the team's state order; a missing matching state leaves the state unchanged. Failed updates are retried on a later worker or PR change, except a missing ticket stops retries.

Links remain after a worker leaves when there is a PR, so a later merge can finish the ticket. A departed worker's link without a PR is dropped. Completed links are kept for seven days after completion and removed on a later sync.

## Autopilot

Turn on **Linear autopilot** in the floor's Linear settings. Choose at least one pickup state type (Triage, Backlog or Todo), a maximum of 1–8 autopilot workers, whether to include older tickets, and a model or the office default. The defaults are off, Todo, two workers, newer tickets only, and the office default model. Each time autopilot is turned on, its clock starts again.

After a successful board read, autopilot selects tickets in the chosen state types that have no active link or worker and are unassigned or assigned to the connected account. Unless **Older tickets too** is on, they must have been created at or after that clock. It sorts by priority (urgent through low, then no priority), then oldest creation time. It selects at most the remaining capacity, counting active autopilot-linked workers and hires in flight; manual workers do not count against that maximum. Links with a live worker or PR and hires in flight prevent another pickup. A failed hire is skipped for ten minutes and produces a warning; a capacity or desk failure stops that pass. Autopilot also runs after settings changes and ticket creation, when a successfully fetched board is available.

## Worker tools and prompts

While Linear is connected, floor workers and building agents can use these Office MCP tools, except `linear_start`, which is for floor workers only. Building agents have no current floor and must name a team or issue when needed. See [Office MCP](office-mcp.md) for the tool inputs.

| Tool | Purpose |
| --- | --- |
| `linear_issues` | Search and filter tickets. |
| `linear_issue` | Read a ticket and its details. |
| `linear_start` | Take a ticket and link it to the calling floor worker. |
| `linear_create_issue` | Create a ticket, optionally taking it as a floor worker. |
| `linear_update_issue` | Update fields, labels or attach a link. |
| `linear_comment` | Add a Markdown comment signed with the worker's name. |
| `linear_workspace` | List teams and a team's states, labels, members, projects and active cycle. |
| `linear_graphql` | Run an arbitrary Linear GraphQL query or mutation as the connected account. |

For a linked floor worker, issue-reading, updating and commenting tools can use its ticket when no issue is named. The **Linear ticket** prompt (`linear.work`) is editable in **Settings → Workers → Prompts** and is used for handoffs and autopilot. It has `task`, `identifier`, `title`, `url`, `description`, `branchHint` and `started` placeholders. Keep the task's first line, `Work on Linear issue DOFF-12: "Title".`: the PR draft recognizes it to title the PR and add `Fixes DOFF-12` (or `Part of DOFF-12` for another repository).

## Storage, security and refresh

The office stores its connection and key in the office-wide `.droid-office/linear.json` with mode 0600. Each floor keeps its team, autopilot settings, links and skipped hires in `<floor>/.droid-office/linear-floor.json`, also mode 0600. The key stays server-side and is not sent to browsers or worker environments; API errors are redacted. Workers and building agents can nevertheless act with the connected account's access: `linear_graphql` deliberately allows arbitrary mutations, including destructive ones. Choose the key accordingly.

The floor refreshes on startup, then every 90 seconds while active or autopilot is on, and approximately every ten minutes when idle; returning to a stale floor also refreshes it. Workspace teams are cached for ten minutes and team details for five. Requests time out after 20 seconds. On a rate-limited board read, automatic reads back off for at least 60 seconds, doubling on consecutive limits up to ten minutes, or longer if Linear's request-reset header requires it. A forced refresh bypasses the backoff. Other tool calls report the error rather than automatically retrying.

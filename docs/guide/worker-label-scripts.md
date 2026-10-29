# Bring your own worker-label implementation

In **Settings → Workers → Worker labels**, select **Custom script (bring your own)**.
Set an absolute executable path and its literal arguments as a JSON array. For
JavaScript, choose the absolute path to Node 22+ and put the absolute script path
first in the arguments. Paths refer to the machine hosting the Office, not a phone
or remote browser. No shell, tilde expansion or shell quoting is involved.

Custom scripts do not require Droid or the Office Factory API key. They use their
own provider, credentials and billing. Only configure programs you trust: they run
as your OS user with the Office process environment and a temporary working
directory, not in a sandbox. The Office does not inject its saved Factory key,
worker hook credentials, worker/session identifiers, or project path. Your program
can access whatever your OS user can access. Keep credentials out of arguments,
which are saved in Office preferences and sent to connected settings clients.

## Contract v1

The Office starts a fresh process for each request, writes one UTF-8 JSON object
plus a newline to stdin, then closes stdin:

```json
{
  "version": 1,
  "system": "The current Sign writer instructions from Settings",
  "conversation": "user: Add custom label scripts\n\nassistant: Checking the contract tests",
  "previousSubject": "Custom Label Scripts",
  "model": "meta/muse-spark-1.3-contributor",
  "effort": "minimal"
}
```

- `version` is exactly `1`. Reject versions you do not implement.
- `system` is the owner's configured Sign writer prompt.
- `conversation` contains only the latest 24,000 characters of visible user and
  assistant text. Tools, results, thinking, hidden messages, hooks and attachments
  are not included.
- `previousSubject` is optional, at most 60 characters, and only comes from a
  previously generated label. Preserve it unless the visible user starts a new task.
- `model` and `effort` are passed literally from Settings. Your implementation
  validates them against its provider; the Office does not consult Droid's model
  catalogue for custom scripts or silently select a different model.

Write exactly one JSON object to stdout and exit `0`:

```json
{"name":"Custom Label Scripts","summary":"Checking the contract tests"}
```

Both fields must be nonempty strings. The Office normalizes whitespace/control
characters and clips `name` to 60 characters and `summary` to 140. Do not write
progress or logs to stdout. Use stderr for diagnostics, but the Office deliberately
does not display it because it may contain credentials or conversation text.

The process must finish within 45 seconds. Combined stdout and stderr must stay
within 64 KiB. Nonzero exit, invalid output, timeout or launch failure keeps the
last successful label and retries with backoff. Settings changes, worker removal,
session changes and shutdown cancel running calls. On macOS/Linux the Office kills
the process group, including children; on Windows it kills the direct child only.
Do not daemonize or detach subprocesses. Temporary working directories are removed.
The same changed-text detection, two-call queue and stale-result checks apply to
both implementations.

## OpenRouter example

[`bin/worker-label-openrouter.mjs`](../../bin/worker-label-openrouter.mjs) is a
dependency-free adapter using OpenRouter Chat Completions, structured JSON output,
no tools and an explicit reasoning effort. It never falls back to another model.

Use these settings:

| Field | Value |
| --- | --- |
| Implementation | Custom script |
| Executable path | The absolute path printed by `command -v node` |
| Arguments | `["/absolute/path/to/worker-label-openrouter.mjs","--key-file","/absolute/path/to/openrouter-key"]` |
| Model | `meta/muse-spark-1.3-contributor` |
| Reasoning effort | `minimal` |
| Refresh interval | `60` |

The key file contains only your OpenRouter API key; make it readable only by you
(`chmod 600 /absolute/path/to/openrouter-key`). Alternatively export
`OPENROUTER_API_KEY` in the environment that launches the Office and omit the
`--key-file` arguments. Apps opened from Finder generally do not inherit shell
exports. Keep your script and key outside the app bundle so app updates do not
replace them.

OpenRouter's [model catalogue](https://openrouter.ai/api/v1/models) currently lists
reasoning as mandatory for Muse Spark 1.3 Contributor, with `minimal` as the lowest
supported effort. `none` and `off` are not supported for this model.
[Contributor prompts and outputs may be used to improve Meta's products](https://openrouter.ai/meta/muse-spark-1.3-contributor).

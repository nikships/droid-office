# OpenAI-compatible worker-label endpoints

In **Settings → Workers → Worker labels**, select **OpenAI-compatible endpoint** to
generate worker task subjects and one-line summaries against any server that
speaks OpenAI's `POST /v1/chat/completions` format, with no local script paths,
Droid CLI, or Factory API key required.

## Quick setup

1. Pick a preset (**Ollama**, **LM Studio**, **OpenAI**, **OpenRouter**, **Groq**,
   **xAI**) or paste your own URL:
   - Server root (`http://localhost:11434`) resolves to `/v1/chat/completions`.
   - Base path (`https://openrouter.ai/api/v1`) resolves to `.../chat/completions`.
   - Full `/chat/completions` URLs (including query parameters such as
     `?api-version=...`) are used as entered.
2. Enter the **Model slug** your server expects (for example `llama3.2`,
   `qwen2.5:7b`, `gpt-4.1-nano`, or `openai/gpt-4.1-mini`).
3. Add an **API key** (`Authorization: Bearer`) when your endpoint requires one.
   Local servers such as Ollama and LM Studio usually leave this blank.
4. Click **Test endpoint** to verify connectivity and inspect a sample generated
   label before or after pressing **Save**.

## Security & behavior

- **Transport rules.** Remote endpoints must use `https://`. Plain `http://` is
  accepted on `localhost`, private LAN addresses, `.local` / `.lan` / `.ts.net`
  names, and Tailscale IPs. HTTP redirects and cloud-metadata/link-local
  addresses are refused.
- **Credential storage.** Saved API keys stay in `.droid-office/worker-labels.json`
  (mode `0600` on the Office computer). They are never sent back to connected
  browsers or phones, and changing the endpoint URL to a different origin does
  not reuse a key saved for the previous host.
- **Model compatibility.** `reasoning_effort` is omitted by default (**Provider
  default**) so standard chat models never reject unknown parameters. Inline
  `<think>...</think>` blocks emitted by local reasoning models are stripped
  before reading `{"name": "...", "summary": "..."}`.
- **Bounds & privacy.** Only the latest 24,000 characters of visible user and
  assistant text plus any previously generated subject are sent (no tool calls,
  tool results, thinking, hooks, or attachments). Responses are capped at
  256 KiB and 45 seconds, and raw provider error payloads are never echoed into
  Office state.

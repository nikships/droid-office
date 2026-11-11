# Orchestration & Office MCP Eval

Measures model-facing context footprint and scores real orchestration and active-management behaviour against the live `src/shared/prompts.ts` briefs and `src/server/office-mcp/` tool descriptions and schemas.

Each sample spins up an isolated `OfficeMcpServer` (`createOfficeMcp` / `remoteMcpListener`) over loopback HTTP. Models see this checkout's actual `instructions` and `tools/list` schemas. Zod validation, access checks, team messages/reviews/questions and inbox handling use real MCP code. Worker terminals/hiring and Git diff/merge backends are simulated; no worker processes or real Git merges run. The bounded shell simulator supports explicit `git status`, `git add <files>` and staged `git commit`; unsupported commands fail unless a case supplies an explicit mock.

The behavioral suite covers orchestrator, external-bot and floor-lead roles; subagents currently have context measurements only. Synthetic scenario fixtures are not evidence of real-product end-to-end behavior. Run artifacts include model conversations, tool results and the full checkout commit (with `-dirty` when modified).

## Commands

```bash
# Deterministic context/token footprint across all 4 office roles (no model calls)
bun tools/orchestration-eval/run.ts --context

# Run full suite against configured DroidProxy models (provider/subscription costs may apply)
bun tools/orchestration-eval/run.ts \
  --model custom:droidproxy:gpt-6.1-sol,custom:droidproxy:gpt-6-luna \
  --samples 2 \
  --out tools/orchestration-eval/runs/current

# Compare against a saved baseline report
bun tools/orchestration-eval/run.ts \
  --model custom:droidproxy:gpt-6.1-sol,custom:droidproxy:gpt-6-luna \
  --samples 2 \
  --compare tools/orchestration-eval/runs/baseline/report.json \
  --out tools/orchestration-eval/runs/after
```

`runs/` is gitignored; keep raw run artifacts out of commits and summarize before/after tables in PR descriptions.

## Interpreting scores

Strict pass requires every case check, no failed tool calls (a legitimate merge conflict is not an argument error), and a completed assistant turn within the step budget. Unsupported simulated operations also fail conservatively; inspect raw traces to distinguish fixture limitations from model mistakes. Host-tool descriptions disclose the bounded simulator and available fixture paths, not expected case actions. Integration checks require an inspected, approved result before merging; the sequencing case requires actually landing the foundational branch while leaving the stale dependent branch unmerged. Inbox acknowledgments must cover the exact delivered ids after handling them. Module-name and backoff questions deliberately accept either offered option: they test unblocking within authority, not a uniquely correct engineering choice. Fixtures and graders are transparent, heuristic checks, not a semantic judge of every instruction.

Use identical cases, graders, sample counts and model settings for both revisions. Keep a fixed harness outside the checkout and point its source imports at each revision when measuring an older checkout without the harness. Historical results produced before grader changes are not comparable; rerun both sides rather than claiming their previous deltas still apply. Context figures count default office prompts, MCP instructions and listed schemas, not the entire Droid session or user-customized prompts; token estimates are byte-based heuristics, not tokenizer counts. `--context` makes no model requests.

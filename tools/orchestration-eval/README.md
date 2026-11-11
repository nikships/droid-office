# Orchestration & Office MCP Eval

Measures model-facing context footprint and scores real orchestration and active-management behaviour against the live `src/shared/prompts.ts` briefs and `src/server/office-mcp/` tool descriptions and schemas.

Each sample spins up an isolated in-memory `OfficeMcpServer` (`createOfficeMcp` / `remoteMcpListener`) so models see the exact `instructions` and `tools/list` schemas shipped by this checkout, and every tool call is validated by the real Zod schemas and handlers.

## Commands

```bash
# Deterministic context/token footprint across all 4 office roles (no model calls)
bun tools/orchestration-eval/run.ts --context

# Run full suite against zero-credit DroidProxy models
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

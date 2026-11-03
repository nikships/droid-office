// Hires a Shell, has it call the Office MCP with its own office credentials (kept in its environment,
// never printed), records the HTTP status the office answered, then sends the Shell home.
//   .agents/skills/verify-droid-office/scripts/drive.sh "$RUN" .agents/skills/verify-droid-office/scripts/steps/mcp-shell-refusal.mjs mcp-shell
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { freeShellDesk, hireShell, openShellRun, sendShellHome } from './shell-journey.mjs';
import { assertMcpRefusal, resetProbe, shellQuote, waitForProbe } from './shell-probe.mjs';

export default async (helpers) => {
  const { js, shot, waitFor, log, out } = helpers;
  const status = path.join(out, 'mcp-shell-status.txt');
  const desk = await freeShellDesk(js);
  const worker = await hireShell(helpers, desk);

  const runWindow = await openShellRun(helpers, worker);
  const call = [
    `curl -s -o /dev/null -w '%{http_code}\\n' -X POST "$DROID_OFFICE_HOOK_URL/office/mcp"`,
    `-H "Authorization: Bearer $DROID_OFFICE_HOOK_TOKEN" -H "x-droid-office-worker-id: $DROID_OFFICE_WORKER_ID"`,
    `-H 'content-type: application/json' -H 'accept: application/json, text/event-stream'`,
    `-d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | tee ${shellQuote(status)}`,
  ].join(' ');
  await runWindow.locator('textarea[aria-label=Prompt]').fill(call);
  resetProbe(status);
  await runWindow.locator('button[type=submit]').click();
  const code = await waitForProbe(status, (value) => /^\d{3}$/.test(value));
  log(`step shell MCP call answered ${code || 'nothing'}`);
  await js(() => window.office.interact('E'));
  await waitFor(() => (document.querySelector('.xterm-rows')?.textContent ?? '').includes('/office/mcp'), undefined, 10_000);
  await shot('01-shell-mcp-call');

  await sendShellHome(helpers, worker);
  writeFileSync(path.join(out, 'proof.json'), `${JSON.stringify({ worker: worker.name, desk, status: code }, null, 2)}\n`);
  assertMcpRefusal(code);
};

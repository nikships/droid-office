// Hires a Shell, has it call the Office MCP with its own office credentials (kept in its environment,
// never printed), records the HTTP status the office answered, then sends the Shell home.
//   .agents/skills/verify-droid-office/scripts/drive.sh "$RUN" .agents/skills/verify-droid-office/scripts/steps/mcp-shell-refusal.mjs mcp-shell
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { assertMcpRefusal, resetProbe, shellQuote, waitForProbe } from './shell-probe.mjs';

export default async ({ page, js, shot, waitFor, log, out }) => {
  const status = path.join(out, 'mcp-shell-status.txt');
  await js(() => window.office.closeAll());
  const desk = await js(() => {
    const taken = new Set(window.office.state().workers.map((w) => w.deskId));
    return window.office.list().find((t) => t.kind === 'desk' && !t.worker && !taken.has(t.id))?.id;
  });
  if (!desk) throw new Error('no free desk on this floor');
  await js((d) => window.office.goTo(d), desk);
  await js(() => window.office.interact('B'));
  await waitFor((d) => window.office.state().workers.some((w) => w.deskId === d && w.kind === 'shell'), desk, 30_000);
  const worker = (await js(() => window.office.state())).workers.find((w) => w.deskId === desk);

  await js(() => window.office.interact('P'));
  const runWindow = page.locator(`[role=dialog][aria-label="🐚 Run in ${worker.name}"]`);
  await runWindow.waitFor({ timeout: 10_000 });
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
  await js(() => window.office.closeAll());

  await js((d) => window.office.goTo(d), desk);
  await js(() => window.office.interact('X'));
  const confirm = page.locator(`[role=alertdialog][aria-label="Send ${worker.name} home?"]`);
  await confirm.waitFor({ timeout: 10_000 });
  await confirm.locator('button', { hasText: 'Send home' }).click();
  await waitFor((id) => !window.office.state().workers.some((w) => w.id === id), worker.id, 30_000);
  writeFileSync(path.join(out, 'proof.json'), `${JSON.stringify({ worker: worker.name, desk, status: code }, null, 2)}\n`);
  assertMcpRefusal(code);
};

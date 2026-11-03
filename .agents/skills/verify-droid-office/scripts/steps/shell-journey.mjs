export async function freeShellDesk(js) {
  await js(() => window.office.closeAll());
  const desk = await js(() => {
    const taken = new Set(window.office.state().workers.map((w) => w.deskId));
    return window.office.list().find((t) => t.kind === 'desk' && !t.worker && !taken.has(t.id))?.id;
  });
  if (!desk) throw new Error('no free desk on this floor: send a worker home or ride to another floor');
  await js((d) => window.office.goTo(d), desk);
  return desk;
}

export async function hireShell({ js, waitFor }, desk) {
  await js(() => window.office.interact('B'));
  await waitFor((d) => window.office.state().workers.some((w) => w.deskId === d && w.kind === 'shell'), desk, 30_000);
  return (await js(() => window.office.state())).workers.find((w) => w.deskId === desk);
}

export async function openShellRun({ page, js }, worker) {
  await js(() => window.office.interact('P'));
  const runWindow = page.locator(`[role=dialog][aria-label="🐚 Run in ${worker.name}"]`);
  await runWindow.waitFor({ timeout: 10_000 });
  return runWindow;
}

export async function sendShellHome({ page, js, waitFor }, worker, beforeSend) {
  await js(() => window.office.closeAll());
  await js((desk) => window.office.goTo(desk), worker.deskId);
  await js(() => window.office.interact('X'));
  const confirm = page.locator(`[role=alertdialog][aria-label="Send ${worker.name} home?"]`);
  await confirm.waitFor({ timeout: 10_000 });
  if (beforeSend) await beforeSend();
  await confirm.locator('button', { hasText: 'Send home' }).click();
  await waitFor((id) => !window.office.state().workers.some((w) => w.id === id), worker.id, 30_000);
}

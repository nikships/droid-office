import { execFile } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { app, dialog } from 'electron';
import { finderBridgeArgs } from './finder-links.js';

export function openFinderSettings() {
  const helper = finderBridgeArgs(app.getAppPath(), app.isPackaged, false)[1];
  if (!helper) return;
  execFile(helper, ['--settings'], { timeout: 10_000 }, (err) => {
    if (err) void dialog.showMessageBox({ type: 'error', message: 'Finder settings could not open', detail: 'Open System Settings → General → Login Items & Extensions → Finder Extensions.', buttons: ['OK'] });
  });
}

export async function explainFinder(userData: string) {
  const marker = path.join(userData, 'finder-explained-v1');
  if (existsSync(marker)) return;
  const { response } = await dialog.showMessageBox({
    type: 'info',
    message: 'Dispatch Finder selections to Droid Office',
    detail:
      'To add “Dispatch to Office…” to Finder, enable Droid Office Finder in System Settings → General → Login Items & Extensions → Finder Extensions. Droid Office never enables it automatically. You can reopen these settings from the Office menu.',
    buttons: ['Open Finder Settings', 'Not Now'],
    defaultId: 1,
    cancelId: 1,
  });
  try {
    writeFileSync(marker, '1\n', { mode: 0o600 });
  } catch {
    // Best effort: a full or read-only disk must not break the running office.
  }
  if (response === 0) openFinderSettings();
}

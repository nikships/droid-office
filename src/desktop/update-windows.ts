import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Whether the app's window was open. Which mode it was in is the `mode` setting, which survives the update by itself. */
export interface UpdateWindows {
  open: boolean;
}

/** Captured before Squirrel closes the window. A failed snapshot must not block installation. */
export function saveUpdateWindows(file: string, windows: UpdateWindows) {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(windows)}\n`, { mode: 0o600 });
  } catch {
    // The update can proceed without restoring the window.
  }
}

/** An update restores its window once; a later ordinary launch keeps the usual startup behavior. */
export function takeUpdateWindows(file: string): UpdateWindows | undefined {
  try {
    const text = readFileSync(file, 'utf8');
    unlinkSync(file);
    const raw: unknown = JSON.parse(text);
    if (!raw || typeof raw !== 'object' || !('open' in raw) || typeof raw.open !== 'boolean') return;
    return { open: raw.open };
  } catch {
    return;
  }
}

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface UpdateWindows {
  office: boolean;
  companion: boolean;
}

/** Captured before Squirrel closes the windows. A failed snapshot must not block installation. */
export function saveUpdateWindows(file: string, windows: UpdateWindows) {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(windows)}\n`, { mode: 0o600 });
  } catch {
    // The update can proceed without restoring windows.
  }
}

/** An update restores its windows once; a later ordinary launch keeps the usual startup behavior. */
export function takeUpdateWindows(file: string): UpdateWindows | undefined {
  try {
    const text = readFileSync(file, 'utf8');
    unlinkSync(file);
    const raw: unknown = JSON.parse(text);
    if (!raw || typeof raw !== 'object' || !('office' in raw) || !('companion' in raw)) return;
    if (typeof raw.office !== 'boolean' || typeof raw.companion !== 'boolean') return;
    return { office: raw.office, companion: raw.companion };
  } catch {
    return;
  }
}

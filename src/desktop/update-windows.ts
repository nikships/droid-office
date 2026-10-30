import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { WindowMode } from './settings.js';

/**
 * Whether the app's window was open. Which mode it was in is the `mode` setting, which survives the update by itself,
 * except from the release that kept a flag for each of two windows: `mode` is then the one it had open.
 */
export interface UpdateWindows {
  open: boolean;
  mode?: WindowMode;
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
    if (!raw || typeof raw !== 'object') return;
    if ('open' in raw && typeof raw.open === 'boolean') return { open: raw.open };
    // The previous release saved `{ office, companion }`; a companion-only session stays a companion session.
    if ('office' in raw && 'companion' in raw && typeof raw.office === 'boolean' && typeof raw.companion === 'boolean') {
      return { open: raw.office || raw.companion, ...(raw.companion && !raw.office ? { mode: 'companion' as const } : raw.office ? { mode: 'office' as const } : {}) };
    }
    return;
  } catch {
    return;
  }
}

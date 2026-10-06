import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * The executable the office runs on. On macOS, the app's main binary run as Node (ELECTRON_RUN_AS_NODE)
 * still registers with LaunchServices as a foreground app, so the office, its PTY host and every
 * hook command it spawns each get a bouncing generic "exec" Dock icon. The app's Helper binary
 * (`<name> Helper.app`, LSUIElement) runs the same Electron Node without one. Anywhere else, or
 * if the helper isn't there (a bundle without one), it is the Electron binary itself.
 */
export function officeRuntime(execPath: string, platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = existsSync): string {
  if (platform !== 'darwin') return execPath;
  const macOS = path.dirname(execPath);
  if (path.basename(macOS) !== 'MacOS') return execPath;
  const name = path.basename(execPath);
  const helper = path.join(macOS, '..', 'Frameworks', `${name} Helper.app`, 'Contents', 'MacOS', `${name} Helper`);
  return exists(helper) ? path.normalize(helper) : execPath;
}

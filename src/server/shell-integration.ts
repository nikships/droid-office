import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// tsx loads src/server; the installed server runs from dist/server/server.
const integrationDirs = ['../../bin/', '../../../bin/'].map((base) => fileURLToPath(new URL(`${base}shell-integration/`, import.meta.url)));
function completeBundle(dir: string) {
  try {
    return ['launch-zsh', 'zsh/.zshenv', 'zsh/_office_prompt'].every((name) => {
      const file = path.join(dir, name);
      accessSync(file, constants.R_OK);
      return statSync(file).isFile();
    });
  } catch {
    return false;
  }
}

/** Wrap only the final, interactive login shell, not the setup shell or any
 * agent subprocess. Off bypasses the startup handoff as well as its marks. */
export function interactiveShell(file: string, args: string[], enabled: boolean, dirs = integrationDirs) {
  if (enabled && process.platform !== 'win32' && path.basename(file) === 'zsh') {
    const dir = dirs.find(completeBundle);
    if (dir) return { file: '/bin/sh', args: [path.join(dir, 'launch-zsh'), file, ...args] };
  }
  return { file, args };
}

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// tsx loads src/server; the installed server runs from dist/server/server.
const launcher = ['../../bin/', '../../../bin/'].map((base) => fileURLToPath(new URL(`${base}shell-integration/launch-zsh`, import.meta.url))).find((file) => existsSync(file));

/** Wrap only the final, interactive login shell, not the setup shell or any
 * agent subprocess. Off bypasses the startup handoff as well as its marks. */
export function interactiveShell(file: string, args: string[], enabled: boolean) {
  if (!enabled || process.platform === 'win32' || path.basename(file) !== 'zsh' || !launcher) return { file, args };
  return { file: '/bin/sh', args: [launcher, file, ...args] };
}

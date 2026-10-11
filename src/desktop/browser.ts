import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';

export interface BrowserDownload {
  /** The executable that runs the CLI: Electron's own binary, run as Node. */
  runtime: string;
  /** bin/droid-office.js */
  cli: string;
  env: NodeJS.ProcessEnv;
  /** Where the download's output goes. */
  log: string;
}

/**
 * Makes sure the Chromium the Whiteboard renders with is downloaded: `droid-office browser install` through
 * the bundled playwright-core, run as Node like the office. It is a no-op once the revision this app
 * pins is installed, so running it at every launch also fetches a newer revision after an update.
 * It runs in the background and never blocks or fails the app: the office reports an unavailable
 * browser itself, and `browser install` can be run again by hand.
 */
export function downloadBrowser(o: BrowserDownload): void {
  let out: number | undefined;
  try {
    out = openSync(o.log, 'w', 0o600);
    const child = spawn(o.runtime, [o.cli, 'browser', 'install'], {
      env: { ...o.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', out, out],
    });
    child.once('error', () => {});
    child.unref();
  } catch {
    // No log file or no runtime: the office's first use of the renderer tries again.
  } finally {
    if (out !== undefined) closeSync(out);
  }
}

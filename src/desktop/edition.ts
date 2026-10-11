import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Droid Office Remastered is this app built with `electron-builder.remastered.yml`, which adds `"remastered": true` to
 * the packaged package.json. It is the same office on the same data, port and preferences (it shares the userData
 * folder, and so the single-instance lock, with Droid Office), but it never updates itself: an update would be the
 * normal Droid Office.
 */
export function isRemastered(appPath: string): boolean {
  try {
    return (JSON.parse(readFileSync(path.join(appPath, 'package.json'), 'utf8')) as { remastered?: unknown }).remastered === true;
  } catch {
    return false;
  }
}

export const CLASSIC_BUNDLE_ID = 'com.nikships.droid-office';

/** JXA run by osascript. NSRunningApplication needs no Automation permission, unlike `tell application … to quit`. */
const jxa = (body: string) => `ObjC.import('AppKit'); const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('${CLASSIC_BUNDLE_ID}').js; ${body}`;

function osa(script: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeout: 10_000 }, (err, stdout) => resolve(err ? '' : stdout.trim()));
  });
}

/** Whether Droid Office (the normal app) is running. */
export async function classicRunning(): Promise<boolean> {
  return (await osa(jxa('apps.length > 0'))) === 'true';
}

/**
 * Asks Droid Office to quit the normal way (it stops its office with SIGTERM, which keeps every worker and terminal) and
 * waits for it to go, up to `timeoutMs`. True once it is gone.
 */
export async function quitClassic(timeoutMs = 20_000): Promise<boolean> {
  if (!(await classicRunning())) return true;
  await osa(jxa('apps.forEach((a) => a.terminate); true'));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    if (!(await classicRunning())) return true;
  }
  return false;
}

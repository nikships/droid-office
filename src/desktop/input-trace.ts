import fs from 'node:fs';

/**
 * Diagnostic: with `DROID_OFFICE_INPUT_TRACE=<file>` every input step is appended to that file, one line each: what the native
 * view saw (it writes to the same file) and what went to the page. The text typed is in it, so it is for a hand test only.
 */
export function traceFile(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const file = env.DROID_OFFICE_INPUT_TRACE;
  return file ? file : undefined;
}

export function createTrace(file: string | undefined, now: () => number = Date.now): (line: string) => void {
  if (!file) return () => {};
  return (line) => {
    try {
      fs.appendFileSync(file, `${(now() / 1000).toFixed(3)} js ${line}\n`);
    } catch {
      // A trace that can't be written must never disturb input.
    }
  };
}

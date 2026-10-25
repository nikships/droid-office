import { parseArgs } from 'node:util';

export function runnerOptions(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      size: { type: 'string', default: '1440x900' },
      timeout: { type: 'string', default: '120' },
      source: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (positionals.length > 2) throw new Error('expected a clone directory and optional steps file');
  const timeout = Number(values.timeout);
  if (!/^[1-9]\d*x[1-9]\d*$/.test(values.size) || !Number.isFinite(timeout) || timeout <= 0) throw new Error('--size must be WIDTHxHEIGHT and --timeout must be positive seconds');
  return { ...values, timeout, positional: positionals };
}

/** Native app navigation must retain its trusted localhost origin, not switch it to 127.0.0.1. */
export const runnerUrl = (port, source) => `http://${source ? 'localhost' : '127.0.0.1'}:${port}/`;
export function nativeClonePage(url, port) {
  try {
    return new URL(url).origin === `http://localhost:${port}`;
  } catch {
    return false;
  }
}

import { readFileSync, rmSync } from 'node:fs';

export const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

export function resetProbe(file) {
  rmSync(file, { force: true });
}

export function assertMcpRefusal(code) {
  if (code !== '401') throw new Error(`expected Office MCP to refuse a Shell worker with 401, got ${code || 'no status'}`);
}

export async function waitForProbe(file, accepts, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let value = '';
  do {
    try {
      value = readFileSync(file, 'utf8').trim();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (accepts(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  return value;
}

import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { officeHome } from './config.js';
import { REMOTE_ADMIN_PATH, REMOTE_ADMIN_TOKEN } from './remote-mcp-http.js';

const HELP = `droid-office remote <list|add|rotate|revoke> [arguments] [--home <office folder>]
  list                         List floors and remote identities
  add <name> <floor> --out <file> Create an independent remote worker
  rotate <id> --out <file>       Revoke the old credential and save a new one
  revoke <id>                   Revoke credentials and release the desk

The office must run with --remote-mcp-port enabled. --out is a new file, mode 0600;
credentials are never printed. Its URL uses Tailscale Serve HTTPS port 8443.
`;

export async function remoteCommand(argv: string[]): Promise<number> {
  if (argv.includes('--help') || !argv.length) {
    console.log(HELP);
    return 0;
  }
  let home = officeHome();
  let out: string | undefined;
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--home' || argv[i] === '--out') {
      const flag = argv[i];
      const value = argv[++i];
      if (!value || value.startsWith('--')) {
        console.error(`${flag} needs a value`);
        return 2;
      }
      if (flag === '--home') home = path.resolve(value);
      else out = path.resolve(value);
    } else args.push(argv[i]);
  }
  const [action, first, second] = args;
  if (!['list', 'add', 'rotate', 'revoke'].includes(action) || args.length !== (action === 'list' ? 1 : action === 'add' ? 3 : 2) || (action === 'add' || action === 'rotate') !== !!out) {
    console.error(HELP);
    return 2;
  }
  let fd: number | undefined;
  let wrote = false;
  try {
    if (out) fd = openSync(out, 'wx', 0o600);
    const data = path.join(home, '.droid-office');
    const port = Number(readFileSync(path.join(data, 'hook-port'), 'utf8'));
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid office hook port');
    const token = readFileSync(path.join(data, REMOTE_ADMIN_TOKEN), 'utf8').trim();
    const command = action === 'add' ? { action, name: first, floor: second } : { action, id: first };
    const response = await fetch(`http://127.0.0.1:${port}${REMOTE_ADMIN_PATH}`, {
      method: action === 'list' ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(action === 'list' ? {} : { body: JSON.stringify(command) }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.json()) as Record<string, unknown>;
    if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Remote MCP is not enabled in this office');
    if (fd !== undefined && out) {
      const connection = { type: 'http', url: `https://${body.hostname}:8443/office/mcp`, headers: { Authorization: `Bearer ${body.token}`, 'x-droid-office-worker-id': body.worker } };
      writeFileSync(fd, `${JSON.stringify(connection, null, 2)}\n`);
      wrote = true;
      console.log(`Saved remote worker ${body.worker} connection to ${out}`);
    } else console.log(JSON.stringify(body, null, 2));
    return 0;
  } catch (err) {
    console.error(`Remote MCP: ${(err as Error).message}`);
    return 1;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
      if (!wrote && out) rmSync(out, { force: true });
    }
  }
}

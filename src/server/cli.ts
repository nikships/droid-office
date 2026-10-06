import os from 'node:os';
import path from 'node:path';
import { renderUnicodeCompact } from 'uqr';
import { loadConfig, ensureSelfSigned } from './config.js';
import { startServer } from './server.js';
import { tildify } from './building.js';
import { lanIPv4s } from './lan.js';

const argv = process.argv.slice(2);
if (argv[0] === 'prune') {
  const { prune } = await import('./prune.js');
  process.exit(await prune(argv.slice(1)));
}
if (argv[0] === 'setup') {
  const { setupCommand } = await import('./setup.js');
  process.exit(await setupCommand(argv.slice(1)));
}

const cfg = loadConfig(argv);
cfg.homeFloor = os.homedir();
await ensureSelfSigned(cfg);
// A new office started in a terminal: where projects go, GitHub or GitLab, and the first floor, before it opens.
if (!cfg.project) {
  const { interactive, welcome } = await import('./setup.js');
  if (interactive()) await welcome(cfg);
}

let office: Awaited<ReturnType<typeof startServer>>;
try {
  office = await startServer(cfg);
} catch (err) {
  const e = err as NodeJS.ErrnoException;
  if (e.code === 'EADDRINUSE') console.error(`droid-office: port ${cfg.port} is already in use (try --port)`);
  else console.error(`droid-office: ${e.message}`);
  process.exit(1);
}

const scheme = cfg.tls ? 'https' : 'http';
const localUrl = `${scheme}://localhost:${cfg.port}`;
// A device on the LAN (another browser) opens the join URL, token and all; this machine's own browser
// on loopback needs no token. A loopback-only bind (--host 127.0.0.1) has no join URL.
const wildcard = cfg.host === '0.0.0.0' || cfg.host === '::';
const loopbackOnly = cfg.host === '127.0.0.1' || cfg.host === '::1' || cfg.host === 'localhost';
const lanIps = wildcard ? lanIPv4s() : loopbackOnly ? [] : [cfg.host];
const joinUrl = lanIps.length ? `${scheme}://${lanIps[0]}:${cfg.port}/?t=${office.lanToken}` : undefined;

const agent = office.resolvedAgent;
function floorsLine() {
  const floors = office.floors();
  const where = `checkouts are looked for in ${tildify(office.projectsDir())}`;
  if (!floors.length) return `🛗 no floors yet — ride the elevator in the office to add a project (${where})`;
  return `🛗 ${floors.length} floor${floors.length === 1 ? '' : 's'}: ${floors.map((f) => f.def.name).join(', ')} (${where})`;
}

// Started in a project that's still one of the floors (it can be taken off like any other).
const local = cfg.project && office.floors().some((f) => path.resolve(f.def.dir) === cfg.project);
console.log(`
  🏢  droid-office is open${local ? ` for ${cfg.project}` : ''}

  ${floorsLine()}

  ${localUrl}

  default agent: ${[agent ?? `${cfg.agentCmd} (via login shell)`, ...cfg.agentArgs].join(' ')}
  choose Claude Code, OpenCode, Codex or Droid when hiring or queueing a task`);
if (joinUrl) {
  console.log(`
  📱 A device on the same Wi-Fi opens the join URL (scan the QR code or open the link):

  ${joinUrl}
`);
  console.log(`${renderUnicodeCompact(joinUrl, { border: 1 }).replace(/^/gm, '  ')}`);
  const others = lanIps.slice(1).map((ip) => `${scheme}://${ip}:${cfg.port}/?t=${office.lanToken}`);
  if (others.length) console.log(`  Other addresses of this machine:\n\n  ${others.join('\n  ')}`);
}

let closing = false;
// SIGTERM is a restart (tsx watch reloading, a plain `kill`, systemd): workers keep running in their
// terminal host and the next office picks them back up. Ctrl+C closes the office and stops them.
// (Under systemd that needs KillMode=process, or stopping the service stops the host with it; see
// deploy/provision.sh. Workers cut off that way are resumed and carry on.)
const stop = (signal: NodeJS.Signals) => {
  if (closing) process.exit(1);
  closing = true;
  const keep = signal === 'SIGTERM';
  console.log(keep ? '\n  closing the office — workers keep running for the next one…' : '\n  closing the office…');
  office.shutdown(keep);
  setTimeout(() => process.exit(0), 300);
};
// Last line of defense: one bad request must never take down every running worker.
process.on('unhandledRejection', (err) => console.error('droid-office: unhandled rejection', err));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
if (argv[0] === 'prune') {
  const { prune } = await import('./prune.js');
  process.exit(await prune(argv.slice(1)));
}
if (argv[0] === 'setup') {
  const { setupCommand } = await import('./setup.js');
  process.exit(await setupCommand(argv.slice(1)));
}

if (argv[0] === 'browser') {
  const { browserCommand } = await import('./whiteboard-browser.js');
  process.exit(await browserCommand(argv.slice(1)));
}

const [{ renderUnicodeCompact }, { loadConfig, ensureSelfSigned }, { startServer }, { tildify }, { FACTORY_SKILLS_DIR }, { COMPANION_PATH }, { enforcedAgentArgs }] = await Promise.all([
  import('uqr'),
  import('./config.js'),
  import('./server.js'),
  import('./building.js'),
  import('./subagents.js'),
  import('../shared/devices.js'),
  import('./workers.js'),
]);

const cfg = loadConfig(argv);
cfg.homeFloor = os.homedir();
cfg.skillsDir = FACTORY_SKILLS_DIR;
cfg.renders = true;
cfg.remoteMcp = !/^(0|off|false|no)$/i.test(process.env.DROID_OFFICE_REMOTE_MCP?.trim() ?? '');
cfg.tailnetHttps = !/^(0|off|false|no)$/i.test(process.env.DROID_OFFICE_TAILNET_HTTPS?.trim() ?? '');
cfg.guestSharing = !/^(0|off|false|no)$/i.test(process.env.DROID_OFFICE_GUEST_SHARING?.trim() ?? '');
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

let closing = false;
// Install shutdown handlers before waiting for Tailscale: certificate approval can take time.
const stop = (signal: NodeJS.Signals) => {
  if (closing) process.exit(1);
  closing = true;
  const keep = signal === 'SIGTERM';
  console.log(keep ? '\n  closing the office — workers keep running for the next one…' : '\n  closing the office…');
  void office.shutdown(keep).finally(() => setTimeout(() => process.exit(0), 300));
};
// One bad request must never take down every running worker.
process.on('unhandledRejection', (err) => console.error('droid-office: unhandled rejection', err));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

const scheme = cfg.tls ? 'https' : 'http';
const localUrl = `${scheme}://localhost:${cfg.port}`;

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
${office.companion() ? `\n  🌐  Web companion, in any browser on this machine: ${localUrl}${COMPANION_PATH} (links for other computers: ⚙️ Settings → Phone & web → Web companion)\n` : ''}
  agent: ${[agent ?? `${cfg.agentCmd} (via login shell)`, '--auto', 'high', ...enforcedAgentArgs(cfg.agentArgs)].join(' ')}`);
// Local startup stays fast. Only the remote QR code waits for Serve to finish.
await office.httpsReady;
const pairing = await office.pairing().catch(() => undefined);
if (pairing?.link) {
  const origin = pairing.addresses[0].url;
  console.log(`
  🔒 Remote access uses Tailscale HTTPS only. Sign both devices in to the same tailnet.
  Web companion: ${origin}${COMPANION_PATH}?t=${office.lanToken}
  Droid Office for Android: scan this pairing code, or open ⚙️ Settings → Phone & web.
`);
  console.log(renderUnicodeCompact(pairing.link, { border: 1 }).replace(/^/gm, '  '));
} else {
  console.log(`\n  Remote access: ${pairing?.reason ?? 'Tailscale HTTPS is not ready.'}`);
}

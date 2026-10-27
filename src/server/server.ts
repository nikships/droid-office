import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import type { Config } from './config.js';
import type { AddressInfo } from 'node:net';
import { bearerToken, isLoopback, lanAllowed, lanIPv4s, mintLanToken, tailscaleIPv4s } from './lan.js';
import { DevicesStore, machineName, pairingAddresses } from './devices.js';
import { TailscaleWatch } from './tailscale.js';
import { WebCompanion } from './web-companion.js';
import { COMPANION_OFF, pairingLink, type PairedDevice, type PairingState } from '../shared/devices.js';
import { MAX_REPOS, childEnv, resolveAgent, type RepoSource } from './workers.js';
import { DROID_MODEL_MAX } from './agents.js';
import { createDroidModelCatalogue } from './droid-models.js';
import { HiddenModels } from './hidden-models.js';
import { Upgrader } from './upgrade.js';
import { GUEST_REFUSED, GuestScanner, guestRefusal, type AgentProcess } from './guests.js';
import { PhoneSizes } from './phone-sizes.js';
import { UPLOAD_MAX_BYTES } from '../shared/decor.js';
import { ImageProxy } from './decor.js';
import { Webhook } from './webhook.js';
import { JiraOffice } from './jira.js';
import { mountFactory, sendDownload } from './factory/index.js';
import { mountSetup } from './setup/index.js';
import { mountSubscriptions } from './subscriptions/index.js';
import { MAX_WORKER_LIMIT, Machine, parseWorkerLimit } from './machine.js';
import { Building, type FloorDef } from './building.js';
import { Floor, type FloorContext } from './floor.js';
import { Sky } from './sky.js';
import { LeaveOnMerge } from './leave-on-merge.js';
import { FreshMain } from './saved-switch.js';
import { Subagents } from './subagents.js';
import { OfficePrompts } from './prompts.js';
import { HotReload, sourceAppDir } from './hot-reload.js';
import { readGpuStats } from './gpu-stats.js';
import { TrackpadHaptics } from './haptics.js';
import { OFFICE_SHELL_ID } from '../shared/office-shell.js';
import type { Arrival, ClientMsg, FloorInfo, FloorView, SearchResults, ServerMsg } from '../shared/protocol.js';
import { AUTO_DESK, GH_COMMENT_MAX, GH_LABEL_MAX, isAgentEffort } from '../shared/protocol.js';
import { elevatorSpot, nextFreeSeat, streetBelow } from '../shared/layout.js';
import { STREAM } from '../shared/jukebox.js';
import { Jukebox } from './jukebox.js';
import { resolveSoundCloudStation } from './soundcloud.js';
import { SEARCH_MAX, SEARCH_MIN, searchKey } from '../shared/search.js';
import { DROP_MAX_BYTES, PROMPT_IMAGES_MAX, PROMPT_IMAGE_ID } from '../shared/drops.js';
import { MAX_FLOORS, forgeWords, returnLanding } from '../shared/floors.js';
import { PROMPTS, PROMPT_MAX, isPromptId } from '../shared/prompts.js';
import { ROOF } from '../shared/rooftop.js';
import { NO_PIPELINES } from '../shared/pipelines.js';
import { MAX_ASSET_BYTES, OWNER_AUTHOR, parseEnvelope } from '../shared/whiteboard.js';
import { pingEligibility } from '../shared/whiteboard-ping.js';
import { CARD_ROUTE, cardResponse, renderInfo, renderStatus, type CardResponse } from './whiteboard.js';
import { RenderEngine } from './whiteboard-render.js';
import { handleAgent } from './whiteboard-agent.js';
import { WhiteboardSkill } from './whiteboard-skill.js';
import { officePrompt } from './prompts.js';
import { Answers } from './answers.js';
import { WorkerThreadReader } from './worker-thread.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
};

const CLEANUPS = new Set(['keep', 'worktree', 'all']);

/** The longest model id Droid takes, so an overlong one fails validation instead of being clipped. */
const MODEL_MAX = DROID_MODEL_MAX;
/** The longest worktree setup command a floor can be given in Settings. */
const SETUP_MAX = 2000;

type ToastLevel = Extract<ServerMsg, { t: 'toast' }>['level'];

interface Client {
  id: string;
  ws: WebSocket;
  /** The floor this connection is on (ROOF, or null out in the empty lobby); routing reads this. */
  floor: string | null;
  /**
   * Display provenance only: the name (?name=, or the `profile` message) and color this
   * connection's toasts, createdBy and score names are written with. Nothing routes or filters
   * by it; every connection is the owner.
   */
  peer: { name: string; color: string };
  attached: Set<string>;
  /** Terminals whose output was skipped because this client fell behind; re-snapshotted later. */
  stale: Set<string>;
  lastGongAt: number;
  /** Cleared at each heartbeat ping and set again by the pong; still clear at the next one means gone. */
  isAlive: boolean;
  /** The paired phone this connection came in with (its device token), if it did. */
  device?: string;
  /** Terminals this phone resized, put back when it disconnects (see phone-sizes.ts). */
  phoneSizes?: PhoneSizes;
  /** A non-scene browser must never receive window.office automation commands. */
  dashboard: boolean;
  requests: Set<string>;
  /** The Whiteboard epoch this connection numbers its batches in, per floor (see WhiteboardStore.issueEpoch). */
  boards: Map<string, string>;
}

const SLOW_CLIENT_BYTES = 8 * 1024 * 1024;

function findPublicDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(here, '../../public'), path.resolve(here, '../../dist/public')];
  for (const c of candidates) if (existsSync(path.join(c, 'index.html'))) return c;
  throw new Error(`Client bundle not found (looked in ${candidates.join(', ')}). Run \`npm run build\`.`);
}

function readBody(req: http.IncomingMessage, limit = 1024 * 1024): Promise<string> {
  return readBytes(req, limit).then((b) => b.toString('utf8'));
}

function readBytes(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Whether the page asking is the office itself. Loopback requests bypass the LAN token (they are the
 * office's own machine), so upgrades and owner writes always need the Origin to match too: without
 * that, any site the owner has open could drive their office over loopback.
 */
function sameOrigin(req: http.IncomingMessage, cfg: Config): boolean {
  const origin = req.headers.origin;
  const host = (cfg.trustProxy && (req.headers['x-forwarded-host'] as string)) || req.headers.host;
  try {
    return !!origin && new URL(origin).host === host;
  } catch {
    return false;
  }
}

function refuseUpgrade(socket: Duplex) {
  socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
  socket.destroy();
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(json);
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
/** Which of a worker's repositories a Changes message is about: another floor's (see WorkerInfo.repos), or none for its own. */
const repoOf = (v: unknown) => str(v, 64) || undefined;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
/** What an office tab answered a relayed automation command with (see automationRequest). */
type AutomationAnswer = { ok: boolean; value?: unknown; error?: string; timedOut?: boolean };
/** How long a relayed automation command waits on the tab by default: longer than a walk across the floor. */
const AUTOMATION_TIMEOUT = 90_000;
/** Where someone going to another floor says they arrive (see `floor.go`): on the grounds, or nowhere (the elevator). */
function arrivalSpot(at: unknown): { x: number; y: number; z: number; rotY: number } | undefined {
  if (!at || typeof at !== 'object') return undefined;
  const a = at as Record<string, unknown>;
  const clamp = (v: unknown, lo: number, hi: number) => Math.min(hi, Math.max(lo, num(v)));
  // Down on the street from a floor high up, the street is a long way down.
  return { x: clamp(a.x, -60, 60), y: clamp(a.y, streetBelow(MAX_FLOORS - 1), 10), z: clamp(a.z, -60, 60), rotY: num(a.rotY) };
}
/** The spot someone coming back in says they were standing in (see Net.connect), if they say. */
function spotFrom(q: URLSearchParams): ReturnType<typeof arrivalSpot> {
  const n = (k: string) => (q.get(k) ? Number(q.get(k)) : NaN);
  const [x, y, z, rotY] = ['x', 'y', 'z', 'rotY'].map(n);
  return Number.isFinite(x) && Number.isFinite(z) ? arrivalSpot({ x, y, z, rotY }) : undefined;
}
/** The ids of the pictures a prompt carries, in the order they were added: well-formed, no repeats, no more than a prompt can take. */
const imageIds = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.map((x) => str(x, 16)).filter((x) => PROMPT_IMAGE_ID.test(x)))].slice(0, PROMPT_IMAGES_MAX) : []);
const issueNumber = (v: unknown) => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : undefined);
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
/** The most lines per worker's terminal a search answers with. */
const SEARCH_TERMINAL_HITS = 25;

export async function startServer(cfg: Config) {
  const publicDir = findPublicDir();
  const appDir = sourceAppDir();
  const hotReload = new HotReload({ appDir, dataDir: cfg.dataDir, publicDir });
  // Frozen at startup, outside the game bundle: a bad source edit cannot remove recovery.
  const reloadScriptFile = [path.join(publicDir, 'office-reload.js'), ...(appDir ? [path.join(appDir, 'src/client/public/office-reload.js')] : [])].find(existsSync);
  const reloadScript = reloadScriptFile ? readFileSync(reloadScriptFile, 'utf8') : '';
  // This start's LAN token (see lan.ts): in memory only, a new one next start.
  const lanToken = mintLanToken();
  // Paired phones (see devices.ts): a device token opens the office like the LAN token, across restarts.
  const devices = new DevicesStore(cfg.dataDir);
  const tailscale = new TailscaleWatch();
  void tailscale.get();
  const companion = new WebCompanion(cfg.dataDir);
  const clients = new Map<string, Client>();
  const workerThreads = new WorkerThreadReader();
  /** The office Mac's trackpad taps for a charging shot; a silent no-op off macOS (see haptics.ts). */
  const trackpadHaptics = new TrackpadHaptics();
  /** What the office is called where it has no project of its own to go by (webhooks). */
  const officeName = cfg.project ? path.basename(cfg.project) : 'the office';
  /** The droid every floor runs, by absolute path; null until it's installed (Setup sets it then). */
  let agentPath = resolveAgent(cfg.agentCmd);
  // Droid lists its own models (built-in and custom); its settings file is the fallback.
  const droidModels = createDroidModelCatalogue({ command: () => agentPath ?? cfg.agentCmd, cwd: cfg.dir });
  const hiddenModels = new HiddenModels(cfg.dataDir);

  const sendTo = (c: Client, msg: ServerMsg) => {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
  };
  const broadcast = (msg: ServerMsg, except?: string, droppable = false) => {
    const json = JSON.stringify(msg);
    for (const c of clients.values()) {
      if (c.id === except || c.ws.readyState !== WebSocket.OPEN) continue;
      if (droppable && c.ws.bufferedAmount > 4 * 1024 * 1024) continue;
      c.ws.send(json);
    }
  };
  const toastAll = (text: string, level: ToastLevel = 'info') => broadcast({ t: 'toast', text, level });

  // --- The building: a floor per project, each with its own workers and boards -----------------
  const building = new Building(cfg.dataDir, cfg.projectsDir);
  if (cfg.projects) {
    const err = building.setProjectsDir(cfg.projects, 'the command line');
    if (err) console.error(`droid-office: --projects: ${err}`);
  }
  const floors = new Map<string, Floor>();
  const floorOf = (c: Client): Floor | undefined => (c.floor ? floors.get(c.floor) : undefined);
  /** The floor a worker sits on. Worker ids are unique across the building. */
  const workerFloor = (workerId: string): Floor | undefined => {
    for (const f of floors.values()) if (f.workers.get(workerId)) return f;
    return undefined;
  };
  /** The floor a guest sits on (see guests.ts): an agent someone runs outside the office, which the office only watches. */
  const guestFloor = (workerId: string): Floor | undefined => {
    for (const f of floors.values()) if (f.guests.get(workerId)) return f;
    return undefined;
  };
  /** To everyone on one floor. */
  const toFloor = (floor: Floor, msg: ServerMsg, droppable = false) => {
    const json = JSON.stringify(msg);
    for (const c of clients.values()) {
      if (c.floor !== floor.id || c.ws.readyState !== WebSocket.OPEN) continue;
      if (droppable && c.ws.bufferedAmount > 4 * 1024 * 1024) continue;
      c.ws.send(json);
    }
  };
  const toastFloor = (floor: Floor | undefined, text: string, level: ToastLevel = 'info', workerId?: string) => {
    if (floor) toFloor(floor, workerId === undefined ? { t: 'toast', text, level } : { t: 'toast', text, level, workerId });
  };
  const floorInfos = (): FloorInfo[] => [...floors.values()].map((f) => ({ ...f.info(), ...(building.isLocal(f.id) ? { local: true } : {}), ...(building.isHome(f.id) ? { home: true } : {}) }));
  // The elevator's counts change with every worker update; tell everyone at most a few times a second.
  let floorsSent = '';
  let floorsTimer: NodeJS.Timeout | undefined;
  const floorsChanged = () => {
    floorsTimer ??= setTimeout(() => {
      floorsTimer = undefined;
      const list = floorInfos();
      const json = JSON.stringify(list);
      if (json === floorsSent) return;
      floorsSent = json;
      broadcast({ t: 'floors', floors: list });
    }, 250);
  };
  /** Tells just this person why their request didn't happen; nothing when there's no error. */
  const warn = (c: Client, error: string | undefined) => {
    if (error) sendTo(c, { t: 'toast', text: error, level: 'warn' });
  };
  const answers = new Answers();

  // --- Loopback-only endpoint for authenticated agent events -------------------------------
  let webhook!: Webhook;
  const hookServer = http.createServer(async (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      return send(res, 400, {});
    }
    if (url.pathname === '/office/workers') return officeWorkers(req, res, url);
    if (url.pathname === '/office/whiteboard') return officeWhiteboard(req, res, url);
    if (url.pathname === '/office/visits') return officeVisits(req, res, url);
    if (req.method !== 'POST' || url.pathname !== '/hooks/droid') return send(res, 404, { ok: false });
    let payload: unknown = {};
    try {
      const body = await readBody(req);
      payload = body ? JSON.parse(body) : {};
    } catch {
      return send(res, 400, { ok: false });
    }
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const workerId = url.searchParams.get('worker') ?? '';
    const workers = workerFloor(workerId)?.workers;
    if (!workers) return send(res, 401, {});
    const event = url.searchParams.get('event') ?? '';
    const ok = workers.handleHook(workerId, token, event, payload);
    send(res, ok ? 200 : 401, {});
  });
  /**
   * A lead's subagents, for the office-workers command (see team.ts): a POST with the action in its
   * JSON body. The worker's own hook token says who's asking, and so whose team it is.
   */
  const officeWorkers = async (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => {
    const workerId = url.searchParams.get('worker') ?? '';
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const floor = workerFloor(workerId);
    const agent = floor?.workers.authenticate(workerId, token);
    if (!floor || !agent) return send(res, 401, { error: 'Send your own DROID_OFFICE_WORKER_ID as ?worker= and DROID_OFFICE_HOOK_TOKEN as the bearer token' });
    if (req.method !== 'POST') return send(res, 405, { error: 'POST, with the action in a JSON body' });
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, { error: 'Send JSON: {"action": "list"}' });
    }
    try {
      const r = await floor.team.handle(agent, body);
      send(res, r.status, r.body);
    } catch (err) {
      send(res, 500, { error: (err as Error).message });
    }
  };
  /**
   * Visits between the floor's independent workers, for the office-visit command (see visits.ts): a
   * POST with the action in its JSON body. The worker's own hook token says who's asking.
   */
  const officeVisits = async (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => {
    const workerId = url.searchParams.get('worker') ?? '';
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const floor = workerFloor(workerId);
    const agent = floor?.workers.authenticate(workerId, token);
    if (!floor || !agent) return send(res, 401, { error: 'Send your own DROID_OFFICE_WORKER_ID as ?worker= and DROID_OFFICE_HOOK_TOKEN as the bearer token' });
    if (req.method !== 'POST') return send(res, 405, { error: 'POST, with the action in a JSON body' });
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, { error: 'Send JSON: {"action": "roster"}' });
    }
    try {
      const r = floor.visits.handle(agent, body);
      send(res, r.status, r.body);
    } catch (err) {
      send(res, 500, { error: (err as Error).message });
    }
  };
  /** The floor's Whiteboard, for the office-whiteboard command (see whiteboard-agent.ts). */
  const officeWhiteboard = async (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => {
    const workerId = url.searchParams.get('worker') ?? '';
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const floor = workerFloor(workerId);
    const agent = floor?.workers.authenticate(workerId, token);
    if (!floor || !agent) return send(res, 401, { error: 'Send your own DROID_OFFICE_WORKER_ID as ?worker= and DROID_OFFICE_HOOK_TOKEN as the bearer token' });
    if (agent.kind === 'shell') return send(res, 403, { error: 'A plain shell has no place on the Whiteboard: only agents do' });
    if (req.method !== 'POST') return send(res, 405, { error: 'POST, with the action in a JSON body' });
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req, 4 * 1024 * 1024));
    } catch {
      return send(res, 400, { error: 'Send JSON: {"action": "read"}' });
    }
    try {
      const r = await handleAgent(floor.whiteboard, agent, { id: floor.id, name: floor.def.name }, body);
      send(res, r.status, r.body);
    } catch (err) {
      // The batch may have been committed before what failed, so don't promise it wasn't: a retry in
      // the same epoch is applied once either way.
      send(res, 500, { error: `The office failed while handling this: ${(err as Error).message}. Run office-whiteboard read to see whether the change is on the board before you try again.` });
    }
  };
  // Workers' terminals outlive a restart of the office (see ptys.ts) with this address in their
  // environment, so listen where the last office did when that port is free.
  const hookPortPath = path.join(cfg.dataDir, 'hook-port');
  const listenHooks = (port: number) =>
    new Promise<void>((resolve, reject) => {
      hookServer.once('error', reject);
      hookServer.listen(port, '127.0.0.1', () => {
        hookServer.off('error', reject);
        resolve();
      });
    });
  let lastHookPort = 0;
  try {
    lastHookPort = Number(readFileSync(hookPortPath, 'utf8')) || 0;
  } catch {
    // first start
  }
  await listenHooks(lastHookPort).catch(() => listenHooks(0));
  const hookPort = (hookServer.address() as { port: number }).port;
  writeFileSync(hookPortPath, String(hookPort), { mode: 0o600 });

  // Day, night and the weather outside the windows, the same for everyone.
  const sky = new Sky({ city: cfg.city, weather: cfg.weather }, (state) => broadcast({ t: 'sky', state }));
  sky.start();
  // Whether a worker whose pull request merged goes home by itself, on every floor (⚙️ Settings).
  const leaveOnMerge = new LeaveOnMerge(cfg.dataDir, (state) => broadcast({ t: 'leaveOnMerge', state }));
  // Whether a fresh worker starts from the latest of the default branch, on every floor (⚙️ Settings).
  const freshMain = new FreshMain(cfg.dataDir, (state) => broadcast({ t: 'freshMain', state }));
  // The prompts the office writes for workers by itself, and the worker a new one starts on when nobody picks (Settings).
  const prompts = new OfficePrompts(cfg.dataDir, (state) => broadcast({ t: 'prompts', state }));
  // How workers hire subagents at the desks, on every floor, and the Droid skill that tells them how (Settings).
  const subagents = new Subagents(cfg.dataDir, (state) => broadcast({ t: 'subagents', state }), cfg.skillsDir);
  subagents.syncSkill();
  // The Droid skill that tells workers how to use the Whiteboard (Settings).
  const whiteboardSkill = new WhiteboardSkill(cfg.dataDir, (state) => broadcast({ t: 'whiteboardSkill', state }), cfg.skillsDir);
  whiteboardSkill.syncSkill();
  // Every floor's Whiteboard renders with one headless Chromium, downloaded on the first render if it's missing.
  const renderer = cfg.renders
    ? new RenderEngine({
        onStatus: (status) => broadcast({ t: 'whiteboard.renderer', status }),
        // A card's requests from the renderer never reach the office itself.
        office: () => {
          let port = cfg.port;
          try {
            port = (server.address() as AddressInfo | null)?.port ?? cfg.port;
          } catch {
            // not listening yet
          }
          return { hosts: [...lanIPv4s(), ...tailscaleIPv4s()], ports: [port, hookPort] };
        },
      })
    : undefined;

  // Slack / Discord pings for workers that need input or finish (set from ⚙️ Settings or --webhook).
  webhook = new Webhook(
    cfg.dataDir,
    (workerId) => (workerId && (workerFloor(workerId) ?? guestFloor(workerId))?.def.name) || officeName,
    (state) => broadcast({ t: 'notify', state }),
  );
  if (cfg.webhook !== undefined) {
    const err = webhook.set(cfg.webhook, 'the command line');
    if (err) console.error(`droid-office: --webhook: ${err}`);
  }

  // The office's one Jira Cloud account, which every floor's epic board reads through (⚙️ Settings).
  const jira = new JiraOffice(cfg.dataDir);
  // The office's Factory API key and every Factory feature read with it (⚙️ Settings → Connections, docs/factory.md).
  // AutoWiki's /wiki runs on a floor's default branch with the office's Droid command (factory/wiki-run.ts).
  const factory = mountFactory({
    dataDir: cfg.dataDir,
    broadcast: (state) => broadcast({ t: 'factory', state }),
    toast: (text, level) => toastAll(text, level),
    // Cloud workers: their Droid session runs on a Factory computer (factory/cloud.ts, cloud-workers.ts).
    cloud: {
      floors: () => [...floors.values()].map((f) => ({ id: f.id, name: f.def.name, repo: f.def.repo, cloud: f.cloud, unstage: (ids: readonly string[]) => f.workers.unstage(ids) })),
      agentArgs: cfg.agentArgs,
      toast: (floorId, text, level) => toastFloor(floors.get(floorId), text, level),
      prompt: (id, vars) => officePrompt(prompts, id, vars),
    },
    // Every floor's workers (desk, cloud and guests) with a session, so each shows what it has cost.
    // Cloud workers live in the floor's CloudWorkers store, not WorkerManager, hence everyone().
    officeSessions: () =>
      [...floors.values()].flatMap((f) =>
        f.everyone().flatMap((w) => (w.sessionId ? [{ sessionId: w.sessionId, workerId: w.id, name: w.name, floor: f.def.name, color: w.color, working: w.status === 'working', createdAt: w.createdAt }] : [])),
      ),
    wiki: {
      floors: () => [...floors.values()].map((f) => ({ id: f.id, dir: f.dir, repo: f.def.repo, name: f.def.name })),
      runner: { command: () => agentPath, env: childEnv },
    },
  });
  const cloud = factory.cloud!;

  // Droid installed and signed in, and the welcome a fresh office opens with (docs/subscriptions.md).
  const setup = mountSetup({
    dataDir: cfg.dataDir,
    agentCmd: cfg.agentCmd,
    broadcast: (state) => broadcast({ t: 'setup', state }),
    toast: (text, level) => toastAll(text, level),
    agentChanged: (file) => {
      agentPath = file;
      droidModels.forget();
      for (const f of floors.values()) f.workers.setAgentPath(file);
    },
  });
  // DroidProxy, and the Claude, ChatGPT and other subscriptions workers run on through it.
  const subscriptions = mountSubscriptions({
    dataDir: cfg.dataDir,
    broadcast: (state) => broadcast({ t: 'subscriptions', state }),
    toast: (text, level) => toastAll(text, level),
    modelsChanged: () => droidModels.forget(),
  });

  // The machine's CPU and memory, for the monitor on the wall and a warning before hiring, and the
  // most workers the office runs at once, across every floor (--max-workers, or ⚙️ Settings).
  const machine = new Machine(
    cfg.dataDir,
    cfg.maxWorkers,
    () => {
      let n = 0;
      for (const f of floors.values()) n += f.workers.list().length;
      return n;
    },
    (state) => broadcast({ t: 'machine', state }),
  );
  machine.start();

  const floorContext: FloorContext = {
    agentCmd: cfg.agentCmd,
    agentArgs: cfg.agentArgs,
    hook: { url: `http://127.0.0.1:${hookPort}`, token: '' },
    capacity: machine,
    jira,
    prompts,
    emit: toFloor,
    toast: toastFloor,
    termData: (workerId, data, connectionIds) => {
      const json = JSON.stringify({ t: 'term.data', workerId, data } satisfies ServerMsg);
      for (const id of connectionIds) {
        const c = clients.get(id);
        if (!c || c.ws.readyState !== WebSocket.OPEN) continue;
        // A connection on a slow link skips output and gets a fresh snapshot once it catches up,
        // instead of queueing unbounded data in server memory.
        if (c.stale.has(workerId) || c.ws.bufferedAmount > SLOW_CLIENT_BYTES) c.stale.add(workerId);
        else c.ws.send(json);
      }
    },
    changes: (state, ids) => {
      for (const id of ids) {
        const c = clients.get(id);
        if (c) sendTo(c, { t: 'changes', state });
      }
    },
    workerChanged: (_floor, w) => {
      answers.changed(typeof w === 'string' ? w : w.id, typeof w === 'string' ? undefined : w.status);
      if (typeof w === 'string') webhook.onWorkerGone(w);
      else webhook.onWorker(w);
      machine.workersChanged();
      floorsChanged();
    },
    connections: (floor) => {
      let n = 0;
      for (const c of clients.values()) if (c.floor === floor.id) n++;
      return n;
    },
    leaveOnMerge: () => leaveOnMerge.on,
    freshMain: () => freshMain.on,
    officeDataDir: cfg.dataDir,
    subagents: () => subagents.settings,
    droidModels: () => droidModels.get(),
    modelGate: (model) => subscriptions.gate(model),
    modelAvailability: (model) => subscriptions.availability(model),
    floor: (id) => floors.get(id),
    pullsChanged: (floor) => {
      for (const f of floors.values()) if (f !== floor && worksIn(f, floor)) f.sendLandedHome();
    },
    lent: (floor) => [...floors.values()].some((f) => f !== floor && worksIn(f, floor)),
    renderer,
  };
  /** Whether a worker on `from` works in `on`'s project too (see WorkerInfo.repos). */
  const worksIn = (from: Floor, on: Floor) => from.workers.list().some((w) => w.repos?.some((r) => r.floor === on.id));
  const openFloor = (def: FloorDef): Floor | undefined => {
    if (!existsSync(def.dir)) {
      console.error(`droid-office: the ${def.name} floor's checkout is gone (${def.dir}) — it stays closed until it's back`);
      return undefined;
    }
    try {
      const floor = new Floor(def, floorContext);
      floors.set(def.id, floor);
      return floor;
    } catch (err) {
      console.error(`droid-office: couldn't open the ${def.name} floor: ${(err as Error).message}`);
      return undefined;
    }
  };
  // Started in a project: it's a floor too (the one it has always been).
  if (cfg.project) building.ensureLocal(cfg.project, 'the office');
  // The home folder is always a floor, after the projects.
  if (cfg.homeFloor) building.ensureHome(cfg.homeFloor);
  for (const def of building.list()) openFloor(def);
  const jukebox = new Jukebox(
    cfg.dataDir,
    building.list().map((def) => path.join(def.dir, '.droid-office')),
  );
  // Workers still running from the last office are back at their desks before anyone walks in.
  await Promise.all([...floors.values()].map((f) => f.ready));

  /** Everything on a floor, for whoever just arrived there. */
  const floorView = (floor: Floor | undefined): FloorView => ({
    floor: floor?.id ?? null,
    project: floor?.project ?? null,
    workers: floor?.everyone() ?? [],
    issues: floor?.board.issues ?? { items: [], fetchedAt: 0, loading: false },
    pulls: floor?.board.pulls ?? { items: [], fetchedAt: 0, loading: false },
    pipelines: floor?.pipelines.state ?? NO_PIPELINES,
    decor: floor?.decor.list() ?? [],
    jira: floor?.jira.state() ?? { connection: jira.connection() },
    jiraBoard: floor?.jira.board ?? null,
    autoHeal: floor?.autoHeal.state() ?? { on: false },
  });
  /** The roof: nobody works up there, so it has none of a floor's things. */
  const roofView = (): FloorView => ({ ...floorView(undefined), floor: ROOF });
  const screensOf = (c: Client, floor: Floor | undefined) => {
    const frames = [...(floor?.workers.fullScreens() ?? []), ...(floor?.cloud.fullScreens() ?? [])];
    const shell = floor?.shell.fullScreen();
    if (shell) frames.push({ workerId: OFFICE_SHELL_ID, frame: shell });
    for (const { workerId, frame } of frames) sendTo(c, { t: 'screen', workerId, ...frame, full: true });
  };
  const images = new ImageProxy();

  const upgrader = new Upgrader(
    (state) => broadcast({ t: 'upgrade', state }),
    () => {
      // cli.ts shuts down gracefully, leaving the workers running in their terminal host; systemd
      // (Restart=always) then starts the new version, which picks them back up.
      process.kill(process.pid, 'SIGTERM');
    },
  );

  // --- HTTP ------------------------------------------------------------------------------------
  /**
   * `immutable` is only for content-hashed names. `revalidate` is for files whose name stays put while
   * their bytes change between releases: the browser keeps them but asks each load, and gets a 304.
   */
  const serveFile = (res: http.ServerResponse, file: string, cache: boolean | 'revalidate', req?: http.IncomingMessage) => {
    const ext = path.extname(file);
    const headers: http.OutgoingHttpHeaders = {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': cache === 'revalidate' ? 'no-cache' : cache ? 'public, max-age=31536000, immutable' : 'no-store',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
    };
    if (cache === 'revalidate') {
      const st = statSync(file);
      headers.etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
      if (req?.headers['if-none-match'] === headers.etag) {
        res.writeHead(304, headers).end();
        return;
      }
    }
    res.writeHead(200, headers);
    createReadStream(file)
      .on('error', (err) => res.destroy(err))
      .pipe(res);
  };

  /** A file of the client bundle, or undefined when it's missing, a folder, or outside the bundle. */
  const publicFile = (p: string): string | undefined => hotReload.file(p);

  const serveIndex = (res: http.ServerResponse, token: string | null) => {
    let html = readFileSync(path.join(hotReload.publicDir, 'index.html'), 'utf8');
    html = html.replace(/<meta\b[^>]*name=["']office-revision["'][^>]*>/gi, '').replace(/<script\b[^>]*src=["']\/api\/hot-reload\/client\.js["'][^>]*>\s*<\/script>/gi, '');
    // A <script> tag can't append the LAN token itself, so the page carries it into the URL.
    const recovery = `<meta name="office-revision" content="${hotReload.state().revision}"><script src="/api/hot-reload/client.js${token ? `?t=${encodeURIComponent(token)}` : ''}" defer></script>`;
    // Also inject when a source edit deletes the original tags (or even the head).
    html = /<head\b[^>]*>/i.test(html) ? html.replace(/<head\b[^>]*>/i, (head) => head + recovery) : recovery + html;
    res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' });
    res.end(html);
  };

  /**
   * Who may reach the office: loopback, this start's LAN token (`?t=`), or a paired phone's device
   * token (`Authorization: Bearer`, or `?d=`). A device token that isn't paired (any more) is refused
   * outright, even on loopback, so a forgotten phone always hears that it was forgotten.
   */
  const access = (req: http.IncomingMessage, url: URL): { ok: boolean; device?: PairedDevice; header?: boolean; unpaired?: boolean } => {
    const header = bearerToken(req);
    const token = header ?? url.searchParams.get('d');
    if (token) {
      const device = devices.verify(token);
      return device ? { ok: true, device, header: header !== undefined } : { ok: false, unpaired: true };
    }
    return { ok: lanAllowed(req, url, lanToken) };
  };
  /**
   * The office's own page on its own machine: loopback, and a same-origin request (the Origin header,
   * or for a GET, which carries none, the browser's Sec-Fetch-Site). What the Phone window reads and
   * changes (the pairing link, the paired phones) answers nothing else: no phone, no LAN browser.
   */
  const ownPage = (req: http.IncomingMessage) => isLoopback(req.socket.remoteAddress) && !bearerToken(req) && (sameOrigin(req, cfg) || (!req.headers.origin && req.headers['sec-fetch-site'] === 'same-origin'));
  const officeCard = () => ({ name: machineName(), version: upgrader.version });
  /** The Phone window's view: the pairing link with the addresses it carries, and the paired phones. */
  const pairingState = async (): Promise<PairingState> => {
    const port = (server.address() as AddressInfo | null)?.port ?? cfg.port;
    const scheme = cfg.tls ? 'https' : 'http';
    const tailnet = await tailscale.get();
    const addresses = pairingAddresses({ scheme, host: cfg.host, port, lan: lanIPv4s(), tailscale: tailnet, tailscaleIps: tailscaleIPv4s() });
    const office = officeCard();
    const reachable = !(cfg.host === '127.0.0.1' || cfg.host === '::1' || cfg.host === 'localhost' || cfg.host.startsWith('127.'));
    const reason = addresses.length
      ? undefined
      : cfg.host === '0.0.0.0' || cfg.host === '::'
        ? 'This machine has no Wi-Fi or Tailscale address a phone could reach it at. Join a network and reopen this window.'
        : 'The office only listens on this machine (--host 127.0.0.1), so no phone can reach it. Start it without --host to pair one.';
    const urls = addresses.map((a) => a.url);
    const link = urls.length ? pairingLink(office.name, lanToken, urls) : undefined;
    return {
      office,
      companion: companion.on,
      local: `${scheme}://localhost:${port}`,
      reachable,
      tailscale: !!tailnet || tailscaleIPv4s().length > 0,
      ...(link ? { link } : {}),
      addresses,
      ...(reason ? { reason } : {}),
      devices: devices.list(),
    };
  };
  /** Turns the web companion on or off. Off closes every companion socket; paired browsers stay paired. */
  const setCompanion = (on: boolean) => {
    if (companion.on === on) return;
    companion.set(on, 'owner');
    console.log(`  🌐  The web companion is ${on ? 'on' : 'off'}`);
    if (!on) for (const c of clients.values()) if (c.dashboard) c.ws.close(4403, 'The web companion was turned off');
  };
  /** Unpairs a phone: its token stops working, and its open connections are closed. */
  const forgetDevice = (id: string): boolean => {
    const name = devices.list().find((d) => d.id === id)?.name;
    if (!devices.forget(id)) return false;
    for (const c of clients.values()) if (c.device === id) c.ws.close(4401, 'This device was unpaired');
    console.log(`  📱 ${name} is no longer paired with the office`);
    return true;
  };

  /** Off the machine without this start's token: APIs get JSON, pages get a pointer to the join link. */
  const refuseHttp = (res: http.ServerResponse, api: boolean, unpaired = false) => {
    if (unpaired) return send(res, 401, { error: 'This device is not paired with the office any more. Pair it again from ⚙️ Settings → Phone & web.' });
    const hint = 'Open the join link from the office’s terminal (it prints a QR code on startup).';
    if (api) return send(res, 401, { error: `This office needs its join link (?t=). ${hint}` });
    res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' });
    res.end(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Join link needed · Droid Office</title></head><body style="font:16px/1.5 system-ui,sans-serif;color:#2b2d42;background:#bfe3ff;display:grid;place-items:center;min-height:100vh;margin:0"><main style="background:#fffaf3;border:3px solid #2b2d42;border-radius:18px;padding:28px 32px;max-width:440px;margin:16px"><h1 style="margin:0 0 8px;font-size:22px">🔒 Join link needed</h1><p style="margin:0">This office only opens with its join link. ${hint}</p></main></body></html>`,
    );
  };

  /** Automation commands relayed to an office tab (POST /api/automation), each waiting on that tab's answer. */
  const automationWaits = new Map<string, { client: string; done: (answer: AutomationAnswer) => void }>();
  /**
   * POST /api/automation {"cmd": "goTo", "args": ["desk-3"]}: runs a `window.office` command in the
   * office tab opened last (not a phone) and answers with what it resolved to. For a command line,
   * so it takes no Origin but the office's own, and JSON only, which a web page elsewhere can't send
   * without a preflight the office never answers.
   */
  const automationRequest = async (req: http.IncomingMessage, res: http.ServerResponse, own: boolean) => {
    if (req.method !== 'POST') return send(res, 405, { error: 'POST a JSON command' }, { allow: 'POST' });
    if (req.headers.origin && !own) return send(res, 403, { error: 'Forbidden' });
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'Send JSON (content-type: application/json)' });
    let body: { cmd?: unknown; args?: unknown; timeout?: unknown } | null;
    try {
      body = JSON.parse(await readBody(req, 64 * 1024));
    } catch {
      body = null;
    }
    const cmd = body && typeof body === 'object' ? str(body.cmd, 32) : '';
    if (!body || !cmd) return send(res, 400, { error: 'Send JSON: {"cmd": "goTo", "args": ["desk-3"]}' });
    const args = Array.isArray(body.args) ? body.args : body.args === undefined ? [] : [body.args];
    const timeout = Math.min(Math.max(num(body.timeout) || AUTOMATION_TIMEOUT, 1000), 5 * 60_000);
    let tab: Client | undefined;
    for (const c of clients.values()) if (!c.device && !c.dashboard && c.ws.readyState === WebSocket.OPEN) tab = c;
    if (!tab) return send(res, 409, { ok: false, error: 'No office tab is open: open the office in a browser first' });
    const id = randomBytes(6).toString('hex');
    const answer = await new Promise<AutomationAnswer>((resolve) => {
      const timer = setTimeout(() => {
        automationWaits.delete(id);
        resolve({ ok: false, error: `The office tab didn't answer within ${Math.round(timeout / 1000)}s`, timedOut: true });
      }, timeout);
      automationWaits.set(id, {
        client: tab.id,
        done: (a) => {
          clearTimeout(timer);
          automationWaits.delete(id);
          resolve(a);
        },
      });
      sendTo(tab, { t: 'automation.run', id, cmd, args });
    });
    const { timedOut, ...out } = answer;
    return send(res, answer.ok ? 200 : timedOut ? 504 : 422, out);
  };

  /** The 🔎 search: lines of the terminals of every worker on that floor, with the words in them. */
  const search = (q: string, floor: Floor | undefined): SearchResults => {
    q = q.slice(0, SEARCH_MAX);
    const needle = searchKey(q);
    if (needle.length < SEARCH_MIN) return { q, terminals: [], more: false };
    const shown = floor?.workers.search(needle, SEARCH_TERMINAL_HITS) ?? { hits: [], more: false };
    return { q, terminals: shown.hits, more: shown.more };
  };

  /** `/whiteboard/c/<cap>/<path>`: whichever floor's store the capability belongs to answers, or nobody does. */
  const serveCard = (req: http.IncomingMessage, res: http.ServerResponse, rest: string) => {
    const slash = rest.indexOf('/');
    const cap = slash < 0 ? rest : rest.slice(0, slash);
    let rel: string;
    try {
      rel =
        slash < 0
          ? ''
          : rest
              .slice(slash + 1)
              .split('/')
              .map(decodeURIComponent)
              .join('/');
    } catch {
      rel = '\0';
    }
    const ifRange = req.headers['if-range'];
    const opts = { method: req.method, ifNoneMatch: req.headers['if-none-match'], range: req.headers.range, ifRange: Array.isArray(ifRange) ? ifRange[0] : ifRange };
    let out: CardResponse | undefined;
    if (/^[ks][A-Za-z0-9_-]{20,80}$/.test(cap)) for (const f of floors.values()) if ((out = f.whiteboard.serve(cap, rel, opts))) break;
    out ??= cardResponse(undefined, rel, () => undefined, opts);
    res.writeHead(out.status, out.headers);
    res.end(out.body);
  };
  /** The window's Whiteboard routes besides the WebSocket: renders, a card's files by hash, uploads. */
  const whiteboardRequest = async (req: http.IncomingMessage, res: http.ServerResponse, p: string, url: URL, floor: Floor | undefined, own: boolean) => {
    if (!floor) return send(res, 404, { error: 'No such floor' });
    const store = floor.whiteboard;
    const cardId = str(url.searchParams.get('card'), 64);
    const card = store.board.cards.find((x) => x.id === cardId);
    if (p === '/api/whiteboard/render/status' && req.method === 'GET') return send(res, 200, renderStatus(store.renderer, card, cardId));
    if (p === '/api/whiteboard/render' && req.method === 'GET') {
      // An image made before the renderer went away is still served; x-whiteboard-current says how fresh it is.
      const image = store.renderer.latest(cardId).image;
      if (!image) {
        const status = store.renderer.status();
        if (!status.available) return send(res, 503, status);
        return send(res, 404, { error: 'This card has no image yet', status: renderStatus(store.renderer, card, cardId) });
      }
      const thumb = url.searchParams.get('size') === 'thumb';
      const tile = Math.max(0, Math.floor(Number(url.searchParams.get('tile')) || 0));
      const body = thumb ? (image.thumb ?? image.tiles[0]) : image.tiles[tile];
      if (!body) return send(res, 404, { error: `This image has ${image.tiles.length} tiles` });
      const current = !!card && renderStatus(store.renderer, card, cardId).image?.current;
      res.writeHead(200, {
        'content-type': 'image/png',
        'content-length': String(body.length),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-whiteboard-rev': String(image.rev),
        'x-whiteboard-rendered-at': String(image.at),
        'x-whiteboard-age-ms': String(Math.max(0, Date.now() - image.at)),
        'x-whiteboard-current': current ? '1' : '0',
        'x-whiteboard-tiles': String(image.tiles.length),
        'x-whiteboard-tile-height': String(image.tileHeight),
        'x-whiteboard-size': `${image.width}x${image.height}`,
      });
      return res.end(body);
    }
    if (p === '/api/whiteboard/file' && req.method === 'GET') {
      const got = store.cardFile(cardId, str(url.searchParams.get('hash'), 64));
      if (!got) return send(res, 404, { error: 'This card holds no such file' });
      res.writeHead(200, {
        'content-type': got.ref.mime,
        'content-length': String(got.body.length),
        // Content-addressed: the bytes for a hash never change.
        'cache-control': 'private, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        'cross-origin-resource-policy': 'same-origin',
      });
      return res.end(got.body);
    }
    if (p === '/api/whiteboard/blob') {
      if (req.method !== 'POST') return send(res, 405, { error: 'POST the file' }, { allow: 'POST' });
      if (!own) return send(res, 403, { error: 'Forbidden' });
      const mime = str(url.searchParams.get('mime') || req.headers['content-type'], 128) || 'application/octet-stream';
      const tooBig = `That file is too big for the Whiteboard (${MAX_ASSET_BYTES / 1024 / 1024} MB a file at most)`;
      if (Number(req.headers['content-length']) > MAX_ASSET_BYTES) return send(res, 413, { error: tooBig });
      let body: Buffer;
      try {
        body = await readBytes(req, MAX_ASSET_BYTES);
      } catch (err) {
        return (err as Error).message === 'too large' ? send(res, 413, { error: tooBig }) : send(res, 400, { error: 'Bad request' });
      }
      return send(res, 200, store.stage(body, mime));
    }
    return send(res, 404, { error: 'Not found' });
  };

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    try {
      let url: URL;
      let p: string;
      try {
        url = new URL(req.url ?? '/', 'http://x');
        p = decodeURIComponent(url.pathname);
      } catch {
        return send(res, 400, { error: 'Bad request' });
      }
      // The client bundle's static files: hashed scripts, models, fonts and icons. They carry no
      // office data, and <script> tags, stylesheets and 3D loaders can't append the LAN token, so
      // they load openly; the office itself (below) always needs it.
      if (p.startsWith('/assets/')) {
        const file = publicFile(p);
        if (file) return serveFile(res, file, true);
        res.writeHead(404).end();
        return;
      }
      // Props keep their names when a release or a regenerate changes them (manifest.json gains rows),
      // so a cached copy is checked every load; an immutable one would hide new props after an update.
      if (p.startsWith('/props/')) {
        const file = publicFile(p);
        if (file) return serveFile(res, file, 'revalidate', req);
        res.writeHead(404).end();
        return;
      }
      if (p === '/favicon.svg' || p === '/factory-glyph.svg' || p === '/manifest.webmanifest' || p.startsWith('/icons/') || p.startsWith('/fonts/')) {
        const file = publicFile(p);
        if (file) return serveFile(res, file, false);
        res.writeHead(404).end();
        return;
      }
      // A Whiteboard card's files (see whiteboard.ts): the capability in the path is the only credential,
      // so the sandboxed frame and its relative assets load without the LAN token.
      if (url.pathname.startsWith(CARD_ROUTE)) return serveCard(req, res, url.pathname.slice(CARD_ROUTE.length));
      // Public bootstrap only: no office state or injected credentials. Saved browser tokens are
      // origin-scoped JS storage and cannot accompany a top-level bookmarked navigation.
      if (p === '/dashboard' || p === '/dashboard/' || p === '/dashboard.html') {
        const file = publicFile('/dashboard.html');
        if (!file) return send(res, 503, { error: 'Companion bundle missing. Rebuild or update Droid Office.' });
        return serveFile(res, file, false);
      }
      // A phone pairing: it scanned this start's QR code, so it has the LAN token (or it's on this
      // machine). A device token doesn't pair another device. A web page's cross-origin POST is refused.
      if (p === '/api/mobile/pair' && req.method === 'POST') {
        if (!lanAllowed(req, url, lanToken)) return refuseHttp(res, true);
        if (req.headers.origin && !sameOrigin(req, cfg)) return send(res, 403, { error: 'Forbidden' });
        let body: { device?: unknown; kind?: unknown } | null;
        try {
          const text = await readBody(req, 4096);
          body = text.trim() ? JSON.parse(text) : {};
        } catch {
          return send(res, 400, { error: 'Send JSON: {"device": "Pixel 10 Pro XL"}' });
        }
        const browser = body?.kind === 'browser';
        if (browser && !companion.on) return send(res, 403, { error: COMPANION_OFF, companionOff: true });
        if (browser && !sameOrigin(req, cfg)) return send(res, 403, { error: 'Pair this browser from the office’s own address.' });
        const paired = devices.pair(body && typeof body === 'object' ? body.device : undefined, browser ? 'browser' : undefined);
        if (!paired) return send(res, 409, { error: 'Too many devices are paired with this office. Forget one in ⚙️ Settings → Phone & web first.' });
        console.log(`  📱 ${paired.device.name} paired with the office`);
        toastAll(`📱 ${paired.device.name} paired with the office`);
        return send(res, 200, { deviceId: paired.device.id, token: paired.token, office: officeCard(), ...(browser ? { device: paired.device } : {}) });
      }
      // Everything else needs this start's token or a paired phone's from off the machine (loopback connects freely).
      const gate = access(req, url);
      if (!gate.ok) return refuseHttp(res, p.startsWith('/api/'), gate.unpaired);
      // Off, the companion's own check-in and every paired browser's request hear why, not a bare refusal.
      if (!companion.on && (gate.device?.kind === 'browser' || (p === '/api/mobile/hello' && url.searchParams.get('client') === 'dashboard'))) return send(res, 403, { error: COMPANION_OFF, companionOff: true });
      // Query credentials authenticate embedded resources too, but never make a foreign browser
      // origin an office page. Native clients without Origin keep their existing bearer contract.
      if (req.headers.origin && !sameOrigin(req, cfg)) return send(res, 403, { error: 'Forbidden' });
      if (gate.device) devices.seen(gate.device.id);
      // A paired phone's bearer header can't come from a web page (it would need a CORS preflight the
      // office never answers), so it counts as the office's own request where the Origin is checked.
      const ownRequest = () => sameOrigin(req, cfg) || (!!gate.device && !!gate.header);

      if (p === '/api/health') return send(res, 200, { ok: true });
      if (p === '/api/automation') return automationRequest(req, res, ownRequest());
      if (p === '/api/mobile/hello' && req.method === 'GET') return send(res, 200, { ok: true, office: officeCard(), ...(gate.device ? { deviceId: gate.device.id } : {}) });
      if (p === '/api/mobile/pair' && req.method === 'DELETE') {
        // The phone's own "Unpair": only with its device token.
        if (!gate.device) return send(res, 400, { error: 'Send the device token to unpair (Authorization: Bearer <token>)' });
        if (!ownRequest()) return send(res, 403, { error: 'Forbidden' });
        forgetDevice(gate.device.id);
        return send(res, 200, { ok: true });
      }
      if (p === '/api/mobile/pairing' || p === '/api/mobile/companion' || p.startsWith('/api/mobile/devices/')) {
        if (gate.device || !ownPage(req)) return send(res, 403, { error: 'Pair devices from the office itself, on its own machine' });
        if (p === '/api/mobile/pairing' && req.method === 'GET') return send(res, 200, await pairingState());
        if (p === '/api/mobile/companion' && req.method === 'PUT') {
          let body: { on?: unknown } | null;
          try {
            body = JSON.parse(await readBody(req, 1024));
          } catch {
            return send(res, 400, { error: 'Send JSON: {"on": true}' });
          }
          if (typeof body?.on !== 'boolean') return send(res, 400, { error: 'Send JSON: {"on": true}' });
          setCompanion(body.on);
          return send(res, 200, await pairingState());
        }
        if (p.startsWith('/api/mobile/devices/') && req.method === 'DELETE') {
          return forgetDevice(p.slice('/api/mobile/devices/'.length)) ? send(res, 200, await pairingState()) : send(res, 404, { error: 'No such phone' });
        }
        return send(res, 405, { error: 'Method not allowed' });
      }
      // The Mac's GPU load for the performance overlay. Only a page on this machine draws on this GPU.
      if (p === '/api/gpu' && req.method === 'GET') {
        if (!ownPage(req)) return send(res, 200, { stats: null, reason: 'not on the office’s machine' });
        const stats = await readGpuStats();
        return send(res, 200, stats ? { stats } : { stats: null, reason: process.platform === 'darwin' ? 'ioreg failed' : 'macOS only' });
      }
      // A charged shot's trackpad taps. Only a page on this machine has a finger on this trackpad;
      // any other page is told there is nothing to feel so it stops asking (see haptics.ts).
      if (p === '/api/haptics') {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST' }, { allow: 'POST' });
        if (!ownPage(req)) return send(res, 200, { ok: false, supported: false, reason: 'not on the office’s machine' });
        let body: { pattern?: unknown } | null;
        try {
          body = JSON.parse(await readBody(req, 1024));
        } catch {
          return send(res, 400, { error: 'Send JSON: {"pattern": "tick" | "charged" | "super"}' });
        }
        const result = trackpadHaptics.perform(body && typeof body === 'object' ? body.pattern : undefined);
        return result.ok ? send(res, 200, result) : send(res, result.supported ? 400 : 200, { ...result, ...(result.supported ? { error: 'Unknown pattern' } : {}) });
      }
      if (p === '/api/hot-reload/client.js' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        return res.end(reloadScript);
      }
      if (p === '/api/hot-reload') {
        const state = () => hotReload.state();
        if (req.method === 'GET') return send(res, 200, state());
        if (req.method !== 'POST') return send(res, 405, { error: 'GET or POST' }, { allow: 'GET, POST' });
        if (!sameOrigin(req, cfg)) return send(res, 403, { error: 'Use source hot reload from the office itself' });
        let body: { enabled?: unknown; rebuild?: unknown } | null;
        try {
          body = JSON.parse(await readBody(req, 4096));
        } catch {
          return send(res, 400, { error: 'Send JSON with enabled or rebuild' });
        }
        if (!body || typeof body !== 'object' || (typeof body.enabled === 'boolean') === (body.rebuild === true)) return send(res, 400, { error: 'Choose enabled (boolean) or rebuild (true)' });
        const error = typeof body.enabled === 'boolean' ? await hotReload.setEnabled(body.enabled) : hotReload.rebuild();
        return error ? send(res, 400, { error }) : send(res, 200, state());
      }
      if (p === '/api/agents/droid/models' && req.method === 'GET') {
        try {
          const catalogue = await droidModels.get();
          return send(res, 200, { models: catalogue.models, defaultModel: catalogue.defaultModel, defaultReasoningEffort: catalogue.defaultReasoningEffort });
        } catch {
          return send(res, 502, { error: 'Could not load Droid models' });
        }
      }
      if (p === '/api/jukebox/soundcloud' && req.method === 'GET') {
        const r = await resolveSoundCloudStation(url.searchParams.get('url') ?? '');
        return 'error' in r ? send(res, r.status, { error: r.error }) : send(res, 200, r);
      }
      if (p === '/api/image' && req.method === 'GET') {
        // A picture on the wall, fetched by the office so the 3D view can draw it (see decor.ts).
        const r = await images.get(url.searchParams.get('url') ?? '');
        if ('error' in r) return send(res, r.status, { error: r.error });
        res.writeHead(200, {
          'content-type': r.type,
          'content-length': String(r.body.length),
          'cache-control': 'private, max-age=3600',
          'x-content-type-options': 'nosniff',
          // Opened on its own (an SVG, say), it still can't run anything on the office's origin.
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
          'cross-origin-resource-policy': 'same-origin',
        });
        res.end(r.body);
        return;
      }
      // Which floor a request is about: its boards and its workers.
      const floor = floors.get(url.searchParams.get('floor') ?? '');
      if (p === '/api/term/drop') {
        // A file dropped or pasted into a worker's terminal, kept on this machine for the terminal to type its path.
        if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
        if (!ownRequest()) return send(res, 403, { error: 'Forbidden' });
        if (!floor) return send(res, 404, { error: 'No such floor' });
        const workerId = str(url.searchParams.get('worker'), 32);
        const shellDrop = workerId === OFFICE_SHELL_ID;
        if (!shellDrop && !floor.workers.get(workerId)) return send(res, 404, { error: 'No such worker' });
        const tooBig = `That file is too big to drop into a terminal (${DROP_MAX_BYTES / 1024 / 1024} MB at most)`;
        if (Number(req.headers['content-length']) > DROP_MAX_BYTES) return send(res, 413, { error: tooBig });
        let body: Buffer;
        try {
          body = await readBytes(req, DROP_MAX_BYTES);
        } catch (err) {
          return (err as Error).message === 'too large' ? send(res, 413, { error: tooBig }) : send(res, 400, { error: 'Bad request' });
        }
        const name = str(url.searchParams.get('name'), 256);
        const type = str(req.headers['content-type'], 128);
        const file = shellDrop ? floor.shell.drop(name, type, body) : floor.workers.drop(workerId, name, type, body);
        return file ? send(res, 200, { path: file }) : send(res, 500, { error: 'The office could not keep that file' });
      }
      if (p === '/api/prompt/image') {
        // A picture pasted into a prompt that isn't sent yet, kept on this machine until it is (POST), or taken out again (DELETE).
        if (req.method !== 'POST' && req.method !== 'DELETE') return send(res, 405, { error: 'Method not allowed' });
        if (!ownRequest()) return send(res, 403, { error: 'Forbidden' });
        if (!floor) return send(res, 404, { error: 'No such floor' });
        if (req.method === 'DELETE') {
          floor.workers.unstage(imageIds([url.searchParams.get('id')]));
          return send(res, 200, {});
        }
        const tooBig = `That picture is too big to send with a prompt (${DROP_MAX_BYTES / 1024 / 1024} MB at most)`;
        if (Number(req.headers['content-length']) > DROP_MAX_BYTES) return send(res, 413, { error: tooBig });
        let body: Buffer;
        try {
          body = await readBytes(req, DROP_MAX_BYTES);
        } catch (err) {
          return (err as Error).message === 'too large' ? send(res, 413, { error: tooBig }) : send(res, 400, { error: 'Bad request' });
        }
        const id = floor.workers.stageImage(str(url.searchParams.get('name'), 256), body);
        return id ? send(res, 200, { id }) : send(res, 415, { error: 'Only PNG, JPEG, GIF and WebP pictures can be sent with a prompt' });
      }
      if (p === '/api/decor/picture') {
        // A picture from the owner's computer for this floor's walls: kept (POST, converted when browsers can't draw it), or shown (GET).
        if (!floor) return send(res, 404, { error: 'No such floor' });
        if (req.method === 'GET') {
          const r = await floor.decor.pictures.read(str(url.searchParams.get('name'), 128));
          if (!r) return send(res, 404, { error: 'That picture is no longer kept on this floor' });
          res.writeHead(200, {
            'content-type': r.type,
            'content-length': String(r.body.length),
            // Named by the hash of its bytes, which never change.
            'cache-control': 'private, max-age=31536000, immutable',
            'x-content-type-options': 'nosniff',
            'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
            'cross-origin-resource-policy': 'same-origin',
          });
          return res.end(r.body);
        }
        if (req.method !== 'POST') return send(res, 405, { error: 'GET or POST' }, { allow: 'GET, POST' });
        if (!ownRequest()) return send(res, 403, { error: 'Forbidden' });
        const tooBig = `That file is over ${UPLOAD_MAX_BYTES / 1024 / 1024} MB. Try a smaller copy of it.`;
        if (Number(req.headers['content-length']) > UPLOAD_MAX_BYTES) return send(res, 413, { error: tooBig });
        let body: Buffer;
        try {
          body = await readBytes(req, UPLOAD_MAX_BYTES);
        } catch (err) {
          return (err as Error).message === 'too large' ? send(res, 413, { error: tooBig }) : send(res, 400, { error: 'Bad request' });
        }
        const r = await floor.decor.pictures.save(body, str(url.searchParams.get('name'), 256));
        return 'error' in r ? send(res, r.status, { error: r.error }) : send(res, 200, r);
      }
      if (p === '/api/changes/file') {
        // A changed picture in the Changes window at a desk: before (old) or after (new) the worker's edits.
        if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
        const workerId = str(url.searchParams.get('worker'), 32);
        const file = str(url.searchParams.get('path'), 4096);
        const side = url.searchParams.get('side');
        if (!workerId || !file || (side !== 'old' && side !== 'new')) return send(res, 400, { error: 'Bad request' });
        if (!floor) return send(res, 404, { error: 'No such floor' });
        if (!floor.workers.get(workerId)) return send(res, 404, { error: 'No such worker' });
        const r = await floor.changes.file(workerId, file, side, repoOf(url.searchParams.get('repo')));
        if ('error' in r) return send(res, r.status, { error: r.error });
        res.writeHead(200, {
          'content-type': r.type,
          'content-length': String(r.body.length),
          // The worker may change it again any moment.
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
          'cross-origin-resource-policy': 'same-origin',
        });
        res.end(r.body);
        return;
      }
      if (p.startsWith('/api/factory/')) {
        // A Factory feature's actions and on-demand reads (see factory/registry.ts); anything but a GET only from the office's own page.
        const r = await factory.registry.http(req.method ?? 'GET', p.slice('/api/factory'.length), url.searchParams, (limit) => readBody(req, limit), { trusted: ownRequest(), by: str(req.headers['x-droid-office-name'], 24) });
        if (r.download) return sendDownload(res, r.download);
        return send(res, r.status, r.body);
      }
      if (p === '/api/jira/ticket' && req.method === 'GET') {
        // What a Jira ticket's window shows beyond its card (see jira.ts). Only the floor's epic's tickets.
        if (!floor) return send(res, 404, { error: 'No such floor' });
        try {
          return send(res, 200, await floor.jira.detail(url.searchParams.get('key') ?? ''));
        } catch (err) {
          const status = (err as { status?: number }).status;
          return send(res, status === 400 || status === 403 || status === 404 ? status : 502, { error: (err as Error).message });
        }
      }
      if (p.startsWith('/api/docs')) {
        // The bookshelf: the project's docs and text files, one to read or save, search across them, and pictures (see docs.ts).
        if (!floor) return send(res, 404, { error: 'No such floor' });
        if (p === '/api/docs/file' && req.method === 'PUT') {
          if (!ownRequest()) return send(res, 403, { error: 'Forbidden' });
          let body: { path?: unknown; text?: unknown; baseMtime?: unknown };
          try {
            body = JSON.parse(await readBody(req, 3 * 1024 * 1024));
          } catch (err) {
            return (err as Error).message === 'too large' ? send(res, 413, { error: 'That file is over 2 MB' }) : send(res, 400, { error: 'Bad JSON' });
          }
          const file = typeof body?.path === 'string' ? str(body.path, 4096) : '';
          const text = typeof body?.text === 'string' ? body.text : undefined;
          const baseMtime = typeof body?.baseMtime === 'number' && Number.isFinite(body.baseMtime) ? body.baseMtime : undefined;
          if (!file || text === undefined) return send(res, 400, { error: 'Bad request' });
          const r = await floor.docs.write(file, text, baseMtime);
          return 'error' in r ? send(res, r.status, { error: r.error, ...(r.mtime !== undefined ? { mtime: r.mtime } : {}) }) : send(res, 200, r);
        }
        if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
        if (p === '/api/docs') return send(res, 200, await floor.docs.list(url.searchParams.get('all') === '1'));
        if (p === '/api/docs/search') {
          const q = str(url.searchParams.get('q'), 256) ?? '';
          return send(res, 200, await floor.docs.search(q, url.searchParams.get('all') !== '0'));
        }
        const file = str(url.searchParams.get('path'), 4096);
        if (!file) return send(res, 400, { error: 'Bad request' });
        if (p === '/api/docs/file') {
          const r = await floor.docs.read(file);
          return 'error' in r ? send(res, r.status, { error: r.error }) : send(res, 200, r);
        }
        if (p === '/api/docs/picture') {
          const r = await floor.docs.picture(file);
          if ('error' in r) return send(res, r.status, { error: r.error });
          res.writeHead(200, {
            'content-type': r.type,
            'content-length': String(r.body.length),
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
            'cross-origin-resource-policy': 'same-origin',
          });
          res.end(r.body);
          return;
        }
        return send(res, 404, { error: 'Not found' });
      }
      if (p.startsWith('/api/whiteboard/')) return whiteboardRequest(req, res, p, url, floor, ownRequest());
      if (p === '/api/search' && req.method === 'GET') return send(res, 200, search(url.searchParams.get('q') ?? '', floor));
      if (p.startsWith('/api/gh/') && req.method === 'GET') {
        // What the issue and PR windows show beyond the board cards (see github.ts and gitlab.ts).
        const n = Number(url.searchParams.get('number'));
        // The repo's labels (for the label picker) are the one thing not about a single issue or PR.
        if (p !== '/api/gh/labels' && (!Number.isSafeInteger(n) || n <= 0)) return send(res, 400, { error: 'Bad number' });
        if (!floor) return send(res, 404, { error: 'No such floor' });
        const board = floor.board;
        try {
          if (p === '/api/gh/labels') return send(res, 200, await board.repoLabels());
          if (p === '/api/gh/pull') return send(res, 200, await board.pullDetail(n));
          if (p === '/api/gh/issue') return send(res, 200, await board.issueDetail(n));
          if (p === '/api/gh/pull/diff') {
            const diff = await board.pullDiff(n);
            res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
            res.end(diff);
            return;
          }
        } catch (err) {
          return send(res, 502, { error: (err as Error).message });
        }
        return send(res, 404, { error: 'Not found' });
      }
      if (p === '/' || p === '/index.html') return serveIndex(res, url.searchParams.get('t'));
      const file = publicFile(p);
      if (file) return serveFile(res, file, false);
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    } catch (err) {
      console.error(err);
      if (!res.headersSent) send(res, 500, { error: 'Internal error' });
    }
  };

  const server = cfg.tls ? https.createServer({ cert: cfg.tls.cert, key: cfg.tls.key }, handler) : http.createServer(handler);

  // --- WebSocket -------------------------------------------------------------------------------
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://x');
    } catch {
      socket.destroy();
      return;
    }
    // The socket is the office page's own: this start's token (or loopback) plus a matching Origin
    // (see sameOrigin), or a paired phone. A phone's device token in the Authorization header skips
    // the Origin check: a browser can't set that header on a WebSocket, so no web page can send it.
    // `?d=` can come from a page, so it doesn't. One check per connection; nothing per message.
    if (url.pathname !== '/ws') return refuseUpgrade(socket);
    const gate = access(req, url);
    if (!gate.ok || (!(gate.device && gate.header) && !sameOrigin(req, cfg))) return refuseUpgrade(socket);
    if (!companion.on && (gate.device?.kind === 'browser' || url.searchParams.get('client') === 'dashboard')) return refuseUpgrade(socket);
    if (gate.device) devices.seen(gate.device.id);
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, url, gate.device));
  });

  const onConnection = (ws: WebSocket, url: URL, device?: PairedDevice) => {
    const id = randomBytes(5).toString('hex');
    // Back on the floor they were on before a reload, a restart or closing the tab, else the first floor.
    const wanted = url.searchParams.get('floor');
    // A floor that's gone since (taken off the building, or its checkout deleted) sends them up to the roof.
    const landing = returnLanding(wanted, [...floors.keys()], ROOF);
    const onRoof = landing.onRoof;
    const floor = landing.floorId ? floors.get(landing.floorId) : undefined;
    // Back where they were standing on it too; anywhere else, they arrive by elevator.
    const saved = landing.back ? spotFrom(url.searchParams) : undefined;
    const spot = saved ?? { ...elevatorSpot(), y: 0, rotY: 0 };
    const arrival: Arrival = {
      floor: onRoof ? ROOF : (floor?.id ?? null),
      ...(onRoof || floor ? { at: { x: spot.x, y: spot.y, z: spot.z, rotY: spot.rotY } } : {}),
      via: !onRoof && !floor ? 'lobby' : saved ? 'saved' : landing.gone ? 'roof' : 'elevator',
      ...(landing.gone ? { removed: true } : {}),
    };
    // The connection names itself (?name=, or the `profile` message): display provenance only.
    const name = str(url.searchParams.get('name'), 24).trim() || `Guest ${id.slice(0, 3)}`;
    const colorParam = url.searchParams.get('color') ?? '';
    const client: Client = {
      id,
      ws,
      floor: onRoof ? ROOF : (floor?.id ?? null),
      attached: new Set(),
      stale: new Set(),
      lastGongAt: 0,
      isAlive: true,
      peer: { name, color: COLOR_RE.test(colorParam) ? colorParam : '#4f86f7' },
      ...(device ? { device: device.id, ...(device.kind !== 'browser' ? { phoneSizes: new PhoneSizes() } : {}) } : {}),
      dashboard: url.searchParams.get('client') === 'dashboard' || device?.kind === 'browser',
      requests: new Set(),
      boards: new Map(),
    };
    clients.set(id, client);
    ws.on('pong', () => (client.isAlive = true));

    sendTo(client, {
      t: 'welcome',
      connection: id,
      arrival,
      floors: floorInfos(),
      projectsDir: building.projectsDirState(),
      version: upgrader.version,
      upgrade: upgrader.state,
      notify: webhook.state(),
      machine: machine.state(),
      sky: sky.state,
      jukebox: jukebox.state(),
      leaveOnMerge: leaveOnMerge.state(),
      freshMain: freshMain.state(),
      subagents: subagents.state(),
      hiddenModels: hiddenModels.state(),
      whiteboardSkill: whiteboardSkill.state(),
      prompts: prompts.state(),
      factory: factory.state(),
      setup: setup.state(),
      subscriptions: subscriptions.state(),
      ...(onRoof ? roofView() : floorView(floor)),
    });
    screensOf(client, floor);
    if (floor) sendBoard(client, floor);
    if (floor) sendTo(client, { t: 'visits', visits: floor.visits.list() });
    floorsChanged();
    if (floor) {
      floor.arrived();
      // Anyone whose process ended since (exited, or failed to resume) gets up as you walk in.
      floor.workers.wakeAll();
    }

    ws.on('message', (raw) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      let msg: ClientMsg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      handleMessage(client, msg);
    });
    ws.on('close', () => {
      clients.delete(id);
      for (const r of client.phoneSizes?.restores((wid) => workerFloor(wid)?.workers.get(wid)) ?? []) workerFloor(r.workerId)?.workers.resize(r.workerId, r.size.cols, r.size.rows);
      for (const wait of automationWaits.values()) if (wait.client === id) wait.done({ ok: false, error: 'The office tab closed before it answered' });
      for (const f of floors.values()) {
        f.workers.detachAll(id);
        f.shell.detach(id);
        f.guests.detachAll(id);
        f.cloud.detachAll(id);
        f.changes.unwatchAll(id);
      }
      factory.drop(id);
      floorsChanged();
    });
    ws.on('error', () => ws.terminate());
  };

  /**
   * A floor's whole Whiteboard for `c`, with the epoch this connection numbers its batches for that
   * floor in (the same one each time, so a resync's resends are still recognised), every card's
   * capability, and whether cards can be rendered.
   */
  const sendBoard = (c: Client, floor: Floor) => {
    const store = floor.whiteboard;
    let epoch = c.boards.get(floor.id);
    if (!epoch) {
      epoch = store.issueEpoch();
      c.boards.set(floor.id, epoch);
    }
    sendTo(c, { t: 'whiteboard', floor: floor.id, update: { kind: 'snapshot', board: store.board, epoch }, caps: store.allCaps(), renderer: store.renderer.status() });
    for (const card of store.board.cards) {
      const info = renderInfo(store.renderer, card, card.id);
      if (info) sendTo(c, { t: 'whiteboard.rendered', floor: floor.id, card: card.id, info });
    }
  };
  /** The owner's batch from the window, answered to `c` once it's committed (or why it wasn't). */
  const applyBoard = (c: Client, floorId: string, raw: unknown) => {
    const floor = floors.get(floorId);
    if (!floor) return warn(c, 'That floor is no longer in the building');
    const env = parseEnvelope(raw);
    if (typeof env === 'string') return warn(c, `The Whiteboard change was malformed: ${env}`);
    let out: ReturnType<typeof floor.whiteboard.apply>;
    try {
      out = floor.whiteboard.apply(env, OWNER_AUTHOR, 'window');
    } catch (err) {
      // Not committed: the window keeps it pending and sends it again after its next resync.
      console.error(`droid-office: the ${floor.def.name} Whiteboard couldn't be saved: ${(err as Error).message}`);
      return warn(c, `The Whiteboard couldn't be saved: ${(err as Error).message}`);
    }
    const head = { epoch: env.epoch, seq: env.seq };
    if (out.kind === 'ack') sendTo(c, { t: 'whiteboard', floor: floor.id, update: { kind: 'ack', ...head, rev: out.rev } });
    else if (out.reason === 'expired') sendTo(c, { t: 'whiteboard', floor: floor.id, update: { kind: 'rejected', ...head, reason: 'expired' } });
    else sendTo(c, { t: 'whiteboard', floor: floor.id, update: { kind: 'rejected', ...head, reason: 'invalid', error: out.error } });
  };
  /** Ping a worker: the Whiteboard line typed into its terminal, as its status allows (see whiteboard-ping.ts). */
  const pingWorker = (c: Client, id: string) => {
    const pinged = (ok: boolean, rest: { how?: 'type' | 'resume' | 'queue'; error?: string }) => sendTo(c, { t: 'whiteboard.pinged', worker: id, ok, ...rest });
    let floor: Floor | undefined;
    let info: ReturnType<Floor['everyone']>[number] | undefined;
    for (const f of floors.values()) {
      info = f.everyone().find((w) => w.id === id);
      if (info) {
        floor = f;
        break;
      }
    }
    if (!floor || !info) return pinged(false, { error: 'That worker is no longer in the office' });
    const can = pingEligibility(info);
    if (!can.ok) return pinged(false, { error: can.reason });
    const text = officePrompt(prompts, 'whiteboard.ping', { floor: floor.def.name });
    const err = can.how === 'resume' ? floor.workers.resume(id, text) : floor.workers.prompt(id, text, [], can.how === 'queue');
    if (err) return pinged(false, { error: `${info.name}: ${err}` });
    pinged(true, { how: can.how });
  };

  const decorChanged = (floor: Floor) => toFloor(floor, { t: 'decor', items: floor.decor.list() });
  const jukeboxChanged = () => broadcast({ t: 'jukebox', state: jukebox.state() });

  /**
   * Takes `c` to another floor: they get the new floor's everything. They arrive in the
   * elevator, or `at` the spot they came by.
   */
  const goToFloor = (c: Client, floor: Floor, at?: { x: number; y: number; z: number; rotY: number }) => {
    if (c.floor === floor.id) return;
    const left = leave(c, at);
    c.floor = floor.id;
    const spot = left.spot;
    sendTo(c, { t: 'floor.enter', arrival: { floor: floor.id, at: { x: spot.x, y: spot.y, z: spot.z, rotY: spot.rotY }, via: at ? 'requested' : 'elevator' }, ...floorView(floor) });
    screensOf(c, floor);
    sendBoard(c, floor);
    sendTo(c, { t: 'visits', visits: floor.visits.list() });
    floor.arrived();
    floor.workers.wakeAll();
    floorsChanged();
  };

  /** Up to the roof, by elevator. */
  const goToRoof = (c: Client) => {
    if (c.floor === ROOF) return;
    const left = leave(c);
    c.floor = ROOF;
    const spot = left.spot;
    sendTo(c, { t: 'floor.enter', arrival: { floor: ROOF, at: { x: spot.x, y: spot.y, z: spot.z, rotY: spot.rotY }, via: 'elevator' }, ...roofView() });
    floorsChanged();
  };

  /** Out to the lobby, where the elevator has nowhere to go: the building's last floor was taken off. */
  const toLobby = (c: Client) => {
    leave(c);
    c.floor = null;
    sendTo(c, { t: 'floor.enter', arrival: { floor: null, via: 'lobby' }, ...floorView(undefined) });
  };

  /**
   * Takes `floor` off the building (already out of floors.json): everyone on it rides the elevator to
   * the next floor, or out to the lobby if it was the last (the roof goes with it), and its workers stop.
   */
  const closeFloor = (floor: Floor, who: string) => {
    const name = floor.def.name;
    const next = [...floors.values()].find((f) => f !== floor);
    // The list without it first, so nobody arrives somewhere (the lobby's panel) that still shows it.
    const list = floorInfos().filter((f) => f.id !== floor.id);
    floorsSent = JSON.stringify(list);
    broadcast({ t: 'floors', floors: list });
    for (const c of clients.values()) {
      if (c.floor === floor.id || (!next && c.floor === ROOF)) {
        if (next) goToFloor(c, next);
        else toLobby(c);
        sendTo(c, { t: 'toast', text: next ? `🛗 ${who} took ${name} off the building, so you rode the elevator to ${next.def.name}` : `🛗 ${who} took ${name}, the last floor, off the building`, level: 'warn' });
      } else sendTo(c, { t: 'toast', text: `🛗 ${who} took ${name} off the building`, level: 'info' });
    }
    floors.delete(floor.id);
    floor.shutdown();
    floorsChanged();
  };

  /** Off the floor (or the roof) `c` was on, to `at` on the next one, or into its elevator car. */
  const leave = (c: Client, at?: { x: number; y: number; z: number; rotY: number }) => {
    const was = floorOf(c);
    if (was) {
      was.workers.detachAll(c.id);
      was.shell.detach(c.id);
      was.guests.detachAll(c.id);
      was.cloud.detachAll(c.id);
      was.changes.unwatchAll(c.id);
    }
    c.attached.clear();
    c.stale.clear();
    const spot = at ?? { ...elevatorSpot(), y: 0, rotY: 0 };
    return { spot };
  };

  /**
   * A worker took on issue `n` (an issue card dropped on its desk): assign it on GitHub or GitLab, which
   * moves it to In progress on the board.
   */
  const takeIssue = (c: Client, floor: Floor, n: number) => {
    void floor.board.claim(n).then((err) => warn(c, err && `Couldn't assign issue #${n} on ${forgeWords(floor.board.forge).site}: ${err}`));
  };

  /** Every floor's Jira tab starts over with the office's new connection (or none). */
  const jiraConnectionChanged = () => {
    for (const f of floors.values()) void f.jira.connectionChanged();
  };

  /**
   * Runs `go` once a worktree made on `floor` would start from what's on the forge now (see
   * Worktrees.fetch): right away when that was just fetched, else after a fetch, if `c` and the floor
   * are still there. With `checkout`, for a worker in the floor's checkout instead.
   */
  const withFreshBase = (c: Client, floor: Floor | Floor[], go: () => void, checkout = false, onAbort?: () => void) => {
    const all = Array.isArray(floor) ? floor : [floor];
    const fetching = all.map((f) => f.workers.fetchBase(checkout)).filter((p): p is Promise<void> => p !== undefined);
    if (!fetching.length) return go();
    void Promise.all(fetching).then(
      () => {
        if (c.ws.readyState !== WebSocket.OPEN || all.some((f) => floors.get(f.id) !== f)) {
          onAbort?.();
          return;
        }
        go();
      },
      () => onAbort?.(),
    );
  };

  /** Opens a worker's terminal for `c`, or the banner a guest has instead of one. */
  const attachTerminal = (wid: string, c: Client) => workerFloor(wid)?.workers.attach(wid, c.id) ?? guestFloor(wid)?.guests.attach(wid, c.id);

  const handleMessage = (c: Client, msg: ClientMsg) => {
    const who = c.peer.name;
    const requestId = str(msg.requestId, 64);
    let finished = false;
    // An awaited action calls done() from a later callback. Do not complete the receipt at the end of this turn.
    let pending = false;
    const done = (error?: string, workerId?: string) => {
      if (!requestId || finished) return;
      finished = true;
      sendTo(c, { t: 'action.result', requestId, ok: !error, ...(error ? { error } : {}), ...(workerId ? { workerId } : {}) });
    };
    const refuse = (error: string | undefined) => {
      warn(c, error);
      if (error) done(error);
    };
    /** A refused action still closes a waiting receipt. */
    const stop = (error: string) => {
      warn(c, error);
      done(error);
    };
    const defer = () => {
      pending = true;
    };
    if (requestId) {
      if (c.requests.has(requestId)) return done('That action was already received. It was not sent again.');
      c.requests.add(requestId);
      // No request is replayed on this connection. Close rather than forget old deduplication keys.
      if (c.requests.size > 4096) {
        done('Too many actions on this connection. Reconnect to continue.');
        return c.ws.close(1012, 'Reconnect to continue');
      }
    }
    if (msg.requestFloor && msg.requestFloor !== c.floor) return done('The active floor changed. Nothing was sent.');
    /** The floor `c` is on, or a note to them that they have to be on one. */
    const here = (): Floor | undefined => {
      const f = floorOf(c);
      if (!f) refuse('Take the elevator to a floor first');
      return f;
    };
    /** A worker by id, with the floor it sits on. */
    const worker = (id: unknown) => {
      const wid = str(id, 32);
      const floor = workerFloor(wid);
      return floor ? { wid, floor, info: floor.workers.get(wid)! } : undefined;
    };
    // A guest runs outside the office: nothing the office does with its own workers is done to it.
    const asked = (msg as { workerId?: unknown }).workerId;
    if (requestId && typeof asked === 'string') {
      const floor = workerFloor(asked) ?? guestFloor(asked) ?? floors.get(cloud.find(asked)?.floor.id ?? '');
      if (floor && floor.id !== c.floor) return done('That worker is not on the active floor. Nothing was sent.');
    }
    const guest = GUEST_REFUSED.has(msg.t) && typeof asked === 'string' ? guestFloor(asked)?.guests.get(asked) : undefined;
    if (guest?.guest) return refuse(guestRefusal(guest, msg.t));
    // A cloud worker's session runs on a Factory computer: factory/cloud.ts answers for it.
    const cloudie = typeof asked === 'string' && /^(worker|term|changes|guest)\./.test(msg.t) ? cloud.find(asked) : undefined;
    if (cloudie) {
      const floor = floors.get(cloudie.floor.id);
      cloud.message(msg as Parameters<typeof cloud.message>[0], { who, client: c.id, warn: (text) => warn(c, text), done, takeIssue: (n) => floor && takeIssue(c, floor, n) });
      return;
    }
    switch (msg.t) {
      case 'profile': {
        // Display provenance only (see Client.peer).
        const name = str(msg.name, 24).trim();
        if (name) c.peer.name = name;
        if (COLOR_RE.test(msg.color)) c.peer.color = msg.color;
        break;
      }
      case 'floor.go': {
        if (msg.floor === ROOF) {
          if (floors.size) goToRoof(c);
          else warn(c, 'There is no building to go up on yet');
          break;
        }
        const floor = floors.get(str(msg.floor, 64));
        if (!floor) warn(c, 'No such floor');
        else goToFloor(c, floor, arrivalSpot(msg.at));
        break;
      }
      case 'floor.reorder': {
        if (typeof msg.floor !== 'string' || msg.floor.length > 64 || (msg.before !== null && (typeof msg.before !== 'string' || msg.before.length > 64))) return stop('Invalid floor order');
        const error = building.reorder(msg.floor, msg.before);
        if (error) return stop(error);
        // Reinsert the same live floors in saved order. Default arrivals and every other Map
        // reader must agree with the numbered list, without reopening a floor or its workers.
        for (const def of building.list()) {
          const floor = floors.get(def.id);
          if (!floor) continue;
          floors.delete(def.id);
          floors.set(def.id, floor);
        }
        floorsChanged();
        done();
        break;
      }
      case 'floor.repos':
        void building.repos(msg.refresh === true).then(
          (repos) => sendTo(c, { t: 'floor.repos', repos }),
          (err: Error) => sendTo(c, { t: 'floor.repos', repos: [], error: `Couldn't look for checkouts: ${err.message}` }),
        );
        break;
      case 'floor.folders': {
        const request = str(msg.request, 80);
        const dir = msg.dir === undefined ? undefined : str(msg.dir, 1024);
        void building.folders(dir).then(
          (listing) => sendTo(c, { t: 'floor.folders', request, ...listing }),
          (err: Error) => sendTo(c, { t: 'floor.folders', request, dir: dir ?? '', shown: dir ?? '', git: false, folders: [], error: `Couldn't list folders: ${err.message}` }),
        );
        break;
      }
      case 'floor.branches':
      case 'floor.branch': {
        const floor = floorOf(c);
        if (!floor || floor.id !== msg.floor) return stop('Choose a branch on the floor you are on');
        const reply = (error?: string) => sendTo(c, { t: 'floor.branches', floor: floor.id, request: str(msg.request, 80), ...floor.workers.branchState(), ...(error ? { error } : {}) });
        if (msg.t === 'floor.branches') reply();
        else {
          if (msg.branch !== null && (typeof msg.branch !== 'string' || msg.branch.length > 1024)) return reply('Invalid branch name');
          void floor.workers.selectBranch(msg.branch).then((error) => {
            if (!error) floorsChanged();
            reply(error);
          });
        }
        break;
      }
      case 'floor.add': {
        const dir = str(msg.dir, 1024);
        const r = building.add(dir, who);
        if (typeof r === 'string') return sendTo(c, { t: 'floor.added', dir, error: r });
        floorsChanged();
        const floor = openFloor(r);
        if (!floor) return sendTo(c, { t: 'floor.added', dir, error: `Added ${r.name}, but couldn't open its floor — see the office's log` });
        console.log(`  ${who} added a floor for ${r.repo ?? r.name} (${r.dir})`);
        toastAll(`🛗 New floor: ${r.name}, added by ${who}`);
        sendTo(c, { t: 'floor.added', dir, floor: floor.id });
        // Its Droid workers find out how to hire subagents from the skill: put it back if it went missing.
        if (subagents.syncSkill()) broadcast({ t: 'subagents', state: subagents.state() });
        if (whiteboardSkill.syncSkill()) broadcast({ t: 'whiteboardSkill', state: whiteboardSkill.state() });
        break;
      }
      case 'floor.remove': {
        const id = str(msg.floor, 64);
        const r = building.remove(id, who);
        if (typeof r === 'string') return stop(r);
        console.log(`  ${who} took the ${r.name} floor off the building (${r.dir} stays where it is)`);
        const floor = floors.get(id);
        if (floor) closeFloor(floor, who);
        else floorsChanged();
        break;
      }
      case 'floor.projectsDir': {
        const err = building.setProjectsDir(str(msg.dir, 1024), who);
        warn(c, err);
        if (err) break;
        const state = building.projectsDirState();
        broadcast({ t: 'projectsDir', state });
        toastAll(state.custom ? `📁 ${who} moved the workspace folder to ${state.dir}` : `📁 ${who} put the workspace folder back to ${state.dir}`);
        break;
      }
      case 'worker.spawn': {
        const images = imageIds(msg.images);
        const floor = here();
        if (!floor) break;
        const kind = msg.kind === 'shell' ? 'shell' : 'agent';
        const model = msg.model === undefined ? undefined : str(msg.model, MODEL_MAX + 1);
        const effort = isAgentEffort(msg.effort) ? msg.effort : undefined;
        // Other floors' projects to work in too, each in a worktree of its own.
        const repos: RepoSource[] = [];
        for (const id of Array.isArray(msg.repos) ? [...new Set(msg.repos.slice(0, MAX_REPOS + 1).map((x) => str(x, 64)))] : []) {
          const other = floors.get(id);
          if (!other || other === floor) {
            floor.workers.unstage(images);
            return refuse(other ? "The worker's own floor's project is already in its workspace" : 'That project is no longer in the building');
          }
          if (other.plain) {
            floor.workers.unstage(images);
            return refuse(`${other.def.name} is a plain folder, not a git checkout, so a worker can't have a worktree of it`);
          }
          repos.push({ floor: other.id, name: other.def.name, repo: other.def.repo, dir: other.dir });
        }
        const hire = () => {
          if (c.floor !== floor.id) {
            floor.workers.unstage(images);
            return done('The active floor changed before hiring. No worker was hired.');
          }
          // AUTO_DESK is picked here, after any fetch, so two quick hires never get the same desk.
          const wanted = str(msg.deskId, 32);
          const deskId = wanted === AUTO_DESK ? nextFreeSeat((id) => floor.workers.deskOccupied(id))?.id : wanted;
          if (!deskId) {
            floor.workers.unstage(images);
            return refuse('Every desk and bean bag on this floor is taken');
          }
          const r = floor.workers.spawn(deskId, who, str(msg.prompt, 20000) || undefined, msg.worktree === true, kind, model, effort, repos, undefined, images);
          floor.workers.unstage(images);
          const issue = kind === 'agent' ? issueNumber(msg.issue) : undefined;
          const across = repos.length ? ` across ${[floor.def.name, ...repos.map((x) => x.name)].join(' + ')}` : '';
          if (typeof r === 'string') refuse(r);
          else toastFloor(floor, kind === 'shell' ? `${who} opened a shell at a desk` : `${who} hired ${r.name}${issue ? ` for issue #${issue}` : r.prompt ? ' with a task' : ''}${kind === 'agent' ? across : ''}`);
          if (typeof r !== 'string') done(undefined, r.id);
          if (typeof r !== 'string' && issue) takeIssue(c, floor, issue);
        };
        // Every project it gets a worktree of starts from what's on the forge now, and so does an
        // agent in the checkout (see WorkerManager.fetchBase).
        const fresh = [floor, ...repos.map((x) => floors.get(x.floor)!)];
        const abortHire = () => {
          floor.workers.unstage(images);
          done('The office could not confirm the hire. Check the floor before trying again; it was not replayed.');
        };
        if (msg.worktree === true) {
          defer();
          withFreshBase(c, fresh, hire, false, abortHire);
        } else if (kind === 'agent') {
          defer();
          withFreshBase(c, floor, hire, true, abortHire);
        } else hire();
        break;
      }
      case 'worker.fork': {
        const w = worker(msg.workerId);
        if (!w) return done('No such worker');
        if (w.floor.id !== c.floor) return refuse('Take the elevator to that worker’s floor before forking');
        defer();
        void w.floor.workers.fork(w.wid, who, str(msg.prompt, 20000) || undefined).then(
          (result) => {
            if (typeof result === 'string') return refuse(result);
            toastFloor(w.floor, `${who} forked ${w.info.name} into ${result.name}`);
            done(undefined, result.id);
          },
          (error: unknown) => refuse(error instanceof Error ? error.message : 'The office could not confirm the fork. Check the floor before trying again.'),
        );
        break;
      }
      case 'worker.resume': {
        const w = worker(msg.workerId);
        const error = w ? w.floor.workers.resume(w.wid) : 'No such worker';
        warn(c, error);
        done(error, w?.wid);
        break;
      }
      case 'guest.bringIn': {
        const wid = str(msg.workerId, 64);
        const floor = guestFloor(wid);
        if (!floor) return stop(workerFloor(wid) ? "That's already one of the office's workers" : 'That guest has gone home');
        void floor.bringIn(wid, who).then((r) => {
          if (typeof r === 'string') warn(c, r);
          else toastFloor(floor, `🚪 ${who} brought ${r.name} into the office: its session carries on at its desk`);
        });
        break;
      }
      case 'worker.shoot': {
        const w = worker(msg.workerId);
        if (!w) break;
        warn(c, w.floor.workers.shoot(w.wid, msg.superShot === true));
        break;
      }
      case 'worker.kill': {
        const w = worker(msg.workerId);
        if (!w) return done('No such worker');
        const { floor, info } = w;
        // The worker leaves right away; its worktree is dealt with after that, and the outcome follows.
        const cleanup = floor.workers.kill(info.id, CLEANUPS.has(String(msg.cleanup)) ? msg.cleanup : undefined);
        toastFloor(floor, `${who} sent ${info.name} home`);
        defer();
        void cleanup.then(
          ({ note, error }) => {
            if (note) toastFloor(floor, note);
            if (error) toastFloor(floor, error, 'warn');
            done(error, info.id);
          },
          (error: unknown) => refuse(error instanceof Error ? error.message : 'The office could not confirm sending the worker home.'),
        );
        break;
      }
      case 'worker.worktree': {
        const w = worker(msg.workerId);
        if (!w) break;
        void w.floor.workers.inspectWorktree(w.wid).then((state) => {
          if (state) sendTo(c, { t: 'worker.worktree', workerId: w.wid, state });
        });
        break;
      }
      case 'worker.rebuild': {
        const w = worker(msg.workerId);
        if (!w) break;
        const { floor } = w;
        // With `all`, every worker on the floor whose worktree was deleted, this one first.
        const ids = [
          w.wid,
          ...(msg.all === true
            ? floor.workers
                .list()
                .filter((x) => x.lost && x.id !== w.wid)
                .map((x) => x.id)
            : []),
        ];
        void (async () => {
          const names: string[] = [];
          const notes: string[] = [];
          for (const id of ids) {
            const info = floor.workers.get(id);
            // Sent home meanwhile, or back already with one before it.
            if (!info || (id !== w.wid && !info.lost)) continue;
            const r = await floor.workers.rebuild(id);
            if (r.error) warn(c, r.error);
            else if (!r.rebuilt) sendTo(c, { t: 'toast', text: r.note ?? `${info.name}'s worktree is already there`, level: 'info' });
            else {
              names.push(info.name);
              if (r.note) notes.push(r.note);
            }
          }
          if (!names.length) return;
          const whose = names.length === 1 ? `${names[0]}'s worktree` : `the worktrees of ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
          toastFloor(floor, `🌿 ${who} rebuilt ${whose}${notes.length ? ` — ${notes.join('; ')}` : ''}`);
        })();
        break;
      }
      case 'worker.attach': {
        const wid = str(msg.workerId, 32);
        const snap = attachTerminal(wid, c);
        if (snap) {
          c.attached.add(wid);
          sendTo(c, { t: 'term.snapshot', workerId: wid, ...snap });
        }
        break;
      }
      case 'worker.detach': {
        const wid = str(msg.workerId, 32);
        c.attached.delete(wid);
        workerFloor(wid)?.workers.detach(wid, c.id);
        guestFloor(wid)?.guests.detach(wid, c.id);
        break;
      }
      case 'shell.attach': {
        const floor = here();
        const snap = floor?.shell.attach(c.id);
        if (!snap) break;
        c.attached.add(OFFICE_SHELL_ID);
        sendTo(c, { t: 'term.snapshot', workerId: OFFICE_SHELL_ID, data: snap.data, cols: snap.cols, rows: snap.rows, shared: snap.shared });
        break;
      }
      case 'shell.detach':
        c.attached.delete(OFFICE_SHELL_ID);
        floorOf(c)?.shell.detach(c.id);
        break;
      case 'shell.input':
        if (c.attached.has(OFFICE_SHELL_ID)) floorOf(c)?.shell.write(str(msg.data, 64 * 1024));
        break;
      case 'shell.resize':
        if (c.attached.has(OFFICE_SHELL_ID)) floorOf(c)?.shell.resize(num(msg.cols), num(msg.rows));
        break;
      case 'worker.prompt': {
        const w = worker(msg.workerId);
        const images = imageIds(msg.images);
        const err = w ? w.floor.workers.prompt(w.wid, str(msg.prompt, 20000), images, msg.queue === true) : 'No such worker';
        w?.floor.workers.unstage(images);
        warn(c, err);
        done(err, w?.wid);
        const issue = w?.info.kind === 'agent' ? issueNumber(msg.issue) : undefined;
        if (w && !err && issue) {
          toastFloor(w.floor, `${who} handed issue #${issue} to ${w.info.name}`);
          takeIssue(c, w.floor, issue);
        }
        break;
      }
      case 'worker.answer': {
        const w = worker(msg.workerId);
        if (!w || c.floor !== w.floor.id) return done('That worker is no longer on this floor.');
        const hasChoice = typeof msg.choice === 'number';
        const hasText = typeof msg.text === 'string';
        if (hasChoice === hasText) return done(hasChoice ? 'Send either a menu choice or a typed answer, not both.' : 'Send a menu choice or a typed answer.');
        defer();
        const lines = () => w.floor.workers.screenLines(w.wid);
        void answers
          .answer(w.wid, msg.menu, hasChoice ? { choice: msg.choice } : { text: str(msg.text, 20000) }, {
            worker: () => w.floor.workers.get(w.wid),
            lines,
            write: (data) => w.floor.workers.write(w.wid, data),
            live: () => c.ws.readyState === WebSocket.OPEN && c.floor === w.floor.id,
          })
          .then(
            (error) => done(error, w.wid),
            () => done('The answer could not be verified. Check the terminal.'),
          );
        break;
      }
      case 'station.open': {
        const floor = here();
        if (!floor) break;
        const result = floor.workers.openStation(str(msg.deskId, 32), who);
        if (typeof result === 'string') warn(c, result);
        else sendTo(c, { t: 'worker.open', workerId: result.id });
        break;
      }
      case 'station.prompt': {
        const floor = here();
        if (!floor) break;
        const model = msg.model === undefined ? undefined : str(msg.model, MODEL_MAX + 1);
        const effort = isAgentEffort(msg.effort) ? msg.effort : undefined;
        const images = imageIds(msg.images);
        const r = floor.workers.station(str(msg.deskId, 32), who, str(msg.prompt, 20000), model, effort, images);
        floor.workers.unstage(images);
        if (typeof r === 'string') warn(c, r);
        else if (r.hired) toastFloor(floor, `${who} asked the ${r.info.name} something`);
        break;
      }
      case 'worker.pr': {
        const w = worker(msg.workerId);
        if (!w) return done('No such worker');
        const { floor, wid } = w;
        defer();
        void floor.workers.openPr(wid, who).then(
          (r) => {
            if (typeof r === 'string') return refuse(r);
            done(r.failed.length ? r.failed.join('; ') : undefined, wid);
            const info = floor.workers.get(wid);
            const name = info?.name ?? 'the worker';
            const words = forgeWords(floor.board.forge);
            const [one] = r.prs;
            if (r.prs.length === 1 && one && !one.repo) toastFloor(floor, one.existed ? `${name}'s branch already has ${words.pr} ${words.ref(one.number)}` : `${who} opened ${words.pr} ${words.ref(one.number)} for ${name}`);
            else {
              const list = r.prs.map((p) => `${p.repo} ${words.ref(p.number)}`).join(', ');
              toastFloor(floor, r.prs.every((p) => p.existed) ? `${name}'s ${words.pull}s are already open: ${list}` : `${who} opened ${name}'s ${words.pull}s: ${list}`);
            }
            const dirty = r.prs.filter((p) => p.dirty);
            if (dirty.length)
              warn(c, `${name} still has uncommitted changes in ${dirty.some((p) => p.repo) ? `its worktree${dirty.length > 1 ? 's' : ''} of ${dirty.map((p) => p.repo).join(', ')}` : 'its worktree'} — they are not in the ${words.pr}`);
            for (const line of r.failed) warn(c, line);
            // Put it on the board now rather than at the next poll. A refresh already in flight
            // returns at once and can miss it, so look again shortly after.
            const own = r.prs.find((p) => !p.repo || p.repo === info?.worktree?.path.split(/[\\/]/).pop());
            void floor.board.refresh().then(() => {
              if (own && !floor.board.pulls.items.some((p) => p.number === own.number)) setTimeout(() => void floor.board.refresh(), 3000);
            });
            for (const x of info?.repos ?? []) void floors.get(x.floor)?.board.refresh();
          },
          (error: unknown) => refuse(error instanceof Error ? error.message : 'The office could not confirm the pull request.'),
        );
        break;
      }
      case 'thread.read': {
        const workerId = str(msg.workerId, 32);
        const request = str(msg.request, 128);
        const before = typeof msg.before === 'number' ? msg.before : undefined;
        const floor = floorOf(c);
        const source = floor?.workers.threadSession(workerId);
        const reply = { t: 'thread.snapshot' as const, workerId, request, ...(before !== undefined ? { before } : {}) };
        if (!source || !floor) {
          sendTo(c, { ...reply, entries: [], hasMore: false, error: 'Thread is available only for local office-owned Droid workers with an active session on this floor. Shells, guests and cloud workers have no local thread.' });
          break;
        }
        if (msg.before !== undefined && (before === undefined || !Number.isSafeInteger(before) || before < 0)) {
          sendTo(c, { ...reply, entries: [], hasMore: false, error: 'Invalid conversation page.' });
          break;
        }
        void workerThreads.read(source, before).then((page) => {
          const current = floor.workers.threadSession(workerId);
          if (floorOf(c) !== floor || current?.sessionId !== source.sessionId || current.cwd !== source.cwd) {
            sendTo(c, { ...reply, entries: [], hasMore: false, error: 'The active floor or worker session changed. Read the thread again.' });
            return;
          }
          sendTo(c, { ...reply, ...page });
        });
        break;
      }
      case 'term.input':
        if (c.attached.has(msg.workerId)) workerFloor(msg.workerId)?.workers.write(msg.workerId, str(msg.data, 64 * 1024));
        break;
      case 'term.resize': {
        const w = c.attached.has(msg.workerId) ? worker(msg.workerId) : undefined;
        if (!w) break;
        const before = { cols: w.info.cols, rows: w.info.rows };
        w.floor.workers.resize(w.wid, num(msg.cols), num(msg.rows));
        const after = w.floor.workers.get(w.wid);
        if (after) c.phoneSizes?.resized(w.wid, before, after);
        break;
      }
      case 'gh.refresh':
        void floorOf(c)?.board.refresh();
        break;
      case 'gh.merge': {
        const floor = here();
        const n = num(msg.number);
        const method = (['squash', 'merge', 'rebase'] as const).find((m) => m === msg.method);
        if (!floor || !Number.isSafeInteger(n) || n <= 0 || !method) break;
        void floor.board.merge(n, method, msg.deleteBranch === true, msg.auto === true).then((error) => {
          sendTo(c, { t: 'gh.merged', number: n, error });
          if (error) return;
          const w = forgeWords(floor.board.forge);
          toastFloor(floor, msg.auto ? `${who} set ${w.pr} ${w.ref(n)} to merge once its checks pass` : `🎉 ${who} merged ${w.pr} ${w.ref(n)}`);
          // An auto-merge rings once the host gets round to it and the boards see it merged.
          if (!msg.auto) floor.merged(n, who);
        });
        break;
      }
      case 'gh.comment': {
        const floor = here();
        const n = num(msg.number);
        const kind = msg.kind === 'pull' ? 'pull' : 'issue';
        if (!floor || !Number.isSafeInteger(n) || n <= 0) break;
        const body = typeof msg.body === 'string' ? msg.body : '';
        // Refused rather than cut short: a comment that silently lost its end would read as finished.
        const invalid = !body.trim() ? 'The comment is empty' : body.length > GH_COMMENT_MAX ? `${forgeWords(floor.board.forge).site} takes comments of up to ${GH_COMMENT_MAX} characters` : '';
        if (invalid) {
          sendTo(c, { t: 'gh.commented', kind, number: n, error: invalid });
          break;
        }
        void floor.board.comment(kind, n, body).then((r) => {
          sendTo(c, { t: 'gh.commented', kind, number: n, ...r });
          const w = forgeWords(floor.board.forge);
          if (r.comment) toastFloor(floor, `💬 ${who} commented on ${kind === 'pull' ? `${w.pr} ${w.ref(n)}` : `issue #${n}`}`);
        });
        break;
      }
      case 'gong': {
        const floor = floorOf(c);
        const now = Date.now();
        if (!floor || now - c.lastGongAt < 500) break;
        c.lastGongAt = now;
        toFloor(floor, { t: 'gong', why: 'hit', by: who });
        break;
      }
      case 'gh.close': {
        const floor = here();
        const n = num(msg.number);
        const kind = msg.kind === 'issue' || msg.kind === 'pull' ? msg.kind : undefined;
        if (!floor || !Number.isSafeInteger(n) || n <= 0 || !kind) break;
        const reason = msg.reason === 'not planned' ? 'not planned' : 'completed';
        void floor.board.close(kind, n, { comment: str(msg.comment, 20000).trim() || undefined, reason, deleteBranch: msg.deleteBranch === true }).then((error) => {
          sendTo(c, { t: 'gh.closed', kind, number: n, error });
          if (error) return;
          const w = forgeWords(floor.board.forge);
          if (kind === 'pull') return toastFloor(floor, `${who} closed ${w.pr} ${w.ref(n)} without merging`);
          toastFloor(floor, `${who} closed issue #${n}${reason === 'not planned' ? ' as not planned' : ''}`);
        });
        break;
      }
      case 'gh.labels': {
        const floor = here();
        const n = num(msg.number);
        const kind = msg.kind === 'issue' || msg.kind === 'pull' ? msg.kind : undefined;
        if (!floor || !Number.isSafeInteger(n) || n <= 0 || !kind) break;
        const names = (v: unknown) => [...new Set((Array.isArray(v) ? v : []).map((l) => str(l, GH_LABEL_MAX + 1)).filter((l) => l && l.length <= GH_LABEL_MAX))].slice(0, 100);
        const add = names(msg.add);
        const remove = names(msg.remove).filter((l) => !add.includes(l));
        if (!add.length && !remove.length) {
          sendTo(c, { t: 'gh.labeled', kind, number: n, error: 'No labels to change' });
          break;
        }
        void floor.board.setLabels(kind, n, add, remove).then((r) => {
          sendTo(c, { t: 'gh.labeled', kind, number: n, ...r });
          const w = forgeWords(floor.board.forge);
          if (r.labels) toastFloor(floor, `${who} labeled ${kind === 'pull' ? `${w.pr} ${w.ref(n)}` : `issue #${n}`}: ${[...add.map((l) => `+${l}`), ...remove.map((l) => `−${l}`)].join(' ')}`);
        });
        break;
      }
      case 'pipelines.refresh':
        void here()?.pipelines.refresh();
        break;
      case 'pipelines.detail': {
        const floor = here();
        const id = num(msg.id);
        if (!floor || !Number.isSafeInteger(id) || id <= 0) break;
        void floor.pipelines.detail(id).then(
          (detail) => sendTo(c, { t: 'pipelines.detail', id, detail }),
          (err: Error) => sendTo(c, { t: 'pipelines.detail', id, error: err.message }),
        );
        break;
      }
      case 'pipelines.rerun':
      case 'pipelines.cancel': {
        const floor = here();
        const id = num(msg.id);
        if (!floor || !Number.isSafeInteger(id) || id <= 0) break;
        const run = floor.pipelines.state.runs.find((r) => r.id === id);
        const action = msg.t === 'pipelines.rerun' ? 'rerun' : 'cancel';
        const failed = msg.t === 'pipelines.rerun' && 'failed' in msg && msg.failed === true;
        void (action === 'rerun' ? floor.pipelines.rerun(id, failed) : floor.pipelines.cancel(id)).then((error) => {
          sendTo(c, { t: 'pipelines.done', action, id, error });
          if (error || !run) return;
          const what = `${run.workflow} #${run.number}`;
          toastFloor(floor, action === 'cancel' ? `⏹️ ${who} cancelled ${what} on ${run.branch}` : `🔁 ${who} re-ran ${failed ? `the failed jobs of ${what}` : what} on ${run.branch}`);
        });
        break;
      }
      case 'pipelines.run': {
        const floor = here();
        if (!floor) break;
        const workflow = str(msg.workflow, 200);
        const ref = str(msg.ref, 255);
        const inputs: Record<string, string> = {};
        if (msg.inputs && typeof msg.inputs === 'object' && !Array.isArray(msg.inputs)) {
          for (const [k, v] of Object.entries(msg.inputs).slice(0, 50)) if (typeof v === 'string' && /^[\w.-]{1,100}$/.test(k)) inputs[k] = v.slice(0, 2000);
        }
        void floor.pipelines.run(workflow, ref, inputs).then((error) => {
          sendTo(c, { t: 'pipelines.done', action: 'run', error });
          if (error) return;
          const name = floor.pipelines.state.workflows.find((w) => w.id === workflow)?.name ?? workflow;
          toastFloor(floor, `🚀 ${who} started ${name} on ${ref.trim() || floor.pipelines.state.defaultBranch}`);
        });
        break;
      }
      case 'notify.webhook': {
        const url = str(msg.url, 4096).trim();
        const err = webhook.set(url, who);
        warn(c, err);
        if (!err) toastAll(url ? `📣 ${who} set up channel notifications` : `${who} turned off channel notifications`);
        break;
      }
      case 'notify.test':
        void webhook.test(who).then((err) => sendTo(c, { t: 'toast', text: err ?? '📣 Sent a test message', level: err ? 'warn' : 'info' }));
        break;
      case 'leaveOnMerge.set': {
        const on = msg.on === true;
        if (on === leaveOnMerge.on) break;
        leaveOnMerge.set(on, who);
        toastAll(on ? `🏠 ${who} set workers to go home by themselves once their pull request merges` : `🪑 ${who} set workers whose pull request merged to stay until they're sent home`);
        // The ones already merged go now.
        if (on) for (const f of floors.values()) f.sendLandedHome();
        break;
      }
      case 'freshMain.set': {
        const on = msg.on === true;
        if (on === freshMain.on) break;
        freshMain.set(on, who);
        toastAll(on ? `🌿 ${who} set fresh workers to start from the latest main` : `🌿 ${who} set fresh workers to start from the branch the checkout is on`);
        break;
      }
      case 'autoHeal.set': {
        const floor = here();
        if (!floor) break;
        const on = msg.on === true;
        if (on === floor.autoHeal.on) break;
        floor.autoHeal.set(on, who);
        toastFloor(floor, on ? `🩹 ${who} turned auto-heal on for this floor: a run that fails wakes the Pipeline agent to fix it` : `🩹 ${who} turned auto-heal off for this floor`);
        break;
      }
      case 'models.hide': {
        const error = hiddenModels.set(msg.id, msg.hidden);
        if (error) return stop(error);
        broadcast({ t: 'models.hidden', ids: hiddenModels.state() });
        done();
        break;
      }
      case 'subagents.set': {
        const before = subagents.settings;
        const err = subagents.set(msg.settings, who);
        if (err) return stop(err);
        const after = subagents.settings;
        if (before.on !== after.on) toastAll(after.on ? `🧭 ${who} let workers hire subagents` : `🧭 ${who} turned subagents off: nobody hires new ones`);
        else toastAll(`🧭 ${who} changed the Subagents settings`);
        break;
      }
      case 'whiteboardSkill.set': {
        if (typeof msg.on !== 'boolean') return;
        whiteboardSkill.set(msg.on, who);
        const state = whiteboardSkill.state();
        if (state.skillError) warn(c, state.skillError);
        else toastAll(msg.on ? `🧑‍🎨 ${who} turned the Whiteboard skill on` : `🧑‍🎨 ${who} turned the Whiteboard skill off`);
        break;
      }
      case 'whiteboard.apply':
        applyBoard(c, str(msg.floor, 64), msg.envelope);
        break;
      case 'whiteboard.sync': {
        const floor = floors.get(str(msg.floor, 64));
        if (floor) sendBoard(c, floor);
        else warn(c, 'That floor is no longer in the building');
        break;
      }
      case 'whiteboard.ping':
        pingWorker(c, str(msg.worker, 32));
        break;
      case 'prompts.set': {
        if (!isPromptId(msg.id) || (msg.text !== null && typeof msg.text !== 'string')) return;
        const was = !!prompts.state().custom[msg.id];
        const err = prompts.setPrompt(msg.id, msg.text === null ? null : str(msg.text, PROMPT_MAX + 1), who);
        if (err) return stop(err);
        const now = !!prompts.state().custom[msg.id];
        const { label } = PROMPTS[msg.id];
        if (now) toastAll(`📝 ${who} rewrote the “${label}” prompt`);
        else if (was) toastAll(`📝 ${who} put the default “${label}” prompt back`);
        break;
      }
      case 'prompts.agent': {
        const ch = msg.choice;
        if (ch !== null && (!ch || typeof ch !== 'object')) return;
        const choice = ch && {
          model: ch.model === undefined || ch.model === '' ? undefined : str(ch.model, MODEL_MAX + 1),
          effort: ch.effort === undefined ? undefined : ch.effort,
        };
        const err = prompts.setAgent(choice, who);
        if (err) return stop(err);
        toastAll(choice ? `🤖 ${who} set the office’s default worker` : `🤖 ${who} put the office’s default worker back to Droid’s own default`);
        break;
      }
      case 'worktreeSetup.get': {
        const floor = here();
        if (floor) sendTo(c, { t: 'worktreeSetup', state: floor.worktreeSetup() });
        break;
      }
      case 'worktreeSetup.set': {
        const floor = here();
        if (!floor) break;
        if (!floor.project.branch) return stop("This floor's project isn't a git checkout, so its workers have no worktrees to set up");
        const s = msg.setup;
        if (s !== null && (!s || typeof s !== 'object' || typeof s.setup !== 'string' || !Array.isArray(s.copy))) return;
        const setup = s && {
          setup: str(s.setup, SETUP_MAX).trim(),
          copy: s.copy
            .slice(0, 50)
            .map((p) => str(p, 300).trim())
            .filter(Boolean),
        };
        try {
          toFloor(floor, { t: 'worktreeSetup', state: floor.setWorktreeSetup(setup, who) });
        } catch (err) {
          return stop(`Could not save the worktree setup: ${(err as Error).message}`);
        }
        toastFloor(floor, setup ? `🌿 ${who} set how this floor's new worktrees are set up` : `🌿 ${who} put this floor's worktree setup back to the repository's`);
        break;
      }
      case 'machine.limit': {
        const limit = msg.limit === null ? undefined : parseWorkerLimit(msg.limit);
        if (msg.limit !== null && limit === undefined) return stop(`The worker limit is a whole number from 1 to ${MAX_WORKER_LIMIT}`);
        const err = machine.setLimit(limit, who);
        if (err) return stop(err);
        const now = machine.limit;
        toastAll(limit !== undefined ? `⚙️ ${who} set the worker limit to ${now}` : now === undefined ? `⚙️ ${who} took the worker limit off` : `⚙️ ${who} put the worker limit back to ${now} (--max-workers)`);
        break;
      }
      case 'jira.connect': {
        void jira.connect(str(msg.site, 300), str(msg.email, 254), str(msg.token, 2000), who).then((error) => {
          sendTo(c, { t: 'jira.setup', step: 'connect', ok: !error, error });
          if (error) return;
          console.log(`  ${who} connected the office to Jira at ${jira.connection()?.site}`);
          toastAll(`🎫 ${who} connected the office to Jira`);
          jiraConnectionChanged();
        });
        break;
      }
      case 'jira.disconnect': {
        if (!jira.connection()) break;
        jira.disconnect();
        console.log(`  ${who} disconnected the office from Jira`);
        toastAll(`${who} disconnected the office from Jira`);
        jiraConnectionChanged();
        break;
      }
      case 'jira.epic': {
        const floor = here();
        if (!floor) break;
        if (!str(msg.key, 40).trim()) {
          floor.jira.clearEpic();
          toastFloor(floor, `${who} took the Jira epic off this floor`);
          sendTo(c, { t: 'jira.setup', step: 'epic', ok: true });
          break;
        }
        void floor.jira.setEpic(str(msg.key, 40), who).then((r) => {
          if ('error' in r) return sendTo(c, { t: 'jira.setup', step: 'epic', error: r.error });
          sendTo(c, { t: 'jira.setup', step: 'epic', ok: true });
          toastFloor(floor, `🎫 ${who} put Jira epic ${r.epic.key} on this floor's issue board`);
        });
        break;
      }
      case 'jira.refresh':
        void floorOf(c)?.jira.refresh(true);
        break;
      case 'factory.connect':
      case 'factory.disconnect':
      case 'factory.refresh':
      case 'factory.watch':
        factory.message(c.id, who, msg, (reply) => sendTo(c, reply));
        break;
      case 'setup.check':
        setup.message(who, msg);
        subscriptions.message(who, { t: 'subscriptions.refresh' });
        break;
      case 'setup.droid.install':
      case 'setup.droid.signIn':
      case 'setup.droid.signInCancel':
      case 'setup.onboarded':
        setup.message(who, msg);
        break;
      case 'subscriptions.proxy':
      case 'subscriptions.connect':
      case 'subscriptions.connectCancel':
      case 'subscriptions.disconnect':
      case 'subscriptions.provider':
      case 'subscriptions.models':
      case 'subscriptions.refresh':
        subscriptions.message(who, msg);
        break;
      case 'changes.watch': {
        const w = worker(msg.workerId);
        if (w) w.floor.changes.watch(w.wid, c.id, repoOf(msg.repo));
        break;
      }
      case 'changes.unwatch': {
        const wid = str(msg.workerId, 32);
        // Its worker may have gone home already; stop watching wherever it was.
        for (const f of floors.values()) f.changes.unwatch(wid, c.id, repoOf(msg.repo));
        break;
      }
      case 'changes.diff': {
        const workerId = str(msg.workerId, 32);
        const file = str(msg.path, 4096);
        const repo = repoOf(msg.repo);
        const floor = workerFloor(workerId);
        if (!floor) {
          sendTo(c, { t: 'changes.diff', workerId, repo, path: file, diff: '', truncated: false, error: 'No such worker' });
          break;
        }
        void floor.changes.diff(workerId, file, repo).then((r) => {
          if (typeof r === 'string') sendTo(c, { t: 'changes.diff', workerId, repo, path: file, diff: '', truncated: false, error: r });
          else sendTo(c, { t: 'changes.diff', workerId, repo, path: file, ...r });
        });
        break;
      }
      case 'changes.commit': {
        const w = worker(msg.workerId);
        if (w) void w.floor.changes.commit(w.wid, str(msg.message, 5000), who, repoOf(msg.repo)).then((err) => warn(c, err));
        break;
      }
      case 'changes.discard': {
        const w = worker(msg.workerId);
        if (w) void w.floor.changes.discard(w.wid, typeof msg.path === 'string' ? str(msg.path, 4096) : undefined, who, repoOf(msg.repo)).then((err) => warn(c, err));
        break;
      }
      case 'changes.pr': {
        const w = worker(msg.workerId);
        if (w) void w.floor.changes.pullRequest(w.wid, str(msg.title, 300), str(msg.body, 20000), who, repoOf(msg.repo)).then((err) => warn(c, err));
        break;
      }
      case 'upgrade.check':
        void upgrader.check();
        break;
      case 'upgrade.start':
        void upgrader.start(who).then((err) => {
          if (err) warn(c, err);
          else toastAll(`${who} is upgrading the office — it restarts when the new version is built`);
        });
        break;
      case 'decor.add': {
        const floor = here();
        if (!floor) break;
        const d = floor.decor.add(msg.decor, who);
        if (typeof d === 'string') return stop(d);
        decorChanged(floor);
        toastFloor(floor, `🖼️ ${who} hung ${d.title ? `“${d.title}”` : 'a picture'}`);
        break;
      }
      case 'decor.update': {
        const floor = here();
        if (!floor) break;
        const d = floor.decor.update(str(msg.id, 32), msg.decor);
        if (typeof d === 'string') return stop(d);
        decorChanged(floor);
        break;
      }
      case 'decor.remove': {
        const floor = here();
        if (!floor) break;
        const d = floor.decor.remove(str(msg.id, 32));
        if (!d) break;
        decorChanged(floor);
        toastFloor(floor, `${who} took down ${d.title ? `“${d.title}”` : 'a picture'}`);
        break;
      }
      case 'jukebox.play': {
        const r = jukebox.play({ track: msg.track, url: msg.url }, who);
        if ('error' in r) return stop(r.error);
        if (!r.changed) break;
        jukeboxChanged();
        toastAll(jukebox.state().track === STREAM ? `📻 ${who} tuned the jukebox to ${jukebox.title()}` : `🎵 ${who} put on “${jukebox.title()}”`);
        break;
      }
      case 'jukebox.skip': {
        jukebox.skip(who);
        jukeboxChanged();
        toastAll(`⏭️ ${who} skipped to “${jukebox.title()}”`);
        break;
      }
      case 'jukebox.stop': {
        if (!jukebox.stop(who)) break;
        jukeboxChanged();
        toastAll(`🔇 ${who} turned the jukebox off`);
        break;
      }
      case 'automation.result': {
        const wait = automationWaits.get(str(msg.id, 16));
        if (!wait || wait.client !== c.id) break;
        wait.done(msg.ok === true ? { ok: true, value: msg.value } : { ok: false, error: str(msg.error, 2000) || 'The command failed' });
        break;
      }
      case 'ping':
        sendTo(c, { t: 'pong', at: num(msg.at), now: Date.now() });
        break;
    }
    // A request id is a receipt request. Sync handlers that did not answer, and actions the companion does not await, still close the receipt so the client does not wait out its timeout.
    if (!pending) done('This action was not confirmed. Check the office before trying again; it was not replayed.');
  };

  const resync = setInterval(() => {
    for (const c of clients.values()) {
      if (!c.stale.size || c.ws.bufferedAmount > SLOW_CLIENT_BYTES / 8) continue;
      for (const wid of c.stale) {
        const snap = c.attached.has(wid) ? attachTerminal(wid, c) : undefined;
        if (snap) sendTo(c, { t: 'term.snapshot', workerId: wid, ...snap });
      }
      c.stale.clear();
    }
  }, 1000);

  // Drop dead connections so ghosts don't linger in the office.
  const heartbeat = setInterval(() => {
    for (const c of clients.values()) {
      if (!c.isAlive) {
        c.ws.terminate();
        continue;
      }
      c.isAlive = false;
      c.ws.ping();
      // A phone that stays connected is still being seen (written down once a minute at most).
      if (c.device) devices.seen(c.device);
    }
  }, 20_000);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, () => resolve());
  });
  // Agents someone started by hand in a floor's checkout, at desks of their own (see guests.ts).
  const guestScanner = new GuestScanner(
    () => [...floors.values()].map((f) => ({ id: f.id, dir: f.dir, home: building.isHome(f.id), syncGuests: (procs: AgentProcess[]) => f.syncGuests(procs) })),
    () => [...floors.values()].flatMap((f) => f.workers.owners()),
  );
  guestScanner.start();
  await hotReload.start();

  /** With `keep` (a restart), workers' terminals keep running for the next office to pick up. */
  const shutdown = (keep = false) => {
    clearInterval(heartbeat);
    clearInterval(resync);
    clearTimeout(floorsTimer);
    upgrader.stop();
    void hotReload.stop().catch((err) => console.error('droid-office: source reload cleanup:', err));
    guestScanner.stop();
    webhook.stop();
    machine.stop();
    sky.stop();
    factory.stop();
    setup.stop();
    subscriptions.stop();
    for (const f of floors.values()) f.shutdown(keep);
    void renderer?.close();
    for (const c of clients.values()) c.ws.close();
    server.close();
    hookServer.close();
  };

  return {
    server,
    shutdown,
    lanToken,
    pairing: pairingState,
    companion: () => companion.on,
    devices,
    publicDir,
    hookPort,
    floors: () => [...floors.values()],
    projectsDir: () => building.projectsDir,
    resolvedAgent: agentPath,
  };
}

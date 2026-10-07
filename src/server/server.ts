import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import type { Config } from './config.js';
import { lanAllowed, mintLanToken } from './lan.js';
import { MAX_REPOS, resolveCommand, type RepoSource } from './workers.js';
import { DROID_MODEL_MAX } from './agents.js';
import { createDroidModelCatalogue } from './droid-models.js';
import { Upgrader } from './upgrade.js';
import { Services } from './services.js';
import { GUEST_REFUSED, GuestScanner, guestRefusal, type AgentProcess } from './guests.js';
import { ImageProxy } from './decor.js';
import { Webhook } from './webhook.js';
import { JiraOffice } from './jira.js';
import { MAX_WORKER_LIMIT, Machine, parseWorkerLimit } from './machine.js';
import { Building, type FloorDef } from './building.js';
import { Floor, type FloorContext } from './floor.js';
import { Sky } from './sky.js';
import { LeaveOnMerge } from './leave-on-merge.js';
import { Subagents } from './subagents.js';
import { OfficePrompts } from './prompts.js';
import { HotReload, sourceAppDir } from './hot-reload.js';
import { relayRequest, relayUpgrade, stoppedPage, tunneledPort } from './relay.js';
import { Arcade, HighScores } from './cabinet.js';
import type { Arrival, ClientMsg, FloorInfo, FloorView, MeetingRequest, SearchResults, ServerMsg, ServicesState } from '../shared/protocol.js';
import { GH_COMMENT_MAX, GH_LABEL_MAX, isAgentEffort } from '../shared/protocol.js';
import { DESK_BY_ID, elevatorSpot, streetBelow } from '../shared/layout.js';
import { JUKEBOX_TUNES, STREAM } from '../shared/jukebox.js';
import { checkFrame, scoreText, type CabinetFrame, type CabinetState } from '../shared/cabinet.js';
import { SEARCH_MAX, SEARCH_MIN, searchKey } from '../shared/search.js';
import { DROP_MAX_BYTES, PROMPT_IMAGES_MAX, PROMPT_IMAGE_ID } from '../shared/drops.js';
import { MAX_FLOORS, forgeWords, returnLanding } from '../shared/floors.js';
import { PROMPTS, PROMPT_MAX, isPromptId } from '../shared/prompts.js';
import { ROOF } from '../shared/rooftop.js';

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
  /** When they last blew the DJ's air horn on the roof. */
  lastHornAt: number;
  /** At the arcade cabinet on their floor, playing their own `game` (see Arcade); `frame` is it as it looks now. */
  playing: boolean;
  game?: string;
  frame?: CabinetFrame;
  /** Cleared at each heartbeat ping and set again by the pong; still clear at the next one means gone. */
  isAlive: boolean;
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
  const clients = new Map<string, Client>();
  // The arcade's high scores: one table for the whole building, on every floor's cabinet. The office
  // follows every game and puts the scores up itself (see Arcade).
  const highScores = new HighScores(cfg.dataDir);
  const arcade = new Arcade(highScores, (first) => {
    cabinetScoresChanged();
    if (first) toastFloor(floors.get(first.floor), `🏆 ${first.score.name} set a new arcade high score: ${scoreText(first.score.score)}`);
  });
  /** What the office is called where it has no project of its own to go by (webhooks). */
  const officeName = cfg.project ? path.basename(cfg.project) : 'the office';
  // Droid lists its own models (built-in and custom); its settings file is the fallback.
  const droidModels = createDroidModelCatalogue({ command: cfg.agentCmd.includes('/') ? path.resolve(cfg.agentCmd) : cfg.agentCmd, cwd: cfg.dir });

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

  // --- The building: a floor per project, each with its own workers, boards and queue -----------
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
  const floorInfos = (): FloorInfo[] => [...[...floors.values()].map((f) => ({ ...f.info(), ...(building.isLocal(f.id) ? { local: true } : {}), ...(building.isHome(f.id) ? { home: true } : {}) }))];
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

  // --- Loopback-only endpoint for authenticated agent events -------------------------------
  let webhook!: Webhook;
  const hookServer = http.createServer(async (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      return send(res, 400, {});
    }
    if (url.pathname === '/office/queue') return officeQueue(req, res, url);
    if (url.pathname === '/office/workers') return officeWorkers(req, res, url);
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
   * The task queue, for the board agents (see stations.ts, which tells them how): GET lists it, POST
   * adds a task, DELETE with ?task= takes a waiting one off. The agent's own hook token says who's asking.
   */
  const officeQueue = async (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => {
    const workerId = url.searchParams.get('worker') ?? '';
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const floor = workerFloor(workerId);
    const agent = floor?.workers.authenticate(workerId, token);
    if (!floor || !agent) return send(res, 401, { error: 'Send your own DROID_OFFICE_WORKER_ID as ?worker= and DROID_OFFICE_HOOK_TOKEN as the bearer token' });
    if (!DESK_BY_ID.get(agent.deskId)?.station) return send(res, 403, { error: 'Only the agents standing by the boards can use the queue' });
    const view = () => {
      const q = floor.queue.state();
      return {
        maxWorkers: q.maxWorkers,
        tasks: q.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, outcome: t.outcome, issue: t.issue, addedBy: t.addedBy, worker: t.workerName, branch: t.branch, pr: t.pr, error: t.error })),
      };
    };
    if (req.method === 'GET') return send(res, 200, view());
    if (req.method === 'DELETE') {
      const err = floor.queue.remove(url.searchParams.get('task') ?? '');
      return err ? send(res, 400, { error: err }) : send(res, 200, view());
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'GET, POST or DELETE' });
    let body: { prompt?: unknown; title?: unknown; issue?: unknown };
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, { error: 'Send JSON: {"title": "…", "prompt": "…", "issue": 12}' });
    }
    const issue = Number.isInteger(body?.issue) && (body.issue as number) > 0 ? (body.issue as number) : undefined;
    const err = floor.queue.add(str(body?.prompt, 20000), agent.name, str(body?.title, 200) || undefined, issue);
    if (err) return send(res, 400, { error: err });
    const task = floor.queue.state().tasks.at(-1)!;
    toastFloor(floor, `📋 The ${agent.name} queued ${issue !== undefined ? `issue #${issue}` : `“${task.title}”`}`);
    send(res, 200, { ok: true, task: { id: task.id, title: task.title, status: task.status } });
  };
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
  // The prompts the office writes for workers by itself, and the worker a new one starts on when nobody picks (Settings).
  const prompts = new OfficePrompts(cfg.dataDir, (state) => broadcast({ t: 'prompts', state }));
  // How workers hire subagents at the desks, on every floor, and the Droid skill that tells them how (Settings).
  const subagents = new Subagents(cfg.dataDir, (state) => broadcast({ t: 'subagents', state }), cfg.skillsDir);
  subagents.syncSkill();

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
  /** Queues everywhere may be waiting for room under the worker limit: let them look again. */
  const pumpQueues = (except?: Floor) => {
    if (machine.limit === undefined) return;
    // Not right now: whoever freed the seat (a queue making room for its next task) takes it first.
    setImmediate(() => {
      for (const f of floors.values()) if (f !== except) f.queue.pump();
    });
  };

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
    workerChanged: (floor, w) => {
      if (typeof w === 'string') {
        webhook.onWorkerGone(w);
        pumpQueues(floor);
      } else webhook.onWorker(w);
      machine.workersChanged();
      floorsChanged();
    },
    connections: (floor) => {
      let n = 0;
      for (const c of clients.values()) if (c.floor === floor.id) n++;
      return n;
    },
    leaveOnMerge: () => leaveOnMerge.on,
    subagents: () => subagents.settings,
    floor: (id) => floors.get(id),
    pullsChanged: (floor) => {
      for (const f of floors.values()) if (f !== floor && worksIn(f, floor)) f.sendLandedHome();
    },
    lent: (floor) => [...floors.values()].some((f) => f !== floor && worksIn(f, floor)),
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
  // Workers still running from the last office are back at their desks before anyone walks in.
  await Promise.all([...floors.values()].map((f) => f.ready));

  // The owner SSHes to a deployed office as the box's own user (deploy/aws.sh tunnels as ubuntu,
  // never as the old restricted team user): the Services board's tunnel hint comes straight from
  // the box's public address, no team membership involved.
  const ownerSsh = cfg.publicHost ? `ubuntu@${cfg.publicHost}` : undefined;

  // Web servers the workers start, for the Services board and service tunnels (see relay.ts).
  // One scan covers every floor; each floor's board lists its own workers' servers.
  const servicesState = (floor: Floor | undefined, items = services.list()): ServicesState => ({
    items: floor ? items.filter((s) => floor.workers.get(s.workerId)) : [],
    port: cfg.port,
    ssh: ownerSsh,
  });
  const services = new Services(
    () => [...floors.values()].flatMap((f) => f.workers.owners()),
    (items) => {
      for (const c of clients.values()) sendTo(c, { t: 'services', state: servicesState(floorOf(c), items) });
    },
  );

  /** The cabinet as `c` sees it: their own game (or none), plus the building's high scores. */
  const cabinetState = (c: Client): CabinetState => {
    return { player: c.playing && c.game ? { game: c.game } : null, scores: highScores.top() };
  };
  const sendCabinet = (c: Client) => sendTo(c, { t: 'cabinet', state: cabinetState(c) });
  /** The high-score table changed: every connection gets its own game plus the new scores. */
  const cabinetScoresChanged = () => {
    for (const c of clients.values()) sendCabinet(c);
  };
  /** `c` stepped away from the cabinet (or left the floor, or the office): their game waits, with its score so far on the table. */
  const stopPlaying = (c: Client, floor = floorOf(c)) => {
    if (!c.playing) return;
    if (floor) arcade.leave(c.game, floor.id);
    c.playing = false;
    c.game = undefined;
    c.frame = undefined;
    sendCabinet(c);
  };

  /** Everything on a floor, for whoever just arrived there. */
  const floorView = (floor: Floor | undefined, c: Client): FloorView => ({
    floor: floor?.id ?? null,
    project: floor?.project ?? null,
    workers: floor?.everyone() ?? [],
    issues: floor?.board.issues ?? { items: [], fetchedAt: 0, loading: false },
    pulls: floor?.board.pulls ?? { items: [], fetchedAt: 0, loading: false },
    queue: floor?.queue.state() ?? { tasks: [], maxWorkers: 0 },
    decor: floor?.decor.list() ?? [],
    services: servicesState(floor),
    ball: floor?.court.state() ?? {},
    jukebox: floor?.jukebox.state() ?? { on: false, track: JUKEBOX_TUNES[0].id, startedAt: Date.now(), elapsed: 0 },
    meeting: floor?.meetings.state() ?? { current: null, past: [] },
    jira: floor?.jira.state() ?? { connection: jira.connection() },
    jiraBoard: floor?.jira.board ?? null,
    cabinet: { ...cabinetState(c), frame: c.frame ?? null },
  });
  /** The rooftop bar: nobody works up there, so it has none of a floor's things. */
  const roofView = (c: Client): FloorView => ({ ...floorView(undefined, c), floor: ROOF });
  const screensOf = (c: Client, floor: Floor | undefined) => {
    for (const { workerId, frame } of floor?.workers.fullScreens() ?? []) sendTo(c, { t: 'screen', workerId, ...frame, full: true });
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

  /** Off the machine without this start's token: APIs get JSON, pages get a pointer to the join link. */
  const refuseHttp = (res: http.ServerResponse, api: boolean) => {
    const hint = 'Open the join link from the office’s terminal (it prints a QR code on startup).';
    if (api) return send(res, 401, { error: `This office needs its join link (?t=). ${hint}` });
    res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' });
    res.end(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Join link needed · Droid Office</title></head><body style="font:16px/1.5 system-ui,sans-serif;color:#2b2d42;background:#bfe3ff;display:grid;place-items:center;min-height:100vh;margin:0"><main style="background:#fffaf3;border:3px solid #2b2d42;border-radius:18px;padding:28px 32px;max-width:440px;margin:16px"><h1 style="margin:0 0 8px;font-size:22px">🔒 Join link needed</h1><p style="margin:0">This office only opens with its join link. ${hint}</p></main></body></html>`,
    );
  };

  /** The 🔎 search: lines of the terminals of every worker on that floor, with the words in them. */
  const search = (q: string, floor: Floor | undefined): SearchResults => {
    q = q.slice(0, SEARCH_MAX);
    const needle = searchKey(q);
    if (needle.length < SEARCH_MIN) return { q, terminals: [], more: false };
    const shown = floor?.workers.search(needle, SEARCH_TERMINAL_HITS) ?? { hits: [], more: false };
    return { q, terminals: shown.hits, more: shown.more };
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
      // A service tunnel (localhost:5173 -> the office): relay to that worker's server. SSH tunnels
      // arrive over loopback; anything else needs the token like any other request.
      const tunneled = tunneledPort(req, cfg.port);
      const svc = tunneled ? services.lookup(tunneled) : undefined;
      if (tunneled && svc) {
        if (!lanAllowed(req, url, lanToken)) return refuseHttp(res, true);
        if (svc === 'gone') return stoppedPage(res, tunneled);
        return relayRequest(req, res, svc);
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
      // Everything else needs this start's token from off the machine (loopback connects freely).
      if (!lanAllowed(req, url, lanToken)) return refuseHttp(res, p.startsWith('/api/'));

      if (p === '/api/health') return send(res, 200, { ok: true });
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
        if (!sameOrigin(req, cfg)) return send(res, 403, { error: 'Forbidden' });
        if (!floor) return send(res, 404, { error: 'No such floor' });
        const workerId = str(url.searchParams.get('worker'), 32);
        if (!floor.workers.get(workerId)) return send(res, 404, { error: 'No such worker' });
        const tooBig = `That file is too big to drop into a terminal (${DROP_MAX_BYTES / 1024 / 1024} MB at most)`;
        if (Number(req.headers['content-length']) > DROP_MAX_BYTES) return send(res, 413, { error: tooBig });
        let body: Buffer;
        try {
          body = await readBytes(req, DROP_MAX_BYTES);
        } catch (err) {
          return (err as Error).message === 'too large' ? send(res, 413, { error: tooBig }) : send(res, 400, { error: 'Bad request' });
        }
        const file = floor.workers.drop(workerId, str(url.searchParams.get('name'), 256), str(req.headers['content-type'], 128), body);
        return file ? send(res, 200, { path: file }) : send(res, 500, { error: 'The office could not keep that file' });
      }
      if (p === '/api/prompt/image') {
        // A picture pasted into a prompt that isn't sent yet, kept on this machine until it is (POST), or taken out again (DELETE).
        if (req.method !== 'POST' && req.method !== 'DELETE') return send(res, 405, { error: 'Method not allowed' });
        if (!sameOrigin(req, cfg)) return send(res, 403, { error: 'Forbidden' });
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
      if (p.startsWith('/api/docs') && req.method === 'GET') {
        // The bookshelf: the project's Markdown files, one to read, and the pictures in it (see docs.ts).
        if (!floor) return send(res, 404, { error: 'No such floor' });
        if (p === '/api/docs') return send(res, 200, await floor.docs.list());
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
    const tunneled = tunneledPort(req, cfg.port);
    const svc = tunneled ? services.lookup(tunneled) : undefined;
    if (tunneled && svc) {
      if (svc !== 'gone' && lanAllowed(req, url, lanToken)) return relayUpgrade(req, socket, head, svc);
      return refuseUpgrade(socket);
    }
    // The socket is the office page's own: this start's token (or loopback) plus a matching
    // Origin (see sameOrigin). One check per connection; nothing per message.
    if (url.pathname !== '/ws' || !sameOrigin(req, cfg) || !lanAllowed(req, url, lanToken)) return refuseUpgrade(socket);
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, url));
  });

  const onConnection = (ws: WebSocket, url: URL) => {
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
      lastHornAt: 0,
      playing: false,
      isAlive: true,
      peer: { name, color: COLOR_RE.test(colorParam) ? colorParam : '#4f86f7' },
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
      leaveOnMerge: leaveOnMerge.state(),
      subagents: subagents.state(),
      prompts: prompts.state(),
      ...(onRoof ? roofView(client) : floorView(floor, client)),
    });
    screensOf(client, floor);
    floorsChanged();
    if (floor) {
      floor.arrived();
      // Anyone whose process ended since (exited, or failed to resume) gets up as you walk in.
      floor.workers.wakeAll();
    }

    ws.on('message', (raw) => {
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
      stopPlaying(client);
      for (const f of floors.values()) {
        f.workers.detachAll(id);
        f.guests.detachAll(id);
        f.changes.unwatchAll(id);
        if (f.court.left(id)) ballChanged(f);
      }
      floorsChanged();
    });
    ws.on('error', () => ws.terminate());
  };

  const decorChanged = (floor: Floor) => toFloor(floor, { t: 'decor', items: floor.decor.list() });
  const ballChanged = (floor: Floor) => toFloor(floor, { t: 'ball', ball: floor.court.state() });
  const jukeboxChanged = (floor: Floor) => toFloor(floor, { t: 'jukebox', state: floor.jukebox.state() });

  /**
   * Takes `c` to another floor: they get the new floor's everything. They arrive in the
   * elevator, or `at` the spot they came by.
   */
  const goToFloor = (c: Client, floor: Floor, at?: { x: number; y: number; z: number; rotY: number }) => {
    if (c.floor === floor.id) return;
    const left = leave(c, at);
    c.floor = floor.id;
    const spot = left.spot;
    sendTo(c, { t: 'floor.enter', arrival: { floor: floor.id, at: { x: spot.x, y: spot.y, z: spot.z, rotY: spot.rotY }, via: at ? 'requested' : 'elevator' }, ...floorView(floor, c) });
    screensOf(c, floor);
    arrived(left);
    floor.arrived();
    floor.workers.wakeAll();
    floorsChanged();
  };

  /** Up to the rooftop bar, by elevator. */
  const goToRoof = (c: Client) => {
    if (c.floor === ROOF) return;
    const left = leave(c);
    c.floor = ROOF;
    const spot = left.spot;
    sendTo(c, { t: 'floor.enter', arrival: { floor: ROOF, at: { x: spot.x, y: spot.y, z: spot.z, rotY: spot.rotY }, via: 'elevator' }, ...roofView(c) });
    arrived(left);
    floorsChanged();
  };

  /** Out to the lobby, where the elevator has nowhere to go: the building's last floor was taken off. */
  const toLobby = (c: Client) => {
    const left = leave(c);
    c.floor = null;
    sendTo(c, { t: 'floor.enter', arrival: { floor: null, via: 'lobby' }, ...floorView(undefined, c) });
    arrived(left);
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
    // Its workers made room under the worker limit.
    pumpQueues();
  };

  /** Off the floor (or the roof) `c` was on, to `at` on the next one, or into its elevator car. */
  const leave = (c: Client, at?: { x: number; y: number; z: number; rotY: number }) => {
    const was = floorOf(c);
    if (was) {
      was.workers.detachAll(c.id);
      was.guests.detachAll(c.id);
      was.changes.unwatchAll(c.id);
    }
    // The ball stays on its floor, back under the hoop. That floor hears so once they're off it (see
    // arrived), or their own page would put it down before it knew they'd gone.
    const ballLeft = !!was?.court.left(c.id);
    c.attached.clear();
    c.stale.clear();
    stopPlaying(c, was);
    const spot = at ?? { ...elevatorSpot(), y: 0, rotY: 0 };
    return { was, ballLeft, spot };
  };

  const arrived = (left: ReturnType<typeof leave>) => {
    if (left.ballLeft && left.was) ballChanged(left.was);
  };

  /**
   * A worker took on issue `n` (an issue card dropped on its desk): assign it on GitHub or GitLab, which
   * moves it to In progress on the board, and take it off the queue so nobody else is seated for it.
   */
  const takeIssue = (c: Client, floor: Floor, n: number) => {
    floor.queue.dropIssue(n);
    void floor.board.claim(n).then((err) => warn(c, err && `Couldn't assign issue #${n} on ${forgeWords(floor.board.forge).site}: ${err}`));
  };

  /** Every floor's Jira tab starts over with the office's new connection (or none). */
  const jiraConnectionChanged = () => {
    for (const f of floors.values()) void f.jira.connectionChanged();
  };

  /**
   * Runs `go` once a worktree made on `floor` would start from what's on the forge now (see
   * Worktrees.fetch): right away when that was just fetched, else after a fetch, if `c` and the floor
   * are still there.
   */
  const withFreshBase = (c: Client, floor: Floor | Floor[], go: () => void) => {
    const all = Array.isArray(floor) ? floor : [floor];
    const fetching = all.map((f) => f.workers.fetchBase()).filter((p): p is Promise<void> => p !== undefined);
    if (!fetching.length) return go();
    void Promise.all(fetching).then(() => {
      if (c.ws.readyState !== WebSocket.OPEN || all.some((f) => floors.get(f.id) !== f)) return;
      go();
    });
  };

  /** Opens a worker's terminal for `c`, or the banner a guest has instead of one. */
  const attachTerminal = (wid: string, c: Client) => workerFloor(wid)?.workers.attach(wid, c.id) ?? guestFloor(wid)?.guests.attach(wid, c.id);

  const handleMessage = (c: Client, msg: ClientMsg) => {
    const who = c.peer.name;
    /** The floor `c` is on, or a note to them that they have to be on one. */
    const here = (): Floor | undefined => {
      const f = floorOf(c);
      if (!f) warn(c, 'Take the elevator to a floor first');
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
    const guest = GUEST_REFUSED.has(msg.t) && typeof asked === 'string' ? guestFloor(asked)?.guests.get(asked) : undefined;
    if (guest?.guest) return warn(c, guestRefusal(guest, msg.t));
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
      case 'floor.repos':
        void building.repos(msg.refresh === true).then(
          (repos) => sendTo(c, { t: 'floor.repos', repos }),
          (err: Error) => sendTo(c, { t: 'floor.repos', repos: [], error: `Couldn't look for checkouts: ${err.message}` }),
        );
        break;
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
        break;
      }
      case 'floor.remove': {
        const id = str(msg.floor, 64);
        const r = building.remove(id, who);
        if (typeof r === 'string') return warn(c, r);
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
      case 'ball.take':
      case 'ball.throw': {
        const floor = floorOf(c);
        if (!floor) break;
        const changed = msg.t === 'ball.take' ? floor.court.take(c.id) : floor.court.throw(c.id, { x: num(msg.x), y: num(msg.y), z: num(msg.z), vx: num(msg.vx), vy: num(msg.vy), vz: num(msg.vz) });
        // Whoever didn't get it (someone else caught it first) is told where it really is.
        if (changed) ballChanged(floor);
        else sendTo(c, { t: 'ball', ball: floor.court.state() });
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
            return warn(c, other ? "The worker's own floor's project is already in its workspace" : 'That project is no longer in the building');
          }
          repos.push({ floor: other.id, name: other.def.name, repo: other.def.repo, dir: other.dir });
        }
        const hire = () => {
          const r = floor.workers.spawn(str(msg.deskId, 32), who, str(msg.prompt, 20000) || undefined, msg.worktree === true, kind, model, effort, undefined, repos, undefined, images);
          floor.workers.unstage(images);
          const issue = kind === 'agent' ? issueNumber(msg.issue) : undefined;
          const across = repos.length ? ` across ${[floor.def.name, ...repos.map((x) => x.name)].join(' + ')}` : '';
          if (typeof r === 'string') warn(c, r);
          else toastFloor(floor, kind === 'shell' ? `${who} opened a shell at a desk` : `${who} hired ${r.name}${issue ? ` for issue #${issue}` : r.prompt ? ' with a task' : ''}${kind === 'agent' ? across : ''}`);
          if (typeof r !== 'string' && issue) takeIssue(c, floor, issue);
        };
        // Every project it gets a worktree of starts from what's on the forge now.
        const fresh = [floor, ...repos.map((x) => floors.get(x.floor)!)];
        if (msg.worktree === true) withFreshBase(c, fresh, hire);
        else hire();
        break;
      }
      case 'worker.resume': {
        const w = worker(msg.workerId);
        warn(c, w ? w.floor.workers.resume(w.wid) : 'No such worker');
        break;
      }
      case 'worker.shoot':
      case 'worker.revive': {
        const w = worker(msg.workerId);
        if (!w) break;
        warn(c, msg.t === 'worker.shoot' ? w.floor.workers.shoot(w.wid) : w.floor.workers.revive(w.wid));
        break;
      }
      case 'worker.kill': {
        const w = worker(msg.workerId);
        if (!w) break;
        const { floor, info } = w;
        if (info.downedUntil !== undefined && info.downedUntil > Date.now()) return warn(c, 'This worker is downed — revive them or wait until the revival window expires');
        // The worker leaves right away; its worktree is dealt with after that, and the outcome follows.
        const done = floor.workers.kill(info.id, CLEANUPS.has(String(msg.cleanup)) ? msg.cleanup : undefined);
        toastFloor(floor, `${who} sent ${info.name} home`);
        void done.then(({ note, error }) => {
          if (note) toastFloor(floor, note);
          if (error) toastFloor(floor, error, 'warn');
        });
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
            // Sent home meanwhile, or back already with one before it (the rest of a meeting's table).
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
      case 'worker.prompt': {
        const w = worker(msg.workerId);
        const images = imageIds(msg.images);
        const err = w ? w.floor.workers.prompt(w.wid, str(msg.prompt, 20000), images) : 'No such worker';
        w?.floor.workers.unstage(images);
        warn(c, err);
        const issue = w?.info.kind === 'agent' ? issueNumber(msg.issue) : undefined;
        if (w && !err && issue) {
          toastFloor(w.floor, `${who} handed issue #${issue} to ${w.info.name}`);
          takeIssue(c, w.floor, issue);
        }
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
        if (!w) break;
        const { floor, wid } = w;
        void floor.workers.openPr(wid, who).then((r) => {
          if (typeof r === 'string') return warn(c, r);
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
        });
        break;
      }
      case 'term.input':
        if (c.attached.has(msg.workerId)) workerFloor(msg.workerId)?.workers.write(msg.workerId, str(msg.data, 64 * 1024));
        break;
      case 'term.resize':
        if (c.attached.has(msg.workerId)) workerFloor(msg.workerId)?.workers.resize(msg.workerId, num(msg.cols), num(msg.rows));
        break;
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
      case 'horn': {
        const now = Date.now();
        if (c.floor !== ROOF || now - c.lastHornAt < 1500) break;
        c.lastHornAt = now;
        for (const o of clients.values()) if (o.floor === ROOF) sendTo(o, { t: 'horn', by: who });
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
          // Nobody should be seated for an issue that's closed.
          const dropped = floor.queue.dropIssue(n);
          toastFloor(floor, `${who} closed issue #${n}${reason === 'not planned' ? ' as not planned' : ''}${dropped ? ' and took it off the queue' : ''}`);
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
      case 'queue.add': {
        const floor = here();
        if (!floor) break;
        const issue = Number.isInteger(msg.issue) && (msg.issue as number) > 0 ? (msg.issue as number) : undefined;
        const model = msg.model === undefined ? undefined : str(msg.model, MODEL_MAX + 1);
        const effort = isAgentEffort(msg.effort) ? msg.effort : undefined;
        const images = imageIds(msg.images);
        const err = floor.queue.add(str(msg.prompt, 20000), who, str(msg.title, 200), issue, model, effort, images);
        if (err) {
          floor.workers.unstage(images);
          warn(c, err);
        } else toastFloor(floor, `📋 ${who} queued ${issue !== undefined ? `issue #${issue}` : 'a task'}`);
        break;
      }
      case 'queue.remove': {
        const floor = here();
        if (floor) warn(c, floor.queue.remove(str(msg.taskId, 32)));
        break;
      }
      case 'queue.move':
        floorOf(c)?.queue.move(str(msg.taskId, 32), num(msg.delta) < 0 ? -1 : 1);
        break;
      case 'queue.retry': {
        const floor = here();
        if (floor) warn(c, floor.queue.retry(str(msg.taskId, 32)));
        break;
      }
      case 'queue.clear':
        floorOf(c)?.queue.clear();
        break;
      case 'queue.limit':
        floorOf(c)?.queue.setLimit(num(msg.maxWorkers));
        break;
      case 'meeting.start': {
        const floor = here();
        if (!floor) break;
        const count = (v: unknown) => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : undefined);
        const request: MeetingRequest = {
          pattern: msg.pattern,
          prompt: str(msg.prompt, 20000),
          title: str(msg.title, 200) || undefined,
          output: str(msg.output, 300) || undefined,
          roles: Array.isArray(msg.roles) ? msg.roles.slice(0, 8).map((r) => str(r, 80)) : [],
          parts: Array.isArray(msg.parts) ? msg.parts.slice(0, 200).map((p) => str(p, 500)) : undefined,
          pr: count(msg.pr),
          issue: count(msg.issue),
          rounds: count(msg.rounds),
          model: msg.model === undefined ? undefined : str(msg.model, MODEL_MAX + 1),
          effort: isAgentEffort(msg.effort) ? msg.effort : undefined,
          images: imageIds(msg.images),
        };
        withFreshBase(c, floor, () => {
          warn(c, floor.meetings.start(request, who));
          floor.workers.unstage(request.images ?? []);
        });
        break;
      }
      case 'meeting.stop': {
        const floor = here();
        if (floor) warn(c, floor.meetings.stop(who));
        break;
      }
      case 'meeting.clear': {
        const floor = here();
        if (floor) warn(c, floor.meetings.clear(who));
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
      case 'subagents.set': {
        const before = subagents.settings;
        const err = subagents.set(msg.settings, who);
        if (err) return warn(c, err);
        const after = subagents.settings;
        if (before.on !== after.on) toastAll(after.on ? `🧭 ${who} let workers hire subagents` : `🧭 ${who} turned subagents off: nobody hires new ones`);
        else toastAll(`🧭 ${who} changed the Subagents settings`);
        break;
      }
      case 'prompts.set': {
        if (!isPromptId(msg.id) || (msg.text !== null && typeof msg.text !== 'string')) return;
        const was = !!prompts.state().custom[msg.id];
        const err = prompts.setPrompt(msg.id, msg.text === null ? null : str(msg.text, PROMPT_MAX + 1), who);
        if (err) return warn(c, err);
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
        if (err) return warn(c, err);
        toastAll(choice ? `🤖 ${who} set the office’s default worker` : `🤖 ${who} put the office’s default worker back to Droid’s own default`);
        break;
      }
      case 'machine.limit': {
        const limit = msg.limit === null ? undefined : parseWorkerLimit(msg.limit);
        if (msg.limit !== null && limit === undefined) return warn(c, `The worker limit is a whole number from 1 to ${MAX_WORKER_LIMIT}`);
        const err = machine.setLimit(limit, who);
        if (err) return warn(c, err);
        const now = machine.limit;
        toastAll(limit !== undefined ? `⚙️ ${who} set the worker limit to ${now}` : now === undefined ? `⚙️ ${who} took the worker limit off` : `⚙️ ${who} put the worker limit back to ${now} (--max-workers)`);
        pumpQueues();
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
        if (typeof d === 'string') return warn(c, d);
        decorChanged(floor);
        toastFloor(floor, `🖼️ ${who} hung ${d.title ? `“${d.title}”` : 'a picture'}`);
        break;
      }
      case 'decor.update': {
        const floor = here();
        if (!floor) break;
        const d = floor.decor.update(str(msg.id, 32), msg.decor);
        if (typeof d === 'string') return warn(c, d);
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
        const floor = here();
        if (!floor) break;
        const r = floor.jukebox.play({ track: msg.track, url: msg.url }, who);
        if ('error' in r) return warn(c, r.error);
        if (!r.changed) break;
        jukeboxChanged(floor);
        toastFloor(floor, floor.jukebox.state().track === STREAM ? `📻 ${who} tuned the jukebox to ${floor.jukebox.title()}` : `🎵 ${who} put on “${floor.jukebox.title()}”`);
        break;
      }
      case 'jukebox.skip': {
        const floor = here();
        if (!floor) break;
        floor.jukebox.skip(who);
        jukeboxChanged(floor);
        toastFloor(floor, `⏭️ ${who} skipped to “${floor.jukebox.title()}”`);
        break;
      }
      case 'cabinet.play': {
        const floor = here();
        if (!floor || (c.playing && msg.game === c.game)) break;
        // Already at it: that game's over, and this is the next one.
        if (c.playing) arcade.leave(c.game, floor.id);
        // Score names come from the connection's display provenance (see Client.peer).
        c.game = arcade.start({ owner: c.id, name: who, color: c.peer.color }, msg.game);
        if (typeof msg.game === 'string' && msg.game && c.game !== msg.game) warn(c, "🕹️ Your paused game didn't survive the restart, so here's a new one");
        if (c.game !== msg.game && !arcade.counts(c.game)) warn(c, "🕹️ That's a lot of new games in a row, so this one won't go on the high-score table");
        c.playing = true;
        c.frame = undefined;
        sendCabinet(c);
        break;
      }
      case 'cabinet.leave':
        stopPlaying(c);
        break;
      case 'cabinet.frame': {
        const floor = floorOf(c);
        const frame = checkFrame(msg.frame);
        if (!c.playing || !floor || !frame) break;
        // Every frame counts towards the score: the office follows the game frame by frame.
        if (arcade.frame(c.game, frame, floor.id) === 'void') warn(c, "🕹️ The office couldn't follow this game, so its score won't go on the high-score table");
        c.frame = frame;
        break;
      }
      case 'jukebox.stop': {
        const floor = here();
        if (!floor?.jukebox.stop(who)) break;
        jukeboxChanged(floor);
        toastFloor(floor, `🔇 ${who} turned the jukebox off`);
        break;
      }
      case 'ping':
        sendTo(c, { t: 'pong', at: num(msg.at), now: Date.now() });
        break;
    }
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
    }
  }, 20_000);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, () => resolve());
  });
  services.start();
  // Agents someone started by hand in a floor's checkout, at desks of their own (see guests.ts).
  const guestScanner = new GuestScanner(
    () => [...floors.values()].map((f) => ({ id: f.id, dir: f.dir, home: building.isHome(f.id), syncGuests: (procs: AgentProcess[]) => f.syncGuests(procs) })),
    () => [...floors.values()].flatMap((f) => f.workers.owners().flatMap((o) => (o.pid ? [o.pid] : []))),
  );
  guestScanner.start();
  await hotReload.start();

  /** With `keep` (a restart), workers' terminals keep running for the next office to pick up. */
  const shutdown = (keep = false) => {
    clearInterval(heartbeat);
    clearInterval(resync);
    clearTimeout(floorsTimer);
    arcade.flush();
    upgrader.stop();
    void hotReload.stop().catch((err) => console.error('droid-office: source reload cleanup:', err));
    services.stop();
    guestScanner.stop();
    webhook.stop();
    machine.stop();
    sky.stop();
    for (const f of floors.values()) f.shutdown(keep);
    for (const c of clients.values()) c.ws.close();
    server.close();
    hookServer.close();
  };

  return { server, shutdown, lanToken, publicDir, hookPort, floors: () => [...floors.values()], projectsDir: () => building.projectsDir, resolvedAgent: resolveCommand(cfg.agentCmd) };
}

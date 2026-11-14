import http from 'node:http';
import https from 'node:https';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import type { Config } from './config.js';
import type { AddressInfo } from 'node:net';
import { lanIPv4s, mintLanToken, tailscaleIPv4s } from './lan.js';
import { DevicesStore, pairingAddresses } from './devices.js';
import { pickDeepLinkBase } from '../shared/deep-links.js';
import { TailscaleWatch } from './tailscale.js';
import { WebCompanion } from './web-companion.js';
import type { PairedDevice } from '../shared/devices.js';
import { MAX_REPOS, childEnv, resolveAgent, type RepoSource } from './workers.js';
import { DROID_MODEL_MAX } from './agents.js';
import { createDroidCommandCatalogue } from './droid-commands.js';
import { airgappedModelError, createDroidModelCatalogue, customModelCatalogue, readDroidModels } from './droid-models.js';
import { HiddenModels } from './hidden-models.js';
import { Upgrader } from './upgrade.js';
import { HostUpdates } from './host-updates.js';
import { PhoneSizes } from './phone-sizes.js';
import { ImageProxy } from './decor.js';
import { JiraOffice } from './jira.js';
import { AUTOPILOT_NAME, LinearOffice } from './linear.js';
import { DEFAULT_AUTOPILOT, linearIssueRef, linearPriority } from '../shared/linear.js';
import { mountFactory } from './factory/index.js';
import { mountSetup, readSetupFile } from './setup/index.js';
import { mountSubscriptions } from './subscriptions/index.js';
import { MAX_WORKER_LIMIT, Machine, parseWorkerLimit } from './machine.js';
import { Building, type FloorDef } from './building.js';
import { FloorActivity } from './floor-activity.js';
import { Floor, type FloorContext } from './floor.js';
import { Sky } from './sky.js';
import { LeaveOnMerge } from './leave-on-merge.js';
import { FreshMain } from './saved-switch.js';
import { Subagents, removeBundledSkills } from './subagents.js';
import { createOfficeMcp, OFFICE_MCP_PATH, syncOfficeMcpConnection, type OfficeMcpServer } from './office-mcp/index.js';
import type { OwnerOffice } from './office-mcp/owner.js';
import { formatBlockingSteerWarning } from './worker-queue.js';
import { OfficePrompts } from './prompts.js';
import { HotReload, sourceAppDir } from './hot-reload.js';
import { TrackpadHaptics } from './haptics.js';
import { OFFICE_SHELL_ID } from '../shared/office-shell.js';
import type { Arrival, ClientMsg, FloorInfo, FloorView, WorkerInfo } from '../shared/protocol.js';
import { AUTO_DESK, isAgentEffort } from '../shared/protocol.js';
import { isAsleep } from '../shared/status.js';
import { ORCHESTRATOR_ID, type MissionControlState, type OrchestratorSettings } from '../shared/mission-control.js';
import { AIRGAPPED_REASON, droidReady } from '../shared/setup.js';
import { cannotRun } from '../shared/subscriptions.js';
import { factoryModelGate, factoryModelTier } from '../shared/factory-limits.js';
import { elevatorSpot, nextFreeSeat, streetBelow } from '../shared/layout.js';
import { STREAM } from '../shared/jukebox.js';
import { Jukebox } from './jukebox.js';
import { MAX_FLOORS, forgeWords, returnLanding } from '../shared/floors.js';
import { PROMPTS, PROMPT_MAX, isPromptId } from '../shared/prompts.js';
import { ROOF } from '../shared/rooftop.js';
import { NO_PIPELINES } from '../shared/pipelines.js';
import { RenderEngine } from './whiteboard-render.js';
import { officePrompt } from './prompts.js';
import { Answers } from './answers.js';
import { WorkerThreadReader } from './worker-thread.js';
import { WorkerLabels } from './worker-labels.js';
import { LabelModelError, openAiLabel, WorkerLabelModel } from './worker-label-model.js';
import { WorkerLabelPreferences } from './worker-label-settings.js';
import { sameEndpointOrigin } from '../shared/worker-labels.js';
import { FinderDispatch, finderCatalogue, handleFinder, publishFinder } from './finder.js';
import { RemoteWorkers } from './remote-workers.js';
import { RemoteOffice } from './remote-office.js';
import { RemoteMcp } from './remote-mcp-http.js';
import { Orchestrator } from './orchestrator.js';
import { missionTeam, type BuildingAgents } from './building-agent.js';
import { GeminiDecisionsStore } from './gemini-decisions.js';
import { OfficeVibes, type VibesFloorView } from './office-vibes.js';
import { WakeFilter } from './wake-filter.js';
import { createBoardCommands } from './server-runtime/board-commands.js';
import { createClientTransport } from './server-runtime/transport.js';
import { createOwnerOffice } from './server-runtime/owner.js';
import { createAccess } from './server-runtime/access.js';
import { createHttpHandler } from './server-runtime/http.js';
import { createFloorHttp } from './server-runtime/floor-http.js';
import type { Client, ToastLevel } from './server-runtime/client.js';
import { readBody, send, sameOrigin, refuseUpgrade } from './server-runtime/http-utils.js';
import { str, num, repoOf, imageIds } from './server-runtime/validation.js';
import { createStaticFiles } from './server-runtime/static-files.js';
import { createAutomation } from './server-runtime/automation.js';
import { createWhiteboardRuntime } from './server-runtime/whiteboard.js';

const CLEANUPS = new Set(['keep', 'worktree', 'all']);

/** The longest model id Droid takes, so an overlong one fails validation instead of being clipped. */
const MODEL_MAX = DROID_MODEL_MAX;
/** The longest worktree setup command a floor can be given in Settings. */
const SETUP_MAX = 2000;

function findPublicDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(here, '../../public'), path.resolve(here, '../../dist/public')];
  for (const c of candidates) if (existsSync(path.join(c, 'index.html'))) return c;
  throw new Error(`Client bundle not found (looked in ${candidates.join(', ')}). Run \`npm run build\`.`);
}

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
const issueNumber = (v: unknown) => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : undefined);
/** Who a floor's Linear autopilot hires as, through the owner's own handler (see FloorContext.linearHire). */
const LINEAR_AUTOPILOT: WorkerInfo = { id: 'linear-autopilot', kind: 'agent', deskId: '', name: AUTOPILOT_NAME, color: '#5e6ad2', status: 'idle', acked: true, createdBy: AUTOPILOT_NAME, createdAt: 0, cols: 80, rows: 24, open: false };
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * Closes the terminals a connection had open on the floor it leaves. Mission Control is on every floor: the
 * Orchestrator's stays open through a ride, and still due a snapshot if a slow link was skipping its output.
 */
export function leaveFloorTerminals(c: Pick<Client, 'attached' | 'stale'>) {
  for (const id of c.attached) if (id !== ORCHESTRATOR_ID) c.attached.delete(id);
  for (const id of c.stale) if (id !== ORCHESTRATOR_ID) c.stale.delete(id);
}

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
  const hostUpdates = new HostUpdates();
  const clients = new Map<string, Client>();
  const floors = new Map<string, Floor>();
  const transport = createClientTransport({ clients, floors });
  const { sendTo, broadcast, toFloor, termData, clearOffFloorThrottle, broadcastOffFloorScreen } = transport;
  const workerThreads = new WorkerThreadReader();
  /** The office Mac's trackpad taps for a charging shot; a silent no-op off macOS (see haptics.ts). */
  const trackpadHaptics = new TrackpadHaptics();
  /** The droid every floor runs, by absolute path; null until it's installed (Setup sets it then). */
  let agentPath = resolveAgent(cfg.agentCmd);
  // Droid lists its own models (built-in and custom); its settings file is the fallback.
  const droidModels = createDroidModelCatalogue({ command: () => agentPath ?? cfg.agentCmd, cwd: cfg.dir });
  const availableDroidModels = async () => {
    const catalogue = await droidModels.get();
    return setup.state().airgapped ? customModelCatalogue(catalogue) : catalogue;
  };
  const modelGate = (model: string | undefined) => {
    const settings = readDroidModels();
    const catalogue = droidModels.peek() ?? settings;
    const modelId = model || settings.defaultModel || catalogue.defaultModel;
    const existing = airgappedModelError(setup.state().airgapped, model, settings) ?? subscriptions.gate(modelId);
    if (existing || !modelId) return existing;
    const descriptor = settings.models.find((m) => m.id === modelId && m.custom) ?? catalogue.models.find((m) => m.id === modelId) ?? catalogue.disabledModels?.find((m) => m.id === modelId) ?? { id: modelId };
    return factoryModelGate(
      factory.state(),
      descriptor,
      catalogue.models.filter((m) => !subscriptions.gate(m.id)),
      Date.now(),
    );
  };
  // And the skills and custom commands it offers as slash commands, in each worker's own folder.
  const droidCommands = createDroidCommandCatalogue({ command: () => agentPath ?? cfg.agentCmd });
  const hiddenModels = new HiddenModels(cfg.dataDir);

  /** The toasts an external worker's owner action raises, through every callback that action starts. */
  const acting = new AsyncLocalStorage<(text: string) => void>();
  const toastAll = (text: string, level: ToastLevel = 'info') => {
    acting.getStore()?.(text);
    broadcast({ t: 'toast', text, level });
  };

  // --- The building: a floor per project, each with its own workers and boards -----------------
  const building = new Building(cfg.dataDir, cfg.projectsDir);
  if (cfg.projects) {
    const err = building.setProjectsDir(cfg.projects, 'the command line');
    if (err) console.error(`droid-office: --projects: ${err}`);
  }
  const floorActivity = new FloorActivity(cfg.dataDir);
  const remoteWorkers = new RemoteWorkers(cfg.dataDir, () => missionChanged());
  let remoteMcp: RemoteMcp | undefined;
  const deepLinkBase = (): string | undefined => {
    let port = cfg.port;
    try {
      port = (server.address() as AddressInfo | null)?.port ?? cfg.port;
    } catch {
      // server not initialized yet
    }
    const scheme = cfg.tls ? 'https' : 'http';
    const tailIps = tailscaleIPv4s();
    const serveDns = remoteMcp?.dnsName();
    const tailnet = tailscale.peek() ?? (serveDns ? { dnsName: serveDns, ips: tailIps } : undefined);
    return pickDeepLinkBase(pairingAddresses({ scheme, host: cfg.host, port, lan: lanIPv4s(), tailscale: tailnet, tailscaleIps: tailIps }));
  };
  const remoteOffice = new RemoteOffice(remoteWorkers, () => [...floors.values()], { deepLinkBase });
  const floorOf = (c: Client): Floor | undefined => (c.floor ? floors.get(c.floor) : undefined);
  /** The floor a worker sits on. Worker ids are unique across the building. */
  const workerFloor = (workerId: string): Floor | undefined => {
    for (const f of floors.values()) if (f.workers.get(workerId)) return f;
    return undefined;
  };
  const toastFloor = (floor: Floor | undefined, text: string, level: ToastLevel = 'info', workerId?: string) => {
    if (!floor) return;
    acting.getStore()?.(text);
    toFloor(floor, workerId === undefined ? { t: 'toast', text, level } : { t: 'toast', text, level, workerId });
  };
  const floorInfos = (): FloorInfo[] =>
    [...floors.values()].map((f) => {
      floorActivity.observe(
        f.id,
        f.everyone().map((w) => w.id),
      );
      return { ...f.info(), ...floorActivity.info(f.id), ...(building.isLocal(f.id) ? { local: true } : {}), ...(building.isHome(f.id) ? { home: true } : {}) };
    });
  // The elevator's counts change with every worker update; tell everyone at most a few times a second.
  let floorsSent = '';
  let floorsTimer: NodeJS.Timeout | undefined;
  const publishFloors = () => {
    if (floorsTimer) {
      clearTimeout(floorsTimer);
      floorsTimer = undefined;
    }
    const list = floorInfos();
    const json = JSON.stringify(list);
    if (json === floorsSent) return;
    floorsSent = json;
    broadcast({ t: 'floors', floors: list });
  };
  const floorsChanged = () => {
    floorsTimer ??= setTimeout(publishFloors, 250);
  };
  /** Tells just this person why their request didn't happen; nothing when there's no error. */
  const warn = (c: Client, error: string | undefined) => {
    if (error) sendTo(c, { t: 'toast', text: error, level: 'warn' });
  };
  const answers = new Answers();

  // --- Loopback-only endpoint for authenticated agent events -------------------------------
  let finder: FinderDispatch | undefined;
  let finderToken: string | undefined;
  const finderModels = async () => finderCatalogue(await availableDroidModels(), hiddenModels.state(), prompts.agent()?.model);
  let officeMcp: OfficeMcpServer | undefined;
  const hookServer = http.createServer(async (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      return send(res, 400, {});
    }
    if (url.pathname.startsWith('/api/finder/')) return handleFinder(req, res, url.pathname, finderToken, finder, finderModels);
    if (url.pathname === OFFICE_MCP_PATH) {
      if (!officeMcp) return send(res, 503, { error: 'Office MCP is starting' });
      return officeMcp.handle(req, res);
    }
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
    const workers = workersOf(workerId);
    if (!workers) return send(res, 401, {});
    const event = url.searchParams.get('event') ?? '';
    // The hook command's version (see HOOK_VERSION): one from before it is 0, and doesn't print what it gets back.
    const version = Number(url.searchParams.get('v')) || 0;
    const reply = workers.hookReply(workerId, token, event, payload, version);
    if (reply === undefined) return send(res, 401, {});
    // What the command prints is what its droid reads: nothing, or the office's hook output.
    res.writeHead(200, { 'content-type': reply ? 'application/json' : 'text/plain' });
    res.end(reply);
  });
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
  const prompts = new OfficePrompts(cfg.dataDir, (state) => {
    broadcast({ t: 'prompts', state });
    missionChanged();
  });
  // Office tools and how workers hire subagents, on every floor (Settings).
  for (const problem of removeBundledSkills(cfg.skillsDir)) console.warn(problem);
  const hookUrl = `http://127.0.0.1:${hookPort}`;
  let mcpProfile = Promise.resolve();
  const syncOfficeMcp = (on: boolean) => {
    mcpProfile = mcpProfile.then(async () => {
      const problem = await syncOfficeMcpConnection(cfg.skillsDir ? path.join(path.dirname(cfg.skillsDir), 'mcp.json') : undefined, hookUrl, on);
      if (problem) console.warn(problem);
    });
  };
  const subagents = new Subagents(cfg.dataDir, (state) => {
    syncOfficeMcp(state.officeMcp);
    broadcast({ t: 'subagents', state });
    missionChanged();
  });
  syncOfficeMcp(subagents.settings.officeMcp);
  // Another office that held the shared profile entry may stop: take it over then.
  setInterval(() => syncOfficeMcp(subagents.settings.officeMcp), 30_000).unref();

  // --- Mission Control: the building's agents, with no desk on any floor (docs/mission-control.md) ---
  const orchestrator = new Orchestrator({
    dataDir: cfg.dataDir,
    agentCmd: cfg.agentCmd,
    agentArgs: cfg.agentArgs,
    hook: { url: hookUrl, token: '' },
    prompts,
    floors: () => [...floors.values()],
    unready: () => {
      if (!droidReady(setup.state())) return { why: 'Droid isn’t ready on this computer. Install it, then sign in or add a custom model in airgapped mode from ⚙️ Settings → Connections → Droid.', pane: 'connections' };
      if (subagents.settings.officeMcp === false) return { why: 'Office tools (the Office MCP) are off. Turn them on in ⚙️ Settings → Subagents & visits → Office MCP.', pane: 'subagents' };
      return undefined;
    },
    modelGate,
    changed: () => {
      answers.changed(ORCHESTRATOR_ID, orchestrator.info?.status);
      missionChanged();
    },
    data: termData,
    screen: (workerId, frame) => broadcast({ t: 'screen', workerId, ...frame }, undefined, true),
    toast: (text, level) => toastAll(text, level),
  });
  /** A worker's own manager: its floor's, or the Orchestrator's. */
  const workersOf = (workerId: string) => (workerId === ORCHESTRATOR_ID ? orchestrator.workers : workerFloor(workerId)?.workers);
  const buildingAgents: BuildingAgents = {
    identity: (id) => (id === ORCHESTRATOR_ID ? orchestrator.identity() : remoteWorkers.identity(id)),
    known: (id) => id === ORCHESTRATOR_ID || !!remoteWorkers.identity(id),
    tell: (id, text, floor) => (id === ORCHESTRATOR_ID ? orchestrator.tell(text) : remoteOffice.tell(id, text, floor)),
  };
  const missionState = (): MissionControlState => {
    const open = [...floors.values()];
    return {
      orchestrator: orchestrator.state(),
      bots: remoteWorkers.workers().map((worker) => {
        const lastUsedAt = remoteWorkers.lastUsedAt(worker.id);
        const grokBot = remoteWorkers.isGrokBot(worker.id);
        return { worker, team: missionTeam(open, worker.id), ...(lastUsedAt ? { lastUsedAt } : {}), ...(grokBot ? { grokBot: true } : {}) };
      }),
    };
  };
  // Every hook and team change reaches it: tell everyone at most a few times a second, and only what changed.
  let missionSent = '';
  let missionTimer: NodeJS.Timeout | undefined;
  const missionChanged = () => {
    missionTimer ??= setTimeout(() => {
      missionTimer = undefined;
      const state = missionState();
      const json = JSON.stringify(state);
      if (json === missionSent) return;
      missionSent = json;
      broadcast({ t: 'missionControl', state });
    }, 150);
  };
  // The office's one Linear workspace, which every floor's team, autopilot and the workers' linear_* tools go through (docs/linear.md).
  const linear = new LinearOffice(cfg.dataDir, fetch, () => linearConnectionChanged());
  const officeMcpFloor = (id: string) => {
    const floor = workerFloor(id);
    return floor ? { id: floor.id, name: floor.def.name, dir: floor.dir, workers: floor.workers, team: floor.team, visits: floor.visits, whiteboard: floor.whiteboard, linear: floor.linear } : undefined;
  };
  // ownerOffice is declared with the message handler below; nothing calls it before the office is serving.
  const ownerBridge: OwnerOffice = {
    floors: () => ownerOffice.floors(),
    mission: () => ownerOffice.mission(),
    tail: (...a) => ownerOffice.tail(...a),
    inspect: (...a) => ownerOffice.inspect?.(...a),
    labelsOn: () => ownerOffice.labelsOn?.() ?? true,
    workerMeta: (id) => ownerOffice.workerMeta?.(id),
    threadImages: (...a) => (ownerOffice.threadImages ? ownerOffice.threadImages(...a) : Promise.resolve([])),
    act: (...a) => ownerOffice.act(...a),
  };
  orchestrator.workers.setSharedImages(remoteOffice.images);
  const geminiStore = new GeminiDecisionsStore(cfg.dataDir);
  let isAirgapped = () => false;
  let wakeTelemetryTimer: NodeJS.Timeout | undefined;
  // With the gate off, nothing would ever route a held batch again.
  const flushWakeHolds = () => {
    for (const f of floors.values()) f.team.flushHolds();
  };
  // The inter-agent noise gate (docs/office-mcp.md#inter-agent-noise-gate): routes team traffic, failing open.
  const wakeFilter = new WakeFilter({
    store: geminiStore,
    airgapped: () => isAirgapped(),
    onChange: () => {
      wakeTelemetryTimer ??= setTimeout(() => {
        wakeTelemetryTimer = undefined;
        broadcast({ t: 'gemini', state: officeVibes.geminiState() });
      }, 400);
      wakeTelemetryTimer.unref?.();
    },
  });
  officeMcp = createOfficeMcp({
    wakeFilter,
    hookUrl,
    deepLinkBase,
    answers,
    settings: () => subagents.settings,
    floor: officeMcpFloor,
    remote: remoteOffice,
    images: remoteOffice.images,
    owner: ownerBridge,
    linear,
    orchestrator: { authenticate: (id, token) => orchestrator.authenticate(id, token), cwd: orchestrator.cwd },
  });
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

  // The office's one Jira Cloud account, which every floor's epic board reads through (⚙️ Settings).
  const jira = new JiraOffice(cfg.dataDir);
  // The office's Factory API key and every Factory feature read with it (⚙️ Settings → Connections, docs/factory.md).
  // AutoWiki's /wiki runs on a floor's default branch with the office's Droid command (factory/wiki-run.ts).
  const factory = mountFactory({
    paused: readSetupFile(cfg.dataDir)?.airgapped,
    dataDir: cfg.dataDir,
    broadcast: (state) => broadcast({ t: 'factory', state }),
    toast: (text, level) => toastAll(text, level),
    hostedWorkers: () => {
      const models = droidModels.peek() ?? readDroidModels();
      const settings = readDroidModels();
      const workers = [...floors.values()].flatMap((f) => f.everyone()).concat(orchestrator.workers.list());
      return workers.some((w) => {
        if (w.kind !== 'agent' || (w.status !== 'working' && w.status !== 'starting')) return false;
        const id = w.activeModel ?? w.model ?? models.defaultModel;
        if (!id) return false;
        const descriptor = settings.models.find((m) => m.id === id && m.custom) ?? models.models.find((m) => m.id === id) ?? { id };
        return !!factoryModelTier(descriptor);
      });
    },
    // Cloud workers: their Droid session runs on a Factory computer (factory/cloud.ts, cloud-workers.ts).
    cloud: {
      floors: () =>
        [...floors.values()].map((f) => ({
          id: f.id,
          name: f.def.name,
          repo: f.def.repo,
          branch: () => (f.plain ? undefined : f.workers.baseBranch),
          cloud: f.cloud,
          unstage: (ids: readonly string[]) => f.workers.unstage(ids),
        })),
      agentArgs: cfg.agentArgs,
      modelName: (id) => droidModels.peek()?.models.find((m) => m.id === id)?.displayName,
      toast: (floorId, text, level) => toastFloor(floors.get(floorId), text, level),
      prompt: (id, vars) => officePrompt(prompts, id, vars),
    },
    // Every floor's workers (desk and cloud) with a session, so each shows what it has cost.
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
  const labelPreferences = new WorkerLabelPreferences(cfg.dataDir);
  let labelSettingsRevision = 0;
  const labelThreads = new WorkerThreadReader(undefined, { sessions: 500, entries: 0, bytes: 0 }, true);
  const labelModel = new WorkerLabelModel({
    droid: () => agentPath,
    key: () => factory.office.key(),
    endpointApiKey: (settings) => (sameEndpointOrigin(labelPreferences.get().baseUrl, settings.baseUrl) ? labelPreferences.apiKey() : undefined),
    system: () => officePrompt(prompts, 'office.namer'),
  });
  const workerLabels = new WorkerLabels({
    settings: () => labelPreferences.get(),
    workers: () =>
      [...floors.values()].flatMap((floor) =>
        floor.workers.list().flatMap((worker) => {
          const source = floor.workers.labelSession(worker.id);
          if (!source) return [];
          return [
            {
              ...source,
              id: `${floor.id}:${worker.id}`,
              status: worker.status,
              task: worker.task,
              apply: (task) => {
                const current = floor.workers.labelSession(worker.id);
                if (current && current.sessionId === source.sessionId && current.cwd === source.cwd && current.epoch === source.epoch && current.since === source.since) floor.workers.setTask(worker.id, task);
              },
            },
          ];
        }),
      ),
    read: (source) => labelThreads.readText(source),
    generate: (input, settings, signal) => {
      if (setup.state().airgapped && settings.implementation !== 'openai') return Promise.reject(new Error(AIRGAPPED_REASON));
      return labelModel.generate(input, settings, signal);
    },
    changed: (state) => broadcast({ t: 'workerLabels', state }),
  });

  const vibesFloorView = (f: Floor): VibesFloorView => ({
    id: f.id,
    name: f.def.name,
    workers: f.everyone(),
    pulls: f.board.pulls.items,
    pipelines: f.pipelines.state,
    tail: (workerId, lines) => f.workers.tail(workerId, lines),
  });
  const officeVibes = new OfficeVibes({
    store: geminiStore,
    airgapped: () => isAirgapped(),
    clients: () => clients.values(),
    floors: () => [...floors.values()].map(vibesFloorView),
    floor: (id) => {
      const f = floors.get(id);
      return f ? vibesFloorView(f) : undefined;
    },
    broadcastGemini: (state) => broadcast({ t: 'gemini', state }),
    wakeTelemetry: () => wakeFilter.telemetry(),
    emitFloorVibes: (floorId, state) => {
      const f = floors.get(floorId);
      if (f) toFloor(f, { t: 'vibes', state });
    },
  });

  // Droid installed and signed in, and the welcome a fresh office opens with (docs/subscriptions.md).
  const setup = mountSetup({
    dataDir: cfg.dataDir,
    agentCmd: cfg.agentCmd,
    customModels: () =>
      readDroidModels()
        .models.filter((m) => m.custom && !cannotRun(subscriptions.availability(m.id)))
        .map((m) => m.id),
    modeChanged: (on) => {
      factory.setPaused(on);
      droidModels.forget();
      workerLabels.settingsChanged();
      officeVibes.syncViewers(!on);
      if (on) flushWakeHolds();
    },
    broadcast: (state) => {
      broadcast({ t: 'setup', state });
      missionChanged();
    },
    toast: (text, level) => toastAll(text, level),
    agentChanged: (file) => {
      agentPath = file;
      droidModels.forget();
      droidCommands.forget();
      for (const f of floors.values()) f.workers.setAgentPath(file);
      orchestrator.workers.setAgentPath(file);
      missionChanged();
    },
  });
  // DroidProxy, and the Claude, ChatGPT and other subscriptions workers run on through it.
  const subscriptions = mountSubscriptions({
    dataDir: cfg.dataDir,
    broadcast: (state) => {
      broadcast({ t: 'subscriptions', state });
      missionChanged();
    },
    toast: (text, level) => toastAll(text, level),
    modelsChanged: () => {
      droidModels.forget();
      setup.message('office', { t: 'setup.check' });
      missionChanged();
    },
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
    building: buildingAgents,
    agentCmd: cfg.agentCmd,
    agentArgs: cfg.agentArgs,
    hook: { url: `http://127.0.0.1:${hookPort}`, token: '' },
    capacity: machine,
    jira,
    linear,
    linearHire: async (floor, prompt, identifier, model) => {
      // Through the owner's own handler, as the Linear tab's Hand to a worker would hire, named for autopilot.
      const r = await ownerOffice.act(LINEAR_AUTOPILOT, { t: 'worker.spawn', deskId: AUTO_DESK, prompt, worktree: !floor.plain, linear: identifier, ...(model ? { model } : {}) }, { floor: floor.id, owner: true });
      return r.error ? { error: r.error } : { workerId: r.workerId };
    },
    prompts,
    emit: toFloor,
    toast: toastFloor,
    termData,
    changes: (state, ids) => {
      for (const id of ids) {
        const c = clients.get(id);
        if (c) sendTo(c, { t: 'changes', state });
      }
    },
    workerChanged: (floor, w) => {
      answers.changed(typeof w === 'string' ? w : w.id, typeof w === 'string' ? undefined : w.status);
      if (typeof w === 'string' || w.status !== 'needs_input') clearOffFloorThrottle(typeof w === 'string' ? w : w.id);
      if (floors.get(floor.id) === floor) {
        if (typeof w === 'string') broadcast({ t: 'building.remove', floor: floor.id, workerId: w });
        else {
          broadcast({ t: 'building.worker', floor: floor.id, worker: w });
          if (w.status === 'needs_input') broadcastOffFloorScreen(floor, w.id);
        }
      }
      // A building lead's held batch may span floors: a teammate settling here can complete it there.
      if (typeof w !== 'string' && w.lead) for (const f of floors.values()) if (f !== floor) f.team.recheckHolds(w.lead);
      // Counted now rather than when the floor list next goes out, so a worker hired and gone within it still counts.
      if (floors.get(floor.id) === floor)
        floorActivity.observe(
          floor.id,
          floor.everyone().map((x) => x.id),
        );
      machine.workersChanged();
      floorsChanged();
      missionChanged();
    },
    offFloorScreen: broadcastOffFloorScreen,
    connections: (floor) => {
      let n = 0;
      for (const c of clients.values()) if (c.floor === floor.id) n++;
      return n;
    },
    leaveOnMerge: () => leaveOnMerge.on,
    freshMain: () => freshMain.on,
    subagents: () => subagents.settings,
    droidModels: availableDroidModels,
    modelGate,
    modelAvailability: (model) => subscriptions.availability(model),
    modelUsage: (model, now) => subscriptions.usage(model, now),
    recheckModels: () => subscriptions.recheck(),
    factory: () => factory.state(),
    recheckFactoryLimits: () => factory.recheckLimits(),
    workerLabelsOn: () => labelPreferences.get().on,
    floor: (id) => floors.get(id),
    liveDeskElsewhere: (floor, deskId) => {
      for (const other of floors.values()) {
        if (other === floor) continue;
        const holder = other.everyone().find((w) => w.deskId === deskId && !w.remote && !isAsleep(w.status));
        if (holder) return { worker: holder, floorName: other.def.name };
      }
      return undefined;
    },
    liveNamesElsewhere: (floor) => {
      const names: string[] = [];
      for (const other of floors.values()) {
        if (other === floor) continue;
        for (const w of other.everyone()) if (!isAsleep(w.status)) names.push(w.name);
      }
      const orch = orchestrator.rosterAgent()?.worker;
      if (orch) names.push(orch.name);
      for (const bot of remoteWorkers.list()) names.push(bot.name);
      return names;
    },
    allNamesElsewhere: (floor) => {
      const names: string[] = [];
      for (const other of floors.values()) {
        if (other === floor) continue;
        for (const w of other.everyone()) names.push(w.name);
      }
      const orch = orchestrator.rosterAgent()?.worker;
      if (orch) names.push(orch.name);
      for (const bot of remoteWorkers.list()) names.push(bot.name);
      return names;
    },
    pullsChanged: (floor) => {
      if (floors.get(floor.id) === floor) broadcast({ t: 'building.pulls', floor: floor.id, pulls: floor.board.pulls.items });
      for (const f of floors.values()) if (f !== floor && worksIn(f, floor)) f.sendLandedHome();
    },
    lent: (floor) => [...floors.values()].some((f) => f !== floor && worksIn(f, floor)),
    renderer,
    sharedImages: remoteOffice.images,
    wakeFilter,
    leadView: (lead) => {
      if (lead === ORCHESTRATOR_ID) {
        const w = orchestrator.workers.get(lead);
        const steps = orchestrator.workers.runtime(lead)?.todoSteps;
        return {
          name: w?.name ?? 'Orchestrator',
          building: true,
          ...(w?.status ? { status: w.status } : {}),
          ...(w?.task ? { task: `${w.task.name}: ${w.task.summary}` } : {}),
          ...(steps?.length ? { steps: steps.map((s) => ({ content: s.content, status: s.status })) } : {}),
          ...(w ? { tail: orchestrator.workers.tail(lead, 30) } : {}),
        };
      }
      const bot = remoteWorkers.identity(lead);
      return bot ? { name: bot.name, building: true, status: remoteWorkers.isGrokBot(lead) ? 'remote Grok Bot (woken by webhook push)' : 'remote bot (reads its office_inbox)' } : undefined;
    },
    teammatesElsewhere: (floor, lead, rich) => [...floors.values()].filter((f) => f !== floor).flatMap((f) => f.team.localTeammates(lead, rich).map((t) => ({ ...t, floor: f.def.name }))),
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
      remoteOffice.syncWatches();
      for (const worker of floor.everyone()) {
        broadcast({ t: 'building.worker', floor: floor.id, worker });
        if (worker.status === 'needs_input') broadcastOffFloorScreen(floor, worker.id);
      }
      if (floor.board.pulls.items.length) broadcast({ t: 'building.pulls', floor: floor.id, pulls: floor.board.pulls.items });
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
  // After the floors, so its team's news can wake it as it comes back.
  await orchestrator.start();
  if (cfg.remoteMcp) {
    remoteMcp = new RemoteMcp({
      dataDir: cfg.dataDir,
      office: remoteOffice,
      mcp: {
        deepLinkBase,
        answers,
        images: remoteOffice.images,
        owner: ownerBridge,
        settings: () => subagents.settings,
        floor: officeMcpFloor,
      },
    });
    // Tailscale may be slow or missing: the office opens without waiting, and Settings shows how it went.
    void remoteMcp.start();
  }

  /** Everything on a floor, for whoever just arrived there. */
  isAirgapped = () => Boolean(setup.state().airgapped);
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
    linear: floor?.linear.state() ?? { connection: linear.connection(), autopilot: DEFAULT_AUTOPILOT, working: 0 },
    linearBoard: floor?.linear.board ?? null,
    ...(floor ? { vibes: officeVibes.floorState(floor.id) } : {}),
  });
  /** The roof: nobody works up there, so it has none of a floor's things. */
  const roofView = (): FloorView => ({ ...floorView(undefined), floor: ROOF });
  const buildingRoster = () => [...floors.values()].map((f) => ({ floor: f.id, workers: f.everyone(), pulls: f.board.pulls.items }));
  const screensOf = (c: Client, floor: Floor | undefined) => {
    const frames = [...(floor?.workers.fullScreens() ?? []), ...(floor?.cloud.fullScreens() ?? []), ...orchestrator.workers.fullScreens()];
    const shell = floor?.shell.fullScreen();
    if (shell) frames.push({ workerId: OFFICE_SHELL_ID, frame: shell });
    for (const f of floors.values()) {
      if (f === floor) continue;
      for (const w of f.workers.list()) {
        if (w.status !== 'needs_input') continue;
        const frame = f.workers.fullScreen(w.id);
        if (frame) frames.push({ workerId: w.id, frame });
      }
    }
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
  const staticFiles = createStaticFiles(hotReload);
  const accessRuntime = createAccess({ cfg, lanToken, devices, tailscale, companion, clients, version: upgrader.version, address: () => server.address() });
  const { access, pairingState } = accessRuntime;

  const automation = createAutomation(clients, sendTo);
  const automationRequest = automation.request;

  const { serveCard, whiteboardRequest, sendBoard, applyBoard, pingWorker } = createWhiteboardRuntime({ floors, prompts, sendTo, warn });

  const floorRequest = createFloorHttp({ floors, orchestrator, workerFloor, workerThreads, factory, setup, whiteboardRequest });
  const handler = createHttpHandler({
    cfg,
    lanToken,
    devices,
    companion,
    clients,
    floors,
    orchestrator,
    missionState,
    deepLinkBase,
    toastAll,
    hostUpdates,
    automationRequest,
    trackpadHaptics,
    hotReload,
    reloadScript,
    availableDroidModels,
    droidCommands,
    workersOf,
    images,
    serveCard,
    floorRequest,
    remoteMcp: () => remoteMcp,
    ...accessRuntime,
    ...staticFiles,
  });

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
    if (floor) floorActivity.visited(floor.id);

    sendTo(client, {
      t: 'welcome',
      connection: id,
      arrival,
      floors: floorInfos(),
      projectsDir: building.projectsDirState(),
      version: upgrader.version,
      upgrade: upgrader.state,
      machine: machine.state(),
      sky: sky.state,
      jukebox: jukebox.state(),
      leaveOnMerge: leaveOnMerge.state(),
      freshMain: freshMain.state(),
      subagents: subagents.state(),
      hiddenModels: hiddenModels.state(),
      workerLabels: workerLabels.state(),
      workerAnswerMultiSelect: true,
      prompts: prompts.state(),
      factory: factory.state(),
      gemini: officeVibes.geminiState(),
      setup: setup.state(),
      subscriptions: subscriptions.state(),
      missionControl: missionState(),
      building: buildingRoster(),
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
      for (const r of client.phoneSizes?.restores((wid) => workersOf(wid)?.get(wid)) ?? []) workersOf(r.workerId)?.resize(r.workerId, r.size.cols, r.size.rows);
      orchestrator.workers.detachAll(id);
      automation.disconnect(id);
      for (const f of floors.values()) {
        f.workers.detachAll(id);
        f.shell.detach(id);
        f.cloud.detachAll(id);
        f.changes.unwatchAll(id);
      }
      factory.drop(id);
      officeVibes.dropClient(id);
      floorsChanged();
    });
    ws.on('error', () => ws.terminate());
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
    officeVibes.syncViewers(true);
    floorsChanged();
  };

  /** Up to the roof, by elevator. */
  const goToRoof = (c: Client) => {
    if (c.floor === ROOF) return;
    const left = leave(c);
    c.floor = ROOF;
    const spot = left.spot;
    sendTo(c, { t: 'floor.enter', arrival: { floor: ROOF, at: { x: spot.x, y: spot.y, z: spot.z, rotY: spot.rotY }, via: 'elevator' }, ...roofView() });
    officeVibes.syncViewers(false);
    floorsChanged();
  };

  /** Out to the lobby, where the elevator has nowhere to go: the building's last floor was taken off. */
  const toLobby = (c: Client) => {
    leave(c);
    c.floor = null;
    sendTo(c, { t: 'floor.enter', arrival: { floor: null, via: 'lobby' }, ...floorView(undefined) });
    officeVibes.syncViewers(false);
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
    floorActivity.forget(floor.id);
    officeVibes.dropFloor(floor.id);
    remoteOffice.syncWatches();
    floor.shutdown();
    floorsChanged();
    missionChanged();
  };

  /** Off the floor (or the roof) `c` was on, to `at` on the next one, or into its elevator car. */
  const leave = (c: Client, at?: { x: number; y: number; z: number; rotY: number }) => {
    const was = floorOf(c);
    if (was) {
      was.workers.detachAll(c.id);
      was.shell.detach(c.id);
      was.cloud.detachAll(c.id);
      was.changes.unwatchAll(c.id);
    }
    leaveFloorTerminals(c);
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

  /**
   * A worker took on a Linear ticket (Hand to a worker on the Linear tab, or autopilot's hire): it's
   * linked to the worker and moved to In Progress (see FloorLinear.take).
   */
  const takeLinear = (c: Client, floor: Floor, ref: string, w: { id: string; name: string }, auto: boolean) => {
    void floor.linear.take(ref, w, { auto }).then(({ ticket, error }) => {
      if (error) return warn(c, `Couldn't hand ${ref} to ${w.name} in Linear: ${error}`);
      if (ticket) toastFloor(floor, `◆ ${w.name} took ${ticket.identifier} in Linear: ${ticket.title}`);
    });
  };

  /** Every floor's Linear tab starts over with the office's new connection (or none), or its new list of teams. */
  function linearConnectionChanged() {
    for (const f of floors.values()) void f.linear.connectionChanged();
  }

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

  /** Opens a worker's terminal for `c`. */
  const attachTerminal = (wid: string, c: Client) => workersOf(wid)?.attach(wid, c.id);

  const handleBoardCommand = createBoardCommands({ floorOf, sendTo, toastFloor });

  const handleMessage = (c: Client, msg: ClientMsg) => {
    const who = c.peer.name;
    const requestId = str(msg.requestId, 64);
    let finished = false;
    // An awaited action calls done() from a later callback. Do not complete the receipt at the end of this turn.
    let pending = false;
    const done = (error?: string, workerId?: string, note?: string) => {
      if (!requestId || finished) return;
      finished = true;
      sendTo(c, { t: 'action.result', requestId, ok: !error, ...(error ? { error } : {}), ...(workerId ? { workerId } : {}), ...(note ? { note } : {}) });
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
    /** A request id is a receipt request. Sync handlers that did not answer, and actions the companion does not await, still close the receipt so the client does not wait out its timeout. */
    const unanswered = () => {
      if (pending || finished) return;
      // A handler that neither answered nor warned may have done nothing at all (an unknown id it ignores).
      if (c.owner && !c.owner.refused) c.owner.unconfirmed = true;
      done(c.owner ? c.owner.refused : 'This action was not confirmed. Check the office before trying again; it was not replayed.');
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
    const asked = (msg as { workerId?: unknown }).workerId;
    const crossFloorWorkerAction = (msg.t === 'worker.answer' || msg.t === 'worker.fork' || msg.t === 'worker.kill') && typeof asked === 'string' && asked !== ORCHESTRATOR_ID;
    const targetFloor = typeof asked === 'string' && asked !== ORCHESTRATOR_ID ? (workerFloor(asked) ?? floors.get(cloud.find(asked)?.floor.id ?? '')) : undefined;
    if (crossFloorWorkerAction) {
      if (msg.requestFloor) {
        if (!floors.has(msg.requestFloor)) return done('The active floor changed. Nothing was sent.');
        if (targetFloor && msg.requestFloor !== targetFloor.id) return done('That worker is not on that floor. Nothing was sent.');
      } else if (requestId && targetFloor && targetFloor.id !== c.floor) {
        return done('That worker is not on the active floor. Nothing was sent.');
      }
    } else {
      if (msg.requestFloor && msg.requestFloor !== c.floor) return done('The active floor changed. Nothing was sent.');
      if (requestId && targetFloor && targetFloor.id !== c.floor) {
        return done('That worker is not on the active floor. Nothing was sent.');
      }
    }
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
    const promptOrchestrator = (m: { prompt: string; images?: string[]; queue?: boolean }) => {
      const images = imageIds(m.images);
      const at = floorOf(c);
      const err = orchestrator.prompt(str(m.prompt, 20000), images, m.queue === true, at && { name: at.def.name, dir: at.dir });
      orchestrator.workers.unstage(images);
      warn(c, err);
      done(err, ORCHESTRATOR_ID);
    };
    const interruptOrchestrator = () => done(orchestrator.interrupt() ? undefined : 'The Orchestrator isn’t in the middle of a turn. Nothing was stopped.');
    // The Orchestrator is in Mission Control on every floor: its terminal, thread and turn are reachable from any.
    if (asked === ORCHESTRATOR_ID && /^(worker|term|thread|changes)\./.test(msg.t)) {
      const orch = orchestrator.workers;
      switch (msg.t) {
        case 'worker.attach': {
          const snap = orch.attach(ORCHESTRATOR_ID, c.id);
          if (!snap) return done('The Orchestrator has no terminal yet. Send it a prompt first.');
          c.attached.add(ORCHESTRATOR_ID);
          sendTo(c, { t: 'term.snapshot', workerId: ORCHESTRATOR_ID, ...snap });
          return done();
        }
        case 'worker.detach':
          c.attached.delete(ORCHESTRATOR_ID);
          orch.detach(ORCHESTRATOR_ID, c.id);
          return done();
        case 'worker.prompt':
          return promptOrchestrator(msg);
        case 'worker.interrupt':
          return interruptOrchestrator();
        case 'worker.answer': {
          const hasChoice = typeof msg.choice === 'number';
          const hasChoices = Array.isArray(msg.choices);
          const hasText = typeof msg.text === 'string';
          if (msg.choices !== undefined && !hasChoices) return done('Send checkbox selections as numbered choices.');
          if (hasChoice ? hasChoices || hasText : !hasChoices && !hasText) return done('Send one choice, a checkbox selection, or a typed answer.');
          defer();
          void answers
            .answer(ORCHESTRATOR_ID, msg.menu, hasChoice ? { choice: msg.choice } : { ...(hasChoices ? { choices: msg.choices } : {}), ...(hasText ? { text: str(msg.text, 20000) } : {}) }, {
              worker: () => orch.get(ORCHESTRATOR_ID),
              lines: () => orch.screenLines(ORCHESTRATOR_ID),
              menu: () => orch.screenMenu(ORCHESTRATOR_ID),
              write: (data) => orch.write(ORCHESTRATOR_ID, data),
              live: () => c.ws.readyState === WebSocket.OPEN,
            })
            .then(
              (error) => done(error, ORCHESTRATOR_ID),
              () => done('The answer could not be verified. Check the terminal.'),
            );
          return;
        }
        case 'term.input':
          if (!c.attached.has(ORCHESTRATOR_ID)) return done('Open the Orchestrator first. Nothing was typed.');
          return done(orch.write(ORCHESTRATOR_ID, str(msg.data, 64 * 1024)) ? undefined : 'The Orchestrator is not running. Nothing was typed.');
        case 'term.resize': {
          const before = orch.get(ORCHESTRATOR_ID);
          if (!c.attached.has(ORCHESTRATOR_ID) || !before) return unanswered();
          const size = { cols: before.cols, rows: before.rows };
          orch.resize(ORCHESTRATOR_ID, num(msg.cols), num(msg.rows));
          const after = orch.get(ORCHESTRATOR_ID);
          if (after) c.phoneSizes?.resized(ORCHESTRATOR_ID, size, after);
          return unanswered();
        }
        case 'thread.read': {
          const request = str(msg.request, 128);
          const before = typeof msg.before === 'number' ? msg.before : undefined;
          const reply = { t: 'thread.snapshot' as const, workerId: ORCHESTRATOR_ID, request, ...(before !== undefined ? { before } : {}) };
          const none = (error: string) => sendTo(c, { ...reply, entries: [], hasMore: false, error });
          const source = orch.threadSession(ORCHESTRATOR_ID);
          if (msg.before !== undefined && (before === undefined || !Number.isSafeInteger(before) || before < 0)) none('Invalid conversation page.');
          else if (!source) none('The Orchestrator has no conversation yet.');
          else
            void workerThreads.read(source, before, orch.threadBusy(ORCHESTRATOR_ID)).then((page) => {
              if (orch.threadSession(ORCHESTRATOR_ID)?.sessionId !== source.sessionId) return none('The Orchestrator’s conversation changed. Read the thread again.');
              sendTo(c, { ...reply, ...page });
            });
          return unanswered();
        }
        default:
          return done('The Orchestrator works from Mission Control: it has no desk, worktree or changes of its own.');
      }
    }
    // A cloud worker's session runs on a Factory computer: factory/cloud.ts answers for it.
    const cloudie = typeof asked === 'string' && /^(worker|term|changes)\./.test(msg.t) ? cloud.find(asked) : undefined;
    if (cloudie) {
      if (setup.state().airgapped) return done(AIRGAPPED_REASON);
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
        else {
          floorActivity.visited(floor.id);
          goToFloor(c, floor, arrivalSpot(msg.at));
          floorsChanged();
        }
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
        if (typeof r === 'string') {
          sendTo(c, { t: 'floor.added', dir, error: r });
          return done(r);
        }
        const floor = openFloor(r);
        if (!floor) {
          const error = `Added ${r.name}, but couldn't open its floor — see the office's log`;
          floorsChanged();
          sendTo(c, { t: 'floor.added', dir, error });
          return done(error);
        }
        // Publish the updated floor list before floor.added, so switching to the new floor sees it in store.floors immediately.
        publishFloors();
        console.log(`  ${who} added a floor for ${r.repo ?? r.name} (${r.dir})`);
        toastAll(`🛗 New floor: ${r.name}, added by ${who}`);
        sendTo(c, { t: 'floor.added', dir, floor: floor.id });
        done();
        break;
      }
      case 'floor.remove': {
        const id = str(msg.floor, 64);
        const r = building.remove(id, who);
        if (typeof r === 'string') return stop(r);
        console.log(`  ${who} took the ${r.name} floor off the building (${r.dir} stays where it is)`);
        const floor = floors.get(id);
        if (floor) closeFloor(floor, who);
        else publishFloors();
        done();
        break;
      }
      case 'floor.projectsDir': {
        const err = building.setProjectsDir(str(msg.dir, 1024), who);
        if (err) return stop(err);
        const state = building.projectsDirState();
        broadcast({ t: 'projectsDir', state });
        toastAll(state.custom ? `📁 ${who} moved the workspace folder to ${state.dir}` : `📁 ${who} put the workspace folder back to ${state.dir}`);
        done();
        break;
      }
      case 'worker.spawn': {
        const images = imageIds(msg.images);
        const floor = here();
        if (!floor) break;
        const kind = msg.kind === 'shell' ? 'shell' : 'agent';
        const model = msg.model === undefined ? undefined : str(msg.model, MODEL_MAX + 1);
        const effort = isAgentEffort(msg.effort) ? msg.effort : undefined;
        // On a Factory computer (factory/cloud.ts). A hire that fails leaves its pictures staged, as the hire route does.
        const where = msg.cloud && typeof msg.cloud === 'object' ? msg.cloud : undefined;
        if (where) {
          if (setup.state().airgapped) return refuse(AIRGAPPED_REASON);
          if (kind === 'shell') return refuse('A shell runs on this machine: only a Droid can work on a Factory computer');
          const wanted = str(msg.deskId, 32);
          const deskId = wanted === AUTO_DESK ? floor.workers.pickSeat(nextFreeSeat)?.id : wanted;
          if (!deskId) return refuse('Every desk and bean bag on this floor is taken');
          defer();
          const body = { floor: floor.id, deskId, computerId: where.computerId, environmentId: where.environmentId, cwd: where.cwd, prompt: msg.prompt, model, effort, images };
          void cloud.hire(body, who).then((r) => (typeof r === 'string' ? refuse(r) : done(undefined, r.id)));
          break;
        }
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
          const deskId = wanted === AUTO_DESK ? floor.workers.pickSeat(nextFreeSeat)?.id : wanted;
          if (!deskId) {
            floor.workers.unstage(images);
            return refuse('Every desk and bean bag on this floor is taken');
          }
          const r = floor.workers.spawn(deskId, who, str(msg.prompt, 20000) || undefined, msg.worktree === true, kind, model, effort, repos, undefined, images);
          floor.workers.unstage(images);
          const issue = kind === 'agent' ? issueNumber(msg.issue) : undefined;
          const ticket = kind === 'agent' ? linearIssueRef(msg.linear) : undefined;
          const across = repos.length ? ` across ${[floor.def.name, ...repos.map((x) => x.name)].join(' + ')}` : '';
          if (typeof r === 'string') refuse(r);
          else
            toastFloor(floor, kind === 'shell' ? `${who} opened a shell at a desk` : `${who} hired ${r.name}${issue ? ` for issue #${issue}` : ticket ? ` for ${ticket}` : r.prompt ? ' with a task' : ''}${kind === 'agent' ? across : ''}`);
          if (typeof r !== 'string') done(undefined, r.id);
          if (typeof r !== 'string' && issue) takeIssue(c, floor, issue);
          if (typeof r !== 'string' && ticket) takeLinear(c, floor, ticket, r, who === AUTOPILOT_NAME);
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
        if ((msg.requestFloor ?? c.floor) !== w.floor.id) return refuse('Take the elevator to that worker’s floor before forking');
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
      case 'worker.shoot': {
        const w = worker(msg.workerId);
        if (!w) break;
        warn(
          c,
          w.floor.team.sendingHome(w.wid, 'owner', () => w.floor.workers.shoot(w.wid, msg.superShot === true)),
        );
        break;
      }
      case 'worker.kill': {
        const w = worker(msg.workerId);
        if (!w) return done('No such worker');
        if ((msg.requestFloor ?? c.floor) !== w.floor.id) return refuse('Take the elevator to that worker’s floor before sending it home');
        const { floor, info } = w;
        // The worker leaves right away; its worktree is dealt with after that, and the outcome follows.
        const cleanup = floor.team.sendingHome(info.id, 'owner', () => floor.workers.kill(info.id, CLEANUPS.has(String(msg.cleanup)) ? msg.cleanup : undefined));
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
        if (msg.queue === true && msg.urgent === true) {
          w?.floor.workers.unstage(images);
          const err = 'Choose either queue: true (after turn) or urgent: true (interrupt and steer now), not both.';
          warn(c, err);
          return done(err, w?.wid);
        }
        const finishPrompt = (target: typeof w, err: string | undefined, infoText?: string, fallbackFloor = w?.floor) => {
          (target?.floor ?? fallbackFloor)?.workers.unstage(images);
          warn(c, err);
          if (!err && infoText) sendTo(c, { t: 'toast', text: infoText, level: 'info' });
          done(err, target?.wid ?? w?.wid);
          const issue = target?.info.kind === 'agent' ? issueNumber(msg.issue) : undefined;
          if (target && !err && issue) {
            toastFloor(target.floor, `${who} handed issue #${issue} to ${target.info.name}`);
            takeIssue(c, target.floor, issue);
          }
          const ticket = target?.info.kind === 'agent' ? linearIssueRef(msg.linear) : undefined;
          if (target && !err && ticket) takeLinear(c, target.floor, ticket, target.info, false);
        };
        if (msg.urgent === true) {
          if (!w) {
            finishPrompt(undefined, 'No such worker');
            break;
          }
          const wid = w.wid;
          const origFloor = w.floor;
          defer();
          void origFloor.workers.urgentPrompt(wid, str(msg.prompt, 20000), images).then(
            (res) => {
              const fresh = worker(wid);
              if (!fresh) return finishPrompt(undefined, res.error ?? 'That worker is no longer on this floor', undefined, origFloor);
              finishPrompt(fresh, res.error, res.interrupted ? `Interrupted ${fresh.info.name}'s running turn and delivered the urgent prompt` : undefined, origFloor);
            },
            () => finishPrompt(worker(wid), 'The urgent prompt could not be delivered.', undefined, origFloor),
          );
          break;
        }
        const blocking = w && msg.queue !== true && w.info.status === 'working' ? w.floor.workers.blockingTool(w.wid) : undefined;
        const err = w ? w.floor.workers.prompt(w.wid, str(msg.prompt, 20000), images, msg.queue === true) : 'No such worker';
        finishPrompt(w, err, blocking && w ? formatBlockingSteerWarning(w.info.name, blocking) : undefined);
        break;
      }
      case 'worker.answer': {
        const w = worker(msg.workerId);
        const expectedFloor = msg.requestFloor ?? c.floor;
        if (!w || expectedFloor !== w.floor.id) return done('That worker is no longer on this floor.');
        const hasChoice = typeof msg.choice === 'number';
        const hasChoices = Array.isArray(msg.choices);
        const hasText = typeof msg.text === 'string';
        if (msg.choices !== undefined && !hasChoices) return done('Send checkbox selections as numbered choices.');
        if (hasChoice ? hasChoices || hasText : !hasChoices && !hasText) return done('Send one choice, a checkbox selection, or a typed answer.');
        defer();
        const lines = () => w.floor.workers.screenLines(w.wid);
        void answers
          .answer(w.wid, msg.menu, hasChoice ? { choice: msg.choice } : { ...(hasChoices ? { choices: msg.choices } : {}), ...(hasText ? { text: str(msg.text, 20000) } : {}) }, {
            worker: () => w.floor.workers.get(w.wid),
            lines,
            menu: () => w.floor.workers.screenMenu(w.wid),
            write: (data) => w.floor.workers.write(w.wid, data),
            live: () => c.ws.readyState === WebSocket.OPEN && floors.get(w.floor.id) === w.floor && (msg.requestFloor ? msg.requestFloor === w.floor.id : c.floor === w.floor.id),
          })
          .then(
            (error) => done(error, w.wid),
            () => done('The answer could not be verified. Check the terminal.'),
          );
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
        const cloudOwner = cloud.find(workerId);
        const floor = workerFloor(workerId) ?? (cloudOwner ? floors.get(cloudOwner.floor.id) : undefined) ?? floorOf(c);
        const source = floor?.workers.threadSession(workerId);
        const reply = { t: 'thread.snapshot' as const, workerId, request, ...(before !== undefined ? { before } : {}) };
        if (msg.before !== undefined && (before === undefined || !Number.isSafeInteger(before) || before < 0)) {
          sendTo(c, { ...reply, entries: [], hasMore: false, error: 'Invalid conversation page.' });
          break;
        }
        // A cloud worker's thread is its Factory session's messages (factory/cloud-thread.ts).
        const remote = floor && cloudOwner?.floor.id === floor.id ? cloud.thread(workerId, before) : undefined;
        if (remote && floor) {
          const sessionId = cloudOwner?.info.sessionId;
          void remote.then((page) => {
            const still = cloud.find(workerId);
            if (floors.get(floor.id) !== floor || still?.info.sessionId !== sessionId) {
              sendTo(c, { ...reply, entries: [], hasMore: false, error: 'The active floor or worker session changed. Read the thread again.' });
              return;
            }
            sendTo(c, { ...reply, ...page });
          });
          break;
        }
        if (!source || !floor) {
          sendTo(c, { ...reply, entries: [], hasMore: false, error: 'Thread is available only for office-owned Droid workers with a session on this floor. Shells have no thread.' });
          break;
        }
        void workerThreads.read(source, before, floor.workers.threadBusy(workerId)).then((page) => {
          const current = floor.workers.threadSession(workerId);
          if (floors.get(floor.id) !== floor || current?.sessionId !== source.sessionId || current.cwd !== source.cwd) {
            sendTo(c, { ...reply, entries: [], hasMore: false, error: 'The active floor or worker session changed. Read the thread again.' });
            return;
          }
          sendTo(c, { ...reply, ...page });
        });
        break;
      }
      case 'worker.interrupt': {
        // Droid's own cancel key. A cloud worker's interrupt is answered by factory/cloud.ts above.
        const w = worker(msg.workerId);
        if (!w) return done('No such worker');
        if (w.info.kind !== 'agent') return done(`${w.info.name} is a shell: there is no turn to stop`);
        if (!w.floor.workers.write(w.wid, '\u001b')) return done(`${w.info.name} is not running. Nothing was stopped.`);
        done();
        break;
      }
      case 'term.input': {
        const f = c.attached.has(msg.workerId) ? workerFloor(msg.workerId) : undefined;
        if (!f) {
          done('Open this worker first. Nothing was typed.');
          break;
        }
        if (!f.workers.write(msg.workerId, str(msg.data, 64 * 1024))) done('This worker is not running. Nothing was typed.');
        else done();
        break;
      }
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
      case 'gh.merge':
      case 'gh.comment':
      case 'gh.close':
      case 'gh.labels':
      case 'pipelines.refresh':
      case 'pipelines.detail':
      case 'pipelines.rerun':
      case 'pipelines.cancel':
      case 'pipelines.run':
        handleBoardCommand(c, msg, here);
        break;
      case 'gong': {
        const floor = floorOf(c);
        const now = Date.now();
        if (!floor || now - c.lastGongAt < 500) break;
        c.lastGongAt = now;
        toFloor(floor, { t: 'gong', why: 'hit', by: who });
        break;
      }
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
      case 'models.hide': {
        const error = hiddenModels.set(msg.id, msg.hidden);
        if (error) return stop(error);
        broadcast({ t: 'models.hidden', ids: hiddenModels.state() });
        done();
        break;
      }
      case 'workerLabels.set': {
        const resolved = labelPreferences.resolve(msg.settings);
        if ('error' in resolved) return stop(resolved.error);
        const next = resolved.settings;
        if (setup.state().airgapped && next.on && next.implementation !== 'openai') return stop(AIRGAPPED_REASON);
        const revision = ++labelSettingsRevision;
        const save = () => {
          if (revision !== labelSettingsRevision) return stop('Worker label settings changed while verifying this selection. Try again.');
          const error = labelPreferences.set(msg.settings);
          if (error) return stop(error);
          workerLabels.settingsChanged();
          done();
        };
        if (!next.on || next.implementation === 'openai') {
          save();
          break;
        }
        defer();
        void droidModels.get().then(
          (catalogue) => {
            const model = catalogue.models.find((m) => m.id === next.model);
            const efforts: readonly string[] = model?.labelReasoningEfforts ?? model?.supportedReasoningEfforts ?? [];
            if (!model || !efforts.includes(next.effort)) return stop('Choose an available label model and one of its supported reasoning efforts.');
            save();
          },
          () => stop('Could not verify the selected label model. Settings are unchanged.'),
        );
        break;
      }
      case 'workerLabels.test': {
        const resolved = labelPreferences.resolve(msg.settings);
        if ('error' in resolved) return stop(resolved.error);
        if (resolved.settings.implementation !== 'openai') return stop('Choose OpenAI-compatible endpoint to test an endpoint.');
        // Guard against racing settings updates: reuse the saved key only if it still matches this origin.
        const keyToSend = msg.settings?.apiKey !== undefined ? resolved.apiKey : sameEndpointOrigin(labelPreferences.get().baseUrl, resolved.settings.baseUrl) ? labelPreferences.apiKey() : undefined;
        defer();
        const startedAt = Date.now();
        void openAiLabel(
          {
            text: 'user: Fix the expired-session redirect loop on /dashboard\n\nassistant: Tracing the auth middleware check that sends expired cookies back to /dashboard instead of /login',
          },
          resolved.settings,
          keyToSend,
          officePrompt(prompts, 'office.namer'),
          AbortSignal.timeout(15_000),
          15_000,
        ).then(
          (task) => done(undefined, undefined, `Connected (${Date.now() - startedAt} ms) · sample label: “${task.name}” — ${task.summary}`),
          (err) => stop(err instanceof LabelModelError ? err.message : 'Endpoint test failed.'),
        );
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
        if (msg.id === 'office.namer') workerLabels.settingsChanged();
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
      case 'linear.connect': {
        void linear.connect(str(msg.key, 300), who).then((error) => {
          sendTo(c, { t: 'linear.setup', step: 'connect', ok: !error, error });
          if (error) return;
          console.log(`  ${who} connected the office to Linear (${linear.connection()?.workspace})`);
          toastAll(`◆ ${who} connected the office to Linear: ${linear.connection()?.workspace}`);
          linearConnectionChanged();
        });
        break;
      }
      case 'linear.disconnect': {
        if (!linear.connection()) break;
        linear.disconnect();
        console.log(`  ${who} disconnected the office from Linear`);
        toastAll(`${who} disconnected the office from Linear`);
        linearConnectionChanged();
        break;
      }
      case 'linear.team': {
        const floor = here();
        if (!floor) break;
        const team = str(msg.team, 100).trim();
        const error = floor.linear.setTeam(team, str(msg.project, 100).trim() || undefined, who);
        sendTo(c, { t: 'linear.setup', step: 'team', ok: !error, error });
        if (error) break;
        const setup = floor.linear.setup;
        toastFloor(floor, setup ? `◆ ${who} put Linear team ${setup.team.name}${setup.project ? ` (${setup.project.name})` : ''} on this floor` : `${who} took Linear off this floor`);
        break;
      }
      case 'linear.autopilot': {
        const floor = here();
        if (!floor) break;
        const was = floor.linear.autopilot.on;
        const change = {
          ...(typeof msg.on === 'boolean' ? { on: msg.on } : {}),
          ...(Array.isArray(msg.pickup) ? { pickup: msg.pickup.slice(0, 8) } : {}),
          ...(typeof msg.max === 'number' ? { max: msg.max } : {}),
          ...(typeof msg.existing === 'boolean' ? { existing: msg.existing } : {}),
          ...(msg.model !== undefined ? { model: str(msg.model, MODEL_MAX) } : {}),
        };
        const error = floor.linear.setAutopilot(change, who);
        sendTo(c, { t: 'linear.setup', step: 'autopilot', ok: !error, error });
        if (!error && was !== floor.linear.autopilot.on)
          toastFloor(floor, floor.linear.autopilot.on ? `🛰️ ${who} turned on Linear autopilot: new ${floor.linear.setup?.team.key} tickets get a worker of their own` : `${who} turned off Linear autopilot`);
        break;
      }
      case 'linear.create': {
        const floor = here();
        if (!floor) break;
        const priority = linearPriority(msg.priority);
        void floor.linear
          .create({ title: str(msg.title, 250), description: str(msg.description, 20_000), ...(priority !== undefined ? { priority } : {}), state: msg.state === 'backlog' ? 'backlog' : 'unstarted' })
          .then((t) => {
            sendTo(c, { t: 'linear.setup', step: 'create', ok: true, identifier: t.identifier });
            console.log(`  ${who} wrote ${t.identifier} in Linear: ${t.title}`);
          })
          .catch((err) => sendTo(c, { t: 'linear.setup', step: 'create', ok: false, error: (err as Error).message }));
        break;
      }
      case 'linear.refresh': {
        void linear.refreshTeams(true);
        void floorOf(c)?.linear.refresh(true);
        break;
      }
      case 'factory.connect':
      case 'factory.disconnect':
      case 'factory.refresh':
      case 'factory.watch':
        factory.message(c.id, who, msg, (reply) => sendTo(c, reply));
        break;
      case 'gemini.connect':
        void officeVibes.connect(str(msg.key, 512), who, (reply) => sendTo(c, reply)).catch(() => sendTo(c, { t: 'gemini.setup', ok: false, error: 'Gemini connection check failed.' }));
        break;
      case 'gemini.disconnect': {
        const err = officeVibes.disconnect();
        if (err) return stop(err);
        flushWakeHolds();
        toastAll(`${who} disconnected Gemini Decisions`);
        done();
        break;
      }
      case 'gemini.check':
        void officeVibes.check((reply) => sendTo(c, reply)).catch(() => sendTo(c, { t: 'gemini.setup', ok: false, error: 'Gemini connection check failed.' }));
        break;
      case 'gemini.vibes': {
        if (typeof msg.on !== 'boolean') return stop('Send {"on": true} or {"on": false}.');
        const err = officeVibes.setVibesOn(msg.on);
        if (err) return stop(err);
        done();
        break;
      }
      case 'gemini.wakeFilter': {
        if (typeof msg.on !== 'boolean') return stop('Send {"on": true} or {"on": false}.');
        const err = officeVibes.setWakeFilterOn(msg.on);
        if (err) return stop(err);
        if (!msg.on) flushWakeHolds();
        done();
        break;
      }
      case 'vibes.watch':
        if (typeof msg.active !== 'boolean') return stop('Send {"active": true} or {"active": false}.');
        if (!c.dashboard) officeVibes.setWatching(c.id, msg.active);
        break;
      case 'setup.check':
        setup.message(who, msg);
        subscriptions.message(who, { t: 'subscriptions.refresh' });
        break;
      case 'setup.droid.install':
      case 'setup.airgapped':
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
      case 'changes.commit':
      case 'changes.discard':
      case 'changes.pr': {
        const w = worker(msg.workerId);
        if (!w) return done('No such worker');
        const changes = w.floor.changes;
        const repo = repoOf(msg.repo);
        defer();
        let change: Promise<string | undefined>;
        if (msg.t === 'changes.commit') change = changes.commit(w.wid, str(msg.message, 5000), who, repo);
        else if (msg.t === 'changes.discard') change = changes.discard(w.wid, typeof msg.path === 'string' ? str(msg.path, 4096) : undefined, who, repo);
        else change = changes.pullRequest(w.wid, str(msg.title, 300), str(msg.body, 20000), who, repo);
        void change.then(
          (err) => (err ? refuse(err) : done(undefined, w.wid)),
          (err: unknown) => refuse(err instanceof Error ? err.message : 'The office could not confirm the change.'),
        );
        break;
      }
      case 'upgrade.check':
        void upgrader.check();
        break;
      case 'upgrade.start':
        defer();
        void upgrader.start(who).then(
          (err) => {
            if (err) return refuse(err);
            toastAll(`${who} is upgrading the office — it restarts when the new version is built`);
            done();
          },
          (err: unknown) => refuse(err instanceof Error ? err.message : 'The upgrade could not start.'),
        );
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
      case 'automation.result':
        automation.answer(c, msg);
        break;
      case 'orchestrator.prompt':
        promptOrchestrator(msg);
        break;
      case 'orchestrator.interrupt':
        interruptOrchestrator();
        break;
      case 'orchestrator.reset':
        orchestrator.reset();
        toastAll(`🛰️ ${who} started a new conversation with the Orchestrator`);
        done();
        break;
      case 'orchestrator.set': {
        const s = (msg.settings ?? {}) as Partial<OrchestratorSettings>;
        if (typeof s.on !== 'boolean') return stop('Send the Orchestrator’s settings: {"on": true}');
        const model = typeof s.model === 'string' && s.model.trim() ? str(s.model.trim(), 128) : undefined;
        const effort = isAgentEffort(s.effort) ? s.effort : undefined;
        const err = orchestrator.set({ on: s.on, ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
        if (err) return stop(err);
        done();
        break;
      }
      case 'ping':
        sendTo(c, { t: 'pong', at: num(msg.at), now: Date.now() });
        break;
    }
    unanswered();
  };

  const ownerOffice = createOwnerOffice({
    floors,
    orchestrator,
    missionState,
    workerFloor,
    workersOf,
    cloud,
    factory,
    subscriptions,
    subagents,
    labelPreferences,
    remoteOffice,
    workerThreads,
    acting,
    handleMessage,
    isCustomModel: (id) => Boolean((droidModels.peek() ?? readDroidModels()).models.find((m) => m.id === id)?.custom || readDroidModels().models.find((m) => m.id === id)?.custom),
  });

  const stopClientTimers = transport.startTimers(attachTerminal, devices);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, () => resolve());
  });
  await hotReload.start();
  workerLabels.start();

  /** With `keep` (a restart), workers' terminals keep running for the next office to pick up. */
  const shutdown = (keep = false) => {
    const labelsStopped = workerLabels.stop();
    hostUpdates.dispose();
    finder?.stop();
    finderToken = undefined;
    stopClientTimers();
    clearTimeout(floorsTimer);
    transport.clearOffFloorScreens();
    upgrader.stop();
    void hotReload.stop().catch((err) => console.error('droid-office: source reload cleanup:', err));
    machine.stop();
    sky.stop();
    factory.stop();
    officeVibes.stop();
    setup.stop();
    subscriptions.stop();
    for (const f of floors.values()) f.shutdown(keep);
    floorActivity.flush();
    orchestrator.shutdown(keep);
    clearTimeout(missionTimer);
    clearTimeout(wakeTelemetryTimer);
    void renderer?.close();
    for (const c of clients.values()) c.ws.close();
    server.close();
    hookServer.close();
    remoteOffice.stop();
    remoteMcp?.stop();
    return labelsStopped;
  };

  if (cfg.finderBridge) {
    finder = new FinderDispatch({
      building,
      dataDir: cfg.dataDir,
      officeUrl: () => `${cfg.tls ? 'https' : 'http'}://127.0.0.1:${(server.address() as AddressInfo).port}/`,
      models: finderModels,
      dispatch: (def, text, model) => {
        const floor = floors.get(def.id) ?? openFloor(def);
        if (!floor) return 'The floor could not be opened. Check the office log.';
        const result = floor.workers.dispatchWorker(text, model);
        if (typeof result === 'string') return result;
        return { leadId: result.info.id, model: result.info.activeModel ?? result.info.model };
      },
      changed: () => {
        // Open newly registered floors immediately so every companion and elevator sees the same registry.
        for (const def of building.list()) if (!floors.has(def.id)) openFloor(def);
        floorsChanged();
      },
    });
    try {
      finderToken = await publishFinder(cfg.finderBridge, `http://127.0.0.1:${hookPort}/`);
    } catch (err) {
      shutdown(true);
      throw err;
    }
  }

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
    owner: ownerOffice,
    projectsDir: () => building.projectsDir,
    resolvedAgent: agentPath,
  };
}

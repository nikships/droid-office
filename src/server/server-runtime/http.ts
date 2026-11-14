import type http from 'node:http';
import type { Config } from '../config.js';
import { serveDeepLinkBounce } from '../deep-links.js';
import { DEEP_LINK_OPEN_PREFIX } from '../../shared/deep-links.js';
import { COMPANION_OFF } from '../../shared/devices.js';
import { lanAllowed } from '../lan.js';
import type { DevicesStore } from '../devices.js';
import type { WebCompanion } from '../web-companion.js';
import { hostUpdateCommand, type HostUpdates } from '../host-updates.js';
import type { HotReload } from '../hot-reload.js';
import { officeStatus } from '../office-status.js';
import { orchestratorNeedsOwner, ORCHESTRATOR_ID, type MissionControlState } from '../../shared/mission-control.js';
import { readGpuStats } from '../gpu-stats.js';
import type { TrackpadHaptics } from '../haptics.js';
import type { Floor } from '../floor.js';
import type { Orchestrator } from '../orchestrator.js';
import type { WorkerManager } from '../workers.js';
import type { RemoteMcp } from '../remote-mcp-http.js';
import type { RemoteMcpState } from '../../shared/remote-mcp.js';
import type { createDroidModelCatalogue } from '../droid-models.js';
import type { createDroidCommandCatalogue } from '../droid-commands.js';
import { resolveSoundCloudStation } from '../soundcloud.js';
import type { ImageProxy } from '../decor.js';
import { CARD_ROUTE } from '../whiteboard.js';
import type { Client } from './client.js';
import type { createAccess } from './access.js';
import type { createAutomation } from './automation.js';
import type { createWhiteboardRuntime } from './whiteboard.js';
import type { createStaticFiles } from './static-files.js';
import { isFloorHttpPath, type createFloorHttp } from './floor-http.js';
import { readBody, sameOrigin, send, statusRequest } from './http-utils.js';
import { str } from './validation.js';

interface HttpContext extends ReturnType<typeof createAccess>, ReturnType<typeof createStaticFiles> {
  cfg: Config;
  lanToken: string;
  devices: DevicesStore;
  companion: WebCompanion;
  clients: Map<string, Client>;
  floors: Map<string, Floor>;
  orchestrator: Orchestrator;
  missionState(): MissionControlState;
  remoteMcp(): RemoteMcp | undefined;
  deepLinkBase(): string | undefined;
  toastAll(text: string): void;
  hostUpdates: HostUpdates;
  automationRequest: ReturnType<typeof createAutomation>['request'];
  trackpadHaptics: TrackpadHaptics;
  hotReload: HotReload;
  reloadScript: string;
  availableDroidModels: ReturnType<typeof createDroidModelCatalogue>['get'];
  droidCommands: ReturnType<typeof createDroidCommandCatalogue>;
  workersOf(id: string): WorkerManager | undefined;
  images: ImageProxy;
  serveCard: ReturnType<typeof createWhiteboardRuntime>['serveCard'];
  floorRequest: ReturnType<typeof createFloorHttp>;
}

/** Ordered public bootstrap, authentication, office-wide APIs, floor APIs, then static fallback. */
export function createHttpHandler(ctx: HttpContext) {
  const {
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
    access,
    ownPage,
    officeCard,
    pairingState,
    setCompanion,
    forgetDevice,
    refuseHttp,
    serveFile,
    publicFile,
    serveIndex,
  } = ctx;
  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
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
      // Android deep links shared in chat (`/open/worker/...`, `/open/floor/...`, `/open/card/...`,
      // `/open/question/...`): zero office state or credentials, redirecting Android browsers into
      // `droidoffice://open/...` with a fallback launch card when uninstalled or on desktop.
      if (p === '/open' || p.startsWith(DEEP_LINK_OPEN_PREFIX)) {
        const scheme = cfg.tls ? 'https' : 'http';
        return serveDeepLinkBounce(req, res, req.url ?? p, scheme, deepLinkBase());
      }
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
      if (p === '/api/host/update') {
        if (req.method !== 'GET' && req.method !== 'POST') return send(res, 405, { error: 'Use GET or POST' });
        if (req.method === 'POST' && !ownRequest()) return send(res, 403, { error: 'Forbidden' });
        let command = hostUpdateCommand(null);
        if (req.method === 'POST') {
          try {
            command = hostUpdateCommand(JSON.parse(await readBody(req, 1024)));
          } catch {
            return send(res, 400, { error: 'Send an update action as JSON.' });
          }
          if (!command) return send(res, 400, { error: 'Use check, or install with the offered version.' });
        }
        try {
          return send(res, 200, await hostUpdates.request(command ?? { action: 'status' }));
        } catch (err) {
          return send(res, 409, { error: (err as Error).message });
        }
      }
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
      // External workers' MCP on the tailnet. Its state holds every bot's credential, so only the office's own page.
      if (p === '/api/remote-mcp') {
        const remoteMcp = ctx.remoteMcp();
        if (gate.device || !ownPage(req)) return send(res, 403, { error: 'External workers are set up from the office itself, on its own computer' });
        if (!remoteMcp) return send(res, 200, { on: false, status: 'off', locked: 'This office was started with DROID_OFFICE_REMOTE_MCP=off.', bots: [] } satisfies RemoteMcpState);
        if (req.method === 'GET') return send(res, 200, await remoteMcp.refresh());
        if (req.method !== 'PUT' && req.method !== 'POST') return send(res, 405, { error: 'Use GET, PUT or POST' });
        let body: Record<string, unknown>;
        try {
          const raw: unknown = JSON.parse(await readBody(req, 8192));
          body = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
        } catch {
          return send(res, 400, { error: 'Send JSON' });
        }
        if (req.method === 'PUT') return typeof body.on === 'boolean' ? send(res, 200, await remoteMcp.set(body.on)) : send(res, 400, { error: 'Send JSON: {"on": true}' });
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const id = typeof body.id === 'string' ? body.id : '';
        const parseGrokArg = (raw: unknown): { webhookUrl: string; webhookToken?: string } | null | undefined => {
          if (raw === undefined) return undefined;
          if (raw === null) return null;
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('grokBot takes null or {webhookUrl, webhookToken}');
          const g = raw as Record<string, unknown>;
          return {
            webhookUrl: typeof g.webhookUrl === 'string' ? g.webhookUrl : '',
            ...(typeof g.webhookToken === 'string' ? { webhookToken: g.webhookToken } : {}),
          };
        };
        try {
          if (body.action === 'add' && name && name.length <= 60) {
            const grokBot = parseGrokArg(body.grokBot);
            if (grokBot === null) return send(res, 400, { error: 'Omit grokBot or pass {webhookUrl, webhookToken} when adding a bot' });
            return send(res, 200, remoteMcp.add(name, grokBot));
          }
          if (body.action === 'set-grok-bot' && id && 'grokBot' in body) {
            const grokBot = parseGrokArg(body.grokBot);
            if (grokBot !== undefined) return send(res, 200, remoteMcp.setGrokBot(id, grokBot));
          }
          if (body.action === 'test-webhook' && id) {
            const { state, result } = await remoteMcp.testWebhook(id);
            return result.ok ? send(res, 200, state) : send(res, 502, { error: result.error ?? 'Webhook test failed', state });
          }
          if (body.action === 'rotate' && id) return send(res, 200, remoteMcp.rotate(id));
          if (body.action === 'revoke' && id) return send(res, 200, remoteMcp.revoke(id));
          if (body.action === 'add-key' && id && name && name.length <= 60) return send(res, 200, remoteMcp.addKey(id, name));
          if (body.action === 'revoke-key' && id && typeof body.key === 'string' && body.key) return send(res, 200, remoteMcp.revokeKey(id, body.key));
        } catch (err) {
          return send(res, 409, { error: (err as Error).message });
        }
        return send(res, 400, {
          error:
            'Send {"action": "add", "name", "grokBot"?}, {"action": "set-grok-bot", "id", "grokBot"}, {"action": "test-webhook", "id"}, {"action": "rotate" | "revoke", "id"}, {"action": "add-key", "id", "name"} or {"action": "revoke-key", "id", "key"}',
        });
      }
      // The Mac app's menu bar icon: busy workers, who is waiting and connected devices. Only the app itself gets them:
      // a request from this Mac, to a loopback host name, with no device token and no Origin.
      if (p === '/api/status' && req.method === 'GET') {
        if (gate.device || !statusRequest(req)) return send(res, 403, { error: 'Forbidden' });
        return send(
          res,
          200,
          officeStatus(
            [...floors.values()].map((f) => ({ id: f.id, name: f.def.name, workers: f.everyone() })),
            [...clients.values()].map((c) => ({ device: c.device, phone: !!c.phoneSizes })),
            orchestratorNeedsOwner(missionState()) ? [orchestrator.info!] : [],
          ),
        );
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
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
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
          const catalogue = await availableDroidModels();
          return send(res, 200, { models: catalogue.models, customOnly: catalogue.customOnly, defaultModel: catalogue.defaultModel, defaultReasoningEffort: catalogue.defaultReasoningEffort });
        } catch {
          return send(res, 502, { error: 'Could not load Droid models' });
        }
      }
      if (p === '/api/agents/droid/commands' && req.method === 'GET') {
        // The skills and custom commands a worker's droid offers as slash commands (droid-commands.ts).
        const workerId = str(url.searchParams.get('worker'), 32);
        // The Orchestrator's folder is there before its first prompt starts a session, and the composer asks at its first "/".
        const folder = workerId === ORCHESTRATOR_ID ? orchestrator.cwd : workerId ? workersOf(workerId)?.agentFolder(workerId) : undefined;
        if (!folder) return send(res, 404, { error: 'No such worker' });
        return send(res, 200, { commands: await droidCommands.get(folder) });
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
      // Await the extracted route so resource failures still use this handler's 500 response.
      if (isFloorHttpPath(p, req.method)) return await floorRequest(req, res, p, url, ownRequest);
      if (p === '/' || p === '/index.html') return serveIndex(res, url.searchParams.get('t'));
      const file = publicFile(p);
      if (file) return serveFile(res, file, false);
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    } catch (err) {
      console.error(err);
      if (!res.headersSent) send(res, 500, { error: 'Internal error' });
    }
  };
}

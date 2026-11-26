// HTTP for external guest sharing (docs/guest-sharing.md): the guest backend's whole request handler,
// and the owner's share-link management API on the main listener.
//
// The guest backend serves an explicit allowlist and nothing else: the companion's static bundle and
// `/dashboard` bootstrap without a token, then `GET /api/guest/hello` and the read routes the companion
// needs for in-scope floors and workers with a share link's token, plus picture uploads and terminal drops
// for write presets, in scope and audited. Every other path answers 404 whether or not it exists elsewhere.

import type http from 'node:http';
import type { Floor } from '../floor.js';
import type { Orchestrator } from '../orchestrator.js';
import type { WorkerManager } from '../workers.js';
import type { createDroidModelCatalogue } from '../droid-models.js';
import type { createDroidCommandCatalogue } from '../droid-commands.js';
import { cardResponse, CARD_ROUTE, type CardResponse } from '../whiteboard.js';
import type { GuestAudit } from '../guest-audit.js';
import type { GuestFunnel } from '../guest-funnel.js';
import { guestTokenOf, type GuestGrant, type GuestLinks } from '../guest-links.js';
import { ORCHESTRATOR_ID } from '../../shared/mission-control.js';
import {
  GUEST_AUDIT_PAGE_MAX,
  GUEST_LINKS_MAX,
  GUEST_UNAVAILABLE_TEXT,
  guestShareUrl,
  type GuestAuditTarget,
  type GuestHello,
  type GuestLinkCreated,
  type GuestLinksState,
  type GuestRefusal,
  type GuestTargetFloor,
  type GuestUnavailableReason,
} from '../../shared/guest-links.js';
import type { createFloorHttp } from './floor-http.js';
import type { createStaticFiles } from './static-files.js';
import { readBody, send } from './http-utils.js';
import { str } from './validation.js';

/** Response headers on everything the guest backend answers itself. */
const GUEST_HEADERS: Record<string, string> = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };

const REFUSAL_STATUS: Record<GuestUnavailableReason, number> = { unavailable: 401, expired: 410, revoked: 410, disabled: 403 };

export function refuseGuest(res: http.ServerResponse, reason: GuestUnavailableReason, retryAfterMs?: number) {
  const body: GuestRefusal = { ok: false, reason, error: GUEST_UNAVAILABLE_TEXT[reason] };
  return send(res, retryAfterMs ? 429 : REFUSAL_STATUS[reason], body, retryAfterMs ? { 'retry-after': String(Math.ceil(retryAfterMs / 1000)) } : {});
}

interface GuestHttpContext extends Pick<ReturnType<typeof createStaticFiles>, 'serveFile' | 'publicFile'> {
  guestLinks: GuestLinks;
  guestAudit: GuestAudit;
  guestFunnel(): GuestFunnel;
  floors: Map<string, Floor>;
  orchestrator: Orchestrator;
  workersOf(id: string): WorkerManager | undefined;
  availableDroidModels: ReturnType<typeof createDroidModelCatalogue>['get'];
  droidCommands: ReturnType<typeof createDroidCommandCatalogue>;
  floorRequest: ReturnType<typeof createFloorHttp>;
}

/** Floor resources a guest may reach, by path: `read` for every preset in scope, `write` only for write presets. */
const GUEST_FLOOR_ROUTES: Record<string, { methods: readonly string[]; write?: readonly string[]; worker: 'required' | 'optional' | 'none' }> = {
  '/api/thread/image': { methods: ['GET'], worker: 'required' },
  '/api/thread/file': { methods: ['GET'], worker: 'required' },
  '/api/thread/files': { methods: [], write: ['GET'], worker: 'required' },
  '/api/term/paths': { methods: ['POST'], worker: 'required' },
  '/api/term/file': { methods: ['GET'], worker: 'required' },
  '/api/changes/file': { methods: ['GET'], worker: 'required' },
  '/api/term/drop': { methods: [], write: ['POST'], worker: 'required' },
  '/api/prompt/image': { methods: [], write: ['POST', 'DELETE'], worker: 'optional' },
  '/api/whiteboard/file': { methods: ['GET'], worker: 'none' },
  '/api/whiteboard/render': { methods: ['GET'], worker: 'none' },
  '/api/whiteboard/render/status': { methods: ['GET'], worker: 'none' },
  '/api/whiteboard/blob': { methods: [], write: ['POST'], worker: 'none' },
  '/api/gh/pull': { methods: ['GET'], worker: 'none' },
  '/api/gh/issue': { methods: ['GET'], worker: 'none' },
  '/api/gh/pull/diff': { methods: ['GET'], worker: 'none' },
  '/api/gh/labels': { methods: [], write: ['GET'], worker: 'none' },
};

/** Static files the companion page loads, served without a token like on every listener. */
function publicGuestPath(p: string): boolean {
  return p.startsWith('/assets/') || p.startsWith('/themes/') || p.startsWith('/icons/') || p.startsWith('/fonts/') || p === '/favicon.svg' || p === '/factory-glyph.svg' || p === '/dashboard.webmanifest';
}

export function createGuestHttp(ctx: GuestHttpContext) {
  const { guestLinks, guestAudit, floors, orchestrator, workersOf, availableDroidModels, droidCommands, floorRequest, serveFile, publicFile } = ctx;

  /** The floor a worker sits on (any worker kind on the floor's roster). */
  const floorOfWorker = (workerId: string): Floor | undefined => {
    for (const f of floors.values()) if (f.everyone().some((w) => w.id === workerId)) return f;
    return undefined;
  };
  const floorInScope = (grant: GuestGrant, floorId: string): boolean => !!floors.get(floorId) && (grant.session.scope === 'office' || floorId === grant.floorId);
  /** Whether a worker (or the Orchestrator) is inside a grant's scope right now. */
  const workerInScope = (grant: GuestGrant, workerId: string): boolean => {
    if (!workerId) return false;
    if (workerId === ORCHESTRATOR_ID) return grant.session.missionControl;
    const floor = floorOfWorker(workerId);
    if (!floor) return false;
    if (grant.session.scope === 'office') return true;
    if (floor.id !== grant.floorId) return false;
    return grant.session.scope === 'floor' || workerId === grant.workerId;
  };
  const auditTarget = (workerId: string, floorId: string | undefined): GuestAuditTarget => {
    if (workerId === ORCHESTRATOR_ID) return { kind: 'missionControl' };
    const floor = (floorId ? floors.get(floorId) : undefined) ?? (workerId ? floorOfWorker(workerId) : undefined);
    const worker = workerId ? floor?.everyone().find((w) => w.id === workerId) : undefined;
    if (worker && floor) return { kind: 'worker', floorId: floor.id, floorName: floor.def.name, workerId: worker.id, workerName: worker.name };
    return { kind: 'floor', ...(floor ? { floorId: floor.id, floorName: floor.def.name } : {}) };
  };

  /** A Whiteboard card's files, only from floors in the grant's scope. Its capability path authenticates it, as everywhere. */
  const serveGuestCard = (req: http.IncomingMessage, res: http.ServerResponse, grant: GuestGrant | undefined, rest: string) => {
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
    if (/^[ks][A-Za-z0-9_-]{20,80}$/.test(cap)) {
      for (const f of floors.values()) {
        if (!guestCardFloor(grant, f.id)) continue;
        if ((out = f.whiteboard.serve(cap, rel, opts))) break;
      }
    }
    out ??= cardResponse(undefined, rel, () => undefined, opts);
    res.writeHead(out.status, out.headers);
    res.end(out.body);
  };
  /**
   * Card frames and their relative assets cannot carry a token, so the capability in the path plus
   * sharing being on is what authenticates them (as on every other listener). A request that does carry
   * a token is held to its scope: a worker-only link sees no Whiteboard.
   */
  const guestCardFloor = (grant: GuestGrant | undefined, floorId: string): boolean => !grant || (grant.session.scope !== 'worker' && floorInScope(grant, floorId));

  /** The guest backend's request listener. */
  const guestRequest = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    for (const [k, v] of Object.entries(GUEST_HEADERS)) res.setHeader(k, v);
    try {
      let url: URL;
      let p: string;
      try {
        url = new URL(req.url ?? '/', 'http://x');
        p = decodeURIComponent(url.pathname);
      } catch {
        return send(res, 400, { error: 'Bad request' });
      }
      if (url.pathname.startsWith(CARD_ROUTE)) {
        if (!guestLinks.on) return refuseGuest(res, 'disabled');
        let grant: GuestGrant | undefined;
        if (guestTokenOf(req, url, true)) {
          const gate = guestLinks.authenticate(req, url, true);
          if (!gate.ok) return refuseGuest(res, gate.reason, gate.retryAfterMs);
          grant = gate.grant;
        }
        return serveGuestCard(req, res, grant, url.pathname.slice(CARD_ROUTE.length));
      }
      res.setHeader('x-frame-options', 'DENY');
      if (publicGuestPath(p)) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Use GET' });
        const file = publicFile(p);
        if (file) return serveFile(res, file, p.startsWith('/assets/') ? true : p.startsWith('/themes/') ? 'revalidate' : false, req);
        return send(res, 404, { error: 'Not found' });
      }
      if (p === '/dashboard' || p === '/dashboard/' || p === '/dashboard.html') {
        const file = publicFile('/dashboard.html');
        if (!file) return send(res, 503, { error: 'This office is updating. Try again in a minute.' });
        return serveFile(res, file, false, req);
      }
      const floorRoute = GUEST_FLOOR_ROUTES[p];
      const known = p === '/api/guest/hello' || p === '/api/agents/droid/models' || p === '/api/agents/droid/commands' || !!floorRoute;
      if (!known) return send(res, 404, { error: 'Not found' });
      const method = req.method ?? 'GET';
      // Embedded pictures (<img src>) cannot send a header, so read-only GETs may carry ?g=.
      const gate = guestLinks.authenticate(req, url, method === 'GET');
      if (!gate.ok) return refuseGuest(res, gate.reason, gate.retryAfterMs);
      const grant = gate.grant;
      const write = grant.session.write;

      if (p === '/api/guest/hello') {
        if (method !== 'GET') return send(res, 405, { error: 'Use GET' });
        return send(res, 200, { ok: true, session: grant.session } satisfies GuestHello);
      }
      if (p === '/api/agents/droid/models') {
        if (method !== 'GET' || !write) return send(res, 404, { error: 'Not found' });
        try {
          const catalogue = await availableDroidModels();
          return send(res, 200, { models: catalogue.models, customOnly: catalogue.customOnly, defaultModel: catalogue.defaultModel, defaultReasoningEffort: catalogue.defaultReasoningEffort });
        } catch {
          return send(res, 502, { error: 'Could not load Droid models' });
        }
      }
      if (p === '/api/agents/droid/commands') {
        if (method !== 'GET' || !write) return send(res, 404, { error: 'Not found' });
        const workerId = str(url.searchParams.get('worker'), 32);
        if (url.searchParams.has('worker')) {
          if (!workerInScope(grant, workerId)) return send(res, 404, { error: 'No such worker' });
          const folder = workerId === ORCHESTRATOR_ID ? orchestrator.cwd : workersOf(workerId)?.agentFolder(workerId);
          if (!folder) return send(res, 404, { error: 'No such worker' });
          return send(res, 200, { commands: await droidCommands.get(folder) });
        }
        const floorId = str(url.searchParams.get('floor'), 64);
        if (!floorInScope(grant, floorId) || grant.session.scope === 'worker') return send(res, 404, { error: 'No such floor' });
        return send(res, 200, { commands: await droidCommands.get(floors.get(floorId)!.dir) });
      }

      // Floor resources: the method must be allowed for this preset, and every floor and worker named must be in scope.
      const route = floorRoute!;
      const allowed = route.methods.includes(method) || (write && (route.write ?? []).includes(method));
      if (!allowed) return send(res, 404, { error: 'Not found' });
      const floorId = url.searchParams.get('floor');
      const workerId = str(url.searchParams.get('worker'), 32);
      const mission = workerId === ORCHESTRATOR_ID;
      if (route.worker === 'required' && !workerInScope(grant, workerId)) return send(res, 404, { error: 'No such worker' });
      if (route.worker === 'optional' && url.searchParams.has('worker') && !workerInScope(grant, workerId)) return send(res, 404, { error: 'No such worker' });
      if (route.worker === 'none' && grant.session.scope === 'worker') return send(res, 404, { error: 'Not found' });
      if (floorId !== null && !floorInScope(grant, floorId)) return send(res, 404, { error: 'No such floor' });
      // A worker route without ?floor= resolves the worker's own floor; one with it must name that floor.
      if (route.worker !== 'none' && !mission && workerId && floorId !== null && floorOfWorker(workerId)?.id !== floorId) return send(res, 404, { error: 'No such worker' });
      if ((route.worker === 'none' || (route.worker === 'optional' && !mission)) && floorId === null) return send(res, 404, { error: 'No such floor' });
      const mutation = method !== 'GET';
      if (mutation && route.write?.includes(method)) {
        const target = auditTarget(workerId, floorId ?? undefined);
        const detail =
          p === '/api/prompt/image'
            ? method === 'DELETE'
              ? 'Removed a picture from a prompt'
              : `Picture for a prompt: ${str(url.searchParams.get('name'), 120) || 'untitled'}`
            : p === '/api/term/drop'
              ? `File into the terminal: ${str(url.searchParams.get('name'), 120) || 'untitled'}`
              : 'File added to the Whiteboard';
        res.once('finish', () => {
          if (res.statusCode < 300) guestAudit.record({ grant, target, action: p === '/api/whiteboard/blob' ? 'whiteboard' : 'upload', detail });
        });
      }
      // The guest page's own requests: its Origin was checked against the guest origin by the backend listener.
      return await floorRequest(
        req,
        res,
        p,
        url,
        () => mutation,
        () => false,
      );
    } catch (err) {
      console.error(err);
      if (!res.headersSent) send(res, 500, { error: 'Something went wrong' });
    }
  };

  /** The create form's choices: every open floor and the workers on it now. */
  const targets = (): GuestTargetFloor[] =>
    [...floors.values()].map((f) => ({
      id: f.id,
      name: f.def.name,
      workers: f.everyone().map((w) => ({ id: w.id, name: w.name })),
    }));

  /** The owner's Share list. */
  const state = (): GuestLinksState => ({
    on: guestLinks.on,
    transport: guestLinks.on ? ctx.guestFunnel().state() : { status: 'off' },
    links: guestLinks.list(),
    guests: guestLinks.liveCount(),
    max: GUEST_LINKS_MAX,
    targets: targets(),
  });

  /** The kill switch: off disconnects every guest at once, then removes the Funnel mapping. */
  const setSharing = async (on: boolean): Promise<GuestLinksState> => {
    guestLinks.setOn(on);
    await ctx.guestFunnel().set(on);
    console.log(`  🔗  External sharing is ${on ? 'on' : 'off'}`);
    return state();
  };

  /** `/api/guest-links*` for the office's own page (the caller has already checked ownPage). */
  const ownerRequest = async (req: http.IncomingMessage, res: http.ServerResponse, p: string, url: URL) => {
    const method = req.method ?? 'GET';
    if (p === '/api/guest-links/audit') {
      if (method !== 'GET') return send(res, 405, { error: 'Use GET' });
      const limit = Number(url.searchParams.get('limit') ?? 50);
      return send(res, 200, guestAudit.read({ before: str(url.searchParams.get('before'), 64) || undefined, limit: Number.isFinite(limit) ? Math.min(GUEST_AUDIT_PAGE_MAX, limit) : 50 }));
    }
    if (p.startsWith('/api/guest-links/')) {
      if (method !== 'DELETE') return send(res, 405, { error: 'Use DELETE' });
      const id = p.slice('/api/guest-links/'.length);
      const label = guestLinks.get(id)?.label;
      if (!guestLinks.revoke(id)) return send(res, 404, { error: 'No such active share link' });
      console.log(`  🔗  Share link “${label}” revoked`);
      return send(res, 200, state());
    }
    if (p !== '/api/guest-links') return send(res, 404, { error: 'Not found' });
    if (method === 'GET') return send(res, 200, state());
    let body: Record<string, unknown>;
    try {
      const raw: unknown = JSON.parse(await readBody(req, 4096));
      body = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    } catch {
      return send(res, 400, { error: 'Send JSON' });
    }
    if (method === 'PUT') {
      if (typeof body.on !== 'boolean') return send(res, 400, { error: 'Send JSON: {"on": true}' });
      return send(res, 200, await setSharing(body.on));
    }
    if (method === 'POST') {
      if (!guestLinks.on) return send(res, 409, { error: 'Turn on external sharing first.' });
      const origin = ctx.guestFunnel().origin();
      if (!origin) {
        const t = ctx.guestFunnel().state();
        return send(res, 409, { error: t.reason ? `Sharing isn’t reachable yet: ${t.reason}` : 'Sharing isn’t reachable yet. Wait for Tailscale Funnel to start.' });
      }
      const made = guestLinks.create({ label: body.label, preset: body.preset, floorId: body.floorId, workerId: body.workerId, expiry: body.expiry ?? 'never' });
      if (!made.ok) return send(res, made.status, { error: made.error });
      console.log(`  🔗  Share link “${made.link.label}” created`);
      return send(res, 200, { link: made.link, url: guestShareUrl(origin, made.token), state: state() } satisfies GuestLinkCreated);
    }
    return send(res, 405, { error: 'Use GET, PUT or POST' });
  };

  return { guestRequest, ownerRequest, state, setSharing };
}

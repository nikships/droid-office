import type http from 'node:http';
import type { Floor } from '../floor.js';
import { officePrompt, type OfficePrompts } from '../prompts.js';
import { MAX_ASSET_BYTES, OWNER_AUTHOR, PINGED_KEY, findCard, parseEnvelope, pinged } from '../../shared/whiteboard.js';
import { pingEligibility } from '../../shared/whiteboard-ping.js';
import { cardResponse, renderInfo, renderStatus, type CardResponse } from '../whiteboard.js';
import { deliverPress, freshPresses, type ButtonPress } from '../whiteboard-buttons.js';
import type { Client, SendTo } from './client.js';
import { readBytes, send } from './http-utils.js';
import { str } from './validation.js';

interface WhiteboardContext {
  floors: Map<string, Floor>;
  prompts: OfficePrompts;
  sendTo: SendTo;
  warn(c: Client, error: string | undefined): void;
}

/** HTTP capability/file/render routes and the window's committed Whiteboard batches. */
export function createWhiteboardRuntime({ floors, prompts, sendTo, warn }: WhiteboardContext) {
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
    const presses = freshPresses(floor.whiteboard.board, env.ops);
    let out: ReturnType<typeof floor.whiteboard.apply>;
    try {
      out = floor.whiteboard.apply(env, OWNER_AUTHOR, 'window');
    } catch (err) {
      // Not committed: the window keeps it pending and sends it again after its next resync.
      console.error(`droid-office: the ${floor.def.name} Whiteboard couldn't be saved: ${(err as Error).message}`);
      return warn(c, `The Whiteboard couldn't be saved: ${(err as Error).message}`);
    }
    const head = { epoch: env.epoch, seq: env.seq };
    if (out.kind === 'ack') {
      sendTo(c, { t: 'whiteboard', floor: floor.id, update: { kind: 'ack', ...head, rev: out.rev } });
      // A retry the record recognised applied nothing new, so a press in it was already delivered.
      if (!out.duplicate) pressButtons(c, floor, presses);
    } else if (out.reason === 'expired') sendTo(c, { t: 'whiteboard', floor: floor.id, update: { kind: 'rejected', ...head, reason: 'expired' } });
    else sendTo(c, { t: 'whiteboard', floor: floor.id, update: { kind: 'rejected', ...head, reason: 'invalid', error: out.error } });
  };
  /**
   * The first press of each `data-wb-ping` button in the owner's batch goes to the worker who last
   * edited its card's page. One that can't get there is taken back, so its button works again, and
   * the owner is told why.
   */
  const pressButtons = (c: Client, floor: Floor, presses: ButtonPress[]) => {
    for (const press of presses) {
      const card = findCard(floor.whiteboard.board, press.card);
      if (!card || !pinged(card.state, press.name)) continue;
      const out = deliverPress(floor.whiteboard.board, press, floor.everyone(), floor.workers, floor.def.name, prompts);
      if (out.ok) continue;
      floor.whiteboard.applyOffice([{ op: 'state.del', card: press.card, path: [PINGED_KEY, press.name] }]);
      warn(c, `“${press.ping.label || press.name}” didn't reach a worker: ${out.error}`);
    }
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
    // Mid-turn, its hooks hand the line over with its next tool call; a hook command that can't, gets it queued behind the turn.
    const err = can.how === 'resume' ? floor.workers.resume(id, text) : can.how === 'queue' && floor.workers.notice(id, text) ? undefined : floor.workers.prompt(id, text, [], can.how === 'queue');
    if (err) return pinged(false, { error: `${info.name}: ${err}` });
    pinged(true, { how: can.how });
  };

  return { serveCard, whiteboardRequest, sendBoard, applyBoard, pingWorker };
}

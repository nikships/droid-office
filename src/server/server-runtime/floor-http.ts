import type http from 'node:http';
import type { Floor } from '../floor.js';
import type { Orchestrator } from '../orchestrator.js';
import type { WorkerThreadReader } from '../worker-thread.js';
import { sendDownload, type mountFactory } from '../factory/index.js';
import type { Setup } from '../setup/index.js';
import { OFFICE_SHELL_ID } from '../../shared/office-shell.js';
import { ORCHESTRATOR_ID } from '../../shared/mission-control.js';
import { AIRGAPPED_REASON } from '../../shared/setup.js';
import { DROP_MAX_BYTES } from '../../shared/drops.js';
import { UPLOAD_MAX_BYTES } from '../../shared/decor.js';
import { SEARCH_MAX, SEARCH_MIN, searchKey } from '../../shared/search.js';
import type { SearchResults } from '../../shared/protocol.js';
import { DROP_IMAGE_ID } from '../thread-images.js';
import { ThreadWorkspace } from '../thread-workspace.js';
import type { createWhiteboardRuntime } from './whiteboard.js';
import { imageIds, repoOf, str } from './validation.js';
import { readBody, readBytes, send } from './http-utils.js';

const SEARCH_TERMINAL_HITS = 25;

export function isFloorHttpPath(p: string, method: string | undefined): boolean {
  return (
    p === '/api/term/drop' ||
    p === '/api/prompt/image' ||
    p === '/api/decor/picture' ||
    p === '/api/changes/file' ||
    p.startsWith('/api/factory/') ||
    p.startsWith('/api/docs') ||
    p.startsWith('/api/whiteboard/') ||
    (method === 'GET' &&
      (p === '/api/thread/image' || p === '/api/thread/files' || p === '/api/thread/file' || p === '/api/linear/issue' || p === '/api/linear/image' || p === '/api/jira/ticket' || p === '/api/search' || p.startsWith('/api/gh/')))
  );
}

interface FloorHttpContext {
  floors: Map<string, Floor>;
  orchestrator: Orchestrator;
  workerFloor(id: string): Floor | undefined;
  workerThreads: WorkerThreadReader;
  factory: ReturnType<typeof mountFactory>;
  setup: Setup;
  whiteboardRequest: ReturnType<typeof createWhiteboardRuntime>['whiteboardRequest'];
}

/** Authenticated floor resources: terminals, boards, docs, integrations and uploads. */
export function createFloorHttp({ floors, orchestrator, workerFloor, workerThreads, factory, setup, whiteboardRequest }: FloorHttpContext) {
  const threadWorkspace = new ThreadWorkspace();
  const resolveThreadCwd = (workerId: string, floor: Floor | undefined): string | undefined => {
    if (!workerId) return undefined;
    if (workerId === ORCHESTRATOR_ID) return orchestrator.cwd;
    return floor?.workers.agentFolder(workerId) ?? workerFloor(workerId)?.workers.agentFolder(workerId);
  };

  /** The 🔎 search: lines of the terminals of every worker on that floor, with the words in them. */
  const search = (q: string, floor: Floor | undefined): SearchResults => {
    q = q.slice(0, SEARCH_MAX);
    const needle = searchKey(q);
    if (needle.length < SEARCH_MIN) return { q, terminals: [], more: false };
    const shown = floor?.workers.search(needle, SEARCH_TERMINAL_HITS) ?? { hits: [], more: false };
    return { q, terminals: shown.hits, more: shown.more };
  };

  return async (req: http.IncomingMessage, res: http.ServerResponse, p: string, url: URL, ownRequest: () => boolean) => {
    // Which floor a request is about: its boards and its workers.
    const floor = floors.get(url.searchParams.get('floor') ?? '');
    if (p === '/api/thread/image' && req.method === 'GET') {
      // A picture a worker read or was sent, shown in its Thread (worker-thread.ts reads it from the session).
      const workerId = str(url.searchParams.get('worker'), 32);
      const id = str(url.searchParams.get('image'), 160);
      // The Orchestrator's thread is the same from every floor; cross-floor thread views fall back to the worker's floor.
      const owner = workerId === ORCHESTRATOR_ID ? orchestrator.workers : (floor?.workers ?? workerFloor(workerId)?.workers);
      const source = owner?.threadSession(workerId);
      // A picture sent with a prompt is served from that worker's own drops, never from the path the message names.
      const drop = DROP_IMAGE_ID.exec(id)?.[1];
      const image = !source ? undefined : drop ? owner?.dropPicture(workerId, drop) : await workerThreads.image(source, id);
      if (!image) return send(res, 404, { error: 'That picture is no longer in the conversation.' });
      res.writeHead(200, {
        'content-type': image.type,
        'content-length': String(image.body.length),
        // The id names the picture's bytes, so the same id is always the same picture.
        'cache-control': 'private, max-age=86400, immutable',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'cross-origin-resource-policy': 'same-origin',
      });
      res.end(image.body);
      return;
    }
    if ((p === '/api/thread/files' || p === '/api/thread/file') && req.method === 'GET') {
      const workerId = str(url.searchParams.get('worker'), 32);
      const cwd = resolveThreadCwd(workerId, floor);
      if (!cwd) return send(res, 404, { error: 'Workspace files are available only for local Droid workers.' });
      if (p === '/api/thread/files') {
        const q = str(url.searchParams.get('q'), 256);
        const r = await threadWorkspace.listFiles(cwd, q);
        return 'error' in r ? send(res, r.status, { error: r.error }) : send(res, 200, r);
      }
      const relPath = str(url.searchParams.get('path'), 4096);
      const r = await threadWorkspace.readPreview(cwd, relPath);
      return 'error' in r ? send(res, r.status, { error: r.error, ...(r.binary ? { binary: true } : {}) }) : send(res, 200, r);
    }
    if (p === '/api/term/drop') {
      // A file dropped or pasted into a worker's terminal, kept on this machine for the terminal to type its path.
      if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
      if (!ownRequest()) return send(res, 403, { error: 'Forbidden' });
      const workerId = str(url.searchParams.get('worker'), 32);
      const mission = workerId === ORCHESTRATOR_ID;
      if (!floor && !mission) return send(res, 404, { error: 'No such floor' });
      const shellDrop = workerId === OFFICE_SHELL_ID;
      const target = mission ? orchestrator.workers : floor?.workers;
      if (!shellDrop && !target?.get(workerId)) return send(res, 404, { error: 'No such worker' });
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
      const file = shellDrop ? floor?.shell.drop(name, type, body) : target?.drop(workerId, name, type, body);
      return file ? send(res, 200, { path: file }) : send(res, 500, { error: 'The office could not keep that file' });
    }
    if (p === '/api/prompt/image') {
      // A picture pasted into a prompt that isn't sent yet, kept on this machine until it is (POST), or taken out again (DELETE).
      if (req.method !== 'POST' && req.method !== 'DELETE') return send(res, 405, { error: 'Method not allowed' });
      if (!ownRequest()) return send(res, 403, { error: 'Forbidden' });
      // ?worker=orchestrator: for a prompt to the Orchestrator, kept where its session reads it.
      const stage = url.searchParams.get('worker') === ORCHESTRATOR_ID ? orchestrator.workers : floor?.workers;
      if (!stage) return send(res, 404, { error: 'No such floor' });
      if (req.method === 'DELETE') {
        stage.unstage(imageIds([url.searchParams.get('id')]));
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
      const id = stage.stageImage(str(url.searchParams.get('name'), 256), body);
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
      if (setup.state().airgapped) return send(res, 403, { error: AIRGAPPED_REASON });
      const r = await factory.registry.http(req.method ?? 'GET', p.slice('/api/factory'.length), url.searchParams, (limit) => readBody(req, limit), { trusted: ownRequest(), by: str(req.headers['x-droid-office-name'], 24) });
      if (r.download) return sendDownload(res, r.download);
      return send(res, r.status, r.body);
    }
    if (p === '/api/linear/issue' && req.method === 'GET') {
      // What a Linear ticket's window shows beyond its card (see linear.ts). Only the floor's team's tickets.
      if (!floor) return send(res, 404, { error: 'No such floor' });
      try {
        return send(res, 200, await floor.linear.detail(url.searchParams.get('id') ?? ''));
      } catch (err) {
        const status = (err as { status?: number }).status;
        return send(res, status === 400 || status === 403 || status === 404 || status === 409 ? status : 502, { error: (err as Error).message });
      }
    }
    if (p === '/api/linear/image' && req.method === 'GET') {
      // An image on uploads.linear.app in a ticket's description or comments, fetched with the office's key.
      if (!floor) return send(res, 404, { error: 'No such floor' });
      const r = await floor.linear.image(url.searchParams.get('url') ?? '');
      if ('error' in r) return send(res, r.status, { error: r.error });
      res.writeHead(200, {
        'content-type': r.type,
        'content-length': String(r.body.length),
        'cache-control': 'private, max-age=3600',
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
  };
}

// The window's side of a floor's Whiteboard (docs/whiteboard.md, "Concurrent edits and reconnects"):
// the board as the server committed it, the owner's batches on top of it until they're acknowledged,
// and what happens to them across an outage.
//
// - Every batch is numbered in this connection's epoch for the floor (from its snapshot) and kept
//   until the server acknowledges it, applied optimistically on top of the committed board.
// - While the connection is down, batches wait here. On reconnect the server sends a fresh snapshot,
//   and every batch it hasn't acknowledged is sent again with its own epoch and number, so one that
//   was committed before the outage is acknowledged again, never applied twice.
// - A batch whose epoch the server no longer holds is rejected as expired: it becomes a draft, which
//   the owner can look at against the board as it is now and reapply (as a new batch) or discard.
//
// No DOM here: tests drive it in Node with a fake `send`.

import type { ClientMsg, ServerMsg, WhiteboardRenderInfo, WhiteboardRendererStatus } from '../shared/protocol';
import { OWNER_AUTHOR, applyOps, applyPatch, findCard, type Board, type Op, type OpError } from '../shared/whiteboard';

export type ApplyResult = { ok: true; rev: number } | { ok: false; reason: 'invalid'; error: OpError } | { ok: false; reason: 'expired' } | { ok: false; reason: 'discarded' };

/** A batch the server hasn't acknowledged yet. */
export interface PendingBatch {
  epoch: string;
  seq: number;
  ops: Op[];
  /** The revision its patch came back at, once it has (the ack may still be on its way). */
  committed?: number;
  done: (r: ApplyResult) => void;
}

/** Edits the server refused as expired: kept for the owner to reapply against the board as it is now. */
export interface Draft {
  id: number;
  ops: Op[];
  at: number;
}

/** One floor's board, as this window knows it. */
export interface FloorBoard {
  floor: string;
  /** The board as the server last committed it; null before the first snapshot. */
  committed: Board | null;
  /** This connection's epoch for the floor, from its snapshot. */
  epoch: string | null;
  /** The next sequence number in each epoch this window has numbered batches in. */
  seqs: Map<string, number>;
  pending: PendingBatch[];
  drafts: Draft[];
  caps: Record<string, string>;
  renderer: WhiteboardRendererStatus;
  /** Each card's latest render, from `whiteboard.rendered`. */
  renders: Record<string, WhiteboardRenderInfo>;
  /** Patches arrive for it: this connection is on the floor and has its snapshot. */
  live: boolean;
  /** The last batch the server refused as invalid, for the window to show. */
  lastError?: OpError;
}

export type SyncState = 'live' | 'offline' | 'syncing';

export class WhiteboardSync {
  private floors = new Map<string, FloorBoard>();
  private subs = new Set<(floor: string) => void>();
  private draftSeq = 0;
  /** The floor the window is on; the server sends that floor's patches. */
  current: string | null = null;
  up = false;

  constructor(
    /** Sends a message now; false when the connection is down (nothing was sent). */
    private send: (msg: ClientMsg) => boolean,
    private now: () => number = Date.now,
  ) {}

  /** Called with a floor's id whenever its board, pending batches, drafts or connection state change. */
  subscribe(fn: (floor: string) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  /** A floor's state, made when first asked for. */
  floor(id: string): FloorBoard {
    let f = this.floors.get(id);
    if (!f) {
      f = { floor: id, committed: null, epoch: null, seqs: new Map(), pending: [], drafts: [], caps: {}, renderer: { available: false }, renders: {}, live: false };
      this.floors.set(id, f);
    }
    return f;
  }

  /** The board as the window shows it: committed, with the batches still waiting applied on top. */
  board(id: string): Board | null {
    const f = this.floors.get(id);
    if (!f?.committed) return null;
    let b = f.committed;
    for (const p of f.pending) {
      if (p.committed !== undefined && p.committed <= f.committed.rev) continue;
      const r = applyOps(b, p.ops, OWNER_AUTHOR, b.rev + 1, this.now());
      // It may not apply on top of what others did since; the server will say.
      if (r.ok) b = { ...r.board, rev: b.rev };
    }
    return b;
  }

  state(id: string): SyncState {
    const f = this.floors.get(id);
    if (!this.up) return 'offline';
    return f?.live ? 'live' : 'syncing';
  }

  /**
   * Applies a batch for the owner: at once on the window's board, and to the server, which answers
   * once it's committed (or why not). A batch that can't apply to the board as the window has it is
   * refused here, before anything is sent. While offline it waits, and goes once the window resyncs.
   */
  apply(floorId: string, ops: Op[]): Promise<ApplyResult> {
    const f = this.floor(floorId);
    const view = this.board(floorId);
    if (view) {
      const check = applyOps(view, ops, OWNER_AUTHOR, view.rev + 1, this.now());
      if (!check.ok) return Promise.resolve({ ok: false, reason: 'invalid', error: check.error });
    }
    return new Promise<ApplyResult>((resolve) => {
      const epoch = f.epoch;
      if (!epoch) {
        // No snapshot yet: numbered once one comes (see snapshot()).
        f.pending.push({ epoch: '', seq: 0, ops, done: resolve });
        this.sync(f);
        this.changed(floorId);
        return;
      }
      const seq = this.nextSeq(f, epoch);
      const p: PendingBatch = { epoch, seq, ops, done: resolve };
      f.pending.push(p);
      if (f.live) this.sendBatch(f, p);
      this.changed(floorId);
    });
  }

  /** Reapplies a draft as a new batch, against the board as it is now; it stays a draft if that fails. */
  async reapplyDraft(floorId: string, draftId: number): Promise<ApplyResult | undefined> {
    const f = this.floor(floorId);
    const d = f.drafts.find((x) => x.id === draftId);
    if (!d) return undefined;
    f.drafts = f.drafts.filter((x) => x !== d);
    this.changed(floorId);
    const r = await this.apply(floorId, d.ops);
    if (!r.ok) {
      f.drafts.push(d);
      this.changed(floorId);
    }
    return r;
  }

  discardDraft(floorId: string, draftId: number) {
    const f = this.floor(floorId);
    f.drafts = f.drafts.filter((x) => x.id !== draftId);
    this.changed(floorId);
  }

  /**
   * Forgets every batch the server hasn't acknowledged and every expired draft, on every floor, without
   * sending anything: for a companion, whose edits never outlive the connection they were made on.
   * A batch the server committed before the loss is in the next snapshot; one it never got is gone.
   */
  discardUnsent() {
    for (const f of this.floors.values()) {
      if (!f.pending.length && !f.drafts.length) continue;
      const pending = f.pending;
      f.pending = [];
      f.drafts = [];
      for (const p of pending) p.done({ ok: false, reason: 'discarded' });
      this.changed(f.floor);
    }
  }

  /** The connection went up or down. Up, the snapshot the server sends next starts the resends. */
  status(up: boolean) {
    this.up = up;
    for (const f of this.floors.values()) {
      f.live = false;
      this.changed(f.floor);
    }
  }

  /** A message from the server: the `whiteboard` ones, and those that say which floor this window is on. */
  handle(msg: ServerMsg) {
    if (msg.t === 'welcome' || msg.t === 'floor.enter') {
      const was = this.current;
      this.current = msg.floor;
      if (msg.t === 'welcome') {
        // A new connection: each floor gets a new epoch with its snapshot; numbering in the old ones stops.
        for (const f of this.floors.values()) f.epoch = null;
      }
      if (was && was !== msg.floor) {
        const old = this.floors.get(was);
        if (old) {
          old.live = false;
          this.changed(was);
        }
      }
      // Batches waiting on another floor go once its snapshot comes.
      for (const f of this.floors.values()) if (f.floor !== msg.floor && f.pending.length) this.sync(f);
      return;
    }
    if (msg.t === 'whiteboard.renderer') {
      for (const f of this.floors.values()) {
        f.renderer = msg.status;
        this.changed(f.floor);
      }
      return;
    }
    if (msg.t === 'whiteboard.rendered') {
      const f = this.floor(msg.floor);
      f.renders = { ...f.renders, [msg.card]: msg.info };
      this.changed(f.floor);
      return;
    }
    if (msg.t !== 'whiteboard') return;
    const f = this.floor(msg.floor);
    const u = msg.update;
    switch (u.kind) {
      case 'snapshot':
        this.snapshot(f, u.board, u.epoch, msg.caps ?? {}, msg.renderer);
        break;
      case 'patch': {
        if (!f.committed || !f.live) break;
        if (u.patch.rev <= f.committed.rev) break;
        const r = u.patch.rev === f.committed.rev + 1 ? applyPatch(f.committed, u.patch) : undefined;
        if (!r?.ok) {
          // A gap or a patch that doesn't replay: start over from a snapshot.
          f.live = false;
          this.send({ t: 'whiteboard.sync', floor: f.floor });
          this.changed(f.floor);
          break;
        }
        f.committed = r.board;
        if (msg.caps) f.caps = { ...f.caps, ...msg.caps };
        if (msg.origin) {
          const p = f.pending.find((x) => x.epoch === msg.origin!.epoch && x.seq === msg.origin!.seq);
          if (p) p.committed = u.patch.rev;
        }
        this.changed(f.floor);
        break;
      }
      case 'ack':
        this.settle(f, u.epoch, u.seq, { ok: true, rev: u.rev });
        break;
      case 'rejected': {
        const p = this.settle(f, u.epoch, u.seq, u.reason === 'invalid' ? { ok: false, reason: 'invalid', error: u.error } : { ok: false, reason: 'expired' });
        if (u.reason === 'invalid') f.lastError = u.error;
        else if (p) f.drafts.push({ id: ++this.draftSeq, ops: p.ops, at: this.now() });
        this.changed(f.floor);
        break;
      }
    }
  }

  /** `/whiteboard/c/<cap>/<entry>#wb=<nonce>`: the URL the window's frame loads a card from. */
  cardUrl(floorId: string, cardId: string, nonce: string): string | undefined {
    const f = this.floors.get(floorId);
    const card = f?.committed && findCard(f.committed, cardId);
    const cap = f?.caps[cardId];
    if (!card?.content || !cap) return undefined;
    return `/whiteboard/c/${cap}/${card.content.entry.split('/').map(encodeURIComponent).join('/')}#wb=${encodeURIComponent(nonce)}`;
  }

  /**
   * `/api/whiteboard/render?…`: a card's latest image (a grid thumbnail, or one tile of the full page),
   * keyed by its render time so a new render is fetched rather than cached; undefined before the first.
   */
  renderUrl(floorId: string, cardId: string, opts: { size?: 'thumb' | 'full'; tile?: number } = {}): string | undefined {
    const info = this.floors.get(floorId)?.renders[cardId];
    if (info?.at === undefined) return undefined;
    const q = new URLSearchParams({ floor: floorId, card: cardId, size: opts.size ?? 'full', v: String(info.at) });
    if (opts.tile !== undefined) q.set('tile', String(opts.tile));
    return `/api/whiteboard/render?${q}`;
  }

  private snapshot(f: FloorBoard, board: Board, epoch: string, caps: Record<string, string>, renderer?: WhiteboardRendererStatus) {
    f.committed = board;
    f.epoch = epoch;
    f.caps = caps;
    if (renderer) f.renderer = renderer;
    f.live = this.current === f.floor;
    // What hasn't been acknowledged goes again, each batch in the epoch it was numbered in; those
    // made before any epoch was known are numbered now. A copy: an answer can settle one mid-loop.
    for (const p of [...f.pending]) {
      if (!p.epoch) {
        p.epoch = epoch;
        p.seq = this.nextSeq(f, epoch);
      }
      this.sendBatch(f, p);
    }
    this.changed(f.floor);
  }

  private settle(f: FloorBoard, epoch: string, seq: number, r: ApplyResult): PendingBatch | undefined {
    const i = f.pending.findIndex((x) => x.epoch === epoch && x.seq === seq);
    if (i < 0) return undefined;
    const [p] = f.pending.splice(i, 1);
    p.done(r);
    this.changed(f.floor);
    return p;
  }

  private nextSeq(f: FloorBoard, epoch: string): number {
    const n = (f.seqs.get(epoch) ?? 0) + 1;
    f.seqs.set(epoch, n);
    return n;
  }

  private sendBatch(f: FloorBoard, p: PendingBatch) {
    // Down: it goes again with the next snapshot.
    this.send({ t: 'whiteboard.apply', floor: f.floor, envelope: { epoch: p.epoch, seq: p.seq, ops: p.ops } });
  }

  private sync(f: FloorBoard) {
    if (this.up) this.send({ t: 'whiteboard.sync', floor: f.floor });
  }

  private changed(floor: string) {
    for (const fn of this.subs) fn(floor);
  }
}

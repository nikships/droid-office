// What a page that joins an already open socket needs to catch up: the sealed management host opens
// on a connection native has held for a while, which sends no new `welcome`. Native (or a test) records
// every message here and hands the page `snapshot()`; applied in order to an empty store, it leaves the
// store as the live messages did. Pure, so the Android build and the tests share it.
//
// Kept: the last `welcome`, the `floor.enter` after it, the latest of each state broadcast, and worker
// updates folded per worker. Not kept: terminal frames, toasts, answers to someone's request, and the
// Whiteboard (the page asks for its own `whiteboard.sync`, so a replayed batch can never be resent).

import type { ServerMsg } from './protocol.js';

/** State broadcasts about the whole office: a new welcome replaces them, a floor change doesn't. */
const OFFICE_TOPICS = ['floors', 'projectsDir', 'upgrade', 'machine', 'sky', 'jukebox', 'leaveOnMerge', 'freshMain', 'subagents', 'models.hidden', 'whiteboardSkill', 'prompts', 'factory', 'setup', 'subscriptions'] as const;

/** State broadcasts about the floor this connection is on: a floor change replaces them. */
const FLOOR_TOPICS = ['gh.issues', 'gh.pulls', 'pipelines', 'jira', 'jira.board', 'autoHeal', 'decor', 'worktreeSetup', 'visits'] as const;

type Topic = (typeof OFFICE_TOPICS)[number] | (typeof FLOOR_TOPICS)[number];
type WorkerMsg = Extract<ServerMsg, { t: 'worker.update' | 'worker.remove' }>;

const isTopic = (t: string, list: readonly string[]): t is Topic => list.includes(t);

export class StateReplay {
  private welcome: Extract<ServerMsg, { t: 'welcome' }> | null = null;
  private enter: Extract<ServerMsg, { t: 'floor.enter' }> | null = null;
  private office = new Map<Topic, ServerMsg>();
  private floor = new Map<Topic, ServerMsg>();
  private workers = new Map<string, WorkerMsg>();

  /** Every message from the socket, in order. */
  record(msg: ServerMsg) {
    switch (msg.t) {
      case 'welcome':
        this.welcome = msg;
        this.enter = null;
        this.office.clear();
        this.floor.clear();
        this.workers.clear();
        return;
      case 'floor.enter':
        if (!this.welcome) return;
        this.enter = msg;
        this.floor.clear();
        this.workers.clear();
        return;
      case 'worker.update':
      case 'worker.remove': {
        if (!this.welcome) return;
        const id = msg.t === 'worker.update' ? msg.worker.id : msg.workerId;
        // Re-inserted so the fold keeps the order the last word on each worker arrived in.
        this.workers.delete(id);
        this.workers.set(id, msg);
        return;
      }
    }
    if (!this.welcome) return;
    if (isTopic(msg.t, OFFICE_TOPICS)) this.office.set(msg.t, msg);
    else if (isTopic(msg.t, FLOOR_TOPICS)) this.floor.set(msg.t, msg);
  }

  /** The socket closed: what it said no longer holds. */
  reset() {
    this.welcome = null;
    this.enter = null;
    this.office.clear();
    this.floor.clear();
    this.workers.clear();
  }

  /** The floor the replay leaves a page on, or null before a welcome. */
  floorId(): string | null {
    return (this.enter ?? this.welcome)?.floor ?? null;
  }

  /** The messages that bring an empty store to now, in the order to apply them; empty before a welcome. */
  snapshot(): ServerMsg[] {
    if (!this.welcome) return [];
    const out: ServerMsg[] = [this.welcome];
    if (this.enter) out.push(this.enter);
    out.push(...this.office.values(), ...this.floor.values(), ...this.workers.values());
    return out;
  }
}

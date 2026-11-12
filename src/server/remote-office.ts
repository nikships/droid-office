import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { WorkerInfo } from '../shared/protocol.js';
import { buildGrokWebhookPayload, buildTeamWebhookItem, sendGrokWebhook, webhookWorkerFromMember, type GrokWebhookItem, type GrokWebhookResult } from './grok-webhook.js';
import { terminalQuestion } from './office-mcp/team-events.js';
import { pushedSha } from './team-inspect.js';
import { teamDeliveryReply, type Team, type TeamDelivery, type TeamEvent, type TeamReply, type TeamViews } from './team.js';
import type { Visits } from './visits.js';
import type { GrokBotInput, RemoteMessage, RemoteWorkers } from './remote-workers.js';
import type { WorkerManager } from './workers.js';
import type { WhiteboardStore } from './whiteboard.js';

export interface RemoteFloor {
  id: string;
  def: { name: string };
  dir: string;
  workers: Pick<WorkerManager, 'get' | 'list' | 'authenticate' | 'releaseLead'> & Partial<Pick<WorkerManager, 'screenLines' | 'screenMenu' | 'write'>>;
  team: Pick<Team, 'handle' | 'inbox' | 'onWorkerGone' | 'cannotHire' | 'hasNews' | 'leadRested' | TeamViews> & Partial<Pick<Team, 'formerMatches'>>;
  visits: Pick<Visits, 'handle' | 'onWorkerGone' | 'cannotVisit'>;
  whiteboard: WhiteboardStore;
}

/** The open floor a reference names (its id, its checkout's path, or its name in any case), or why it names none. */
export function floorNamed<F extends { id: string; def: { name: string }; dir: string }>(floors: readonly F[], ref: string): F | string {
  const want = ref.trim();
  const exact = floors.find((f) => f.id === want) ?? floors.find((f) => path.isAbsolute(want) && path.resolve(f.dir) === path.resolve(want));
  if (exact) return exact;
  const named = floors.filter((f) => f.def.name.toLowerCase() === want.toLowerCase());
  if (named.length === 1) return named[0];
  if (named.length) return `Several open floors are called ${want}. Use the floor id: ${named.map((f) => f.id).join(', ')}.`;
  return `No open floor ${want}. office_floors lists them: ${floors.map((f) => `${f.def.name} (${f.id})`).join(', ') || 'none open'}.`;
}

export interface RemoteOfficeOptions {
  fetchImpl?: typeof fetch;
  /** Debounce window (ms) for coalescing automatic floor hook events before POSTing to a Grok Bot's webhook. */
  webhookDelayMs?: number;
  webhookTimeoutMs?: number;
  now?: () => number;
}

type PendingPush = { type: 'team'; id: string; floor: RemoteFloor; event: TeamEvent } | { type: 'inbox'; id: string; message: RemoteMessage } | { type: 'direct'; id: string; item: GrokWebhookItem };

const WEBHOOK_DELAY_MS = 1500;
const PUSHED_HISTORY_MAX = 1000;

/**
 * The building agents' side of every floor: Mission Control has no desks, so a building agent's teams,
 * inbox and hires span every open floor, and each hire names its floor.
 */
export class RemoteOffice {
  private readonly unsubs = new Map<RemoteFloor, () => void>();
  private readonly pending = new Map<string, Map<string, PendingPush>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly inFlight = new Map<string, Promise<GrokWebhookResult | undefined>>();
  private readonly pushedIds = new Set<string>();
  private readonly webhookDeliveries = new Map<string, { leadId: string; ackIds: string[] }>();
  private stopped = false;

  constructor(
    readonly store: RemoteWorkers,
    /** Every open floor, where a building agent's teams may be. */
    readonly floors: () => RemoteFloor[],
    private readonly opts: RemoteOfficeOptions = {},
  ) {
    if (this.store.hasGrokBots()) this.syncWatches();
  }

  /** Keeps floor team subscriptions aligned with open floors whenever at least one Grok Bot is configured. */
  syncWatches() {
    if (this.stopped || !this.store.hasGrokBots()) {
      for (const unsub of this.unsubs.values()) unsub();
      this.unsubs.clear();
      return;
    }
    const open = new Set(this.floors());
    for (const [floor, unsub] of this.unsubs) {
      if (!open.has(floor)) {
        unsub();
        this.unsubs.delete(floor);
      }
    }
    for (const floor of open) {
      if (this.unsubs.has(floor)) continue;
      this.unsubs.set(
        floor,
        floor.team.subscribe((signal) => {
          if (signal.type === 'event') this.onTeamEvent(floor, signal.event);
        }),
      );
    }
  }

  stop() {
    this.stopped = true;
    for (const unsub of this.unsubs.values()) unsub();
    this.unsubs.clear();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.pending.clear();
  }

  add(name: string, grokBot?: GrokBotInput) {
    const added = this.store.add(name, grokBot);
    this.syncWatches();
    return added;
  }

  setGrokBot(id: string, grokBot: GrokBotInput | null) {
    this.store.setGrokBot(id, grokBot);
    if (grokBot === null) this.clearLeadQueue(id);
    this.syncWatches();
  }

  /** The bot's key stops working, and its subagents carry on as independent workers. */
  revoke(id: string) {
    this.clearLeadQueue(id);
    this.store.remove(id);
    this.syncWatches();
    for (const floor of this.floors()) {
      floor.workers.releaseLead(id);
      floor.team.onWorkerGone(id);
      floor.visits.onWorkerGone(id);
      floor.whiteboard.forgetReader(id);
    }
  }

  /** Queues a message in an external bot's inbox and, if it is a Grok Bot, schedules a webhook push. */
  tell(id: string, text: string, floor?: string): string | undefined {
    const { message, error } = this.store.enqueueMessage(id, text, floor);
    if (error || !message) return error;
    if (this.store.isGrokBot(id)) {
      this.syncWatches();
      this.queuePush(id, { type: 'inbox', id: message.id, message });
      this.scheduleFlush(id);
    }
    return undefined;
  }

  /** Flushes a subagent's report, progress or question immediately to its Grok Bot lead's webhook. */
  async pushTeamReport(floorId: string, leadId: string, event?: TeamEvent): Promise<GrokWebhookResult | undefined> {
    if (!this.store.isGrokBot(leadId)) return undefined;
    this.syncWatches();
    if (event) {
      const floor = this.floors().find((f) => f.id === floorId);
      const id = `team:${floorId}:${event.seq}`;
      if (floor && !this.pushedIds.has(id)) this.queuePush(leadId, { type: 'team', id, floor, event });
    }
    return this.flushLeadPush(leadId);
  }

  /** Sends a direct mid-turn update, question, blocker or connectivity test from a subagent to its Grok Bot lead. */
  async notifyLead(
    caller: { worker: WorkerInfo; floor: { id: string; name: string; dir: string } },
    input: { kind: 'update' | 'question' | 'blocker' | 'test'; text: string; options?: string[]; prUrl?: string; pushedSha?: string },
  ): Promise<{ ok: boolean; status?: number; error?: string; ackId?: string; lead: string }> {
    const leadId = caller.worker.lead;
    const lead = leadId ? this.store.identity(leadId) : undefined;
    if (!leadId || !lead || !this.store.isGrokBot(leadId)) {
      return { ok: false, error: 'Your lead does not have a Grok Bot push webhook configured.', lead: lead?.name ?? leadId ?? 'unknown' };
    }
    this.syncWatches();
    const now = (this.opts.now ?? Date.now)();
    const floor = this.floors().find((f) => f.id === caller.floor.id);
    const member = floor?.team.roster(leadId).find((m) => m.id === caller.worker.id);
    const sha = input.pushedSha ?? (input.kind === 'test' ? undefined : await pushedSha(caller.floor.dir, caller.worker));
    const prUrl = input.prUrl ?? caller.worker.pr?.url ?? /https:\/\/(?:github\.com|gitlab\.com)\/[^\s)<>]+\/(?:pull|merge_requests)\/\d+/.exec(input.text)?.[0];
    let ackId: string | undefined;
    if (input.kind !== 'test') {
      const formatted = [
        `${caller.worker.name}: ${input.kind}`,
        input.text,
        ...(input.options?.length ? [`Options: ${input.options.map((o, i) => `${i + 1}. ${o}`).join(' | ')}`] : []),
        ...(prUrl ? [`PR: ${prUrl}`] : []),
        ...(sha ? [`Commit: ${sha}`] : []),
      ].join('\n');
      const enqueued = this.store.enqueueMessage(leadId, formatted.slice(0, 24_000), caller.floor.id);
      if (enqueued.message) ackId = enqueued.message.id;
    }
    const id = ackId ?? `test-${randomBytes(8).toString('hex')}`;
    const ackNote = ackId ? " Acknowledge only this item's ackId once handled." : '';
    const item: GrokWebhookItem = {
      id,
      ...(ackId ? { ackId } : {}),
      kind: input.kind,
      at: new Date(now).toISOString(),
      floor: { id: caller.floor.id, name: caller.floor.name, cwd: caller.floor.dir },
      worker: webhookWorkerFromMember(member, caller.worker),
      text: input.text,
      ...(input.options?.length ? { options: [...input.options] } : {}),
      ...(prUrl ? { prUrl } : {}),
      ...(sha ? { pushedSha: sha } : {}),
      actionHint:
        input.kind === 'test'
          ? 'Connectivity verification ping from Droid Office; no action or acknowledgment required.'
          : input.kind === 'question'
            ? `Send an answer to this worker on this floor.${ackNote}`
            : `Check this worker's status or send guidance on this floor if needed.${ackNote}`,
    };
    this.queuePush(leadId, { type: 'direct', id, item });
    const receipt = await this.flushLeadPush(leadId);
    return {
      ok: Boolean(receipt?.ok),
      ...(receipt?.status !== undefined ? { status: receipt.status } : {}),
      ...(receipt?.error ? { error: receipt.error } : {}),
      ...(ackId ? { ackId } : {}),
      lead: lead.name,
    };
  }

  /** Sends a clearly marked test event from Settings → Tailscale MCP to verify a Grok Bot's webhook. */
  async testWebhook(id: string, note = 'Connectivity test from Droid Office Settings.'): Promise<GrokWebhookResult> {
    const bot = this.store.identity(id);
    const target = this.store.grokWebhook(id);
    if (!bot || !target) throw new Error('Configure a Grok Bot webhook on this bot first');
    const now = (this.opts.now ?? Date.now)();
    const payload = buildGrokWebhookPayload(
      { id: bot.id, name: bot.name },
      [
        {
          id: `test-${randomBytes(8).toString('hex')}`,
          kind: 'test',
          at: new Date(now).toISOString(),
          text: `${note}\nPlease reply to the owner confirming you received this test ping and report all non-secret details you received.`,
          actionHint:
            'Reply to the owner to acknowledge this connectivity test. Include all non-secret payload details: event, test flag, source, version, summary, lead id and name, sentAt, and every item field (including id, kind, at, text and actionHint). Include any request id or other non-secret request metadata you received; say when a request id is absent rather than inventing one. Never include Authorization headers, webhook keys, tokens or other secrets. This is a test, not a worker task; do not acknowledge it via office_inbox.',
        },
      ],
      now,
    );
    const result = await sendGrokWebhook(target, payload, { fetchImpl: this.opts.fetchImpl, timeoutMs: this.opts.webhookTimeoutMs });
    this.store.recordDelivery(id, { at: now, ok: result.ok, ...(result.status !== undefined ? { status: result.status } : {}), event: 'test', ...(result.error ? { error: result.error } : {}) });
    return result;
  }

  flushLeadPush(leadId: string): Promise<GrokWebhookResult | undefined> {
    const timer = this.timers.get(leadId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(leadId);
    }
    const prev = this.inFlight.get(leadId) ?? Promise.resolve(undefined);
    const next = prev.catch(() => undefined).then(() => this.deliverPending(leadId));
    this.inFlight.set(leadId, next);
    void next.finally(() => {
      if (this.inFlight.get(leadId) === next) this.inFlight.delete(leadId);
    });
    return next;
  }

  private onTeamEvent(floor: RemoteFloor, event: TeamEvent) {
    if (this.stopped || !this.store.isGrokBot(event.lead)) return;
    if (event.kind === 'done') {
      const member = floor.team.roster(event.lead).find((m) => m.id === event.worker);
      if (member && (member.openQuestion !== undefined || member.awaitingJob)) return;
    }
    const id = `team:${floor.id}:${event.seq}`;
    if (this.pushedIds.has(id)) return;
    this.queuePush(event.lead, { type: 'team', id, floor, event });
    this.scheduleFlush(event.lead);
  }

  private queuePush(leadId: string, entry: PendingPush) {
    let map = this.pending.get(leadId);
    if (!map) {
      map = new Map();
      this.pending.set(leadId, map);
    }
    if (!map.has(entry.id)) map.set(entry.id, entry);
  }

  private scheduleFlush(leadId: string) {
    if (this.stopped || this.timers.has(leadId)) return;
    const delay = this.opts.webhookDelayMs ?? WEBHOOK_DELAY_MS;
    const timer = setTimeout(() => {
      this.timers.delete(leadId);
      void this.flushLeadPush(leadId);
    }, delay);
    timer.unref?.();
    this.timers.set(leadId, timer);
  }

  private clearLeadQueue(leadId: string) {
    const timer = this.timers.get(leadId);
    if (timer) clearTimeout(timer);
    this.timers.delete(leadId);
    this.pending.delete(leadId);
    for (const [deliveryId, rec] of this.webhookDeliveries) {
      if (rec.leadId === leadId) this.webhookDeliveries.delete(deliveryId);
    }
  }

  /** Resolves the exact item ackIds delivered in one Grok Bot webhook POST for payload-scoped reads and acks. */
  deliveryAckIds(leadId: string, deliveryId: string): string[] | undefined {
    const found = this.webhookDeliveries.get(deliveryId);
    return found?.leadId === leadId ? [...found.ackIds] : undefined;
  }

  private async deliverPending(leadId: string): Promise<GrokWebhookResult | undefined> {
    const queued = this.pending.get(leadId);
    if (!queued?.size) return undefined;
    const entries = [...queued.values()];
    this.pending.delete(leadId);
    const bot = this.store.identity(leadId);
    const target = this.store.grokWebhook(leadId);
    if (!bot || !target) return undefined;
    for (const entry of entries) {
      this.pushedIds.add(entry.id);
      if (this.pushedIds.size > PUSHED_HISTORY_MAX) {
        const oldest = this.pushedIds.values().next().value;
        if (oldest) this.pushedIds.delete(oldest);
      }
    }
    const items = entries.map((entry) => this.materializeItem(leadId, entry));
    const ackIds = items.flatMap((item) => (item.ackId ? [item.ackId] : []));
    const deliveryId = ackIds.length ? `whk-${randomBytes(8).toString('hex')}` : undefined;
    if (deliveryId) {
      this.webhookDeliveries.set(deliveryId, { leadId, ackIds });
      while (this.webhookDeliveries.size > PUSHED_HISTORY_MAX) {
        const oldest = this.webhookDeliveries.keys().next().value;
        if (oldest) this.webhookDeliveries.delete(oldest);
      }
    }
    const now = (this.opts.now ?? Date.now)();
    const payload = buildGrokWebhookPayload({ id: bot.id, name: bot.name }, items, now, deliveryId);
    const result = await sendGrokWebhook(target, payload, { fetchImpl: this.opts.fetchImpl, timeoutMs: this.opts.webhookTimeoutMs });
    this.store.recordDelivery(leadId, {
      at: now,
      ok: result.ok,
      ...(result.status !== undefined ? { status: result.status } : {}),
      event: payload.event,
      ...(result.error ? { error: result.error } : {}),
    });
    return result;
  }

  private materializeItem(leadId: string, entry: PendingPush): GrokWebhookItem {
    if (entry.type === 'direct') return entry.item;
    if (entry.type === 'inbox') {
      const m = entry.message;
      const f = m.floor ? this.floors().find((x) => x.id === m.floor) : undefined;
      return {
        id: m.id,
        ackId: m.id,
        kind: 'message',
        at: new Date(m.at).toISOString(),
        ...(f ? { floor: { id: f.id, name: f.def.name, cwd: f.dir } } : {}),
        text: m.text,
        actionHint: "Acknowledge only this item's ackId after handling this message.",
      };
    }
    const { floor, event } = entry;
    const member = floor.team.roster(leadId).find((m) => m.id === event.worker);
    const worker = floor.workers.get(event.worker);
    const openQuestion = event.kind === 'needs_input' && worker ? terminalQuestion(floor, worker) : undefined;
    return buildTeamWebhookItem({
      event,
      floor: { id: floor.id, name: floor.def.name, cwd: floor.dir },
      member,
      worker,
      openQuestion,
    });
  }

  list(id: string) {
    return this.floors().map((f) => ({
      id: f.id,
      name: f.def.name,
      cwd: f.dir,
      subagents: f.workers.list().filter((w) => w.lead === id).length,
      unreadTeam: f.team.inbox(id).length,
    }));
  }

  inbox(id: string, ack: readonly string[] = [], limit = 50, own = true, filter?: { ids?: readonly string[]; deliveryId?: string }) {
    const deliveryIds = filter?.deliveryId !== undefined ? (this.deliveryAckIds(id, filter.deliveryId) ?? []) : undefined;
    const scopedList = filter?.ids !== undefined || filter?.deliveryId !== undefined ? [...(deliveryIds ?? []), ...(filter?.ids ?? [])] : undefined;
    const onlyIds = scopedList ? new Set(scopedList) : undefined;
    const expandedAck: string[] = [];
    for (const rawEntry of ack) {
      const entry = rawEntry.trim();
      const fromDelivery = this.deliveryAckIds(id, entry);
      if (fromDelivery) expandedAck.push(...fromDelivery);
      else expandedAck.push(entry);
    }
    const ignoredAck = onlyIds ? expandedAck.filter((a) => !onlyIds.has(a)) : [];
    const effectiveAck = onlyIds ? expandedAck.filter((a) => onlyIds.has(a)) : expandedAck;
    const storeLimit = onlyIds ? Math.max(500, onlyIds.size) : 500;
    const messages: Array<{ id: string; floor?: string; at: number; kind: string; text: string; acked?: boolean }> = own ? this.store.inbox(id, effectiveAck, storeLimit, onlyIds).messages.map((m) => ({ ...m, kind: 'message' })) : [];
    for (const floor of this.floors()) {
      const prefix = `team:${floor.id}:`;
      const heard = effectiveAck
        .filter((s) => s.startsWith(prefix))
        .map((s) => Number(s.slice(prefix.length)))
        .filter(Number.isSafeInteger);
      const unacked = floor.team.inbox(id, heard);
      if (!onlyIds) {
        for (const e of unacked) messages.push({ id: `${prefix}${e.seq}`, floor: floor.id, at: e.at, kind: e.kind, text: `${e.name}: ${e.kind}${e.text ? `\n${e.text}` : ''}` });
      } else {
        const wantedSeqs = new Set(
          [...onlyIds]
            .filter((s) => s.startsWith(prefix))
            .map((s) => Number(s.slice(prefix.length)))
            .filter(Number.isSafeInteger),
        );
        if (!wantedSeqs.size) continue;
        const unackedSeqs = new Set(unacked.map((e) => e.seq));
        const allEvents = typeof floor.team.news === 'function' ? floor.team.news(id) : unacked;
        for (const e of allEvents) {
          if (!wantedSeqs.has(e.seq)) continue;
          messages.push({
            id: `${prefix}${e.seq}`,
            floor: floor.id,
            at: e.at,
            kind: e.kind,
            text: `${e.name}: ${e.kind}${e.text ? `\n${e.text}` : ''}`,
            acked: !unackedSeqs.has(e.seq),
          });
        }
      }
    }
    messages.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    const shown = messages.slice(0, limit);
    if (!onlyIds) return { messages: shown, remaining: Math.max(0, messages.length - limit), floors: this.list(id) };
    const foundIds = new Set(messages.map((m) => m.id));
    const missingIds = [...onlyIds].filter((want) => !foundIds.has(want));
    const totalUnacked = messages.filter((m) => !m.acked).length;
    const shownUnacked = shown.filter((m) => !m.acked).length;
    return {
      messages: shown,
      remaining: Math.max(0, totalUnacked - shownUnacked),
      filtered: true as const,
      ...(missingIds.length ? { missingIds } : {}),
      ...(ignoredAck.length ? { ignoredAck } : {}),
      floors: this.list(id),
    };
  }

  /** `since` holds a status cursor per floor; a floor it leaves out reports everything it keeps. */
  async team(worker: WorkerInfo, args: { action: string; worker?: string; lines?: number; text?: string; floor?: string; since?: Record<string, number>; kinds?: string[]; [key: string]: unknown }): Promise<TeamReply> {
    if (args.action === 'send' && !args.text?.trim()) return { status: 400, body: { error: 'Provide text for team_message.' } };
    const all = this.floors();
    const named = args.floor === undefined ? undefined : floorNamed(all, args.floor);
    if (typeof named === 'string') return { status: 404, body: { error: named } };
    if (args.action === 'hire') {
      const repo = typeof args.repo === 'string' ? floorNamed(all, args.repo) : undefined;
      if (typeof repo === 'string') return { status: 404, body: { error: repo } };
      if (repo && named && repo !== named) return { status: 400, body: { error: `floor and task.repo name different floors (${named.def.name} and ${repo.def.name}). Name one floor.` } };
      const target = repo ?? named;
      if (!target) return { status: 400, body: { error: 'Name the floor to hire on: floor or task.repo takes an open floor’s id, name or path (office_floors lists them).' } };
      return target.team.handle(worker, { ...args, ...(repo ? { repo: target.dir } : {}) });
    }
    const floors = named ? [named] : all;
    if (!floors.length) return { status: 404, body: { error: 'No floor is open.' } };
    if (args.action === 'watch') {
      const enable = args.watch !== false;
      if (args.all === true) {
        if (args.worker !== undefined || args.workers !== undefined) return { status: 400, body: { error: 'Choose exactly one of worker, workers, or all: true.' } };
        const replies = await Promise.all(floors.map(async (f) => ({ floor: f.id, reply: await f.team.handle(worker, { action: 'watch', all: true, watch: enable }) })));
        const watching = replies.flatMap(({ floor, reply }) => ((reply.body.watching as Record<string, unknown>[] | undefined) ?? []).map((w) => ({ ...w, floor })));
        const results = replies.flatMap(({ floor, reply }) => ((reply.body.results as Record<string, unknown>[] | undefined) ?? []).map((r) => ({ ...r, floor })));
        return {
          status: 200,
          body: {
            watch: enable,
            results,
            watching,
            ...(!results.length ? { note: enable ? 'No independent workers on the selected floor(s) to watch.' : 'You were not watching any workers on the selected floor(s).' } : {}),
          },
        };
      }
      const refs = Array.isArray(args.workers) ? (args.workers as string[]) : args.worker ? [args.worker] : [];
      if (!refs.length || (args.worker !== undefined && args.workers !== undefined)) {
        return { status: 400, body: { error: 'Choose exactly one of worker, workers, or all: true.' } };
      }
      const results: Record<string, unknown>[] = [];
      const seen = new Set<string>();
      for (const ref of refs) {
        const want = String(ref).trim().toLowerCase();
        const found = floors.flatMap((f) =>
          f.workers
            .list()
            .filter((w) => w.id !== worker.id && !w.remote && (w.id.toLowerCase() === want || w.name.toLowerCase() === want || w.name.replace(/ 🐚$/, '').toLowerCase() === want))
            .map((w) => ({ f, w })),
        );
        if (found.length !== 1) {
          results.push({ id: String(ref), error: found.length ? 'That name occurs on several floors; use the worker id or specify floor' : `No worker called ${String(ref)}${named ? ` on ${named.def.name}` : ' in the building'}` });
          continue;
        }
        const { f, w } = found[0];
        if (seen.has(w.id)) continue;
        seen.add(w.id);
        const reply = await f.team.handle(worker, { action: 'watch', worker: w.id, watch: enable });
        const entry = ((reply.body.results as Record<string, unknown>[] | undefined) ?? [])[0];
        results.push(reply.status < 400 && entry ? { ...entry, floor: f.id } : { id: w.id, name: w.name, floor: f.id, error: String(reply.body.error ?? 'Could not update watch') });
      }
      const okAny = results.some((r) => !r.error);
      if (!okAny && results.length === 1) {
        const err = String(results[0].error);
        return { status: err.startsWith('No worker called') ? 404 : 409, body: { error: err, results } };
      }
      if (!okAny) {
        return { status: 409, body: { error: results.map((r) => `${r.name ?? r.id}: ${r.error}`).join('\n'), results } };
      }
      const watching = floors.flatMap((f) =>
        f.team
          .roster(worker.id)
          .filter((m) => m.watched)
          .map((m) => ({ ...m, floor: f.id })),
      );
      return { status: 200, body: { watch: enable, results, watching } };
    }
    const matchesFor = (ref: string) => {
      const wanted = ref.trim().toLowerCase();
      return floors.flatMap((f) =>
        f.workers
          .list()
          .filter((w) => (w.lead === worker.id || f.team.isWatching?.(worker.id, w.id)) && (w.id === wanted || w.name.toLowerCase() === wanted || w.name.replace(/ 🐚$/, '').toLowerCase() === wanted))
          .map((w) => ({ f, w })),
      );
    };
    if (args.action === 'send' && (args.all === true || Array.isArray(args.workers))) {
      const refs =
        args.all === true
          ? floors.flatMap((f) =>
              f.workers
                .list()
                .filter((w) => w.lead === worker.id)
                .map((w) => w.id),
            )
          : (args.workers as string[]);
      if (!refs.length) return { status: 400, body: { error: 'No subagents selected for this broadcast.' } };
      const results: TeamDelivery[] = [];
      const seen = new Set<string>();
      for (const ref of refs) {
        const matches = matchesFor(ref);
        if (matches.length !== 1) {
          results.push({ id: ref, error: matches.length ? 'That name occurs on several floors; use the worker id or specify floor' : 'No such subagent in your teams' });
          continue;
        }
        const { f, w } = matches[0];
        if (seen.has(w.id)) continue;
        seen.add(w.id);
        const result = await f.team.handle(worker, { action: 'send', worker: w.id, text: args.text, queue: args.queue, urgent: args.urgent });
        results.push({ id: w.id, name: w.name, floor: f.id, ...result.body });
      }
      return teamDeliveryReply(results);
    }
    if (args.worker) {
      const matches = matchesFor(args.worker);
      if (!matches.length && (args.action === 'diff' || args.action === 'review')) {
        const wanted = args.worker.trim().toLowerCase();
        const former = floors.flatMap((f) => (f.team.formerMatches?.(worker.id, args.worker!) ?? []).map((m) => ({ f, id: m.id, name: m.name })));
        const exact = former.filter((m) => m.id.toLowerCase() === wanted);
        const picked = exact.length ? exact : former;
        if (picked.length === 1) return picked[0].f.team.handle(worker, { ...args, worker: picked[0].id });
        if (picked.length > 1) return { status: 409, body: { error: `${args.worker} names more than one former subagent; use the worker id${floors.length > 1 ? ' or specify floor' : ''}` } };
      }
      if (matches.length !== 1) return { status: matches.length ? 409 : 404, body: { error: matches.length ? 'That name occurs on several floors; use the worker id or specify floor' : 'No such subagent in your teams' } };
      const { f, w } = matches[0];
      const result = await f.team.handle(worker, { ...args, worker: w.id, since: args.since ? args.since[f.id] : undefined });
      if (args.action !== 'status' || result.status >= 400) return result;
      // Every floor's position, so this cursor also serves a later status of the whole building.
      const latest = Object.fromEntries(floors.map((x) => [x.id, x === f ? result.body.latest : x.team.latest()]));
      return { status: 200, body: { ...result.body, ...merged([{ floor: f.id, result }]), latest } };
    }
    if (args.action !== 'status') return { status: 400, body: { error: 'Name a subagent' } };
    const snapshots = await Promise.all(floors.map(async (f) => ({ floor: f.id, result: await f.team.handle(worker, { ...args, since: args.since ? args.since[f.id] : undefined }) })));
    return { status: 200, body: merged(snapshots) };
  }
}

/** Floor snapshots as one status, each subagent and event tagged with its floor, and each floor's latest event seq. */
function merged(snapshots: { floor: string; result: TeamReply }[]): Record<string, unknown> {
  const otherWorkers = snapshots.flatMap(({ floor, result }) => ((result.body.otherWorkers as Record<string, unknown>[] | undefined) ?? []).map((w) => ({ ...w, floor })));
  return {
    team: snapshots.flatMap(({ floor, result }) => ((result.body.team as Record<string, unknown>[] | undefined) ?? []).map((w) => ({ ...w, floor }))),
    ...(otherWorkers.length ? { otherWorkers } : {}),
    events: snapshots.flatMap(({ floor, result }) => ((result.body.events as Record<string, unknown>[] | undefined) ?? []).map((e) => ({ ...e, floor }))),
    latest: Object.fromEntries(snapshots.map(({ floor, result }) => [floor, result.body.latest])),
  };
}

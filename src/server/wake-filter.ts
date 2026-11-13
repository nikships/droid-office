// The inter-agent noise gate and smart lead wakeup filter (docs/office-mcp.md#inter-agent-noise-gate).
// One `gemini-decision-1` forward pass per message weighs what the lead waits on, the team board,
// the sender's recent chatter and the message itself, then routes it: wake the lead now, hold it
// until the batch of running teammates settles, record it without waking anyone, or (rarely, under
// deterministic guardrails and two agreeing high-confidence answers) coach the sender instead.
// Every failure delivers exactly as before.

import { emptyWakeFilterTelemetry, type WakeFilterTelemetry, type WakeTraffic } from '../shared/gemini-vibes.js';
import { callGeminiDecisions, type DecisionAnswer, type DecisionQuestion, type FetchLike, type GeminiDecisionsStore, redactGeminiSecrets } from './gemini-decisions.js';

export type WakeChannel = 'team_report' | 'done' | 'lead_notify' | 'team_note' | 'visit_tell';

export const WAKE_TIMEOUT_MS = 2500;
/** `block_and_coach` needs the traffic choice at least this sure... */
export const BLOCK_TRAFFIC_MIN = 0.85;
/** ...and the independent pure-chatter check at least this sure. */
export const BLOCK_CHATTER_MIN = 0.88;
/** A quieter-than-wake route needs at least this much of the traffic probability; less wakes. */
export const QUIET_MIN = 0.5;
/** A working sibling is interrupted mid-turn by a team_note only at or above this relevance. */
export const SIBLING_NOTICE_MIN = 0.6;
export const CHATTER_WINDOW_MS = 5 * 60_000;
const MAX_SIBLING_QUESTIONS = 12;
const MAX_TEAMMATES = 14;
const MAX_INPUT_CHARS = 14_000;
const TEXT_MAX = 3000;
const TAIL_MAX = 1400;
const TASK_MAX = 600;
const STEPS_MAX = 12;

export interface WakeLeadView {
  id: string;
  name: string;
  /** A building agent (Orchestrator or a Grok Bot) whose team spans every open floor. */
  building?: boolean;
  status?: string;
  task?: string;
  steps?: { content: string; status: string }[];
  tail?: string;
}

export interface WakeTeammate {
  id: string;
  name: string;
  status: string;
  task?: string;
  areas?: string[];
  note?: string;
  report?: { kind: string; summary: string; status?: string };
  floor?: string;
}

export interface WakeMessage {
  text: string;
  /** team_report progress: true (the sender ends its turn waiting on its own background job). */
  progress?: boolean;
  question?: boolean;
  /** lead_notify kind or visit kind. */
  kind?: string;
  urgent?: boolean;
  resultStatus?: string;
  conflicts?: number;
  pushedSha?: string;
  /** The sender's previously seen pushed SHA, so an unchanged branch head is not a new commit. */
  previousSha?: string;
  /** Pull requests the sender already announced, so repeating one is not news. */
  previousPrs?: string[];
  prUrl?: string;
  commits?: number;
  files?: string[];
  images?: number;
  areas?: string[];
  /** team_note: this note declares or changes the sender's edit areas. */
  areasChanged?: boolean;
}

export interface WakePacket {
  channel: WakeChannel;
  lead: WakeLeadView;
  sender: { id: string; name: string; task?: string; areas?: string[] };
  /** The lead's other teammates (sender excluded), across open floors for building leads. */
  teammates: WakeTeammate[];
  /** team_note: working siblings who have not reported this turn and would be interrupted. */
  siblings?: WakeTeammate[];
  message: WakeMessage;
}

export type WakeSource = 'model' | 'guard' | 'bypass' | 'fail_open';

export interface WakeVerdict {
  traffic: WakeTraffic;
  source: WakeSource;
  reason: string;
  /** block_and_coach: what the sender is told instead of delivery. */
  coach?: string;
  /** team_note: sibling ids to notify mid-turn; undefined notifies every candidate as before. */
  notify?: string[];
  probabilities?: Partial<Record<WakeTraffic, number>>;
  pureChatter?: number;
  latencyMs?: number;
  inputTokens?: number;
}

/** What the team, visits and lead_notify need: a fail-open router that may be off. */
export interface WakeGate {
  active(): boolean;
  decide(packet: WakePacket): Promise<WakeVerdict>;
}

export interface ChatterStats {
  /** Routine updates (no new commit, PR, blocker or question) in the last five minutes. */
  routine: number;
  total: number;
  sinceLastMs?: number;
}

export interface WakeGuard {
  forced?: WakeTraffic;
  reason?: string;
  /** Deterministic guardrails allow block_and_coach at all. */
  blockable: boolean;
  /** Why blocking is ruled out, for the audit trail. */
  noBlock: string[];
}

const ACTIVE = new Set(['working', 'starting']);
const UNBLOCKABLE_KINDS = new Set(['question', 'blocker', 'test', 'ask', 'handoff', 'reply']);

export function isActiveTeammate(t: Pick<WakeTeammate, 'status'>): boolean {
  return ACTIVE.has(t.status);
}

function turnEnding(p: WakePacket): boolean {
  return p.channel === 'done' || (p.channel === 'team_report' && !p.message.progress);
}

function hasArtifacts(m: WakeMessage): boolean {
  return Boolean(m.prUrl || (m.pushedSha && m.pushedSha !== m.previousSha) || (m.commits ?? 0) > 0 || (m.images ?? 0) > 0 || (m.conflicts ?? 0) > 0);
}

const SUBSTANCE: [string, RegExp][] = [
  ['question mark', /\?/],
  ['link', /\bhttps?:\/\//i],
  ['code span', /`/],
  ['file path', /(?:^|[\s(])[\w.@-]+\/[\w./@-]+|\b[\w-]+\.(?:ts|tsx|js|mjs|cjs|json|md|css|html|kt|kts|swift|py|go|rs|java|rb|yml|yaml|toml|sh|sql|mm|m|h|c|cc|cpp)\b/i],
  ['commit or hash', /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,64}\b/i],
  ['measured result', /\b\d+\s*(?:\/\s*\d+\s*)?(?:tests?|specs?|passed|passing|pass|failed|failing|fails?|files?|ms|sec|seconds?|minutes?|%|errors?|warnings?|lines?|commits?|prs?|issues?|cases?|events?|messages?)\b/i],
  ['issue or PR reference', /(?:^|\s)#\d+\b/],
  [
    'problem or decision word',
    /\b(?:error|errors|fail\w*|broke\w*|block\w*|stuck|conflict\w*|regress\w*|bug\w*|crash\w*|exception|warn\w*|breaking|contract|schema|interface|signature|migrat\w*|renam\w*|deprecat\w*|decid\w*|decision|question|unsure|unclear|help|permission|denied|timeout|timed out|cannot|can't|unable|revert\w*|secret|leak\w*|overlap\w*|merge\w*|rebase\w*|depend\w*|wait\w* on|need\w*|ask\w*|approve\w*|review\w*)\b/i,
  ],
];

/** Wording that asks the recipient to act: such a message always wakes, whatever the model thinks. */
const ASKS_FOR_ACTION =
  /\b(?:blocked on|blocker|need (?:your|a|the lead'?s?|an?) (?:decision|answer|call|approval|review|input|help|guidance)|needs? (?:your|lead) (?:decision|approval|input|review)|awaiting (?:your|lead|the lead|approval|a decision)|waiting (?:for|on) (?:your|you|the lead|lead|approval|a decision)|please (?:send|forward|confirm|approve|advise|decide|review|merge|reply|answer|let me know)|ready for (?:your|lead) (?:merge|review|approval)|requests? (?:ownership|approval|permission)|can you|could you|should i|do you want|which (?:option|approach) (?:do|should))\b/i;

const PR_LINK = /https:\/\/(?:github\.com|gitlab\.com)\/[^\s)<>\]]+\/(?:pull|merge_requests)\/\d+/g;

/** Pull requests the message names, by `prUrl` or a link in its text. */
export function pullRequestsOf(m: Pick<WakeMessage, 'text' | 'prUrl'>): string[] {
  return [...new Set([...(m.prUrl ? [m.prUrl] : []), ...(m.text.match(PR_LINK) ?? [])])];
}

/** The message asks its recipient to act or decide. */
export function asksForAction(text: string): boolean {
  return ASKS_FOR_ACTION.test(text);
}

/** Concrete content a message carries; any one rules out blocking it. */
export function substanceSignals(text: string): string[] {
  return SUBSTANCE.filter(([, re]) => re.test(text)).map(([name]) => name);
}

/** Deterministic routing that never depends on model probabilities. */
export function wakeGuard(p: WakePacket): WakeGuard {
  const m = p.message;
  const noBlock: string[] = [];
  let forced: WakeTraffic | undefined;
  let reason: string | undefined;
  if (m.question) [forced, reason] = ['wake_immediately', 'question'];
  else if (m.kind && UNBLOCKABLE_KINDS.has(m.kind) && p.channel !== 'visit_tell') [forced, reason] = ['wake_immediately', `kind ${m.kind}`];
  else if (m.urgent && p.channel !== 'visit_tell') [forced, reason] = ['wake_immediately', 'urgent'];
  else if (m.resultStatus === 'failed' || m.resultStatus === 'blocked') [forced, reason] = ['wake_immediately', `result ${m.resultStatus}`];
  else if ((m.conflicts ?? 0) > 0) [forced, reason] = ['wake_immediately', 'merge conflicts'];
  else if (p.channel !== 'visit_tell' && asksForAction(m.text)) [forced, reason] = ['wake_immediately', 'asks for action'];
  else if ((p.channel === 'lead_notify' || (p.channel === 'team_report' && m.progress)) && pullRequestsOf(m).some((pr) => !m.previousPrs?.includes(pr))) [forced, reason] = ['wake_immediately', 'new pull request'];
  else if (turnEnding(p) && !p.teammates.some(isActiveTeammate)) [forced, reason] = ['wake_immediately', 'last active teammate finished'];

  if (m.question) noBlock.push('question');
  if (m.kind && UNBLOCKABLE_KINDS.has(m.kind)) noBlock.push(`kind ${m.kind}`);
  if (m.urgent) noBlock.push('urgent');
  if (p.channel === 'team_report' || p.channel === 'done') noBlock.push(`${p.channel} always records`);
  if (p.channel === 'lead_notify' && m.kind !== 'update') noBlock.push('lead_notify beyond update');
  if (p.channel === 'visit_tell' && m.kind !== 'tell') noBlock.push('visit beyond tell');
  if (p.channel === 'team_note' && m.areasChanged) noBlock.push('team_note declares areas');
  if (hasArtifacts(m)) noBlock.push('artifacts');
  const signals = substanceSignals(m.text);
  if (signals.length) noBlock.push(...signals);
  if (m.text.trim().length > 600) noBlock.push('long message');
  return { ...(forced ? { forced, reason } : {}), blockable: noBlock.length === 0, noBlock };
}

const clip = (s: string | undefined, n: number): string => {
  const flat = (s ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};
const quote = (s: string) => s.replace(/"/g, "'");

const CHANNEL_WORDS: Record<WakeChannel, string> = {
  team_report: 'team_report (a subagent reporting to its lead as it ends its turn)',
  done: 'done (a subagent ended its turn without sending a report)',
  lead_notify: 'lead_notify (a mid-turn push from a working subagent to its Grok Bot lead webhook)',
  team_note: 'team_note (a short sibling note shown on the team board and, mid-turn, to working siblings)',
  visit_tell: 'visit_message tell (an informational message from one independent worker to another busy worker)',
};

const TRAFFIC_CRITERIA: Record<WakeTraffic, string> = {
  wake_immediately:
    'The recipient should act on this now: a real blocker, error or failure, a question or decision fork, a contract, schema or shared-file discovery that changes others’ work, a concrete result the lead is specifically waiting on, or the final expected teammate finishing so the batch is complete.',
  hold_for_batch: 'A clean completion from one teammate while other teammates on the same lead are still actively working, and the lead needs the whole set before acting or merging; nothing here needs action before the others finish.',
  record_silently: 'A routine mid-task status or progress update (a phase done, starting the next step, checks green so far, waiting on CI, diary-style narration) worth keeping on record but needing no action or interruption now.',
  block_and_coach: 'Purely performative chatter: repetitive self-narration, empty courtesy or enthusiasm, with zero concrete findings, file paths, contract details, test outcomes, blockers or questions.',
};

const PURE_CHATTER =
  'Is this incoming message purely performative status chatter, repetitive self-narration, or empty courtesy containing ZERO concrete technical findings, file paths, contract details, test outcomes, blockers, or questions?';

function teammateLine(t: WakeTeammate): string {
  return [
    `- [${isActiveTeammate(t) ? 'active' : 'settled'}] ${t.name}${t.floor ? ` (floor ${t.floor})` : ''}: status ${t.status}`,
    t.task ? `task: ${clip(t.task, 160)}` : '',
    t.areas?.length ? `areas: ${clip(t.areas.join(', '), 160)}` : '',
    t.note ? `note: ${clip(t.note, 160)}` : '',
    t.report ? `latest ${t.report.kind}${t.report.status ? ` (${t.report.status})` : ''}: ${clip(t.report.summary, 180)}` : '',
  ]
    .filter(Boolean)
    .join(' | ');
}

/** The scrubbed context packet and question map for one message, in one request. */
export function buildWakeRequest(p: WakePacket, chatter: ChatterStats, secrets: readonly (string | undefined)[] = []): { input: string; questions: Record<string, DecisionQuestion>; siblingKeys: [string, WakeTeammate][] } {
  const scrub = (s: string) => redactGeminiSecrets(s, secrets);
  const lead = p.lead;
  const active = p.teammates.filter(isActiveTeammate);
  const resting = lead.status === 'done' || lead.status === 'idle' || lead.status === undefined;
  const m = p.message;
  const lines: string[] = [
    '## What the lead waits on',
    `Lead "${quote(lead.name)}" (${lead.building ? 'building lead whose team spans every open floor' : 'floor lead'}), status ${lead.status ?? 'unknown'} (${resting ? 'resting: delivering wakes it for a new turn' : 'mid-turn: it reads news at its next status check'}).`,
    ...(lead.task ? [`Lead task: ${clip(lead.task, TASK_MAX)}`] : []),
    ...(lead.steps?.length ? ['Lead plan (TodoWrite):', ...lead.steps.slice(0, STEPS_MAX).map((s) => `  [${s.status}] ${clip(s.content, 140)}`)] : []),
    ...(lead.tail?.trim()
      ? [
          'Lead recent terminal:',
          ...lead.tail
            .trim()
            .slice(-TAIL_MAX)
            .split('\n')
            .map((l) => `  ${l}`),
        ]
      : []),
    '',
    `## Team board: ${p.teammates.length} other teammates, ${active.length} actively mid-turn, ${p.teammates.length - active.length} settled`,
    ...p.teammates.slice(0, MAX_TEAMMATES).map(teammateLine),
    ...(p.teammates.length > MAX_TEAMMATES ? [`(${p.teammates.length - MAX_TEAMMATES} more not shown)`] : []),
    '',
    '## Sender',
    `${p.sender.name}${p.sender.task ? `, task: ${clip(p.sender.task, 240)}` : ''}${p.sender.areas?.length ? `, areas: ${clip(p.sender.areas.join(', '), 200)}` : ''}.`,
    `Sender chatter: ${chatter.routine} routine updates in the last 5 minutes without a new commit, PR, blocker or question (${chatter.total} messages total)${chatter.sinceLastMs !== undefined ? `; previous update ${Math.round(chatter.sinceLastMs / 1000)}s ago` : '; no earlier update'}.`,
    '',
    '## Incoming message',
    `Channel: ${CHANNEL_WORDS[p.channel]}${m.kind ? `, kind ${m.kind}` : ''}${m.progress ? ', progress: true (not finished; waits on its own background job)' : ''}${m.urgent ? ', urgent' : ''}.`,
    `Artifacts: ${
      [
        m.pushedSha ? `pushed commit ${m.pushedSha.slice(0, 12)}${m.pushedSha === m.previousSha ? ' (unchanged since its last message)' : ''}` : '',
        m.prUrl ? `PR ${m.prUrl}` : '',
        m.commits ? `${m.commits} commits` : '',
        m.files?.length ? `files ${clip(m.files.join(', '), 240)}` : '',
        m.images ? `${m.images} images` : '',
        m.conflicts ? `${m.conflicts} conflicts` : '',
        m.areas?.length ? `${m.areasChanged ? 'new ' : ''}areas ${clip(m.areas.join(', '), 200)}` : '',
      ]
        .filter(Boolean)
        .join('; ') || 'none'
    }.`,
    ...(m.resultStatus ? [`Result status: ${m.resultStatus}.`] : []),
    'Text:',
    m.text.trim().slice(0, TEXT_MAX),
  ];
  let input = scrub(lines.join('\n'));
  if (input.length > MAX_INPUT_CHARS) input = `${input.slice(0, MAX_INPUT_CHARS - 1)}…`;

  const recipient = p.channel === 'team_note' ? 'working siblings' : p.channel === 'visit_tell' ? 'the busy recipient' : `lead "${quote(lead.name)}"`;
  const questions: Record<string, DecisionQuestion> = {
    traffic: {
      type: 'choice',
      instructions: scrub(
        `You route inter-agent traffic. Decide how this one incoming ${p.channel} message from "${quote(p.sender.name)}" should reach ${recipient}, weighing what the lead waits on (all teammates in a batch, one specific dependency, or any first finding), how many teammates are still actively mid-turn, how chatty the sender has been, and what the message concretely says.`,
      ),
      criteria: TRAFFIC_CRITERIA,
    },
    pure_chatter: { type: 'noul', instructions: PURE_CHATTER },
  };
  const siblingKeys: [string, WakeTeammate][] = [];
  if (p.channel === 'team_note') {
    (p.siblings ?? []).slice(0, MAX_SIBLING_QUESTIONS).forEach((s, i) => {
      const key = `sib_${i}`;
      siblingKeys.push([key, s]);
      questions[key] = {
        type: 'noul',
        instructions: scrub(
          `Teammate "${quote(s.name)}" is working on: ${clip(s.task, 220) || 'an unstated task'}. Declared edit areas: ${s.areas?.length ? clip(s.areas.join(', '), 200) : 'none'}. Does this note from "${quote(p.sender.name)}" contain a contract or interface change, a shared file overlap, or a finding that directly affects ${quote(s.name)}'s task or areas, so ${quote(s.name)} should be interrupted mid-turn to read it now?`,
        ),
      };
    });
  }
  return { input, questions, siblingKeys };
}

const areaKey = (a: string) => a.trim().replace(/[*]+$/, '').replace(/\/+$/, '');

/** Deterministic sibling relevance: the note names this sibling, cites one of its areas, or claims an overlapping area. */
export function siblingAddressed(p: WakePacket, s: WakeTeammate): boolean {
  const text = p.message.text;
  const name = s.name.replace(/ 🐚$/, '').trim();
  if (name && new RegExp(`(?:^|[^\\w])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^\\w]|$)`, 'i').test(text)) return true;
  const theirs = (s.areas ?? []).map(areaKey).filter((a) => a.length >= 3);
  if (theirs.some((a) => a.length >= 4 && text.includes(a))) return true;
  const mine = (p.message.areas ?? []).map(areaKey).filter((a) => a.length >= 3);
  return mine.some((m) => theirs.some((t) => m.startsWith(t) || t.startsWith(m)));
}

function trafficProbs(ans: DecisionAnswer | undefined): { choice?: WakeTraffic; probs: Partial<Record<WakeTraffic, number>> } {
  if (ans?.type !== 'choice' || !(ans.choice in TRAFFIC_CRITERIA)) return { probs: {} };
  const choice = ans.choice as WakeTraffic;
  const probs: Partial<Record<WakeTraffic, number>> = {};
  for (const k of Object.keys(TRAFFIC_CRITERIA) as WakeTraffic[]) if (ans.probabilities[k] !== undefined) probs[k] = ans.probabilities[k];
  if (probs[choice] === undefined) probs[choice] = ans.confidence;
  return { choice, probs };
}

export function coachText(p: WakePacket): string {
  const to = p.channel === 'team_note' ? 'your siblings' : p.channel === 'visit_tell' ? p.lead.name : p.lead.name;
  return `Noise gate: this read as status chatter with no concrete findings, so it was not delivered to ${to}. Stay heads-down on your task, and send it again once you have concrete outcomes (files, test results, commits or PRs), a blocker, or a question.`;
}

/** Turns the model's answers into a route under the guardrails; every unsure case wakes or records rather than blocks. */
export function resolveWakeAnswers(p: WakePacket, guard: WakeGuard, answers: Record<string, DecisionAnswer>, siblingKeys: [string, WakeTeammate][] = []): WakeVerdict {
  const { choice, probs } = trafficProbs(answers.traffic);
  const chatterAns = answers.pure_chatter;
  const pureChatter = chatterAns?.type === 'noul' ? chatterAns.noul : undefined;
  const activeOthers = p.teammates.filter(isActiveTeammate).length;
  const ending = turnEnding(p);
  const base = { source: 'model' as const, probabilities: probs, ...(pureChatter !== undefined ? { pureChatter } : {}) };
  let traffic: WakeTraffic = 'wake_immediately';
  let reason = choice ? `model chose ${choice}` : 'no traffic answer';

  if (guard.forced) {
    traffic = guard.forced;
    reason = `guard: ${guard.reason}`;
  } else if (choice === 'block_and_coach' && guard.blockable && (probs.block_and_coach ?? 0) >= BLOCK_TRAFFIC_MIN && (pureChatter ?? 0) >= BLOCK_CHATTER_MIN) {
    traffic = 'block_and_coach';
    reason = 'dual high-confidence chatter lock';
  } else if (choice && choice !== 'wake_immediately') {
    const quiet = choice === 'block_and_coach' ? (probs.block_and_coach ?? 0) + (probs.record_silently ?? 0) : (probs[choice] ?? 0);
    if (quiet < QUIET_MIN) reason = `${choice} below ${QUIET_MIN}`;
    else if (p.channel === 'team_note' && choice === 'hold_for_batch') reason = 'note held means relevant siblings hear it now';
    else if (choice === 'hold_for_batch' || ending) {
      // A completion may wait for its batch, but never goes unannounced.
      if ((p.channel === 'team_report' || p.channel === 'done') && activeOthers > 0) [traffic, reason] = ['hold_for_batch', `${choice} held for ${activeOthers} active teammates`];
      else if (!ending) [traffic, reason] = ['record_silently', `${choice} mid-turn`];
      else reason = `${choice} without active teammates`;
    } else {
      traffic = 'record_silently';
      reason = choice === 'block_and_coach' ? 'block downgraded under guardrails' : 'routine update';
    }
  }

  const verdict: WakeVerdict = { ...base, traffic, reason, ...(guard.forced ? { source: 'guard' as const } : {}) };
  if (traffic === 'block_and_coach') verdict.coach = coachText(p);
  if (p.channel === 'team_note') {
    const siblings = p.siblings ?? [];
    const addressed = siblings.filter((s) => siblingAddressed(p, s)).map((s) => s.id);
    if (traffic === 'record_silently' || traffic === 'block_and_coach') verdict.notify = traffic === 'block_and_coach' ? [] : addressed;
    else if (siblingKeys.length === siblings.length) {
      const relevant = new Set(
        siblingKeys
          .filter(([key]) => {
            const a = answers[key];
            return a?.type !== 'noul' || a.noul >= SIBLING_NOTICE_MIN;
          })
          .map(([, s]) => s.id),
      );
      verdict.notify = siblings.filter((s) => relevant.has(s.id) || addressed.includes(s.id)).map((s) => s.id);
    }
  }
  return verdict;
}

export interface WakeFilterOptions {
  store: Pick<GeminiDecisionsStore, 'apiKey' | 'connected' | 'wakeFilterOn' | 'rejected'>;
  airgapped: () => boolean;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
  /** Shares call accounting with the Gemini settings readout. */
  onUsage?: (inputTokens: number, latencyMs: number) => void;
  /** Telemetry changed. */
  onChange?: () => void;
  /** Every routed message, for the backtest audit trail. */
  onDecision?: (packet: WakePacket, verdict: WakeVerdict) => void;
}

interface ChatterEntry {
  at: number;
  routine: boolean;
}

/** Office-wide router shared by every floor's team, lead_notify and visit tells. */
export class WakeFilter implements WakeGate {
  private readonly chatter = new Map<string, ChatterEntry[]>();
  private readonly lastSha = new Map<string, string>();
  private readonly announcedPrs = new Map<string, Set<string>>();
  private stats: WakeFilterTelemetry = emptyWakeFilterTelemetry();

  constructor(private readonly opts: WakeFilterOptions) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  active(): boolean {
    const s = this.opts.store;
    return !this.opts.airgapped() && s.wakeFilterOn() && s.connected() && !s.rejected();
  }

  telemetry(): WakeFilterTelemetry {
    return { ...this.stats };
  }

  /** Rolling five-minute chatter for one sender. */
  chatterOf(senderId: string): ChatterStats {
    const now = this.now();
    const entries = (this.chatter.get(senderId) ?? []).filter((e) => now - e.at <= CHATTER_WINDOW_MS);
    const last = entries.at(-1);
    return { routine: entries.filter((e) => e.routine).length, total: entries.length, ...(last ? { sinceLastMs: now - last.at } : {}) };
  }

  /** The pushed SHA the sender carried last time, so an unchanged branch head is no new commit. */
  previousSha(senderId: string): string | undefined {
    return this.lastSha.get(senderId);
  }

  async decide(packet: WakePacket): Promise<WakeVerdict> {
    if (!this.active()) return { traffic: 'wake_immediately', source: 'bypass', reason: 'noise gate off' };
    const apiKey = this.opts.store.apiKey();
    if (!apiKey) return { traffic: 'wake_immediately', source: 'bypass', reason: 'no key' };
    const sender = packet.sender.id;
    const prs = this.announcedPrs.get(sender);
    const message = {
      ...packet.message,
      ...(packet.message.previousSha === undefined && this.lastSha.has(sender) ? { previousSha: this.lastSha.get(sender) } : {}),
      ...(packet.message.previousPrs === undefined && prs?.size ? { previousPrs: [...prs] } : {}),
    };
    const p: WakePacket = { ...packet, message };
    const guard = wakeGuard(p);
    let verdict: WakeVerdict;
    // Forced wakes on turn-ending channels need no model; notes still need per-sibling relevance.
    if (guard.forced && p.channel !== 'team_note') verdict = { traffic: guard.forced, source: 'guard', reason: `guard: ${guard.reason}` };
    else {
      const { input, questions, siblingKeys } = buildWakeRequest(p, this.chatterOf(p.sender.id), [apiKey]);
      const res = await callGeminiDecisions({ apiKey, input, questions, fetchImpl: this.opts.fetchImpl, timeoutMs: this.opts.timeoutMs ?? WAKE_TIMEOUT_MS, now: this.opts.now }).catch((err: unknown) => ({
        ok: false as const,
        status: 0,
        error: err instanceof Error ? err.message : 'failed',
      }));
      if (!res.ok || res.blockedReason) {
        this.stats.failedOpen += 1;
        this.stats.lastAt = this.now();
        this.opts.onChange?.();
        verdict = { traffic: 'wake_immediately', source: 'fail_open', reason: res.ok ? `skipped (${res.blockedReason})` : redactGeminiSecrets(res.error, [apiKey]).slice(0, 160) };
        this.opts.onDecision?.(p, verdict);
        return verdict;
      }
      this.opts.onUsage?.(res.inputTokens, res.latencyMs);
      verdict = { ...resolveWakeAnswers(p, guard, res.answers, siblingKeys), latencyMs: res.latencyMs, inputTokens: res.inputTokens };
      this.stats.lastLatencyMs = res.latencyMs;
    }
    this.count(p, verdict, guard);
    this.opts.onDecision?.(p, verdict);
    return verdict;
  }

  private count(p: WakePacket, v: WakeVerdict, guard: WakeGuard): void {
    const s = this.stats;
    s.evaluated += 1;
    if (v.traffic === 'wake_immediately') s.woken += 1;
    else if (v.traffic === 'hold_for_batch') s.held += 1;
    else if (v.traffic === 'record_silently') s.silent += 1;
    else s.blocked += 1;
    if (p.channel === 'team_note' && v.notify) s.siblingFiltered += Math.max(0, (p.siblings?.length ?? 0) - v.notify.length);
    s.lastAt = this.now();
    const m = p.message;
    const routine = !guard.forced && !pullRequestsOf(m).length && !(m.commits ?? 0) && !(m.pushedSha && m.pushedSha !== m.previousSha);
    const list = (this.chatter.get(p.sender.id) ?? []).filter((e) => s.lastAt! - e.at <= CHATTER_WINDOW_MS);
    list.push({ at: s.lastAt, routine });
    this.chatter.set(p.sender.id, list.slice(-50));
    if (m.pushedSha) this.lastSha.set(p.sender.id, m.pushedSha);
    const prs = pullRequestsOf(m);
    if (prs.length) this.announcedPrs.set(p.sender.id, new Set([...(this.announcedPrs.get(p.sender.id) ?? []), ...prs].slice(-20)));
    this.opts.onChange?.();
  }
}

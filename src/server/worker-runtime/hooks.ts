import path from 'node:path';
import type { WorkerInfo, WorkerStatus } from '../../shared/protocol.js';
import { inputQuestions, permissionLine } from '../../shared/ask-question.js';
import { toolRefresh, type ToolRefresh } from '../hook-refresh.js';
import { FAILS_TO_DESPAIR, outputFailed, toolAction } from '../../shared/actions.js';
import { officeSays, withoutReminders } from '../../shared/prompts.js';
import { readDroidQueue } from '../../shared/droid-queue.js';
import { todoItems, todoProgress } from '../../shared/todos.js';
import { readDroidScreen } from '../droid-screen.js';
import { screenRows, type Worker } from './state.js';
import { HOOK_EVENTS, HOOK_VERSION } from './hook-transport.js';
import { describeTool, permissionAsk, truncate } from './activity.js';
import type { WorkerDelivery } from './delivery.js';

interface HookContext {
  get(id: string): Worker | undefined;
  closing(): boolean;
  persist(): void;
  update(worker: Worker): void;
  setStatus(worker: Worker, status: WorkerStatus): void;
  setup(worker: Worker, report: Record<string, unknown>): boolean;
  refreshModel(worker: Worker): void;
  syncBranch(worker: Worker): Promise<void>;
  tool(workerId: string, refresh: ToolRefresh): void;
  notePrompt(worker: Worker, text: string): void;
  beforeStop(info: WorkerInfo): string | undefined;
  nextTurn(info: WorkerInfo): void;
  delivery: Pick<WorkerDelivery, 'sendLaunchPrompt'>;
}

/**
 * How long a Stop waits for another hook before the turn is done: a Stop hook that blocks shows up
 * as a new tool call or a second Stop well within it.
 */
export const STOP_GRACE_MS = 1200;
/** How long after Escape or Ctrl+C a Stop counts as the turn being cancelled (see stopped). */
const CANCEL_MS = 3000;
/** A worker's activity while Droid compacts its conversation (PreCompact, until the compact SessionStart). */
const COMPACTING = 'Compacting its conversation';
/** Tools that ask the person a question: droid's is AskUser. */
const ASK_TOOLS = new Set<unknown>(['AskUser', 'AskUserQuestion', 'request_user_input']);

/** Applies authenticated session/subagent hooks and owns the delayed Stop lifecycle. */
export class WorkerHooks {
  constructor(private context: HookContext) {}

  /** A hook from the worker's droid, live (`version`) or replayed from its spool (`at`, when it fired). */
  accept(w: Worker, event: string, payload: unknown, from: { version: number } | { at: number }): string | undefined {
    if (!payload || typeof payload !== 'object') return undefined;
    const report = payload as Record<string, unknown>;
    if (report.hook_event_name !== event) return undefined;
    if (event === 'WorktreeSetup') return this.context.setup(w, report) ? '' : undefined;
    if (w.info.kind !== 'agent' || typeof report.session_id !== 'string' || !report.session_id) return undefined;
    if (!HOOK_EVENTS.includes(event)) return undefined;
    const session = report.session_id;
    const caller = typeof report.calling_session_id === 'string' && report.calling_session_id ? report.calling_session_id : undefined;
    if (event === 'SessionStart' && caller) {
      // A subagent its droid just started (the Task tool): a session of its own, inside this one's turn.
      w.info.sessionId ??= caller;
      if (caller !== w.info.sessionId && !w.subSessions.has(caller)) return undefined;
      w.subSessions.add(session);
    }
    const sub = w.subSessions.has(session);
    if (!sub && event !== 'SessionStart' && w.info.sessionId && session !== w.info.sessionId) return undefined;
    const live = 'version' in from;
    if (live) w.hookVersion = from.version;
    w.hookAt = live ? Date.now() : from.at;
    // Any hook after a Stop means the turn went on: a Stop starts the grace again (see stopped).
    w.stopAt = undefined;
    const reply = sub ? this.subagentHook(w, event, report, live) : this.sessionHook(w, event, report, live && w.hookVersion >= HOOK_VERSION);
    this.context.update(w);
    this.context.persist();
    return reply ?? '';
  }

  /**
   * A hook from the worker's own session. With `replies` (a live hook from a command that prints
   * what the office answers), PostToolUse and Stop can carry its notices; the reply is returned.
   */
  private sessionHook(w: Worker, event: string, report: Record<string, unknown>, replies: boolean): string | undefined {
    const session = report.session_id as string;
    const transcript = report.transcript_path;
    if (typeof transcript === 'string' && path.isAbsolute(transcript) && path.basename(transcript) === `${session}.jsonl`) w.transcript = transcript;
    let reply: string | undefined;
    if (event === 'SessionStart' && report.source === 'compact') {
      // Compaction finished inside a turn: the same conversation carries on.
      w.info.sessionId = session;
      if (w.info.activity === COMPACTING) w.info.activity = undefined;
    } else if (event === 'SessionStart') {
      if ((w.info.sessionId && w.info.sessionId !== session) || report.source === 'clear') this.clearTask(w, report.source === 'clear');
      w.info.sessionId = session;
      w.pendingFork = undefined;
      w.subSessions.clear();
      w.lastTool.clear();
      w.currentTool = undefined;
      w.completedTool = undefined;
      w.activeTool.clear();
      w.bootBlocked = false;
      w.settingUp = false;
      w.queued = 0;
      w.sentQueue = [];
      w.info.activity = undefined;
      this.context.setStatus(w, 'idle');
      this.context.delivery.sendLaunchPrompt(w);
    } else if (event === 'UserPromptSubmit') {
      w.bootBlocked = false;
      w.currentTool = undefined;
      w.info.action = undefined;
      if (typeof report.prompt === 'string') {
        // The office's reminders after the owner's words (an Orchestrator prompt's floor) aren't what was asked.
        const said = withoutReminders(report.prompt) || report.prompt;
        w.info.activity = truncate(said, 80);
        this.context.notePrompt(w, said);
      }
      this.context.setStatus(w, 'working');
    } else if (event === 'PreToolUse') this.toolStarted(w, session, report);
    else if (event === 'PostToolUse') {
      if (w.currentTool && (!report.tool_name || w.currentTool.name === report.tool_name)) {
        w.completedTool = { ...w.currentTool, at: w.hookAt || Date.now() };
        w.currentTool = undefined;
      }
      w.activeTool.delete(session);
      // The structured list (PreToolUse has it as typed text).
      if (report.tool_name === 'TodoWrite') this.noteTodos(w, report.tool_input);
      this.noteOutcome(w, report, false);
      this.refreshAfter(w, report);
      // A hook command from before SubagentStop: a subagent that asked has finished once its Task returns.
      if (w.hookVersion < HOOK_VERSION && w.asking && w.asking.session !== session && report.tool_name === 'Task') this.context.setStatus(w, 'working');
      else this.toolFinished(w, session, report);
      if (replies && w.outbox.length) {
        reply = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: officeSays(w.outbox.join('\n\n')) } });
        w.outbox = [];
      }
    } else if (event === 'Notification') {
      // The hooks reference says a cancelled turn sends idle_prompt instead of Stop; Droid 1.1.0 sends Stop.
      if (report.notification_type === 'idle_prompt' && (w.info.status === 'working' || (w.info.status === 'needs_input' && !w.bootBlocked))) this.context.setStatus(w, 'done');
      else this.notified(w, session, report);
    } else if (event === 'Stop') {
      w.activeTool.delete(session);
      reply = this.stopped(w, report, replies);
    } else if (event === 'SubagentStop') {
      w.activeTool.delete(session);
      // A Task subagent finished: a question it was asking in this terminal is over.
      if (w.info.status === 'needs_input' && w.asking && w.asking.session !== session) this.context.setStatus(w, 'working');
      const name = typeof report.task_name === 'string' && report.task_name ? report.task_name : 'A subagent';
      if (w.info.status === 'working') w.info.activity = truncate(`${name} finished${typeof report.task_error === 'string' && report.task_error ? ' with an error' : ''}`, 80);
    } else if (event === 'PreCompact') w.info.activity = COMPACTING;
    // /model can change it between turns, and droid writes the file a moment after SessionStart.
    if (event === 'SessionStart' || event === 'UserPromptSubmit' || event === 'Stop') this.context.refreshModel(w);
    return reply;
  }

  /**
   * Its own session's Stop. A Stop hook that blocks (the office's own, below, or another one the
   * owner set up) keeps the turn going, so a Stop is only done once STOP_GRACE_MS passes with no
   * other hook (see settleStop). With `replies`, the office blocks it to hand over what it has for
   * the worker, but never a Stop that a block already continued (stop_hook_active), so it can't loop,
   * nor one right after a cancel or with a queued message to run next.
   */
  private stopped(w: Worker, report: Record<string, unknown>, replies: boolean): string | undefined {
    // Droid's queue was emptied some other way (Ctrl+R in its terminal): nothing runs next.
    if (w.queued > 0 && w.term && readDroidQueue(screenRows(w.term))?.length === 0) {
      w.queued = 0;
      w.sentQueue = w.sentQueue.filter((s) => s.group !== 'queued');
    }
    // A message queued with Ctrl+Enter runs next, without a UserPromptSubmit of its own.
    if (w.queued > 0) {
      w.queued--;
      w.sentQueue.shift();
      this.context.nextTurn(w.info);
      return undefined;
    }
    const cancelled = w.cancelAt !== undefined && Date.now() - w.cancelAt < CANCEL_MS;
    if (replies && !cancelled && report.stop_hook_active !== true && (w.info.status === 'working' || w.info.status === 'needs_input')) {
      const notes = [...w.outbox];
      const more = this.context.beforeStop(w.info);
      if (more) notes.push(more);
      if (notes.length) {
        w.outbox = [];
        return JSON.stringify({ decision: 'block', reason: officeSays(notes.join('\n\n')) });
      }
    }
    // Already at rest: a queued turn that used no tools ended. It doesn't finish (and ding) again.
    if (w.info.status !== 'working' && (w.info.status !== 'needs_input' || w.bootBlocked)) return undefined;
    const at = Date.now();
    w.stopAt = at;
    setTimeout(() => this.settleStop(w, at), STOP_GRACE_MS).unref();
    return undefined;
  }

  /**
   * A Stop's grace passed with no other hook: the turn is done, unless its screen shows it still
   * going. Asked again every second (see reconcile) while it isn't.
   */
  settleStop(w: Worker, at: number, now = Date.now()) {
    if (w.stopAt !== at || this.context.closing() || this.context.get(w.info.id) !== w || !w.term) return;
    if (w.info.status !== 'working' && w.info.status !== 'needs_input') return;
    const screen = readDroidScreen(screenRows(w.term));
    // A dialog is up, or another Stop hook continued the turn before any tool: its spinner is still
    // printing. One quoted in a reply doesn't print, and doesn't hold the finish up.
    if (screen === 'asking' || (screen === 'busy' && now - w.outputAt < STOP_GRACE_MS)) return;
    this.context.setStatus(w, 'done');
  }

  /** A tool call finished: what it may have changed is looked at now rather than on the next timer (see hook-refresh.ts). */
  private refreshAfter(w: Worker, report: Record<string, unknown>) {
    const refresh = toolRefresh(report.tool_name, report.tool_input);
    if (!refresh) return;
    if (refresh.branch) void this.context.syncBranch(w);
    this.context.tool(w.info.id, refresh);
  }

  /**
   * A hook from one of its subagents. It works inside the worker's turn, and its permission prompts
   * and questions show in the worker's terminal; its own start, prompt and end are not the worker's.
   */
  private subagentHook(w: Worker, event: string, report: Record<string, unknown>, live: boolean): undefined {
    const session = report.session_id as string;
    if (event === 'PreToolUse') this.toolStarted(w, session, report, true);
    else if (event === 'PostToolUse') {
      w.activeTool.delete(session);
      this.noteOutcome(w, report, false);
      if (live) this.refreshAfter(w, report);
      this.toolFinished(w, session, report);
    } else if (event === 'Stop') w.activeTool.delete(session);
    else if (event === 'Notification') this.notified(w, session, report, true);
    else if ((event === 'SessionStart' || event === 'UserPromptSubmit') && (w.info.status === 'done' || w.info.status === 'idle')) this.context.setStatus(w, 'working');
    return undefined;
  }

  private toolStarted(w: Worker, session: string, report: Record<string, unknown>, sub = false) {
    const tool = report.tool_name;
    if (typeof tool === 'string') w.lastTool.set(session, { tool, input: report.tool_input });
    if (ASK_TOOLS.has(tool)) {
      w.activeTool.delete(session);
      this.context.setStatus(w, 'needs_input');
      w.asking = { session, tool: tool as string };
      const input = report.tool_input && typeof report.tool_input === 'object' ? (report.tool_input as Record<string, unknown>) : {};
      const questions = inputQuestions(input);
      if (questions.length) {
        w.info.ask = { kind: 'question', questions, ...(sub ? { sub: true as const } : {}) };
        w.info.activity = truncate(questions.length > 1 ? `${questions[0].question} (+${questions.length - 1} more)` : questions[0].question, 80);
        if (w.pty?.id) this.context.persist();
      }
      return;
    }
    const summary = describeTool(report);
    w.info.activity = summary;
    if (!sub) w.currentTool = { name: String(tool ?? 'tool'), summary, at: w.hookAt || Date.now() };
    if (typeof tool === 'string') w.activeTool.set(session, { tool, input: report.tool_input, startedAt: w.hookAt || Date.now() });
    w.info.action = toolAction(tool, report.tool_input);
    // Moving on means its question was answered, unless another session is the one asking.
    if (w.info.status !== 'needs_input' || !w.asking || w.asking.session === session) this.context.setStatus(w, 'working');
  }

  /** A tool the session asked about (permission to run it, or a question) has run: it was answered. */
  private toolFinished(w: Worker, session: string, report: Record<string, unknown>) {
    const { asking } = w;
    if (w.info.status !== 'needs_input' || !asking || asking.session !== session) return;
    if (asking.tool === undefined || asking.tool === report.tool_name) this.context.setStatus(w, 'working');
  }

  private notified(w: Worker, session: string, report: Record<string, unknown>, sub = false) {
    if (report.notification_type !== 'permission_prompt' && report.notification_type !== 'elicitation_dialog') return;
    const call = w.lastTool.get(session);
    const permission = report.notification_type === 'permission_prompt' && call && !ASK_TOOLS.has(call.tool) ? permissionAsk(call.tool, call.input, sub) : undefined;
    const question = w.info.status === 'needs_input' && w.info.ask?.kind === 'question' ? w.info.activity : undefined;
    w.info.activity = permission ? truncate(permissionLine(permission), 80) : (question ?? (typeof report.message === 'string' ? truncate(report.message, 80) : 'Waiting for input'));
    this.context.setStatus(w, 'needs_input');
    w.asking = { session, tool: call?.tool };
    if (permission) {
      w.info.ask = permission;
      if (w.pty?.id) this.context.persist();
    }
  }

  /**
   * A tool call finished. Tests or a build that failed again (by exit code, or by the summary it
   * printed when the exit code was piped away) and the worker puts its head in its hands, until its
   * next tool call; a passing run ends the streak.
   */
  private noteOutcome(w: Worker, payload: any, failed: boolean) {
    if (payload?.is_interrupt || toolAction(payload?.tool_name, payload?.tool_input) !== 'test') return;
    const res = payload?.tool_response;
    const output = [payload?.error, res?.stdout, res?.stderr].filter((s) => typeof s === 'string').join('\n');
    if (!failed && !outputFailed(output)) {
      w.failStreak = 0;
      return;
    }
    if (++w.failStreak < FAILS_TO_DESPAIR || w.info.action === 'failing') return;
    w.info.action = 'failing';
    this.context.update(w);
  }

  /** Its latest TodoWrite list; one with no items clears it. */
  private noteTodos(w: Worker, input: unknown) {
    const todos = todoProgress(input);
    if (todos) {
      w.info.todos = todos;
      w.todoSteps = todoItems(input);
    } else {
      delete w.info.todos;
      delete w.todoSteps;
    }
  }

  private clearTask(w: Worker, cleared: boolean) {
    w.taskEpoch++;
    w.info.taskSince = cleared ? Date.now() : undefined;
    w.info.task = undefined;
    delete w.info.todos;
    delete w.todoSteps;
    this.context.update(w);
    this.context.persist();
  }
}

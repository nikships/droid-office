import type { ThreadEntry } from './worker-thread.js';

export type ActivityState = 'working' | 'complete' | 'incomplete' | 'failed' | 'cancelled';
export type ActionKind =
  | 'read'
  | 'list'
  | 'search'
  | 'command'
  | 'edit'
  | 'create'
  | 'web'
  | 'webSearch'
  | 'delegate'
  | 'skill'
  | 'ask'
  | 'memory'
  | 'script'
  | 'plan'
  | 'taskStop'
  | 'loopCreate'
  | 'loopList'
  | 'loopPause'
  | 'loopResume'
  | 'loopCancel'
  | 'other';
/** A tool call as the engine reads it. The wire carries a ThreadModelAction instead. */
export interface ThreadAction {
  type: 'action';
  entry: ThreadEntry;
  title: string;
  detail?: string;
  category: ActionKind;
  state: ActivityState;
  paths: string[];
  /** A wrapper's diagnostics remain available, but its child's failure is counted only once. */
  causedBy?: string;
}
export interface PlanStep {
  done: boolean;
  active: boolean;
  text: string;
}

/**
 * The Thread presentation model, built by the office and rendered by the web and Android clients.
 * Raise THREAD_MODEL_VERSION when a change would make an older client read the model wrongly (a
 * renamed or retyped field, a new row or block kind); added optional fields don't need it.
 */
export const THREAD_MODEL_VERSION = 1;
export interface ThreadPresentation {
  version: typeof THREAD_MODEL_VERSION;
  rows: ThreadRow[];
}
/** Where an action's arguments are in its entry's input: a key of the JSON object, '.' for a JSON string, or the whole input. */
export interface ThreadArgumentsRef {
  label: string;
  field?: string;
}
export interface ThreadModelAction {
  /** The tool entry's id: its arguments and result are that entry's input and output. */
  id: string;
  title: string;
  detail?: string;
  category: ActionKind;
  state: ActivityState;
  /** The state in words beside the title, empty when it simply finished. */
  status: string;
  causedBy?: string;
  arguments?: ThreadArgumentsRef;
  /** The heading over the output. */
  result: 'Result' | 'Error' | 'Cancelled';
  open: boolean;
}
export interface ThreadFailure {
  id: string;
  title: string;
  /** The first line of the error, shown while the Activity is closed. */
  preview: string;
}
export type ThreadBlock =
  | { kind: 'thought'; id: string; preview: string; live: boolean; open: boolean }
  | { kind: 'tools'; id: string; label: string; state: ActivityState; live: boolean; open: boolean; actions: ThreadModelAction[]; plan?: PlanStep[] };
/** `from` and `to` are the seqs of the first and last entry a row stands for, hidden ones included. */
export type ThreadRow =
  | { kind: 'message'; id: string; from: number; to: number; role: 'user' | 'assistant'; startsTurn: boolean }
  | { kind: 'notice'; id: string; from: number; to: number; role: ThreadEntry['role']; text: string; tone: 'quiet' | 'danger' | 'attachment' }
  | {
      kind: 'activity';
      id: string;
      from: number;
      to: number;
      sourceIds: string[];
      label: string;
      state: ActivityState;
      live: boolean;
      open: boolean;
      /** "2 failed · 1 no result", when anything didn't simply finish. */
      status?: string;
      /** The newest working action's title while live. */
      running?: string;
      failed: ThreadFailure[];
      blocks: ThreadBlock[];
    };

const bookkeeping = new Set(['todowrite', 'todoread', 'toolsearch', 'skill', 'todo_write', 'todo_read', 'update_plan', 'waitforscript', 'taskoutput']);
const leaf = (name = '') => name.split(/[.:/]/).at(-1)?.toLowerCase() ?? '';
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const str = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const sentence = (text: string) => {
  const line = text.split('\n')[0].trim().replace(/\.$/, '');
  return line.charAt(0).toUpperCase() + line.slice(1);
};
const baseName = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '').split('/').at(-1) || path;

export function threadShortPath(path: string): string {
  const root = path.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (/\/\.droid-office\/worktrees\/[^/]+$/.test(root)) return baseName(root);
  const short = path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^.*?\/\.droid-office\/worktrees\/[^/]+\//, '')
    .replace(/^\/(?:Users|home)\/[^/]+\//, '~/');
  const parts = short.split('/').filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : short;
}

function argumentsOf(entry: ThreadEntry): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(entry.input ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Source is available on demand, formatted as source rather than escaped JSON. */
export function threadArguments(entry: ThreadEntry): ThreadArgumentsRef | undefined {
  const raw = entry.input?.trim();
  if (!raw || raw === '{}') return;
  const args = argumentsOf(entry);
  if (str(args.command)) return { label: 'Command', field: 'command' };
  if (str(args.script)) return { label: 'Script', field: 'script' };
  if (str(args.code)) return { label: 'Script', field: 'code' };
  if (leaf(entry.name) === 'applypatch' && str(args.input)) return { label: 'Patch', field: 'input' };
  if (leaf(entry.name) === 'applypatch' && str(args.patch)) return { label: 'Patch', field: 'patch' };
  try {
    if (typeof JSON.parse(raw) === 'string') return { label: leaf(entry.name) === 'script' ? 'Script' : leaf(entry.name) === 'applypatch' ? 'Patch' : 'Arguments', field: '.' };
  } catch {
    /* Older tools can record plain-text arguments. */
  }
  return { label: 'Arguments' };
}

/** The text a ThreadArgumentsRef points at in an entry's input. */
export function threadArgumentsText(input: string | undefined, ref: ThreadArgumentsRef): string {
  const raw = input?.trim() ?? '';
  if (ref.field === undefined) return raw;
  try {
    const value: unknown = JSON.parse(raw);
    const picked = ref.field === '.' ? value : value && typeof value === 'object' ? (value as Record<string, unknown>)[ref.field] : undefined;
    return typeof picked === 'string' ? picked.trim() : raw;
  } catch {
    return raw;
  }
}

export function threadAction(entry: ThreadEntry, live = false, cancelled = false): ThreadAction {
  const name = leaf(entry.name);
  const args = argumentsOf(entry);
  const path = str(args.file_path ?? args.path ?? args.directory_path ?? args.folder);
  const failed = !!entry.error && !cancelled;
  const action = (category: ActionKind, title: string, detail?: string, paths = path ? [path] : []): ThreadAction => ({
    type: 'action',
    entry,
    category,
    paths,
    title: clip(title, 90),
    ...(detail ? { detail: clip(detail, 70) } : {}),
    state: cancelled ? 'cancelled' : failed ? 'failed' : entry.output !== undefined ? 'complete' : live ? 'working' : 'incomplete',
  });
  const file = path ? baseName(path) : 'a file';
  const detail = path ? threadShortPath(path) : undefined;
  switch (name) {
    case 'read':
      return action('read', `Read ${file}`, detail);
    case 'ls':
      return action('list', `Listed ${path ? baseName(path) : 'a folder'}`, detail);
    case 'glob': {
      const patterns = Array.isArray(args.patterns) ? args.patterns.filter((p) => typeof p === 'string') : [str(args.patterns)].filter(Boolean);
      return action('search', patterns.length ? `Found files matching ${patterns.join(', ')}` : 'Found files', detail);
    }
    case 'grep':
      return action('search', str(args.pattern) ? `Searched for “${clip(str(args.pattern), 48)}”` : 'Searched the code', detail);
    case 'execute': {
      const summary = str(args.summary);
      const command = str(args.command)
        .split('\n')
        .find((line) => line.trim())
        ?.trim()
        .replace(/[^\s'"]*\/\.droid-office\/worktrees\/[^/\s'"]+\/?/g, '')
        .replace(/\/(?:Users|home)\/[^/\s'"]+\//g, '~/');
      return action('command', summary ? sentence(summary) : 'Ran a command', summary ? undefined : command);
    }
    case 'edit':
    case 'multiedit':
      return action('edit', `Edited ${file}`, detail);
    case 'create':
    case 'write':
      return action('create', `Created ${file}`, detail);
    case 'applypatch': {
      const patch = str(args.input ?? args.patch) || entry.input || '';
      const files = [...patch.replace(/\\n/g, '\n').matchAll(/\*\*\* (?:Update|Add|Delete) File: (\S.*)/g)].map((m) => m[1].trim().replace(/[",]+$/, ''));
      const names = [...new Set(files.map(baseName))];
      return action('edit', names.length ? `Edited ${names.join(', ')}` : 'Edited files', files.length === 1 ? threadShortPath(files[0]) : undefined, files);
    }
    case 'fetchurl': {
      const host = str(args.url)
        .split('://')
        .at(-1)
        ?.split(/[/?]/)[0]
        .replace(/^www\./, '');
      return action('web', host ? `Read ${host}` : 'Read a web page');
    }
    case 'websearch':
      return action('webSearch', str(args.query) ? `Searched the web for “${clip(str(args.query), 48)}”` : 'Searched the web');
    case 'task':
      return action('delegate', str(args.description) ? sentence(str(args.description)) : 'Ran a subagent', str(args.subagent_type));
    case 'skill':
      return action('skill', str(args.skill) ? `${failed ? "Couldn't load" : 'Used'} the ${str(args.skill)} skill` : failed ? "Couldn't load a skill" : 'Used a skill');
    case 'askuser':
      return action('ask', 'Asked you a question');
    case 'script':
      return action('script', failed ? 'A script failed' : 'Ran a script');
    case 'toolsearch':
      return action('plan', failed ? "Couldn't load tools" : 'Loaded tools');
    case 'waitforscript':
      return action('plan', failed ? "Couldn't read script results" : 'Read script results');
    case 'taskoutput':
      return action('plan', failed ? "Couldn't read task output" : 'Read task output');
    case 'taskstop':
      return action('taskStop', failed ? "Couldn't stop the background task" : 'Stopped a background task');
    case 'loop': {
      const verbs: Record<string, [ActionKind, string, string]> = {
        list: ['loopList', 'Checked scheduled loops', "Couldn't read scheduled loops"],
        pause: ['loopPause', 'Paused a loop', "Couldn't pause the loop"],
        resume: ['loopResume', 'Resumed a loop', "Couldn't resume the loop"],
        cancel: ['loopCancel', 'Cancelled a loop', "Couldn't cancel the loop"],
      };
      const [kind, done, error] = verbs[str(args.action)] ?? ['loopCreate', 'Scheduled a loop', "Couldn't schedule the loop"];
      return action(kind, failed ? error : done);
    }
    default:
      if (bookkeeping.has(name)) return action('plan', failed ? "Couldn't update the plan" : 'Updated the plan');
      if (name.startsWith('memory___')) return action('memory', /save|update/.test(name) ? 'Saved to memory' : 'Checked memory');
      return action(
        'other',
        `Used ${(entry.name || 'a tool')
          .replace(/___/g, ' ')
          .replace(/_/g, ' ')
          .replace(/([a-z])([A-Z])/g, '$1 $2')
          .toLowerCase()
          .trim()}`,
        str(args.description ?? args.query) || detail,
      );
  }
}

const counts: Record<ActionKind, [string, string]> = {
  read: ['Read a file', 'Read %d files'],
  list: ['Listed a folder', 'Listed %d folders'],
  search: ['Searched the code', 'Searched %d times'],
  command: ['Ran a command', 'Ran %d commands'],
  edit: ['Edited a file', 'Edited %d files'],
  create: ['Created a file', 'Created %d files'],
  web: ['Read a web page', 'Read %d web pages'],
  webSearch: ['Searched the web', 'Searched the web %d times'],
  delegate: ['Ran a subagent', 'Ran %d subagents'],
  skill: ['Used a skill', 'Used %d skills'],
  ask: ['Asked you a question', 'Asked you %d questions'],
  memory: ['Checked memory', 'Used memory %d times'],
  script: ['Ran a script', 'Ran %d scripts'],
  plan: ['Updated the plan', 'Updated the plan %d times'],
  taskStop: ['Stopped a background task', 'Stopped %d background tasks'],
  loopCreate: ['Scheduled a loop', 'Scheduled %d loops'],
  loopList: ['Checked scheduled loops', 'Checked scheduled loops %d times'],
  loopPause: ['Paused a loop', 'Paused %d loops'],
  loopResume: ['Resumed a loop', 'Resumed %d loops'],
  loopCancel: ['Cancelled a loop', 'Cancelled %d loops'],
  other: ['Used a tool', 'Used %d tools'],
};
const controls: Partial<Record<ActionKind, [string, string, string]>> = {
  taskStop: ['stop background tasks', 'Stopping a background task', 'Background task stop cancelled'],
  loopCreate: ['schedule loops', 'Scheduling a loop', 'Loop scheduling cancelled'],
  loopList: ['check scheduled loops', 'Checking scheduled loops', 'Loop check cancelled'],
  loopPause: ['pause loops', 'Pausing a loop', 'Loop pause cancelled'],
  loopResume: ['resume loops', 'Resuming a loop', 'Loop resume cancelled'],
  loopCancel: ['cancel loops', 'Cancelling a loop', 'Loop cancellation cancelled'],
};
function activityLabel(actions: ThreadAction[]): string {
  const counted = actions.filter((action) => !action.causedBy && !(action.state === 'failed' && (action.category === 'plan' || action.category === 'skill')));
  if (!counted.length && actions.length) return (actions.find((action) => !action.causedBy) ?? actions[0]).title;
  const kinds = new Map<ActionKind, Set<string>>();
  for (const action of counted) {
    const units = ['edit', 'create'].includes(action.category) ? (action.paths.length ? action.paths : [action.title]) : [action.entry.id];
    if (!kinds.has(action.category)) kinds.set(action.category, new Set());
    for (const unit of units) kinds.get(action.category)?.add(unit);
  }
  const entries = [...kinds.entries()];
  const parts = entries.slice(0, 3).map(([kind, units]) => {
    const control = controls[kind];
    const group = counted.filter((action) => action.category === kind);
    if (control && units.size === 1) {
      const first = group[0];
      if (first.state === 'cancelled') return control[2];
      return first.state === 'working' || first.state === 'incomplete' ? control[1] : first.title;
    }
    if (control && group.some((action) => action.state !== 'complete')) return `${units.size} attempts to ${control[0]}`;
    return units.size === 1 ? counts[kind][0] : counts[kind][1].replace('%d', String(units.size));
  });
  const folded = new Set(entries.slice(3).map(([kind]) => kind));
  const more = counted.filter((action) => folded.has(action.category)).length;
  if (more) parts.push(`${more} more`);
  return parts.join(' · ') || 'Thought';
}

/** Only the CLI's exact causal error envelope can deduplicate a failed wrapper, not proximity. */
function scriptFailureCause(entry: ThreadEntry, children: ThreadEntry[]): string | undefined {
  const lines = entry.output?.trim().split('\n') ?? [];
  if (lines.length !== 2 || !/^\[Script failed · .* · after call \d+ \(.+\) · log: .+]$/.test(lines[0])) return;
  try {
    const result = JSON.parse(lines[1]);
    if (Object.keys(result).sort().join(',') !== 'error,status,toolCallId') return;
    if (result.status !== 'failed' || result.toolCallId !== entry.id.replace(/^tool:/, '')) return;
    return children.find((child) => child.error && child.output?.trim() && result.error === `Error: tools.${child.name}: ${child.output.trim()}`)?.id;
  } catch {
    return;
  }
}

function scriptChildren(source: ThreadEntry[], at: number): ThreadEntry[] {
  const following = source.slice(at + 1);
  const nextScript = following.findIndex((entry) => entry.kind === 'tool' && leaf(entry.name) === 'script');
  return (nextScript < 0 ? following : following.slice(0, nextScript)).filter((entry) => entry.kind === 'tool');
}

const byUser = /^(?:Error: )?tool execution (?:was )?(?:cancelled|canceled|interrupted|aborted) by (?:the )?user$/i;

/**
 * Results that came only after a later message, notice or Script, or past the loaded entries. The CLI
 * flushes the calls a crash orphaned as "cancelled by user" when the owner later stops another
 * Script, so such a result says nothing about why its call stopped.
 */
function lateResults(entries: readonly ThreadEntry[]): Set<string> {
  const late = new Set<string>();
  const end = (entries.at(-1)?.seq ?? 0) + 1;
  for (const [at, entry] of entries.entries()) {
    const result = entry.resultSeq;
    if (entry.kind !== 'tool' || !entry.error || result === undefined || !byUser.test(entry.output?.trim() ?? '')) continue;
    if (result > end) late.add(entry.id);
    for (let next = at + 1; next < entries.length && entries[next].seq < result && !late.has(entry.id); next++) {
      const other = entries[next];
      if (other.kind === 'text' || other.kind === 'notice' || (other.kind === 'tool' && leaf(other.name) === 'script')) late.add(entry.id);
    }
  }
  return late;
}

/**
 * An exact CLI by-user result that came in time is owner evidence, without a turn notice. A bare
 * "was interrupted" (a crash or restart) stays failed, and so does a Script whose by-user result came
 * late or whose child was interrupted that way: the owner's Stop cancels the running child by user
 * too. Such a Script is counted on its failed child. Never infer across another Script or message.
 */
function ownerCancellations(source: ThreadEntry[], late: Set<string>): { ids: Set<string>; causes: Map<string, string> } {
  const marked = source.filter((entry) => entry.kind === 'tool' && entry.error && byUser.test(entry.output?.trim() ?? ''));
  const ids = new Set(marked.filter((entry) => !late.has(entry.id)).map((entry) => entry.id));
  const causes = new Map<string, string>();
  for (const [at, entry] of source.entries()) {
    if (leaf(entry.name) !== 'script' || !marked.includes(entry)) continue;
    const children = scriptChildren(source, at);
    const failed = children.find((child) => child.error && !ids.has(child.id));
    if (failed?.output?.trim() === 'Tool execution was interrupted') ids.delete(entry.id);
    const cause = ids.has(entry.id) ? children.find((child) => ids.has(child.id)) : failed;
    if (cause) causes.set(entry.id, cause.id);
  }
  return { ids, causes };
}

export function threadPlan(text: string): PlanStep[] {
  return text.split('\n').flatMap((line) => {
    const match = /^\d+\.\s*\[(completed|in progress|in_progress|pending)]\s*(.*)$/.exec(line.trim());
    return match ? [{ done: match[1] === 'completed', active: match[1].replace('_', ' ') === 'in progress', text: match[2].trim() }] : [];
  });
}
export function threadStop(reason: string): string {
  const copy: Record<string, string> = {
    error: 'The turn stopped on an error',
    model_authentication_failed: "The turn stopped: the model's sign-in failed",
    model_provider_unavailable: "The turn stopped: the model's provider couldn't be reached",
    model_provider_unreachable: "The turn stopped: the model's provider couldn't be reached",
    model_rate_limited: 'The turn stopped: the model was rate limited',
    model_request_rejected: 'The turn stopped: the model rejected the request',
    model_usage_exhausted: "The turn stopped: the model's usage ran out",
    permission_rejected: 'The turn stopped: a permission was refused',
  };
  return copy[reason] ?? `The turn stopped: ${reason.replace(/_/g, ' ')}`;
}
function notice(entry: ThreadEntry): Extract<ThreadRow, { kind: 'notice' }> | undefined {
  const text = entry.text?.trim() || entry.name || '';
  const row = (text: string, tone: 'quiet' | 'danger' | 'attachment'): Extract<ThreadRow, { kind: 'notice' }> => ({ kind: 'notice', id: entry.id, from: entry.seq, to: entry.seq, role: entry.role, text, tone });
  if (entry.id.startsWith('turn:') || text.startsWith('Turn ended') || text === 'Turn cancelled') {
    const reason = entry.id.startsWith('turn:') ? entry.id.split(':').at(-1) : text.split('·')[1]?.trim();
    if (text === 'Turn cancelled' || reason === 'cancelled') return row('Turn cancelled', 'quiet');
    return !reason || reason === 'completed' ? undefined : row(threadStop(reason), 'danger');
  }
  if (text === '[Image attachment]') return row('Image attached', 'attachment');
  return text ? row(text, entry.error ? 'danger' : 'quiet') : undefined;
}

const STATUS: Record<ActivityState, string> = { complete: '', working: 'Running', failed: 'Failed', incomplete: 'No result', cancelled: 'Cancelled' };

function modelAction(action: ThreadAction): ThreadModelAction {
  const args = threadArguments(action.entry);
  return {
    id: action.entry.id,
    title: action.title,
    ...(action.detail ? { detail: action.detail } : {}),
    category: action.category,
    state: action.state,
    status: STATUS[action.state],
    ...(action.causedBy ? { causedBy: action.causedBy } : {}),
    ...(args ? { arguments: args } : {}),
    result: action.state === 'cancelled' ? 'Cancelled' : action.entry.error ? 'Error' : 'Result',
    open: false,
  };
}

const rollup = (failed: number, live: boolean, noResult: number, cancelled: number): ActivityState => (failed ? 'failed' : live ? 'working' : noResult ? 'incomplete' : cancelled ? 'cancelled' : 'complete');

/**
 * The model the clients render; session entries, positions, paging and the wire entries stay intact.
 * Messages and notices are rows. Everything between them is one Activity row, collapsed, holding
 * its thoughts and tool runs in order, each with its own disclosure.
 */
export function presentThread(entries: readonly ThreadEntry[], busy: boolean): ThreadRow[] {
  const rows: ThreadRow[] = [];
  let section: ThreadEntry[] = [];
  let blocks: ThreadBlock[] = [];
  let actions: ThreadAction[] = [];
  let run: ThreadEntry[] = [];
  let lastPlan = '';
  let plan: PlanStep[] = [];
  let previousRole: ThreadEntry['role'] | undefined;
  const late = lateResults(entries);
  const flushRun = (live: boolean) => {
    if (!run.length) return;
    const source = run;
    run = [];
    const todo = source.filter((entry) => entry.kind === 'todo').at(-1);
    if (todo) plan = threadPlan(todo.text ?? '');
    const items: ThreadAction[] = [];
    const cancellations = ownerCancellations(source, late);
    for (const [index, entry] of source.entries()) {
      if (entry.kind !== 'tool') continue;
      const name = leaf(entry.name);
      if (!entry.error && bookkeeping.has(name)) continue;
      let causedBy = cancellations.causes.get(entry.id);
      if (name === 'script') {
        const children = scriptChildren(source, index);
        if (!entry.error && children.length) continue;
        if (entry.error) causedBy ??= scriptFailureCause(entry, children);
      }
      const action = threadAction(entry, live, cancellations.ids.has(entry.id));
      if (causedBy) {
        action.causedBy = causedBy;
        action.title = action.state === 'cancelled' ? 'Script stopped after a tool was cancelled' : 'Script stopped after a tool failed';
      }
      items.push(action);
    }
    if (!items.length) return;
    const failed = items.filter((a) => a.state === 'failed' && !a.causedBy).length;
    const cancelled = items.filter((a) => a.state === 'cancelled' && !a.causedBy).length;
    const noResult = items.filter((a) => a.state === 'incomplete').length;
    const planKey = JSON.stringify(plan);
    const changedPlan = plan.length && planKey !== lastPlan ? plan : undefined;
    if (changedPlan) lastPlan = planKey;
    actions.push(...items);
    blocks.push({
      kind: 'tools',
      id: `tools:${source[0].id}`,
      label: activityLabel(items),
      state: rollup(failed, live, noResult, cancelled),
      live,
      open: false,
      actions: items.map(modelAction),
      ...(changedPlan ? { plan: changedPlan } : {}),
    });
  };
  const flush = (live: boolean) => {
    flushRun(live);
    const source = section;
    const shown = blocks;
    const all = actions;
    section = [];
    blocks = [];
    actions = [];
    if (!shown.length) return;
    const failed = all.filter((a) => a.state === 'failed' && !a.causedBy);
    const cancelled = all.filter((a) => a.state === 'cancelled' && !a.causedBy).length;
    const noResult = all.filter((a) => a.state === 'incomplete').length;
    const status = [failed.length ? `${failed.length} failed` : '', cancelled ? `${cancelled} cancelled` : '', noResult ? `${noResult} no result` : ''].filter(Boolean).join(' · ');
    const running = live ? all.filter((a) => a.state === 'working').at(-1)?.title : undefined;
    rows.push({
      kind: 'activity',
      id: `activity:${source[0].id}`,
      from: source[0].seq,
      to: Math.max(...source.map((e) => e.seq)),
      sourceIds: source.map((e) => e.id),
      label: activityLabel(all),
      state: rollup(failed.length, live, noResult, cancelled),
      live,
      open: false,
      ...(status ? { status } : {}),
      ...(running ? { running } : {}),
      failed: failed.map((a) => ({
        id: a.entry.id,
        title: a.title,
        preview: clip(
          a.entry.output
            ?.split('\n')
            .find((line) => line.trim())
            ?.trim() ?? 'No error details were recorded.',
          240,
        ),
      })),
      blocks: shown,
    });
  };
  const last = entries.at(-1);
  for (const entry of entries) {
    if (entry.kind === 'text' && entry.role !== 'system') {
      flush(false);
      rows.push({ kind: 'message', id: entry.id, from: entry.seq, to: entry.seq, role: entry.role, startsTurn: entry.role === 'assistant' && previousRole !== 'assistant' });
      previousRole = entry.role;
    } else if (entry.kind === 'notice' || (entry.kind === 'text' && entry.role === 'system')) {
      const important = notice(entry);
      if (important) {
        flush(false);
        rows.push(important);
      }
    } else if (entry.kind === 'thinking') {
      flushRun(false);
      section.push(entry);
      const preview = entry.text
        ?.split('\n')
        .find((line) => line.trim())
        ?.trim()
        .replace(/^\*+|\*+$/g, '')
        .trim();
      if (preview) blocks.push({ kind: 'thought', id: entry.id, preview: clip(preview, 120), live: busy && entry === last, open: false });
    } else {
      section.push(entry);
      run.push(entry);
    }
  }
  flush(busy);
  return rows;
}

/** The rows a page carries: those standing for any of its entries, before `before` when it is an earlier page. */
export function pageRows(rows: readonly ThreadRow[], entries: readonly ThreadEntry[], before = Infinity): ThreadRow[] {
  const first = entries[0]?.seq;
  if (first === undefined) return [];
  return rows.filter((row) => row.to >= first && row.from < before);
}

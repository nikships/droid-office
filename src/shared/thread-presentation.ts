import type { ThreadEntry } from './worker-thread.js';

export type ActivityState = 'working' | 'complete' | 'incomplete' | 'failed' | 'cancelled';
type ActionKind = 'read' | 'list' | 'search' | 'command' | 'edit' | 'create' | 'web' | 'webSearch' | 'delegate' | 'skill' | 'ask' | 'memory' | 'script' | 'plan' | 'other';
export interface ThreadAction {
  type: 'action';
  entry: ThreadEntry;
  title: string;
  detail?: string;
  category: ActionKind;
  state: ActivityState;
  paths: string[];
}
interface ThreadThought {
  type: 'thought';
  entry: ThreadEntry;
  preview: string;
}
export interface PlanStep {
  done: boolean;
  active: boolean;
  text: string;
}
export type ThreadRow =
  | { id: string; kind: 'message'; entry: ThreadEntry; startsTurn: boolean }
  | { id: string; kind: 'notice'; entry: ThreadEntry; text: string; tone: 'quiet' | 'danger' | 'attachment' }
  | {
      id: string;
      kind: 'activity';
      sourceIds: string[];
      items: (ThreadAction | ThreadThought)[];
      actions: ThreadAction[];
      plan?: PlanStep[];
      label: string;
      state: ActivityState;
      live: boolean;
      failed: ThreadAction[];
      cancelled: number;
      noResult: number;
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
export function threadArguments(entry: ThreadEntry): { label: string; text: string } | undefined {
  const raw = entry.input?.trim();
  if (!raw || raw === '{}') return;
  const args = argumentsOf(entry);
  if (str(args.command)) return { label: 'Command', text: str(args.command) };
  if (str(args.script ?? args.code)) return { label: 'Script', text: str(args.script ?? args.code) };
  if (leaf(entry.name) === 'applypatch' && str(args.input ?? args.patch)) return { label: 'Patch', text: str(args.input ?? args.patch) };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'string') return { label: leaf(entry.name) === 'script' ? 'Script' : leaf(entry.name) === 'applypatch' ? 'Patch' : 'Arguments', text: parsed };
  } catch {
    /* Older tools can record plain-text arguments. */
  }
  return { label: 'Arguments', text: raw };
}

/** Matches Android's ThreadView.action; a shared golden fixture guards the words and hierarchy. */
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
      return action('other', failed ? "Couldn't stop the background task" : 'Stopped a background task');
    case 'loop': {
      const verbs: Record<string, [string, string]> = {
        list: ['Checked scheduled loops', "Couldn't read scheduled loops"],
        pause: ['Paused a loop', "Couldn't pause the loop"],
        resume: ['Resumed a loop', "Couldn't resume the loop"],
        cancel: ['Cancelled a loop', "Couldn't cancel the loop"],
      };
      const [done, error] = verbs[str(args.action)] ?? ['Scheduled a loop', "Couldn't schedule the loop"];
      return action('other', failed ? error : done);
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
  other: ['Used a tool', 'Used %d tools'],
};
function activityLabel(actions: ThreadAction[]): string {
  const counted = actions.filter((action) => !(action.state === 'failed' && (action.category === 'plan' || action.category === 'skill')));
  if (!counted.length && actions.length) return actions[0].title;
  const kinds = new Map<ActionKind, Set<string>>();
  for (const action of counted) {
    const units = ['edit', 'create'].includes(action.category) ? (action.paths.length ? action.paths : [action.title]) : [action.entry.id];
    if (!kinds.has(action.category)) kinds.set(action.category, new Set());
    for (const unit of units) kinds.get(action.category)?.add(unit);
  }
  const entries = [...kinds.entries()];
  const parts = entries.slice(0, 3).map(([kind, units]) => (units.size === 1 ? counts[kind][0] : counts[kind][1].replace('%d', String(units.size))));
  const folded = new Set(entries.slice(3).map(([kind]) => kind));
  const more = counted.filter((action) => folded.has(action.category)).length;
  if (more) parts.push(`${more} more`);
  return parts.join(' · ') || 'Thought';
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
  const row = (text: string, tone: 'quiet' | 'danger' | 'attachment'): Extract<ThreadRow, { kind: 'notice' }> => ({ id: entry.id, kind: 'notice', entry, text, tone });
  if (entry.id.startsWith('turn:') || text.startsWith('Turn ended') || text === 'Turn cancelled') {
    const reason = entry.id.startsWith('turn:') ? entry.id.split(':').at(-1) : text.split('·')[1]?.trim();
    if (text === 'Turn cancelled' || reason === 'cancelled') return row('Turn cancelled', 'quiet');
    return !reason || reason === 'completed' ? undefined : row(threadStop(reason), 'danger');
  }
  if (text === '[Image attachment]') return row('Image attached', 'attachment');
  return text ? row(text, entry.error ? 'danger' : 'quiet') : undefined;
}

/** A display-only projection; session entries, positions, paging and the wire contract stay intact. */
export function presentThread(entries: readonly ThreadEntry[], busy: boolean): ThreadRow[] {
  const rows: ThreadRow[] = [];
  let run: ThreadEntry[] = [];
  let lastPlan = '';
  let plan: PlanStep[] = [];
  let previousRole: ThreadEntry['role'] | undefined;
  const flush = (live: boolean, cancelledTurn = false) => {
    if (!run.length) return;
    const source = run;
    run = [];
    const todo = source.filter((entry) => entry.kind === 'todo').at(-1);
    if (todo) plan = threadPlan(todo.text ?? '');
    const items: (ThreadAction | ThreadThought)[] = [];
    for (const [index, entry] of source.entries()) {
      if (entry.kind === 'thinking') {
        const preview = entry.text
          ?.split('\n')
          .find((line) => line.trim())
          ?.trim()
          .replace(/^\*+|\*+$/g, '')
          .trim();
        if (preview) items.push({ type: 'thought', entry, preview: clip(preview, 120) });
      } else if (entry.kind === 'tool') {
        const name = leaf(entry.name);
        if (!entry.error && bookkeeping.has(name)) continue;
        if (!entry.error && name === 'script') {
          const following = source.slice(index + 1);
          const nextScript = following.findIndex((e) => e.kind === 'tool' && leaf(e.name) === 'script');
          if ((nextScript < 0 ? following : following.slice(0, nextScript)).some((e) => e.kind === 'tool')) continue;
        }
        items.push(threadAction(entry, live, cancelledTurn && !!entry.error && /\btool execution (?:was )?(?:cancelled|canceled|interrupted|aborted) by (?:the )?user\b/i.test(entry.output ?? '')));
      }
    }
    if (!items.length) return;
    const actions = items.filter((item): item is ThreadAction => item.type === 'action');
    const failed = actions.filter((a) => a.state === 'failed');
    const cancelled = actions.filter((a) => a.state === 'cancelled').length;
    const noResult = actions.filter((a) => a.state === 'incomplete').length;
    const planKey = JSON.stringify(plan);
    const changedPlan = plan.length && planKey !== lastPlan ? plan : undefined;
    if (changedPlan) lastPlan = planKey;
    rows.push({
      id: `activity:${source[0].id}`,
      kind: 'activity',
      sourceIds: source.map((e) => e.id),
      items,
      actions,
      ...(changedPlan ? { plan: changedPlan } : {}),
      label: activityLabel(actions),
      live,
      failed,
      cancelled,
      noResult,
      state: failed.length ? 'failed' : live ? 'working' : noResult ? 'incomplete' : cancelled ? 'cancelled' : 'complete',
    });
  };
  for (const entry of entries) {
    if (entry.kind === 'text' && entry.role !== 'system') {
      flush(false);
      rows.push({ id: entry.id, kind: 'message', entry, startsTurn: entry.role === 'assistant' && previousRole !== 'assistant' });
      previousRole = entry.role;
    } else if (entry.kind === 'notice' || (entry.kind === 'text' && entry.role === 'system')) {
      const important = notice(entry);
      if (important) {
        flush(false, important.text === 'Turn cancelled');
        rows.push(important);
      }
    } else run.push(entry);
  }
  flush(busy);
  return rows;
}

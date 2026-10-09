#!/usr/bin/env node
// office-workers: subagents from inside Droid Office, for any agent at a desk and the Team lead (see
// src/server/team.ts). The office puts it on every agent's PATH and gives it its own address and token
// in DROID_OFFICE_HOOK_URL, DROID_OFFICE_WORKER_ID and DROID_OFFICE_HOOK_TOKEN; this talks to the
// /office/workers endpoint with them. Plain Node, no build step, no dependencies.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const USAGE = `Usage:
  office-workers whoami                         who you are here, and whether you can hire
  office-workers hire --title "…" [--model <id>] [--effort <e>] [--no-worktree] <<'EOF'
  …the subagent's brief…                        hires a subagent at the free desk nearest you
  EOF
  office-workers list                           your subagents and what they last reported
  office-workers wait [<name>…] [--all] [--timeout <s>]
                                                waits for news from your team and prints it
  office-workers read <name> [--lines <n>]      the end of a subagent's terminal
  office-workers send <name> <<'EOF'            a message for a subagent: an answer, a follow-up
  …
  EOF
  office-workers dismiss <name>                 sends a subagent home
  office-workers report [--question] <<'EOF'    (a subagent) tells your lead what you did, or asks it
  …
  EOF
  office-workers help                           the whole guide`;

const GUIDE = `office-workers: run subagents from inside Droid Office.

A subagent is a real Droid Office droid. It sits down at the free desk nearest you, with its own
laptop and a live terminal anyone in the office can open, and works on the task you give it, in its
own git worktree unless you say otherwise. It reports back to you when it's done: you're its lead.

COMMANDS

  office-workers whoami
      Who you are here: your desk, your lead if you're a subagent, whether you can hire, how many
      subagents you may have at once, and whether the office wakes you when your team has news.

  office-workers hire --title "Short title" [options] <<'EOF'
  …the subagent's brief…
  EOF
      Hires a subagent and gives it the brief. Prints its name, desk and worktree. The title goes
      on the card over its head. Options:
        --model <id>     an id from droid's model list. Default: what ⚙️ Settings → Subagents
                         picks, else the office's default droid.
        --effort <e>     low, medium, high, xhigh or max.
        --no-worktree    work in the project's main checkout instead of a fresh worktree: only for
                         read-only work, or when it has to see your uncommitted changes.

  office-workers list
      Your subagents: status, desk, model, worktree, what each is doing, and what it last reported.

  office-workers wait [<name>…] [--all] [--timeout <seconds>]
      Waits for news from your team and prints it: a report, a question, a finished turn, a
      terminal that needs someone, someone stopping or leaving. Returns at the first news; with
      --all, once every subagent (or every one named) has finished its turn. --timeout is 50
      seconds unless you say (at most 1800): give your shell tool a longer timeout than that.

  office-workers read <name> [--lines <n>]
      The last lines of a subagent's terminal (80 unless you say, at most 400).

  office-workers send <name> <<'EOF'
  …the message…
  EOF
      Types a message into a subagent's session: an answer to its question, or a follow-up on its
      task. Best sent once it has finished its turn.

  office-workers dismiss <name>
      Sends a subagent home. Its worktree and branch stay when they hold work (commits or
      changes); otherwise they're deleted.

  office-workers report [--question] <<'EOF'
  …your report…
  EOF
      For a subagent: tells your lead what you did, or with --question asks it something. End your
      turn after it; the answer comes as your next message.

  A <name> is the subagent's name (Pixel) or id, as hire and list print them.

HOW TO RUN A TEAM

  1. Split the work into pieces that don't touch the same files. Hire one subagent per piece, and
     no more than the work needs.
  2. A subagent starts knowing nothing. Write its brief like a ticket: the goal, where to look,
     what's off limits, how to check the work, and how to finish (commit in its worktree and open a
     pull request, or just report back).
  3. Give every brief and message on stdin in a quoted heredoc (<<'EOF'), so the shell leaves quotes,
     $ and backticks in it alone.
  4. Wait for news with office-workers wait and deal with it: answer questions with send, look at
     what was done (git -C <its worktree> log, diff), and send a follow-up if it isn't finished.
     When whoami says the office wakes you, you can end your turn instead: the office types a note
     to you once your team has news.
  5. A question only a person can answer goes to whoever asked you. So does a subagent waiting on its
     own terminal (a permission prompt): tell them which desk it's at.
  6. When everything is done, tell whoever asked what each subagent did, with links. Don't dismiss
     your team unless you're asked to: people may want to look at their work first.

Subagents can't hire subagents of their own. Everything here happens on this floor of the office.`;

/** A mistake in how the command was called: the usage is shown with it. */
export class UsageError extends Error {}

const ENV = ['DROID_OFFICE_HOOK_URL', 'DROID_OFFICE_WORKER_ID', 'DROID_OFFICE_HOOK_TOKEN'];
/** How long the office may take to come back when it's restarting (a dev reload, an upgrade). */
const RETRY_MS = 6000;
const TIMEOUT_MS = 30_000;
export const WAIT_DEFAULT_S = 50;
export const WAIT_MAX_S = 1800;
export const POLL_MS = 2000;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Each command's options: true takes a value, false is a switch. */
const OPTIONS = {
  whoami: {},
  list: {},
  hire: { '--title': true, '--model': true, '--effort': true, '--worktree': false, '--no-worktree': false, '--task': true },
  wait: { '--all': false, '--timeout': true },
  read: { '--lines': true },
  send: { '--message': true },
  dismiss: {},
  report: { '--question': false, '--message': true },
};
/** How many names each command takes: [least, most]. */
const NAMES = { whoami: [0, 0], list: [0, 0], hire: [0, 0], wait: [0, Infinity], read: [1, 1], send: [1, 1], dismiss: [1, 1], report: [0, 0] };
const ALIASES = { ls: 'list', who: 'whoami', fire: 'dismiss', tail: 'read', ask: 'send' };

/**
 * What the command line asks for: { cmd, names, opts }, or { cmd: 'help' }.
 * @param {string[]} argv the arguments after the command's name
 */
export function parseArgs(argv) {
  const [first, ...rest] = argv;
  const help = (a) => a === '-h' || a === '--help';
  if (first === undefined || first === 'help' || help(first) || rest.some(help)) return { cmd: 'help', full: first === undefined || first === 'help' || help(first) };
  const cmd = ALIASES[first] ?? first;
  const allowed = OPTIONS[cmd];
  if (!allowed) throw new UsageError(`Unknown command: ${first}`);
  /** @type {string[]} */
  const names = [];
  /** @type {Record<string, string | boolean>} */
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith('--')) {
      names.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    if (!(flag in allowed)) throw new UsageError(`Unknown option for ${cmd}: ${flag}`);
    if (!allowed[flag]) {
      if (eq > 0) throw new UsageError(`${flag} takes no value`);
      opts[flag] = true;
      continue;
    }
    if (eq > 0) opts[flag] = arg.slice(eq + 1);
    else if (i + 1 < rest.length) opts[flag] = rest[++i];
    else throw new UsageError(`${flag} needs a value`);
  }
  const [least, most] = NAMES[cmd];
  if (names.length < least) throw new UsageError(`${cmd} takes the subagent's name, e.g. office-workers ${cmd} Pixel`);
  if (names.length > most) throw new UsageError(most ? `${cmd} takes one subagent's name (got ${names.join(' ')})` : `Unexpected argument: ${names[0]}${cmd === 'hire' ? ' (quote the title, and give the brief on stdin)' : ''}`);
  if (opts['--worktree'] && opts['--no-worktree']) throw new UsageError('Pick --worktree or --no-worktree, not both');
  if (typeof opts['--effort'] === 'string' && !EFFORTS.includes(opts['--effort'])) throw new UsageError(`--effort is one of ${EFFORTS.join(', ')} (got ${opts['--effort']})`);
  for (const [flag, max] of [
    ['--timeout', WAIT_MAX_S],
    ['--lines', 400],
  ]) {
    if (opts[flag] === undefined) continue;
    const n = Number(opts[flag]);
    if (!Number.isInteger(n) || n < 1 || n > max) throw new UsageError(`${flag} takes a whole number from 1 to ${max} (got ${opts[flag]})`);
    opts[flag] = n;
  }
  return { cmd, names, opts };
}

/** Whether the command's text comes in on stdin when it isn't given as an option. */
export function needsText(cmd) {
  return (cmd.cmd === 'hire' && cmd.opts['--task'] === undefined) || ((cmd.cmd === 'send' || cmd.cmd === 'report') && cmd.opts['--message'] === undefined);
}

/**
 * The office's address and this agent's id and token, from the environment.
 * @param {Record<string, string | undefined>} env
 */
export function officeEnv(env) {
  const missing = ENV.filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(`${missing.join(', ')} ${missing.length === 1 ? "isn't" : "aren't"} set. office-workers only works inside Droid Office, from the terminal of one of its agents.`);
  }
  return { url: env.DROID_OFFICE_HOOK_URL.replace(/\/+$/, ''), worker: env.DROID_OFFICE_WORKER_ID, token: env.DROID_OFFICE_HOOK_TOKEN };
}

/**
 * The JSON body for a parsed command. `text` is what came in on stdin, for a command that takes some.
 * @param {ReturnType<typeof parseArgs>} cmd
 * @param {string} [text]
 */
export function buildBody(cmd, text) {
  const o = cmd.opts;
  const given = (/** @type {unknown} */ v) => (typeof v === 'string' ? v : (text ?? '')).replace(/\r\n?/g, '\n').trim();
  switch (cmd.cmd) {
    case 'whoami':
    case 'list':
      return { action: cmd.cmd };
    case 'hire': {
      const task = given(o['--task']);
      if (!task) throw new UsageError(`The subagent needs a brief: pipe it in (office-workers hire --title "…" <<'EOF' … EOF)`);
      return {
        action: 'hire',
        task,
        ...(typeof o['--title'] === 'string' && o['--title'].trim() ? { title: o['--title'].trim() } : {}),
        ...(typeof o['--model'] === 'string' && o['--model'].trim() ? { model: o['--model'].trim() } : {}),
        ...(typeof o['--effort'] === 'string' ? { effort: o['--effort'] } : {}),
        ...(o['--no-worktree'] ? { worktree: false } : o['--worktree'] ? { worktree: true } : {}),
      };
    }
    case 'wait':
      return { action: 'events', ...(cmd.names.length ? { workers: cmd.names } : {}) };
    case 'read':
      return { action: 'read', worker: cmd.names[0], ...(typeof o['--lines'] === 'number' ? { lines: o['--lines'] } : {}) };
    case 'send': {
      const message = given(o['--message']);
      if (!message) throw new UsageError(`Give the message on stdin (office-workers send ${cmd.names[0]} <<'EOF' … EOF)`);
      return { action: 'send', worker: cmd.names[0], text: message };
    }
    case 'dismiss':
      return { action: 'dismiss', worker: cmd.names[0] };
    case 'report': {
      const report = given(o['--message']);
      if (!report) throw new UsageError(`Give the ${o['--question'] ? 'question' : 'report'} on stdin (office-workers report${o['--question'] ? ' --question' : ''} <<'EOF' … EOF)`);
      return { action: 'report', text: report, ...(o['--question'] ? { question: true } : {}) };
    }
    default:
      throw new Error(`No request for ${cmd.cmd}`);
  }
}

/**
 * The HTTP request for a body.
 * @param {Record<string, unknown>} body
 * @param {{ url: string, worker: string, token: string }} office
 */
export function buildRequest(body, office) {
  const url = new URL(`${office.url}/office/workers`);
  url.searchParams.set('worker', office.worker);
  return { method: 'POST', url: url.href, headers: { authorization: `Bearer ${office.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

/** e.g. "3m ago" */
export function ago(at, now) {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

const indent = (text, by = '    ') =>
  String(text)
    .split('\n')
    .map((l) => (l ? by + l : l))
    .join('\n');

/** Who you are, from whoami (or list). */
export function formatWho(view) {
  const you = view?.you ?? {};
  const lines = [];
  if (view?.lead) lines.push(`You're ${you.name} at ${you.desk}, a subagent of ${view.lead.name}.`);
  else if (you.role === 'lead') lines.push(`You're ${you.name} at ${you.desk}, a lead with ${view.subagents} of at most ${view.max} subagents.`);
  else lines.push(`You're ${you.name} at ${you.desk}, with no subagents yet (at most ${view?.max} at once).`);
  if (view?.canHire) {
    lines.push(`You can hire. New subagents ${view.worktree ? 'get their own git worktree' : 'work in the main checkout (this floor has no worktrees)'}.`);
    lines.push(view.wakeLead ? 'The office wakes you when your team has news, so you can end your turn while they work.' : "The office doesn't wake you when your team has news: check with office-workers wait.");
  } else lines.push(`You can't hire: ${view?.why ?? 'not allowed'}.`);
  if (view?.lead) lines.push(`When you're done, report to ${view.lead.name} with office-workers report.`);
  return lines.join('\n');
}

/** One subagent, a few lines. */
export function formatMember(m, now = Date.now()) {
  const engine = [m.model, m.effort].filter(Boolean).join(' ');
  const lines = [`${m.name} (${m.id}) · ${m.status}${m.settled ? '' : ' …'} · ${m.desk}${engine ? ` · ${engine}` : ''}`];
  if (m.task) lines.push(`  task: ${m.task}`);
  if (m.activity) lines.push(`  doing: ${m.activity}`);
  if (m.worktree) lines.push(`  worktree: ${m.worktree.path} on ${m.worktree.branch}`);
  else lines.push('  in the main checkout');
  if (m.pr) lines.push(`  pull request #${m.pr.number}: ${m.pr.url}`);
  if (m.report) lines.push(`  last ${m.report.question ? 'question' : 'report'} (${ago(m.report.at, now)}):`, indent(m.report.text));
  return lines.join('\n');
}

/** Your team, from list. */
export function formatTeam(view, now = Date.now()) {
  const team = view?.team ?? [];
  if (!team.length) return `You have no subagents.${view?.canHire ? ' Hire one with office-workers hire.' : ''}`;
  return [`${team.length} subagent${team.length === 1 ? '' : 's'} (at most ${view.max}):`, ...team.map((m) => formatMember(m, now))].join('\n\n');
}

const SAID = {
  report: (e) => `📨 ${e.name} reported:`,
  question: (e) => `❓ ${e.name} asked:`,
  done: (e) => `✅ ${e.name} finished its turn without reporting${e.text ? `: ${e.text}` : ''}. Read its terminal with office-workers read ${e.name}.`,
  needs_input: (e) => `✋ ${e.name} is waiting on an answer in its own terminal${e.text ? ` (${e.text})` : ''}: someone has to answer it there.`,
  stopped: (e) => `⛔ ${e.name} stopped${e.text ? ` (${e.text})` : ''}.`,
  left: (e) => `👋 ${e.name} left the floor.`,
};

/** What came back from wait. */
export function formatEvents(events) {
  return events
    .map((e) => {
      const head = (SAID[e.kind] ?? ((x) => `${x.name}: ${x.kind}`))(e);
      return (e.kind === 'report' || e.kind === 'question') && e.text ? `${head}\n${indent(e.text)}` : head;
    })
    .join('\n\n');
}

/** Where the team stands, in a line or two. */
export function formatStanding(team) {
  const busy = team.filter((m) => !m.settled);
  const rest = team.filter((m) => m.settled);
  const who = (ms) => ms.map((m) => `${m.name} (${m.status}, ${m.desk})`).join(', ');
  const parts = [];
  if (busy.length) parts.push(`Still working: ${who(busy)}.`);
  if (rest.length) parts.push(`At rest: ${who(rest)}.`);
  return parts.join(' ');
}

/** Why the office turned a request down, in words. */
export function refusal(status, body) {
  const said = body && typeof body.error === 'string' ? body.error : '';
  if (status === 401) return `The office didn't accept this agent's token (401)${said ? `: ${said}` : ''}. Is this the terminal of a Droid Office droid that's still running?`;
  return `The office said no (${status})${said ? `: ${said}` : ''}.`;
}

/** Sends the request, retrying for a few seconds while nothing's listening (the office restarting). */
async function send(req, fetchImpl, sleep) {
  const until = Date.now() + RETRY_MS;
  for (;;) {
    try {
      const res = await fetchImpl(req.url, { method: req.method, headers: req.headers, body: req.body, signal: AbortSignal.timeout(TIMEOUT_MS) });
      const text = await res.text();
      let body;
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = { error: text.slice(0, 300) };
      }
      return { status: res.status, body };
    } catch (err) {
      const code = err?.cause?.code ?? err?.code;
      if (code === 'ECONNREFUSED' && Date.now() < until) {
        await sleep(1000);
        continue;
      }
      throw new Error(`Couldn't reach the office at ${new URL(req.url).origin} (${code ?? err?.message ?? err}). Is it running?`);
    }
  }
}

function readStdin(stdin) {
  return new Promise((resolve, reject) => {
    let data = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (c) => (data += c));
    stdin.on('end', () => resolve(data));
    stdin.on('error', reject);
  });
}

class Refused extends Error {}

/**
 * Runs the command; resolves to its exit code.
 * @param {string[]} argv
 * @param {{ env?: Record<string, string | undefined>, stdin?: NodeJS.ReadableStream & { isTTY?: boolean }, fetch?: typeof fetch, out?: (s: string) => void, err?: (s: string) => void, sleep?: (ms: number) => Promise<void>, now?: () => number }} [io]
 */
export async function main(argv, io = {}) {
  const env = io.env ?? process.env;
  const stdin = io.stdin ?? process.stdin;
  const fetchImpl = io.fetch ?? fetch;
  const out = io.out ?? ((s) => process.stdout.write(`${s}\n`));
  const err = io.err ?? ((s) => process.stderr.write(`${s}\n`));
  const sleep = io.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = io.now ?? Date.now;
  try {
    const cmd = parseArgs(argv);
    if (cmd.cmd === 'help') {
      out(cmd.full ? GUIDE : USAGE);
      return 0;
    }
    const office = officeEnv(env);
    let text;
    if (needsText(cmd)) {
      if (stdin.isTTY) throw new UsageError(`${cmd.cmd} needs its text on stdin: pipe it in with a quoted heredoc (<<'EOF' … EOF)`);
      text = await readStdin(stdin);
    }
    const body = buildBody(cmd, text);
    const call = async (b) => {
      const res = await send(buildRequest(b, office), fetchImpl, sleep);
      if (res.status < 200 || res.status >= 300) throw new Refused(refusal(res.status, res.body));
      return res.body;
    };
    if (cmd.cmd === 'wait') return await wait(cmd, body, call, { out, sleep, now });
    const res = await call(body);
    if (cmd.cmd === 'whoami') out(formatWho(res));
    else if (cmd.cmd === 'list') out(`${formatWho(res)}\n\n${formatTeam(res, now())}`);
    else if (cmd.cmd === 'hire') {
      const w = res.worker ?? {};
      out(`Hired ${w.name} (${w.id}) at ${w.desk}${w.worktree ? `, in its own worktree ${w.worktree.path} on ${w.worktree.branch}` : ', in the main checkout'}.`);
      out(`It's on it. Wait for its report with office-workers wait, or see its terminal with office-workers read ${w.name}.`);
    } else if (cmd.cmd === 'read') out(res.text || `(${res.worker?.name ?? cmd.names[0]}'s terminal is empty)`);
    else if (cmd.cmd === 'send') out(`Sent to ${res.worker?.name ?? cmd.names[0]}.`);
    else if (cmd.cmd === 'dismiss') out(`Sent ${res.name ?? cmd.names[0]} home.${res.note ? ` ${res.note}.` : ''}`);
    else if (cmd.cmd === 'report') out(`${cmd.opts['--question'] ? 'Asked' : 'Reported to'} ${res.lead}. End your turn now: ${res.lead} answers with your next message.`);
    return 0;
  } catch (e) {
    err(`office-workers: ${e.message}`);
    if (e instanceof UsageError) err(`\n${USAGE}`);
    return e instanceof UsageError ? 2 : 1;
  }
}

/** Polls for news until there is some (or, with --all, until the team is at rest), or time's up. */
async function wait(cmd, body, call, { out, sleep, now }) {
  const all = cmd.opts['--all'] === true;
  const seconds = typeof cmd.opts['--timeout'] === 'number' ? cmd.opts['--timeout'] : WAIT_DEFAULT_S;
  const deadline = now() + seconds * 1000;
  const named = new Set(cmd.names.map((n) => n.toLowerCase()));
  const got = [];
  for (;;) {
    const res = await call(body);
    const events = res.events ?? [];
    got.push(...events);
    // What came in is printed at once: the office counts it as heard.
    if (events.length) out(formatEvents(events));
    const team = res.team ?? [];
    const watched = named.size ? team.filter((m) => named.has(m.name.toLowerCase()) || named.has(m.id)) : team;
    if (!team.length && !got.length) {
      out('You have no subagents to wait for.');
      return 0;
    }
    const done = all ? watched.every((m) => m.settled) : got.length > 0;
    if (done || now() >= deadline) {
      if (!done) out(`${got.length ? '\n' : ''}Nothing ${got.length ? 'more ' : ''}after ${seconds}s. Run office-workers wait again to keep waiting.`);
      const standing = formatStanding(team);
      if (standing) out(`\n${standing}`);
      return 0;
    }
    await sleep(Math.min(POLL_MS, Math.max(0, deadline - now())));
  }
}

const invoked = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invoked) process.exitCode = await main(process.argv.slice(2));

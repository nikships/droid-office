#!/usr/bin/env node
// office-visit: visits between the independent workers on a floor of Droid Office (see
// src/server/visits.ts). The office puts it on every agent's PATH next to office-workers, with the
// same DROID_OFFICE_HOOK_URL, DROID_OFFICE_WORKER_ID and DROID_OFFICE_HOOK_TOKEN; this talks to the
// /office/visits endpoint with them. Plain Node, no build step, no dependencies.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const USAGE = `Usage:
  office-visit roster                           the independent workers on this floor, and what each is on
  office-visit look <name> [--lines <n>]        walks over and reads the end of its terminal
  office-visit tell <name> [--urgent] <<'EOF'   walks over and tells it something
  …
  EOF
  office-visit ask <name> [--urgent] [--timeout <s>] <<'EOF'
  …the question…                                walks over, asks, and waits there for the answer
  EOF
  office-visit handoff <name> [--title "…"] [--urgent] <<'EOF'
  …the task…                                    walks over and asks it to take on a task
  EOF
  office-visit reply <visit-id> <<'EOF'         answers a question another worker asked you
  …
  EOF
  office-visit whoami                           who you are here, and whether you can visit
  office-visit help                             the whole guide`;

const GUIDE = `office-visit: visit the other independent workers on your floor of Droid Office.

An independent worker is one the owner hired: it has no lead. A lead with subagents of its own is one
too. Independent workers on the same floor can visit each other. The visitor gets up, walks over to
the other worker's desk (the host's), and the office shows it there: leaning over the laptop to read
the screen, or standing at the desk with a speech bubble while it talks and waits for an answer. Then
it walks back to its own desk. Everything works both ways: the host can visit you back the same way.

Subagents take no part. A subagent can't see the roster or visit anyone, and nobody can visit a
subagent: only its own lead reaches it, with office-workers. Workers on other floors aren't listed.
The owner can turn visits off for the whole office (⚙️ Settings → Subagents & visits → Visits); then every
command here is refused.

COMMANDS

  office-visit roster
      The independent workers on this floor, you included: name, desk, status (busy or idle), the
      task on the card over its head, what it's doing now, and whose desk it's at if it's out
      visiting.

  office-visit look <name> [--lines <n>]
      Walks to its desk, reads the last lines of its terminal (80 unless you say, at most 400) and
      prints them, then walks back. Nothing is typed into its session: it isn't told.

  office-visit tell <name> [--urgent] <<'EOF'
  …the message…
  EOF
      Walks over and puts a message into its session, headed with your name and desk and how to
      answer. It goes in as soon as you arrive: typed with Enter while it's mid-turn, it steers
      that turn, so it reads your message once its current tool call finishes and carries on; at
      rest it's simply its next prompt. Only when its session can't take it while you stand there
      (a permission prompt is showing, say) do you walk back after a few seconds and leave it to
      go in as soon as it can. --urgent cancels the turn it's in (one Escape, as the owner would
      press) and puts the message in as its next prompt once the turn has stopped, at most 5
      seconds later. Prints whether it went in.

  office-visit ask <name> [--urgent] [--timeout <seconds>] <<'EOF'
  …the question…
  EOF
      Walks over, asks, and stands at its desk until it answers with office-visit reply, then
      prints the answer and walks back. --timeout is how long you wait in all, walking included:
      300 seconds unless you say (at most 1800). If it runs out you give up, walk back, and this
      exits with status 1. Give your shell tool a longer timeout than --timeout.

  office-visit handoff <name> [--title "Short title"] [--urgent] <<'EOF'
  …the task…
  EOF
      Like tell, for work you want it to take on: write it as a complete brief (the goal, where to
      look, how to check it, how to finish), because it knows nothing of your task. It decides
      whether it fits what the owner asked it, and tells you back with office-visit tell.

  office-visit reply <visit-id> <<'EOF'
  …your answer…
  EOF
      Answers a question another worker asked you. The message that asked it has the exact command,
      with the visit id (v-…). The asker gets your answer in its terminal and walks back.

  office-visit whoami
      Your name and desk, and whether you're out on a visit now.

  A <name> is a worker's name (Nibble) or id, as roster prints them.

PRIORITY

  Normal is right almost always: it steers the other worker's turn, so it reads your message as
  soon as its current tool call finishes, and its work carries on. Use --urgent only when even
  that wait would waste real work: it is about to change code you're changing, or it's blocked on
  what you know. Urgent stops what the other worker is doing, a running command included; it
  decides afterwards whether to go back to it. Even an urgent message waits while the other
  worker's terminal shows a permission prompt: that's for the owner to answer.

ONE VISIT AT A TIME

  You're at one desk at a time: a second visit while you're still on one is refused. Once a visit has
  its outcome (a look has printed the screen), the next one waits for you to walk back, then sets off.
  Two workers can
  visit one host at once; they stand side by side and the host gets their messages one after the
  other, never mixed.

WHAT YOU GET IN YOUR SESSION

  When someone visits you, its message arrives in your session headed with its name and desk. It's
  from a worker, not the owner: weigh it against what the owner asked you. Answer an ask with the
  office-visit reply command in it. Tell back only when there's something to say: a message just to
  acknowledge or thank starts another turn for the other worker.

Give every message, question, task and answer on stdin in a quoted heredoc (<<'EOF'), so the shell
leaves quotes, $ and backticks in it alone.`;

/** A mistake in how the command was called: the usage is shown with it. */
export class UsageError extends Error {}

const ENV = ['DROID_OFFICE_HOOK_URL', 'DROID_OFFICE_WORKER_ID', 'DROID_OFFICE_HOOK_TOKEN'];
/** How long the office may take to come back when it's restarting (a dev reload, an upgrade). */
const RETRY_MS = 6000;
const TIMEOUT_MS = 30_000;
export const ASK_DEFAULT_S = 300;
export const ASK_MAX_S = 1800;
const LINES_MAX = 400;
export const POLL_MS = 1000;
/** How long look, tell and handoff wait on the office before giving up on it: a long walk and a busy host. */
export const VISIT_WAIT_S = 180;

/** Each command's options: true takes a value, false is a switch. */
const OPTIONS = {
  whoami: {},
  roster: {},
  look: { '--lines': true },
  tell: { '--urgent': false, '--message': true },
  ask: { '--urgent': false, '--timeout': true, '--message': true },
  handoff: { '--urgent': false, '--title': true, '--message': true },
  reply: { '--message': true },
};
/** How many names each command takes: [least, most]. */
const NAMES = { whoami: [0, 0], roster: [0, 0], look: [1, 1], tell: [1, 1], ask: [1, 1], handoff: [1, 1], reply: [1, 1] };
const ALIASES = { ls: 'roster', list: 'roster', who: 'roster', read: 'look', say: 'tell', send: 'tell', answer: 'reply', hand: 'handoff' };
const TEXT_CMDS = new Set(['tell', 'ask', 'handoff', 'reply']);

/**
 * What the command line asks for: { cmd, names, opts }, or { cmd: 'help' }.
 * @param {string[]} argv the arguments after the command's name
 */
export function parseArgs(argv) {
  const [first, ...rest] = argv;
  const help = (a) => a === '-h' || a === '--help';
  const full = first === undefined || first === 'help' || help(first);
  if (full || rest.some(help)) return { cmd: 'help', full };
  const cmd = ALIASES[first] ?? first;
  const allowed = OPTIONS[cmd];
  if (!allowed) throw new UsageError(`Unknown command: ${first}`);
  /** @type {string[]} */
  const names = [];
  /** @type {Record<string, string | boolean | number>} */
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
  if (names.length < least) throw new UsageError(cmd === 'reply' ? 'reply takes the visit id from the question, e.g. office-visit reply v-1a2b3c4d' : `${cmd} takes the worker's name, e.g. office-visit ${cmd} Nibble`);
  if (names.length > most) throw new UsageError(most ? `${cmd} takes one ${cmd === 'reply' ? 'visit id' : "worker's name"} (got ${names.join(' ')}): give the text on stdin` : `Unexpected argument: ${names[0]}`);
  for (const [flag, max] of [
    ['--timeout', ASK_MAX_S],
    ['--lines', LINES_MAX],
  ]) {
    if (opts[flag] === undefined) continue;
    const n = Number(opts[flag]);
    if (!Number.isInteger(n) || n < 1 || n > max) throw new UsageError(`${flag} takes a whole number from 1 to ${max} (got ${opts[flag]})`);
    opts[flag] = n;
  }
  return { cmd, names, opts };
}

/** Whether the command's text comes in on stdin when it isn't given as --message. */
export function needsText(cmd) {
  return TEXT_CMDS.has(cmd.cmd) && cmd.opts['--message'] === undefined;
}

/**
 * The office's address and this agent's id and token, from the environment.
 * @param {Record<string, string | undefined>} env
 */
export function officeEnv(env) {
  const missing = ENV.filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(`${missing.join(', ')} ${missing.length === 1 ? "isn't" : "aren't"} set. office-visit only works inside Droid Office, from the terminal of one of its agents.`);
  }
  return { url: env.DROID_OFFICE_HOOK_URL.replace(/\/+$/, ''), worker: env.DROID_OFFICE_WORKER_ID, token: env.DROID_OFFICE_HOOK_TOKEN };
}

const WHAT = { tell: 'message', ask: 'question', handoff: 'task', reply: 'answer' };

/**
 * The JSON body for a parsed command. `text` is what came in on stdin, for a command that takes some.
 * @param {ReturnType<typeof parseArgs>} cmd
 * @param {string} [text]
 */
export function buildBody(cmd, text) {
  const o = cmd.opts;
  const given = (typeof o['--message'] === 'string' ? o['--message'] : (text ?? '')).replace(/\r\n?/g, '\n').trim();
  if (TEXT_CMDS.has(cmd.cmd) && !given) throw new UsageError(`Give the ${WHAT[cmd.cmd]} on stdin (office-visit ${cmd.cmd} ${cmd.names[0]} <<'EOF' … EOF)`);
  switch (cmd.cmd) {
    case 'whoami':
    case 'roster':
      return { action: cmd.cmd };
    case 'look':
      return { action: 'visit', kind: 'look', worker: cmd.names[0], ...(typeof o['--lines'] === 'number' ? { lines: o['--lines'] } : {}) };
    case 'tell':
    case 'handoff':
    case 'ask':
      return {
        action: 'visit',
        kind: cmd.cmd,
        worker: cmd.names[0],
        text: given,
        ...(o['--urgent'] ? { urgent: true } : {}),
        ...(cmd.cmd === 'ask' ? { timeout: typeof o['--timeout'] === 'number' ? o['--timeout'] : ASK_DEFAULT_S } : {}),
        ...(cmd.cmd === 'handoff' && typeof o['--title'] === 'string' && o['--title'].trim() ? { title: o['--title'].trim() } : {}),
      };
    case 'reply':
      return { action: 'reply', visit: cmd.names[0], text: given };
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
  const url = new URL(`${office.url}/office/visits`);
  url.searchParams.set('worker', office.worker);
  return { method: 'POST', url: url.href, headers: { authorization: `Bearer ${office.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

const indent = (text, by = '    ') =>
  String(text)
    .split('\n')
    .map((l) => (l ? by + l : l))
    .join('\n');

/** The roster, from roster. */
export function formatRoster(view) {
  const you = view?.you ?? {};
  const all = view?.roster ?? [];
  const lines = [`You're ${you.name} at ${you.desk}.${view?.visiting ? ` You're at ${view.visiting.host}'s desk now (${view.visiting.kind}, ${view.visiting.visit}).` : ''}`];
  const others = all.filter((w) => !w.you);
  if (!others.length) {
    lines.push('', 'No other independent workers on this floor: there is no one to visit.');
    return lines.join('\n');
  }
  lines.push('', `${all.length} independent worker${all.length === 1 ? '' : 's'} on this floor:`);
  for (const w of all) {
    lines.push(`  ${w.name}${w.you ? ' (you)' : ''} (${w.id}) · ${w.desk} · ${w.busy ? 'busy' : 'idle'} (${w.status})${w.visiting ? ` · at ${w.visiting}'s desk` : ''}`);
    if (w.task) lines.push(`      task: ${w.task}`);
    if (w.activity) lines.push(`      doing: ${w.activity}`);
  }
  return lines.join('\n');
}

/** What a finished visit printed, and the exit code it ends with. */
export function formatOutcome(kind, host, res) {
  if (!res?.ok) return { text: `office-visit: ${res?.error ?? 'The visit ended without an answer'}.`, code: 1 };
  if (kind === 'look') return { text: `${host}'s screen:\n\n${res.text || '(its terminal is empty)'}`, code: 0 };
  if (kind === 'ask') return { text: `${host} answered:\n${indent(res.answer ?? '')}`, code: 0 };
  const what = kind === 'handoff' ? 'The task' : 'Your message';
  if (res.queued) return { text: `${host}'s session couldn't take it while you stood there, so you walked back and left it: ${what.toLowerCase()} is typed in as soon as its session can take it.`, code: 0 };
  return { text: `${what} is in ${host}'s session now.${kind === 'handoff' ? ` ${host} decides whether to take it on, and tells you back with office-visit tell.` : ''}`, code: 0 };
}

/** Why the office turned a request down, in words. */
export function refusal(status, body) {
  const said = body && typeof body.error === 'string' ? body.error : '';
  if (status === 401) return `The office didn't accept this agent's token (401)${said ? `: ${said}` : ''}. Is this the terminal of a Droid Office worker that's still running?`;
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
    const res = await call(body);
    if (cmd.cmd === 'whoami') {
      out(`You're ${res.you?.name} at ${res.you?.desk}. You can visit the other independent workers on this floor: office-visit roster lists them.`);
      if (res.visiting) out(`You're at ${res.visiting.host}'s desk now (${res.visiting.kind}, ${res.visiting.visit}).`);
      return 0;
    }
    if (cmd.cmd === 'roster') {
      out(formatRoster(res));
      return 0;
    }
    if (cmd.cmd === 'reply') {
      out(`Answered ${res.to}. It has your answer and walks back to its desk.`);
      return 0;
    }
    return await follow(cmd, res, call, { out, sleep, now });
  } catch (e) {
    err(`office-visit: ${e.message}`);
    if (e instanceof UsageError) err(`\n${USAGE}`);
    return e instanceof UsageError ? 2 : 1;
  }
}

/** Waits for a visit that has begun to come to its outcome, and prints it. */
async function follow(cmd, started, call, { out, sleep, now }) {
  const kind = cmd.cmd;
  const host = started.host?.name ?? cmd.names[0];
  const desk = started.host?.desk ? ` at ${started.host.desk}` : '';
  const doing = { look: 'to read its screen', tell: 'to tell it', ask: 'to ask it', handoff: 'to hand it the task' }[kind];
  out(started.after ? `You're finishing your last visit; then you go over to ${host}${desk} ${doing}.` : `Walking over to ${host}${desk} ${doing}…`);
  const waitS = kind === 'ask' ? (typeof started.timeout === 'number' ? started.timeout : ASK_DEFAULT_S) + 60 : VISIT_WAIT_S;
  const until = now() + waitS * 1000;
  let said = false;
  for (;;) {
    await sleep(POLL_MS);
    const s = await call({ action: 'status', visit: started.visit });
    if (s.done) {
      const { text, code } = formatOutcome(kind, host, s);
      out(text);
      return code;
    }
    if (kind === 'ask' && s.phase === 'waiting' && !said) {
      said = true;
      out(`Asked. Waiting at ${host}'s desk for its answer (visit ${started.visit})…`);
    }
    if (now() >= until) {
      out(`office-visit: the office didn't finish the visit in ${waitS}s. It may still be going: office-visit whoami says where you are.`);
      return 1;
    }
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

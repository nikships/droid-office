#!/usr/bin/env node
// office-jira: the Jira ticket a worker was handed, from inside Agent Office (see src/server/jira.ts).
// The office puts it on its workers' PATH with their own address and token in AGENT_OFFICE_HOOK_URL,
// AGENT_OFFICE_WORKER_ID and AGENT_OFFICE_HOOK_TOKEN; this talks to the /office/jira endpoint with
// them. The office holds the Jira token and only lets a worker touch its own ticket. Plain Node, no
// build step, no dependencies.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const USAGE = `Usage:
  office-jira view                    your ticket: status, description and comments
  office-jira transitions             the statuses it can move to from where it is
  office-jira transition "In Review"  move it (a status or transition name)
  office-jira comment <<'EOF'         comment on it, the text on stdin (or: office-jira comment "…")
  …the comment…
  EOF

It only works for the ticket you were handed. Add --key <KEY> to any of them to say which one you
mean; any other ticket is refused.`;

/** A mistake in how the command was called: the usage is shown with it. */
export class UsageError extends Error {}

const ENV = ['AGENT_OFFICE_HOOK_URL', 'AGENT_OFFICE_WORKER_ID', 'AGENT_OFFICE_HOOK_TOKEN'];
/** How long the office may take to come back when it's restarting (a dev reload, an upgrade). */
const RETRY_MS = 6000;
const TIMEOUT_MS = 30_000;

/**
 * What the command line asks for:
 * { cmd: 'help' } | { cmd: 'view' | 'transitions', key? } | { cmd: 'transition', to, key? } | { cmd: 'comment', text?, key? }.
 * @param {string[]} argv the arguments after the command's name
 */
export function parseArgs(argv) {
  const help = (a) => a === '-h' || a === '--help';
  const args = [];
  let key;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--key' || a.startsWith('--key=')) {
      const v = a === '--key' ? argv[++i] : a.slice(6);
      if (!v) throw new UsageError('--key needs a ticket key, e.g. --key EDP-12');
      key = v.trim();
    } else args.push(a);
  }
  const [cmd, ...rest] = args;
  if (cmd === undefined || cmd === 'help' || help(cmd) || rest.some(help)) return { cmd: 'help' };
  const withKey = (o) => (key ? { ...o, key } : o);
  if (cmd === 'view' || cmd === 'show') {
    if (rest.length) throw new UsageError(`view takes no arguments (got ${rest.join(' ')})`);
    return withKey({ cmd: 'view' });
  }
  if (cmd === 'transitions') {
    if (rest.length) throw new UsageError(`transitions takes no arguments (got ${rest.join(' ')})`);
    return withKey({ cmd: 'transitions' });
  }
  if (cmd === 'transition' || cmd === 'move') {
    const to = rest.join(' ').trim();
    if (!to) throw new UsageError('Say where to move it, e.g. office-jira transition "In Review" (office-jira transitions lists them)');
    return withKey({ cmd: 'transition', to });
  }
  if (cmd === 'comment') {
    const text = rest.join(' ').trim();
    return withKey(text ? { cmd: 'comment', text } : { cmd: 'comment' });
  }
  throw new UsageError(`Unknown command: ${cmd}`);
}

/**
 * The office's address and this worker's name and token, from the environment.
 * @param {Record<string, string | undefined>} env
 */
export function officeEnv(env) {
  const missing = ENV.filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(`${missing.join(', ')} ${missing.length === 1 ? "isn't" : "aren't"} set. office-jira only works inside Agent Office, from the terminal of a worker that was handed a Jira ticket.`);
  }
  return { url: env.AGENT_OFFICE_HOOK_URL.replace(/\/+$/, ''), worker: env.AGENT_OFFICE_WORKER_ID, token: env.AGENT_OFFICE_HOOK_TOKEN };
}

/**
 * The HTTP request for a parsed command (anything but help). `stdin` is the comment's text when it
 * wasn't given on the command line.
 * @param {ReturnType<typeof parseArgs>} cmd
 * @param {{ url: string, worker: string, token: string }} office
 * @param {string} [stdin]
 * @returns {{ method: string, url: string, headers: Record<string, string>, body?: string }}
 */
export function buildRequest(cmd, office, stdin) {
  const url = new URL(`${office.url}/office/jira`);
  url.searchParams.set('worker', office.worker);
  if (cmd.key) url.searchParams.set('key', cmd.key);
  const headers = { authorization: `Bearer ${office.token}` };
  if (cmd.cmd === 'view') return { method: 'GET', url: url.href, headers };
  if (cmd.cmd === 'transitions') {
    url.searchParams.set('what', 'transitions');
    return { method: 'GET', url: url.href, headers };
  }
  const json = { ...headers, 'content-type': 'application/json' };
  if (cmd.cmd === 'transition') return { method: 'POST', url: url.href, headers: json, body: JSON.stringify({ action: 'transition', to: cmd.to }) };
  if (cmd.cmd !== 'comment') throw new Error(`No request for ${cmd.cmd}`);
  const text = (cmd.text ?? stdin ?? '').replace(/\r\n?/g, '\n').trim();
  if (!text) throw new UsageError(`The comment is empty: pipe it in (office-jira comment <<'EOF' … EOF) or pass it as an argument`);
  return { method: 'POST', url: url.href, headers: json, body: JSON.stringify({ action: 'comment', body: text }) };
}

/**
 * The ticket as the office returns it, for reading in a terminal.
 * @param {Record<string, any>} t
 */
export function formatTicket(t) {
  const lines = [`${t.key}  ${t.summary ?? ''}`, `Status: ${t.status ?? '?'} · ${t.type ?? ''}${t.priority ? ` · ${t.priority}` : ''} · ${t.assignee ? `assigned to ${t.assignee}` : 'unassigned'}`];
  if (t.url) lines.push(t.url);
  lines.push('', t.description?.trim() || '(No description.)');
  const comments = Array.isArray(t.comments) ? t.comments : [];
  if (comments.length) {
    lines.push('', `Comments (${comments.length}):`);
    for (const c of comments)
      lines.push(
        '',
        `— ${c.author ?? 'someone'}, ${String(c.created ?? '')
          .slice(0, 16)
          .replace('T', ' ')}`,
        String(c.body ?? '').trim(),
      );
  }
  if (Array.isArray(t.transitions)) lines.push('', `Can move to: ${t.transitions.map((x) => x.to).join(', ') || 'nothing'}`);
  return lines.join('\n');
}

/** The moves a ticket can make, one per line. */
export function formatTransitions(view) {
  const ts = Array.isArray(view?.transitions) ? view.transitions : [];
  if (!ts.length) return `${view?.key ?? 'The ticket'} can't move anywhere from its status.`;
  return [`${view.key} can move to:`, ...ts.map((t) => `  ${t.to}${t.name && t.name !== t.to ? `  (transition "${t.name}")` : ''}`)].join('\n');
}

/** Why the office turned a request down, in words. */
export function refusal(status, body) {
  const said = body && typeof body.error === 'string' ? body.error : '';
  if (status === 401) return `The office didn't accept this worker's token (401)${said ? `: ${said}` : ''}. Is this the terminal of a worker that's still running?`;
  if (status === 403) return `The office said no (403): ${said || 'this worker can only update the Jira ticket it was handed'}.`;
  return `The office said no (${status})${said ? `: ${said}` : ''}.`;
}

/** Sends the request, retrying for a few seconds while nothing's listening (the office restarting). */
async function send(req, fetchImpl) {
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
        await new Promise((r) => setTimeout(r, 1000));
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

/**
 * Runs the command; resolves to its exit code.
 * @param {string[]} argv
 * @param {{ env?: Record<string, string | undefined>, stdin?: NodeJS.ReadableStream & { isTTY?: boolean }, fetch?: typeof fetch, out?: (s: string) => void, err?: (s: string) => void }} [io]
 */
export async function main(argv, io = {}) {
  const env = io.env ?? process.env;
  const stdin = io.stdin ?? process.stdin;
  const fetchImpl = io.fetch ?? fetch;
  const out = io.out ?? ((s) => process.stdout.write(`${s}\n`));
  const err = io.err ?? ((s) => process.stderr.write(`${s}\n`));
  try {
    const cmd = parseArgs(argv);
    if (cmd.cmd === 'help') {
      out(USAGE);
      return 0;
    }
    const office = officeEnv(env);
    let text;
    if (cmd.cmd === 'comment' && cmd.text === undefined) {
      if (stdin.isTTY) throw new UsageError(`The comment needs text: pipe it in (office-jira comment <<'EOF' … EOF) or pass it as an argument`);
      text = await readStdin(stdin);
    }
    const req = buildRequest(cmd, office, text);
    const res = await send(req, fetchImpl);
    if (res.status < 200 || res.status >= 300) {
      err(`office-jira: ${refusal(res.status, res.body)}`);
      return 1;
    }
    if (cmd.cmd === 'view') out(formatTicket(res.body));
    else if (cmd.cmd === 'transitions') out(formatTransitions(res.body));
    else if (cmd.cmd === 'transition') out(`Moved to ${res.body?.status ?? cmd.to}.`);
    else out('Commented.');
    return 0;
  } catch (e) {
    err(`office-jira: ${e.message}`);
    if (e instanceof UsageError) err(`\n${USAGE}`);
    return e instanceof UsageError ? 2 : 1;
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

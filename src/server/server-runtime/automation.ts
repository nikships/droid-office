import type http from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import type { ClientMsg } from '../../shared/protocol.js';
import type { Client, SendTo } from './client.js';
import { readBody, send } from './http-utils.js';
import { num, str } from './validation.js';

/** What an office tab answered a relayed automation command with. */
type AutomationAnswer = { ok: boolean; value?: unknown; error?: string; timedOut?: boolean };
/** Longer than a walk across the floor. */
const AUTOMATION_TIMEOUT = 90_000;

/** Owns requests until the selected scene tab answers, disconnects, or times out. */
export function createAutomation(clients: Map<string, Client>, sendTo: SendTo) {
  /** Automation commands relayed to an office tab (POST /api/automation), each waiting on that tab's answer. */
  const automationWaits = new Map<string, { client: string; done: (answer: AutomationAnswer) => void }>();
  /**
   * POST /api/automation {"cmd": "goTo", "args": ["desk-3"]}: runs a `window.office` command in the
   * office tab opened last (not a phone) and answers with what it resolved to. For a command line,
   * so it takes no Origin but the office's own, and JSON only, which a web page elsewhere can't send
   * without a preflight the office never answers.
   */
  const automationRequest = async (req: http.IncomingMessage, res: http.ServerResponse, own: boolean) => {
    if (req.method !== 'POST') return send(res, 405, { error: 'POST a JSON command' }, { allow: 'POST' });
    if (req.headers.origin && !own) return send(res, 403, { error: 'Forbidden' });
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'Send JSON (content-type: application/json)' });
    let body: { cmd?: unknown; args?: unknown; timeout?: unknown } | null;
    try {
      body = JSON.parse(await readBody(req, 64 * 1024));
    } catch {
      body = null;
    }
    const cmd = body && typeof body === 'object' ? str(body.cmd, 32) : '';
    if (!body || !cmd) return send(res, 400, { error: 'Send JSON: {"cmd": "goTo", "args": ["desk-3"]}' });
    const args = Array.isArray(body.args) ? body.args : body.args === undefined ? [] : [body.args];
    const timeout = Math.min(Math.max(num(body.timeout) || AUTOMATION_TIMEOUT, 1000), 5 * 60_000);
    let tab: Client | undefined;
    for (const c of clients.values()) if (!c.device && !c.dashboard && c.ws.readyState === WebSocket.OPEN) tab = c;
    if (!tab) return send(res, 409, { ok: false, error: 'No office tab is open: open the office in a browser first' });
    const id = randomBytes(6).toString('hex');
    const answer = await new Promise<AutomationAnswer>((resolve) => {
      const timer = setTimeout(() => {
        automationWaits.delete(id);
        resolve({ ok: false, error: `The office tab didn't answer within ${Math.round(timeout / 1000)}s`, timedOut: true });
      }, timeout);
      automationWaits.set(id, {
        client: tab.id,
        done: (a) => {
          clearTimeout(timer);
          automationWaits.delete(id);
          resolve(a);
        },
      });
      sendTo(tab, { t: 'automation.run', id, cmd, args });
    });
    const { timedOut, ...out } = answer;
    return send(res, answer.ok ? 200 : timedOut ? 504 : 422, out);
  };

  return {
    request: automationRequest,
    answer(c: Client, msg: Extract<ClientMsg, { t: 'automation.result' }>) {
      const wait = automationWaits.get(str(msg.id, 16));
      if (!wait || wait.client !== c.id) return;
      wait.done(msg.ok === true ? { ok: true, value: msg.value } : { ok: false, error: str(msg.error, 2000) || 'The command failed' });
    },
    disconnect(id: string) {
      for (const wait of automationWaits.values()) if (wait.client === id) wait.done({ ok: false, error: 'The office tab closed before it answered' });
    },
  };
}

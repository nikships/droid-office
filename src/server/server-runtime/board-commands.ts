import type { ClientMsg } from '../../shared/protocol.js';
import { GH_COMMENT_MAX, GH_LABEL_MAX } from '../../shared/protocol.js';
import { forgeWords } from '../../shared/floors.js';
import type { Floor } from '../floor.js';
import type { Client, SendTo, ToastLevel } from './client.js';
import { num, str } from './validation.js';

type BoardCommand = Extract<ClientMsg, { t: `gh.${string}` | `pipelines.${string}` }>;

interface BoardCommandsContext {
  floorOf(c: Client): Floor | undefined;
  sendTo: SendTo;
  toastFloor(floor: Floor | undefined, text: string, level?: ToastLevel): void;
}

/** Forge board and pipeline commands, preserving their asynchronous reply/toast ordering. */
export function createBoardCommands({ floorOf, sendTo, toastFloor }: BoardCommandsContext) {
  return (c: Client, msg: BoardCommand, here: () => Floor | undefined) => {
    const who = c.peer.name;
    switch (msg.t) {
      case 'gh.refresh':
        void floorOf(c)?.board.refresh();
        break;
      case 'gh.merge': {
        const floor = here();
        const n = num(msg.number);
        const method = (['squash', 'merge', 'rebase'] as const).find((m) => m === msg.method);
        if (!floor || !Number.isSafeInteger(n) || n <= 0 || !method) break;
        void floor.board.merge(n, method, msg.deleteBranch === true, msg.auto === true).then((error) => {
          sendTo(c, { t: 'gh.merged', number: n, error });
          if (error) return;
          const w = forgeWords(floor.board.forge);
          toastFloor(floor, msg.auto ? `${who} set ${w.pr} ${w.ref(n)} to merge once its checks pass` : `🎉 ${who} merged ${w.pr} ${w.ref(n)}`);
          // An auto-merge rings once the host gets round to it and the boards see it merged.
          if (!msg.auto) floor.merged(n, who);
        });
        break;
      }
      case 'gh.comment': {
        const floor = here();
        const n = num(msg.number);
        const kind = msg.kind === 'pull' ? 'pull' : 'issue';
        if (!floor || !Number.isSafeInteger(n) || n <= 0) break;
        const body = typeof msg.body === 'string' ? msg.body : '';
        // Refused rather than cut short: a comment that silently lost its end would read as finished.
        const invalid = !body.trim() ? 'The comment is empty' : body.length > GH_COMMENT_MAX ? `${forgeWords(floor.board.forge).site} takes comments of up to ${GH_COMMENT_MAX} characters` : '';
        if (invalid) {
          sendTo(c, { t: 'gh.commented', kind, number: n, error: invalid });
          break;
        }
        void floor.board.comment(kind, n, body).then((r) => {
          sendTo(c, { t: 'gh.commented', kind, number: n, ...r });
          const w = forgeWords(floor.board.forge);
          if (r.comment) toastFloor(floor, `💬 ${who} commented on ${kind === 'pull' ? `${w.pr} ${w.ref(n)}` : `issue #${n}`}`);
        });
        break;
      }
      case 'gh.close': {
        const floor = here();
        const n = num(msg.number);
        const kind = msg.kind === 'issue' || msg.kind === 'pull' ? msg.kind : undefined;
        if (!floor || !Number.isSafeInteger(n) || n <= 0 || !kind) break;
        const reason = msg.reason === 'not planned' ? 'not planned' : 'completed';
        void floor.board.close(kind, n, { comment: str(msg.comment, 20000).trim() || undefined, reason, deleteBranch: msg.deleteBranch === true }).then((error) => {
          sendTo(c, { t: 'gh.closed', kind, number: n, error });
          if (error) return;
          const w = forgeWords(floor.board.forge);
          if (kind === 'pull') return toastFloor(floor, `${who} closed ${w.pr} ${w.ref(n)} without merging`);
          toastFloor(floor, `${who} closed issue #${n}${reason === 'not planned' ? ' as not planned' : ''}`);
        });
        break;
      }
      case 'gh.labels': {
        const floor = here();
        const n = num(msg.number);
        const kind = msg.kind === 'issue' || msg.kind === 'pull' ? msg.kind : undefined;
        if (!floor || !Number.isSafeInteger(n) || n <= 0 || !kind) break;
        const names = (v: unknown) => [...new Set((Array.isArray(v) ? v : []).map((l) => str(l, GH_LABEL_MAX + 1)).filter((l) => l && l.length <= GH_LABEL_MAX))].slice(0, 100);
        const add = names(msg.add);
        const remove = names(msg.remove).filter((l) => !add.includes(l));
        if (!add.length && !remove.length) {
          sendTo(c, { t: 'gh.labeled', kind, number: n, error: 'No labels to change' });
          break;
        }
        void floor.board.setLabels(kind, n, add, remove).then((r) => {
          sendTo(c, { t: 'gh.labeled', kind, number: n, ...r });
          const w = forgeWords(floor.board.forge);
          if (r.labels) toastFloor(floor, `${who} labeled ${kind === 'pull' ? `${w.pr} ${w.ref(n)}` : `issue #${n}`}: ${[...add.map((l) => `+${l}`), ...remove.map((l) => `−${l}`)].join(' ')}`);
        });
        break;
      }
      case 'pipelines.refresh':
        void here()?.pipelines.refresh();
        break;
      case 'pipelines.detail': {
        const floor = here();
        const id = num(msg.id);
        if (!floor || !Number.isSafeInteger(id) || id <= 0) break;
        void floor.pipelines.detail(id).then(
          (detail) => sendTo(c, { t: 'pipelines.detail', id, detail }),
          (err: Error) => sendTo(c, { t: 'pipelines.detail', id, error: err.message }),
        );
        break;
      }
      case 'pipelines.rerun':
      case 'pipelines.cancel': {
        const floor = here();
        const id = num(msg.id);
        if (!floor || !Number.isSafeInteger(id) || id <= 0) break;
        const run = floor.pipelines.state.runs.find((r) => r.id === id);
        const action = msg.t === 'pipelines.rerun' ? 'rerun' : 'cancel';
        const failed = msg.t === 'pipelines.rerun' && 'failed' in msg && msg.failed === true;
        void (action === 'rerun' ? floor.pipelines.rerun(id, failed) : floor.pipelines.cancel(id)).then((error) => {
          sendTo(c, { t: 'pipelines.done', action, id, error });
          if (error || !run) return;
          const what = `${run.workflow} #${run.number}`;
          toastFloor(floor, action === 'cancel' ? `⏹️ ${who} cancelled ${what} on ${run.branch}` : `🔁 ${who} re-ran ${failed ? `the failed jobs of ${what}` : what} on ${run.branch}`);
        });
        break;
      }
      case 'pipelines.run': {
        const floor = here();
        if (!floor) break;
        const workflow = str(msg.workflow, 200);
        const ref = str(msg.ref, 255);
        const inputs: Record<string, string> = {};
        if (msg.inputs && typeof msg.inputs === 'object' && !Array.isArray(msg.inputs)) {
          for (const [k, v] of Object.entries(msg.inputs).slice(0, 50)) if (typeof v === 'string' && /^[\w.-]{1,100}$/.test(k)) inputs[k] = v.slice(0, 2000);
        }
        void floor.pipelines.run(workflow, ref, inputs).then((error) => {
          sendTo(c, { t: 'pipelines.done', action: 'run', error });
          if (error) return;
          const name = floor.pipelines.state.workflows.find((w) => w.id === workflow)?.name ?? workflow;
          toastFloor(floor, `🚀 ${who} started ${name} on ${ref.trim() || floor.pipelines.state.defaultBranch}`);
        });
        break;
      }
    }
  };
}

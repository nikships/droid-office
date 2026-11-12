import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { CLEAR_DROID_QUEUE, DELETE_DROID_QUEUE_ITEM, DROID_QUEUE_DOWN, DROID_QUEUE_UP, REVIEW_DROID_QUEUE, readDroidPending, readDroidQueue } from '../src/shared/droid-queue.js';
import { BLOCKING_TOOL_MS, clearDroidPendingAll, detectBlockingTool, driveDroidQueueItem, resolveWorkerQueue, type ActiveToolCall, type SentPendingMessage } from '../src/server/worker-queue.js';
import { HOOK_VERSION, WorkerManager } from '../src/server/workers.js';
import { Team } from '../src/server/team.js';
import { RemoteWorkers } from '../src/server/remote-workers.js';
import { RemoteOffice, type RemoteFloor } from '../src/server/remote-office.js';
import { createOfficeMcp, OFFICE_MCP_PATH, OFFICE_MCP_WORKER_HEADER, type OfficeMcpFloor } from '../src/server/office-mcp/index.js';
import { WhiteboardStore } from '../src/server/whiteboard.js';
import type { OwnerOffice } from '../src/server/office-mcp/owner.js';
import { SUBAGENT_DEFAULTS } from '../src/shared/protocol.js';

function droidBoxRows(above: string[], busy = true): string[] {
  return [
    '  ● Executing command...',
    ...above,
    busy ? '  ⠋ Working… (Press ESC to stop · Enter to steer · Ctrl+Enter to queue)' : '  Ready',
    '╭──────────────────────────────────────────────╮',
    '│ >                                            │',
    '╰──────────────────────────────────────────────╯',
  ];
}

test('readDroidPending parses Steering and Queued groups, review mode, overflow counts, and anti-spoofing', () => {
  const rows = droidBoxRows([
    '   Steering messages:',
    '   Stop editing config.ts…',
    '   +1 more steering item',
    '   Queued messages:',
    '   Run the full test suite after this turn (2 more lines)',
    '   +2 more queued items',
    '   Ctrl+R to modify queue · Ctrl+G to pull top · Ctrl+X to clear queue',
  ]);

  const snap = readDroidPending(rows);
  assert.ok(snap);
  assert.equal(snap.reviewActive, false);
  assert.equal(snap.moreSteering, 1);
  assert.equal(snap.moreQueued, 2);
  assert.deepEqual(snap.items, [
    { group: 'steering', text: 'Stop editing config.ts', cut: true, more: 0 },
    { group: 'queued', text: 'Run the full test suite after this turn', cut: false, more: 2 },
  ]);

  // Existing readDroidQueue ignores "+N more queued items" overflow rows while returning queued rows.
  assert.deepEqual(readDroidQueue(rows), [{ text: 'Run the full test suite after this turn', cut: false, more: 2 }]);

  const reviewRows = droidBoxRows(['   Queued messages:', '   Check coverage', '   ↑↓ scroll · Enter send now · Ctrl+D delete · Esc/Ctrl+R exit']);
  const reviewSnap = readDroidPending(reviewRows);
  assert.ok(reviewSnap);
  assert.equal(reviewSnap.reviewActive, true);
  assert.deepEqual(reviewSnap.items, [{ group: 'queued', text: 'Check coverage', cut: false, more: 0 }]);

  // Real Droid HintSegments renders three spaces ("   ") rather than " · " between segments.
  const realReviewRows = droidBoxRows(['   Queued messages:', '   Check coverage', '   ↑↓ scroll   Enter send now   Ctrl+D delete   Esc/Ctrl+R exit']);
  const realReviewSnap = readDroidPending(realReviewRows);
  assert.ok(realReviewSnap);
  assert.equal(realReviewSnap.reviewActive, true);
  assert.deepEqual(realReviewSnap.items, [{ group: 'queued', text: 'Check coverage', cut: false, more: 0 }]);
  assert.deepEqual(readDroidQueue(realReviewRows), [{ text: 'Check coverage', cut: false, more: 0 }]);

  // Narrow terminal widths wrap hint footers across two rows without turning the upper hint row into a queued item.
  const wrappedReviewRows = droidBoxRows(['   Queued messages:', '   Narrow item', '   ↑↓ scroll   Enter send now   Ctrl+D delete', '   Esc/Ctrl+R exit']);
  const wrappedSnap = readDroidPending(wrappedReviewRows);
  assert.ok(wrappedSnap);
  assert.equal(wrappedSnap.reviewActive, true);
  assert.deepEqual(wrappedSnap.items, [{ group: 'queued', text: 'Narrow item', cut: false, more: 0 }]);
  assert.deepEqual(readDroidQueue(wrappedReviewRows), [{ text: 'Narrow item', cut: false, more: 0 }]);

  // A busy screen with a queue heading but a torn/unrecognized footer returns undefined rather than falsely claiming an empty queue.
  const tornBusyRows = droidBoxRows(['   Queued messages:', '   Still waiting in Droid']);
  assert.equal(readDroidPending(tornBusyRows), undefined);
  assert.equal(readDroidQueue(tornBusyRows), undefined);

  // Quoted labels without a busy turn spinner are ignored.
  const idleQuoted = droidBoxRows(['   Queued messages:', '   Quoted in assistant prose', '   Ctrl+R to modify queue · Ctrl+G to pull top · Ctrl+X to clear queue'], false);
  assert.deepEqual(readDroidPending(idleQuoted), { items: [], moreSteering: 0, moreQueued: 0, reviewActive: false });
  assert.equal(readDroidPending(['plain shell output']), undefined);
});

test('resolveWorkerQueue merges hook outbox, enriched Droid TUI items, and in-flight pastes', () => {
  const sent: SentPendingMessage[] = [{ id: 1, text: 'Run the full test suite after this turn\nand check lint\nand check types', group: 'queued', at: 1_000 }];
  const rows = droidBoxRows([
    '   Steering messages:',
    '   Typed directly in TUI…',
    '   Queued messages:',
    '   Run the full test suite after this turn (2 more lines)',
    '   Ctrl+R to modify queue · Ctrl+G to pull top · Ctrl+X to clear queue',
  ]);
  const state = resolveWorkerQueue({
    outbox: ['First hook notice'],
    sent,
    inFlight: [{ text: 'Still pasting queued prompt', queued: true }],
    rows,
    now: 2_000,
  });

  assert.equal(state.count, 4);
  assert.deepEqual(
    state.items.map((i) => ({ index: i.index, source: i.source, delivery: i.delivery, preview: i.preview, text: i.text })),
    [
      { index: 1, source: 'outbox', delivery: 'next_step', preview: false, text: 'First hook notice' },
      { index: 2, source: 'droid', delivery: 'steering', preview: true, text: 'Typed directly in TUI' },
      {
        index: 3,
        source: 'droid',
        delivery: 'after_turn',
        preview: false,
        text: 'Run the full test suite after this turn\nand check lint\nand check types',
      },
      { index: 4, source: 'droid', delivery: 'after_turn', preview: false, text: 'Still pasting queued prompt' },
    ],
  );
});

test('driveDroidQueueItem and clearDroidPendingAll send review/promote/delete/clear keys without Esc', async () => {
  const written: string[] = [];
  let reviewOpen = false;
  const io = {
    write: (data: string) => {
      written.push(data);
      if (data === REVIEW_DROID_QUEUE) reviewOpen = !reviewOpen;
      if (data === '\r') reviewOpen = false;
    },
    rows: () =>
      droidBoxRows([
        '   Steering messages:',
        '   Already steering',
        '   Queued messages:',
        '   Queued second',
        reviewOpen ? '   ↑↓ scroll   Enter send now   Ctrl+D delete   Esc/Ctrl+R exit' : '   Ctrl+R to modify queue   Ctrl+G to pull top   Ctrl+X to clear queue',
      ]),
  };

  const okPromote = await driveDroidQueueItem(io, 1, 2, 'promote', { group: 'queued', text: 'Queued second' });
  assert.equal(okPromote, true);
  assert.deepEqual(written, [REVIEW_DROID_QUEUE, DROID_QUEUE_DOWN, '\r']);
  assert.equal(written.includes('\x1b'), false, 'never sends bare Escape');

  written.length = 0;
  const okDelete = await driveDroidQueueItem(io, 1, 2, 'delete', { group: 'queued', text: 'Queued second' });
  assert.equal(okDelete, true);
  assert.deepEqual(written, [REVIEW_DROID_QUEUE, DROID_QUEUE_DOWN, DELETE_DROID_QUEUE_ITEM, REVIEW_DROID_QUEUE]);
  assert.equal(written.includes('\x1b'), false, 'closes review mode with Ctrl+R rather than Escape');

  // When "+1 more steering item" expands inside Ctrl+R review mode, target matching navigates to the shifted index (2 instead of 1).
  written.length = 0;
  reviewOpen = false;
  const overflowIo = {
    write: (data: string) => {
      written.push(data);
      if (data === REVIEW_DROID_QUEUE) reviewOpen = !reviewOpen;
      if (data === '\r') reviewOpen = false;
    },
    rows: () =>
      reviewOpen
        ? droidBoxRows(['   Steering messages:', '   First steer', '   Hidden second steer', '   Queued messages:', '   Target queued item', '   ↑↓ scroll   Enter send now   Ctrl+D delete   Esc/Ctrl+R exit'])
        : droidBoxRows(['   Steering messages:', '   First steer', '   +1 more steering item', '   Queued messages:', '   Target queued item', '   Ctrl+R to modify queue   Ctrl+G to pull top   Ctrl+X to clear queue']),
  };
  assert.equal(await driveDroidQueueItem(overflowIo, 1, 2, 'promote', { group: 'queued', text: 'Target queued item' }), true);
  assert.deepEqual(written, [REVIEW_DROID_QUEUE, DROID_QUEUE_DOWN, DROID_QUEUE_DOWN, '\r']);

  // If review mode was already open beforehand, rewinds selection to index 0 before stepping down.
  written.length = 0;
  reviewOpen = true;
  assert.equal(await driveDroidQueueItem(io, 1, 2, 'promote', { group: 'queued', text: 'Queued second' }), true);
  assert.deepEqual(written, [DROID_QUEUE_UP, DROID_QUEUE_DOWN, '\r']);

  // If Enter fails to close review mode (e.g. daemon update_queue rejected), closes review mode with Ctrl+R and returns false.
  const failedEnterWritten: string[] = [];
  let stuckReview = false;
  const okFailedEnter = await driveDroidQueueItem(
    {
      write: (d) => {
        failedEnterWritten.push(d);
        if (d === REVIEW_DROID_QUEUE) stuckReview = !stuckReview;
      },
      rows: () => droidBoxRows(['   Queued messages:', '   Queued only', stuckReview ? '   ↑↓ scroll   Enter send now   Ctrl+D delete   Esc/Ctrl+R exit' : '   Ctrl+R to modify queue   Ctrl+G to pull top   Ctrl+X to clear queue']),
    },
    0,
    1,
    'promote',
    { group: 'queued', text: 'Queued only' },
  );
  assert.equal(okFailedEnter, false);
  assert.equal(stuckReview, false, 'leaves review mode closed on failure');
  assert.deepEqual(failedEnterWritten, [REVIEW_DROID_QUEUE, '\r', REVIEW_DROID_QUEUE]);

  // If Ctrl+R review mode never opens (e.g. queue drained or another program is up), fail closed without sending Enter or Ctrl+D.
  const stuckWritten: string[] = [];
  const okStuck = await driveDroidQueueItem({ write: (d) => stuckWritten.push(d), rows: () => ['plain shell output'] }, 1, 2, 'delete');
  assert.equal(okStuck, false);
  assert.deepEqual(stuckWritten, [REVIEW_DROID_QUEUE]);

  written.length = 0;
  reviewOpen = true;
  const cleared = await clearDroidPendingAll(io);
  assert.equal(cleared, true);
  assert.deepEqual(written, [REVIEW_DROID_QUEUE, '\x15', CLEAR_DROID_QUEUE]);
});

test('detectBlockingTool flags watch commands immediately and long-running tools after BLOCKING_TOOL_MS', () => {
  const watchMap = new Map<string, ActiveToolCall>([['s1', { tool: 'Execute', input: { command: 'gh run watch 12345 --exit-status' }, startedAt: 1_000 }]]);
  const watchHit = detectBlockingTool('working', watchMap, 1_200);
  assert.deepEqual(watchHit, {
    tool: 'Execute',
    command: 'gh run watch 12345 --exit-status',
    runningForMs: 200,
    reason: 'watch_command',
  });
  assert.equal(detectBlockingTool('needs_input', watchMap, 50_000), undefined);
  assert.equal(detectBlockingTool('done', watchMap, 50_000), undefined);

  const fastMap = new Map<string, ActiveToolCall>([['s1', { tool: 'Execute', input: { command: 'npm test' }, startedAt: 1_000 }]]);
  assert.equal(detectBlockingTool('working', fastMap, 1_000 + BLOCKING_TOOL_MS - 1), undefined);
  assert.deepEqual(detectBlockingTool('working', fastMap, 1_000 + BLOCKING_TOOL_MS + 500), {
    tool: 'Execute',
    command: 'npm test',
    runningForMs: BLOCKING_TOOL_MS + 500,
    reason: 'long_running',
  });

  // Non-shell tools do not misreport arbitrary `command` properties as shell commands.
  const nonShellMap = new Map<string, ActiveToolCall>([['s1', { tool: 'Read', input: { command: 'gh run watch 1' }, startedAt: 1_000 }]]);
  assert.equal(detectBlockingTool('working', nonShellMap, 1_200), undefined);
  assert.deepEqual(detectBlockingTool('working', nonShellMap, 1_000 + BLOCKING_TOOL_MS + 100), {
    tool: 'Read',
    runningForMs: BLOCKING_TOOL_MS + 100,
    reason: 'long_running',
  });
});

async function createQueueMcpRig(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'office-mcp-queue-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const fakeAgent = path.join(dir, 'fake-droid.cjs');
  writeFileSync(
    fakeAgent,
    `#!/usr/bin/env node
      process.stdout.write('Thinking... Press ESC to stop\\r\\n╭──────────╮\\r\\n│ >        │\\r\\n╰──────────╯\\r\\n');
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        if (chunk === '\\x1b') {
          process.stdout.write('\\r\\nOperation cancelled\\r\\n╭──────────╮\\r\\n│ >        │\\r\\n╰──────────╯\\r\\n');
        }
      });
      process.stdin.resume();
      setInterval(() => {}, 1000);
    `,
  );
  chmodSync(fakeAgent, 0o755);

  let hookUrl = 'http://127.0.0.1:0';
  const wm = new WorkerManager(
    dir,
    path.join(dir, '.droid-office'),
    fakeAgent,
    [],
    { url: hookUrl, token: '' },
    {
      update: () => {},
      remove: () => {},
      data: () => {},
      screen: () => {},
      toast: () => {},
    },
  );
  await wm.start();
  t.after(() => wm.shutdown(false));

  const remoteStore = new RemoteWorkers(dir, () => {});
  const remote = new RemoteOffice(remoteStore, () => [floorObj]);
  t.after(() => remote.stop());
  const botCreated = remote.add('GrokLead');
  const botWorker = botCreated.worker;

  wm.buildingIdentity = (id: string) => (id === botWorker.id ? botWorker : undefined);
  wm.buildingAgent = (id: string) => id === botWorker.id;

  const team = new Team(
    {
      list: () => wm.list(),
      get: (id) => wm.get(id) ?? (id === botWorker.id ? botWorker : undefined),
      buildingAgent: (id) => id === botWorker.id,
      deskOccupied: (id) => wm.deskOccupied(id),
      officeDefault: undefined,
      hire: (deskId, by, prompt, worktree, c, lead, from, branch) => wm.spawn(deskId, by, prompt, worktree, 'agent', c.model, c.effort, [], lead, undefined, from, branch),
      prompt: (id, text, queue) => (queue === undefined ? wm.tell(id, text) : wm.prompt(id, text, [], queue)),
      urgentPrompt: (id, text) => wm.urgentPrompt(id, text),
      notice: (id, text) => wm.notice(id, text),
      queueState: (id, now) => wm.queueState(id, now),
      blockingTool: (id, now) => wm.blockingTool(id, now),
      resume: (id, text) => wm.resume(id, text),
      kill: (id) => wm.kill(id),
      dismiss: (id, prune, keep) => wm.dismissTeam(id, prune, keep),
      tail: (id, lines) => wm.tail(id, lines),
      setTask: (id, task) => wm.setTask(id, task),
    },
    {
      dataDir: path.join(dir, '.droid-office'),
      dir,
      git: false,
      settings: () => ({ ...SUBAGENT_DEFAULTS, worktree: false }),
      toast: () => {},
    },
  );
  t.after(() => team.stop());

  const floorObj: OfficeMcpFloor & RemoteFloor = {
    id: 'f-main',
    name: 'main-repo',
    def: { name: 'main-repo' },
    dir,
    workers: wm,
    team,
    visits: { handle: () => ({ status: 400, body: { error: 'off' } }), cannotVisit: () => 'off' },
    whiteboard: new WhiteboardStore(path.join(dir, '.droid-office', 'wb'), () => {}),
  };

  const promptCalls: { msg: Record<string, unknown>; notes: string[] }[] = [];
  const owner: OwnerOffice = {
    floors: () => [{ id: 'f-main', name: 'main-repo', workers: wm.list() }],
    mission: () => [{ worker: botWorker, team: [] }],
    tail: (id, lines) => wm.tail(id, lines),
    workerMeta: (id) => {
      const q = wm.queueState(id);
      const b = wm.blockingTool(id);
      return q?.count || b ? { ...(q?.count ? { queuedMessages: q } : {}), ...(b ? { blockingTool: b } : {}) } : undefined;
    },
    act: async (_by, msg) => {
      const notes: string[] = [];
      promptCalls.push({ msg, notes });
      if (msg.t === 'worker.prompt') {
        const wid = String(msg.workerId);
        const text = String(msg.prompt);
        if (msg.urgent === true) {
          const res = await wm.urgentPrompt(wid, text);
          if (res.interrupted) notes.push(`Interrupted ${wm.get(wid)?.name}'s running turn and delivered the urgent prompt`);
          return { ...(res.error ? { error: res.error } : {}), workerId: wid, notes };
        }
        const blocking = msg.queue !== true ? wm.blockingTool(wid) : undefined;
        const err = wm.prompt(wid, text, [], msg.queue === true);
        if (!err && blocking) notes.push(`${wm.get(wid)?.name} is inside a blocking command (${blocking.tool}: \`${blocking.command}\`)`);
        return { ...(err ? { error: err } : {}), workerId: wid, notes };
      }
      return { notes };
    },
  };

  const mcp = createOfficeMcp({
    settings: () => ({ ...SUBAGENT_DEFAULTS, worktree: false }),
    floor: (workerId) => (wm.get(workerId) ? floorObj : undefined),
    remote,
    owner,
    remoteTransport: { hostname: () => 'mac.tail.ts.net', owner: () => 'nik@example.com' },
    answers: { answer: async () => undefined },
  });

  const localMcp = createOfficeMcp({
    settings: () => ({ ...SUBAGENT_DEFAULTS, worktree: false }),
    floor: (workerId) => (wm.get(workerId) ? floorObj : undefined),
    remote,
    answers: { answer: async () => undefined },
  });

  const httpServer = createServer((req, res) => {
    if (req.headers['x-local-mcp'] === '1') {
      void localMcp.handle(req, res);
      return;
    }
    req.headers.host = 'mac.tail.ts.net';
    req.headers['tailscale-user-login'] = 'nik@example.com';
    void mcp.handle(req, res);
  });
  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  t.after(() => httpServer.close());
  const port = (httpServer.address() as AddressInfo).port;
  hookUrl = `http://127.0.0.1:${port}`;

  const botClient = new Client({ name: 'bot-test', version: '1.0.0' });
  t.after(() => botClient.close());
  await botClient.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${OFFICE_MCP_PATH}`), {
      requestInit: { headers: { Authorization: `Bearer ${botCreated.token}` } },
    }),
  );

  const connectLocal = async (workerId: string, hookToken: string) => {
    const c = new Client({ name: 'floor-lead', version: '1.0.0' });
    t.after(() => c.close());
    await c.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${OFFICE_MCP_PATH}`), {
        requestInit: {
          headers: {
            'x-local-mcp': '1',
            Authorization: `Bearer ${hookToken}`,
            [OFFICE_MCP_WORKER_HEADER]: workerId,
          },
        },
      }),
    );
    return c;
  };

  const hook = (workerId: string, token: string, event: string, extra: Record<string, unknown> = {}) => wm.hookReply(workerId, token, event, { hook_event_name: event, session_id: `sess-${workerId}`, ...extra }, HOOK_VERSION);

  const tokenOf = (workerId: string): string => {
    const map = (wm as unknown as { workers: Map<string, { hookToken: string }> }).workers;
    return map.get(workerId)?.hookToken ?? '';
  };

  return { wm, team, botWorker, botClient, connectLocal, hook, tokenOf, promptCalls };
}

test('MCP end-to-end: default steer vs queue: true, worker_queue list/clear/promote, blocking hints, and urgent interrupt', async (t) => {
  const rig = await createQueueMcpRig(t);

  // Hire a subagent under GrokLead and a standalone worker on the floor.
  const hired = await rig.botClient.callTool({
    name: 'team_hire',
    arguments: { floor: 'f-main', title: 'Watch CI', brief: 'Monitor CI and ship', worktree: false },
  });
  assert.equal(hired.isError, undefined);
  const subId = (hired.structuredContent!.worker as { id: string }).id;
  const subToken = rig.tokenOf(subId);

  const standalone = rig.wm.spawn('desk-5', 'Owner', 'Standalone task', false, 'agent');
  assert.equal(typeof standalone, 'object');
  if (typeof standalone === 'string') throw new Error(standalone);
  const soloToken = rig.tokenOf(standalone.id);

  // Start both sessions and put them into working state; put subagent inside `gh run watch`.
  rig.hook(subId, subToken, 'SessionStart');
  rig.hook(subId, subToken, 'UserPromptSubmit', { prompt: 'Monitor CI' });
  rig.hook(subId, subToken, 'PreToolUse', { tool_name: 'Execute', tool_input: { command: 'gh run watch 98765' } });

  rig.hook(standalone.id, soloToken, 'SessionStart');
  rig.hook(standalone.id, soloToken, 'UserPromptSubmit', { prompt: 'Standalone task' });

  // 1. Default team_message (`queue` omitted -> false) steers at next_step (hook outbox) and warns about `gh run watch`!
  const steered = await rig.botClient.callTool({
    name: 'team_message',
    arguments: { worker: subId, text: 'Stop watching old run; check commit abc123.' },
  });
  assert.equal(steered.isError, undefined);
  assert.equal(steered.structuredContent?.delivery, 'next_step');
  assert.equal((steered.structuredContent?.blockingTool as { reason: string })?.reason, 'watch_command');
  assert.match((steered.content[0] as { text: string }).text, /Warning: .*gh run watch 98765/);

  // 2. Explicit `queue: true` queues behind the turn (`queued_turn`).
  const afterTurn = await rig.botClient.callTool({
    name: 'team_message',
    arguments: { worker: subId, text: 'After this turn, update CHANGELOG.md.', queue: true },
  });
  assert.equal(afterTurn.isError, undefined);
  assert.equal(afterTurn.structuredContent?.delivery, 'queued_turn');

  // Combining `queue: true` and `urgent: true` is rejected on both team_message and office_worker_prompt.
  const badComboTeam = await rig.botClient.callTool({
    name: 'team_message',
    arguments: { worker: subId, text: 'Conflict', queue: true, urgent: true },
  });
  assert.equal(badComboTeam.isError, true);

  const badComboOwner = await rig.botClient.callTool({
    name: 'office_worker_prompt',
    arguments: { workerId: standalone.id, prompt: 'Conflict', queue: true, urgent: true },
  });
  assert.equal(badComboOwner.isError, true);

  // 3. `team_status` and `office_roster` both expose `queuedMessages` and `blockingTool`!
  const status = await rig.botClient.callTool({ name: 'team_status', arguments: { verbose: false } });
  assert.equal(status.isError, undefined);
  const statusWorkers = status.structuredContent?.workers as Array<{ id: string; queuedMessages?: { count: number }; blockingTool?: { command: string } }>;
  assert.equal(statusWorkers[0].id, subId);
  assert.equal(statusWorkers[0].queuedMessages?.count, 2);
  assert.equal(statusWorkers[0].blockingTool?.command, 'gh run watch 98765');
  assert.match((status.content[0] as { text: string }).text, /Blocking: Execute: `gh run watch 98765`/);
  assert.match((status.content[0] as { text: string }).text, /Queued \(2\)/);

  const rosterRes = await rig.botClient.callTool({ name: 'office_roster', arguments: {} });
  assert.equal(rosterRes.isError, undefined);
  assert.match((rosterRes.content[0] as { text: string }).text, /Blocking command: Execute: `gh run watch 98765`/);
  assert.match((rosterRes.content[0] as { text: string }).text, /Queued \(2\)/);

  // 4. `worker_queue` list shows both pending items (#1 next_step outbox, #2 after_turn queued) + blockingTool.
  const listed = await rig.botClient.callTool({
    name: 'worker_queue',
    arguments: { worker: subId, action: 'list' },
  });
  assert.equal(listed.isError, undefined);
  assert.equal(listed.structuredContent?.count, 2);
  const items = listed.structuredContent?.items as Array<{ index: number; delivery: string; source: string; text: string }>;
  assert.equal(items[0].delivery, 'next_step');
  assert.equal(items[1].delivery, 'after_turn');
  assert.match(items[1].text, /update CHANGELOG\.md/);

  // 5. `worker_queue` clear with `index: 1` removes just #1, leaving #2 intact!
  const clearedOne = await rig.botClient.callTool({
    name: 'worker_queue',
    arguments: { worker: subId, action: 'clear', index: 1 },
  });
  assert.equal(clearedOne.isError, undefined);
  assert.equal((clearedOne.structuredContent!.remaining as { count: number }).count, 1);

  // Wait for the 120ms paste timer on #2 to settle into sentQueue, then promote #1 with `urgent: true` to break out of `gh run watch`!
  await new Promise((r) => setTimeout(r, 150));
  const promotedUrgent = await rig.botClient.callTool({
    name: 'worker_queue',
    arguments: { worker: subId, action: 'promote', urgent: true },
  });
  assert.equal(promotedUrgent.isError, undefined, (promotedUrgent.content[0] as { text: string })?.text);
  assert.equal(promotedUrgent.structuredContent?.delivery, 'interrupted');
  assert.equal((promotedUrgent.structuredContent!.remaining as { count: number }).count, 0);
  assert.match((promotedUrgent.content[0] as { text: string }).text, /Interrupted/);

  // 6. Building agent can ALSO manage a standalone floor worker's queue via `office_worker_prompt` + `worker_queue`,
  //    while a floor lead can manage only its own subagents!
  await rig.botClient.callTool({
    name: 'office_worker_prompt',
    arguments: { workerId: standalone.id, prompt: 'Queued on standalone worker', queue: true },
  });
  const soloQueue = await rig.botClient.callTool({
    name: 'worker_queue',
    arguments: { worker: standalone.name, action: 'list' },
  });
  assert.equal(soloQueue.isError, undefined);
  assert.equal(soloQueue.structuredContent?.count, 1);

  const soloCleared = await rig.botClient.callTool({
    name: 'worker_queue',
    arguments: { worker: standalone.id, action: 'clear' },
  });
  assert.equal(soloCleared.isError, undefined);
  assert.equal((soloCleared.structuredContent!.remaining as { count: number }).count, 0);

  // Urgent `office_worker_prompt` interrupts a blocking command on the standalone worker too.
  rig.hook(standalone.id, soloToken, 'PreToolUse', { tool_name: 'Execute', tool_input: { command: 'sleep 60' } });
  const soloUrgent = await rig.botClient.callTool({
    name: 'office_worker_prompt',
    arguments: { workerId: standalone.id, prompt: 'Abort sleep and run fast check', urgent: true },
  });
  assert.equal(soloUrgent.isError, undefined);
  assert.match((soloUrgent.content[0] as { text: string }).text, /Interrupted/);

  // Floor lead access control: floor lead can manage its own subagent's queue, never a standalone peer's.
  const floorLead = rig.wm.spawn('desk-6', 'Owner', 'Floor lead', false, 'agent');
  assert.equal(typeof floorLead, 'object');
  if (typeof floorLead === 'string') throw new Error(floorLead);
  const leadToken = rig.tokenOf(floorLead.id);
  rig.hook(floorLead.id, leadToken, 'SessionStart');
  const floorLeadSub = rig.wm.spawn('desk-7', floorLead.name, 'Child task', false, 'agent', undefined, undefined, [], floorLead.id);
  assert.equal(typeof floorLeadSub, 'object');
  if (typeof floorLeadSub === 'string') throw new Error(floorLeadSub);

  const localClient = await rig.connectLocal(floorLead.id, leadToken);
  const ownSubQueue = await localClient.callTool({ name: 'worker_queue', arguments: { worker: floorLeadSub.id } });
  assert.equal(ownSubQueue.isError, undefined);

  const peerRefused = await localClient.callTool({ name: 'worker_queue', arguments: { worker: standalone.id } });
  assert.equal(peerRefused.isError, true);
  assert.match((peerRefused.content[0] as { text: string }).text, /isn't one of your subagents/);
});

test('MCP worker_queue promote: real 3-space review footer, failed promote keeps seen item visible with stillPending, and drained turn reports already_delivered', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'office-mcp-promote-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const stateFile = path.join(dir, 'tui-mode.txt');
  writeFileSync(stateFile, 'normal');

  // Simulates Droid 1.9.0's real 3-space HintSegments queue and review footers over a real PTY.
  const fakeDroid = path.join(dir, 'fake-droid-tui.cjs');
  writeFileSync(
    fakeDroid,
    `#!/usr/bin/env node
      const fs = require('node:fs');
      const stateFile = ${JSON.stringify(stateFile)};
      let steering = [];
      let queued = [];
      let review = false;
      let buf = '';
      let started = false;

      function render() {
        const mode = fs.readFileSync(stateFile, 'utf8').trim();
        if (mode === 'dialog') {
          process.stdout.write('\\x1b[2J\\x1b[H╭──────────────────────────╮\\r\\n│ DROID STATUS             │\\r\\n╰──────────────────────────╯\\r\\n');
          return;
        }
        const lines = ['\\x1b[2J\\x1b[H  ● Running command...'];
        if (steering.length) {
          lines.push('   Steering messages:');
          for (const s of steering) lines.push('   ' + s);
        }
        if (queued.length) {
          lines.push('   Queued messages:');
          for (const q of queued) lines.push('   ' + q);
        }
        if (steering.length || queued.length) {
          lines.push(
            review
              ? '   ↑↓ scroll   Enter send now   Ctrl+D delete   Esc/Ctrl+R exit'
              : '   Ctrl+R to modify queue   Ctrl+G to pull top   Ctrl+X to clear queue'
          );
        }
        if (mode === 'idle') {
          lines.push('  Ready');
        } else {
          lines.push(' ⠋ Executing...  (Press ESC to stop)');
        }
        lines.push('╭──────────────────────────────────────────────────────────────────────╮');
        lines.push(
          mode === 'idle'
            ? '│ >                                                                    │'
            : '│ > Enter to steer · Ctrl+Enter to queue                               │',
        );
        lines.push('╰──────────────────────────────────────────────────────────────────────╯');
        lines.push('[⏱ 12s, context: 2%] ? for help');
        process.stdout.write(lines.join('\\r\\n') + '\\r\\n');
      }

      render();
      let draft = '';
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        buf += chunk;
        while (buf.length) {
          const pStart = buf.indexOf('\\x1b[200~');
          if (pStart === 0) {
            const pEnd = buf.indexOf('\\x1b[201~');
            if (pEnd < 0) return;
            draft = buf.slice(6, pEnd);
            buf = buf.slice(pEnd + 6);
            continue;
          }
          const mode = fs.readFileSync(stateFile, 'utf8').trim();
          if (buf.startsWith('\\x1b[13;5u')) {
            buf = buf.slice(7);
            if (draft) {
              const lines = draft.split('\\n').filter((l) => l.trim());
              const preview = lines[0].length > 48 ? lines[0].slice(0, 48).trimEnd() + '…' : lines[0];
              const more = Math.max(0, draft.split('\\n').length - 1);
              queued.push(more > 0 ? preview + ' (' + more + ' more lines)' : preview);
              draft = '';
              render();
            }
            continue;
          }
          if (buf.startsWith('\\x1b[B') || buf.startsWith('\\x1b[A')) {
            buf = buf.slice(3);
            continue;
          }
          const ch = buf[0];
          buf = buf.slice(1);
          if (ch === '\\x15') {
            draft = '';
            continue;
          }
          if (ch === '\\x18') {
            steering = [];
            queued = [];
            review = false;
            render();
            continue;
          }
          if (ch === '\\x12') {
            if (mode === 'drain_on_review') {
              queued = [];
              fs.writeFileSync(stateFile, 'idle');
              render();
              continue;
            }
            if (mode === 'block_review') continue;
            if (queued.length || steering.length) {
              review = !review;
              render();
            }
            continue;
          }
          if (ch === '\\r') {
            if (review && queued.length) {
              steering.push(queued.shift());
              review = false;
              render();
            } else if (draft) {
              if (!started) {
                started = true;
              } else {
                const lines = draft.split('\\n').filter((l) => l.trim());
                const preview = lines[0].length > 48 ? lines[0].slice(0, 48).trimEnd() + '…' : lines[0];
                steering.push(preview);
              }
              draft = '';
              render();
            }
          }
        }
      });
      process.stdin.resume();
      setInterval(() => {}, 1000);
    `,
  );
  chmodSync(fakeDroid, 0o755);

  const wm = new WorkerManager(dir, path.join(dir, '.droid-office'), fakeDroid, [], { url: 'http://127.0.0.1:0', token: '' }, { update: () => {}, remove: () => {}, data: () => {}, screen: () => {}, toast: () => {} });
  await wm.start();
  t.after(() => wm.shutdown(false));

  const remoteStore = new RemoteWorkers(dir, () => {});
  let floorObj!: OfficeMcpFloor & RemoteFloor;
  const remote = new RemoteOffice(remoteStore, () => [floorObj]);
  t.after(() => remote.stop());
  const botCreated = remote.add('GrokLead');
  const botWorker = botCreated.worker;
  wm.buildingIdentity = (id: string) => (id === botWorker.id ? botWorker : undefined);
  wm.buildingAgent = (id: string) => id === botWorker.id;

  const team = new Team(
    {
      list: () => wm.list(),
      get: (id) => wm.get(id) ?? (id === botWorker.id ? botWorker : undefined),
      buildingAgent: (id) => id === botWorker.id,
      deskOccupied: (id) => wm.deskOccupied(id),
      officeDefault: undefined,
      hire: (deskId, by, prompt, worktree, c, lead, from, branch) => wm.spawn(deskId, by, prompt, worktree, 'agent', c.model, c.effort, [], lead, undefined, from, branch),
      prompt: (id, text, queue) => (queue === undefined ? wm.tell(id, text) : wm.prompt(id, text, [], queue)),
      urgentPrompt: (id, text) => wm.urgentPrompt(id, text),
      notice: (id, text) => wm.notice(id, text),
      queueState: (id, now) => wm.queueState(id, now),
      blockingTool: (id, now) => wm.blockingTool(id, now),
      resume: (id, text) => wm.resume(id, text),
      kill: (id) => wm.kill(id),
      dismiss: (id, prune, keep) => wm.dismissTeam(id, prune, keep),
      tail: (id, lines) => wm.tail(id, lines),
      setTask: (id, task) => wm.setTask(id, task),
    },
    { dataDir: path.join(dir, '.droid-office'), dir, git: false, settings: () => ({ ...SUBAGENT_DEFAULTS, worktree: false }), toast: () => {} },
  );
  t.after(() => team.stop());

  floorObj = {
    id: 'f-main',
    name: 'main-repo',
    def: { name: 'main-repo' },
    dir,
    workers: wm,
    team,
    visits: { handle: () => ({ status: 400, body: { error: 'off' } }), cannotVisit: () => 'off' },
    whiteboard: new WhiteboardStore(path.join(dir, '.droid-office', 'wb'), () => {}),
  };

  const owner: OwnerOffice = {
    floors: () => [{ id: 'f-main', name: 'main-repo', workers: wm.list() }],
    mission: () => [{ worker: botWorker, team: [] }],
    tail: (id, lines) => wm.tail(id, lines),
    act: async () => ({ notes: [] }),
  };

  const mcp = createOfficeMcp({
    settings: () => ({ ...SUBAGENT_DEFAULTS, worktree: false }),
    floor: (workerId) => (wm.get(workerId) ? floorObj : undefined),
    remote,
    owner,
    remoteTransport: { hostname: () => 'mac.tail.ts.net', owner: () => 'nik@example.com' },
    answers: { answer: async () => undefined },
  });

  const httpServer = createServer((req, res) => {
    req.headers.host = 'mac.tail.ts.net';
    req.headers['tailscale-user-login'] = 'nik@example.com';
    void mcp.handle(req, res);
  });
  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  t.after(() => httpServer.close());
  const port = (httpServer.address() as AddressInfo).port;

  const botClient = new Client({ name: 'bot-promote-test', version: '1.0.0' });
  t.after(() => botClient.close());
  await botClient.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${OFFICE_MCP_PATH}`), {
      requestInit: { headers: { Authorization: `Bearer ${botCreated.token}` } },
    }),
  );

  const hired = await botClient.callTool({
    name: 'team_hire',
    arguments: { floor: 'f-main', title: 'Promote Test', brief: 'Run task', worktree: false },
  });
  const subId = (hired.structuredContent!.worker as { id: string }).id;
  const subToken = (wm as unknown as { workers: Map<string, { hookToken: string }> }).workers.get(subId)!.hookToken;
  wm.hookReply(subId, subToken, 'SessionStart', { hook_event_name: 'SessionStart', session_id: 's1' }, HOOK_VERSION);
  wm.hookReply(subId, subToken, 'UserPromptSubmit', { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'Run task' }, HOOK_VERSION);

  // Wait for initial launch prompt paste + 120ms Enter timer to complete.
  await new Promise((r) => setTimeout(r, 220));

  // 1. Queue a message via Ctrl+Enter (`queue: true`) and wait for it to render on the fake Droid TUI.
  await botClient.callTool({
    name: 'team_message',
    arguments: { worker: subId, text: 'Switch to PR 1 first', queue: true },
  });
  await new Promise((r) => setTimeout(r, 220));

  const listBefore = await botClient.callTool({ name: 'worker_queue', arguments: { worker: subId, action: 'list' } });
  assert.equal(listBefore.structuredContent?.count, 1);
  assert.equal((listBefore.structuredContent!.items as Array<{ delivery: string }>)[0].delivery, 'after_turn');

  // Promote via real 3-space review mode (`↑↓ scroll   Enter send now   Ctrl+D delete   Esc/Ctrl+R exit`).
  const promoted = await botClient.callTool({ name: 'worker_queue', arguments: { worker: subId, action: 'promote' } });
  assert.equal(promoted.isError, undefined, (promoted.content[0] as { text: string })?.text);
  assert.equal(promoted.structuredContent?.delivery, 'steering');
  assert.equal(promoted.structuredContent?.stillPending, false);
  const remAfterPromote = promoted.structuredContent?.remaining as { count: number; items: Array<{ delivery: string }> };
  assert.equal(remAfterPromote.count, 1);
  assert.equal(remAfterPromote.items[0].delivery, 'steering');

  // 2. Queue a second message, mark it seen via `list`, block Ctrl+R, and verify failed promote keeps it visible AND reports stillPending: true.
  writeFileSync(stateFile, 'block_review');
  await botClient.callTool({
    name: 'team_message',
    arguments: { worker: subId, text: 'Keep me visible on failed promote', queue: true },
  });
  await new Promise((r) => setTimeout(r, 220));

  const seenList = await botClient.callTool({ name: 'worker_queue', arguments: { worker: subId, action: 'list' } });
  assert.equal(seenList.structuredContent?.count, 2);

  const failedPromote = await botClient.callTool({ name: 'worker_queue', arguments: { worker: subId, action: 'promote' } });
  assert.equal(failedPromote.isError, true);
  assert.equal(failedPromote.structuredContent?.code, 'queue_error');
  assert.equal(failedPromote.structuredContent?.stillPending, true);
  assert.match((failedPromote.content[0] as { text: string }).text, /Message is still pending in queue \(#2 \[after turn\]; 2 pending\)/);

  const listAfterFail = await botClient.callTool({ name: 'worker_queue', arguments: { worker: subId, action: 'list' } });
  assert.equal(listAfterFail.structuredContent?.count, 2);
  assert.ok((listAfterFail.structuredContent!.items as Array<{ text: string }>).some((it) => it.text.includes('Keep me visible on failed promote')));

  // 3. When the worker's turn drains the queued message right as promote runs, report delivery: 'already_delivered' and stillPending: false.
  writeFileSync(stateFile, 'normal');
  await botClient.callTool({ name: 'worker_queue', arguments: { worker: subId, action: 'clear' } });
  // Reset fake TUI to clean busy state and queue one fresh message.
  wm.hookReply(subId, subToken, 'UserPromptSubmit', { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'Next turn' }, HOOK_VERSION);
  await botClient.callTool({
    name: 'team_message',
    arguments: { worker: subId, text: 'Delivered right as turn ended', queue: true },
  });
  await new Promise((r) => setTimeout(r, 220));
  writeFileSync(stateFile, 'drain_on_review');

  const drainedPromote = await botClient.callTool({ name: 'worker_queue', arguments: { worker: subId, action: 'promote' } });
  assert.equal(drainedPromote.isError, undefined, (drainedPromote.content[0] as { text: string })?.text);
  assert.equal(drainedPromote.structuredContent?.delivery, 'already_delivered');
  assert.equal(drainedPromote.structuredContent?.stillPending, false);
  assert.match((drainedPromote.content[0] as { text: string }).text, /already been delivered/);
});

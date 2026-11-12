import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { CLEAR_DROID_QUEUE, DELETE_DROID_QUEUE_ITEM, DROID_QUEUE_DOWN, REVIEW_DROID_QUEUE, readDroidPending, readDroidQueue } from '../src/shared/droid-queue.js';
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
        reviewOpen ? '   ↑↓ scroll · Enter send now · Ctrl+D delete · Esc/Ctrl+R exit' : '   Ctrl+R to modify queue · Ctrl+G to pull top · Ctrl+X to clear queue',
      ]),
  };

  const okPromote = await driveDroidQueueItem(io, 1, 2, 'promote');
  assert.equal(okPromote, true);
  assert.deepEqual(written, [REVIEW_DROID_QUEUE, DROID_QUEUE_DOWN, '\r']);
  assert.equal(written.includes('\x1b'), false, 'never sends bare Escape');

  written.length = 0;
  const okDelete = await driveDroidQueueItem(io, 1, 2, 'delete');
  assert.equal(okDelete, true);
  assert.deepEqual(written, [REVIEW_DROID_QUEUE, DROID_QUEUE_DOWN, DELETE_DROID_QUEUE_ITEM, REVIEW_DROID_QUEUE]);
  assert.equal(written.includes('\x1b'), false, 'closes review mode with Ctrl+R rather than Escape');

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

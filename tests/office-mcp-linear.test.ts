import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Answers } from '../src/server/answers.js';
import { FloorLinear, LinearOffice, type RawIssue } from '../src/server/linear.js';
import { createOfficeMcp, OFFICE_MCP_PATH, OFFICE_MCP_WORKER_HEADER, type OfficeMcpFloor } from '../src/server/office-mcp/index.js';
import { signed } from '../src/server/office-mcp/linear.js';
import { SUBAGENT_DEFAULTS, type WorkerInfo } from '../src/shared/protocol.js';

const TEST_KEY = `lin_api_${'unitTestOnly'.repeat(3)}`;
// Trimmed real Foundry responses captured 2026-11-12; names, email and IDs replaced.
const me = { viewer: { id: 'viewer', name: 'Owner', email: 'owner@example.com' }, organization: { name: 'Foundry', urlKey: 'foundry-nik' } };
const team = { id: 'team', key: 'DOFF', name: 'droid-office' };
const workflow = [
  { id: 'backlog', name: 'Backlog', type: 'backlog', color: '#bec2c8', position: 0 },
  { id: 'todo', name: 'Todo', type: 'unstarted', color: '#e2e2e2', position: 1 },
  { id: 'progress', name: 'In Progress', type: 'started', color: '#f2c94c', position: 2 },
  { id: 'review', name: 'In Review', type: 'started', color: '#0f783c', position: 1002 },
];
const project = { id: 'project', name: 'Droid Office', state: 'backlog' };
const capturedIssue = {
  id: '2642e227-528a-4e6d-b2fd-5f31a6da7497',
  identifier: 'DOFF-900',
  title: 'Capture fixture (delete me)',
  url: 'https://linear.app/foundry-nik/issue/DOFF-900/capture-fixture-delete-me',
  priority: 3,
  priorityLabel: 'Medium',
  estimate: null,
  sortOrder: -806909,
  createdAt: '2026-11-12T00:19:28.336Z',
  updatedAt: '2026-11-12T00:19:28.336Z',
  state: workflow[0],
  assignee: null,
  labels: { nodes: [] },
  project: null,
  description: 'Fixture for unit tests.',
  branchName: 'capture-fixture-delete-me-doff-900',
  creator: { name: 'Owner' },
  team,
  parent: null,
  children: { nodes: [] },
  attachments: { nodes: [] },
  comments: { nodes: [] },
};

function stub() {
  const calls: { query: string; variables: Record<string, any> }[] = [];
  let next: Response | undefined;
  const fetchImpl: typeof fetch = async (_url, init) => {
    assert.equal(new Headers(init?.headers).get('authorization'), TEST_KEY);
    const { query, variables = {} } = JSON.parse(String(init?.body));
    calls.push({ query, variables });
    if (next) {
      const response = next;
      next = undefined;
      return response;
    }
    let data: unknown;
    if (query.startsWith('query Me')) data = me;
    else if (query.startsWith('query Teams')) data = { teams: { nodes: [{ ...team, defaultIssueState: { type: 'backlog' } }] }, projects: { nodes: [{ ...project, teams: { nodes: [{ id: team.id }] } }] } };
    else if (query.startsWith('query Team('))
      data = {
        team: {
          ...team,
          states: { nodes: workflow },
          labels: { nodes: [{ id: 'docs', name: 'Docs', color: '#F97316' }] },
          members: { nodes: [{ ...me.viewer, displayName: 'owner', active: true }] },
          projects: { nodes: [project] },
          activeCycle: null,
        },
        issueLabels: { nodes: [{ id: 'bug', name: 'Bug', color: '#EB5757' }] },
      };
    else if (query.startsWith('query Issues')) data = { issues: { nodes: [capturedIssue], pageInfo: { hasNextPage: false, endCursor: capturedIssue.id } } };
    else if (query.startsWith('query Issue(')) data = { issue: capturedIssue };
    else if (query.startsWith('mutation Update')) data = { issueUpdate: { success: true, issue: capturedIssue } };
    else if (query.startsWith('mutation Create')) data = { issueCreate: { success: true, issue: capturedIssue } };
    else if (query.startsWith('mutation Comment')) data = { commentCreate: { success: true, comment: { id: 'comment', url: `${capturedIssue.url}#comment` } } };
    else if (query.startsWith('mutation Attach')) data = { attachmentLinkURL: { success: true } };
    else if (query.includes('issueAddLabel')) data = { issueAddLabel: { success: true } };
    else if (query.includes('issueRemoveLabel')) data = { issueRemoveLabel: { success: true } };
    else throw new Error(`Unexpected query ${query}`);
    return Response.json({ data });
  };
  return {
    fetchImpl,
    calls,
    fail: (response: Response) => {
      next = response;
    },
  };
}

async function rig(
  t: TestContext,
  fetchImpl: typeof fetch = async () => {
    throw new Error('Unexpected Linear fetch');
  },
) {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-mcp-linear-'));
  const worker: WorkerInfo = { id: 'widget', name: 'Widget', kind: 'agent', deskId: 'desk-1', color: '#888888', status: 'idle', acked: true, createdBy: 'test', createdAt: 1, cols: 100, rows: 30, open: false };
  const floor: OfficeMcpFloor = {
    id: 'floor',
    name: 'droid-office',
    dir,
    workers: { list: () => [worker], get: (id) => (id === worker.id ? worker : undefined), authenticate: (id, token) => (id === worker.id && token === 'floor-token' ? worker : undefined) },
    team: { cannotHire: () => 'Hiring disabled', hasNews: () => false } as OfficeMcpFloor['team'],
    visits: { cannotVisit: () => 'Visits disabled' } as OfficeMcpFloor['visits'],
    whiteboard: {} as OfficeMcpFloor['whiteboard'],
  };
  const linear = new LinearOffice(dir, fetchImpl);
  const office = createOfficeMcp({
    answers: new Answers(),
    settings: () => ({ ...SUBAGENT_DEFAULTS }),
    floor: (id) => (id === worker.id ? floor : undefined),
    linear,
    orchestrator: { cwd: dir, authenticate: (id, token) => (id === 'orchestrator' && token === 'building-token' ? { ...worker, id, name: 'Orchestrator', deskId: '' } : undefined) },
  });
  const http = createServer((req, res) => void office.handle(req, res));
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const url = new URL(OFFICE_MCP_PATH, `http://127.0.0.1:${(http.address() as AddressInfo).port}`);
  const clients: Client[] = [];
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close()));
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  async function connect(building = false) {
    const client = new Client({ name: 'linear-tests', version: '1.0.0' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { [OFFICE_MCP_WORKER_HEADER]: building ? 'orchestrator' : worker.id, Authorization: `Bearer ${building ? 'building-token' : 'floor-token'}` } } }));
    return client;
  }
  return { dir, linear, floor, worker, connect };
}

async function connected(t: TestContext) {
  const api = stub();
  const r = await rig(t, api.fetchImpl);
  assert.equal(await r.linear.connect(TEST_KEY, 'Owner'), undefined);
  const floorLinear = new FloorLinear(r.dir, r.linear, undefined, { state() {}, board() {}, toast() {}, workers: () => [r.worker], hire: async () => ({ error: 'Not used' }), pullName: (n) => `PR #${n}` }, ['droid-office']);
  r.floor.linear = floorLinear;
  const client = await r.connect();
  return { ...r, api, floorLinear, client };
}

test('disconnected Linear tools are hidden and guessed direct calls return a permission error', async (t) => {
  const r = await rig(t);
  const client = await r.connect();
  assert.deepEqual(
    (await client.listTools()).tools.filter((tool) => tool.name.startsWith('linear_')),
    [],
  );
  const reply = await client.callTool({ name: 'linear_graphql', arguments: { query: '{ viewer { id } }' } });
  assert.equal(reply.isError, true);
  assert.equal(reply.structuredContent?.code, 'permission_denied');
  assert.match(JSON.stringify(reply.content), /Linear is not connected.*Settings/);
});

test('Linear comments trim trailing whitespace and sign the worker rather than impersonating the account', () => {
  assert.equal(signed('Delivered.\n  ', { name: 'Widget' }), 'Delivered.\n\n— Widget, a Droid Office worker');
  assert.equal(signed('  Preserve leading spaces', { name: 'Pixel' }), '  Preserve leading spaces\n\n— Pixel, a Droid Office worker');
});

test('all eight Linear tools appear while connected, building agents cannot start, and disconnect hides/refuses calls', async (t) => {
  const r = await connected(t);
  const names = (await r.client.listTools()).tools.filter((tool) => tool.name.startsWith('linear_')).map((tool) => tool.name);
  assert.deepEqual(names.sort(), ['linear_comment', 'linear_create_issue', 'linear_graphql', 'linear_issue', 'linear_issues', 'linear_start', 'linear_update_issue', 'linear_workspace']);
  const building = await r.connect(true);
  assert.ok(!(await building.listTools()).tools.some((tool) => tool.name === 'linear_start'));
  const refused = await building.callTool({ name: 'linear_start', arguments: { issue: 'DOFF-900' } });
  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent?.code, 'permission_denied');
  const started = await r.client.callTool({ name: 'linear_start', arguments: { issue: 'doff-900' } });
  assert.notEqual(started.isError, true);
  assert.equal(r.floorLinear.linkOf(r.worker.id)?.identifier, 'DOFF-900');
  const own = await r.client.callTool({ name: 'linear_issue', arguments: {} });
  assert.notEqual(own.isError, true);
  assert.ok(own.structuredContent);
  assert.equal((own.structuredContent.issue as RawIssue).identifier, 'DOFF-900');
  r.linear.disconnect();
  assert.ok(!(await r.client.listTools()).tools.some((tool) => tool.name.startsWith('linear_')));
  assert.equal((await r.client.callTool({ name: 'linear_issue', arguments: { issue: 'DOFF-900' } })).structuredContent?.code, 'permission_denied');
});

test('linear_update_issue resolves names into state, labels, priority, assignee, project and parent IDs', async (t) => {
  const r = await connected(t);
  const updated = await r.client.callTool({
    name: 'linear_update_issue',
    arguments: {
      issue: 'DOFF-900',
      state: 'in review',
      labels: ['bug', 'DOCS'],
      priority: 'high',
      assignee: 'owner@example.com',
      project: 'droid office',
      parent: 'DOFF-1',
      title: 'New title',
      description: 'Details',
      estimate: 3,
      dueDate: '2026-12-01',
    },
  });
  assert.notEqual(updated.isError, true);
  assert.deepEqual(r.api.calls.find((call) => call.query.startsWith('mutation Update'))?.variables, {
    id: capturedIssue.id,
    input: { title: 'New title', description: 'Details', stateId: 'review', priority: 2, assigneeId: 'viewer', labelIds: ['bug', 'docs'], projectId: 'project', parentId: capturedIssue.id, estimate: 3, dueDate: '2026-12-01' },
  });
  for (const who of ['me', 'self', 'owner', 'Owner', 'own']) {
    const reply = await r.client.callTool({ name: 'linear_update_issue', arguments: { issue: 'DOFF-900', assignee: who } });
    assert.notEqual(reply.isError, true);
    assert.equal(r.api.calls.filter((c) => c.query.startsWith('mutation Update')).at(-1)?.variables.input.assigneeId, 'viewer');
  }
  await r.client.callTool({ name: 'linear_update_issue', arguments: { issue: 'DOFF-900', assignee: 'none', labels: [], project: 'none', parent: 'none', dueDate: 'none', estimate: null } });
  assert.deepEqual(r.api.calls.filter((c) => c.query.startsWith('mutation Update')).at(-1)?.variables.input, { assigneeId: null, labelIds: [], projectId: null, parentId: null, estimate: null, dueDate: null });
});

test('linear_update_issue adds/removes labels and attaches a link without replacing unspecified fields', async (t) => {
  const r = await connected(t);
  const reply = await r.client.callTool({ name: 'linear_update_issue', arguments: { issue: 'DOFF-900', addLabels: ['Bug'], removeLabels: ['Docs'], link: { url: 'https://github.com/example/repo/pull/1', title: 'PR' } } });
  assert.notEqual(reply.isError, true);
  assert.deepEqual(
    r.api.calls.filter((c) => c.query.startsWith('mutation L')).map((c) => c.variables),
    [
      { id: capturedIssue.id, labelId: 'bug' },
      { id: capturedIssue.id, labelId: 'docs' },
    ],
  );
  assert.deepEqual(r.api.calls.find((c) => c.query.startsWith('mutation Attach'))?.variables, { issueId: capturedIssue.id, url: 'https://github.com/example/repo/pull/1', title: 'PR' });
  assert.equal(
    r.api.calls.some((c) => c.query.startsWith('mutation Update')),
    false,
  );
});

test('Linear tool errors name invalid fields and expose upstream not-found diagnostics', async (t) => {
  const r = await connected(t);
  for (const [fields, message] of [
    [{}, /not working on a Linear ticket/],
    [{ issue: 'invalid' }, /isn't a Linear issue/],
    [{ issue: 'DOFF-900', state: 'No such state' }, /has no state.*States:/],
    [{ issue: 'DOFF-900', labels: ['No such label'] }, /has no label.*Labels:/],
    [{ issue: 'DOFF-900', assignee: 'Nobody matches' }, /No.*members match/],
    [{ issue: 'DOFF-900', priority: 'critical' }, /priority is 0 none/],
    [{ issue: 'DOFF-900', project: 'unknown' }, /has no project/],
    [{ issue: 'DOFF-900', parent: 'invalid' }, /isn't a Linear issue/],
    [{ issue: 'DOFF-900', dueDate: 'tomorrow' }, /YYYY-MM-DD/],
  ] as const) {
    const reply = await r.client.callTool({ name: 'linear_update_issue', arguments: fields });
    assert.equal(reply.isError, true);
    assert.match(JSON.stringify(reply.content), message);
  }
  r.api.fail(Response.json({ errors: [{ message: 'Entity not found: Issue', extensions: { code: 'INPUT_ERROR', userPresentableMessage: 'Could not find referenced Issue.' } }], data: null }, { status: 400 }));
  const missing = await r.client.callTool({ name: 'linear_issue', arguments: { issue: 'DOFF-999' } });
  assert.equal(missing.structuredContent?.code, 'not_found');
  assert.match(JSON.stringify(missing.content), /no DOFF-999/);
});

test('linear_comment signs the actual posted body and defaults to the worker linked issue', async (t) => {
  const r = await connected(t);
  await r.floorLinear.take('DOFF-900', r.worker);
  const reply = await r.client.callTool({ name: 'linear_comment', arguments: { body: 'Delivered.\n  ' } });
  assert.notEqual(reply.isError, true);
  assert.deepEqual(r.api.calls.find((c) => c.query.startsWith('mutation Comment'))?.variables.input, { issueId: capturedIssue.id, body: 'Delivered.\n\n— Widget, a Droid Office worker' });
  assert.equal(reply.structuredContent?.issue, 'DOFF-900');
});

test('linear_graphql passes query and variables unchanged and maps upstream errors', async (t) => {
  const r = await connected(t);
  const query = 'query Me($include: Boolean!) { viewer { id name email } organization { name urlKey } }';
  const reply = await r.client.callTool({ name: 'linear_graphql', arguments: { query, variables: { include: true } } });
  assert.notEqual(reply.isError, true);
  assert.deepEqual(r.api.calls.at(-1), { query, variables: { include: true } });
  assert.deepEqual(reply.structuredContent?.data, me);
  r.api.fail(Response.json({ errors: [{ message: `Forbidden ${TEST_KEY}`, extensions: { code: 'FORBIDDEN' } }] }));
  const failure = await r.client.callTool({ name: 'linear_graphql', arguments: { query } });
  assert.equal(failure.structuredContent?.code, 'linear_error');
  assert.match(JSON.stringify(failure.content), /may not do that/);
  assert.ok(!JSON.stringify(failure).includes(TEST_KEY));
});

test('linear_issues builds team/state/assignee/project/label/search filters and supports issue lookup', async (t) => {
  const r = await connected(t);
  const reply = await r.client.callTool({ name: 'linear_issues', arguments: { query: 'fixture', state: 'todo', assignee: 'me', project: 'Office', label: 'Bug', priority: 'p1', limit: 10 } });
  assert.notEqual(reply.isError, true);
  const filter = r.api.calls.find((c) => c.query.startsWith('query Issues'))?.variables.filter;
  assert.deepEqual(filter.and, [
    { team: { id: { eq: 'team' } } },
    { state: { type: { eq: 'unstarted' } } },
    { assignee: { isMe: { eq: true } } },
    { project: { name: { containsIgnoreCase: 'Office' } } },
    { labels: { some: { name: { eqIgnoreCase: 'Bug' } } } },
    { priority: { eq: 1 } },
    { or: [{ title: { containsIgnoreCase: 'fixture' } }, { description: { containsIgnoreCase: 'fixture' } }] },
  ]);
  const lookup = await r.client.callTool({ name: 'linear_issues', arguments: { query: 'doff-900' } });
  assert.ok(lookup.structuredContent);
  assert.equal((lookup.structuredContent.issues as RawIssue[])[0].identifier, 'DOFF-900');
});

test('linear_create_issue defaults to the floor team, resolves fields, and optionally starts the ticket', async (t) => {
  const r = await connected(t);
  const reply = await r.client.callTool({ name: 'linear_create_issue', arguments: { title: 'Follow up', state: 'Todo', assignee: 'me', labels: ['Bug'], start: true } });
  assert.notEqual(reply.isError, true);
  assert.deepEqual(r.api.calls.find((c) => c.query.startsWith('mutation Create'))?.variables.input, { title: 'Follow up', teamId: 'team', stateId: 'todo', assigneeId: 'viewer', labelIds: ['bug'] });
  assert.equal(r.floorLinear.linkOf(r.worker.id)?.identifier, 'DOFF-900');
  const building = await r.connect(true);
  const unowned = await building.callTool({ name: 'linear_create_issue', arguments: { title: 'For someone', team: 'DOFF', start: true } });
  assert.notEqual(unowned.isError, true);
  assert.match(JSON.stringify(unowned.content), /Filed DOFF-900.*Not taken: only a worker at a floor desk/);
  assert.equal(unowned.structuredContent?.taken, false);
  const unknown = await r.client.callTool({ name: 'linear_create_issue', arguments: { title: 'No team', team: 'unknown' } });
  assert.equal(unknown.isError, true);
  assert.match(JSON.stringify(unknown.content), /no team unknown/);
});

test('linear_workspace returns the captured vocabulary and refreshes it on every read', async (t) => {
  const r = await connected(t);
  for (let i = 0; i < 2; i++) {
    const reply = await r.client.callTool({ name: 'linear_workspace', arguments: {} });
    assert.notEqual(reply.isError, true);
    assert.match(JSON.stringify(reply.content), /Foundry.*Owner.*owner@example.com/);
    assert.ok(reply.structuredContent);
    assert.equal((reply.structuredContent.team as { key: string }).key, 'DOFF');
  }
  assert.equal(r.api.calls.filter((c) => c.query.startsWith('query Team(')).length, 2);
});

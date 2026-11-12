import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { detailOf, ticketOf, FloorLinear, LinearApi, LinearError, LinearOffice, type FloorLinearEvents } from '../src/server/linear.js';
import type { GhPull, WorkerInfo } from '../src/shared/protocol.js';
import {
  AUTOPILOT_MAX,
  DEFAULT_AUTOPILOT,
  LINEAR_PICKUPS,
  LINEAR_STATE_TYPES,
  PRIORITY_NAMES,
  autopilotPicks,
  compareTickets,
  findState,
  guessTeam,
  linearColumns,
  linearIssueRef,
  linearKey,
  linearPriority,
  linearPromptVars,
  linearTaskLine,
  linearTaskOf,
  priorityOrder,
  stateForStage,
  type LinearState,
  type LinearTeamRef,
  type LinearTicket,
} from '../src/shared/linear.js';

const TEST_KEY = `lin_api_${'unitTestOnly'.repeat(3)}`;

// Trimmed from real Foundry GraphQL captures, 2026-11-12. IDs/names/email replaced;
// variants below change captured fields to exercise different states, never the envelope shape.
const meBody = { viewer: { id: 'viewer', name: 'Owner', email: 'owner@example.com' }, organization: { name: 'Foundry', urlKey: 'foundry-nik' } };
const teamRef = { id: 'team', key: 'DOFF', name: 'droid-office' };
const project = { id: 'project', name: 'Droid Office', state: 'backlog', teams: { nodes: [{ id: 'team' }] } };
const teamsBody = { teams: { nodes: [{ ...teamRef, defaultIssueState: { type: 'backlog' } }] }, projects: { nodes: [project] } };
const teamBody = {
  team: {
    ...teamRef,
    states: {
      nodes: [
        { id: 'done', name: 'Done', type: 'completed', color: '#5e6ad2', position: 3 },
        { id: 'review', name: 'In Review', type: 'started', color: '#0f783c', position: 1002 },
        { id: 'backlog', name: 'Backlog', type: 'backlog', color: '#bec2c8', position: 0 },
        { id: 'progress', name: 'In Progress', type: 'started', color: '#f2c94c', position: 2 },
        { id: 'todo', name: 'Todo', type: 'unstarted', color: '#e2e2e2', position: 1 },
      ],
    },
    labels: { nodes: [{ id: 'docs', name: 'Docs', color: '#F97316' }] },
    members: { nodes: [{ ...meBody.viewer, displayName: 'owner', active: true }] },
    projects: { nodes: [{ id: project.id, name: project.name, state: project.state }] },
    activeCycle: null,
  },
  issueLabels: { nodes: [{ id: 'bug', name: 'Bug', color: '#EB5757' }] },
};
type Issue = Parameters<typeof detailOf>[0];
const rawIssue: Issue = {
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
  state: { id: 'backlog', name: 'Backlog', type: 'backlog', color: '#bec2c8' },
  assignee: null,
  labels: { nodes: [] },
  project: null,
  description: 'Fixture for unit tests.',
  branchName: 'capture-fixture-delete-me-doff-900',
  creator: { name: 'Owner' },
  team: teamRef,
  parent: null,
  children: { nodes: [] },
  attachments: { nodes: [] },
  comments: { nodes: [] },
};
const authError = {
  errors: [{ message: 'Authentication required, not authenticated', extensions: { type: 'authentication error', code: 'AUTHENTICATION_ERROR', userPresentableMessage: 'You need to authenticate to access this operation.' } }],
};
const missingError = { errors: [{ message: 'Entity not found: Issue', extensions: { type: 'invalid input', code: 'INPUT_ERROR', userPresentableMessage: 'Could not find referenced Issue.' } }], data: null };
const complexityError = { errors: [{ message: 'Query too complex', extensions: { type: 'invalid input', code: 'INPUT_ERROR', userPresentableMessage: 'The query is too complex. Complexity: 13240. Maximum allowed complexity: 10000.' } }] };

function apiRig() {
  const calls: { query: string; variables: Record<string, any> }[] = [];
  const issues = new Map([[rawIssue.id, structuredClone(rawIssue)]]);
  let boardItems = [rawIssue.id];
  let failure: Response | undefined;
  let before: ((query: string) => Promise<void>) | undefined;
  const fetchImpl: typeof fetch = async (url, init) => {
    assert.equal(url, 'https://api.linear.app/graphql');
    assert.equal(new Headers(init?.headers).get('authorization'), TEST_KEY);
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    const { query, variables = {} } = JSON.parse(String(init?.body));
    calls.push({ query, variables });
    await before?.(query);
    if (failure) {
      const res = failure;
      failure = undefined;
      return res;
    }
    let data: unknown;
    if (query.startsWith('query Me')) data = meBody;
    else if (query.startsWith('query Teams')) data = teamsBody;
    else if (query.startsWith('query Team(')) data = teamBody;
    else if (query.startsWith('query Issues')) data = { issues: { nodes: boardItems.map((id) => issues.get(id)), pageInfo: { hasNextPage: false, endCursor: boardItems.at(-1) } } };
    else if (query.startsWith('query Issue(')) data = { issue: [...issues.values()].find((it) => it.id === variables.id || it.identifier === variables.id) ?? null };
    else if (query.startsWith('mutation Update')) {
      const found = issues.get(variables.id)!;
      const input = variables.input;
      if (input.stateId) found.state = teamBody.team.states.nodes.find((s) => s.id === input.stateId);
      if (input.assigneeId) found.assignee = { id: input.assigneeId, name: 'Owner' };
      if (input.title) found.title = input.title;
      data = { issueUpdate: { success: true, issue: found } };
    } else if (query.startsWith('mutation Create')) data = { issueCreate: { success: true, issue: rawIssue } };
    else if (query.startsWith('mutation Attach')) data = { attachmentLinkURL: { success: true } };
    else if (query.startsWith('mutation Comment')) data = { commentCreate: { success: true, comment: { id: 'comment', url: `${rawIssue.url}#comment` } } };
    else throw new Error(`Unexpected query ${query}`);
    return Response.json({ data });
  };
  return {
    fetchImpl,
    calls,
    issues,
    setBoard: (ids: string[]) => {
      boardItems = ids;
    },
    fail: (res: Response) => {
      failure = res;
    },
    before: (fn?: typeof before) => {
      before = fn;
    },
  };
}

async function connectedFloor(t: TestContext) {
  const dir = temporary(t);
  const api = apiRig();
  let changes = 0;
  const office = new LinearOffice(dir, api.fetchImpl, () => {
    changes++;
  });
  assert.equal(await office.connect(TEST_KEY, 'Owner'), undefined);
  const people: WorkerInfo[] = [];
  const hires: { prompt: string; identifier: string; model?: string }[] = [];
  const notices: string[] = [];
  const event = { ...events(), workers: () => people, toast: (text: string) => notices.push(text) };
  event.hire = async (prompt: string, identifier: string, model?: string) => {
    hires.push({ prompt, identifier, model });
    return { workerId: 'new-worker' };
  };
  const floor = new FloorLinear(dir, office, undefined, event, ['droid-office']);
  let pilotDone: Promise<void> = Promise.resolve();
  const pilot = floor.pilot.bind(floor);
  t.mock.method(floor, 'pilot', () => {
    pilotDone = pilot();
    return pilotDone;
  });
  return { dir, api, office, floor, people, event, hires, notices, changes: () => changes, pilotDone: () => pilotDone };
}

function person(id = 'widget'): WorkerInfo {
  return { id, name: id, kind: 'agent', deskId: 'desk-1', color: '#888888', status: 'idle', acked: true, createdBy: 'test', createdAt: 1, cols: 100, rows: 30, open: false };
}

function temporary(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-linear-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const noFetch: typeof fetch = async () => {
  throw new Error('Unexpected fetch');
};

function events(): FloorLinearEvents {
  return { state() {}, board() {}, toast() {}, hire: async () => ({ error: 'Not used' }), workers: () => [], pullName: (n) => `PR #${n}` };
}

function ticket(id: string, extra: Partial<LinearTicket> = {}): LinearTicket {
  return {
    id,
    identifier: `DOFF-${id}`,
    title: 'Task',
    url: `https://linear.app/example/issue/DOFF-${id}`,
    priority: 0,
    priorityLabel: 'No priority',
    state: { id: 'todo', name: 'Todo', type: 'unstarted', color: '#888888' },
    labels: [],
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    sortOrder: 0,
    ...extra,
  };
}

const states: LinearState[] = [
  { id: 'review', name: 'In Review', type: 'started', color: '#888888', position: 3 },
  { id: 'done', name: 'Done', type: 'completed', color: '#888888', position: 4 },
  { id: 'progress', name: 'In Progress', type: 'started', color: '#888888', position: 2 },
  { id: 'todo', name: 'Todo', type: 'unstarted', color: '#888888', position: 1 },
  { id: 'backlog', name: 'Backlog', type: 'backlog', color: '#888888', position: 0 },
  { id: 'cancel', name: 'Canceled', type: 'canceled', color: '#888888', position: 5 },
];

test('Linear references normalize identifiers, URLs and UUIDs while rejecting invalid inputs', () => {
  for (const input of ['doff-12', ' DOFF-12 ', 'https://linear.app/foundry-nik/issue/doff-12/title']) assert.equal(linearIssueRef(input), 'DOFF-12');
  assert.equal(linearIssueRef('AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE'), 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.equal(linearIssueRef('A_1-999999999'), 'A_1-999999999');
  for (const input of [undefined, null, 12, {}, '', 'DOFF-0', 'DOFF-01', 'DOFF-1000000000', 'TOOLONGTEAMX-1', '1A-1', 'DOFF-1 extra', 'x'.repeat(301)]) assert.equal(linearIssueRef(input), undefined);
});

test('Linear keys accept only supported prefixes and bounded alphanumeric tokens', () => {
  for (const kind of ['api', 'oauth']) {
    assert.equal(linearKey(` lin_${kind}_${'a'.repeat(20)} `), `lin_${kind}_${'a'.repeat(20)}`);
    assert.ok(linearKey(`lin_${kind}_${'Z1'.repeat(100)}`));
  }
  for (const input of [undefined, 12, '', 'lin_api_short', `lin_api_${'a'.repeat(201)}`, `lin_api_${'a'.repeat(20)}-`, `Bearer lin_api_${'a'.repeat(20)}`, `lin_other_${'a'.repeat(20)}`]) assert.equal(linearKey(input), undefined);
});

test('priorities parse every number, name and p alias and rank no priority last', () => {
  assert.deepEqual(PRIORITY_NAMES, ['No priority', 'Urgent', 'High', 'Medium', 'Low']);
  for (let i = 0; i <= 4; i++) {
    assert.equal(linearPriority(i), i);
    assert.equal(linearPriority(String(i)), i);
    assert.equal(linearPriority(` ${PRIORITY_NAMES[i].toUpperCase()} `), i);
    if (i) assert.equal(linearPriority(`p${i}`), i);
    assert.equal(priorityOrder(i), i || 5);
  }
  assert.equal(linearPriority('none'), 0);
  for (const value of [-1, 5, 1.5, NaN, Infinity, null, {}, '', 'p0', 'p5', '01', 'critical']) assert.equal(linearPriority(value), undefined);
  for (const value of [-1, 5, NaN]) assert.equal(priorityOrder(value), 5);
});

test('board columns hide canceled/duplicate, sort priority then manual order, and newest done first without mutation', () => {
  const items = [
    ticket('1'),
    ticket('2', { priority: 1, sortOrder: 2 }),
    ticket('3', { priority: 1, sortOrder: 1 }),
    ...(['triage', 'backlog', 'started', 'completed', 'completed', 'canceled', 'duplicate'] as const).map((type, i) =>
      ticket(String(i + 4), {
        state: { id: type, name: type, type, color: '#888888' },
        updatedAt: `2026-11-0${i + 1}T00:00:00Z`,
      }),
    ),
  ];
  const copy = structuredClone(items);
  const cols = linearColumns(items);
  assert.deepEqual(
    cols.map((c) => [c.name, c.items.map((i) => i.id)]),
    [
      ['Backlog', ['4', '5']],
      ['Todo', ['3', '2', '1']],
      ['In Progress', ['6']],
      ['Done', ['8', '7']],
    ],
  );
  assert.deepEqual(items, copy);
  assert.ok(compareTickets(items[1], items[0]) < 0);
  assert.deepEqual(
    linearColumns([]).map((c) => c.items),
    [[], [], [], []],
  );
});

test('workflow lookup prefers exact names then aliases and ordered types, with review fallback', () => {
  assert.equal(stateForStage(states, 'started')?.id, 'progress');
  assert.equal(stateForStage(states, 'review')?.id, 'review');
  assert.equal(stateForStage(states, 'completed')?.id, 'done');
  for (const name of ['started', 'progress', ' In Progress ']) assert.equal(findState(states, name)?.id, 'progress');
  for (const name of ['done', 'complete', 'closed', 'completed']) assert.equal(findState(states, name)?.id, 'done');
  for (const name of ['todo', 'to do', 'unstarted']) assert.equal(findState(states, name)?.id, 'todo');
  assert.equal(findState(states, 'in review')?.id, 'review');
  assert.equal(findState(states, 'cancelled')?.id, 'cancel');
  assert.equal(findState(states, 'backlog')?.id, 'backlog');
  for (const name of ['', 'unknown', 'duplicate', 'triage']) assert.equal(findState(states, name), undefined);
  assert.equal(
    stateForStage(
      states.filter((s) => s.id === 'review'),
      'started',
    )?.id,
    'review',
  );
  assert.equal(
    stateForStage(
      states.filter((s) => s.id !== 'review'),
      'review',
    ),
    undefined,
  );
  assert.equal(stateForStage([], 'completed'), undefined);
  assert.deepEqual(LINEAR_STATE_TYPES, ['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled', 'duplicate']);
  assert.deepEqual(LINEAR_PICKUPS, ['triage', 'backlog', 'unstarted']);
  assert.equal(AUTOPILOT_MAX, 8);
});

test('autopilot filters state, links, worker chips, assignments and creation cutoff before priority/age and room', () => {
  const since = Date.parse('2026-11-01T00:00:00Z');
  const pilot = { ...DEFAULT_AUTOPILOT, on: true, since };
  const items = [
    ticket('old', { createdAt: '2026-10-31T00:00:00Z', priority: 1 }),
    ticket('low', { priority: 4 }),
    ticket('urgent', { priority: 1 }),
    ticket('self', { assignee: 'Owner', priority: 2 }),
    ticket('other', { assignee: 'Someone else', priority: 1 }),
    ticket('linked', { priority: 1 }),
    ticket('worker', { worker: { id: 'w', name: 'Widget' }, priority: 1 }),
    ticket('done', { state: states[1] }),
    ticket('newer', { priority: 1, createdAt: '2026-11-02T00:00:00Z' }),
    ticket('invalid-date', { createdAt: 'invalid' }),
  ];
  const linked = new Set(['linked']);
  const copy = structuredClone(items);
  assert.deepEqual(
    autopilotPicks(items, pilot, linked, 3, 'Owner').map((t) => t.id),
    ['urgent', 'newer', 'self'],
  );
  assert.deepEqual(
    autopilotPicks(items, pilot, linked, 8).map((t) => t.id),
    ['urgent', 'newer', 'low'],
  );
  assert.equal(autopilotPicks(items, { ...pilot, existing: true }, linked, 1)[0].id, 'old');
  assert.deepEqual(autopilotPicks(items, { ...pilot, on: false }, linked, 3), []);
  assert.deepEqual(autopilotPicks(items, pilot, linked, 0), []);
  assert.deepEqual(autopilotPicks(items, pilot, linked, -1), []);
  assert.deepEqual(items, copy);
});

test('team guessing requires a matching normalized floor/repository name or key even for one team', () => {
  const team: LinearTeamRef = { id: 'a', key: 'DOFF', name: 'droid-office', projects: [] };
  const other: LinearTeamRef = { id: 'b', key: 'API', name: 'Service API', projects: [] };
  assert.equal(guessTeam([team], []), undefined);
  assert.equal(guessTeam([team], ['unrelated']), undefined);
  assert.equal(guessTeam([team], ['droid-office']), team);
  for (const name of ['Droid Office', 'DOFF', 'nikships/droid-office']) assert.equal(guessTeam([team, other], [undefined, name]), team);
  assert.equal(guessTeam([], ['DOFF']), undefined);
  assert.equal(guessTeam([team, other], ['unknown']), undefined);
  assert.equal(guessTeam([team, other], ['DOFF', 'API']), undefined);
});

test('task first lines round trip quotes and prompt variables retain text while filling optional defaults', () => {
  const task = { identifier: 'DOFF-12', title: 'Fix "quoted" title', url: 'https://linear.app/example/issue/DOFF-12' };
  assert.equal(linearTaskLine(task), 'Work on Linear issue DOFF-12: "Fix "quoted" title".');
  assert.deepEqual(linearTaskOf(linearTaskLine(task)), { identifier: task.identifier, title: task.title });
  assert.deepEqual(linearTaskOf('Work on Linear issue DOFF-12: “Title”. '), { identifier: 'DOFF-12', title: 'Title' });
  for (const line of ['', 'Work on GitHub issue #12: "Title".', 'Linear issue doff-12: "Title".', 'Linear issue DOFF-12: "".']) assert.equal(linearTaskOf(line), undefined);
  assert.deepEqual(linearPromptVars(task), { task: linearTaskLine(task), identifier: task.identifier, title: task.title, url: task.url, description: '(No description.)', branchHint: '', started: 'In Progress' });
  assert.equal(linearPromptVars({ ...task, description: '  Notes  ', branchName: 'doff-12-fix' }, 'Doing').branchHint, ' (Linear suggests `doff-12-fix`)');
  assert.equal(linearPromptVars({ ...task, description: '  Notes  ' }, 'Doing').description, 'Notes');
  assert.equal(linearPromptVars({ ...task, description: '  ' }, 'Doing').started, 'Doing');
});

test('Linear network failures, causes and timeouts redact the key in every diagnostic', async () => {
  for (const err of [new Error(`Could not connect ${TEST_KEY}`), Object.assign(new Error('socket'), { cause: { code: `ECONNRESET ${TEST_KEY}` } }), Object.assign(new Error('expired'), { name: 'TimeoutError' })]) {
    const api = new LinearApi(TEST_KEY, async () => {
      throw err;
    });
    await assert.rejects(api.me(), (error) => {
      assert.ok(error instanceof LinearError);
      assert.equal(error.status, 0);
      assert.match(error.message, /Couldn't reach Linear/);
      assert.ok(!String(error.stack).includes(TEST_KEY));
      if (err.name === 'TimeoutError') assert.match(error.message, /did not answer in time/);
      return true;
    });
  }
});

test('disconnected office validates keys without fetching and rejects team context with setup guidance', async (t) => {
  const office = new LinearOffice(temporary(t), noFetch);
  assert.equal(office.connection(), undefined);
  assert.equal(office.client(), undefined);
  assert.equal(office.viewerId, undefined);
  assert.equal(office.viewerName, undefined);
  assert.match((await office.connect('bad', 'owner'))!, /doesn't look like a Linear API key/);
  assert.match((await office.connect(TEST_KEY, 'owner'))!, /Couldn't reach Linear/);
  await assert.rejects(office.teamContext('team'), /not connected.*Settings/);
  await office.refreshTeams(true);
  office.disconnect();
  assert.equal(existsSync(office.file), false);
});

test('office restore tolerates absent, malformed and incomplete connection files', (t) => {
  const dir = temporary(t);
  for (const text of ['{', 'null', '{}', JSON.stringify({ key: TEST_KEY }), JSON.stringify({ key: 'bad', viewerId: 'viewer' })]) {
    writeFileSync(path.join(dir, 'linear.json'), text);
    const office = new LinearOffice(dir, noFetch);
    assert.equal(office.connection(), undefined);
  }
  writeFileSync(path.join(dir, 'linear.json'), JSON.stringify({ key: TEST_KEY, viewerId: 'viewer' }));
  const office = new LinearOffice(dir, noFetch);
  assert.equal(office.viewerId, 'viewer');
  assert.equal(office.connection()?.workspace, 'Linear');
  assert.deepEqual(office.connection()?.teams, []);
  assert.ok(!JSON.stringify(office.connection()).includes(TEST_KEY));
  assert.ok(office.client());
  office.disconnect();
  assert.equal(existsSync(office.file), false);
});

test('unconfigured floor exposes no board and refuses team, autopilot, detail, take and create', async (t) => {
  const dir = temporary(t);
  const floor = new FloorLinear(dir, new LinearOffice(dir, noFetch), undefined, events());
  assert.equal(floor.on, false);
  assert.equal(floor.piloted, false);
  assert.equal(floor.fetchedAt, 0);
  assert.equal(floor.board, null);
  assert.equal(floor.state().working, 0);
  assert.match(floor.setTeam('DOFF', undefined, 'owner')!, /Connect.*first/);
  assert.match(floor.setAutopilot({ on: true }, 'owner')!, /Pick a Linear team/);
  assert.match((await floor.take('DOFF-12', { id: 'widget', name: 'Widget' })).error!, /not connected/);
  await assert.rejects(floor.detail('DOFF-12'), /no Linear team/);
  await assert.rejects(floor.create({ title: 'Task' }), /no Linear team/);
  await floor.connectionChanged();
  await floor.refresh();
  await floor.pilot();
  await floor.sync([]);
  floor.workersChanged();
  assert.equal(floor.linkOf('widget'), undefined);
});

test('floor restore sanitizes malformed setup, autopilot and links without network access', (t) => {
  const dir = temporary(t);
  const file = path.join(dir, 'linear-floor.json');
  for (const text of ['{', 'null', '0']) {
    writeFileSync(file, text);
    assert.equal(new FloorLinear(dir, new LinearOffice(dir, noFetch), undefined, events()).setup, undefined);
  }
  writeFileSync(
    file,
    JSON.stringify({
      setup: { team: { id: 'team', key: 'DOFF' } },
      autopilot: { on: true, pickup: ['completed'], max: 99, existing: true, model: 'custom:test' },
      links: [null, {}, { issueId: 'issue', workerId: 'widget', stage: 'started' }, { issueId: 'bad', workerId: 'bad', stage: 'invalid' }],
    }),
  );
  const floor = new FloorLinear(dir, new LinearOffice(dir, noFetch), undefined, events());
  assert.equal(floor.setup?.team.name, 'DOFF');
  assert.equal(floor.autopilot.max, AUTOPILOT_MAX);
  assert.deepEqual(floor.autopilot.pickup, ['unstarted']);
  assert.equal(floor.autopilot.model, 'custom:test');
  assert.equal(floor.linkOf('widget')?.issueId, 'issue');
  assert.equal(floor.linkOf('bad'), undefined);
  assert.match(floor.setAutopilot({ pickup: [] }, 'owner')!, /at least one/);
  floor.setAutopilot({ on: false, max: 0, model: '' }, 'owner');
  assert.equal(floor.autopilot.max, 1);
  assert.ok(!('model' in floor.autopilot));
  floor.setAutopilot({ max: 2.5 }, 'owner');
  assert.equal(floor.autopilot.max, 1);
  const restored = new FloorLinear(dir, new LinearOffice(dir, noFetch), undefined, events());
  assert.deepEqual(restored.autopilot, floor.autopilot);
  assert.deepEqual(restored.setup, floor.setup);
  assert.deepEqual(restored.linkOf('widget'), floor.linkOf('widget'));
});

test('API maps captured auth, forbidden, GraphQL and malformed HTTP errors without leaking the key', async () => {
  const cases = [
    { body: authError, status: 401, expected: 401, code: 'AUTHENTICATION_ERROR', text: /didn't accept.*authenticate/ },
    { body: authError, status: 200, expected: 401, code: 'AUTHENTICATION_ERROR', text: /revoked/ },
    { body: { errors: [{ message: `Forbidden ${TEST_KEY}`, extensions: { code: 'FORBIDDEN' } }] }, status: 200, expected: 403, code: 'FORBIDDEN', text: /may not do that/ },
    { body: complexityError, status: 400, expected: 400, code: 'INPUT_ERROR', text: /13240.*10000/ },
    { body: { errors: [{ message: `First ${TEST_KEY}` }, { message: 'Second' }] }, status: 200, expected: 400, code: undefined, text: /First.*Second/ },
    { body: { errors: [{}] }, status: 200, expected: 400, code: undefined, text: /answered 200/ },
  ];
  for (const c of cases) {
    const api = new LinearApi(TEST_KEY, async () => Response.json(c.body, { status: c.status }));
    await assert.rejects(api.me(), (err) => {
      assert.ok(err instanceof LinearError);
      assert.equal(err.status, c.expected);
      assert.equal(err.code, c.code);
      assert.match(err.message, c.text);
      assert.ok(!String(err.stack).includes(TEST_KEY));
      return true;
    });
  }
  for (const [body, status] of [
    ['not JSON', 502],
    ['', 401],
    ['{}', 200],
  ] as const) {
    await assert.rejects(new LinearApi(TEST_KEY, async () => new Response(body, { status })).me(), LinearError);
  }
});

test('API rate limiting recognizes HTTP and GraphQL status and reset/retry headers', async (t) => {
  const now = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ['Date'], now });
  for (const status of [400, 429]) {
    const api = new LinearApi(TEST_KEY, async () => Response.json({ errors: [{ message: 'Rate limited', extensions: { code: 'RATELIMITED' } }] }, { status, headers: { 'x-ratelimit-requests-reset': String(now + 125_500) } }));
    await assert.rejects(api.me(), (err) => err instanceof LinearError && err.status === 429 && err.retryAfter === 126);
  }
  const retry = new LinearApi(TEST_KEY, async () => new Response('', { status: 429, headers: { 'retry-after': '180' } }));
  await assert.rejects(retry.me(), (err) => err instanceof LinearError && err.retryAfter === 180);
  const expired = new LinearApi(TEST_KEY, async () => new Response('', { status: 429, headers: { 'x-ratelimit-requests-reset': '1' } }));
  await assert.rejects(expired.me(), (err) => err instanceof LinearError && err.retryAfter === undefined);
  for (const [headers, expected] of [
    [{ 'retry-after': new Date(now + 240_000).toUTCString() }, 240],
    [{ 'retry-after': '60', 'x-ratelimit-requests-reset': String(now + 180_000) }, 180],
    [{ 'retry-after': 'invalid' }, undefined],
    [{ 'retry-after': '-10' }, undefined],
  ] as const) {
    await assert.rejects(new LinearApi(TEST_KEY, async () => new Response('', { status: 429, headers })).me(), (err) => err instanceof LinearError && err.retryAfter === expected);
  }
});

test('API maps flat projects onto each matching team, excluding completed and canceled projects', async () => {
  const second = { ...teamsBody.teams.nodes[0], id: 'other', key: 'API', name: 'API' };
  const body = {
    teams: { nodes: [...teamsBody.teams.nodes, second] },
    projects: {
      nodes: [
        { ...project, teams: { nodes: [{ id: 'team' }, { id: 'other' }] } },
        { ...project, id: 'canceled', state: 'canceled' },
        { ...project, id: 'completed', state: 'completed' },
        { ...project, id: 'unrelated', teams: { nodes: [{ id: 'unknown' }] } },
      ],
    },
  };
  const api = new LinearApi(TEST_KEY, async (_url, init) => {
    assert.match(JSON.parse(String(init?.body)).query, /projects\(first: 100\).*teams\(first: 10\)/);
    return Response.json({ data: body });
  });
  const teams = await api.teams();
  assert.deepEqual(
    teams.map((x) => x.key),
    ['API', 'DOFF'],
  );
  assert.deepEqual(
    teams.map((x) => x.projects),
    [[{ id: 'project', name: 'Droid Office' }], [{ id: 'project', name: 'Droid Office' }]],
  );
});

test('ticket/detail conversion handles captured nulls, missing fields, nested relations and chronological comment authors', () => {
  const detail = detailOf({
    ...rawIssue,
    estimate: 0,
    assignee: meBody.viewer,
    project: { name: project.name },
    parent: { identifier: 'DOFF-1', title: 'Parent' },
    children: { nodes: [{ identifier: 'DOFF-2', title: 'Child' }] },
    comments: {
      nodes: [
        { id: 'later', body: 'Later', createdAt: '2026-11-12', user: { name: 'Owner' } },
        { id: 'bot', body: 'Earlier', createdAt: '2026-11-11', user: null, botActor: { name: 'Linear' } },
        { id: 'unknown', body: '', createdAt: '2026-11-10' },
      ],
    },
    attachments: { nodes: [{ title: 'PR', url: 'https://github.com/example/repo/pull/1' }] },
  });
  assert.deepEqual(
    detail.comments.map((c) => c.author),
    ['someone', 'Linear', 'Owner'],
  );
  assert.equal(detail.estimate, 0);
  assert.equal(detail.assignee, 'Owner');
  assert.equal(detail.project, 'Droid Office');
  assert.equal(detail.children[0].state, '');
  assert.equal(detail.parent?.identifier, 'DOFF-1');
  assert.equal(detail.attachments[0].title, 'PR');
  const minimal = detailOf({ id: 'id', identifier: 'DOFF-1', title: '', url: '', state: { id: '', name: '', type: 'new-type', color: '' } });
  assert.equal(minimal.state.type, 'backlog');
  assert.deepEqual(minimal.team, { id: '', key: '', name: '' });
  assert.equal(minimal.description, '');
  assert.equal(minimal.branchName, '');
  assert.equal(ticketOf({ id: 'id', identifier: 'DOFF-1', title: '', url: '' }).state.color, '#888888');
});

test('API paginates with cursors and limits, and board uses project and recent-completion filters', async () => {
  const calls: Record<string, any>[] = [];
  const api = new LinearApi(TEST_KEY, async (_url, init) => {
    const { variables } = JSON.parse(String(init?.body));
    calls.push(variables);
    return Response.json({ data: { issues: { nodes: Array.from({ length: variables.after ? 3 : 100 }, () => rawIssue), pageInfo: { hasNextPage: !variables.after, endCursor: 'cursor' } } } });
  });
  assert.equal((await api.issues({ title: { contains: 'fixture' } }, 102)).length, 102);
  assert.equal(calls[0].first, 100);
  assert.equal(calls[1].first, 2);
  assert.equal(calls[1].after, 'cursor');
  calls.length = 0;
  await api.board('team', 'project');
  assert.deepEqual(calls[0].filter.team, { id: { eq: 'team' } });
  assert.deepEqual(calls[0].filter.project, { id: { eq: 'project' } });
  assert.deepEqual(calls[0].filter.or[1].completedAt, { gte: '-P14D' });
});

test('API maps absent and inaccessible issues to 404 and failed mutation success flags to clear errors', async () => {
  for (const body of [{ data: { issue: null } }, missingError]) {
    await assert.rejects(new LinearApi(TEST_KEY, async () => Response.json(body, { status: 'errors' in body ? 400 : 200 })).issue('DOFF-1'), (err) => err instanceof LinearError && err.status === 404 && /no DOFF-1/.test(err.message));
  }
  for (const [key, invoke] of [
    ['issueCreate', (api: LinearApi) => api.createIssue({ title: 'Task' })],
    ['issueUpdate', (api: LinearApi) => api.updateIssue(rawIssue.id, {})],
    ['commentCreate', (api: LinearApi) => api.comment(rawIssue.id, 'Note')],
    ['attachmentLinkURL', (api: LinearApi) => api.attach(rawIssue.id, rawIssue.url, 'Link')],
  ] as const) {
    const api = new LinearApi(TEST_KEY, async () => Response.json({ data: { [key]: { success: false } } }));
    await assert.rejects(invoke(api), /Linear didn't/);
  }
});

test('office connects, stores 0600 credentials, restores without network and disconnects cleanly', async (t) => {
  const r = await connectedFloor(t);
  assert.equal(statSync(r.office.file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(r.office.file, 'utf8')).key, TEST_KEY);
  assert.ok(!JSON.stringify(r.office.connection()).includes(TEST_KEY));
  for (const ref of ['team', 'doff', ' Droid-Office ']) assert.equal(r.office.findTeam(ref)?.id, 'team');
  assert.equal(r.office.findTeam('unknown'), undefined);
  const restored = new LinearOffice(r.dir, noFetch);
  assert.deepEqual(restored.connection(), r.office.connection());
  assert.equal(restored.viewerName, 'Owner');
  assert.equal(restored.viewerId, 'viewer');
  assert.ok(restored.client());
  restored.disconnect();
  assert.equal(restored.client(), undefined);
  assert.equal(existsSync(restored.file), false);
});

test('office context cache shares inflight requests, expires, forces refresh and evicts failures', async (t) => {
  const r = await connectedFloor(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const a = r.office.teamContext('team');
  const b = r.office.teamContext('team');
  assert.equal(a, b);
  const ctx = await a;
  assert.deepEqual(
    ctx.states.map((s) => s.id),
    ['backlog', 'todo', 'progress', 'done', 'review'],
  );
  assert.deepEqual(
    ctx.labels.map((l) => l.name),
    ['Docs', 'Bug'],
  );
  assert.equal(ctx.members.length, 1);
  await r.office.teamContext('team', true);
  t.mock.timers.tick(5 * 60_000);
  await r.office.teamContext('team');
  assert.equal(r.api.calls.filter((c) => c.query.startsWith('query Team(')).length, 3);
  r.api.fail(Response.json(complexityError, { status: 400 }));
  await assert.rejects(r.office.teamContext('team', true), /too complex/);
  await r.office.teamContext('team');
  await r.office.refreshTeams();
  const before = r.api.calls.filter((c) => c.query.startsWith('query Teams')).length;
  await r.office.refreshTeams(true);
  assert.equal(r.api.calls.filter((c) => c.query.startsWith('query Teams')).length, before + 1);
  assert.equal(r.changes(), 0, 'unchanged teams do not announce changes');
});

test('floor guesses only a matching team, validates project and autopilot configuration, and persists', async (t) => {
  const r = await connectedFloor(t);
  assert.equal(r.floor.setup?.team.id, 'team');
  assert.equal(new FloorLinear(temporary(t), r.office, undefined, events(), ['unrelated']).setup, undefined);
  assert.match(r.floor.setTeam('missing', undefined, 'Owner')!, /no team/);
  assert.match(r.floor.setTeam('DOFF', 'missing', 'Owner')!, /no project/);
  assert.equal(r.floor.setTeam('doff', 'droid office', 'Owner'), undefined);
  await r.floor.refresh(true);
  assert.equal(r.floor.setup?.project?.id, 'project');
  assert.match(r.floor.setAutopilot({ pickup: [] }, 'Owner')!, /at least one/);
  assert.equal(r.floor.setAutopilot({ max: 99, pickup: ['backlog', 'unstarted', 'backlog'], model: 'custom:test' }, 'Owner'), undefined);
  assert.equal(r.floor.autopilot.max, 8);
  assert.deepEqual(r.floor.autopilot.pickup, ['backlog', 'unstarted']);
  const restored = new FloorLinear(r.dir, r.office, undefined, events());
  assert.deepEqual(restored.setup, r.floor.setup);
  assert.deepEqual(restored.autopilot, r.floor.autopilot);
  assert.equal(statSync(path.join(r.dir, 'linear-floor.json')).mode & 0o777, 0o600);
});

test('floor refresh publishes loading and fetched boards and applies exponential 429 backoff with force override', async (t) => {
  const r = await connectedFloor(t);
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now });
  const boards: boolean[] = [];
  r.event.board = (board) => {
    boards.push(!!board?.loading);
  };
  r.api.fail(new Response('', { status: 429, headers: { 'x-ratelimit-requests-reset': String(now + 90_000) } }));
  await r.floor.refresh();
  assert.match(r.floor.board?.error ?? '', /rate limiting/);
  const count = r.api.calls.length;
  await r.floor.refresh();
  assert.equal(r.api.calls.length, count);
  t.mock.timers.tick(89_999);
  await r.floor.refresh();
  assert.equal(r.api.calls.length, count);
  t.mock.timers.tick(1);
  r.api.fail(new Response('', { status: 429 }));
  await r.floor.refresh();
  t.mock.timers.tick(119_999);
  const second = r.api.calls.length;
  await r.floor.refresh();
  assert.equal(r.api.calls.length, second);
  await r.floor.refresh(true);
  assert.equal(r.floor.board?.error, undefined);
  assert.equal(r.floor.fetchedAt, Date.now());
  assert.deepEqual(boards, [true, false, true, false, true, false]);
});

test('taking a ticket moves to started, assigns only when unassigned, and keeps review/done', async (t) => {
  const r = await connectedFloor(t);
  const worker = person();
  r.people.push(worker);
  const first = await r.floor.take('doff-900', worker, { auto: true });
  assert.equal(first.ticket?.state.id, 'progress');
  assert.equal(first.ticket?.assignee, 'Owner');
  assert.equal(r.floor.state().working, 1);
  assert.equal(r.floor.linkOf(worker.id)?.auto, true);
  assert.deepEqual(r.api.calls.find((c) => c.query.startsWith('mutation Update'))?.variables.input, { stateId: 'progress', assigneeId: 'viewer' });
  for (const state of ['review', 'done']) {
    r.api.issues.get(rawIssue.id)!.state = teamBody.team.states.nodes.find((s) => s.id === state);
    const before = r.api.calls.filter((c) => c.query.startsWith('mutation Update')).length;
    const result = await r.floor.take('DOFF-900', worker);
    assert.equal(result.ticket?.state.id, state);
    assert.equal(r.api.calls.filter((c) => c.query.startsWith('mutation Update')).length, before);
  }
  const restored = new FloorLinear(r.dir, r.office, undefined, r.event);
  assert.deepEqual(restored.linkOf(worker.id), r.floor.linkOf(worker.id));
  assert.match((await r.floor.take('bad', worker)).error!, /DOFF-12/);
  assert.match((await r.floor.take('DOFF-999', worker)).error!, /no DOFF-999/);
});

test('floor detail enforces its team, worker chips follow workers, and changed tickets update only a fetched own board', async (t) => {
  const r = await connectedFloor(t);
  const worker = person();
  r.people.push(worker);
  await r.floor.take('DOFF-900', worker);
  await r.floor.refresh();
  assert.equal((await r.floor.detail('DOFF-900')).worker?.id, worker.id);
  worker.name = 'Renamed';
  r.floor.workersChanged();
  assert.equal(r.floor.board?.items[0].worker?.name, 'Renamed');
  r.floor.changed({ ...detailOf(rawIssue), title: 'Changed' });
  assert.equal(r.floor.board?.items[0].title, 'Changed');
  r.floor.changed({ ...detailOf(rawIssue), title: 'Wrong team', team: { ...teamRef, id: 'other' } });
  assert.equal(r.floor.board?.items[0].title, 'Changed');
  r.api.issues.get(rawIssue.id)!.team = { ...teamRef, id: 'other' };
  await assert.rejects(r.floor.detail('DOFF-900'), /isn't one of/);
  await assert.rejects(r.floor.detail('invalid'), /DOFF-12/);
  r.people.length = 0;
  r.floor.workersChanged();
  assert.equal(r.floor.board?.items[0].worker, undefined);
});

test('PR synchronization attaches and reviews, completes with a comment on merge, and forgets workers without PRs', async (t) => {
  const r = await connectedFloor(t);
  const worker = person();
  r.people.push(worker);
  await r.floor.take('DOFF-900', worker);
  worker.pr = { number: 12, url: 'https://github.com/example/repo/pull/12' };
  const pull = { ...worker.pr, state: 'OPEN' } as GhPull;
  await r.floor.sync([pull]);
  assert.equal(r.floor.linkOf(worker.id)?.stage, 'review');
  assert.deepEqual(r.api.calls.find((c) => c.query.startsWith('mutation Attach'))?.variables, { issueId: rawIssue.id, url: worker.pr.url, title: 'PR #12 by widget' });
  assert.deepEqual(r.api.calls.filter((c) => c.query.startsWith('mutation Update')).at(-1)?.variables.input, { stateId: 'review' });
  r.people.length = 0;
  await r.floor.sync([{ ...pull, state: 'MERGED' }]);
  assert.equal(r.floor.linkOf(worker.id), undefined);
  assert.deepEqual(r.api.calls.filter((c) => c.query.startsWith('mutation Update')).at(-1)?.variables.input, { stateId: 'done' });
  assert.match(r.api.calls.find((c) => c.query.startsWith('mutation Comment'))?.variables.input.body, /Merged in \[PR #12\].*Done by widget/);
  assert.match(r.notices.at(-1)!, /DOFF-900 is done/);
  const comments = r.api.calls.filter((c) => c.query.startsWith('mutation Comment')).length;
  await r.floor.sync([{ ...pull, state: 'MERGED' }]);
  assert.equal(r.api.calls.filter((c) => c.query.startsWith('mutation Comment')).length, comments);
  await r.floor.take('DOFF-900', person('gone'));
  await r.floor.sync([]);
  assert.equal(r.floor.linkOf('gone'), undefined);
});

test('floor create trims and caps titles, defaults to Todo, supports backlog and floor project', async (t) => {
  const r = await connectedFloor(t);
  r.floor.setup!.project = { id: project.id, name: project.name };
  await r.floor.refresh();
  await r.floor.create({ title: ` ${'a'.repeat(300)} `, description: ' Details ', priority: 1 });
  assert.deepEqual(r.api.calls.filter((c) => c.query.startsWith('mutation Create')).at(-1)?.variables.input, { teamId: 'team', title: 'a'.repeat(250), description: 'Details', priority: 1, projectId: 'project', stateId: 'todo' });
  await r.floor.create({ title: 'Park it', state: 'backlog' });
  assert.equal(r.api.calls.filter((c) => c.query.startsWith('mutation Create')).at(-1)?.variables.input.stateId, 'backlog');
  await assert.rejects(r.floor.create({ title: '  ' }), /needs a title/);
});

test('autopilot respects max, existing=false cutoff and assignment, and successful linked hires are not repeated', async (t) => {
  const r = await connectedFloor(t);
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now });
  const items = ['old', 'other', 'eligible', 'next'].map((name, i) => ({
    ...structuredClone(rawIssue),
    id: `00000000-0000-4000-8000-00000000000${i}`,
    identifier: `DOFF-${i + 1}`,
    state: teamBody.team.states.nodes.find((s) => s.id === 'todo'),
    createdAt: new Date(now + (name === 'old' ? -1 : 0)).toISOString(),
    assignee: name === 'other' ? { id: 'other', name: 'Another person' } : null,
  }));
  for (const item of items) r.api.issues.set(item.id, item);
  r.api.setBoard(items.map((i) => i.id));
  r.event.hire = async (prompt, identifier, model) => {
    r.hires.push({ prompt, identifier, model });
    const worker = person(`worker-${identifier}`);
    r.people.push(worker);
    await r.floor.take(identifier, worker, { auto: true });
    return { workerId: worker.id };
  };
  r.floor.setAutopilot({ on: true, max: 1, existing: false, model: 'custom:test' }, 'Owner');
  await r.floor.refresh();
  // refresh launches pilot synchronously up to its first await. Share its completion rather than sleep.
  await r.pilotDone();
  assert.deepEqual(
    r.hires.map((h) => h.identifier),
    ['DOFF-3'],
  );
  assert.equal(r.hires[0].model, 'custom:test');
  assert.match(r.hires[0].prompt, /Work on Linear issue DOFF-3/);
  assert.equal(r.floor.state().working, 1);
  await r.floor.pilot();
  assert.equal(r.hires.length, 1);
});

test('autopilot persists skipped retries and stops the current pass on desk-full errors', async (t) => {
  const r = await connectedFloor(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const two = { ...structuredClone(rawIssue), id: '00000000-0000-4000-8000-000000000002', identifier: 'DOFF-2' };
  r.api.issues.set(two.id, two);
  r.api.setBoard([rawIssue.id, two.id]);
  let attempts = 0;
  r.event.hire = async () => {
    attempts++;
    return { error: 'No free desk' };
  };
  r.floor.setAutopilot({ on: true, pickup: ['backlog'], existing: true, max: 8 }, 'Owner');
  await r.floor.refresh();
  await r.pilotDone();
  assert.equal(attempts, 1, 'each pass stops at the first full desk');
  await r.floor.pilot();
  assert.equal(attempts, 2);
  await r.floor.pilot();
  assert.equal(attempts, 2, 'both skipped issues stay in cooldown');
  const restored = new FloorLinear(r.dir, r.office, undefined, r.event);
  assert.deepEqual(JSON.parse(readFileSync(path.join(r.dir, 'linear-floor.json'), 'utf8')).skipped, { [rawIssue.id]: Date.now(), [two.id]: Date.now() });
  restored.board = r.floor.board;
  await restored.pilot();
  assert.equal(attempts, 2);
  t.mock.timers.tick(10 * 60_000 + 1);
  await restored.pilot();
  assert.equal(attempts, 3);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('refresh ignores stale results after disconnect and deduplicates an in-flight board read', async (t) => {
  const r = await connectedFloor(t);
  const entered = deferred();
  const release = deferred();
  r.api.before(async (query) => {
    if (query.startsWith('query Issues')) {
      entered.resolve();
      await release.promise;
    }
  });
  const pending = r.floor.refresh();
  await entered.promise;
  await r.floor.refresh();
  assert.equal(r.api.calls.filter((c) => c.query.startsWith('query Issues')).length, 1);
  r.office.disconnect();
  await r.floor.connectionChanged();
  release.resolve();
  await pending;
  assert.equal(r.floor.board, null);
});

test('floor detail refuses a result from a connection replaced while the request was running', async (t) => {
  const r = await connectedFloor(t);
  const entered = deferred();
  const release = deferred();
  r.api.before(async (query) => {
    if (query.startsWith('query Issue(')) {
      entered.resolve();
      await release.promise;
    }
  });
  const pending = r.floor.detail('DOFF-900');
  await entered.promise;
  r.office.disconnect();
  release.resolve();
  await assert.rejects(pending, (err) => err instanceof LinearError && err.status === 409);
});

test('autopilot serializes concurrent looks, continues after non-capacity failures and retries only after cooldown under jitter', async (t) => {
  const r = await connectedFloor(t);
  const gate = deferred();
  const entered = deferred();
  const two = { ...structuredClone(rawIssue), id: '00000000-0000-4000-8000-000000000002', identifier: 'DOFF-2' };
  r.api.issues.set(two.id, two);
  r.api.setBoard([rawIssue.id, two.id]);
  let attempts = 0;
  r.event.hire = async () => {
    attempts++;
    if (attempts === 1) {
      entered.resolve();
      await gate.promise;
    }
    return { error: 'Provider temporarily unavailable' };
  };
  r.api.before(async () => {
    await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 5)));
  });
  r.floor.setAutopilot({ on: true, pickup: ['backlog'], existing: true, max: 2 }, 'Owner');
  await r.floor.refresh();
  await entered.promise;
  const running = r.pilotDone();
  await r.floor.pilot();
  assert.equal(attempts, 1);
  gate.resolve();
  await running;
  assert.equal(attempts, 2, 'a provider failure does not stop the next ticket');
  await r.floor.pilot();
  assert.equal(attempts, 2);
});

test('office refreshTeams persists changed teams and notifies only after successful reads', async (t) => {
  const r = await connectedFloor(t);
  const changed = { ...teamsBody, teams: { nodes: [...teamsBody.teams.nodes, { ...teamsBody.teams.nodes[0], id: 'second', key: 'API', name: 'API' }] } };
  r.api.fail(Response.json({ data: changed }));
  await r.office.refreshTeams(true);
  assert.equal(r.changes(), 1);
  assert.equal(r.office.connection()?.teams.length, 2);
  r.api.fail(Response.json(complexityError, { status: 400 }));
  await r.office.refreshTeams(true);
  assert.equal(r.changes(), 1);
  assert.equal(r.office.connection()?.teams.length, 2);
  assert.equal(new LinearOffice(r.dir, noFetch).connection()?.teams.length, 2);
});

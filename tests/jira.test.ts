import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FloorJira, JiraApi, type JiraError, JiraOffice, jiraSite, redact, ticketOf, workerTicket } from '../src/server/jira.js';
import { adfToMarkdown, childrenJql, columnsOf, jiraKey, keysIn, pickTransition, subQueryOf, textToAdf, ticketColumns, ticketPrompt, type JiraBoardState, type JiraTicket, type JiraTransition } from '../src/shared/jira.js';

const TOKEN = 'ATATT3xFfGF0-secret-token-value';
const SITE = 'https://example.atlassian.net';

interface Call {
  method: string;
  url: string;
  auth: string;
  body?: any;
}

/** A fake Jira Cloud: routes by "METHOD /path", answering JSON (or a status with a body). */
function fakeJira(routes: Record<string, (call: Call) => unknown | { status: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? 'GET',
      url: url.pathname + url.search,
      auth: String((init?.headers as Record<string, string>)?.authorization ?? ''),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const route = Object.entries(routes).find(([k]) => {
      const [m, p] = k.split(' ');
      return m === call.method && (p.endsWith('*') ? url.pathname.startsWith(p.slice(0, -1)) : url.pathname === p);
    });
    if (!route) return new Response(JSON.stringify({ errorMessages: [`no route for ${call.method} ${url.pathname}`] }), { status: 404 });
    const out = route[1](call) as any;
    if (out && typeof out === 'object' && typeof out.status === 'number' && 'body' in out) return new Response(out.body === undefined ? '' : JSON.stringify(out.body), { status: out.status, headers: out.headers });
    return new Response(out === undefined ? '' : JSON.stringify(out), { status: 200 });
  }) as typeof fetch;
  return { impl, calls };
}

const tmp = () => mkdtempSync(path.join(tmpdir(), 'ao-jira-'));

const MYSELF = { 'GET /rest/api/3/myself': () => ({ accountId: 'acc-1', displayName: 'Office Bot' }) };

function ticket(key: string, statusId: string, status = 'To Do', category: JiraTicket['category'] = 'new'): JiraTicket {
  return { key, summary: key, type: 'Story', priority: 'Medium', status, statusId, category, url: `${SITE}/browse/${key}`, updated: '' };
}

// ---- Keys, sites and redaction -----------------------------------------------------------------

test('reads issue keys, and finds them in PR titles and branches', () => {
  assert.equal(jiraKey(' edp-168 '), 'EDP-168');
  assert.equal(jiraKey('EDP-0'), undefined);
  assert.equal(jiraKey('168'), undefined);
  assert.equal(jiraKey('EDP-12; rm -rf'), undefined);
  assert.equal(jiraKey(12), undefined);
  assert.deepEqual(keysIn('EDP-12: Fix login office/edp-12-pixel-3f2a'), ['EDP-12']);
  assert.deepEqual(keysIn('office/edp-7-ada ABC-1 and UTF-8'), ['EDP-7', 'ABC-1', 'UTF-8']);
  assert.deepEqual(keysIn('EDP-12x EDP-3_ok'), []);
  assert.deepEqual(keysIn('no keys here'), []);
});

test('only takes Jira Cloud sites', () => {
  assert.equal(jiraSite('https://Example.atlassian.net/jira/software'), SITE);
  assert.equal(jiraSite('example.atlassian.net'), SITE);
  assert.equal(jiraSite('example'), SITE);
  assert.equal(jiraSite('https://jira.example.com'), undefined);
  assert.equal(jiraSite('https://atlassian.net.evil.com'), undefined);
  assert.equal(jiraSite(''), undefined);
});

test('redacts the token wherever it shows up', () => {
  assert.equal(redact(`bad token ${TOKEN} here ${TOKEN}`, [TOKEN]), 'bad token [redacted] here [redacted]');
  assert.equal(redact('nothing secret', [TOKEN, '']), 'nothing secret');
});

// ---- The connection ----------------------------------------------------------------------------

test('connecting checks the credentials with /myself and stores them 0600, never showing the token', async () => {
  const dir = tmp();
  const jira = fakeJira(MYSELF);
  const office = new JiraOffice(dir, jira.impl);
  assert.equal(await office.connect('example', 'bot@example.com', TOKEN, 'Ada'), undefined);
  assert.equal(jira.calls[0].url, '/rest/api/3/myself');
  assert.equal(jira.calls[0].auth, `Basic ${Buffer.from(`bot@example.com:${TOKEN}`).toString('base64')}`);
  const conn = office.connection();
  assert.deepEqual({ ...conn, at: 0 }, { site: SITE, email: 'bot@example.com', name: 'Office Bot', by: 'Ada', at: 0 });
  // What browsers get says nothing of the token.
  assert.ok(!JSON.stringify(conn).includes(TOKEN));
  const file = path.join(dir, 'jira.json');
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).token, TOKEN);
  // And it comes back after a restart.
  const again = new JiraOffice(dir, jira.impl);
  assert.equal(again.connection()?.name, 'Office Bot');
  assert.equal(again.accountId, 'acc-1');
  again.disconnect();
  assert.equal(again.connection(), undefined);
  assert.equal(new JiraOffice(dir, jira.impl).connection(), undefined);
});

test('a bad connection says what is wrong, and never repeats the token', async () => {
  const dir = tmp();
  const cases: [Parameters<JiraOffice['connect']>, Parameters<typeof fakeJira>[0], RegExp][] = [
    [['https://jira.example.com', 'a@b.co', TOKEN, 'x'], {}, /Jira Cloud address/],
    [['example', 'not-an-email', TOKEN, 'x'], {}, /email/],
    [['example', 'a@b.co', 'short', 'x'], {}, /API token/],
    [['example', 'a@b.co', TOKEN, 'x'], { 'GET /rest/api/3/myself': () => ({ status: 401, body: { message: `token ${TOKEN} rejected` } }) }, /didn't accept the email and API token/],
    [['example', 'a@b.co', TOKEN, 'x'], { 'GET /rest/api/3/myself': () => ({ status: 403, body: { errorMessages: [`no access for ${TOKEN}`] } }) }, /no access/],
    [['example', 'a@b.co', TOKEN, 'x'], { 'GET /rest/api/3/myself': () => ({ status: 404, body: undefined }) }, /doesn't look like a Jira Cloud site/],
  ];
  for (const [args, routes, message] of cases) {
    const office = new JiraOffice(dir, fakeJira(routes).impl);
    const err = await office.connect(...args);
    assert.match(err ?? '', message, String(args[0]));
    assert.ok(!err?.includes(TOKEN), 'the token is redacted');
    assert.equal(office.connection(), undefined);
  }
  const unreachable = new JiraOffice(dir, (async () => {
    throw Object.assign(new Error(`fetch failed ${TOKEN}`), { cause: { code: 'ENOTFOUND' } });
  }) as typeof fetch);
  const err = await unreachable.connect('example', 'a@b.co', TOKEN, 'x');
  assert.match(err ?? '', /Couldn't reach https:\/\/example\.atlassian\.net \(ENOTFOUND\)/);
});

test('a broken or incomplete jira.json means no connection', () => {
  const dir = tmp();
  writeFileSync(path.join(dir, 'jira.json'), '{not json');
  assert.equal(new JiraOffice(dir).connection(), undefined);
  writeFileSync(path.join(dir, 'jira.json'), JSON.stringify({ site: 'https://evil.com', email: 'a@b.co', token: TOKEN, accountId: 'x' }));
  assert.equal(new JiraOffice(dir).connection(), undefined);
});

test('a 429 carries its Retry-After', async () => {
  const api = new JiraApi({ site: SITE, email: 'a@b.co', token: TOKEN }, fakeJira({ 'GET /rest/api/3/myself': () => ({ status: 429, body: {}, headers: { 'retry-after': '30' } }) }).impl);
  await assert.rejects(api.myself(), (e: JiraError) => e.status === 429 && e.retryAfter === 30);
});

// ---- The epic and its board --------------------------------------------------------------------

async function connected(routes: Parameters<typeof fakeJira>[0]) {
  const jira = fakeJira({ ...MYSELF, ...routes });
  const office = new JiraOffice(tmp(), jira.impl);
  assert.equal(await office.connect('example', 'bot@example.com', TOKEN, 'Ada'), undefined);
  const states: unknown[] = [];
  const boards: (JiraBoardState | null)[] = [];
  const floor = new FloorJira(tmp(), office, { state: (s) => states.push(s), board: (b) => boards.push(b) });
  return { jira, office, floor, states, boards };
}

const EPIC = { key: 'EDP-168', fields: { summary: 'In-app chat', issuetype: { name: 'Epic', hierarchyLevel: 1 }, project: { key: 'EDP' } } };
const CONFIG = {
  subQuery: { query: 'fixVersion in unreleasedVersions() OR fixVersion is EMPTY' },
  columnConfig: {
    columns: [
      { name: 'Backlog', statuses: [] },
      { name: 'To Do', statuses: [{ id: '1' }] },
      { name: 'In Progress', statuses: [{ id: '3' }] },
      { name: 'Review', statuses: [{ id: '10' }] },
      { name: 'Done', statuses: [{ id: '5' }, { id: '6' }] },
    ],
  },
};

test('an epic must exist, be an epic, and have a board in its project', async () => {
  const notFound = await connected({ 'GET /rest/api/3/issue/*': () => ({ status: 404, body: { errorMessages: ['Issue does not exist'] } }) });
  assert.deepEqual(await notFound.floor.setEpic('EDP-999', undefined, 'Ada'), { error: "There's no EDP-999 in Jira, or the office's account can't see it" });

  const story = await connected({ 'GET /rest/api/3/issue/*': () => ({ key: 'EDP-12', fields: { issuetype: { name: 'Story', hierarchyLevel: 0 }, project: { key: 'EDP' } } }) });
  assert.deepEqual(await story.floor.setEpic('EDP-12', undefined, 'Ada'), { error: 'EDP-12 is a Story, not an epic' });

  assert.deepEqual(await story.floor.setEpic('not a key', undefined, 'Ada'), { error: 'An epic key looks like EDP-168' });

  const noBoard = await connected({
    'GET /rest/api/3/issue/*': () => EPIC,
    'GET /rest/agile/1.0/board': (c) => (c.url.includes('projectKeyOrId') ? { values: [], isLast: true } : { values: [{ id: 9, name: 'Other', location: { projectKey: 'ETH' } }], isLast: true }),
  });
  const none = await noBoard.floor.setEpic('EDP-168', undefined, 'Ada');
  assert.ok('error' in none);
  assert.match(none.error, /EDP project has no Jira board/);
  assert.equal(noBoard.floor.epic, undefined);

  const office = new JiraOffice(tmp());
  const unconnected = new FloorJira(tmp(), office, { state: () => {}, board: () => {} });
  assert.deepEqual(await unconnected.setEpic('EDP-168', undefined, 'Ada'), { error: 'Connect the office to Jira first' });
});

test("finds the project's board by its location when the project filter finds none", async () => {
  const { floor, jira } = await connected({
    'GET /rest/api/3/issue/*': () => EPIC,
    'GET /rest/agile/1.0/board': (c) => (c.url.includes('projectKeyOrId') ? { values: [], isLast: true } : { values: [{ id: 4851, name: 'EGT AI Engineering', type: 'kanban', location: { projectKey: 'EDP' } }], isLast: true }),
    'GET /rest/agile/1.0/board/4851/configuration': () => CONFIG,
    'POST /rest/api/3/search/jql': () => ({ issues: [], isLast: true }),
  });
  const r = await floor.setEpic('edp-168', undefined, 'Ada');
  assert.ok('epic' in r);
  assert.equal(r.epic.boardId, 4851);
  assert.equal(r.epic.boardName, 'EGT AI Engineering');
  assert.ok(jira.calls.some((c) => c.url.startsWith('/rest/agile/1.0/board?') && c.url.includes('projectKeyOrId=EDP')));
});

test('with more than one board, the admin picks one', async () => {
  const { floor } = await connected({
    'GET /rest/api/3/issue/*': () => EPIC,
    'GET /rest/agile/1.0/board': () => ({
      values: [
        { id: 1, name: 'Dev', type: 'scrum' },
        { id: 2, name: 'Kanban', type: 'kanban' },
      ],
      isLast: true,
    }),
    'GET /rest/agile/1.0/board/2/configuration': () => CONFIG,
    'POST /rest/api/3/search/jql': () => ({ issues: [], isLast: true }),
  });
  const first = await floor.setEpic('EDP-168', undefined, 'Ada');
  assert.deepEqual(first, {
    choose: [
      { id: 1, name: 'Dev', type: 'scrum' },
      { id: 2, name: 'Kanban', type: 'kanban' },
    ],
  });
  assert.deepEqual(await floor.setEpic('EDP-168', 99, 'Ada'), { error: "Board 99 isn't one of the EDP project's boards" });
  const picked = await floor.setEpic('EDP-168', 2, 'Ada');
  assert.ok('epic' in picked && picked.epic.boardId === 2);
});

test("the board shows the epic's direct children in the board's columns, and saves the epic", async () => {
  const children = [
    {
      key: 'EDP-1',
      fields: {
        summary: 'One',
        issuetype: { name: 'Story' },
        priority: { name: 'High' },
        assignee: { displayName: 'Nik' },
        status: { id: '3', name: 'In Progress', statusCategory: { key: 'indeterminate' } },
        updated: '2026-09-01T00:00:00Z',
      },
    },
    { key: 'EDP-2', fields: { summary: 'Two', issuetype: { name: 'Bug' }, status: { id: '42', name: 'Blocked', statusCategory: { key: 'indeterminate' } } } },
  ];
  const { floor, jira, boards } = await connected({
    'GET /rest/api/3/issue/*': () => EPIC,
    'GET /rest/agile/1.0/board': () => ({ values: [{ id: 7, name: 'EDP board' }], isLast: true }),
    'GET /rest/agile/1.0/board/7/configuration': () => CONFIG,
    'POST /rest/api/3/search/jql': () => ({ issues: children, isLast: true }),
  });
  const r = await floor.setEpic('EDP-168', undefined, 'Ada');
  assert.ok('epic' in r);
  await floor.refresh(true);
  const search = jira.calls.find((c) => c.url === '/rest/api/3/search/jql');
  assert.equal(search?.body.jql, 'parent = EDP-168 AND (fixVersion in unreleasedVersions() OR fixVersion is EMPTY) ORDER BY Rank ASC');
  const board = boards.at(-1)!;
  assert.deepEqual(
    board.columns.map((c) => c.name),
    ['To Do', 'In Progress', 'Review', 'Done'],
  );
  assert.deepEqual(
    board.items.map((t) => [t.key, t.status, t.assignee, t.url]),
    [
      ['EDP-1', 'In Progress', 'Nik', `${SITE}/browse/EDP-1`],
      ['EDP-2', 'Blocked', undefined, `${SITE}/browse/EDP-2`],
    ],
  );
  assert.ok(floor.on && floor.has('EDP-1'));
});

test('the board backs off when Jira rate limits it', async () => {
  let limited = true;
  const { floor, boards } = await connected({
    'GET /rest/api/3/issue/*': () => EPIC,
    'GET /rest/agile/1.0/board': () => ({ values: [{ id: 7, name: 'B' }], isLast: true }),
    'GET /rest/agile/1.0/board/7/configuration': () => CONFIG,
    'POST /rest/api/3/search/jql': () => (limited ? { status: 429, body: {}, headers: { 'retry-after': '120' } } : { issues: [], isLast: true }),
  });
  await floor.setEpic('EDP-168', undefined, 'Ada');
  await floor.refresh(true);
  assert.match(boards.at(-1)?.error ?? '', /rate limiting/);
  const before = boards.length;
  limited = false;
  // A scheduled refresh waits out the back-off...
  await floor.refresh();
  assert.equal(boards.length, before);
  // ...though someone pressing Refresh goes ahead.
  await floor.refresh(true);
  assert.equal(boards.at(-1)?.error, undefined);
});

// ---- Columns, transitions and ADF ----------------------------------------------------------------

test('maps statuses to the board columns, with a column for statuses it has none for', () => {
  const columns = columnsOf(CONFIG);
  assert.deepEqual(columns, [
    { name: 'To Do', statusIds: ['1'] },
    { name: 'In Progress', statusIds: ['3'] },
    { name: 'Review', statusIds: ['10'] },
    { name: 'Done', statusIds: ['5', '6'] },
  ]);
  const out = ticketColumns(columns, [ticket('A-1', '1'), ticket('A-2', '6'), ticket('A-3', '99'), ticket('A-4', '3')]);
  assert.deepEqual(
    out.map((c) => [c.name, c.items.map((t) => t.key)]),
    [
      ['To Do', ['A-1']],
      ['In Progress', ['A-4']],
      ['Review', []],
      ['Done', ['A-2']],
      ['Not on the board', ['A-3']],
    ],
  );
  assert.deepEqual(columnsOf({}), []);
  assert.equal(subQueryOf(CONFIG), 'fixVersion in unreleasedVersions() OR fixVersion is EMPTY');
  assert.equal(subQueryOf({ subQuery: { query: ' labels = x ORDER BY Rank ' } }), 'labels = x');
  assert.equal(subQueryOf({ subQuery: { query: '' } }), undefined);
  assert.equal(subQueryOf({}), undefined);
  assert.equal(childrenJql('EDP-168'), 'parent = EDP-168 ORDER BY Rank ASC');
  assert.equal(childrenJql('EDP-168', 'labels = x'), 'parent = EDP-168 AND (labels = x) ORDER BY Rank ASC');
});

const T = (id: string, name: string, to: string, toCategory: JiraTransition['toCategory']): JiraTransition => ({ id, name, to, toCategory });
const EDP_TRANSITIONS = [
  T('11', 'To Do', 'To Do', 'new'),
  T('21', 'In Progress', 'In Progress', 'indeterminate'),
  T('31', 'Done', 'Done', 'done'),
  T('41', 'In Review', 'In Review', 'indeterminate'),
  T('51', 'Ready for Development', 'Ready for Development', 'new'),
];

test('picks the right transition for each stage, and for what a person named', () => {
  assert.equal(pickTransition(EDP_TRANSITIONS, 'progress')?.id, '21');
  assert.equal(pickTransition(EDP_TRANSITIONS, 'review')?.id, '41');
  assert.equal(pickTransition(EDP_TRANSITIONS, 'done')?.id, '31');
  assert.equal(pickTransition(EDP_TRANSITIONS, 'in review')?.id, '41');
  assert.equal(pickTransition(EDP_TRANSITIONS, '51')?.id, '51');
  assert.equal(pickTransition(EDP_TRANSITIONS, 'ready')?.id, '51');
  // "Do" is in "To Do" and "Done": too vague to guess.
  assert.equal(pickTransition(EDP_TRANSITIONS, 'do'), undefined);
  assert.equal(pickTransition(EDP_TRANSITIONS, 'Shipped'), undefined);
  // Done never means Won't Do, and a workflow named differently still has a way in.
  const other = [T('1', "Won't do", "Won't Do", 'done'), T('2', 'Start work', 'Doing', 'indeterminate'), T('3', 'Resolve', 'Resolved', 'done'), T('4', 'Send to QA', 'Code Review', 'indeterminate')];
  assert.equal(pickTransition(other, 'done')?.id, '3');
  assert.equal(pickTransition(other, 'progress')?.id, '2');
  assert.equal(pickTransition(other, 'review')?.id, '4');
  assert.equal(pickTransition([T('1', "Won't do", "Won't Do", 'done')], 'done'), undefined);
  assert.equal(pickTransition([], 'progress'), undefined);
});

test('converts Atlassian Document Format to markdown', () => {
  const doc = {
    type: 'doc',
    version: 1,
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'DoD' }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'See ' },
          { type: 'text', text: 'the docs', marks: [{ type: 'link', attrs: { href: 'https://x.dev' } }] },
          { type: 'text', text: ' and ' },
          { type: 'text', text: 'run.sh', marks: [{ type: 'code' }] },
          { type: 'hardBreak' },
          { type: 'mention', attrs: { text: '@Nik' } },
          { type: 'text', text: ' is ', marks: [] },
          { type: 'text', text: 'on it', marks: [{ type: 'strong' }] },
        ],
      },
      {
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] },
          {
            type: 'listItem',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'two' }] },
              { type: 'orderedList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'nested' }] }] }] },
            ],
          },
        ],
      },
      { type: 'codeBlock', attrs: { language: 'ts' }, content: [{ type: 'text', text: 'const a = 1;' }] },
      { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'quoted' }] }] },
      { type: 'rule' },
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }] },
              { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'B' }] }] },
            ],
          },
          {
            type: 'tableRow',
            content: [
              { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '1|2' }] }] },
              { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '3' }] }] },
            ],
          },
        ],
      },
      { type: 'mediaSingle', content: [{ type: 'media', attrs: {} }] },
    ],
  };
  assert.equal(
    adfToMarkdown(doc),
    [
      '## DoD',
      'See [the docs](https://x.dev) and `run.sh`  \n@Nik is **on it**',
      '- one\n- two\n  1. nested',
      '```ts\nconst a = 1;\n```',
      '> quoted',
      '---',
      '| A | B |\n| --- | --- |\n| 1\\|2 | 3 |',
      '_(attachment: open the ticket in Jira to see it)_',
    ].join('\n\n'),
  );
  assert.equal(adfToMarkdown(null), '');
  assert.equal(adfToMarkdown('plain'), 'plain');
});

test('turns a comment into ADF paragraphs with links', () => {
  assert.deepEqual(textToAdf('PR is up:\nhttps://github.com/o/r/pull/3.\n\nThanks'), {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'PR is up:' },
          { type: 'hardBreak' },
          { type: 'text', text: 'https://github.com/o/r/pull/3', marks: [{ type: 'link', attrs: { href: 'https://github.com/o/r/pull/3' } }] },
          { type: 'text', text: '.' },
        ],
      },
      { type: 'paragraph', content: [{ type: 'text', text: 'Thanks' }] },
    ],
  });
});

test("the worker's prompt carries the ticket and the rules for keeping it up to date", () => {
  const p = ticketPrompt({ key: 'EDP-12', summary: 'Fix login', description: 'It breaks.', url: `${SITE}/browse/EDP-12` });
  assert.match(p, /^Work on Jira ticket EDP-12: "Fix login"\./);
  assert.match(p, /It breaks\./);
  assert.match(p, /office-jira transition "In Review"/);
  assert.match(p, /\*\*In Progress:\*\*/);
  assert.match(p, /Put EDP-12 in the branch name and in the PR title \(open it with `gh pr create`\)/);
  assert.match(p, /the office moves it to Done once the PR merges/);
  assert.match(ticketPrompt({ key: 'EDP-12', summary: 'x' }, 'gitlab'), /MR title \(open it with `glab mr create`\)/);
  assert.match(ticketPrompt({ key: 'EDP-12', summary: 'x' }), /\(No description\.\)/);
});

// ---- One ticket per worker -------------------------------------------------------------------------

test("a worker's office-jira requests reach only the ticket it was handed", () => {
  assert.deepEqual(workerTicket({ name: 'Pixel', ticket: 'EDP-12' }), { key: 'EDP-12' });
  assert.deepEqual(workerTicket({ name: 'Pixel', ticket: 'EDP-12' }, 'edp-12'), { key: 'EDP-12' });
  assert.deepEqual(workerTicket({ name: 'Pixel', ticket: 'EDP-12' }, 'EDP-13'), { status: 403, error: 'Pixel can only update EDP-12, the ticket it was handed (not EDP-13)' });
  assert.deepEqual(workerTicket({ name: 'Pixel', ticket: 'EDP-12' }, '../../myself'), { status: 403, error: 'Pixel can only update EDP-12, the ticket it was handed (not ../../myself)' });
  assert.deepEqual(workerTicket({ name: 'Pixel' }), { status: 403, error: "Pixel wasn't handed a Jira ticket, so there's none to update" });
});

test("the floor refuses tickets that aren't the epic's children", async () => {
  const { floor } = await connected({
    'GET /rest/api/3/issue/EDP-168': () => EPIC,
    'GET /rest/api/3/issue/ETH-1': () => ({ key: 'ETH-1', fields: { parent: { key: 'ETH-9' } } }),
    'GET /rest/agile/1.0/board': () => ({ values: [{ id: 7, name: 'B' }], isLast: true }),
    'GET /rest/agile/1.0/board/7/configuration': () => CONFIG,
    'POST /rest/api/3/search/jql': () => ({ issues: [], isLast: true }),
  });
  await floor.setEpic('EDP-168', undefined, 'Ada');
  await assert.rejects(floor.comment('ETH-1', 'hi'), /ETH-1 isn't one of EDP-168's tickets/);
  await assert.rejects(floor.transition('not-a-key', 'done'), /A ticket key looks like/);
});

test('claiming assigns the ticket to the office and moves it to In Progress; a merge moves it to Done', async () => {
  let status = { id: '1', name: 'To Do', statusCategory: { key: 'new' } };
  const child = { key: 'EDP-12', fields: { summary: 'Fix', issuetype: { name: 'Story' }, status, parent: { key: 'EDP-168' } } };
  const { floor, jira } = await connected({
    'GET /rest/api/3/issue/EDP-168': () => EPIC,
    'GET /rest/api/3/issue/EDP-12': () => ({ ...child, fields: { ...child.fields, status } }),
    'GET /rest/api/3/issue/EDP-12/transitions': () => ({
      transitions: EDP_TRANSITIONS.filter((t) => t.to !== status.name).map((t) => ({ id: t.id, name: t.name, to: { name: t.to, statusCategory: { key: t.toCategory } } })),
    }),
    'POST /rest/api/3/issue/EDP-12/transitions': (c) => {
      const t = EDP_TRANSITIONS.find((x) => x.id === c.body.transition.id)!;
      status = { id: t.id, name: t.to, statusCategory: { key: t.toCategory } };
      return undefined;
    },
    'PUT /rest/api/3/issue/EDP-12/assignee': () => undefined,
    'POST /rest/api/3/issue/EDP-12/comment': (c) => ({ id: '9', author: { displayName: 'Office Bot' }, body: c.body.body, created: '2026-09-28T00:00:00Z' }),
    'GET /rest/agile/1.0/board': () => ({ values: [{ id: 7, name: 'B' }], isLast: true }),
    'GET /rest/agile/1.0/board/7/configuration': () => CONFIG,
    'POST /rest/api/3/search/jql': () => ({ issues: [{ ...child, fields: { ...child.fields, status } }], isLast: true }),
  });
  await floor.setEpic('EDP-168', undefined, 'Ada');
  await floor.refresh(true);
  assert.equal(await floor.claim('EDP-12'), undefined);
  assert.deepEqual(jira.calls.find((c) => c.method === 'PUT')?.body, { accountId: 'acc-1' });
  assert.equal(status.name, 'In Progress');
  // Handed out again while it's in review, it stays in review.
  status = { id: '41', name: 'In Review', statusCategory: { key: 'indeterminate' } };
  const moves = jira.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/transitions')).length;
  assert.equal(await floor.claim('EDP-12'), undefined);
  assert.equal(status.name, 'In Review');
  assert.equal(jira.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/transitions')).length, moves);
  const pr = { number: 3, url: 'https://github.com/o/r/pull/3', title: 'EDP-12: Fix' };
  assert.equal(await floor.finish('EDP-12', pr), undefined);
  assert.equal(status.name, 'Done');
  const comment = jira.calls.filter((c) => c.url.endsWith('/comment') && c.method === 'POST');
  assert.equal(comment.length, 1);
  assert.match(JSON.stringify(comment[0].body), /pull\/3/);
  // The same merge seen again doesn't comment twice.
  assert.equal(await floor.finish('EDP-12', pr), undefined);
  assert.equal(jira.calls.filter((c) => c.url.endsWith('/comment') && c.method === 'POST').length, 1);
});

test('a card comes from the search API shape', () => {
  assert.deepEqual(ticketOf(SITE, { key: 'EDP-1', fields: {} }), { key: 'EDP-1', summary: '', type: '', priority: '', assignee: undefined, status: '', statusId: '', category: 'indeterminate', url: `${SITE}/browse/EDP-1`, updated: '' });
});

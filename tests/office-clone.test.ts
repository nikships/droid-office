import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FloorLinear, LinearOffice } from '../src/server/linear.js';
import type { GhPull } from '../src/shared/protocol.js';

const script = fileURLToPath(new URL('../.agents/skills/office-clone/scripts/clone-office.sh', import.meta.url));
const TEST_LINEAR_KEY = `lin_api_${'unitTestOnly'.repeat(3)}`;

test('an office clone keeps Orchestrator settings but never copies its live session or credentials', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'office-clone-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const office = path.join(root, 'office');
  const state = path.join(office, '.droid-office');
  const session = path.join(state, 'orchestrator', '.droid-office');
  const dest = path.join(root, 'clone');
  mkdirSync(home);
  mkdirSync(session, { recursive: true });
  writeFileSync(path.join(state, 'floors.json'), JSON.stringify([{ id: 'home', name: 'Home', dir: home }]));
  const settings = { on: true, model: 'claude-haiku-5-5' };
  writeFileSync(path.join(state, 'orchestrator.json'), JSON.stringify(settings));
  for (const file of ['workers.json', 'droid-hooks.json', 'hook.cjs', 'pty.sock']) writeFileSync(path.join(session, file), 'session must not copy');
  writeFileSync(path.join(state, 'remote-workers.json'), 'remote credentials must not copy');
  // The script runs the built CLI from dist/, whose original source is covered by the source-level suites.
  execFileSync('bash', [script, '--office', office, '--dest', dest, '--port', '4699'], { env: { ...process.env, HOME: home, NODE_V8_COVERAGE: '' }, timeout: 30_000, stdio: 'pipe' });
  const copied = path.join(dest, 'office', '.droid-office');
  assert.deepEqual(JSON.parse(readFileSync(path.join(copied, 'orchestrator.json'), 'utf8')), settings);
  assert.equal(existsSync(path.join(copied, 'orchestrator')), false);
  assert.equal(existsSync(path.join(copied, 'remote-workers.json')), false);
  assert.match(readFileSync(path.join(dest, 'start.sh'), 'utf8'), /export HOME=/);
});

test('an office clone keeps Linear team and project setup while disabling autopilot and clearing links', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'office-clone-linear-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const office = path.join(root, 'office');
  const remote = path.join(root, 'origin.git');
  const proj = path.join(root, 'proj');
  const broken = path.join(root, 'broken');
  const dest = path.join(root, 'clone');
  mkdirSync(path.join(home, '.droid-office'), { recursive: true });
  mkdirSync(path.join(office, '.droid-office'), { recursive: true });
  mkdirSync(path.join(proj, '.droid-office'), { recursive: true });
  mkdirSync(path.join(broken, '.droid-office'), { recursive: true });

  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['init', '-q', '-b', 'main', proj]);
  execFileSync('git', ['-C', proj, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', proj, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', proj, 'config', 'commit.gpgsign', 'false']);
  writeFileSync(path.join(proj, 'README.md'), 'hi\n');
  execFileSync('git', ['-C', proj, 'add', 'README.md']);
  execFileSync('git', ['-C', proj, 'commit', '-q', '-m', 'init']);
  execFileSync('git', ['-C', proj, 'remote', 'add', 'origin', remote]);
  execFileSync('git', ['-C', proj, 'push', '-q', '-u', 'origin', 'HEAD']);

  writeFileSync(
    path.join(office, '.droid-office', 'floors.json'),
    JSON.stringify([
      { id: 'home', name: 'Home', dir: home },
      { id: 'proj', name: 'proj', dir: proj },
      { id: 'broken', name: 'broken', dir: broken },
    ]),
  );
  writeFileSync(
    path.join(office, '.droid-office', 'linear.json'),
    JSON.stringify({
      key: TEST_LINEAR_KEY,
      viewerId: 'viewer',
      workspace: 'Foundry',
      urlKey: 'foundry-nik',
      name: 'Owner',
      email: 'owner@example.com',
      teams: [{ id: 'team', key: 'DOFF', name: 'droid-office', projects: [{ id: 'project', name: 'Droid Office' }] }],
      by: 'Owner',
      at: 1794545300000,
    }),
    { mode: 0o600 },
  );

  const sourceFloor = {
    setup: {
      team: { id: 'team', key: 'DOFF', name: 'droid-office' },
      project: { id: 'project', name: 'Droid Office' },
      by: 'Owner',
      at: 1794545321321,
    },
    autopilot: {
      on: true,
      pickup: ['triage', 'unstarted'],
      max: 3,
      existing: true,
      since: 1794545334176,
      model: 'gemini-4-carbon',
      by: 'Owner',
      at: 1794545360259,
    },
    links: [
      {
        issueId: '4d87531f-82ff-4709-a271-e91f32e9df4e',
        identifier: 'DOFF-924',
        title: 'Active started link with open PR',
        url: 'https://linear.app/foundry-nik/issue/DOFF-924/active',
        teamId: 'team',
        workerId: '0929deae693a',
        workerName: 'Nibble',
        auto: true,
        stage: 'started',
        at: 1794588772105,
        pr: { number: 442, url: 'https://github.com/example/repo/pull/442' },
      },
      {
        issueId: 'aa11bb22-82ff-4709-a271-e91f32e9df4e',
        identifier: 'DOFF-926',
        title: 'Active review link with merged PR',
        url: 'https://linear.app/foundry-nik/issue/DOFF-926/review',
        teamId: 'team',
        workerId: '112233445566',
        workerName: 'Byte',
        auto: true,
        stage: 'review',
        at: 1794589000000,
        pr: { number: 443, url: 'https://github.com/example/repo/pull/443' },
      },
      {
        issueId: '281ef321-1b48-433a-a808-af46e369193c',
        identifier: 'DOFF-925',
        title: 'Completed link',
        url: 'https://linear.app/foundry-nik/issue/DOFF-925/completed',
        teamId: 'team',
        workerId: 'a8d4db61a180',
        workerName: 'Widget',
        auto: true,
        stage: 'completed',
        at: 1794593992880,
        pr: { number: 441, url: 'https://github.com/example/repo/pull/441' },
      },
    ],
    skipped: { 'ea11f731-a2f9-49d0-af52-7a2bb5223c3a': 1794596000000 },
  };
  const projLinearFile = path.join(proj, '.droid-office', 'linear-floor.json');
  writeFileSync(projLinearFile, JSON.stringify(sourceFloor, null, 2), { mode: 0o600 });

  const homeFloor = {
    off: true,
    autopilot: { on: true, pickup: ['unstarted'], max: 2, existing: false, since: 1, by: 'Owner', at: 2 },
    links: [sourceFloor.links[0]],
  };
  writeFileSync(path.join(home, '.droid-office', 'linear-floor.json'), JSON.stringify(homeFloor), { mode: 0o600 });
  writeFileSync(path.join(broken, '.droid-office', 'linear-floor.json'), '{not valid json', { mode: 0o600 });

  const help = execFileSync('bash', [script, '--help'], { env: { ...process.env, NODE_V8_COVERAGE: '' }, encoding: 'utf8' });
  assert.match(help, /linear-floor\.json/);
  assert.doesNotMatch(help, /set -euo pipefail/);

  execFileSync('bash', [script, '--office', office, '--dest', dest, '--port', '4698'], { env: { ...process.env, HOME: home, NODE_V8_COVERAGE: '' }, timeout: 30_000, stdio: 'pipe' });

  // Owner source state stays untouched.
  assert.deepEqual(JSON.parse(readFileSync(projLinearFile, 'utf8')), sourceFloor);

  // Cloned project floor keeps team/project setup and mode 0600, disables autopilot, and clears links/skipped.
  const clonedProjFile = path.join(dest, 'floors', 'proj', '.droid-office', 'linear-floor.json');
  assert.equal(statSync(clonedProjFile).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(clonedProjFile, 'utf8')), {
    setup: sourceFloor.setup,
    autopilot: { ...sourceFloor.autopilot, on: false },
    links: [],
    skipped: {},
  });

  // Home floor keeps off: true while disarming autopilot and links; corrupt JSON is removed cleanly.
  const clonedHomeFile = path.join(dest, 'home', '.droid-office', 'linear-floor.json');
  assert.equal(statSync(clonedHomeFile).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(clonedHomeFile, 'utf8')), {
    off: true,
    autopilot: { ...homeFloor.autopilot, on: false },
    links: [],
  });
  assert.equal(existsSync(path.join(dest, 'floors', 'broken', '.droid-office', 'linear-floor.json')), false);

  // Starting FloorLinear against the cloned state supports read-only board reads without autopilot hires or PR sync mutations.
  const mutations: string[] = [];
  const hires: string[] = [];
  const stubFetch: typeof fetch = async (_url, init) => {
    const { query } = JSON.parse(String(init?.body)) as { query: string };
    if (query.trimStart().startsWith('mutation')) {
      mutations.push(query);
      throw new Error(`unexpected Linear mutation in clone: ${query}`);
    }
    if (query.startsWith('query Teams')) {
      return Response.json({
        data: {
          teams: { nodes: [{ id: 'team', key: 'DOFF', name: 'droid-office', defaultIssueState: { type: 'unstarted' } }] },
          projects: { nodes: [{ id: 'project', name: 'Droid Office', state: 'started', teams: { nodes: [{ id: 'team' }] } }] },
        },
      });
    }
    if (query.startsWith('query Issues')) {
      return Response.json({
        data: {
          issues: {
            nodes: [
              {
                id: '2642e227-528a-4e6d-b2fd-5f31a6da7497',
                identifier: 'DOFF-900',
                title: 'Eligible Todo ticket for read-only board',
                url: 'https://linear.app/foundry-nik/issue/DOFF-900/eligible',
                priority: 1,
                priorityLabel: 'Urgent',
                estimate: null,
                sortOrder: 1,
                createdAt: '2026-11-13T00:00:00.000Z',
                updatedAt: '2026-11-13T00:00:00.000Z',
                state: { id: 'todo', name: 'Todo', type: 'unstarted', color: '#e2e2e2' },
                assignee: null,
                labels: { nodes: [] },
                project: { name: 'Droid Office' },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    }
    throw new Error(`unexpected query: ${query}`);
  };

  const clonedOffice = new LinearOffice(path.join(dest, 'office', '.droid-office'), stubFetch);
  const clonedFloor = new FloorLinear(path.join(dest, 'floors', 'proj', '.droid-office'), clonedOffice, undefined, {
    state() {},
    board() {},
    toast() {},
    async hire(_prompt, identifier) {
      hires.push(identifier);
      return { workerId: 'unexpected' };
    },
    workers: () => [],
    pullName: (n) => `PR #${n}`,
  });

  assert.equal(clonedFloor.piloted, false);
  assert.equal(clonedFloor.autopilot.on, false);
  await clonedFloor.refresh(true);
  assert.equal(clonedFloor.board?.team, 'DOFF');
  assert.equal(clonedFloor.board?.project, 'Droid Office');
  assert.equal(clonedFloor.board?.items.length, 1);
  assert.equal(clonedFloor.board?.items[0]?.identifier, 'DOFF-900');

  const pulls = [{ number: 442, url: 'https://github.com/example/repo/pull/442', state: 'OPEN' } as GhPull, { number: 443, url: 'https://github.com/example/repo/pull/443', state: 'MERGED' } as GhPull];
  await clonedFloor.sync(pulls);
  assert.deepEqual(hires, []);
  assert.deepEqual(mutations, []);
});

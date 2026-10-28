import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDroidCommandCatalogue, DROID_COMMANDS_TTL_MS, listDroidCommands, parseDroidCommands } from '../src/server/droid-commands.js';
import { askDroid, DROID_LIST } from '../src/server/droid-rpc.js';

function scratch(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'droid-office-droid-commands-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Trimmed from the owner's droid 0.251.0: `droid.list_commands` and `droid.list_skills` results.
const COMMANDS = {
  commands: [
    { name: 'delegate-review', description: 'Custom command: delegate-review', isExecutable: false },
    { name: 'review', description: 'Custom command: review', isExecutable: false },
  ],
};
const SKILLS = {
  skills: [
    { name: 'office-clone', description: 'Run a build of Droid Office against a copy of the owner’s real installed office', location: 'project', enabled: true, userInvocable: true },
    { name: 'agent-browser', description: 'Browser automation CLI for AI agents.\nUse when the user needs to interact with websites.', location: 'personal', enabled: true, userInvocable: true },
    { name: 'tuistory', description: 'Automates terminal user interface (TUI) testing.', location: 'builtin', enabled: true, userInvocable: false },
    { name: 'review', description: 'Review code changes and identify high-confidence, actionable bugs.', location: 'builtin', enabled: true, userInvocable: true },
    { name: 'off-skill', description: 'Turned off', location: 'personal', enabled: false, userInvocable: true },
    { name: 'has a space', description: 'bad', location: 'personal', enabled: true, userInvocable: true },
  ],
};

test('custom commands come first, then the skills a user can invoke, each name once', () => {
  assert.deepEqual(parseDroidCommands(COMMANDS, SKILLS), [
    { name: 'delegate-review', description: 'Custom command: delegate-review', source: 'command' },
    { name: 'review', description: 'Custom command: review', source: 'command' },
    { name: 'office-clone', description: 'Run a build of Droid Office against a copy of the owner’s real installed office', source: 'skill' },
    { name: 'agent-browser', description: 'Browser automation CLI for AI agents.', source: 'skill' },
  ]);
  assert.deepEqual(parseDroidCommands({ commands: [{ name: 'deploy', description: 'Ship it', argumentHint: '<env>' }] }, undefined), [{ name: 'deploy', description: 'Ship it', source: 'command', argumentHint: '<env>' }]);
  assert.deepEqual(parseDroidCommands(undefined, { skills: 'nope' }), []);
  assert.deepEqual(parseDroidCommands({ commands: [null, 3, { name: 5 }] }, null), []);
});

test('the catalogue asks droid once per folder while its answer is fresh, and is empty when droid fails', async () => {
  let clock = 1000;
  const asked: string[] = [];
  const catalogue = createDroidCommandCatalogue({
    command: () => '/usr/local/bin/droid',
    now: () => clock,
    lister: (command, cwd) => {
      asked.push(`${command} ${cwd}`);
      return cwd === '/broken' ? Promise.reject(new Error('no droid')) : Promise.resolve(parseDroidCommands(COMMANDS, undefined));
    },
  });
  const [a, b] = await Promise.all([catalogue.get('/repo'), catalogue.get('/repo')]);
  assert.equal(a.length, 2);
  assert.equal(b, a);
  await catalogue.get('/repo/.droid-office/worktrees/x');
  assert.deepEqual(asked, ['/usr/local/bin/droid /repo', '/usr/local/bin/droid /repo/.droid-office/worktrees/x']);
  clock += DROID_COMMANDS_TTL_MS + 1;
  await catalogue.get('/repo');
  assert.equal(asked.length, 3);
  catalogue.forget();
  await catalogue.get('/repo');
  assert.equal(asked.length, 4);
  assert.deepEqual(await catalogue.get('/broken'), []);
  assert.deepEqual(await catalogue.get('/broken'), []);
  assert.equal(asked.length, 6);
});

test('forget discards an in-flight result without replacing its newer request', async () => {
  const pending: Array<(value: ReturnType<typeof parseDroidCommands>) => void> = [];
  const catalogue = createDroidCommandCatalogue({ lister: () => new Promise((resolve) => pending.push(resolve)) });
  const old = catalogue.get('/repo');
  catalogue.forget();
  const current = catalogue.get('/repo');
  pending[0]([{ name: 'old', description: '', source: 'command' }]);
  await old;
  assert.equal(catalogue.get('/repo'), current);
  pending[1]([{ name: 'new', description: '', source: 'command' }]);
  await current;
  assert.equal((await catalogue.get('/repo'))[0].name, 'new');
});

test('SDK transport rejects excessive output and an early normal exit', { skip: process.platform === 'win32' }, async (t) => {
  const dir = scratch(t);
  const droid = path.join(dir, 'droid');
  writeFileSync(droid, '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o700 });
  await assert.rejects(askDroid(droid, dir, [DROID_LIST.commands], 5000), /exited without answering/);
  writeFileSync(droid, '#!/usr/bin/env node\nprocess.stdout.write("x".repeat(5 * 1024 * 1024));\nsetInterval(() => {}, 1000);\n', { mode: 0o700 });
  await assert.rejects(askDroid(droid, dir, [DROID_LIST.commands], 5000), /output exceeded/);
});

test('listDroidCommands asks droid in the worker’s folder over stream-jsonrpc, without a session', { skip: process.platform === 'win32' }, async (t) => {
  const dir = scratch(t);
  const droid = path.join(dir, 'droid');
  writeFileSync(
    droid,
    `#!/usr/bin/env node
const args = process.argv.slice(2).join(' ');
if (args !== 'exec --input-format stream-jsonrpc --output-format stream-jsonrpc') process.exit(2);
const envelope = { jsonrpc: '2.0', factoryApiVersion: '1.0.0', factoryProtocolVersion: '1.279.0' };
const answers = {
  'droid.list_commands': ${JSON.stringify(COMMANDS)},
  'droid.list_skills': ${JSON.stringify(SKILLS)},
};
let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
  const lines = input.split('\\n');
  input = lines.pop();
  for (const line of lines) {
    const req = JSON.parse(line);
    if (req.method === 'droid.initialize_session') process.exit(4);
    const out = process.cwd().endsWith('refused') ? { error: { code: -32601, message: 'nope' } } : { result: answers[req.method] };
    process.stdout.write(JSON.stringify({ ...envelope, type: 'response', id: req.id, ...out }) + '\\n');
  }
});
setInterval(() => {}, 1000);
`,
    { mode: 0o700 },
  );
  const names = (await listDroidCommands(droid, dir)).map((c) => `${c.source}:${c.name}`);
  assert.deepEqual(names, ['command:delegate-review', 'command:review', 'skill:office-clone', 'skill:agent-browser']);

  const refused = path.join(dir, 'refused');
  mkdirSync(refused);
  await assert.rejects(listDroidCommands(droid, refused), /refused to list its commands/);
});

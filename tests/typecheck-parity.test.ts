import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const bin = path.join(root, 'node_modules', '.bin');
const projects = ['tsconfig.server.json', 'tsconfig.client.json', 'tsconfig.desktop.json', 'tsconfig.desktop-page.json', 'website/tsconfig.json'];

function check(tool: 'bun' | 'tsc', project: string) {
  const args = tool === 'bun' ? ['check', '-p', project, '--no-pretty'] : ['-p', project, '--noEmit', '--pretty', 'false'];
  const env = { ...process.env };
  for (const key of ['AGENT', 'CLAUDECODE', 'REPL_ID']) delete env[key];
  const result = spawnSync(path.join(bin, tool), args, { cwd: root, env, encoding: 'utf8', timeout: 30_000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return { status: result.status, output: result.stdout + result.stderr };
}

test('Bun and TypeScript accept all five real projects', () => {
  for (const project of projects) {
    for (const tool of ['tsc', 'bun'] as const) {
      const result = check(tool, project);
      assert.equal(result.status, 0, `${tool}: ${project}\n${result.output}`);
    }
  }
});

test('Bun and TypeScript reject the same injected errors under every project config', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-typecheck-parity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  writeFileSync(
    path.join(dir, 'errors.ts'),
    [
      'export const wrong: number = "not a number";',
      'export const nullable: string = null;',
      'export const missing = unknownSymbol;',
      'export const imported = import("./missing.js");',
      'export function unused(parameter: string) { const local = 1; return 0; }',
    ].join('\n'),
  );
  for (const project of projects) {
    const config = path.join(dir, 'tsconfig.json');
    writeFileSync(config, JSON.stringify({ extends: path.join(root, project), compilerOptions: { rootDir: dir, noEmit: true }, files: ['errors.ts'], include: [], exclude: [] }));
    const results = (['tsc', 'bun'] as const).map((tool) => {
      const result = check(tool, config);
      assert.equal(result.status, 1, `${tool}: ${project}\n${result.output}`);
      return [...result.output.matchAll(/\berror (TS\d+):/g)].map((match) => match[1]).sort();
    });
    for (const code of ['TS2322', 'TS2304', 'TS2307']) assert.ok(results[0].includes(code), `${project}: expected ${code}`);
    assert.equal(results[0].filter((code) => code === 'TS2322').length, 2, `${project}: assignment and strict nullability`);
    if (project.startsWith('website/')) assert.equal(results[0].filter((code) => code === 'TS6133').length, 2, 'website unused locals and parameters');
    assert.deepEqual(results[1], results[0], project);
  }
});

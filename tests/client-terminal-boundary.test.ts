import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));

test('no terminal client, including the Android bundle entry, imports xterm', async () => {
  const imports: string[] = [];
  const client = join(root, 'src/client');
  for (const entry of await readdir(client, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.(?:[cm]?[jt]s|css)$/.test(entry.name)) continue;
    const path = join(entry.parentPath, entry.name);
    if (/(?:\bfrom\s*|\bimport(?:\s+type)?\s*\(?\s*|\brequire\s*\(\s*)['"]@xterm\//.test(await readFile(path, 'utf8'))) imports.push(relative(root, path));
  }
  assert.deepEqual(imports, []);
});

test('a bare adapter entry does not include desktop features or CSS', async () => {
  const result = await build({ entryPoints: [join(root, 'src/client/term-engine/wterm.ts')], bundle: true, write: false, metafile: true, external: ['@wterm/*'], logLevel: 'silent' });
  const files = Object.keys(result.metafile!.inputs);
  assert.ok(files.some((p) => p.endsWith('/wterm-core.ts')));
  assert.deepEqual(
    files.filter((p) => p.endsWith('.css') || /\/wterm-(?:runtime|keys|scroll|links|graphics)\.ts$/.test(p)),
    [],
  );
});

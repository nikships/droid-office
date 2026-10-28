import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildCompanionTools, COMPANION_TOOLS_DIR } from '../tools/android-companion-tools.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const committed = () =>
  readdirSync(COMPANION_TOOLS_DIR, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => path.relative(COMPANION_TOOLS_DIR, path.join(d.parentPath, d.name)).replaceAll('\\', '/'))
    .sort();

test("the Android management page is built from the office's own windows (node tools/android-companion-tools.mjs)", async (t) => {
  const out = mkdtempSync(path.join(os.tmpdir(), 'android-companion-tools-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const built = await buildCompanionTools(out);
  for (const f of ['index.html', 'tools.css', 'tools.js']) assert.ok(built.includes(f), `${f} is missing from the build`);
  assert.deepEqual(committed(), built, 'android/app/src/main/assets/companion-tools differs: run node tools/android-companion-tools.mjs');
  for (const f of built) assert.ok(readFileSync(path.join(out, f)).equals(readFileSync(path.join(COMPANION_TOOLS_DIR, f))), `${f} is stale: run node tools/android-companion-tools.mjs`);
});

test('the Android management page loads nothing from the network but through the app', () => {
  const html = readFileSync(path.join(COMPANION_TOOLS_DIR, 'index.html'), 'utf8');
  assert.match(html, /src="\.\/tools\.js"/);
  assert.match(html, /href="\.\/tools\.css"/);
  assert.doesNotMatch(html, /https?:\/\//);
  const css = readFileSync(path.join(COMPANION_TOOLS_DIR, 'tools.css'), 'utf8');
  // Fonts are the office's own, served by the app's passthrough, never a web font service.
  assert.doesNotMatch(css, /url\(\s*['"]?https?:/);
});

/** `import type …`, or braces of nothing but `type` names: erased by the build, so nothing is loaded. */
function typeOnly(statement: string): boolean {
  if (/^(?:import|export)\s+type\s/.test(statement)) return true;
  const names = /^(?:import|export)\s*\{([^}]*)\}\s*from/.exec(statement)?.[1];
  return !!names && names.split(',').every((n) => !n.trim() || /^type\s/.test(n.trim()));
}

/** Every module the page can load, statically or lazily, following relative value imports from its entry. */
function importGraph(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const todo = [entry];
  const spec = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s*['"]([^'"]+)['"]/g;
  while (todo.length) {
    const file = todo.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const source = readFileSync(file, 'utf8');
    for (const m of source.matchAll(spec)) {
      const s = m[1] ?? m[2] ?? m[3];
      if (!s || typeOnly(m[0])) continue;
      if (!s.startsWith('.')) {
        packages.add(s);
        continue;
      }
      if (s.endsWith('.css')) continue;
      const base = path.resolve(path.dirname(file), s.replace(/\.js$/, ''));
      // A .d.ts module is types only: nothing of it is bundled.
      if (existsSync(`${base}.d.ts`)) continue;
      const found = [`${base}.ts`, path.join(base, 'index.ts')].find((p) => existsSync(p));
      assert.ok(found, `${path.relative(root, file)} imports ${s}, which is not a .ts module`);
      todo.push(found);
    }
  }
  return { files, packages };
}

test('the management page never loads three.js or the 3D office', () => {
  const { files, packages } = importGraph(path.join(root, 'src/client/companion-tools-host.ts'));
  const loaded = [...files].map((f) => path.relative(root, f).replaceAll('\\', '/'));
  // A few windows share plain helpers that live under world/ (machine load colours, the DroidProxy
  // glyph); the scene, its meshes and the first-person page never come along.
  for (const f of ['src/client/main.ts', 'src/client/world/office.ts', 'src/client/world/character.ts', 'src/client/office-map.ts']) assert.ok(!loaded.includes(f), `the management page loads ${f}`);
  assert.deepEqual(
    [...packages].filter((p) => p === 'three' || p.startsWith('three/')),
    [],
  );
  assert.ok(files.has(path.join(root, 'src/client/companion-tools.ts')));
  const js = readFileSync(path.join(COMPANION_TOOLS_DIR, 'tools.js'), 'utf8');
  assert.doesNotMatch(js, /WebGLRenderer|PerspectiveCamera/);
});

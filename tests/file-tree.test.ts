import test from 'node:test';
import assert from 'node:assert/strict';
import { fileIcon, folderIcon } from '../src/client/ui/file-icons.js';
import { filterDocs, shelfOrder } from '../src/client/ui/file-tree.js';

const f = (path: string, title?: string) => ({ path, size: 1, mtime: 1, ...(title ? { title } : {}) });

test('each file gets the icon its name, then its extension, says', () => {
  const icon = (p: string) => {
    const i = fileIcon(p);
    return i.label ? `${i.shape}:${i.label}` : i.shape;
  };
  assert.equal(icon('src/server/docs.ts'), 'badge:TS');
  assert.equal(icon('src/client/App.tsx'), 'badge:TSX');
  assert.equal(icon('bin/droid-office.js'), 'badge:JS');
  assert.equal(icon('tests/docs.test.ts'), 'badge:TS');
  assert.notEqual(fileIcon('tests/docs.test.ts').color, fileIcon('src/docs.ts').color);
  assert.equal(icon('tsconfig.json'), 'cog');
  assert.equal(icon('data/config.json'), 'braces');
  assert.equal(icon('package.json'), 'badge:NPM');
  assert.equal(icon('package-lock.json'), 'lock');
  assert.equal(icon('README.md'), 'info');
  assert.equal(icon('docs/guide.md'), 'page:M');
  assert.equal(icon('LICENSE'), 'page:©');
  assert.equal(icon('Dockerfile'), 'badge:DK');
  assert.equal(icon('deploy/Dockerfile.prod'), 'badge:DK');
  assert.equal(icon('.env.example'), 'badge:ENV');
  assert.equal(icon('.gitignore'), 'badge:GIT');
  assert.equal(icon('.prettierrc'), 'cog');
  assert.equal(icon('.somethingrc'), 'cog');
  assert.equal(icon('scripts/run.sh'), 'badge:$_');
  assert.equal(icon('.github/workflows/release.yml'), 'badge:YML');
  assert.equal(icon('android/app/Main.kt'), 'badge:K');
  assert.equal(icon('notes'), 'page');
  assert.equal(icon('weird.unknownext'), 'page');
});

test('folders named for what they hold get their own color, and the last part of a chain counts', () => {
  assert.equal(folderIcon('tests').shape, 'folder');
  assert.equal(folderIcon('tests').color, folderIcon('__tests__').color);
  assert.equal(folderIcon('src/client').color, folderIcon('client').color);
  assert.notEqual(folderIcon('src').color, folderIcon('somewhere').color);
  assert.equal(folderIcon('somewhere').color, folderIcon('elsewhere').color);
});

test('go to file ranks the name over the title over the path, and every word must match', () => {
  const files = [f('docs/guide.md', 'Guide'), f('docs/getting-started.md', 'Getting started'), f('src/client/ui/file-tree.ts'), f('src/shared/docs.ts'), f('README.md', 'Droid Office')];
  const paths = (q: string) => filterDocs(files, q).map((h) => h.doc.path);
  // Letters in order, as with gs for getting-started.
  assert.deepEqual(paths('gs'), ['docs/getting-started.md']);
  assert.equal(paths('docs')[0], 'src/shared/docs.ts');
  assert.deepEqual(paths('tree ui'), ['src/client/ui/file-tree.ts']);
  assert.deepEqual(paths('office'), ['README.md']);
  assert.deepEqual(paths('zzz'), []);
  const hit = filterDocs(files, 'tree')[0];
  const start = 'src/client/ui/file-'.length;
  assert.deepEqual([...hit.path], [start, start + 1, start + 2, start + 3]);
  // No query: the shelf order, the project's README first.
  assert.deepEqual(
    paths(''),
    shelfOrder(files).map((x) => x.path),
  );
  assert.equal(shelfOrder(files)[0]?.path, 'README.md');
});

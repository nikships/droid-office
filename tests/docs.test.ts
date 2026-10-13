import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Docs, docTitle } from '../src/server/docs.js';
import { buildDocTree, flattenDocTree, isBinaryBuffer, isDocPath, isEditablePath, isSafeProjectPath, resolveDocLink } from '../src/shared/docs.js';

/** A folder with some Markdown in it, and whatever `git` makes of it. */
function fixture(t: { after(fn: () => void): void }, git: boolean) {
  const root = mkdtempSync(path.join(tmpdir(), 'office-docs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'proj');
  const put = (file: string, text: string) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  };
  put('README.md', '# Droid Office\n\nHello.\n');
  put('docs/setup.markdown', '---\ntitle: "Getting set up"\n---\n\n# Not this one\n');
  put('docs/API.MD', 'Some intro\n\nThe API\n=======\n');
  put('src/index.ts', 'export {};\n');
  put('node_modules/dep/README.md', '# a dependency\n');
  put('.droid-office/notes.md', '# office notes\n');
  put('ignored/secret.md', '# ignored\n');
  put('pic.png', 'not really a png');
  writeFileSync(path.join(root, 'outside.md'), '# outside\n');
  if (git) {
    const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    g('init', '-q', '-b', 'main');
    put('.gitignore', 'node_modules\nignored\n.droid-office/\n');
    g('add', 'README.md', 'docs', 'src', '.gitignore');
    g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
    // New and not ignored: still the project's.
    put('NOTES.md', 'no heading here\n');
  }
  return { root, dir, docs: new Docs(dir) };
}

test('the shelf is every Markdown file git counts as the project, with its title', async (t) => {
  const { docs } = fixture(t, true);
  const { files, more } = await docs.list();
  assert.equal(more, false);
  assert.deepEqual(
    files.map((f) => [f.path, f.title]),
    [
      ['docs/API.MD', 'The API'],
      ['docs/setup.markdown', 'Getting set up'],
      ['NOTES.md', undefined],
      ['README.md', 'Droid Office'],
    ],
  );
  assert.ok(files.every((f) => f.size > 0 && f.mtime > 0));
});

test('without git, the shelf walks the folder, skipping hidden and dependency folders', async (t) => {
  const { docs } = fixture(t, false);
  const { files } = await docs.list();
  assert.deepEqual(files.map((f) => f.path).sort(), ['docs/API.MD', 'docs/setup.markdown', 'ignored/secret.md', 'README.md'].sort());
  const all = await docs.list(true);
  assert.ok(all.files.some((f) => f.path === 'src/index.ts'));
});

test('only editable text files inside the project can be read, not binaries, .. or a link out of it', async (t) => {
  const { root, dir, docs } = fixture(t, true);
  const ok = await docs.read('docs/setup.markdown');
  assert.ok('text' in ok && ok.text.includes('Getting set up') && ok.mtime > 0);
  const code = await docs.read('src/index.ts');
  assert.ok('text' in code && code.text.includes('export {}'));
  writeFileSync(path.join(dir, 'binary.txt'), Buffer.from([0x68, 0x69, 0x00, 0x78]));
  for (const bad of ['pic.png', 'binary.txt', '../outside.md', path.join(root, 'outside.md'), 'missing.md', 'docs']) {
    const r = await docs.read(bad);
    assert.ok('error' in r, bad);
  }
  symlinkSync(root, path.join(dir, 'up'), 'junction');
  const r = await docs.read('up/outside.md');
  assert.ok('error' in r && r.status === 404);
  // Pictures the docs show: only pictures, only from the project.
  const pic = await docs.picture('pic.png');
  assert.ok('body' in pic && pic.type === 'image/png');
  assert.ok('error' in (await docs.picture('README.md')));
  assert.ok('error' in (await docs.picture('up/outside.md')));
});

test('all-files mode lists every non-binary project file and skips binary extensions', async (t) => {
  const { docs } = fixture(t, true);
  const { files } = await docs.list(true);
  const paths = files.map((f) => f.path);
  assert.ok(paths.includes('src/index.ts'));
  assert.ok(paths.includes('README.md'));
  assert.ok(paths.includes('.gitignore'));
  assert.ok(!paths.includes('pic.png'));
  assert.ok(!paths.includes('node_modules/dep/README.md'));
});

test('writing saves atomically, detects mtime conflicts with 409, and refuses unsafe paths', async (t) => {
  const { root, dir, docs } = fixture(t, true);
  const initial = await docs.read('README.md');
  assert.ok('text' in initial);

  const saved = await docs.write('README.md', '# Updated Title\n\nNew body.\n', initial.mtime);
  assert.ok('mtime' in saved && saved.size > 0);

  const reread = await docs.read('README.md');
  assert.ok('text' in reread && reread.text === '# Updated Title\n\nNew body.\n');

  // Stale baseMtime must fail with 409 conflict
  const conflict = await docs.write('README.md', '# Overwrite attempt\n', initial.mtime - 5000);
  assert.ok('error' in conflict && conflict.status === 409);

  // Force save without baseMtime succeeds
  const forced = await docs.write('README.md', '# Force saved\n');
  assert.ok('mtime' in forced);

  // Refuses binary text (NUL byte), binary extensions, traversal, missing files, symlinks outside
  assert.ok('error' in (await docs.write('README.md', 'bad\0text')));
  assert.ok('error' in (await docs.write('pic.png', 'nope')));
  assert.ok('error' in (await docs.write('../outside.md', 'nope')));
  assert.ok('error' in (await docs.write('missing.md', 'nope')));
  assert.ok('error' in (await docs.write('docs', 'nope')));
  symlinkSync(path.join(root, 'outside.md'), path.join(dir, 'escape.md'));
  assert.ok('error' in (await docs.write('escape.md', 'nope')));
});

test('searching across files returns matching lines and respects the scope flag', async (t) => {
  const { docs } = fixture(t, true);
  const empty = await docs.search('   ');
  assert.deepEqual(empty, { query: '', hits: [], more: false });

  const mdHits = await docs.search('export', false);
  assert.equal(mdHits.hits.length, 0);

  const allHits = await docs.search('export', true);
  assert.equal(allHits.hits.length, 1);
  assert.equal(allHits.hits[0]?.path, 'src/index.ts');
  assert.equal(allHits.hits[0]?.matches[0]?.line, 1);
  assert.ok(allHits.hits[0]?.matches[0]?.text.includes('export'));
});

test('shared tree and path helpers group folders and validate editable paths', () => {
  assert.ok(isSafeProjectPath('src/client/ui/bookshelf.ts'));
  assert.ok(!isSafeProjectPath('') && !isSafeProjectPath('../a.ts') && !isSafeProjectPath('/abs.ts'));
  assert.ok(isEditablePath('src/index.ts') && isEditablePath('README.md') && isEditablePath('Dockerfile'));
  assert.ok(!isEditablePath('pic.png') && !isEditablePath('font.woff2') && !isEditablePath('../bad.ts'));
  assert.ok(!isBinaryBuffer(Buffer.from('hello world\n')));
  assert.ok(isBinaryBuffer(Buffer.from([0x61, 0x00, 0x62])));

  const tree = buildDocTree([
    { path: 'README.md', title: 'Readme', size: 10, mtime: 1 },
    { path: 'docs/guide.md', title: 'Guide', size: 20, mtime: 1 },
    { path: 'docs/api/auth.md', title: 'Auth', size: 15, mtime: 1 },
    { path: 'src/client/ui/bookshelf.ts', size: 30, mtime: 1 },
  ]);
  assert.equal(tree.files.length, 1);
  assert.equal(tree.dirs.length, 2);
  assert.equal(tree.dirs[0]?.name, 'docs');
  assert.equal(tree.dirs[1]?.name, 'src/client/ui');
  assert.deepEqual(
    flattenDocTree(tree, new Set()).map((f) => f.path),
    ['docs/api/auth.md', 'docs/guide.md', 'src/client/ui/bookshelf.ts', 'README.md'],
  );
  assert.deepEqual(
    flattenDocTree(tree, new Set(['docs'])).map((f) => f.path),
    ['src/client/ui/bookshelf.ts', 'README.md'],
  );
});

test('a doc is titled by its front matter, else its first heading, whatever the style', () => {
  assert.equal(docTitle('# Hello *world*\n'), 'Hello world');
  assert.equal(docTitle('<p align="center"><img src="x.png"></p>\n<h1 align="center">Office</h1>\n'), 'Office');
  assert.equal(docTitle('```\n# not a heading\n```\n## Real one ##\n'), 'Real one');
  assert.equal(docTitle('Setext\n---\n'), 'Setext');
  assert.equal(docTitle('- a list item\n---\n'), undefined);
  assert.equal(docTitle('## [Linked](http://x) `code`\n'), 'Linked code');
  assert.equal(docTitle('just words\n'), undefined);
});

test('links in a doc resolve to paths in the project, and nowhere else', () => {
  assert.deepEqual(resolveDocLink('docs/a.md', '../README.md#setup'), { path: 'README.md', hash: 'setup' });
  assert.deepEqual(resolveDocLink('docs/a.md', './b.md'), { path: 'docs/b.md', hash: '' });
  assert.deepEqual(resolveDocLink('docs/a.md', '#usage'), { path: 'docs/a.md', hash: 'usage' });
  assert.deepEqual(resolveDocLink('docs/a.md', '/src/x%20y.ts?plain=1'), { path: 'src/x y.ts', hash: '' });
  for (const href of ['https://example.com/a.md', '//cdn/x.png', 'mailto:a@b.c', '../../etc/passwd', '..', '%E0%A4%A']) assert.equal(resolveDocLink('docs/a.md', href), undefined, href);
  assert.ok(isDocPath('a/b.MD') && isDocPath('x.markdown'));
  assert.ok(!isDocPath('a.mdx') && !isDocPath('../a.md') && !isDocPath('a/./b.md') && !isDocPath('md'));
});

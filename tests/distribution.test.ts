import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (file: string) => readFileSync(new URL(file, root), 'utf8');

test('production distribution has no standalone installers or npm publication', () => {
  for (const script of ['install.sh', 'install.ps1']) assert.equal(existsSync(new URL(script, root)), false, script);
  assert.equal(JSON.parse(read('package.json')).private, true);
});

test('releases retain Mac app packaging and checkout startup checks, but no server tarball', () => {
  const workflow = read('.github/workflows/release.yml');
  assert.doesNotMatch(workflow, /install\.sh|install\.ps1|npm pack|npm-shrinkwrap|droid-office\.tgz|name: tarball|DROID_OFFICE_INSTALL_/);
  assert.match(workflow, /node "\$GITHUB_WORKSPACE\/bin\/droid-office\.js" --host 127\.0\.0\.1/);
  assert.match(workflow, /name: Start the office on the app's own Electron/);
  assert.match(workflow, /name: Build, sign and notarize the app/);
  assert.match(workflow, /release\/\*\.dmg/);
  assert.match(workflow, /release\/\*\.zip/);
  assert.match(workflow, /release\/latest-mac\.yml/);
});

test('installation guidance points to the Mac release and keeps source development available', () => {
  for (const file of ['README.md', 'docs/guide/getting-started.md']) {
    const text = read(file);
    assert.match(text, /only supported production install/);
    assert.match(text, /Droid-Office-<version>-arm64\.dmg/);
    assert.match(text, /git clone https:\/\/github\.com\/nikships\/droid-office\.git/);
    assert.match(text, /npm ci/);
    assert.doesNotMatch(text, /install\.sh|install\.ps1|npm install -g/);
  }
  assert.doesNotMatch(read('.agents/skills/office-video-capture/references/example-launch/example-composition.html'), /install\.sh|install\.ps1/);
});

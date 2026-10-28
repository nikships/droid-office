import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('React Native tooling and its local bundle stay out of the Electron payload', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const name of ['react', 'react-native', '@react-native/gradle-plugin', '@react-native/metro-config']) {
    assert.ok(pkg.devDependencies[name], `${name} is development tooling`);
    assert.equal(pkg.dependencies[name], undefined, `${name} must not be a desktop runtime dependency`);
  }
  assert.match(pkg.scripts['mobile:bundle'], /--bundle-output dist\/mobile\//);
  const packaging = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8');
  const files = packaging.split('\nfiles:\n')[1]?.split('\nextraFiles:')[0];
  assert.ok(files);
  assert.match(files, /- '!dist\/mobile\/\*\*\/\*'/);
});

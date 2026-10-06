import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname;

test('the release has only browser and server build targets', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.build, 'npm run build:client && npm run build:server');
  assert.deepEqual(pkg.files, ['bin', 'dist']);
  assert.doesNotMatch(JSON.stringify(pkg), /@iwsdk|bonjour|three-mesh-bvh|dev:runtime|build:android|test:vr|tools\/vr/);
  const workflow = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8');
  assert.doesNotMatch(workflow, /setup-java|setup-android|OFFICE_XR|\.apk|native\//);
});

test('removed clients, discovery, and emulator entry points cannot ship', () => {
  for (const file of [
    'native/android/app/build.gradle',
    'native/unity/Assets',
    'src/client/vr/session.ts',
    'src/client/native/scene.ts',
    'src/client/iwsdk-scripts',
    'src/client/public/xr-hands',
    'src/client/vr-preview.html',
    'src/server/discovery.ts',
    'src/shared/targets.ts',
    'tools/vr.mjs',
  ])
    assert.equal(existsSync(join(ROOT, file)), false, file);
});

test('browser sources do not start XR sessions or export a headset scene', () => {
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const file = join(dir, entry.name);
      return entry.isDirectory() ? (entry.name === 'public' ? [] : sources(file)) : entry.name.endsWith('.ts') ? [file] : [];
    });
  for (const file of sources(join(ROOT, 'src/client'))) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /navigator\.xr|renderer\.xr|NativeScene|NativeHost|headsetActive|headsetControls|native-xr|__vrtest|VrSession/, file);
  }
});

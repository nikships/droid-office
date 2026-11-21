import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const client = new URL('../src/client/', import.meta.url);
const publicDir = new URL('public/', client);
const manifest = JSON.parse(readFileSync(new URL('manifest.webmanifest', publicDir), 'utf8'));
const companion = JSON.parse(readFileSync(new URL('dashboard.webmanifest', publicDir), 'utf8'));

function pngSize(src: string) {
  const png = readFileSync(new URL(src.replace(/^\//, ''), publicDir));
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.subarray(12, 16).toString(), 'IHDR');
  return `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`;
}

test('the office installs as a standalone app at the origin root', () => {
  assert.equal(manifest.name, 'Droid Office');
  assert.equal(manifest.short_name, 'Droid Office');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.background_color, '#020202');
  assert.equal(manifest.theme_color, '#020202');
});

test('the manifest supplies the favicon, both PNG sizes and a separate maskable icon', () => {
  assert.deepEqual(manifest.icons, [
    { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ]);
  assert.match(readFileSync(new URL('favicon.svg', publicDir), 'utf8'), /<svg\b/);
  for (const icon of manifest.icons) {
    if (icon.type === 'image/png') assert.equal(pngSize(icon.src), icon.sizes, icon.src);
  }
  assert.equal(pngSize('/icons/apple-touch-icon.png'), '180x180');
  const grokbot = readFileSync(new URL('icons/grokbot.webp', publicDir));
  assert.equal(grokbot.subarray(0, 4).toString(), 'RIFF');
  assert.equal(grokbot.subarray(8, 12).toString(), 'WEBP');
});

test('the companion installs separately and opens the dashboard without credentials or worker links', () => {
  assert.equal(companion.id, '/dashboard');
  assert.equal(companion.name, 'Droid Office Companion');
  assert.equal(companion.short_name, 'Companion');
  assert.equal(companion.start_url, '/dashboard');
  assert.equal(companion.scope, '/dashboard');
  assert.notEqual(companion.id, manifest.id ?? manifest.start_url);
  assert.equal(companion.display, 'standalone');
  assert.equal(companion.background_color, manifest.background_color);
  assert.equal(companion.theme_color, manifest.theme_color);
  assert.deepEqual(companion.icons, manifest.icons);
  for (const route of ['/dashboard', '/dashboard/', '/dashboard.html']) assert.ok(route.startsWith(companion.scope));
  for (const route of ['/', '/open/worker/example', '/api/mobile/hello']) assert.ok(!route.startsWith(companion.scope));
});

for (const [page, appManifest] of [
  ['index', '/manifest.webmanifest'],
  ['dashboard', '/dashboard.webmanifest'],
]) {
  test(`${page} advertises its own manifest, theme color and Apple icon`, () => {
    const head = readFileSync(new URL(`${page}.html`, client), 'utf8').split('</head>')[0];
    assert.ok(head.includes(`<link rel="manifest" href="${appManifest}" />`));
    assert.match(head, /<meta name="theme-color" content="#020202"\s*\/>/);
    assert.match(head, /<link rel="apple-touch-icon" href="\/icons\/apple-touch-icon\.png"\s*\/>/);
  });
}

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import signFinder, { validateFinderProfile } from '../build/signFinder.mjs';
import { companionNavigation, finderBridgeArgs, parseThreadLink, threadDashboardUrl } from '../src/desktop/finder-links.js';

const root = fileURLToPath(new URL('../', import.meta.url));

test('Finder thread links carry only a lead and a floor', () => {
  assert.deepEqual(parseThreadLink('droid-office://thread/lead-123?floor=floor_abc'), { lead: 'lead-123', floor: 'floor_abc' });
  assert.deepEqual(parseThreadLink('droid-office://thread/%6cead?floor=%66loor'), { lead: 'lead', floor: 'floor' });
  for (const raw of [
    '',
    'http://thread/lead?floor=floor',
    'droid-office://terminal/lead?floor=floor',
    'droid-office://thread/lead',
    'droid-office://thread/lead?floor=',
    'droid-office://thread/lead?floor=floor&url=https://evil.example',
    'droid-office://thread/lead?floor=a&floor=b',
    'droid-office://thread/lead?floor=floor#x',
    'droid-office://thread/a/../lead?floor=floor',
    'droid-office://thread/%2flead?floor=floor',
    'droid-office://thread/lead?floor=%00',
    'droid-office://thread/lead?floor=floor&',
    'droid-office://thread/lead?floor=floor\n',
    'droid-office://thread:123/lead?floor=floor',
    `droid-office://thread/${'x'.repeat(129)}?floor=floor`,
    `droid-office://thread/lead?floor=${'x'.repeat(2048)}`,
    'droid-office://thread/%ZZ?floor=floor',
  ])
    assert.equal(parseThreadLink(raw), undefined, raw);
  assert.equal(threadDashboardUrl('http://localhost:4600/', { lead: 'lead', floor: 'floor' }), 'http://localhost:4600/dashboard#worker=lead&floor=floor&view=thread');
});

test('only packaged non-isolated app-owned launches get a Finder bridge', () => {
  assert.deepEqual(finderBridgeArgs('/Applications/Droid Office.app/Contents/Resources/app', false, false), []);
  assert.deepEqual(finderBridgeArgs('/app', true, true), []);
  assert.deepEqual(finderBridgeArgs('/app', true, false), ['--finder-bridge', '/app/native/mac/build/DroidOfficeFinderBridge.app/Contents/MacOS/DroidOfficeFinderBridge']);
});

test('companion navigation cannot escape into files, custom schemes or other office endpoints', () => {
  const origin = 'http://localhost:4600/';
  for (const url of ['http://localhost:4600/dashboard', 'http://localhost:4600/dashboard#worker=lead']) assert.equal(companionNavigation(url, origin), 'allow');
  for (const url of ['https://example.com/', 'mailto:owner@example.com', 'http://example.com/']) assert.equal(companionNavigation(url, origin), 'external');
  for (const url of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'droid-office://thread/a?floor=b',
    'http://localhost:4600/',
    'http://localhost:4600/api/status',
    'http://localhost:4600/dashboard?d=token',
    'http://user:pass@localhost:4600/dashboard',
    'not a URL',
  ]) {
    assert.equal(companionNavigation(url, origin), 'deny', url);
  }
});

test('Finder Developer ID profile checks reject missing or unauthorized entitlements', () => {
  const id = 'com.nikships.droid-office.finder-sync';
  const profile = {
    TeamIdentifier: ['NW6B3R27LQ'],
    ExpirationDate: '2030-01-01T00:00:00Z',
    ProvisionsAllDevices: true,
    Entitlements: {
      'com.apple.application-identifier': `NW6B3R27LQ.${id}`,
      'com.apple.developer.team-identifier': 'NW6B3R27LQ',
      'keychain-access-groups': ['NW6B3R27LQ.group.com.nikships.droid-office'],
      'com.apple.security.application-groups': ['group.com.nikships.droid-office'],
    },
  };
  const now = Date.parse('2026-10-27');
  assert.doesNotThrow(() => validateFinderProfile(profile, id, now));
  assert.throws(() => validateFinderProfile({}, id, now));
  for (const change of [{ TeamIdentifier: ['OTHER'] }, { ExpirationDate: '2020-01-01' }, { ExpirationDate: 'invalid' }, { ProvisionsAllDevices: false }]) {
    assert.throws(() => validateFinderProfile({ ...profile, ...change }, id, now));
  }
  for (const change of [
    { 'keychain-access-groups': ['group.com.nikships.droid-office'] },
    { 'com.apple.security.application-groups': [] },
    { 'com.apple.application-identifier': 'NW6B3R27LQ.other' },
    { 'get-task-allow': true },
    { 'com.apple.security.get-task-allow': true },
    { 'com.apple.developer.team-identifier': 'OTHER' },
  ])
    assert.throws(() => validateFinderProfile({ ...profile, Entitlements: { ...profile.Entitlements, ...change } }, id, now));
});

test('unsigned packaging remains possible but signed packaging cannot omit profiles', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'finder-package-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const contents = path.join(dir, 'Droid Office.app/Contents');
  for (const relative of ['Resources/app/native/mac/build/DroidOfficeFinderBridge.app', 'PlugIns/DroidOfficeFinderSync.appex']) {
    mkdirSync(path.join(contents, relative, 'Contents'), { recursive: true });
    writeFileSync(path.join(contents, relative, 'Contents/Info.plist'), '<plist/>');
  }
  const context = {
    electronPlatformName: 'darwin',
    appOutDir: dir,
    packager: { projectDir: dir, appInfo: { productFilename: 'Droid Office' }, platformSpecificBuildOptions: { identity: null as string | null }, codeSigningInfo: { value: Promise.resolve({}) } },
  };
  await signFinder(context);
  context.packager.platformSpecificBuildOptions.identity = '-';
  await assert.rejects(signFinder(context), /not ad-hoc/);
  context.packager.platformSpecificBuildOptions.identity = 'Nikhil Anand (NW6B3R27LQ)';
  await assert.rejects(signFinder(context), /FinderBridge.provisionprofile/);
  await signFinder({ electronPlatformName: 'linux' });
});

test('packaging embeds FinderSync outside Resources and preserves native entitlements', () => {
  const config = readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
  assert.match(config, /to: PlugIns\/DroidOfficeFinderSync\.appex/);
  assert.match(config, /afterPack: build\/signFinder\.mjs/);
  assert.match(config, /schemes: \[droid-office\]/);
  for (const name of ['FinderBridge', 'FinderSync']) {
    const entitlements = readFileSync(path.join(root, `build/${name}.entitlements.plist`), 'utf8');
    assert.match(entitlements, /NW6B3R27LQ\.group\.com\.nikships\.droid-office/);
    assert.match(entitlements, /com\.apple\.security\.app-sandbox/);
    assert.doesNotMatch(entitlements, /allow-jit|disable-library-validation/);
  }
  const source = readFileSync(path.join(root, 'native/mac/FinderCore.swift'), 'utf8');
  assert.doesNotMatch(source, /SecItemDelete/);
  assert.match(source, /token: previous\.token/);
  assert.match(source, /completionHandler\(nil\)/);
  assert.match(source, /realpath\(url\.path, nil\)/);
  assert.match(source, /retryDuplicate: false/);
  const menu = readFileSync(path.join(root, 'native/mac/FinderSync.swift'), 'utf8');
  assert.doesNotMatch(menu, /representedObject|currentItem|isEnabled = false/);
  assert.match(menu, /sender\.tag == 1/);
  const workflow = readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
  assert.match(workflow, /Final Finder signature lost its required entitlements/);
  assert.match(workflow, /codesign -d --entitlements/);
});

test('Swift policy checks compile and execute without Keychain or extension activation', { skip: process.platform !== 'darwin' }, (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'finder-swift-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const output = path.join(dir, 'policy-tests');
  execFileSync('xcrun', ['swiftc', '-swift-version', '5', '-parse-as-library', path.join(root, 'native/mac/FinderCore.swift'), path.join(root, 'native/mac/PolicyTests.swift'), '-o', output], { timeout: 60_000 });
  assert.match(execFileSync(output, [], { encoding: 'utf8', timeout: 10_000 }), /Finder policy checks passed/);
  const entitlements = path.join(dir, 'test-entitlements.plist');
  const signed = path.join(dir, 'signed-policy');
  copyFileSync(output, signed);
  writeFileSync(entitlements, '<?xml version="1.0"?><plist version="1.0"><dict><key>office.test-marker</key><true/></dict></plist>');
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--entitlements', entitlements, signed], { timeout: 10_000 });
  const xml = execFileSync('/usr/bin/codesign', ['-d', '--entitlements', '-', '--xml', signed], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 });
  const decoded = execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { input: xml, encoding: 'utf8' });
  assert.equal(JSON.parse(decoded)['office.test-marker'], true);
  assert.match(execFileSync(output, ['--signing-info', signed], { encoding: 'utf8', timeout: 10_000 }), /exposes entitlements without requirement flags/);
});

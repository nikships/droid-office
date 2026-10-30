import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import signFinder, { validateFinderProfile } from '../build/signFinder.mjs';
import { pickerModel } from '../src/client/ui/models.js';
import { MODEL_BRANDS, modelBrand } from '../src/client/ui/model-brand.js';
import { multiplierLabel, sectionsFor } from '../src/client/ui/model-search.js';
import { companionNavigation, finderBridgeArgs, parseThreadLink } from '../src/desktop/finder-links.js';
import { finderCatalogue } from '../src/server/finder.js';

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
});

test('a Finder thread goes to the app window that is open, or else the last mode used, never one of its own', () => {
  const main = readFileSync(path.join(root, 'src/desktop/main.ts'), 'utf8');
  assert.doesNotMatch(main, /new BrowserWindow|FinderThreads/);
  const receive = main.slice(main.indexOf('function receiveThread'), main.indexOf('function takePendingThread'));
  assert.match(receive, /openWorker\(worker\)/);
  assert.match(receive, /if \(!starting\) openWindow\(\)/);
  assert.match(main, /show\(officePage\(takePendingThread\(\)\)\)/);
  const finder = readFileSync(path.join(root, 'src/desktop/finder.ts'), 'utf8');
  assert.doesNotMatch(finder, /BrowserWindow/);
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
    if (name === 'FinderSync') assert.match(entitlements, /com\.apple\.security\.app-sandbox/);
    else assert.doesNotMatch(entitlements, /com\.apple\.security\.app-sandbox/);
    assert.doesNotMatch(entitlements, /allow-jit|disable-library-validation/);
  }
  const source = readFileSync(path.join(root, 'native/mac/FinderCore.swift'), 'utf8');
  assert.doesNotMatch(source, /SecItemDelete/);
  assert.match(source, /token: previous\.token/);
  assert.match(source, /completionHandler\(nil\)/);
  assert.match(source, /realpath\(url\.path, nil\)/);
  assert.match(source, /retryDuplicate: false/);
  const bridge = readFileSync(path.join(root, 'native/mac/Bridge.swift'), 'utf8');
  assert.match(bridge, /showExtensionManagementInterface\(\)\s*\n[^\n]*\n\s*RunLoop\.main\.run\(until:/);
  const build = readFileSync(path.join(root, 'native/mac/build.mjs'), 'utf8');
  assert.match(build, /CFBundleURLTypes[\s\S]*CFBundleURLSchemes[\s\S]*droid-office-finder/);
  assert.doesNotMatch(build, /CFBundleDocumentTypes/);
  const menu = readFileSync(path.join(root, 'native/mac/FinderSync.swift'), 'utf8');
  assert.doesNotMatch(menu, /representedObject|currentItem|isEnabled = false/);
  assert.match(menu, /sender\.tag == 1/);
  // Sandboxed callers cannot pass launch arguments or open inaccessible selections as documents.
  assert.match(menu, /FinderPolicy\.dispatchURL\(urls\)/);
  assert.match(menu, /\.open\(\[selection\], withApplicationAt: helper/);
  assert.doesNotMatch(menu, /configuration\.arguments/);
  assert.match(menu, /addsToRecentItems = false/);
  assert.match(menu, /createsNewApplicationInstance = true/);
  assert.doesNotMatch(menu, /\.open\(urls/);
  assert.match(bridge, /args\[1\] == "--dispatch"/);
  assert.match(bridge, /applicationShouldTerminateAfterLastWindowClosed/);
  assert.match(bridge, /show\(try FinderPolicy\.dispatchSelection\(url\), in: application\)/);
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

// Entries from the owner's Droid catalogue (GET /api/agents/droid/models), one or more per section, trimmed.
const CATALOGUE = [
  { id: 'custom:openrouter:kimi-k3.1-pro', displayName: 'OpenRouter: Kimi K3.1 Pro', custom: true as const, provider: 'anthropic' },
  { id: 'custom:droidproxy:gpt-6-astra', displayName: 'DroidProxy: GPT 6 Astra', custom: true as const, provider: 'openai' },
  { id: 'custom:droidproxy:gpt-6.1-sol', displayName: 'DroidProxy: GPT 6.1 Sol', custom: true as const, provider: 'openai' },
  { id: 'custom:droidproxy:ag-c55o-high', displayName: 'DroidProxy: Antigravity: Claude Opus 5.5 (High)', custom: true as const, provider: 'openai' },
  { id: 'custom:droidproxy:fable-5', displayName: 'custom:droidproxy:fable-5' },
  { id: 'custom:meta:muse-spark-1.3', displayName: 'custom:meta:muse-spark-1.3' },
  { id: 'auto', displayName: 'Auto Model', provider: 'factory', tokenMultiplier: 1 },
  { id: 'claude-fable-5.1', displayName: 'Fable 5.1', provider: 'anthropic', tokenMultiplier: 4 },
  { id: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', provider: 'openai', tokenMultiplier: 0.8 },
  { id: 'gemini-4-argon', displayName: 'Gemini 4 Argon', provider: 'google', tokenMultiplier: 0.8 },
  { id: 'inkling', displayName: 'Inkling', provider: 'factory', tokenMultiplier: 0.4 },
  { id: 'grok-4.7', displayName: 'Grok 4.7', provider: 'xai', tokenMultiplier: 0.8 },
  { id: 'deepseek-v4-flash-0731', displayName: 'DeepSeek V4 Flash 0731 [Deprecated]', legacy: true as const, provider: 'factory', tokenMultiplier: 0.176 },
  { id: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro [Deprecated]', legacy: true as const, provider: 'factory', tokenMultiplier: 0.528 },
];

test('the native model picker names, groups, brands, searches and prices models as the office picker does', { skip: process.platform !== 'darwin' }, (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'finder-models-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const output = path.join(dir, 'policy-tests');
  execFileSync('xcrun', ['swiftc', '-swift-version', '5', '-parse-as-library', path.join(root, 'native/mac/FinderCore.swift'), path.join(root, 'native/mac/PolicyTests.swift'), '-o', output], { timeout: 60_000 });
  const identities = [
    ...CATALOGUE.map((m) => ({ id: m.id, name: m.displayName, provider: m.provider })),
    ...['claude-opus-5-5', 'OPUS 5.5', 'gpt-5-codex', 'Antigravity: Gemini', 'deep-seek', 'Qwen3-Coder', 'chatglm', 'Codestral', 'Llama4', 'command-r-plus', 'Nemotron', 'Sonar Pro', 'gpt_6', 'o4-mini', 'megptastic'].map((name) => ({
      name,
    })),
    { provider: 'Z.ai' },
    { provider: 'DroidProxy' },
    { id: 'custom:zen:space-bunny-free', name: 'Space Alpha Bunny', provider: 'generic-chat-completion-api' },
  ];
  const queries = ['', 'opus', 'gpt sol', 'gpt61sol', 'yours', 'deepseek', 'nothing at all'];
  const multipliers = [0.176, 4, 1.6, 0.06, 0.528, 1];
  const input = { models: finderCatalogue({ models: CATALOGUE }, []).models, identities, queries, multipliers };
  const answer = JSON.parse(execFileSync(output, ['--models'], { input: JSON.stringify(input), encoding: 'utf8', timeout: 10_000 }));
  assert.deepEqual(answer.marks, Object.fromEntries(Object.entries(MODEL_BRANDS).map(([brand, m]) => [brand, { mono: 'mono' in m && m.mono, tile: 'tile' in m && m.tile }])));
  assert.deepEqual(
    answer.brands,
    identities.map((i) => modelBrand(i) ?? null),
  );
  const picked = CATALOGUE.map(pickerModel);
  assert.deepEqual(
    answer.entries,
    picked.map((m) => ({ id: m.id, name: m.name, group: m.group, cost: m.cost ?? null, brand: modelBrand(m) ?? null })),
  );
  assert.deepEqual(
    answer.sections,
    queries.map((query) => sectionsFor(picked, { query, scope: '', recents: [] }).map((s) => ({ label: s.label, ids: s.models.map((m) => m.id) }))),
  );
  assert.deepEqual(answer.multipliers, multipliers.map(multiplierLabel));
  const build = readFileSync(path.join(root, 'native/mac/build.mjs'), 'utf8');
  // The marks are the Android app's PNGs, which tests/model-brand.test.ts keeps in step with the web SVGs.
  assert.match(build, /android\/app\/src\/main\/assets\/model-icons/);
});

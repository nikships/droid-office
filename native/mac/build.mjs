import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const version = JSON.parse(readFileSync(path.join(root, '../../package.json'), 'utf8')).version;
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw new Error(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`);
}
function bundle(name, suffix, id, extension) {
  const contents = path.join(root, 'build', `${name}.${suffix}`, 'Contents');
  mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  const extra = extension
    ? '<key>NSExtension</key><dict><key>NSExtensionPointIdentifier</key><string>com.apple.FinderSync</string><key>NSExtensionPrincipalClass</key><string>FinderSync</string><key>NSExtensionAttributes</key><dict/></dict>'
    : '<key>LSUIElement</key><true/>';
  writeFileSync(
    path.join(contents, 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${id}</string>
<key>CFBundleName</key><string>${name}</string>
<key>CFBundleDisplayName</key><string>Droid Office Finder</string>
<key>CFBundleExecutable</key><string>${name}</string>
<key>CFBundlePackageType</key><string>${extension ? 'XPC!' : 'APPL'}</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
${extra}</dict></plist>
`,
  );
  return path.join(contents, 'MacOS', name);
}
const shared = ['-swift-version', '5', '-target', 'arm64-apple-macos14.0', '-O', '-parse-as-library', path.join(root, 'FinderCore.swift')];
run('xcrun', ['swiftc', ...shared, path.join(root, 'Bridge.swift'), path.join(root, 'DispatchPrompt.swift'), '-o', bundle('DroidOfficeFinderBridge', 'app', 'com.nikships.droid-office.finder-bridge', false)]);
run('xcrun', [
  'swiftc',
  ...shared,
  '-application-extension',
  '-module-name',
  'DroidOfficeFinderSync',
  path.join(root, 'FinderSync.swift'),
  '-Xlinker',
  '-e',
  '-Xlinker',
  '_NSExtensionMain',
  '-o',
  bundle('DroidOfficeFinderSync', 'appex', 'com.nikships.droid-office.finder-sync', true),
]);
console.log('native: built Finder bridge and FinderSync extension (not installed or enabled)');

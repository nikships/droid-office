import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const TEAM = 'NW6B3R27LQ';
const GROUP = 'group.com.nikships.droid-office';

/** Restricted Keychain access must be authorized by a current Developer ID profile, not an ad-hoc signature. */
export function validateFinderProfile(profile, bundleId, now = Date.now()) {
  const entitlements = profile.Entitlements ?? {};
  const appId = entitlements['com.apple.application-identifier'] ?? entitlements['application-identifier'];
  const groups = entitlements['keychain-access-groups'];
  const allowed = Array.isArray(groups) && groups.some((group) => group === `${TEAM}.${GROUP}` || group === `${TEAM}.*`);
  if (
    !profile.TeamIdentifier?.includes(TEAM) ||
    appId !== `${TEAM}.${bundleId}` ||
    entitlements['com.apple.developer.team-identifier'] !== TEAM ||
    !allowed ||
    !entitlements['com.apple.security.application-groups']?.includes(GROUP) ||
    !Number.isFinite(Date.parse(profile.ExpirationDate)) ||
    Date.parse(profile.ExpirationDate) <= now ||
    profile.ProvisionsAllDevices !== true ||
    entitlements['get-task-allow'] === true ||
    entitlements['com.apple.security.get-task-allow'] === true
  ) {
    throw new Error(`Finder signing: invalid Developer ID profile for ${bundleId}; check team, app ID, shared groups, expiry and distribution.`);
  }
}

export default async function signFinder(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const root = context.packager.projectDir;
  const contents = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents');
  const targets = [
    { name: 'FinderBridge', id: 'com.nikships.droid-office.finder-bridge', bundle: path.join(contents, 'Resources/app/native/mac/build/DroidOfficeFinderBridge.app') },
    { name: 'FinderSync', id: 'com.nikships.droid-office.finder-sync', bundle: path.join(contents, 'PlugIns/DroidOfficeFinderSync.appex') },
  ];
  for (const target of targets) {
    if (!existsSync(path.join(target.bundle, 'Contents/Info.plist'))) throw new Error(`Finder signing: missing ${target.name} bundle.`);
  }
  // Explicit unsigned packaging is for CI PRs only. It never publishes Keychain credentials or enables Finder.
  if (context.packager.platformSpecificBuildOptions.identity === null) return;
  const identity = context.packager.platformSpecificBuildOptions.identity;
  if (identity !== 'Nikhil Anand (NW6B3R27LQ)') throw new Error('Finder signing requires the configured Developer ID team, not ad-hoc signing.');
  const signing = await context.packager.codeSigningInfo.value;
  const keychain = signing?.keychainFile ? ['--keychain', signing.keychainFile] : [];
  for (const target of targets) {
    // CI decodes its provisioning-profile secrets here. This directory is already gitignored.
    const profile = path.join(root, 'native/mac/build/signing', `${target.name}.provisionprofile`);
    if (!existsSync(profile)) throw new Error(`Finder signing requires ${profile}. No authentication fallback is permitted.`);
    const xml = execFileSync('/usr/bin/security', ['cms', '-D', '-i', profile], { stdio: ['ignore', 'pipe', 'pipe'] });
    // A complete profile also contains Data and Date values that JSON cannot represent.
    const extract = (key, format) => execFileSync('/usr/bin/plutil', ['-extract', key, format, '-o', '-', '-'], { input: xml, encoding: 'utf8' }).trim();
    const decoded = {
      Entitlements: JSON.parse(extract('Entitlements', 'json')),
      TeamIdentifier: JSON.parse(extract('TeamIdentifier', 'json')),
      ExpirationDate: extract('ExpirationDate', 'raw'),
      ProvisionsAllDevices: extract('ProvisionsAllDevices', 'raw') === 'true',
    };
    validateFinderProfile(decoded, target.id);
    copyFileSync(profile, path.join(target.bundle, 'Contents/embedded.provisionprofile'));
    execFileSync(
      '/usr/bin/codesign',
      ['--force', '--options', 'runtime', '--timestamp', '--sign', `Developer ID Application: ${identity}`, ...keychain, '--entitlements', path.join(root, 'build', `${target.name}.entitlements.plist`), target.bundle],
      { stdio: 'pipe' },
    );
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', target.bundle], { stdio: 'pipe' });
  }
}

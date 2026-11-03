// Node entry for both old npm-based UI upgrades and current Bun installs.
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const exec = promisify(execFile);

export async function ensureBun(dir, { cache = path.join(homedir(), '.cache', 'droid-office', 'bun'), run = exec, download = fetch } = {}) {
  const { packageManager } = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
  const version = /^bun@(\d+\.\d+\.\d+)$/.exec(packageManager)?.[1];
  if (!version) throw new Error('packageManager must pin a Bun release');
  const local = path.join(cache, version, 'bun');
  for (const command of ['bun', local]) {
    try {
      if ((await run(command, ['--version'])).stdout.trim() === version) return command;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  if (!['linux', 'darwin'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch)) throw new Error(`Install Bun ${version} before building on this platform`);
  // Older AWS provisioners already installed Python for node-gyp, but not unzip. Keep this
  // versioned binary outside the install so upgrades reuse it without sudo or shell-profile edits.
  const asset = `bun-${process.platform}-${process.arch === 'arm64' ? 'aarch64' : 'x64'}`;
  await mkdir(path.dirname(local), { recursive: true });
  const stage = await mkdtemp(path.join(path.dirname(local), '.download-'));
  try {
    const release = `https://github.com/oven-sh/bun/releases/download/bun-v${version}`;
    const response = await download(`${release}/${asset}.zip`, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Bun ${version} download failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const sums = await download(`${release}/SHASUMS256.txt`, { signal: AbortSignal.timeout(30_000) });
    if (!sums.ok) throw new Error(`Bun ${version} checksum download failed: HTTP ${sums.status}`);
    const expected = (await sums.text())
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .find((entry) => entry[1] === `${asset}.zip`)?.[0];
    if (!expected || !/^[a-f0-9]{64}$/i.test(expected) || createHash('sha256').update(bytes).digest('hex') !== expected.toLowerCase()) throw new Error(`Bun ${version} archive checksum mismatch`);
    const archive = path.join(stage, 'bun.zip');
    const binary = path.join(stage, 'bun');
    await writeFile(archive, bytes);
    await run('python3', ['-c', 'import sys, zipfile; open(sys.argv[3], "wb").write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))', archive, `${asset}/bun`, binary]);
    await chmod(binary, 0o755);
    if ((await run(binary, ['--version'])).stdout.trim() !== version) throw new Error(`Downloaded Bun does not match ${version}`);
    await rename(binary, local);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  return local;
}

export async function prepare(dir, install = false) {
  const migrate = install || process.env.npm_config_user_agent?.startsWith('npm/');
  // Ordinary dev installs keep the caller's Bun. Only deployed upgrades bootstrap the pin.
  const bun = migrate ? await ensureBun(dir) : 'bun';
  // Resolve PATH's Bun once so nested build scripts inherit the selected executable.
  const bunPath = bun === 'bun' ? (await exec(bun, ['-e', 'console.log(process.execPath)'])).stdout.trim() : bun;
  const env = { ...process.env, PATH: `${path.dirname(bunPath)}${path.delimiter}${process.env.PATH ?? ''}` };
  // The previous server runs `npm install`. Its prepare script must migrate the staged
  // tree to Bun's frozen lockfile, not build npm's independently resolved dependency tree.
  const args = migrate ? ['install', '--frozen-lockfile'] : ['run', 'build'];
  // Bun preserves npm's inherited user agent. Drop it at the handoff so its prepare
  // child builds once rather than mistaking itself for another legacy npm install.
  delete env.npm_config_user_agent;
  if (args[0] !== 'install') {
    const hooks = spawnSync(process.execPath, [path.join(dir, '.husky/install.mjs')], { cwd: dir, env, stdio: 'inherit' });
    if (hooks.error) throw hooks.error;
    if (hooks.status !== 0) throw new Error(`Hook installation failed (${hooks.status ?? hooks.signal})`);
  }
  const result = spawnSync(bunPath, args, { cwd: dir, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`bun ${args.join(' ')} failed (${result.status ?? result.signal})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await prepare(root, process.argv.includes('--install'));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ensureBun } from '../bin/prepare.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const packageManager = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).packageManager;
const version = packageManager.replace(/^bun@/, '');
const missing = () => Object.assign(new Error('spawn bun ENOENT'), { code: 'ENOENT' });

function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-bun-bootstrap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ packageManager }));
  return { dir, cache: path.join(dir, 'cache') };
}

test('Bun bootstrap reuses the pinned PATH binary without downloading', async (t) => {
  const { dir, cache } = fixture(t);
  const command = await ensureBun(dir, {
    cache,
    run: async (cmd, args) => {
      assert.equal(cmd, 'bun');
      assert.deepEqual(args, ['--version']);
      return { stdout: `${version}\n` };
    },
    download: async () => assert.fail('must not download'),
  });
  assert.equal(command, 'bun');
});

test('Bun bootstrap installs and reuses a pinned binary when PATH has no Bun or the wrong version', async (t) => {
  for (const absent of [true, false]) {
    const { dir, cache } = fixture(t);
    let installed = false;
    let downloads = 0;
    const run = async (cmd, args) => {
      if (cmd === 'bun') {
        if (absent) throw missing();
        return { stdout: '0.0.0\n' };
      }
      if (cmd === 'python3') {
        assert.match(args[3], /^bun-(linux|darwin)-(aarch64|x64)\/bun$/);
        writeFileSync(args[4], 'downloaded binary');
        installed = true;
        return { stdout: '' };
      }
      if (!installed) throw missing();
      assert.deepEqual(args, ['--version']);
      return { stdout: `${version}\n` };
    };
    const download = async (url) => {
      downloads++;
      assert.ok(url.startsWith(`https://github.com/oven-sh/bun/releases/download/bun-v${version}/`));
      return new Response('archive');
    };
    const command = await ensureBun(dir, { cache, run, download });
    assert.equal(command, path.join(cache, version, 'bun'));
    assert.equal(readFileSync(command, 'utf8'), 'downloaded binary');
    assert.deepEqual(readdirSync(path.dirname(command)), ['bun'], 'temporary downloads are removed');
    assert.equal(await ensureBun(dir, { cache, run, download }), command);
    assert.equal(downloads, 1);
  }
});

test('Bun bootstrap preserves real execution errors, including ENOENT in build output', async (t) => {
  const { dir, cache } = fixture(t);
  const error = Object.assign(new Error('ENOENT: no such file or directory, missing build input'), { code: 1 });
  await assert.rejects(
    ensureBun(dir, {
      cache,
      run: async () => {
        throw error;
      },
    }),
    (err) => err === error,
  );
});

test('Bun bootstrap reports download failures and removes temporary files', async (t) => {
  const { dir, cache } = fixture(t);
  await assert.rejects(
    ensureBun(dir, {
      cache,
      run: async () => {
        throw missing();
      },
      download: async () => new Response('', { status: 503 }),
    }),
    /download failed: HTTP 503/,
  );
  assert.deepEqual(readdirSync(path.join(cache, version)), []);
});

test('old npm prepare and current UI upgrades both hand dependency installation to frozen Bun', (t) => {
  for (const mode of ['npm', 'upgrade', 'bun', 'build-error']) {
    const { dir } = fixture(t);
    mkdirSync(path.join(dir, 'bin'));
    mkdirSync(path.join(dir, '.husky'));
    copyFileSync(path.join(root, 'bin/prepare.mjs'), path.join(dir, 'bin/prepare.mjs'));
    writeFileSync(path.join(dir, '.husky/install.mjs'), 'import {writeFileSync} from "node:fs"; writeFileSync("hooks", "installed");');
    writeFileSync(
      path.join(dir, 'bin/bun'),
      [
        `#!${process.execPath}`,
        'const fs = require("node:fs"); const {spawnSync} = require("node:child_process");',
        'const args = process.argv.slice(2);',
        `if (args[0] === "--version") console.log("${version}");`,
        'else if (args[0] === "-e") console.log(__filename);',
        'else if (args[0] === "install") {',
        '  fs.writeFileSync("install", JSON.stringify(args));',
        '  if (process.env.npm_config_user_agent?.startsWith("npm/")) throw new Error("npm metadata leaked into Bun");',
        '  const child = spawnSync(process.execPath, ["bin/prepare.mjs"], {env: process.env, stdio: "inherit"});',
        '  process.exit(child.status);',
        mode === 'build-error' ? '} else { console.error("ENOENT: no such file or directory, missing build input"); process.exit(2); }' : '} else fs.writeFileSync("build", JSON.stringify(args));',
      ].join('\n'),
      { mode: 0o755 },
    );
    const result = spawnSync(process.execPath, ['bin/prepare.mjs', ...(mode === 'upgrade' ? ['--install'] : [])], {
      cwd: dir,
      env: { ...process.env, PATH: path.join(dir, 'bin'), npm_config_user_agent: mode === 'npm' ? 'npm/11' : 'bun/1' },
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.ifError(result.error);
    if (mode === 'build-error') {
      assert.equal(result.status, 1);
      assert.match(result.stderr, /ENOENT: no such file or directory, missing build input/);
      assert.doesNotMatch(result.stderr, /Bun is not installed/);
      continue;
    }
    assert.equal(result.status, 0, result.stderr);
    if (mode !== 'bun') assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'install'), 'utf8')), ['install', '--frozen-lockfile']);
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'build'), 'utf8')), ['run', 'build']);
    assert.equal(readFileSync(path.join(dir, 'hooks'), 'utf8'), 'installed');
  }
});

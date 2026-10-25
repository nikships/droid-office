#!/usr/bin/env node
// ABBA thermal comparison, using office-run and a real-office clone. No global installs or fan controls.
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { clonePort } from './launch.mjs';
import { machineRecord, storageFor } from './lib.mjs';
import { summarizeTrials } from './thermal-lib.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const help = `Usage:
  node tools/frame-bench/thermal.mjs --clone DIR --before BUILD --after BUILD --macmon PATH --out DIR [--fps 120]
  node tools/frame-bench/thermal.mjs --clone DIR --build BUILD --variant before|after --label A1 --macmon PATH --out DIR
  node tools/frame-bench/thermal.mjs --compare RESULTS_DIR

Runs A1-before, B1-after, B2-after, A2-before. Builds must already be built.
Native Electron is the default backend. --backend headless supports up to 60 FPS.
Options: --fps 120|60|40, --config remastered-sdr|remastered-hdr|classic,
  --target desk-1, --warmup 180, --seconds 120, --cpu-max 34, --gpu-max 33,
  --stability 0.3, --min-cool 90, --max-cool 900, --size 3456x2168 (headless only).
Output is fresh per trial. Failed runs retain logs but never get result.json.
No physical scan-out, hottest-core, ambient or battery-life claims.`;

export function thermalOptions(argv) {
  const names = ['clone', 'before', 'after', 'build', 'variant', 'label', 'macmon', 'out', 'compare', 'fps', 'backend', 'config', 'target', 'warmup', 'seconds', 'cpu-max', 'gpu-max', 'stability', 'min-cool', 'max-cool', 'size'];
  const { values } = parseArgs({ args: argv, options: { ...Object.fromEntries(names.map((name) => [name, { type: 'string' }])), help: { type: 'boolean', short: 'h' } } });
  if (values.help || values.compare) return values;
  for (const name of ['clone', 'macmon', 'out']) if (!values[name]) throw new Error(`--${name} is required`);
  if (values.build ? values.before || values.after || !['before', 'after'].includes(values.variant) || !/^[A-Za-z0-9_-]{1,64}$/.test(values.label ?? '') : !values.before || !values.after)
    throw new Error('supply --before and --after, or --build with --variant and --label');
  const number = (name, fallback, min, max) => {
    const value = Number(values[name] ?? fallback);
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`invalid --${name}`);
    return value;
  };
  const fps = number('fps', 120, 40, 120);
  if (![40, 60, 120].includes(fps)) throw new Error('--fps must be 40, 60 or 120');
  const backend = values.backend ?? 'native';
  if (!['native', 'headless'].includes(backend) || (backend === 'headless' && fps > 60)) throw new Error('120 FPS requires the native backend; a headless cap is not proof of 120 FPS');
  return {
    ...values,
    fps,
    backend,
    config: values.config ?? 'remastered-sdr',
    target: values.target ?? 'desk-1',
    size: values.size ?? '3456x2168',
    warmup: number('warmup', 180, 3, 3600),
    seconds: number('seconds', 120, 30, 3600),
    cpuMax: number('cpu-max', 34, 10, 100),
    gpuMax: number('gpu-max', 33, 10, 100),
    stability: number('stability', 0.3, 0.01, 5),
    minCool: number('min-cool', 90, 30, 3600),
    maxCool: number('max-cool', 900, 30, 3600),
  };
}

function hostPids(clone) {
  const roots = [
    path.join(clone, 'home'),
    ...readdirSync(path.join(clone, 'floors'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(clone, 'floors', e.name)),
  ];
  const sockets = roots.map((root) => path.join(root, '.droid-office/pty.sock')).filter(existsSync);
  if (!sockets.length) return [];
  try {
    return execFileSync('lsof', ['-t', ...sockets], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter((n) => n > 0);
  } catch (error) {
    if (error.status === 1) return [];
    throw error;
  }
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const ended = new Promise((resolve) => child.once('close', resolve));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  await ended;
  clearTimeout(timer);
}

function compare(out) {
  const trials = ['A1', 'B1', 'B2', 'A2'].map((label) => JSON.parse(readFileSync(path.join(out, label, 'result.json'), 'utf8')));
  const summary = summarizeTrials(trials);
  writeFileSync(path.join(out, 'summary.json'), `${JSON.stringify({ summary, trials }, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

async function run(options) {
  if (options.help) {
    console.log(help);
    return;
  }
  if (options.compare) {
    compare(path.resolve(options.compare));
    return;
  }
  if (process.platform !== 'darwin') throw new Error('macmon thermal measurements require macOS');
  const clone = path.resolve(options.clone),
    port = clonePort(clone),
    out = path.resolve(options.out);
  if (options.minCool > options.maxCool) throw new Error('--min-cool exceeds --max-cool');
  if (!existsSync(options.macmon)) throw new Error('supply an existing macmon executable; this tool never downloads one');
  if (
    await fetch(`http://127.0.0.1:${port}/`).then(
      () => true,
      () => false,
    )
  )
    throw new Error(`port ${port} is already serving; stop your clone first`);
  mkdirSync(out, { recursive: true });
  const plan = options.build
    ? [[options.label, options.variant, options.build]]
    : [
        ['A1', 'before', options.before],
        ['B1', 'after', options.after],
        ['B2', 'after', options.after],
        ['A2', 'before', options.before],
      ];
  for (const [label] of plan) if (existsSync(path.join(out, label))) throw new Error(`refusing to overwrite trial ${label}`);
  // Snapshot once before launching any measured workload. This is deliberately outside the sensor window.
  writeFileSync(path.join(out, 'machine.json'), `${JSON.stringify(machineRecord(), null, 2)}\n`);
  let server,
    runner,
    interrupted = false;
  const interrupt = () => {
    interrupted = true;
    runner?.kill('SIGTERM');
    server?.kill('SIGTERM');
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const oldHosts = new Set(hostPids(clone));
  try {
    for (const [label, variant, buildPath] of plan) {
      if (interrupted) throw new Error('measurement interrupted');
      const build = path.resolve(buildPath),
        trialOut = path.join(out, label);
      if (!existsSync(path.join(build, 'dist/server/server/cli.js'))) throw new Error(`build ${build} first with npm run build`);
      const commit = execFileSync('git', ['-C', build, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      mkdirSync(trialOut);
      const params = { ...options, label, variant, commit, macmon: path.resolve(options.macmon), storage: storageFor(clone, { config: options.config, cap: options.fps, graphics: { stats: false } }) };
      writeFileSync(path.join(trialOut, 'protocol.json'), `${JSON.stringify({ ...params, storage: undefined, build }, null, 2)}\n`);
      const env = {
        ...process.env,
        HOME: path.join(clone, 'home'),
        GH_CONFIG_DIR: process.env.GH_CONFIG_DIR ?? path.join(os.homedir(), '.config/gh'),
        GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL ?? path.join(os.homedir(), '.gitconfig'),
      };
      for (const key of ['DROID_OFFICE_HOME', 'DROID_OFFICE_WORKER_ID', 'DROID_OFFICE_HOOK_TOKEN']) delete env[key];
      const serverLog = openSync(path.join(trialOut, 'server.log'), 'a');
      try {
        server = spawn(process.execPath, [path.join(build, 'bin/droid-office.js'), '--home', path.join(clone, 'office'), '--projects', path.join(clone, 'floors'), '--port', String(port), '--host', '127.0.0.1', '--weather', 'clear'], {
          cwd: build,
          env,
          stdio: ['ignore', serverLog, serverLog],
        });
        let serverError;
        server.once('error', (error) => {
          serverError = error;
        });
        const deadline = Date.now() + 45000;
        while (
          !(await fetch(`http://127.0.0.1:${port}/`).then(
            (r) => r.ok,
            () => false,
          ))
        ) {
          if (interrupted || serverError || server.exitCode !== null || Date.now() > deadline) throw new Error(`clone failed to start: ${serverError ?? 'see server.log'}`);
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        console.log(`Starting ${label}: ${variant} ${commit.slice(0, 7)}, ${options.backend} target ${options.fps} FPS`);
        const args = [
          path.join(repo, '.agents/skills/office-clone/scripts/office-run.mjs'),
          clone,
          path.join(repo, 'tools/frame-bench/thermal-steps.mjs'),
          '--out',
          trialOut,
          '--size',
          options.size,
          '--timeout',
          '360',
          ...(options.backend === 'native' ? ['--source', build] : []),
        ];
        runner = spawn(process.execPath, args, { cwd: repo, env: { ...process.env, OFFICE_THERMAL_OPTIONS: JSON.stringify(params) }, stdio: 'inherit' });
        const timeout = setTimeout(() => runner.kill('SIGTERM'), (options.maxCool + options.warmup + options.seconds + 600) * 1000);
        try {
          const code = await new Promise((resolve, reject) => {
            runner.once('error', reject);
            runner.once('close', resolve);
          });
          if (code !== 0 || interrupted) throw new Error(`${label} failed (${code}); logs retained, no comparison generated`);
        } finally {
          clearTimeout(timeout);
        }
      } finally {
        await stop(runner);
        await stop(server);
        closeSync(serverLog);
      }
    }
    if (!options.build) compare(out);
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    for (const pid of hostPids(clone))
      if (!oldHosts.has(pid)) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          /* already exited */
        }
      }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run(thermalOptions(process.argv.slice(2)));
  } catch (error) {
    console.error(`thermal: ${error.message}`);
    process.exitCode = 1;
  }
}

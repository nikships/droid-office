// Renders the office's materials with three.js r186 and with the scene_shaders.cpp programs in
// headless Chromium (harness.ts), and reports how far apart the pixels are. Needs the repository's
// node_modules (esbuild, playwright-core with its installed Chromium) and a host C++ compiler.
//
//   node native/android/app/src/test/cpp/shaders/compare.mjs [out-dir]
//
// Writes <out-dir>/report.json and one PNG per case and variant (three, native, diff), and prints a
// table. Exit status 1 when an opaque pixel differs by more than the tolerance.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const cpp = process.env.OFFICE_XR_SOURCE ?? resolve(here, '../../../main/cpp');
const out = resolve(process.argv[2] ?? process.env.OFFICE_XR_TEST_OUT ?? join(process.env.TMPDIR ?? '/tmp', 'office-shader-compare'));
mkdirSync(out, { recursive: true });

// Cases whose opaque pixels are held to 8/255 at most (three's own output is 8-bit, so a step of 1-2 is rounding).
const EXACT = new Set(['toon-indoor-shadow-fog-sky', 'toon-outdoor-wet-snow-lamps-haze', 'toon-fallback-emissive-flat-double-back-instanced', 'basic-text-sprite-card-line-premul', 'points-stars-halos-snow', 'skydome-beam-moon']);
const REQUIRED = new Set([...EXACT, 'standard-lambert-phong-exp2']);

const bundle = await build({ entryPoints: [join(here, 'harness.ts')], bundle: true, write: false, format: 'iife', target: 'es2022', logLevel: 'error' });
const script = bundle.outputFiles[0].text;

const emit = join(out, 'emit');
// The host suite supplies space-separated flags, including ASan/UBSan. No shell interprets them.
const suppliedFlags = (process.env.OFFICE_XR_CXXFLAGS ?? '').trim().split(/\s+/).filter(Boolean);
execFileSync(process.env.CXX ?? 'c++', ['-std=c++17', '-O1', '-Wall', '-Wextra', ...suppliedFlags, '-UNDEBUG', '-Werror', `-I${cpp}`, join(here, 'emit.cpp'), join(cpp, 'scene_shaders.cpp'), '-o', emit]);

const args = process.platform === 'darwin' ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'];
// An explicitly selected local Chrome may be used on macOS. CI installs Playwright's pinned Chromium.
const browser = await chromium.launch({ args, executablePath: process.env.OFFICE_XR_BROWSER_PATH });
const browserInfo = { platform: process.platform, version: browser.version(), args, executablePath: process.env.OFFICE_XR_BROWSER_PATH ?? chromium.executablePath() };
console.log(`Chromium ${browserInfo.version}, ${process.platform}, ${args.join(' ')}`);
let failed = false;
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.setContent('<!doctype html><html><body style="margin:0;background:#000"></body></html>');
  await page.addScriptTag({ content: script });
  const keys = await page.evaluate(() => window.harness.keys());
  const shaders = JSON.parse(execFileSync(emit, keys, { maxBuffer: 64 << 20 }).toString());
  const { results, log } = await page.evaluate((s) => window.harness.run(s), shaders);
  for (const line of [...log, ...errors]) console.log(line);

  const rows = [];
  const seen = new Set();
  for (const r of results) {
    if (!REQUIRED.has(r.name) || seen.has(r.name)) {
      errors.push(`unexpected or duplicate comparison case: ${r.name}`);
    }
    seen.add(r.name);
    for (const name of ['srgb', 'srgbThreeShadowMap', 'linear', 'linearOpaque']) {
      const stats = r[name];
      if (
        !stats ||
        !['max', 'over2', 'over8', 'pixels'].every((key) => Number.isFinite(stats[key]) && stats[key] >= 0) ||
        stats.max > 255 ||
        stats.over8 > stats.over2 ||
        stats.over2 > stats.pixels ||
        (name !== 'linearOpaque' && stats.pixels !== 160 * 160)
      ) {
        throw new Error(`${r.name}: invalid ${name} comparison statistics`);
      }
    }
    if (r.name !== 'skydome-beam-moon' && r.linearOpaque.pixels === 0) throw new Error(`${r.name}: no opaque pixels were compared`);
    for (const [variant, data] of Object.entries(r.images)) writeFileSync(join(out, `${r.name}.${variant}.png`), Buffer.from(data.split(',')[1], 'base64'));
    delete r.images;
    const fmt = (s) => `max ${String(s.max).padStart(3)}  >2 ${String(s.over2).padStart(5)}  >8 ${String(s.over8).padStart(5)} / ${s.pixels}`;
    rows.push(
      `${r.name}\n  sRGB output, own shadow map   ${fmt(r.srgb)}\n  sRGB output, three shadow map ${fmt(r.srgbThreeShadowMap)}\n  linear output (SRGB8_ALPHA8)  ${fmt(r.linear)}\n  linear output, opaque pixels  ${fmt(r.linearOpaque)}${r.srgbThreeDfg ? `\n  sRGB, three's DFG LUT        ${fmt(r.srgbThreeDfg)}` : ''}\n  keys: ${r.keys.join(' ')}`,
    );
    if (EXACT.has(r.name) && (r.srgb.max > 8 || r.srgbThreeShadowMap.max > 8 || r.linearOpaque.max > 8)) failed = true;
    if (r.name === 'standard-lambert-phong-exp2' && (!r.srgbThreeDfg || !Number.isFinite(r.srgbThreeDfg.max) || r.srgbThreeDfg.pixels !== 160 * 160 || r.srgbThreeDfg.max > 8)) failed = true;
  }
  for (const name of REQUIRED) if (!seen.has(name)) errors.push(`missing required comparison case: ${name}`);
  // Block layout, framebuffer and missing LUT diagnostics are failures; the renderer line is informational.
  errors.push(...log.filter((line) => !line.startsWith('GL renderer:')));
  writeFileSync(join(out, 'report.json'), JSON.stringify({ browser: browserInfo, results, log, errors }, null, 2));
  console.log(rows.join('\n'));
  console.log(`images and report.json in ${out}`);
  if (errors.length) failed = true;
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);

#!/usr/bin/env node
// Opens the marketing site in Playwright's headless shell, checks every landing section by its id and
// heading, and saves one screenshot per section plus the page's console errors.
//   node .agents/skills/verify-droid-office/scripts/website-sections.mjs <url> <out-dir>
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SECTIONS = ['top', 'play', 'tour', 'agents', 'pocket', 'why', 'workers', 'install'];
const [url, outArg] = process.argv.slice(2);
if (!url || !outArg) {
  console.error('usage: website-sections.mjs <url> <out-dir>');
  process.exit(2);
}
const out = path.resolve(outArg);
mkdirSync(out, { recursive: true });
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const root = path.join(os.homedir(), 'Library/Caches/droid-office/browsers');
const shell = existsSync(root)
  ? readdirSync(root)
      .filter((d) => d.startsWith('chromium_headless_shell-'))
      .sort()
      .reverse()
      .flatMap((d) => readdirSync(path.join(root, d)).map((s) => path.join(root, d, s, 'chrome-headless-shell')))
      .find(existsSync)
  : undefined;
const { chromium } = await import(pathToFileURL(path.join(repo, 'node_modules/playwright-core/index.mjs')).href);
const browser = await chromium.launch({ executablePath: shell, headless: true });
const errors = [];
const report = { url, sections: [] };
let code = 0;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 300)));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url, { waitUntil: 'networkidle' });
  for (const id of SECTIONS) {
    const section = page.locator(`section#${id}`);
    if ((await section.count()) !== 1) {
      report.sections.push({ id, found: false });
      code = 1;
      continue;
    }
    await section.scrollIntoViewIfNeeded();
    const heading = (await section.locator(`#${id}-title, h1, h2`).first().textContent())?.trim();
    const file = path.join(out, `section-${id}.png`);
    await section.screenshot({ path: file });
    report.sections.push({ id, found: true, heading, shot: file });
    console.log(`section ${id}: ${heading}`);
  }
} finally {
  await browser.close();
}
report.errors = errors;
writeFileSync(path.join(out, 'website.json'), `${JSON.stringify(report, null, 2)}\n`);
if (errors.length) console.log(`console errors:\n  ${errors.join('\n  ')}`);
console.log(`report ${path.join(out, 'website.json')}`);
process.exit(code);

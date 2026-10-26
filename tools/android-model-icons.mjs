// Preserve the web's official SVG colors, gradients and masks on native Android without an SVG
// runtime dependency. Render at 4× the largest 32dp logo; commit the PNGs for Gradle-only builds.
//   node --import tsx tools/android-model-icons.mjs
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_BRANDS } from '../src/client/ui/model-brand.ts';
import { closeBrowser, launchBrowser, newIsolatedContext, pinnedBrowser } from '../src/server/whiteboard-browser.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sources = path.join(root, 'src/client/public/icons/models');
export const MODEL_ICONS_DIR = path.join(root, 'android/app/src/main/assets/model-icons');
export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

export async function buildModelIcons(outDir = MODEL_ICONS_DIR) {
  mkdirSync(outDir, { recursive: true });
  const size = 128;
  const manifest = { size, chromium: pinnedBrowser().version, icons: {} };
  try {
    const browser = await launchBrowser();
    const context = await newIsolatedContext(browser, { viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    // No server or external resources: every image is an exact bundled SVG data URL.
    await page.route('**/*', (route) => route.abort());
    for (const [brand, mark] of Object.entries(MODEL_BRANDS)) {
      const source = readFileSync(path.join(sources, mark.file));
      // Kimi combines a black currentColor path and a blue accent: a light tile keeps both intact.
      await page.setContent(`<body style="margin:0;background:${mark.tile ? '#fff' : 'transparent'}"><img width="${size}" height="${size}" src="data:image/svg+xml;base64,${source.toString('base64')}"></body>`);
      await page.locator('img').evaluate((img) => img.decode());
      const png = await page.screenshot({ type: 'png', omitBackground: true });
      writeFileSync(path.join(outDir, `${brand}.png`), png);
      manifest.icons[brand] = { file: mark.file, mono: !!mark.mono, tile: !!mark.tile, svgSha256: sha256(source), pngSha256: sha256(png) };
    }
    await context.close();
  } finally {
    await closeBrowser();
  }
  writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const license = readFileSync(path.join(sources, 'LICENSE.txt'), 'utf8').replace('These SVGs are unmodified upstream assets.', 'These PNGs are rendered from the unmodified upstream SVGs, preserving their colors.');
  writeFileSync(path.join(outDir, 'LICENSE.txt'), license);
  return manifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifest = await buildModelIcons();
  console.log(`Rendered ${Object.keys(manifest.icons).length} official model marks at ${manifest.size}px into ${MODEL_ICONS_DIR}`);
}

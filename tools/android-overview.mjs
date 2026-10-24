// Builds the Android app's tablet and foldable overview page (src/client/android-overview.ts, the web
// companion's 3D floor) into android/app/src/main/assets/overview/, so the app runs the same map as
// the web companion without Node in its own build. `tests/android-overview.test.ts` fails when the
// committed copy no longer matches what the sources build to.
//
//   node tools/android-overview.mjs

import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OVERVIEW_DIR = path.join(root, 'android/app/src/main/assets/overview');

/** Builds the page into `outDir` as index.html, overview.js and overview.css, with no hashes, so a rebuild of the same sources is byte-identical. */
export async function buildOverview(outDir = OVERVIEW_DIR) {
  const { build } = await import('vite');
  await build({
    configFile: false,
    logLevel: 'warn',
    root: path.join(root, 'src/client'),
    // The page loads from the app's assets: everything it fetches by an absolute path (props, fonts)
    // goes through the app to the office.
    base: './',
    publicDir: false,
    plugins: [
      {
        // three's DRACOLoader names its own decoder files with new URL(…, import.meta.url), which would
        // bundle 1.3 MB of decoders the map never loads: it decodes with the office's /props/draco/.
        name: 'no-bundled-draco',
        transform(code, id) {
          if (id.replaceAll('\\', '/').endsWith('three/examples/jsm/loaders/DRACOLoader.js')) return code.replace(/new URL\(\s*'[^']+',\s*import\.meta\.url\s*\)\.toString\(\)/g, "''");
        },
      },
    ],
    build: {
      outDir,
      emptyOutDir: true,
      chunkSizeWarningLimit: 4000,
      modulePreload: false,
      reportCompressedSize: false,
      rollupOptions: {
        input: path.join(root, 'src/client/android-overview.html'),
        output: {
          codeSplitting: false,
          entryFileNames: 'overview.js',
          assetFileNames: 'overview[extname]',
        },
      },
    },
  });
  const html = path.join(outDir, 'android-overview.html');
  if (existsSync(html)) renameSync(html, path.join(outDir, 'index.html'));
  return readdirSync(outDir).sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  rmSync(OVERVIEW_DIR, { recursive: true, force: true });
  for (const f of await buildOverview()) console.log(path.relative(root, path.join(OVERVIEW_DIR, f)));
}

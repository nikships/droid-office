// Builds the Android app's Management page (src/client/companion-tools.html and companion-tools-host.ts,
// the office's own boards, pipelines, changes, docs, computers, floors, settings and Whiteboard windows)
// into android/app/src/main/assets/companion-tools/, so the app shows the same windows as the office
// without Node in its own build. `tests/android-companion-tools.test.ts` fails when the committed copy no
// longer matches what the sources build to.
//
//   node tools/android-companion-tools.mjs

import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const COMPANION_TOOLS_DIR = path.join(root, 'android/app/src/main/assets/companion-tools');

/** Builds the page into `outDir` as index.html, tools.js, tools.css and lazy chunks/, with no hashes, so a rebuild of the same sources is byte-identical. Returns every file, relative to `outDir`. */
export async function buildCompanionTools(outDir = COMPANION_TOOLS_DIR) {
  const { build } = await import('vite');
  await build({
    configFile: false,
    logLevel: 'warn',
    root: path.join(root, 'src/client'),
    // The page loads from the app's assets: everything it fetches by an absolute path (pictures,
    // fonts, card frames) goes through the app to the office.
    base: './',
    publicDir: false,
    build: {
      outDir,
      emptyOutDir: true,
      chunkSizeWarningLimit: 8000,
      modulePreload: false,
      reportCompressedSize: false,
      rollupOptions: {
        input: path.join(root, 'src/client/companion-tools.html'),
        output: {
          // Diagrams (mermaid) and maths load only when a document has them: keep them out of the page's
          // first parse, under names without hashes.
          entryFileNames: 'tools.js',
          chunkFileNames: 'chunks/[name].js',
          assetFileNames: 'tools[extname]',
        },
      },
    },
  });
  const html = path.join(outDir, 'companion-tools.html');
  if (existsSync(html)) renameSync(html, path.join(outDir, 'index.html'));
  return readdirSync(outDir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => path.relative(outDir, path.join(d.parentPath, d.name)).replaceAll('\\', '/'))
    .sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  rmSync(COMPANION_TOOLS_DIR, { recursive: true, force: true });
  for (const f of await buildCompanionTools()) console.log(path.relative(root, path.join(COMPANION_TOOLS_DIR, f)));
}

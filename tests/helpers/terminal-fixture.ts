import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { OFFICE_SHELL_ID } from '../../src/shared/office-shell.js';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright-core';
import { createServer } from 'vite';

/** Mount the production UI using its real module graph, stylesheet and WASM. */
export async function terminalFixture(t: TestContext) {
  const cacheDir = await mkdtemp(join(tmpdir(), 'office-terminal-ui-'));
  const server = await createServer({
    root: fileURLToPath(new URL('../../src/client', import.meta.url)),
    configFile: false,
    cacheDir,
    logLevel: 'error',
    appType: 'custom',
    server: { host: '127.0.0.1', port: 0, hmr: false },
    optimizeDeps: { noDiscovery: true, include: ['@wterm/dom', '@wterm/ghostty'] },
  });
  t.after(async () => {
    await server.close();
    await rm(cacheDir, { recursive: true, force: true });
  });
  await server.listen();
  const addr = server.httpServer!.address();
  if (!addr || typeof addr === 'string') throw Error('missing fixture address');
  return async (page: Page, body: string) => {
    // Only the document is synthetic. Let Chromium load and cache the real module graph normally.
    await page.route('**/fixture', (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><link rel="stylesheet" href="/style.css">${body}` }), { times: 1 });
    await page.goto(`http://127.0.0.1:${addr.port}/fixture`);
    await page.addScriptTag({ content: 'window.__name = fn => fn' });
    await page.evaluate(async (shellId) => {
      const urls = ['/ui/terminal.ts', '/state.ts', '/ui/term-font.ts', '/term-engine/wterm.ts'];
      const [ui, state, font, { WTermAdapter }] = await Promise.all(urls.map((url) => import(url)));
      (window as any).TerminalUI = { ...ui, ...font, store: state.store, Terminal: WTermAdapter, OFFICE_SHELL_ID: shellId };
    }, OFFICE_SHELL_ID);
  };
}

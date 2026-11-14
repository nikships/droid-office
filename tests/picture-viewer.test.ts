import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildSync } from 'esbuild';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';

const status = browserStatus();

test('picture windows hug the image and fit the viewport without stretching or cropping', { skip: status.installed ? false : `Chromium is not installed in ${status.path}` }, async (t) => {
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await newIsolatedContext(browser);
  t.after(() => context.close());
  const page = await context.newPage();
  await page.setContent('<!doctype html><div id="modal-root"></div>');
  await page.addScriptTag({ content: 'window.__name = (fn) => fn;' });
  await page.addStyleTag({ path: fileURLToPath(new URL('../src/client/style.css', import.meta.url)) });
  const bundle = buildSync({
    stdin: { contents: "export { viewPicture } from './src/client/ui/picture-viewer';", resolveDir: fileURLToPath(new URL('..', import.meta.url)) },
    bundle: true,
    format: 'iife',
    globalName: 'PictureUI',
    write: false,
    target: 'es2022',
  }).outputFiles[0].text;
  await page.addScriptTag({ content: bundle });
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1024, height: 700 },
  ]) {
    await page.setViewportSize(viewport);
    for (const [width, height] of [
      [684, 428],
      [2400, 600],
      [900, 2400],
      [160, 120],
    ]) {
      for (const dimensions of [true, false]) {
        await page.evaluate(
          ({ width, height, dimensions }) => {
            const src = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="orange"/></svg>`)}`;
            (window as any).PictureUI.viewPicture(src, 'Terminal image', { ...(dimensions ? { width, height } : {}), about: 'Worker with a very long name '.repeat(12) });
          },
          { width, height, dimensions },
        );
        await page.locator('.wt-picture-full').evaluate((el) => (el as HTMLImageElement).decode());
        await page.locator('.wt-picture-window').evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)));
        const boxes = await page.evaluate(() => {
          const rect = (selector: string) => {
            const r = document.querySelector(selector)!.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
          };
          return { modal: rect('.wt-picture-window'), body: rect('.wt-picture-body'), image: rect('.wt-picture-full'), close: rect('.wt-picture-window .close') };
        });
        const label = JSON.stringify({ viewport, width, height, dimensions, boxes });
        assert.ok(Math.abs(boxes.body.height - boxes.image.height) <= 1, `no blank space above or below the image: ${label}`);
        if (width >= 684) assert.ok(Math.abs(boxes.body.width - boxes.image.width) <= 1, `no blank space beside the image: ${label}`);
        assert.ok(Math.abs(boxes.image.width / boxes.image.height - width / height) < 0.01, `image keeps its aspect ratio: ${label}`);
        assert.ok(boxes.image.width <= width && boxes.image.height <= height, `small images are not enlarged: ${label}`);
        assert.ok(boxes.modal.x >= 16 && boxes.modal.y >= 16 && boxes.modal.right <= viewport.width - 16 && boxes.modal.bottom <= viewport.height - 16, `window stays on screen: ${label}`);
        assert.ok(boxes.close.x >= boxes.modal.x && boxes.close.right <= boxes.modal.right, `close button stays visible: ${label}`);
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('.wt-picture-window').count(), 0);
      }
    }
  }
});

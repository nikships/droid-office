/**
 * Screenshots the running office with a real browser, so the props are proven in the
 * actual app rather than in a render.
 *
 * Usage: node tools/props/shoot.mjs [out.png]
 */
import { chromium } from 'playwright';

const OUT = process.argv[2] ?? '.props-preview/office-props.png';
const URL_ = process.env.OFFICE_URL ?? 'http://localhost:4600';

// The login wall stands in front of the office; get past it the same way a person does.
const PASSWORD = process.env.OFFICE_PASSWORD ?? 'dev';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });

// Seed the saved profile before any script runs, so the character picker never opens.
// The picker is a modal dialog that also swallows key events meant for the camera.
await page.addInitScript(() => {
  localStorage.setItem(
    'agent-office.profile',
    JSON.stringify({ name: 'Nik', color: '#4f86f7', look: { skin: 2, hair: 2, style: 2 } }),
  );
});

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

const resp = await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 30000 });
console.log('status', resp?.status());

// Log in if the login page is what came back.
if (page.url().includes('login') || (await page.locator('input[type=password]').count())) {
  await page.fill('input[type=password]', PASSWORD);
  await Promise.all([page.waitForURL((u) => !u.toString().includes('login'), { timeout: 20000 }), page.click('button[type=submit]')]);
}

await page.waitForSelector('canvas', { timeout: 30000 });
await page.waitForTimeout(500);

// Give the GLBs time to fetch, decode and swap into the scene.
await page.waitForTimeout(9000);

// Turn to face the desk pods. The camera starts by the entrance looking at the atrium, so
// walk in and pan until the desks fill the frame. Keys go to the page, not to any dialog.
await page.locator('canvas').click({ position: { x: 800, y: 500 } }).catch(() => {});
const hold = async (key, ms) => {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
};
// Forward into the room.
await hold('KeyW', 2600);
await hold('KeyW', 2600);
// Look around by dragging, which is how the app turns the view.
const turn = async (dx) => {
  const box = await page.locator('canvas').boundingBox();
  await page.mouse.move(box.width / 2, box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.width / 2 + dx, box.height / 2, { steps: 20 });
  await page.mouse.up();
  await page.waitForTimeout(400);
};
await turn(320);
await hold('KeyW', 1400);
await page.waitForTimeout(600);

const diag = await page.evaluate(() => {
  const c = document.querySelector('canvas');
  const gl = c?.getContext('webgl2') ?? c?.getContext('webgl');
  return {
    canvas: c ? { w: c.width, h: c.height } : null,
    renderer: gl ? gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info')?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER) : null,
  };
});
console.log('diag', JSON.stringify(diag));

await page.screenshot({ path: OUT });
console.log('shot ->', OUT);

const propLogs = logs.filter((l) => /prop|swapped|GLB|draco|error|warn/i.test(l));
console.log('--- prop-related console ---');
console.log(propLogs.length ? propLogs.join('\n') : '(none)');

await browser.close();

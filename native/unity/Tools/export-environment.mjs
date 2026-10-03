import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';

const tools = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(tools, '../../..');
const output = path.resolve(tools, '../Assets/Art/Environment');
await mkdir(output, { recursive: true });
const server = await createServer({
  configFile: false,
  root: tools,
  publicDir: path.join(root, 'src/client/public'),
  server: { host: '127.0.0.1', port: 14601, strictPort: true, fs: { allow: [root] } },
});
const session = 'unity-environment-export';
async function browser(...args) {
  const child = spawn('agent-browser', ['--session', session, ...args], { cwd: root, stdio: 'inherit', timeout: 180000 });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Browser export failed: ${args[0]}`))));
  });
}
try {
  await server.listen();
  await browser('open', 'http://127.0.0.1:14601/environment-export.html?native=1');
  await browser('wait', '--fn', 'window.environmentExportReady === true || !!window.environmentExportError');
  await browser('get', 'text', '#status');
  await browser('download', '#model', path.join(output, 'office-environment.glb'));
  await browser('download', '#contract', path.join(output, 'office-environment.json'));
  await browser('download', '#worker', path.join(output, 'office-worker.glb'));
  await browser('download', '#laptop', path.join(output, 'office-laptop.glb'));
  const contractPath = path.join(output, 'office-environment.json');
  const contract = JSON.parse(await readFile(contractPath, 'utf8'));
  contract.modelSha256 = createHash('sha256')
    .update(await readFile(path.join(output, 'office-environment.glb')))
    .digest('hex');
  await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
  console.log(`Exported ${contract.sourceMeshes} meshes / ${contract.sourceTriangles} triangles in ${contract.batches} spatial/material batches.`);
} catch (error) {
  await browser('errors');
  await browser('console');
  throw error;
} finally {
  try {
    await browser('close');
  } finally {
    await server.close();
  }
}

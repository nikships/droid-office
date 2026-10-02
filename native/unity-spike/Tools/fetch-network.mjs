import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const tools = dirname(fileURLToPath(import.meta.url));
const dependencies = JSON.parse(await readFile(resolve(tools, 'network-deps.json'), 'utf8'));
const destination = resolve(tools, '../Assets/Plugins/Android');
await mkdir(destination, { recursive: true });
for (const { artifact, sha256 } of dependencies) {
  const name = artifact.split('/').at(-1) + '.jar';
  const path = resolve(destination, name);
  let bytes;
  try {
    bytes = await readFile(path);
  } catch {
    /* First install. */
  }
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== sha256) {
    const response = await fetch(`https://repo.maven.apache.org/maven2/${artifact}.jar`);
    if (!response.ok) throw new Error(`Dependency download failed: ${name}, HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error(`Checksum mismatch: ${name}`);
    await writeFile(path, bytes);
  }
  console.log(`Verified ${name}`);
}

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cache = resolve(dirname(fileURLToPath(import.meta.url)), '.cache');
const archive = resolve(cache, 'typescript-5.9.3.tgz');
const integrity = 'jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==';
mkdirSync(cache, { recursive: true });
if (!existsSync(archive)) {
  const response = await fetch('https://registry.npmjs.org/typescript/-/typescript-5.9.3.tgz');
  if (!response.ok) throw new Error('Compiler download failed');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha512').update(bytes).digest('base64') !== integrity) throw new Error('Compiler integrity mismatch');
  writeFileSync(archive, bytes);
}
if (createHash('sha512').update(readFileSync(archive)).digest('base64') !== integrity) throw new Error('Compiler integrity mismatch');
execFileSync('tar', ['-xzf', archive, '-C', cache]);
console.log('Verified isolated TypeScript 5.9.3 compiler API, Apache-2.0.');

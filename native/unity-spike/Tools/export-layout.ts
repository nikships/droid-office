import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as layout from '../../../src/shared/layout.ts';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(project, '../..');
const source = readFileSync(resolve(root, 'src/shared/layout.ts'));
const constants = Object.fromEntries(Object.entries(layout).filter(([, value]) => typeof value !== 'function' && !(value instanceof Map)));
const output = resolve(project, 'Assets/Spike/Layout');
mkdirSync(output, { recursive: true });
writeFileSync(
  resolve(output, 'office-layout.json'),
  `${JSON.stringify(
    {
      sourceCommit: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      sourceSha256: createHash('sha256').update(source).digest('hex'),
      constants,
    },
    null,
    2,
  )}\n`,
);
const props = resolve(project, 'Assets/Spike/Props');
mkdirSync(props, { recursive: true });
copyFileSync(resolve(root, 'src/client/public/props/macbook-base.glb'), resolve(props, 'macbook-base.glb'));
console.log(`U0 layout snapshot and unmodified laptop asset written under ${project}`);

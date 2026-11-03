import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function buildFreshness(checkout) {
  const files = execFileSync('git', ['-C', checkout, 'ls-files', '-z', 'src', 'bin'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const built = statSync(path.join(checkout, 'dist/server/server/cli.js')).mtimeMs;
  return files.some((file) => statSync(path.join(checkout, file)).mtimeMs > built) ? 'stale' : 'current';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(buildFreshness(process.argv[2]));

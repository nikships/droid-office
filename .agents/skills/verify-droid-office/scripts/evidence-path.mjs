import { realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function assertEvidenceOutsideRun(run, evidence) {
  const scratch = realpathSync(run);
  const proof = realpathSync(evidence);
  if (proof === scratch || proof.startsWith(`${scratch}${path.sep}`)) throw new Error(`evidence must be outside the scratch directory: ${evidence}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) assertEvidenceOutsideRun(process.argv[2], process.argv[3]);

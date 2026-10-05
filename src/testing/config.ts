// The owner's policy with the live gate closed: tests about the gate must not depend on his current `liveEffects`.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../core/env.ts';

export function gateClosedPolicy(dir: string): string {
  const path = join(dir, 'policy-gate-closed.ts');
  const owner = pathToFileURL(join(REPO_ROOT, 'config', 'policy.ts')).href;
  writeFileSync(path, `import owner from '${owner}';\nexport default { ...owner, liveEffects: false };\n`);
  return path;
}

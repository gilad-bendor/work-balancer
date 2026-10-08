// The owner's policy with the live gate closed: tests about the gate must not depend on his current `liveEffects`.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../core/env.ts';

export function gateClosedPolicy(dir: string): string {
  return testPolicy(dir, { liveEffects: false });
}

/** Keep unrelated policy tests independent of the owner's report start day (default: no days are asked for). */
export function testPolicy(dir: string, overrides: { liveEffects?: boolean; reportsStartDay?: string | null } = {}): string {
  const path = join(dir, 'policy-gate-closed.ts');
  const owner = pathToFileURL(join(REPO_ROOT, 'config', 'policy.ts')).href;
  const { reportsStartDay = null, ...rest } = overrides;
  writeFileSync(path, `import owner from '${owner}';\nexport default { ...owner, ...${JSON.stringify(rest)}, reports: { ...owner.reports, startDay: ${JSON.stringify(reportsStartDay)} } };\n`);
  return path;
}

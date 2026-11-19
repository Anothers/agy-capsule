import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function hostFixture(productRoot) {
  mkdirSync(join(productRoot, 'daemon'), { recursive: true });
  writeFileSync(join(productRoot, 'daemon', 'hub_5352.json'), JSON.stringify({
    httpPort: 5352, httpsPort: 5351, csrfToken: 'hub-only',
  }));
  return { productRoots: [productRoot], env: { ANTIGRAVITY_LS_ADDRESS: 'localhost:5352', ANTIGRAVITY_CSRF_TOKEN: 'fixture-session' } };
}

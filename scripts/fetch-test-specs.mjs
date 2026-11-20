// The tests run against real API specs, which are not committed (see README, "API specs"). This downloads the pinned versions into
// test/.specs the first time; it does nothing when they are there.
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';

const dir = new URL('../test/.specs/', import.meta.url);
const PINNED = {
  network: { version: '11.0.99', url: 'https://raw.githubusercontent.com/beezly/unifi-apis/main/unifi-network/11.0.99.json' },
  protect: { version: '7.3.74', url: 'https://apidoc-cdn.ui.com/protect/v7.3.74/integration.json' },
};

if (!existsSync(new URL('versions.json', dir))) {
  mkdirSync(dir, { recursive: true });
  for (const [app, { url }] of Object.entries(PINNED)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`could not download ${url} (${String(res.status)})`);
    writeFileSync(new URL(`${app}.json`, dir), Buffer.from(await res.arrayBuffer()));
  }
  const versions = Object.fromEntries(Object.entries(PINNED).map(([app, { version }]) => [app, version]));
  writeFileSync(new URL('versions.json.tmp', dir), `${JSON.stringify(versions, null, 2)}\n`);
  renameSync(new URL('versions.json.tmp', dir), new URL('versions.json', dir));
}

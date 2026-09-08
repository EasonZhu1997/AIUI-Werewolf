import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from '../server/service.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('web entry and module imports stay under the deployment prefix', async (t) => {
  const service = createService({ root });
  const address = await service.listen(0);
  t.after(() => service.close());
  const base = `http://127.0.0.1:${address.port}`;
  for (const prefix of ['/', '/werewolf/']) {
    const entryUrl = new URL(prefix, base);
    const entry = await fetch(entryUrl);
    assert.equal(entry.status, 200);
    const html = await entry.text();
    const script = html.match(/<script type="module" src="([^"]+)"/)[1];
    const style = html.match(/<link rel="stylesheet" href="([^"]+)"/)[1];
    for (const ref of [script, style]) {
      const url = new URL(ref, entryUrl);
      assert.ok(url.pathname.startsWith(prefix));
      assert.equal((await fetch(url)).status, 200);
    }
    const moduleUrl = new URL(script, entryUrl);
    const module = await (await fetch(moduleUrl)).text();
    const imports = [...module.matchAll(/^import .* from ['"]([^'"]+)['"]/gm)].map((match) => match[1]);
    assert.ok(imports.includes('./phase-ui.js'));
    for (const ref of imports) {
      const url = new URL(ref, moduleUrl);
      assert.ok(url.pathname.startsWith(prefix));
      assert.equal((await fetch(url)).status, 200);
    }
    const config = await (await fetch(new URL('../lib/config.js', moduleUrl))).text();
    assert.match(config, /url: ''/);
  }
});

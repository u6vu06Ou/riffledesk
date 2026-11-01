// scan-zh.test.mjs — guard the hardcoded-Chinese UI scanner: the product must
// stay at zero hits, otherwise English mode ships Chinese strings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('scan-hardcoded-zh: no hardcoded Chinese in product UI', () => {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'scan-hardcoded-zh.mjs')], {
    cwd: root, encoding: 'utf8',
  });
  assert.equal(r.status, 0, (r.stdout || '') + (r.stderr || ''));
  assert.match(r.stdout, /scan clean: 0/);
});

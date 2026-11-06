import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
process.env.NODE_ENV = 'test';
const { select } = require('../agentroots.js');

test('cloud-synced folders are never auto-indexed', () => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'rd-cloud-'));
  const home = path.join(base, 'home'); fs.mkdirSync(home);
  // zh-TW Google Drive "My Drive" folder name, escaped
  const names = ['My Drive', '我的雲端硬碟', 'OneDrive - Acme', 'Dropbox', 'local-proj'];
  const dirs = names.map(n => { const d = path.join(base, n, 'proj'); fs.mkdirSync(d, { recursive: true }); return d; });
  try {
    const got = select(dirs, { home }).map(p => path.basename(path.dirname(p)));
    assert.deepEqual(got, ['local-proj']);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

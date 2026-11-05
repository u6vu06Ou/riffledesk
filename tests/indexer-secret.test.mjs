// tests/indexer-secret.test.mjs — the INDEX path of the secret scan:
//   1) v6 → v8 DB migration keeps all rows/meta (secret column + diragg table
//      added in place — no wipe)
//   2) after a crawl, files.secret holds the scan result (1 = flagged, 0 = clean)
//   3) /api/list picks the flag up from the index
// Server on port 5185 with a FABRICATED v6 index.db. All keys are fixtures' fakes.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { loadSqlite } = require('../indexshared');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5185;
const BASE = `http://127.0.0.1:${PORT}`;
const DEMO = path.join(ROOT, 'tests/fixtures/secretdemo');

const sqlite = loadSqlite();
const haveSqlite = !!sqlite;

const TMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'riffledesk-idxsec-test-'));
const DB_PATH = path.join(TMP, 'index.db');
const CONFIG_PATH = path.join(TMP, 'config.json');

if (haveSqlite) {
  // --- fabricate a v6 database (pre-secret schema) with a sentinel meta row ---
  const db = new sqlite.DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE dirs (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, rpath TEXT);
    CREATE TABLE files (
      id INTEGER PRIMARY KEY,
      dirid INTEGER NOT NULL REFERENCES dirs(id),
      name TEXT NOT NULL, ext TEXT NOT NULL, kind TEXT,
      size INTEGER NOT NULL, mtime REAL NOT NULL,
      has_content INTEGER NOT NULL DEFAULT 0,
      UNIQUE(dirid, name)
    );
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema', '6');
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('sentinel', 'kept-always'); // survives ONLY if the DB is not rebuilt
  // one pre-existing indexed row for the fake-key note (has_content=0 → crawl will rescan)
  const dirId = db.prepare('INSERT INTO dirs (path, rpath) VALUES (?, ?)')
    .run(DEMO.replace(/[/\\]+$/, '').toLowerCase(), DEMO).lastInsertRowid;
  const st = fs.statSync(path.join(DEMO, 'keys-note.md'));
  db.prepare('INSERT INTO files (dirid, name, ext, kind, size, mtime, has_content) VALUES (?, ?, ?, ?, ?, ?, 0)')
    .run(dirId, 'keys-note.md', '.md', 'markdown', st.size, st.mtimeMs);
  db.close();

  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ roots: [DEMO], pinned: [] }, null, 2));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const proc = haveSqlite ? spawn('node', ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), FLODER_CONFIG: CONFIG_PATH },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true
}) : null;
let serverOut = '';
if (proc) {
  proc.stdout.on('data', d => { serverOut += d; });
  proc.stderr.on('data', d => { serverOut += d; });
}

async function waitListening() {
  const t0 = Date.now();
  while (!serverOut.includes('listening')) {
    if (proc.exitCode !== null) throw new Error('server exited early: ' + serverOut);
    if (Date.now() - t0 > 10000) throw new Error('server start timeout: ' + serverOut);
    await sleep(25);
  }
}
async function waitCrawled() {
  const t0 = Date.now();
  for (;;) {
    const r = await (await fetch(BASE + '/api/index/status')).json();
    if (r.available && !r.crawling && r.lastCrawlAt) return r;
    if (Date.now() - t0 > 30000) throw new Error('crawl timeout: ' + JSON.stringify(r));
    await sleep(150);
  }
}

after(async () => {
  try { proc && proc.kill(); } catch (_) {}
  if (proc) await Promise.race([new Promise(r => proc.once('exit', r)), sleep(3000)]);
  await sleep(300);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

const run = haveSqlite ? test : test.skip;
run('index secret path', async (t) => {
  await waitListening();
  const st0 = await waitCrawled();

  await t.test('v6 → v8 migration kept the data, and the crawl stored flags', async () => {
    // crawl idle → open the DB and check: secret column present, sentinel row alive
    const t0 = Date.now();
    let db = null;
    while (!db && Date.now() - t0 < 5000) {
      try { db = new sqlite.DatabaseSync(DB_PATH); } catch (_) { await sleep(150); }
    }
    assert.ok(db, 'cannot open migrated index.db');
    db.exec('PRAGMA query_only = ON');
    try {
      const cols = db.prepare('PRAGMA table_info(files)').all().map(c => c.name);
      assert.ok(cols.includes('secret'), 'files.secret column missing after migration');
      const sentinel = db.prepare('SELECT value FROM meta WHERE key = ?').get('sentinel');
      assert.equal(sentinel && sentinel.value, 'kept-always', 'meta lost — the DB was rebuilt, not migrated');
      const sv = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema');
      assert.equal(sv && sv.value, '8');

      const byName = Object.fromEntries(db.prepare(
        'SELECT f.name AS name, f.secret AS secret FROM files f JOIN dirs d ON d.id = f.dirid'
      ).all().map(r => [r.name, r.secret]));
      assert.equal(byName['keys-note.md'], 1, 'fake-key file should be flagged in the index');
      assert.equal(byName['prose-note.md'], 0, 'placeholder prose must stay clean');
      assert.equal(byName['rename-me.md'], 0);
      // this config has NO secretScanSkipDirs → the skipme/ file IS flagged on the index side
      assert.equal(byName['keys-hidden.md'], 1);
    } finally { try { db.close(); } catch (_) {} }
  });

  await t.test('/api/list picks the flag from the index', async () => {
    assert.ok(st0.files >= 4, JSON.stringify(st0));
    const r = await fetch(BASE + '/api/list?path=' + encodeURIComponent(DEMO) + '&exts=.md');
    const d = await r.json();
    const byName = Object.fromEntries(d.files.map(f => [f.name, !!f.secret]));
    assert.equal(byName['keys-note.md'], true);
    assert.equal(byName['prose-note.md'], false);
  });
});

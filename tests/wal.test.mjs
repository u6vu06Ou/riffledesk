// tests/wal.test.mjs — WAL growth/shrink semantics behind the index housekeeping.
//
// Regression guard for the field bug where index.db-wal sat at 399 MB for days:
//   (a) a reader holding a snapshot makes TRUNCATE return busy and the file does
//       NOT shrink — so the fix cannot be "just truncate harder", the readers
//       (status()'s full-table COUNT(*)) had to be taken off the hot path too;
//   (b) with journal_size_limit set, the WAL stays bounded once the reader lets
//       go — the default (-1) let a blown-up WAL stay huge forever;
//   (c) the status() counter cache only rescans when the generation moved and
//       the minimum gap has passed, never on every poll.
//
// Everything happens in os.tmpdir(); no repo DB, no server, no ports.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const { createCountCache } = require('../countcache.js');

const MB = 1048576;
const tmpDirs = [];
function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'riffledesk-wal-'));
  tmpDirs.push(dir);
  return path.join(dir, 'wal.db');
}
function walBytes(dbPath) {
  try { return fs.statSync(dbPath + '-wal').size; } catch (_) { return 0; }
}
after(() => {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
});

function open(dbPath, { sizeLimit } = {}) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = OFF'); // speed only; WAL mechanics are unaffected
  db.exec('PRAGMA busy_timeout = 1000');
  db.exec('PRAGMA wal_autocheckpoint = 256'); // let it try to cap during writes
  if (sizeLimit) db.exec(`PRAGMA journal_size_limit = ${sizeLimit}`);
  db.exec('CREATE TABLE IF NOT EXISTS blob (id INTEGER PRIMARY KEY, body TEXT)');
  return db;
}

// Writes well past 2 MB of WAL. Each row carries ~16 KB of payload so the pages
// really have to be appended, and the pinned snapshot stops any reset.
function writeBulk(db, rows = 260) {
  const payload = 'x'.repeat(16 * 1024);
  for (let start = 0; start < rows; start += 20) {
    db.exec('BEGIN');
    try {
      const ins = db.prepare('INSERT INTO blob (body) VALUES (?)');
      for (let i = start; i < Math.min(rows, start + 20); i++) ins.run(payload + i);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      throw e;
    }
  }
}

test('a: a pinned reader makes TRUNCATE busy and keeps the WAL large', () => {
  const dbPath = tmpDb();
  const w = open(dbPath);
  const r = open(dbPath);
  r.exec('BEGIN');
  r.prepare('SELECT COUNT(*) AS n FROM blob').get(); // take the snapshot
  try {
    writeBulk(w);

    const before = walBytes(dbPath);
    assert.ok(before > 2 * MB, `expected WAL > 2 MB with a pinned reader, got ${before}`);

    const res = w.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    assert.equal(res.busy, 1, 'TRUNCATE must report busy while a snapshot is held');
    const afterBusy = walBytes(dbPath);
    assert.ok(afterBusy > 2 * MB, `WAL must stay large after a busy TRUNCATE, got ${afterBusy}`);

    r.exec('COMMIT'); // reader lets go
    const res2 = w.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    assert.equal(res2.busy, 0, 'TRUNCATE must succeed once the reader released');
    const afterFree = walBytes(dbPath);
    assert.ok(afterFree < 1 * MB, `WAL must shrink below 1 MB, got ${afterFree}`);
  } finally {
    try { r.close(); } catch (_) {}
    try { w.close(); } catch (_) {}
  }
});

// journal_size_limit acts at the next COMMIT (SQLite truncates the WAL to the
// limit there), but only once a checkpoint has actually reclaimed the file:
// the sequence is grow behind a pinned reader → release → full PASSIVE reset →
// one tiny commit. A control run without the pragma proves the limit is what
// shrinks it (there the file simply stays at its grown length).
test('b: journal_size_limit bounds the WAL after the reader releases', () => {
  const growThenBounded = (dbPath, sizeLimit) => {
    const w = open(dbPath, sizeLimit ? { sizeLimit } : {});
    const r = open(dbPath);
    r.exec('BEGIN');
    r.prepare('SELECT COUNT(*) AS n FROM blob').get();
    try {
      writeBulk(w);
      assert.ok(walBytes(dbPath) > 2 * MB, 'precondition: WAL grew past 2 MB');
      r.exec('COMMIT');
    } finally {
      try { r.close(); } catch (_) {}
    }
    try {
      const res = w.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
      assert.equal(res.busy, 0, 'PASSIVE must fully reset the WAL now the reader is gone');
      w.exec('BEGIN'); // the commit after the reset is when the limit applies
      w.prepare('INSERT INTO blob (body) VALUES (?)').run('tiny');
      w.exec('COMMIT');
      return walBytes(dbPath);
    } finally {
      try { w.close(); } catch (_) {}
    }
  };

  const unlimited = growThenBounded(tmpDb(), 0);
  assert.ok(unlimited > 2 * MB, `control: default -1 must leave the WAL grown, got ${unlimited}`);

  const bounded = growThenBounded(tmpDb(), 4 * MB);
  assert.ok(bounded <= 4 * MB + 64 * 1024, `WAL must be bounded by journal_size_limit, got ${bounded}`);
  assert.ok(bounded < unlimited, `limit must actually shrink it (${bounded} vs ${unlimited})`);
});

test('c: status() count cache does not rescan on every poll', () => {
  let clock = 1_000_000;
  const cache = createCountCache({ ttlMs: 60_000, minGapMs: 5_000, now: () => clock });

  assert.equal(cache.shouldScan(7), true, 'first call must scan');
  cache.record(7, 100, 40);

  // same generation: every subsequent poll reuses the numbers
  for (let i = 0; i < 40; i++) {
    clock += 100; // 40 polls, 4 s total — still inside the min gap
    assert.equal(cache.shouldScan(7), false, `poll ${i} must not rescan with an unchanged gen`);
  }

  // generation moved, but a crawl is running and we are inside the min gap
  clock += 100;
  assert.equal(cache.shouldScan(8, true), false, 'a gen tick within minGap during a crawl must not rescan');
  clock += 1_000;
  clock += 5_000;
  assert.equal(cache.shouldScan(8, true), true, 'a gen tick past minGap must rescan even mid-crawl');
  cache.record(8, 101, 41);
  assert.deepEqual([cache.peek().files, cache.peek().filesWithContent], [101, 41]);

  // crawl finished: a gen change reflects immediately, without waiting for minGap
  clock += 100;
  assert.equal(cache.shouldScan(9, false), true, 'after the crawl ends a gen change must rescan at once');
  cache.record(9, 102, 42);

  // quiet index, no gen change: the TTL still refreshes eventually
  clock += 59_000;
  assert.equal(cache.shouldScan(9), false, 'still cached before the TTL');
  clock += 1_500;
  assert.equal(cache.shouldScan(9), true, 'TTL expiry forces a rescan');

  // a scan that failed (nulls) must still back off, not re-run every poll
  cache.record(9, null, null);
  clock += 100;
  assert.equal(cache.shouldScan(9), false, 'a failed scan still occupies the cache slot');
  clock += 1_000;
  assert.equal(cache.shouldScan(10, true), false, 'and honours the crawl min gap too');

  // peek() hands out a copy: mutating it must not corrupt the cache
  const snap = cache.peek();
  snap.files = 999999;
  assert.equal(cache.peek().files, null, 'peek() must not expose the live state object');
});

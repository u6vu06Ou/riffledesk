// writeAtomic（fileops.js）的後備路徑：這是存檔的最後一道，壞掉就是使用者白打一篇。
// 用 monkeypatch 假造 Windows 的暫時鎖（EPERM／EACCES）與寫入失敗，驗：
//  - 正常路徑照舊、不留 temp
//  - 重試撐爆就原地覆寫，內容換新、temp 清掉
//  - 原地覆寫也失敗時，舊內容被還原，錯誤訊息講明有快照、還原結果，temp（新內容）留著
//  - transient 判斷涵蓋 EACCES（不是只有 EPERM/EBUSY）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { writeAtomic } = require('../fileops.js');

const tmpDir = () => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'rd-writeatomic-'));
function failWith(code) { const e = new Error(code + ' (simulated)'); e.code = code; throw e; }

test('normal path writes and leaves no temp file', () => {
  const d = tmpDir(), f = path.join(d, 'a.md');
  fs.writeFileSync(f, 'old\n');
  writeAtomic(f, Buffer.from('new\n'));
  assert.equal(fs.readFileSync(f, 'utf8'), 'new\n');
  assert.deepEqual(fs.readdirSync(d), ['a.md']);
});

// the retry + in-place fallback exists for Windows lock churn (Defender / indexer
// holding the target); POSIX writeAtomic throws at once on a transient rename error
const WIN_FALLBACK = { skip: process.platform !== 'win32' && 'Windows-only rename retry + in-place fallback' };

for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
  test(`transient ${code} that never clears falls back to an in-place write`, WIN_FALLBACK, () => {
    const d = tmpDir(), f = path.join(d, 'a.md');
    fs.writeFileSync(f, 'old\n');
    const real = fs.renameSync;
    fs.renameSync = () => failWith(code);
    try { writeAtomic(f, Buffer.from('fallback\n')); } finally { fs.renameSync = real; }
    assert.equal(fs.readFileSync(f, 'utf8'), 'fallback\n');
    assert.deepEqual(fs.readdirSync(d), ['a.md']);   // temp 被清掉
  });
}

test('fallback failure keeps the old bytes and reports the snapshot/restore state', WIN_FALLBACK, () => {
  const d = tmpDir(), f = path.join(d, 'a.md');
  fs.writeFileSync(f, 'old\n');
  const realRename = fs.renameSync, realWrite = fs.writeFileSync;
  fs.renameSync = () => failWith('EPERM');
  fs.writeFileSync = (p, b, ...rest) => (p === f ? failWith('ENOSPC') : realWrite(p, b, ...rest));
  let err;
  try { writeAtomic(f, Buffer.from('x\n')); } catch (e) { err = e; } finally {
    fs.renameSync = realRename; fs.writeFileSync = realWrite;
  }
  assert.ok(err, 'should throw');
  assert.equal(fs.readFileSync(f, 'utf8'), 'old\n');
  assert.match(err.message, /previous \d+ bytes snapshotted/);
  assert.match(err.message, /RESTORE ALSO FAILED/);
  const kept = fs.readdirSync(d).filter(n => n.startsWith('.rdtmp-'));
  assert.equal(kept.length, 1, 'the new content must survive in the temp file');
  assert.equal(fs.readFileSync(path.join(d, kept[0]), 'utf8'), 'x\n');
});

test('a non-transient rename error does not fall back', () => {
  const d = tmpDir(), f = path.join(d, 'a.md');
  fs.writeFileSync(f, 'old\n');
  const real = fs.renameSync;
  fs.renameSync = () => failWith('EXDEV');
  try { assert.throws(() => writeAtomic(f, Buffer.from('new\n')), /rename into place failed/); }
  finally { fs.renameSync = real; }
  assert.equal(fs.readFileSync(f, 'utf8'), 'old\n');
  assert.deepEqual(fs.readdirSync(d), ['a.md']);
  if (process.platform !== 'win32') assert.equal(fs.readdirSync(d).length, 1);
});

test('stale temp files in the directory are swept on the next success', { skip: process.platform !== 'win32' }, () => {
  const d = tmpDir(), f = path.join(d, 'a.md');
  fs.writeFileSync(f, 'old\n');
  const old = path.join(d, '.rdtmp-stale.tmp');
  fs.writeFileSync(old, 'junk');
  const long = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(old, long, long);
  writeAtomic(f, Buffer.from('new\n'));
  assert.ok(!fs.existsSync(old), 'stale temp should be gone');
  // 同一目錄 10 分鐘內不再掃；新的一份放久一點仍會被下次（換目錄）掃到
  const fresh = path.join(d, '.rdtmp-fresh.tmp');
  fs.writeFileSync(fresh, 'junk');
  fs.utimesSync(fresh, long, long);
  writeAtomic(f, Buffer.from('newer\n'));
  assert.ok(fs.existsSync(fresh), 'same dir within 10 min is not rescanned');
});

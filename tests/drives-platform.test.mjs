// tests/drives-platform.test.mjs — collectDrives() with stubbed platform + I/O:
// simulates darwin / linux volume layouts on any host machine, so the macOS/Linux
// drivable-scope semantics are verified without a Mac or a Linux box.
// Usage: node --test tests/drives-platform.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// keep loadConfig away from the repo's real config before requiring server.js
process.env.FLODER_CONFIG = path.join(
  fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'rd-drives-cfg-')), 'config.json');
const require = createRequire(import.meta.url);
const { collectDrives } = require(path.join(ROOT, 'server.js'));

// Build an io stub from a description of the simulated filesystem.
function sim(dirs, realpaths = {}) {
  const dirset = new Set(dirs.map(d => d.replace(/\/+$/, '') || '/'));
  return {
    isDir: p => dirset.has(p.replace(/\/+$/, '') || '/'),
    subdirs: base => [...dirset]
      .filter(d => path.posix.dirname(d) === base)
      .map(d => d.slice(base.length + 1)),
    realpath: p => realpaths[p.replace(/\/+$/, '') || '/'] || p
  };
}

test('darwin: home + real volumes; the whole-disk aliases are excluded, real mounts kept', () => {
  const items = collectDrives({
    platform: 'darwin', home: '/Users/kim',
    ...sim(
      ['/Users/kim', '/Volumes', '/Volumes/Macintosh HD', '/Volumes/Macintosh HD - Data',
        '/Volumes/System', '/Volumes/USB'],
      { // stock Mac (Catalina+): boot volume → "/", data volume → the firmlinked data root
        '/Volumes/Macintosh HD': '/',
        '/Volumes/Macintosh HD - Data': '/System/Volumes/Data',
        '/Volumes/System': '/System' })
  });
  const paths = items.map(i => i.path);
  assert.deepEqual(paths, ['/Users/kim', '/Volumes/USB']);
  assert.ok(!paths.includes('/'), 'the filesystem root must not be a POSIX drive');
  assert.ok(!paths.includes('/Volumes/Macintosh HD'), 'the alias of "/" would silently re-widen the scope');
  assert.ok(!paths.includes('/Volumes/Macintosh HD - Data'),
    'the data volume would re-open the whole data disk behind the home filter');
});

test('darwin: home is checked as a string only, so a home realpathing under /System/Volumes stays', () => {
  const items = collectDrives({
    platform: 'darwin', home: '/Users/kim',
    ...sim(['/Users/kim', '/Volumes'], { '/Users/kim': '/System/Volumes/Data/Users/kim' })
  });
  assert.deepEqual(items.map(i => i.path), ['/Users/kim']);
});

test('POSIX: HOME="/" is dropped (root is not a drive)', () => {
  for (const platform of ['darwin', 'linux']) {
    const items = collectDrives({ platform, home: '/', ...sim(['/', '/Volumes', '/mnt']) });
    assert.deepEqual(items.map(i => i.path), [], platform);
  }
});

test('darwin: two volumes realpathing to the same target dedupe to one entry', () => {
  const items = collectDrives({
    platform: 'darwin', home: '/Users/kim',
    ...sim(
      ['/Users/kim', '/Volumes', '/Volumes/Snap', '/Volumes/Snap-alias'],
      { '/Volumes/Snap-alias': '/Volumes/Snap' })
  });
  const paths = items.map(i => i.path);
  assert.deepEqual(paths.filter(p => p.includes('Snap')).length, 1);
});

test('linux (incl. WSL): home + /mnt/* + the per-user /media/<user>/* entries only', () => {
  const items = collectDrives({
    platform: 'linux', home: '/home/kim', user: 'kim',
    ...sim(['/home/kim', '/mnt', '/mnt/c', '/media', '/media/kim', '/media/kim/T128',
      '/media/other', '/media/other/Disk'])
  });
  const paths = items.map(i => i.path);
  assert.deepEqual(paths, ['/home/kim', '/mnt/c', '/media/kim/T128']);
  assert.ok(!paths.includes('/'), 'the filesystem root must not be a POSIX drive');
  assert.ok(!paths.includes('/media'), 'bare /media is a parent directory, not a mount');
  assert.ok(!paths.includes('/media/other/Disk'), 'another user\'s mounts are out of scope');
});

test('linux: unresolvable user falls back to scanning /media/* entries (still no bare /media)', () => {
  const items = collectDrives({
    platform: 'linux', home: '/home/kim', user: '',
    ...sim(['/home/kim', '/media', '/media/kim', '/media/kim/T128', '/media/other', '/media/other/Disk'])
  });
  assert.deepEqual(items.map(i => i.path), ['/home/kim', '/media/kim', '/media/other']);
});

test('linux: /media entries realpathing to the root or /System/Volumes are skipped too', () => {
  const items = collectDrives({
    platform: 'linux', home: '/home/kim', user: 'kim',
    ...sim(['/home/kim', '/media/kim', '/media/kim/rooty', '/media/kim/data'],
      { '/media/kim/rooty': '/', '/media/kim/data': '/System/Volumes/Data' })
  });
  assert.deepEqual(items.map(i => i.path), ['/home/kim']);
});

test('linux: a mount whose realpath cannot be resolved is still offered', () => {
  const d = sim(['/home/kim', '/media/kim', '/media/kim/flaky']);
  d.realpath = p => { if (p.endsWith('/flaky')) throw new Error('EIO'); return p; };
  const items = collectDrives({ platform: 'linux', home: '/home/kim', user: 'kim', ...d });
  assert.deepEqual(items.map(i => i.path), ['/home/kim', '/media/kim/flaky']);
});

test('linux: udisks2 locations /run/media/<user>/* are listed too', () => {
  const items = collectDrives({
    platform: 'linux', home: '/home/kim', user: 'kim',
    ...sim(['/home/kim', '/run/media', '/run/media/kim', '/run/media/kim/USB'])
  });
  assert.deepEqual(items.map(i => i.path), ['/home/kim', '/run/media/kim/USB']);
});

test('linux: USER/LOGNAME env is only consulted when the user lookup fails, and must be a plain name', () => {
  const d = sim(['/home/kim', '/media/other', '/media/other/Disk', '/media/frank', '/media/frank/X']);
  const noLookup = { userInfo: () => { throw new Error('no passwd entry'); } };
  const before = { USER: process.env.USER, LOGNAME: process.env.LOGNAME };
  try {
    process.env.USER = 'other';
    assert.deepEqual(collectDrives({ platform: 'linux', home: '/home/kim', ...noLookup, ...d }).map(i => i.path),
      ['/home/kim', '/media/other/Disk'], 'env user picks its own /media dir');
    process.env.USER = 'other/../../etc';
    assert.deepEqual(collectDrives({ platform: 'linux', home: '/home/kim', ...noLookup, ...d }).map(i => i.path),
      ['/home/kim', '/media/other', '/media/frank'], 'unusable env name falls back to scanning');
    process.env.USER = 'frank';
    assert.deepEqual(collectDrives({ platform: 'linux', home: '/home/kim', user: 'kim', ...d }).map(i => i.path),
      ['/home/kim'], 'an explicit io.user beats the env');
    // an io.userInfo result wins over the env as well
    process.env.USER = 'frank';
    assert.deepEqual(collectDrives({
      platform: 'linux', home: '/home/kim', userInfo: () => ({ username: 'other' }), ...d
    }).map(i => i.path), ['/home/kim', '/media/other/Disk']);
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('HOME symlinked to the filesystem root counts as root and is dropped', () => {
  const items = collectDrives({
    platform: 'linux', home: '/home/kim', user: 'kim',
    ...sim(['/home/kim'], { '/home/kim': '/' })
  });
  assert.deepEqual(items.map(i => i.path), []);
});

test('linux: an empty/missing mount tree still yields just the home dir', () => {
  const items = collectDrives({ platform: 'linux', home: '/home/kim', user: 'kim', ...sim(['/home/kim']) });
  assert.deepEqual(items.map(i => i.path), ['/home/kim']);
});

test('win32: drive letters only, no POSIX branches fire', () => {
  const items = collectDrives({
    platform: 'win32',
    isDir: p => /^[CD]:\\$/.test(p),           // only C: and D: exist
    realpath: p => p,
    subdirs: () => { throw new Error('POSIX readdir must never run for win32'); }
  });
  assert.deepEqual(items.map(i => i.path), ['C:\\', 'D:\\']);
});

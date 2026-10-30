// tests/cli-install-skill.test.mjs — tests for `riffledesk install-skill`.
// Every case runs in a throwaway HOME so the real ~/.claude is never touched.
// Usage: node --test tests/cli-install-skill.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'riffledesk.js');
const SKILL = path.join(ROOT, 'skills', 'riffledesk', 'SKILL.md');
const SNIPPET = path.join(ROOT, 'skills', 'riffledesk', 'AGENTS-snippet.md');
let TMP;

before(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'riffledesk-install-')); });
after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

let seq = 0;
function fakeHome() {
  const dir = path.join(TMP, `home-${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// HOME (POSIX) and USERPROFILE (Windows) both point into the throwaway dir.
function run(args, home = fakeHome()) {
  return new Promise(resolve => {
    const proc = spawn(process.execPath, [BIN, ...args], {
      cwd: TMP,
      env: { ...process.env, HOME: home, USERPROFILE: home, RIFFLEDESK_BROWSER_CMD: 'definitely-not-a-browser' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    proc.on('close', code => resolve({ code, out, err, home }));
  });
}

const installed = home => path.join(home, '.claude', 'skills', 'riffledesk');
// backups live BESIDE the skills folder, never in it (Claude Code loads every entry
// of skills/ as a skill, so a sibling *.bak showed up as a second "riffledesk" skill)
const backupRoot = home => path.join(home, '.claude', 'skills-backup');

test('help exits 0 and documents the flags', async () => {
  const r = await run(['install-skill', '--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /--dest/);
  assert.match(r.out, /--claude/);
  assert.match(r.out, /skills-backup/);
});

test('default target is <home>/.claude/skills/riffledesk and both files land', async () => {
  const r = await run(['install-skill']);
  assert.equal(r.code, 0);
  assert.match(r.out, new RegExp(`installed: .*riffledesk`));
  const dir = installed(r.home);
  assert.equal(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), fs.readFileSync(SKILL, 'utf8'));
  assert.equal(fs.readFileSync(path.join(dir, 'AGENTS-snippet.md'), 'utf8'), fs.readFileSync(SNIPPET, 'utf8'));
});

test('an identical copy is left alone and reported as up to date', async () => {
  const first = await run(['install-skill']);
  assert.equal(first.code, 0);
  const target = path.join(installed(first.home), 'SKILL.md');
  const stamp = new Date(2001, 0, 1);
  fs.utimesSync(target, stamp, stamp);

  const again = await run(['install-skill'], first.home);
  assert.equal(again.code, 0);
  assert.match(again.out, /already up to date/);
  assert.equal(fs.statSync(target).mtimeMs, stamp.getTime(), 'file must not be rewritten');
  assert.equal(fs.existsSync(backupRoot(first.home)), false, 'nothing backed up when identical');
});

test('a differing copy is backed up outside the skills dir and replaced', async () => {
  const first = await run(['install-skill']);
  assert.equal(first.code, 0, `first install failed: ${first.err}`);
  const dir = installed(first.home);
  fs.writeFileSync(path.join(dir, 'SKILL.md'), 'old hand-edited copy\n');

  const again = await run(['install-skill'], first.home);
  assert.equal(again.code, 0, `replace failed: ${again.err}`);
  assert.match(again.out, /replaced differing copy/);
  assert.equal(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), fs.readFileSync(SKILL, 'utf8'));

  const root = backupRoot(first.home);
  assert.ok(fs.existsSync(root), 'backup root exists');
  const names = fs.readdirSync(root);
  assert.equal(names.length, 1);
  assert.match(names[0], /^riffledesk-\d{8}-\d{6}(-\d+)?$/);
  assert.equal(fs.readFileSync(path.join(root, names[0], 'SKILL.md'), 'utf8'), 'old hand-edited copy\n');
  assert.deepEqual(fs.readdirSync(path.join(first.home, '.claude', 'skills')), ['riffledesk'],
    'only the live skill sits in skills/');
});

test('--dest installs under that directory and keeps unrelated entries', async () => {
  const dest = path.join(TMP, `dest-${++seq}`);
  fs.mkdirSync(path.join(dest, 'other-skill'), { recursive: true });
  fs.writeFileSync(path.join(dest, 'other-skill', 'SKILL.md'), 'keep me\n');

  const r = await run(['install-skill', '--dest', dest]);
  assert.equal(r.code, 0);
  assert.ok(fs.existsSync(path.join(dest, 'riffledesk', 'SKILL.md')));
  assert.equal(fs.readFileSync(path.join(dest, 'other-skill', 'SKILL.md'), 'utf8'), 'keep me\n');
});

test('--dest=value form and ~ expansion work', async () => {
  const home = fakeHome();
  const r = await run(['install-skill', '--dest=~/custom'], home);
  assert.equal(r.code, 0);
  assert.ok(fs.existsSync(path.join(home, 'custom', 'riffledesk', 'SKILL.md')));
});

test('--claude and --dest together is a usage error in either order', async () => {
  for (const args of [['--dest', path.join(TMP, 'ignored'), '--claude'], ['--claude', '--dest', TMP]]) {
    const r = await run(['install-skill', ...args]);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.err, /pick one/);
    assert.match(r.err, /usage: riffledesk install-skill/);
  }
});

test('--claude alone installs into the default location', async () => {
  const r = await run(['install-skill', '--claude']);
  assert.equal(r.code, 0, `install failed: ${r.err}`);
  assert.ok(fs.existsSync(path.join(installed(r.home), 'SKILL.md')));
});

test('an empty --dest is a usage error, not a silent default', async () => {
  for (const args of [['--dest='], ['--dest', '']]) {
    const r = await run(['install-skill', ...args]);
    assert.equal(r.code, 2, JSON.stringify(args));
    assert.match(r.err, /empty value for/);
  }
});

test('a value after -- is taken as the destination', async () => {
  const dest = path.join(TMP, `dashdash-${++seq}`);
  const r = await run(['install-skill', '--', dest]);
  assert.equal(r.code, 0);
  assert.ok(fs.existsSync(path.join(dest, 'riffledesk', 'SKILL.md')));
});

test('a second differing install adds another backup instead of overwriting it', async () => {
  const first = await run(['install-skill']);
  const dir = installed(first.home);

  fs.writeFileSync(path.join(dir, 'SKILL.md'), 'first hand edit\n');
  assert.equal((await run(['install-skill'], first.home)).code, 0);

  fs.writeFileSync(path.join(dir, 'SKILL.md'), 'second hand edit\n');
  assert.equal((await run(['install-skill'], first.home)).code, 0);

  const root = backupRoot(first.home);
  const names = fs.readdirSync(root).sort();
  assert.equal(names.length, 2, 'both earlier copies are kept');
  const bodies = names.map(n => fs.readFileSync(path.join(root, n, 'SKILL.md'), 'utf8')).sort();
  assert.deepEqual(bodies, ['first hand edit\n', 'second hand edit\n']);
});

test('a legacy skills/riffledesk.bak is moved out of the skills folder', async () => {
  const first = await run(['install-skill']);
  assert.equal(first.code, 0, `first install failed: ${first.err}`);
  const skills = path.join(first.home, '.claude', 'skills');
  const legacy = path.join(skills, 'riffledesk.bak');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'SKILL.md'), 'old bak copy\n');

  const again = await run(['install-skill'], first.home);
  assert.equal(again.code, 0, `re-run failed: ${again.err}`);
  assert.match(again.out, /moved the old/);
  assert.deepEqual(fs.readdirSync(skills).sort(), ['riffledesk'], 'skills/ holds only the live skill');
  const root = backupRoot(first.home);
  const names = fs.readdirSync(root);
  assert.equal(names.length, 1);
  assert.equal(fs.readFileSync(path.join(root, names[0], 'SKILL.md'), 'utf8'), 'old bak copy\n');
});

test('backups are pruned to the newest few', async () => {
  const first = await run(['install-skill']);
  const dir = installed(first.home);
  for (let i = 0; i < 12; i++) {
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `edit ${i}\n`);
    assert.equal((await run(['install-skill'], first.home)).code, 0);
  }
  const names = fs.readdirSync(backupRoot(first.home));
  assert.ok(names.length <= 10, `expected at most 10 backups, got ${names.length}`);
  const bodies = names.map(n => fs.readFileSync(path.join(backupRoot(first.home), n, 'SKILL.md'), 'utf8'));
  assert.ok(bodies.includes('edit 11\n'), 'the newest backup survives');
});

test('missing --dest value and unknown options exit 2 with usage', async () => {
  const missing = await run(['install-skill', '--dest']);
  assert.equal(missing.code, 2);
  assert.match(missing.err, /missing value for --dest/);
  const junk = await run(['install-skill', '--wat']);
  assert.equal(junk.code, 2);
  assert.match(junk.err, /unknown option/);
  assert.match(junk.err, /usage: riffledesk install-skill/);
});

test('a plain file sitting at the target is replaced by the folder', async () => {
  const dest = path.join(TMP, `filetarget-${++seq}`);
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'riffledesk'), 'not a folder\n');
  const r = await run(['install-skill', '--dest', dest]);
  assert.equal(r.code, 0, `install failed: ${r.err}`);
  assert.ok(fs.statSync(path.join(dest, 'riffledesk')).isDirectory());
  assert.ok(fs.existsSync(path.join(dest, 'riffledesk', 'SKILL.md')));
});

test('top-level help lists install-skill', async () => {
  const r = await run(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /install-skill/);
});

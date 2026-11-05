// tests/hook.test.mjs — tests for `riffledesk hook install|uninstall|status|check`.
// Settings merges run against throwaway files / HOME dirs; `check` reads fixture
// transcripts in the real Claude Code JSONL shape. Usage: node --test tests/hook.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'riffledesk.js');
const require = createRequire(import.meta.url);
const hooklib = require(path.join(ROOT, 'bin', 'hook.js'));
let TMP;

before(() => { TMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'riffledesk-hook-')); });
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });

let seq = 0;
function fakeHome() {
  const dir = path.join(TMP, `home-${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// stdin is always ended (hook check reads it to EOF); every run gets a
// throwaway HOME so the real ~/.claude is never touched.
function run(args, { home = fakeHome(), stdin = null, envExtra = {} } = {}) {
  return new Promise(resolve => {
    const proc = spawn(process.execPath, [BIN, ...args], {
      cwd: TMP,
      env: { ...process.env, ...envExtra, HOME: home, USERPROFILE: home, RIFFLEDESK_BROWSER_CMD: 'definitely-not-a-browser' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    proc.on('close', code => resolve({ code, out, err, home }));
    if (stdin !== null) proc.stdin.write(stdin);
    proc.stdin.end();
  });
}

function settingsFile() {
  const f = path.join(TMP, `settings-${++seq}.json`);
  return f;
}

// --- transcript fixtures in the Claude Code JSONL shape ---

const userText = text => JSON.stringify({
  type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }
});
const toolResult = () => JSON.stringify({
  type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }
});
const writeCall = (fp, name = 'Write') => JSON.stringify({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id: `w${++seq}`, name, input: { file_path: fp } }] }
});
const bashCall = (command, name = 'Bash') => JSON.stringify({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id: `b${++seq}`, name, input: { command } }] }
});

function transcript(lines) {
  const tp = path.join(TMP, `transcript-${++seq}.jsonl`);
  fs.writeFileSync(tp, lines.join('\n') + '\n');
  return tp;
}

function realFile(name, body = '# report\n') {
  // each file in its own folder so the basename stays literal (exclusion rules
  // match on basenames like AGENTS.md / README*.md)
  const dir = path.join(TMP, `files-${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
}

function runCheck(payload, home) {
  return run(['hook', 'check'], { home, stdin: JSON.stringify(payload === undefined ? {} : payload) });
}

function blocked(r) {
  assert.equal(r.code, 0, `exit code, stderr: ${r.err}`);
  let data = null;
  try { data = JSON.parse(r.out); } catch (_) {}
  assert.ok(data && data.decision === 'block', `expected a block decision, got stdout: ${JSON.stringify(r.out)}`);
  assert.equal(typeof data.reason, 'string');
  return data;
}

function silent(r) {
  assert.equal(r.code, 0, `exit code, stderr: ${r.err}`);
  assert.equal(r.out.trim(), '', `expected no output, got: ${JSON.stringify(r.out)}`);
}

// ---------- install ----------

test('install --help exits 0 and documents the subcommands', async () => {
  const r = await run(['hook', '--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /hook install/);
  assert.match(r.out, /hook uninstall/);
  assert.match(r.out, /hook check/);
  assert.match(r.out, /--settings/);
});

test('install into a fresh settings file creates hooks.Stop with a node command', async () => {
  const f = settingsFile();
  const r = await run(['hook', 'install', '--settings', f]);
  assert.equal(r.code, 0, `install failed: ${r.err}`);
  assert.match(r.out, /installed/);
  const data = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.ok(Array.isArray(data.hooks.Stop));
  const entry = data.hooks.Stop.at(-1);
  assert.equal(entry.matcher, '');
  assert.equal(entry.hooks.length, 1);
  assert.equal(entry.hooks[0].type, 'command');
  const cmd = entry.hooks[0].command;
  // absolute node path everywhere; on Windows this is the required form (no sh shim)
  assert.match(cmd, /^node "[^"]+" hook check$/);
  assert.ok(cmd.includes(BIN), `command should point at ${BIN}, got: ${cmd}`);
  assert.equal(fs.existsSync(`${f}.bak`), false, 'no .bak when the file did not exist before');
});

test('install defaults to <home>/.claude/settings.json', async () => {
  const home = fakeHome();
  const r = await run(['hook', 'install'], { home });
  assert.equal(r.code, 0, `install failed: ${r.err}`);
  const f = path.join(home, '.claude', 'settings.json');
  assert.ok(fs.existsSync(f));
  const data = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.ok(data.hooks.Stop.length >= 1);
});

test('install preserves other keys and existing hooks, and writes a .bak', async () => {
  const f = settingsFile();
  const before_ = {
    model: 'opus',
    env: { FOO: 'bar' },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'pretool-guard' }] }],
      Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'echo other-stop' }] }]
    }
  };
  fs.writeFileSync(f, JSON.stringify(before_, null, 2));

  const r = await run(['hook', 'install', '--settings', f]);
  assert.equal(r.code, 0, `install failed: ${r.err}`);

  const bak = JSON.parse(fs.readFileSync(`${f}.bak`, 'utf8'));
  assert.deepEqual(bak, before_, '.bak holds the pre-install contents');

  const data = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(data.model, 'opus');
  assert.deepEqual(data.env, { FOO: 'bar' });
  assert.deepEqual(data.hooks.PreToolUse, before_.hooks.PreToolUse);
  assert.equal(data.hooks.Stop.length, 2);
  assert.equal(data.hooks.Stop[0].hooks[0].command, 'echo other-stop');
  assert.match(data.hooks.Stop[1].hooks[0].command, /hook check$/);
});

test('install is idempotent: a second run changes nothing', async () => {
  const f = settingsFile();
  assert.equal((await run(['hook', 'install', '--settings', f])).code, 0);
  const first = fs.readFileSync(f, 'utf8');
  const again = await run(['hook', 'install', '--settings', f]);
  assert.equal(again.code, 0);
  assert.match(again.out, /already installed/);
  assert.equal(fs.readFileSync(f, 'utf8'), first, 'file untouched on the second run');
  assert.equal(fs.existsSync(`${f}.bak`), false, 'no .bak when nothing changed');
});

test('install refuses a settings file that is not valid JSON (exit 2, file kept)', async () => {
  const f = settingsFile();
  const original = 'this is { not json';
  fs.writeFileSync(f, original);
  const r = await run(['hook', 'install', '--settings', f]);
  assert.equal(r.code, 2);
  assert.match(r.err, /not valid JSON/);
  assert.match(r.err, /nothing was written/);
  assert.equal(fs.readFileSync(f, 'utf8'), original, 'the broken file is left alone');
  assert.equal(fs.existsSync(`${f}.bak`), false);
});

test('install refuses a settings file whose root is a JSON array', async () => {
  const f = settingsFile();
  fs.writeFileSync(f, '[1, 2, 3]');
  const r = await run(['hook', 'install', '--settings', f]);
  assert.equal(r.code, 2);
  assert.match(r.err, /not valid JSON/);
  assert.equal(fs.readFileSync(f, 'utf8'), '[1, 2, 3]');
});

test('install refuses a wrongly-shaped hooks.Stop instead of clobbering it', async () => {
  const f = settingsFile();
  const original = { hooks: { Stop: { not: 'an array' } } };
  fs.writeFileSync(f, JSON.stringify(original));
  const r = await run(['hook', 'install', '--settings', f]);
  assert.equal(r.code, 2);
  assert.match(r.err, /unexpected shape/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), original);
});

test('install tolerates a UTF-8 BOM in the settings file', async () => {
  const f = settingsFile();
  fs.writeFileSync(f, '﻿' + JSON.stringify({ keep: 1 }));
  const r = await run(['hook', 'install', '--settings', f]);
  assert.equal(r.code, 0, `install failed: ${r.err}`);
  const data = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(data.keep, 1);
  assert.ok(Array.isArray(data.hooks.Stop));
});

test('install honors CLAUDE_CONFIG_DIR over ~/.claude', async () => {
  const home = fakeHome();
  const cfg = path.join(TMP, `cfg-${++seq}`);
  const r = await run(['hook', 'install'], { home, envExtra: { CLAUDE_CONFIG_DIR: cfg } });
  assert.equal(r.code, 0, `install failed: ${r.err}`);
  assert.ok(fs.existsSync(path.join(cfg, 'settings.json')), 'settings written under CLAUDE_CONFIG_DIR');
  assert.equal(fs.existsSync(path.join(home, '.claude', 'settings.json')), false, 'not under ~/.claude');
});

test('install then uninstall keeps the pre-install .bak (first backup wins)', async () => {
  const f = settingsFile();
  const original = { model: 'opus' };
  fs.writeFileSync(f, JSON.stringify(original));
  assert.equal((await run(['hook', 'install', '--settings', f])).code, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${f}.bak`, 'utf8')), original, '.bak after install');
  assert.equal((await run(['hook', 'uninstall', '--settings', f])).code, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${f}.bak`, 'utf8')), original,
    'uninstall must not overwrite the pre-install .bak with the hooked state');
});

test('install through a symlinked settings file writes the real target', async () => {
  const target = path.join(TMP, `real-settings-${++seq}.json`);
  const link = settingsFile();
  fs.writeFileSync(target, JSON.stringify({ keep: 1 }));
  try { fs.symlinkSync(target, link); } catch (err) {
    // Windows without developer mode / privileges cannot create symlinks
    assert.ok(['EPERM', 'EACCES', 'ENOSYS'].includes(err.code), err.message);
    return;
  }
  const r = await run(['hook', 'install', '--settings', link]);
  assert.equal(r.code, 0, `install failed: ${r.err}`);
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the symlink itself survives');
  const data = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.ok(Array.isArray(data.hooks.Stop), 'the hook landed in the real target');
});

// ---------- uninstall / status ----------

test('uninstall removes exactly our entry and keeps everything else', async () => {
  const f = settingsFile();
  fs.writeFileSync(f, JSON.stringify({
    keep: true,
    hooks: {
      Stop: [
        { matcher: '', hooks: [{ type: 'command', command: 'echo other-stop' }] },
        { matcher: '', hooks: [{ type: 'command', command: hooklib.hookCommand(BIN) }] }
      ],
      PostToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'echo post' }] }]
    }
  }, null, 2));

  const r = await run(['hook', 'uninstall', '--settings', f]);
  assert.equal(r.code, 0, `uninstall failed: ${r.err}`);
  assert.match(r.out, /removed/);

  const data = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(data.keep, true);
  assert.equal(data.hooks.Stop.length, 1);
  assert.equal(data.hooks.Stop[0].hooks[0].command, 'echo other-stop');
  assert.ok(Array.isArray(data.hooks.PostToolUse));
  assert.ok(fs.existsSync(`${f}.bak`), 'a .bak of the pre-uninstall file exists');

  const again = await run(['hook', 'uninstall', '--settings', f]);
  assert.equal(again.code, 0);
  assert.match(again.out, /not installed — nothing removed/);
});

test('uninstall with no settings file reports not installed, exit 0', async () => {
  const r = await run(['hook', 'uninstall', '--settings', settingsFile()]);
  assert.equal(r.code, 0);
  assert.match(r.out, /not installed/);
});

test('status prints installed / not installed with exit codes 0 / 1', async () => {
  const f = settingsFile();
  const none = await run(['hook', 'status', '--settings', f]);
  assert.equal(none.code, 1);
  assert.match(none.out, /not installed/);

  assert.equal((await run(['hook', 'install', '--settings', f])).code, 0);
  const yes = await run(['hook', 'status', '--settings', f]);
  assert.equal(yes.code, 0);
  assert.match(yes.out, /^installed/);
});

test('status on an unreadable settings file says not installed with a warning', async () => {
  const f = settingsFile();
  fs.writeFileSync(f, '{ nope');
  const r = await run(['hook', 'status', '--settings', f]);
  assert.equal(r.code, 1);
  assert.match(r.out, /not installed/);
  assert.match(r.err, /warning/);
});

test('unknown hook subcommand and unknown option exit 2 with usage', async () => {
  const sub = await run(['hook', 'frobnicate']);
  assert.equal(sub.code, 2);
  assert.match(sub.err, /unknown hook command/);
  const opt = await run(['hook', 'install', '--wat']);
  assert.equal(opt.code, 2);
  assert.match(opt.err, /unknown option/);
});

test('top-level help lists hook', async () => {
  const r = await run(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /riffledesk hook/);
});

// ---------- check ----------

test('check blocks when a deliverable .md was written and never shown', async () => {
  const report = realFile('report.md');
  const tp = transcript([userText('write me a report'), writeCall(report)]);
  const r = await runCheck({ session_id: 's1', transcript_path: tp, stop_hook_active: false });
  const data = blocked(r);
  assert.ok(data.reason.includes(report), 'reason lists the file');
  assert.match(data.reason, /riffledesk open "/);
  assert.match(data.reason, /not deliverables/);
});

test('check shows a show-style command when several files are pending', async () => {
  const a = realFile('a.md');
  const b = realFile('b.html');
  const tp = transcript([userText('make both'), writeCall(a), writeCall(b)]);
  const r = await runCheck({ session_id: 's2', transcript_path: tp, stop_hook_active: false });
  const data = blocked(r);
  assert.match(data.reason, /riffledesk show /);
  assert.match(data.reason, /--title/);
  assert.ok(data.reason.includes(a) && data.reason.includes(b));
});

test('check is silent when a riffledesk open/show call happened in the same span', async () => {
  for (const call of [
    `riffledesk open "x.md"`,
    `riffledesk.cmd show a.md b.md --title "t"`,
    `node "D:\\tools\\riffledesk.js" open x.md`
  ]) {
    const report = realFile('shown.md');
    const tp = transcript([userText('write and show'), writeCall(report), toolResult(), bashCall(call)]);
    const r = await runCheck({ session_id: 's3', transcript_path: tp, stop_hook_active: false });
    silent(r);
  }
});

test('an open/show before the last user message does not cover later writes', async () => {
  const report = realFile('fresh.md');
  const tp = transcript([
    bashCall('riffledesk open old.md'),
    userText('now write a fresh report'),
    writeCall(report)
  ]);
  const r = await runCheck({ session_id: 's4', transcript_path: tp, stop_hook_active: false });
  blocked(r);
});

test('check is silent when stop_hook_active is true (never loops)', async () => {
  const report = realFile('loop.md');
  const tp = transcript([userText('write'), writeCall(report)]);
  const r = await runCheck({ session_id: 's5', transcript_path: tp, stop_hook_active: true });
  silent(r);
});

test('check is silent for excluded paths and non-deliverable writes', async () => {
  const home = fakeHome();
  const underClaude = path.join(home, '.claude', 'scratch.md');
  fs.mkdirSync(path.dirname(underClaude), { recursive: true });
  fs.writeFileSync(underClaude, 'x\n');
  const nodeModules = path.join(TMP, 'nm', 'node_modules', 'pkg');
  fs.mkdirSync(nodeModules, { recursive: true });
  const inNm = path.join(nodeModules, 'README-extra.md');
  fs.writeFileSync(inNm, 'x\n');
  const gitDir = path.join(TMP, 'repo', '.git');
  fs.mkdirSync(gitDir, { recursive: true });
  const inGit = path.join(gitDir, 'COMMIT_EDITMSG.md');
  fs.writeFileSync(inGit, 'x\n');
  const agents = realFile('AGENTS.md');
  const changelog = realFile('CHANGELOG.md');
  const readme = realFile('README.zh-TW.md');
  const code = realFile('tool.js');
  const ghost = path.join(TMP, `ghost-${++seq}.md`);   // never created

  const tp = transcript([
    userText('write lots of stuff'),
    writeCall(underClaude), writeCall(inNm), writeCall(inGit),
    writeCall(agents), writeCall(changelog), writeCall(readme),
    writeCall(code), writeCall(ghost)
  ]);
  const r = await runCheck({ session_id: 's6', transcript_path: tp, stop_hook_active: false }, home);
  silent(r);
});

test('check counts Edit and NotebookEdit writes too', async () => {
  const page = realFile('page.html');
  const tp = transcript([userText('edit the page'), writeCall(page, 'Edit'), writeCall(page, 'NotebookEdit')]);
  const r = await runCheck({ session_id: 's7', transcript_path: tp, stop_hook_active: false });
  const data = blocked(r);
  // the same file appears once (listed once, and named once more in the command)
  assert.equal(data.reason.split(page).length - 1, 2, 'path appears exactly twice (list + command)');
});

test('check is silent on garbage stdin, missing fields and a missing transcript', async () => {
  const garbage = await run(['hook', 'check'], { stdin: 'this is not json at all' });
  silent(garbage);
  const empty = await run(['hook', 'check'], { stdin: '' });
  silent(empty);
  const noPath = await runCheck({ session_id: 's8', stop_hook_active: false });
  silent(noPath);
  const gone = await runCheck({ session_id: 's9', transcript_path: path.join(TMP, 'no-such.jsonl'), stop_hook_active: false });
  silent(gone);
});

test('check lists at most 5 paths in the reason', async () => {
  const files = [];
  const calls = [userText('write eight files')];
  for (let i = 0; i < 8; i++) {
    files.push(realFile(`f${i}.md`));
    calls.push(writeCall(files[i]));
  }
  const tp = transcript(calls);
  const r = await runCheck({ session_id: 's10', transcript_path: tp, stop_hook_active: false });
  const data = blocked(r);
  assert.match(data.reason, /\+3 more/);
  assert.ok(!data.reason.includes(files[7]), 'the 8th path is not listed');
});

// ---------- timing ----------

test('analysis stays fast on a ~20MB transcript (reads only the tail)', () => {
  const dir = path.join(TMP, `big-${++seq}`);
  fs.mkdirSync(dir);
  const report = path.join(dir, 'big-report.md');
  fs.writeFileSync(report, '# report\n');
  const tp = path.join(dir, 'big.jsonl');

  const filler = JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(200) }] }
  }) + '\n';
  const target = 20 * 1024 * 1024;
  const chunk = filler.repeat(1000);
  const chunkBytes = Buffer.byteLength(chunk);
  const fd = fs.openSync(tp, 'w');
  let size = 0;
  while (size < target) { fs.writeSync(fd, chunk); size += chunkBytes; }
  // the decisive part sits at the very end, inside the 2 MB tail window
  fs.writeSync(fd, userText('write the report') + '\n' + writeCall(report) + '\n');
  fs.closeSync(fd);
  assert.ok(fs.statSync(tp).size >= target);

  const t0 = performance.now();
  const tail = hooklib.readTail(tp);
  const { files, shown } = hooklib.analyzeTail(tail);
  const kept = hooklib.deliverableFiles(files, { claudeDir: path.join(dir, 'no-such-home', '.claude') });
  const ms = performance.now() - t0;

  assert.equal(shown, false);
  assert.deepEqual(kept, [report], 'the tail reaches the last user turn and the write');
  assert.ok(ms < 300, `tail analysis took ${ms.toFixed(1)} ms (budget 300 ms)`);
});

// ---------- library-level edge cases (in-process, no spawn cost) ----------

test('a user tool_result does not reset the span; a string user content does', () => {
  const lines = [
    userText('first request'),
    writeCall('D:/work/a.md'),
    toolResult(),
    writeCall('D:/work/b.md'),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'second request (string form)' } }),
    writeCall('D:/work/c.md')
  ].join('\n');
  const { files } = hooklib.analyzeTail(lines);
  assert.deepEqual(files, ['D:/work/c.md'], 'string user content starts a new span');

  const noUser = [writeCall('D:/work/x.md'), toolResult(), writeCall('D:/work/y.md')].join('\n');
  assert.deepEqual(hooklib.analyzeTail(noUser).files, ['D:/work/x.md', 'D:/work/y.md'],
    'without any genuine user message the whole tail is in scope');
});

test('hookCommand matches the idempotency regex, status finds its own entry', () => {
  const cmd = hooklib.hookCommand(BIN);
  assert.ok(hooklib.HOOK_CMD_RE.test(cmd), `installed command is recognized: ${cmd}`);
  assert.ok(hooklib.HOOK_CMD_RE.test('riffledesk hook check'), 'bare form recognized');
  assert.ok(hooklib.HOOK_CMD_RE.test('riffledesk.cmd hook check'), '.cmd form recognized');
  assert.ok(!hooklib.HOOK_CMD_RE.test('riffledesk open a.md'), 'open is not the hook');
  assert.ok(!hooklib.HOOK_CMD_RE.test('xriffledesk hook check'), 'a lookalike prefix must not match');
  assert.ok(!hooklib.HOOK_CMD_RE.test('riffledesk hook checkpoint'), 'a longer subcommand must not match');
});

test('meta entries and command wrappers do not reset the span', () => {
  const lines = [
    userText('real request'),
    writeCall('D:/work/a.md'),
    JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: 'slash wrapper text' } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: '<local-command-stdout>done</local-command-stdout>' } }),
    toolResult(),
    writeCall('D:/work/b.md')
  ].join('\n');
  assert.deepEqual(hooklib.analyzeTail(lines).files, ['D:/work/a.md', 'D:/work/b.md'],
    'meta/stdout entries are not a user boundary');
});

test('MultiEdit file_path and NotebookEdit notebook_path are collected', () => {
  const lines = [
    userText('go'),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'm1', name: 'MultiEdit', input: { file_path: 'D:/work/multi.md' } }
    ] } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'n1', name: 'NotebookEdit', input: { notebook_path: 'D:/work/nb.md' } }
    ] } })
  ].join('\n');
  assert.deepEqual(hooklib.analyzeTail(lines).files, ['D:/work/multi.md', 'D:/work/nb.md']);
});

test('a directory named x.md is not a deliverable (regular files only)', () => {
  const dir = path.join(TMP, `dirmd-${++seq}`, 'fake.md');
  fs.mkdirSync(dir, { recursive: true });
  const kept = hooklib.deliverableFiles([dir], { claudeDir: path.join(TMP, 'nope', '.claude') });
  assert.deepEqual(kept, []);
});

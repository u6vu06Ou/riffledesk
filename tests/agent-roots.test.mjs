// tests/agent-roots.test.mjs — folders where an AI agent worked become index roots
// automatically. Every cheap session adapter gets an isolated fake-HOME fixture; no test
// reads the real agent/editor directories. A new Copilot session AFTER boot must be found
// by the watcher (no polling timer in discovery). Port 5194, reused by the opt-out server.
// Usage: node --test tests/agent-roots.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentroots = createRequire(import.meta.url)('../agentroots.js');
const PORT = 5194;
const OFF_PORT = PORT;
const BASE = `http://127.0.0.1:${PORT}`;

const TMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'riffledesk-agentroots-'));
const HOME = path.join(TMP, 'home');
const APPDATA = path.join(HOME, 'fake-appdata');
const WORK = path.join(TMP, 'work');
const OFFWORK = path.join(TMP, 'offwork');
fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(OFFWORK, { recursive: true });
fs.writeFileSync(path.join(WORK, 'agent-made.md'), 'the quokkaword artifact lives here\n');
fs.writeFileSync(path.join(OFFWORK, 'off-made.md'), 'the pangolinword artifact lives here\n');

function workspace(name) {
  const dir = path.join(TMP, 'new-sources', name, 'project');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function put(rel, text) {
  const abs = path.join(HOME, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  return abs;
}
function firstJsonl(rel, cwd, extra = {}) {
  put(rel, JSON.stringify({ cwd, ...extra }) + '\n' + JSON.stringify({ token: 'fixture-not-read' }) + '\n');
}

// Existing Claude coverage, including the two generic path filters.
function session(slug, cwd) {
  const dir = path.join(HOME, '.claude', 'projects', slug);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: 'user', cwd, sessionId: slug, message: { role: 'user', content: 'hello' } }),
    JSON.stringify({ type: 'assistant', cwd, sessionId: slug, message: { content: [{ type: 'text', text: 'hi' }] } })
  ];
  fs.writeFileSync(path.join(dir, slug + '.jsonl'), lines.join('\n') + '\n');
}
session('work-slug', WORK);
session('home-slug', HOME);
session('root-slug', path.parse(TMP).root);

const PROJECTS = {};

// 1. Gemini CLI: plain-text project roots in both supported parent folders. File URIs
// must decode; its tmp/temp/user slugs are noise even when their target exists.
PROJECTS.gemini = workspace('gemini');
put(path.join('.gemini', 'tmp', 'gemini-project', '.project_root'), pathToFileURL(PROJECTS.gemini).href);
const GEMINI_NOISE = workspace('gemini-noise');
put(path.join('.gemini', 'history', 'user', '.project_root'), GEMINI_NOISE + '\n');

// 2. Antigravity CLI: newest JSONL history entries carry `workspace`.
PROJECTS.antigravity = workspace('antigravity');
put(path.join('.gemini', 'antigravity-cli', 'history.jsonl'),
  '{bad json}\n' + JSON.stringify({ workspace: PROJECTS.antigravity, token: 'fixture-not-read' }) + '\n');

// 3. Grok CLI: URL-encoded session group name (a .cwd marker is also supported).
PROJECTS.grok = workspace('grok');
put(path.join('.grok', 'sessions', encodeURIComponent(PROJECTS.grok), 'updates.jsonl'), '{}\n');

// 4. Copilot CLI: only the cwd scalar in workspace.yaml is used.
PROJECTS.copilot = workspace('copilot');
put(path.join('.copilot', 'session-state', 'initial', 'workspace.yaml'),
  `cwd: '${PROJECTS.copilot}'\ngit_root: '${TMP}'\ntoken: fixture-not-read\n`);

// 5. Factory Droid: the first JSONL record of each session.
PROJECTS.factory = workspace('factory');
firstJsonl(path.join('.factory', 'sessions', 'project-key', 'session.jsonl'), PROJECTS.factory, { type: 'session_start' });

// 6. Qwen Code: the first chat record, not the lossy project directory name.
PROJECTS.qwen = workspace('qwen');
firstJsonl(path.join('.qwen', 'projects', 'lossy-project-name', 'chats', 'chat.jsonl'), PROJECTS.qwen);

// 7. Continue: workspaceDirectory in the sessions index array.
PROJECTS.continue = workspace('continue');
put(path.join('.continue', 'sessions', 'sessions.json'), JSON.stringify([
  { workspaceDirectory: PROJECTS.continue }, { workspaceDirectory: path.join(TMP, 'does-not-exist') }
]));

// 8. Amp: cwd in the bounded tail of history.jsonl.
PROJECTS.amp = workspace('amp');
put(path.join('.local', 'share', 'amp', 'history.jsonl'), JSON.stringify({ cwd: PROJECTS.amp }) + '\n');

// 9. Cline CLI: newest JSON session records below CLINE_DATA_DIR's default location.
PROJECTS.clineCli = workspace('cline-cli');
put(path.join('.cline', 'data', 'sessions', 'one', 'session.json'),
  JSON.stringify({ cwd: PROJECTS.clineCli, apiKey: 'fixture-not-read' }));

// 10. Roo Code and the Cline extension across VS Code-family globalStorage.
PROJECTS.roo = workspace('roo-extension');
const storage = path.join(APPDATA, 'Code', 'User', 'globalStorage');
const rooIndex = path.join(storage, 'rooveterinaryinc.roo-cline', 'tasks', '_index.json');
fs.mkdirSync(path.dirname(rooIndex), { recursive: true });
fs.writeFileSync(rooIndex, JSON.stringify({ entries: [{ workspace: PROJECTS.roo }] }));
PROJECTS.clineExtension = workspace('cline-extension');
put(path.relative(HOME, path.join(storage, 'saoudrizwan.claude-dev', 'sessions', 'one', 'one.json')),
  JSON.stringify({ cwd: PROJECTS.clineExtension }));

const DRIVES = [TMP, process.env.RIFFLEDESK_TEST_DRIVES].filter(Boolean).join(path.delimiter);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeServer(port, cfgName, cfg) {
  const cfgPath = path.join(TMP, cfgName);
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const env = {
    ...process.env, NODE_ENV: 'test', PORT: String(port), FLODER_CONFIG: cfgPath,
    RIFFLEDESK_TEST_DRIVES: DRIVES, RIFFLEDESK_AGENT_HOME: HOME,
    RIFFLEDESK_AGENT_APPDATA: APPDATA
  };
  for (const key of ['COPILOT_HOME', 'FACTORY_HOME_OVERRIDE', 'CLINE_DATA_DIR', 'GROK_HOME', 'CONTINUE_GLOBAL_DIR', 'GEMINI_CLI_HOME']) delete env[key];
  const proc = spawn('node', ['server.js'], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  const st = { proc, out: '' };
  proc.stdout.on('data', d => { st.out += d; });
  proc.stderr.on('data', d => { st.out += d; });
  return st;
}

const main = makeServer(PORT, 'config.json', { roots: [], pinned: [] });
let off = null; // started lazily: both bind the same port, the first one has to be gone

async function stop(st) {
  try { st.proc.kill(); } catch (_) {}
  await Promise.race([new Promise(r => st.proc.once('exit', r)), sleep(3000)]);
}

async function waitListening(st, base) {
  const t0 = Date.now();
  while (!st.out.includes('listening')) {
    if (st.proc.exitCode !== null) throw new Error('server exited early: ' + st.out);
    if (Date.now() - t0 > 15000) throw new Error('server start timeout: ' + st.out);
    await sleep(25);
  }
  assert.ok(base);
}

async function getJson(base, p) {
  const res = await fetch(base + p);
  return { status: res.status, body: await res.json() };
}

// wait until the original workspace root has been crawled (its file rows exist)
async function waitIndexed(base, fileWord) {
  const t0 = Date.now();
  let body;
  for (;;) {
    ({ body } = await getJson(base, '/api/index/status'));
    if (body.ok && body.available && body.lastCrawlAt && !body.crawling && body.files > 0) {
      const s = await getJson(base, `/api/search?path=${encodeURIComponent(WORK)}&q=${fileWord}`);
      if (s.body.indexed) return body;
    }
    if (Date.now() - t0 > 40000) throw new Error('index never crawled: ' + JSON.stringify(body) + ' / ' + st0Log());
    await sleep(120);
  }
}
const st0Log = () => main.out + '\n---\n' + (off ? off.out : '');

after(async () => {
  await stop(main);
  if (off) await stop(off);
  await sleep(300);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test('workspace records cannot inject relative, control-character or network paths', () => {
  const candidates = ['relative/project', '.', '..', 'file://example.invalid/share', 'file://example.invalid/%00'];
  if (process.platform === 'win32') candidates.push('\\\\server\\share', '\\\\?\\Volume{1234}\\');
  const found = agentroots.discover({ home: HOME, cwds: candidates, isAllowed: () => true });
  assert.deepEqual(found, []);
});

test('agent workspaces become index roots', async (t) => {
  await waitListening(main, BASE);
  const status = await waitIndexed(BASE, 'quokkaword');
  const resolvedRoots = status.agentRoots.map(r => path.resolve(r));

  await t.test('the original Claude session cwd shows up in status.agentRoots', () => {
    assert.ok(Array.isArray(status.agentRoots));
    assert.ok(resolvedRoots.includes(path.resolve(WORK)), 'agentRoots=' + JSON.stringify(status.agentRoots));
    assert.ok(status.roots.map(r => path.resolve(r)).includes(path.resolve(WORK)),
      'agent root must also be an index root');
  });

  for (const [source, project] of Object.entries(PROJECTS)) {
    await t.test(`new source ${source} contributes its project`, () => {
      assert.ok(resolvedRoots.includes(path.resolve(project)),
        `${source}: ${project} missing from ${JSON.stringify(status.agentRoots)}`);
    });
  }

  await t.test('home, filesystem root, missing paths and Gemini noise slugs are ignored', () => {
    const lower = resolvedRoots.map(r => r.toLowerCase());
    assert.ok(!lower.includes(path.resolve(HOME).toLowerCase()));
    assert.ok(!resolvedRoots.some(r => r === path.parse(TMP).root));
    assert.ok(!lower.includes(path.resolve(GEMINI_NOISE).toLowerCase()));
    assert.ok(!resolvedRoots.some(r => r === path.join(TMP, 'does-not-exist')));
  });

  await t.test('a file in the agent workspace is findable through the index', async () => {
    const { status: code, body } = await getJson(BASE, `/api/search?path=${encodeURIComponent(WORK)}&q=quokkaword`);
    assert.equal(code, 200);
    assert.equal(body.indexed, true);
    assert.ok(body.files.some(f => f.name === 'agent-made.md'), JSON.stringify(body.files));
  });

  await t.test('a new-source session created after boot is picked up by the watcher', async () => {
    const LATE = workspace('copilot-late');
    fs.writeFileSync(path.join(LATE, 'late-made.md'), 'the narwhalword artifact lives here\n');
    put(path.join('.copilot', 'session-state', 'late', 'workspace.yaml'), `cwd: '${LATE}'\n`);
    const t0 = Date.now();
    let body;
    for (;;) {
      ({ body } = await getJson(BASE, '/api/index/status'));
      if (body.agentRoots.map(r => path.resolve(r)).includes(path.resolve(LATE))) {
        const s = await getJson(BASE, `/api/search?path=${encodeURIComponent(LATE)}&q=narwhalword`);
        if (s.body.indexed && s.body.files.some(f => f.name === 'late-made.md')) return;
      }
      if (Date.now() - t0 > 45000) throw new Error('late session never indexed: ' + JSON.stringify(body) + ' / ' + main.out);
      await sleep(200);
    }
  });

  await t.test('indexAgentRoots:false leaves the workspaces out', async () => {
    await stop(main);
    off = makeServer(OFF_PORT, 'config-off.json', { roots: [], pinned: [], indexAgentRoots: false });
    await waitListening(off, `http://127.0.0.1:${OFF_PORT}`);
    await sleep(500);
    const { body } = await getJson(`http://127.0.0.1:${OFF_PORT}`, '/api/index/status');
    assert.ok(Array.isArray(body.agentRoots));
    assert.deepEqual(body.agentRoots, []);
    assert.ok(!body.roots.map(r => path.resolve(r)).includes(path.resolve(WORK)));
  });
});

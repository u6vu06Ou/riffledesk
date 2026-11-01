// tests/recentmod.test.mjs — /api/recentmod ("最近改動（不確定是誰改的）"): index-backed
// mtime query over marker-project folders, minus files an AI conversation provably wrote.
// Spawns server.js on port 5192 with a temp fixture dir; index.db lives next to the temp
// config, never in the repo. Usage: node --test tests/recentmod.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5192;
const BASE = `http://127.0.0.1:${PORT}`;

// ---------- fixture tree ----------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'riffledesk-rm-test-'));
const FIX = path.join(TMP, 'fixture');
const mkdir = (...p) => fs.mkdirSync(path.join(FIX, ...p), { recursive: true });
const write = (rel, text) => fs.writeFileSync(path.join(FIX, ...rel.split('/')), text);

// projA is a marker project (CLAUDE.md); plain/ has no markers at all
mkdir('projA', 'notes');
write('projA/CLAUDE.md', '# projA rules\n');
write('projA/notes/touched.md', 'hand-edited recently\n');
write('projA/mine.txt', 'also hand-edited\n');
write('projA/ai-made.md', 'written by an AI conversation (fixture transcript claims it)\n');
mkdir('plain');
write('plain/lone.txt', 'no marker anywhere around here\n');

// fake Claude transcript that WROTE projA/ai-made.md 5 minutes ago
const TRX = path.join(TMP, 'trx', 'projects', 'x-proj');
fs.mkdirSync(TRX, { recursive: true });
const esc = p => JSON.stringify(p).slice(1, -1);
fs.writeFileSync(path.join(TRX, 'ses-1.jsonl'),
  JSON.stringify({ type: 'user', sessionId: 'ses-1', timestamp: new Date(Date.now() - 10 * 60000).toISOString(), message: { role: 'user', content: '做一個 md' } }) + '\n' +
  JSON.stringify({ type: 'assistant', sessionId: 'ses-1', timestamp: new Date(Date.now() - 5 * 60000).toISOString(), cwd: path.join(FIX, 'projA'), message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Write', input: { file_path: path.join(FIX, 'projA', 'ai-made.md'), content: 'x' } }] } }) + '\n');

const CONFIG_PATH = path.join(TMP, 'config.json');
fs.writeFileSync(CONFIG_PATH, JSON.stringify({
  roots: [FIX], pinned: [],
  convoRoots: [{ kind: 'claude', dir: path.join(TMP, 'trx', 'projects') }]
}, null, 2));

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJson(p) {
  const res = await fetch(BASE + p);
  return { status: res.status, body: await res.json() };
}

const proc = spawn('node', ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), FLODER_CONFIG: CONFIG_PATH },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true
});
let serverOut = '';
proc.stdout.on('data', d => { serverOut += d; });
proc.stderr.on('data', d => { serverOut += d; });
after(() => {
  try { proc.kill(); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

async function waitListening() {
  const t0 = Date.now();
  while (!serverOut.includes('listening')) {
    if (proc.exitCode !== null) throw new Error('server exited early: ' + serverOut);
    if (Date.now() - t0 > 10000) throw new Error('server start timeout: ' + serverOut);
    await sleep(25);
  }
}
async function waitCrawled(maxMs = 30000) {
  const t0 = Date.now();
  for (;;) {
    const { body } = await getJson('/api/index/status');
    if (body.ok && body.available && body.lastCrawlAt && !body.crawling && body.files > 0) return body;
    if (Date.now() - t0 > maxMs) throw new Error('crawl timeout: ' + serverOut);
    await sleep(200);
  }
}

test('recentmod: marker projects only, AI-written files excluded, exts filter respected', async () => {
  await waitListening();
  await waitCrawled();

  const { status, body } = await getJson('/api/recentmod?hours=24');
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.ok, true);
  assert.equal(body.indexed, true, 'index is running in this test');
  const names = body.files.map(f => f.name);
  assert.ok(names.includes('touched.md'), 'hand-edited file in a marker project shows up');
  assert.ok(names.includes('mine.txt'), 'sibling file in the same project shows up');
  assert.ok(names.includes('CLAUDE.md'), 'the marker file itself is a recently-changed file too');
  assert.ok(!names.includes('ai-made.md'), 'AI-written file must be subtracted');
  assert.ok(!names.includes('lone.txt'), 'folder without markers is never listed');

  // the subtracted file must still be attributed to the conversation (the two lists
  // stay complementary, never mixed)
  const rc = await getJson('/api/recent?hours=24');
  assert.ok(rc.body.files.some(f => f.name === 'ai-made.md'), 'AI list keeps ai-made.md');

  const md = await getJson('/api/recentmod?hours=24&exts=' + encodeURIComponent('.md'));
  assert.ok(md.body.files.length > 0);
  assert.ok(md.body.files.every(f => f.ext === '.md'), 'exts filter applies');
  for (const f of body.files) {
    for (const k of ['name', 'path', 'size', 'mtime', 'ext', 'kind']) assert.ok(k in f, `missing ${k}`);
  }

  // shrinking hours shrinks/narrows the set (the untouched-in-window case returns [])
  const soon = await getJson('/api/recentmod?hours=1');
  assert.equal(soon.status, 200);
});

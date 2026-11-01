// tests/convos-extra.test.mjs — parsers for the non-Claude/Codex tools added 2026-11-01:
// Gemini CLI (jsonl, legacy .json, subagent), Cline/Roo/Kilo (globalStorage tasks JSON),
// Pi (pi-mono), Grok Build (updates.jsonl). Pure scan-level: no server, no real user
// records — fixtures are invented templates in tests/fixtures/convos-extra/.
// Usage: node --test tests/convos-extra.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMPL_DIR = path.join(ROOT, 'tests', 'fixtures', 'convos-extra');
const require = createRequire(import.meta.url);
const convos = require(path.join(ROOT, 'convos.js'));

// ---------- sandbox ----------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'riffledesk-convos-extra-'));
const WRITTEN = path.join(TMP, 'written');
fs.mkdirSync(WRITTEN, { recursive: true });
const F = n => path.join(WRITTEN, n);
const mk = n => fs.writeFileSync(F(n), '#' + n + '\n');
for (const n of ['gem-a.md', 'gem-b.md', 'gem-c.md', 'gem-d.md',
  'cline-a.md', 'cline-b.md', 'cline-e.md',
  'roo-a.md', 'roo-b.md', 'kilo-a.md',
  'pi-a.md', 'pi-b.md',
  'grok-a.md', 'grok-b.md', 'grok-c.md', 'grok-e.md']) mk(n);
const GHOST = F('ghost2.md'); // named only INSIDE grok write content — must never be captured

const T = m => new Date(Date.now() - m * 60000).toISOString();        // minutes ago, ISO
const TS = m => Date.now() - m * 60000;                               // minutes ago, unix ms
const UX = m => Math.round((Date.now() - m * 60000) / 1000);          // minutes ago, unix s
const esc = p => JSON.stringify(p).slice(1, -1);

const fill = name => fs.readFileSync(path.join(TMPL_DIR, name), 'utf8')
  .replaceAll('@@CWD@@', esc(WRITTEN))
  .replaceAll('@@GEM_A@@', esc(F('gem-a.md'))).replaceAll('@@GEM_B@@', esc(F('gem-b.md')))
  .replaceAll('@@GEM_C@@', esc(F('gem-c.md'))).replaceAll('@@GEM_D@@', esc(F('gem-d.md')))
  .replaceAll('@@GEM_GHOST@@', esc(F('gem-ghost.md')))
  .replaceAll('@@CLINE_A@@', esc(F('cline-a.md'))).replaceAll('@@CLINE_B@@', esc(F('cline-b.md')))
  .replaceAll('@@CLINE_E@@', esc(F('cline-e.md'))).replaceAll('@@CLINE_READ@@', esc(F('cline-a.md')))
  .replaceAll('@@ROO_A@@', esc(F('roo-a.md'))).replaceAll('@@ROO_B@@', esc(F('roo-b.md')))
  .replaceAll('@@KILO_A@@', esc(F('kilo-a.md')))
  .replaceAll('@@PI_A@@', esc(F('pi-a.md'))).replaceAll('@@PI_B@@', esc(F('pi-b.md')))
  .replaceAll('@@GROK_A@@', esc(F('grok-a.md'))).replaceAll('@@GROK_B@@', esc(F('grok-b.md')))
  .replaceAll('@@GROK_C@@', esc(F('grok-c.md'))).replaceAll('@@GROK_E@@', esc(F('grok-e.md')))
  .replaceAll('@@T80@@', T(80)).replaceAll('@@T75@@', T(75)).replaceAll('@@T70@@', T(70))
  .replaceAll('@@T68@@', T(68)).replaceAll('@@T60@@', T(60)).replaceAll('@@T59@@', T(59))
  .replaceAll('@@T58@@', T(58)).replaceAll('@@T55@@', T(55)).replaceAll('@@T54@@', T(54))
  .replaceAll('@@T52@@', T(52)).replaceAll('@@T50@@', T(50))
  .replaceAll('@@TS70@@', String(TS(70))).replaceAll('@@TS68@@', String(TS(68)))
  .replaceAll('@@TS60@@', String(TS(60))).replaceAll('@@TS55@@', String(TS(55)))
  .replaceAll('@@TS54@@', String(TS(54))).replaceAll('@@TS52@@', String(TS(52)))
  .replaceAll('@@UX60@@', String(UX(60))).replaceAll('@@UX55@@', String(UX(55)))
  .replaceAll('@@UX52@@', String(UX(52))).replaceAll('@@UX50@@', String(UX(50)))
  .replaceAll('@@UX48@@', String(UX(48))).replaceAll('@@UX46@@', String(UX(46)));

// ---------- lay out fake transcript homes ----------
const GEM_TMP = path.join(TMP, 'gemini-home', 'tmp');
fs.mkdirSync(path.join(GEM_TMP, 'proj-demo', 'chats', 'gem-1'), { recursive: true });
fs.writeFileSync(path.join(GEM_TMP, 'proj-demo', 'chats', 'session-20261101T120000-ab12.jsonl'), fill('gemini-main.jsonl.tmpl'));
fs.writeFileSync(path.join(GEM_TMP, 'proj-demo', 'chats', 'session-20261031T000000-cd34.json'), fill('gemini-legacy.json.tmpl'));
fs.writeFileSync(path.join(GEM_TMP, 'proj-demo', 'chats', 'gem-1', 'sess-child.jsonl'), fill('gemini-subagent.jsonl.tmpl'));
// decoy: logs sit one level up and are NOT chats — must never be scanned
fs.writeFileSync(path.join(GEM_TMP, 'proj-demo', 'logs.json'),
  JSON.stringify({ sessionId: 'evil', messages: [{ type: 'gemini', toolCalls: [{ name: 'write_file', args: { file_path: F('gem-ghost.md') } }] }] }));

const GS = path.join(TMP, 'vscode', 'User', 'globalStorage');
const CLINE_TASKS = path.join(GS, 'saoudrizwan.claude-dev', 'tasks');
const ROO_TASKS = path.join(GS, 'rooveterinaryinc.roo-cline', 'tasks');
const KILO_TASKS = path.join(GS, 'kilocode.kilo-code', 'tasks');
fs.mkdirSync(path.join(CLINE_TASKS, '5001'), { recursive: true });
fs.writeFileSync(path.join(CLINE_TASKS, '5001', 'api_conversation_history.json'), fill('cline-task.json.tmpl'));
fs.writeFileSync(path.join(CLINE_TASKS, '5001', 'ui_messages.json'), '[]');   // never parsed
fs.writeFileSync(path.join(CLINE_TASKS, '9002.json'), fill('cline-legacy.json.tmpl'));
fs.mkdirSync(path.join(ROO_TASKS, '6001'), { recursive: true });
fs.writeFileSync(path.join(ROO_TASKS, '6001', 'api_conversation_history.json'), fill('roo-task.json.tmpl'));
fs.mkdirSync(path.join(KILO_TASKS, '7001'), { recursive: true });
fs.writeFileSync(path.join(KILO_TASKS, '7001', 'api_conversation_history.json'), fill('kilo-task.json.tmpl'));

const PI_SESS = path.join(TMP, 'pi-home', 'agent', 'sessions', '--d--workspace-proj--');
fs.mkdirSync(PI_SESS, { recursive: true });
fs.writeFileSync(path.join(PI_SESS, '2026-11-01T12-00-00_1111.jsonl'), fill('pi-session.jsonl.tmpl'));

const GROK_SESS = path.join(TMP, 'grok-home', 'sessions', '-d--workspace-proj', 'sess-001');
fs.mkdirSync(GROK_SESS, { recursive: true });
fs.writeFileSync(path.join(GROK_SESS, 'updates.jsonl'), fill('grok-updates.jsonl.tmpl'));
fs.writeFileSync(path.join(GROK_SESS, 'summary.json'), JSON.stringify({ title: 'Grok 產生報表腳本', model: 'grok-4' }));

const ROOTS = [
  { kind: 'gemini', dir: GEM_TMP },
  { kind: 'cline', dir: CLINE_TASKS },
  { kind: 'roo', dir: ROO_TASKS },
  { kind: 'kilo', dir: KILO_TASKS },
  { kind: 'pi', dir: path.join(TMP, 'pi-home', 'agent', 'sessions') },
  { kind: 'grok', dir: path.join(TMP, 'grok-home', 'sessions') }
];

after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });

let scanResult = null;
test('scan finds every new kind of transcript home', async () => {
  scanResult = await convos.scan({ roots: ROOTS, minUpdatedMs: 0 });
  assert.ok(scanResult.convos.length >= 9, JSON.stringify(scanResult.convos.map(c => convos.mergeId(c))));
});

function convo(id) {
  const c = scanResult.convos.find(x => convos.mergeId(x) === id);
  assert.ok(c, 'missing conversation ' + id);
  return c;
}
const names = c => c.files.map(f => f.path.toLowerCase());
const has = (c, p) => names(c).some(x => x.endsWith(p.toLowerCase()));

test('gemini: jsonl main session, legacy .json, subagent flag, logs decoy skipped', () => {
  const main = convo('gemini:gem-1');
  assert.equal(main.title, '把採購清單整理成表格');
  assert.ok(has(main, 'gem-a.md'), 'write_file captured');
  assert.ok(has(main, 'gem-b.md'), 'replace captured');
  const legacy = convo('gemini:gem-legacy');
  assert.equal(legacy.title, '舊格式對話也抓得到');
  assert.ok(has(legacy, 'gem-c.md'));
  const sub = convo('gemini:gem-sub');
  assert.equal(sub.auto, true, 'kind:subagent counts as an automated session');
  assert.ok(has(sub, 'gem-d.md'));
  assert.ok(!scanResult.convos.some(c => convos.mergeId(c) === 'gemini:evil'), 'logs.json outside chats/ must not be scanned');
  for (const c of scanResult.convos) assert.ok(!has(c, 'gem-ghost.md'));
});

test('cline family: tasks dirs parse, read_file is not a write, legacy json at root', () => {
  const cl = convo('cline:5001');
  assert.equal(cl.title, '幫我補一個 README');
  assert.ok(has(cl, 'cline-a.md') && has(cl, 'cline-b.md'));
  const legacy = convo('cline:9002');
  assert.equal(legacy.title, '舊版單檔任務');
  assert.ok(has(legacy, 'cline-e.md'));
  const roo = convo('roo:6001');
  assert.equal(roo.agent, 'roo');
  assert.ok(has(roo, 'roo-a.md') && has(roo, 'roo-b.md'), 'insert_content + apply_diff captured');
  const kilo = convo('kilo:7001');
  assert.equal(kilo.agent, 'kilo');
  assert.ok(has(kilo, 'kilo-a.md'), 'edit_file via input.target_file captured');
});

test('pi: session header cwd, session_info name is the title, write/edit captured', () => {
  const pi = convo('pi:pi-1');
  assert.equal(pi.title, 'Pi 整理採購清單');
  assert.equal(pi.project, WRITTEN);
  assert.ok(has(pi, 'pi-a.md') && has(pi, 'pi-b.md'));
});

test('grok build: summary.json title wins, write/search_replace/apply_patch captured, content ghost never attributed', () => {
  const g = convo('grok:grok-1');
  assert.equal(g.title, 'Grok 產生報表腳本');
  assert.ok(has(g, 'grok-a.md') && has(g, 'grok-b.md') && has(g, 'grok-c.md') && has(g, 'grok-e.md'));
  assert.ok(!has(g, 'ghost2.md'), '"*** Add File:" inside write CONTENT must not count');
});

test('normalizeRoots: nonexistent dirs skipped silently, explicit kinds kept', () => {
  const roots = convos.normalizeRoots([
    { kind: 'gemini', dir: GEM_TMP },
    { kind: 'gemini', dir: path.join(TMP, 'no-such-dir') },
    { kind: 'codex', dir: path.join(TMP, 'another-missing') }
  ]);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].kind, 'gemini');
  // legacy config string heuristics stay intact
  const r2 = convos.normalizeRoots([GEM_TMP]);
  assert.equal(r2[0].kind, 'gemini', 'dir name containing "gemini" auto-detects');
});

test('discoverFiles matches scan discovery (server transcript-signature basis)', () => {
  const byKind = ROOTS.map(r => [r.kind, convos.discoverFiles(r, 0).map(f => path.basename(f.abs))]);
  const gem = byKind.find(([k]) => k === 'gemini')[1].sort();
  assert.deepEqual(gem, ['sess-child.jsonl', 'session-20261031T000000-cd34.json', 'session-20261101T120000-ab12.jsonl'].sort());
  const grok = byKind.find(([k]) => k === 'grok')[1];
  assert.deepEqual(grok, ['updates.jsonl'], 'chat_history.jsonl / summary.json not scanned as transcripts');
});

test('UI label map covers every parsed agent (public/main.js AGENT_LABEL)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'main.js'), 'utf8');
  for (const [k, label] of Object.entries(convos.KIND_LABEL)) {
    assert.ok(new RegExp(`${k}:\\s*'${label}'`).test(src), `AGENT_LABEL missing ${k}: '${label}'`);
  }
});

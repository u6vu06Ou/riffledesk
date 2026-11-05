import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import convos from '../convos.js';

test('native titles stay separate from first prompts; index-only renames refresh cached transcripts', async () => {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'riffle-metadata-'));
  try {
    const claude = path.join(tmp, 'projects', 'demo'), codex = path.join(tmp, 'codex', 'sessions');
    fs.mkdirSync(claude, { recursive: true }); fs.mkdirSync(codex, { recursive: true });
    const written = path.join(tmp, 'report.md'); fs.writeFileSync(written, '# report');
    const when = new Date().toISOString();
    const cp = path.join(claude, 'session.jsonl');
    fs.writeFileSync(cp, [
      { type: 'user', sessionId: 'c1', timestamp: when, cwd: tmp, message: { content: '第一句請幫我寫報告' } },
      { type: 'assistant', sessionId: 'c1', timestamp: when, cwd: tmp, message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: written } }] } },
    ].map(JSON.stringify).join('\n'));
    fs.writeFileSync(path.join(claude, 'sessions-index.json'), JSON.stringify({ entries: [
      { sessionId: 'c1', summary: '報告摘要標題' }, { sessionId: 'unrelated', summary: '不能套錯對話' },
    ] }));
    const dp = path.join(codex, 'rollout.jsonl');
    const template = fs.readFileSync(new URL('./fixtures/convos/codex-session.jsonl.tmpl', import.meta.url), 'utf8');
    // Reuse a realistic patch transcript; only actual output paths count.
    const esc = p => JSON.stringify(p).slice(1, -1);
    fs.writeFileSync(dp, template.replaceAll('@@CWD@@', esc(tmp))
      .replace(/@@T\d+@@/g, when).replaceAll('@@FILE4@@', esc(esc(written)))
      .replaceAll('@@FILE5@@', esc(esc(path.join(tmp, 'second.js')))));
    const idx = path.join(tmp, 'codex', 'session_index.jsonl');
    fs.writeFileSync(idx, JSON.stringify({ id: 'cod-1', thread_name: 'Codex 短標題' }) + '\n');
    const roots = [{ kind: 'claude', dir: path.dirname(claude) }, { kind: 'codex', dir: codex }];
    let result = (await convos.scan({ roots })).convos;
    const c = result.find(c => c.agent === 'claude'), d = result.find(c => c.agent === 'codex');
    assert.equal(c.title, '報告摘要標題'); assert.equal(c.firstPrompt, '第一句請幫我寫報告');
    assert.deepEqual(c.transcriptPaths, [cp]); assert.equal(c.id, 'c1');
    assert.equal(d.title, 'Codex 短標題'); assert.equal(d.firstPrompt, '寫一個排序腳本');
    assert.deepEqual(d.transcriptPaths, [dp]);
    fs.appendFileSync(idx, JSON.stringify({ id: 'cod-1', thread_name: '改名後的 Codex 標題' }) + '\n');
    result = (await convos.scan({ roots })).convos;
    assert.equal(result.find(c => c.agent === 'codex').title, '改名後的 Codex 標題');
    fs.writeFileSync(idx, '{broken metadata');
    fs.writeFileSync(path.join(claude, 'sessions-index.json'), 'invalid');
    result = (await convos.scan({ roots })).convos;
    assert.equal(result.find(c => c.agent === 'codex').title, '寫一個排序腳本');
    assert.equal(result.find(c => c.agent === 'claude').title, '第一句請幫我寫報告');
    fs.appendFileSync(cp, '\n' + JSON.stringify({ type: 'custom-title', sessionId: 'c1', customTitle: '自訂標題' }));
    assert.equal((await convos.scan({ roots })).convos.find(c => c.agent === 'claude').title, '自訂標題');
  } finally { convos.clearCache(); fs.rmSync(tmp, { recursive: true, force: true }); }
});

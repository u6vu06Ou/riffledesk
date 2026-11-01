// tests/copyai.test.mjs — copyai.js pure functions (no server, no browser)
import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, slimDom, buildForAI, getMaxTokens, setMaxTokens } from '../public/copyai.js';

// minimal localStorage stand-in for the settings helpers
class MemStore {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}
globalThis.localStorage = new MemStore();

test('estimateTokens counts CJK per char and other text per 4 chars', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2);
  assert.equal(estimateTokens('中文'), 2);
  assert.equal(estimateTokens('中文ab'), 3);        // 2 + ceil(2/4)
  assert.equal(estimateTokens('，。！？'), 4);       // fullwidth punctuation counts as CJK
  assert.equal(estimateTokens('ab中文cd'), 3);      // 2 + ceil(4/4)
});

test('slimDom drops script/style/noscript/template/svg, comments and data-*', () => {
  const html = [
    '<!doctype html><html data-theme="dark">',
    '<head><style>body{color:red}</style><script>var a=1</script></head>',
    '<body><noscript>no js</noscript><template><b>tpl</b></template>',
    '<svg><path d="M0 0"/></svg>',
    '<!-- comment -->',
    '<div id="x" class="a  b" data-foo="1" onclick="go()">  hello   world  </div>',
    '<a href="/u" title="t" data-x="y">link</a>',
    '</body></html>'
  ].join('\n');
  const out = slimDom(html);
  assert.ok(!/script/i.test(out));
  assert.ok(!/style/.test(out));
  assert.ok(!/no js/.test(out));
  assert.ok(!/tpl/.test(out));
  assert.ok(!/path/.test(out));
  assert.ok(!/comment/.test(out));
  assert.ok(!/data-foo|onclick|data-theme|data-x/.test(out));
  assert.match(out, /<div id="x" class="a b"> hello world <\/div>/);
  assert.match(out, /<a href="\/u" title="t">link<\/a>/);
  assert.ok(!/\s{2,}/.test(out));
});

test('short page comes out whole, no padding, tokens match the input', () => {
  const page = { title: 'T', url: 'https://e.test/a', text: 'hello world', html: '<p>hello world</p>', lang: 'en' };
  const r = buildForAI(page, 4000);
  assert.equal(r.truncated, false);
  assert.equal(r.tokens, estimateTokens(r.text));
  assert.equal(r.originalTokens, r.tokens);
  assert.ok(r.tokens < 100);
  assert.ok(r.text.startsWith('# T\nhttps://e.test/a\n\n## 內文\nhello world'));
  assert.match(r.text, /## DOM（精簡）\n```html\n<p>hello world<\/p>\n```$/);
  assert.ok(!/\n\n\n/.test(r.text));
});

test('long page is cut to the limit and carries a truncation note', () => {
  const text = '內文句子。'.repeat(4000);
  const html = '<p>' + 'x'.repeat(200000) + '</p>';
  const page = { title: 'Long', url: 'https://e.test/long', text, html, lang: 'en' };
  const r = buildForAI(page, 2000);
  assert.equal(r.truncated, true);
  assert.ok(r.tokens <= 2000, 'tokens ' + r.tokens + ' must be <= 2000');
  assert.ok(r.originalTokens > 2000);
  assert.match(r.text, /\(truncated, originally ~\d+ tokens\)$/);
  assert.ok(r.text.startsWith('# Long'), 'head is kept');
  assert.ok(r.text.includes('內文句子'), 'body is kept');
  assert.ok(r.text.includes('## DOM（精簡）'), 'dom section is kept');
});

test('zh truncation note is Chinese', () => {
  const page = { title: 'L', url: 'u', text: '中'.repeat(5000), html: '<p>x</p>' };
  const r = buildForAI(page, 1000);
  assert.equal(r.truncated, true);
  assert.match(r.text, /（已截斷，原本約 \d+ token）$/);
  assert.ok(r.tokens <= 1000);
});

test('zH note with no DOM still fits', () => {
  const r = buildForAI({ title: 'L', url: 'u', text: '中'.repeat(3000), html: '' }, 800);
  assert.equal(r.truncated, true);
  assert.ok(r.tokens <= 800);
});

test('max tokens setting persists, clamps and takes effect', () => {
  setMaxTokens(2000);
  assert.equal(getMaxTokens(), 2000);
  assert.equal(setMaxTokens(10), 500);
  assert.equal(getMaxTokens(), 500);
  assert.equal(setMaxTokens(999999), 200000);
  assert.equal(setMaxTokens('8000'), 8000);
  setMaxTokens(2000);

  const r = buildForAI({ title: 'T', url: 'u', text: '中'.repeat(9000), html: '<p>x</p>' }, getMaxTokens());
  assert.ok(r.tokens <= 2000);
  assert.ok(r.tokens > 1500);
  assert.equal(r.truncated, true);
  setMaxTokens(4000);
});

test('broken localStorage falls back to the default', () => {
  const saved = globalThis.localStorage;
  globalThis.localStorage = { getItem() { throw new Error('nope'); }, setItem() { throw new Error('nope'); } };
  assert.equal(getMaxTokens(), 4000);
  assert.equal(setMaxTokens(8000), 8000);
  globalThis.localStorage = saved;
});

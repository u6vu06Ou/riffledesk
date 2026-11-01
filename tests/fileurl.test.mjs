// tests/fileurl.test.mjs — fileurl.js 純函數：file:// 網址翻本機路徑、內建頁判斷、副檔名分類
// （零伺服器、零瀏覽器）
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileUrlToPath, isBuiltinUrl, extToKind, pathExtOf } from '../public/fileurl.js';

test('file:// Windows 網址翻成反斜線路徑', () => {
  assert.equal(fileUrlToPath('file:///D:/workspace/a/b.html'), 'D:\\workspace\\a\\b.html');
  assert.equal(fileUrlToPath('file:///d:/x.md'), 'd:\\x.md');
});

test('查詢字串與錨點不進路徑', () => {
  assert.equal(fileUrlToPath('file:///D:/a/b.html?x=1#frag'), 'D:\\a\\b.html');
  assert.equal(fileUrlToPath('file:///D:/a/b%20c.md'), 'D:\\a\\b c.md');
});

test('POSIX 絕對路徑原樣保留', () => {
  assert.equal(fileUrlToPath('file:///home/x/y.md'), '/home/x/y.md');
});

test('非 file:、UNC、本機形式怪異的網址回 null', () => {
  for (const u of ['https://example.com/a', 'chrome://newtab/', '', 'file://server/share/a.md', 'file:///',
    'file://localhost/D:/a.md', null])
    assert.equal(fileUrlToPath(u), null, String(u));
});

test('舊式 file:///C|/x 也認得', () => {
  assert.equal(fileUrlToPath('file:///C|/x.md'), 'C:\\x.md');
});

test('內建頁與擴充頁認得出來，普通網址不算', () => {
  for (const u of ['chrome://newtab/', 'chrome://extensions/', 'chrome-untrusted://x', 'edge://settings',
    'about:blank', 'view-source:https://a.b', 'chrome-extension://abc/x.html', 'data:text/html,x',
    'blob:https://a.b/123', 'filesystem:https://a.b/temporary/x'])
    assert.equal(isBuiltinUrl(u), true, u);
  for (const u of ['https://a.b/c', 'file:///D:/a.md', '', null])
    assert.equal(isBuiltinUrl(u), false, String(u));
});

test('副檔名分類：認得的給 kind，不認得回 null', () => {
  assert.equal(extToKind('.md'), 'markdown');
  assert.equal(extToKind('.HTML'), 'html');
  assert.equal(extToKind('.py'), 'code');
  assert.equal(extToKind('.exe'), null);
  assert.equal(extToKind(''), null);
});

test('pathExtOf 取最後一段副檔名（小寫）', () => {
  assert.equal(pathExtOf('D:\\a\\b.TXT'), '.txt');
  assert.equal(pathExtOf('/a/b.tar.gz'), '.gz');
  assert.equal(pathExtOf('D:\\a\\noext'), '');
});

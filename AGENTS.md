# 3jsfloder

three.js 3D 檔案瀏覽器 v2（本機唯讀）：DOM 資料夾樹 ＋ WebGL 卡片堆 ＋ 真 DOM 閱讀面板（三欄可切）。

- `server.js`：零相依 Node 伺服器，`127.0.0.1:5177`（`PORT` 環境變數／命令列可改），API 見 README.md。瀏覽範圍＝所有本機固定磁碟＋config `roots`。投影端點 `POST /api/project`（AI 推檔到已開分頁，經 SSE 廣播）只收同源 Origin，或「無 Origin＋`X-RiffleDesk-CLI: 1`」的 CLI 請求，路徑須存在且在 isAllowed 範圍內。
- `bin/riffledesk.js`：不帶子命令＝起 server＋開瀏覽器；子命令 `open <檔> [--line N]`／`search "字" [--in 資料夾] [--json]` 是給 AI agent 用的（open 打 `/api/project`，沒分頁就開 `/?open=` 網址）。
- `public/`：`index.html`（版面＋CSP）、`util.js`（阻尼插值等共用工具）、`tree.js`（資料夾樹）、`stack.js`（three.js 卡片堆，核心）、`thumbs.js`（縮圖繪製＋排程）、`reader.js`（閱讀面板＋編輯／查找接線）、`editor.js`（閱讀區編輯器：CodeJar＋hljs，存檔衝突對話框）、`find.js`（閱讀區查找／取代，分片掃描不卡）、`undo.js`（改名／刪除／存檔的 Ctrl+Z）、`main.js`（chips／搜尋／三欄版面狀態機／測試 hook `__dbg`）。three.js 用 CDN importmap，three@0.160.0。
- `config.json`：`roots`（額外根目錄）＋`pinned`（釘選資料夾）＋`indexSkipDirs`（另外不索引的目錄名）＋`indexMaxMB`（索引檔大小上限，預設 2048MB，超過就只建檔名索引）＋`indexContent`（內容索引開關，預設 true，關＝drop FTS 表、搜尋退回即時掃描）；不進 git，首次啟動從 `config.example.json` 複製。全文索引謹記：內容只進 md/txt/code/json/html/csv/tsv 類、≤5MB、每檔只看前 64KB，contentless FTS + detail='none'（索引量≈內容的 0.22x；搜尋用逐 trigram INTERSECT＋回讀驗證）；路徑字串只在 dirs 表存一份（files 帶 dirid+name，metadata 層 <100MB）—— 第一版存全文曾把 index.db 吹到 37GB。
- `tests/`：`fixtures/`（驗收用夾具資料夾）＋`e2e.mjs`（playwright-core 全套驗收，用 5178 埠，跑完自動關）＋`edit-find-e2e.mjs`（編輯／查找驗收，5184）＋`project-e2e.mjs`（投影驗收，5188，`npm run test:project`）＋`select-scroll-e2e.mjs`（選取／滾動驗收，5196，`npm run test:select`）。隊員手動或新寫的 e2e 一律用 5190–5199 埠（5177 是歐哥在用的，5179 給 server.test.mjs）。
- `docs/screenshots/`：驗收截圖（v2-*.png）。

## 怎麼跑

```bat
npm install && npm start
```
或 `start.bat`。開 <http://127.0.0.1:5177/>。改完程式碼 Ctrl+F5 強制重整即可；伺服器改動要重啟 `node server.js`。

## 驗收

`node tests/e2e.mjs`（自起 5178、截圖、印量測 JSON、跑完關伺服器）、`npm run test:edit`（5184，編輯／查找／衝突）、`node --test "tests/*.test.mjs"`、`npm run test:regress`、`npm run test:select`、`node tests/mirror-e2e.mjs`。手動 smoke：`curl http://127.0.0.1:5177/api/drives`、`/api/list?path=D:\workspace&exts=.md` 應回 JSON。

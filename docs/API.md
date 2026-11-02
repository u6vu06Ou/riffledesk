# RiffleDesk API reference

Every endpoint below is served by `server.js` on `127.0.0.1` only. The browser UI uses
them; anything that can reach the loopback port can use them too (`curl`, an AI agent's
own HTTP call). Read endpoints are open to the browsable scope; write endpoints carry
the guards described under *Security*.

See also: the agent CLI (`riffledesk open|search|changes|wait`) in
[README](../README.md#command-line-for-ai-agents).

---

## Endpoints (English)

## Full-text search API

```
GET /api/search?path=<dir>&q=<text>&exts=<like /api/list>&limit=<n>
```

Recursive, case-insensitive substring search of file **contents and names** under `path`. Only text-like files (markdown, text, html, json, code, csv/tsv) are searched; images, pdf, xlsx and binaries are skipped, as are `node_modules`, dot-dirs, files over 5 MB, and anything deeper than 8 levels. Budgets default to 4 seconds / 20,000 files per query (`RIFFLEDESK_SEARCH_TIME_MS`, `RIFFLEDESK_SEARCH_MAX_FILES`; legacy `FLODER_*` aliases work); hitting a budget sets `truncated: true`.

Response: `{ ok, path, q, files, scanned, truncated, ms, indexed }` where each entry of `files` is the same file-info object `/api/list` returns plus `hits` (occurrences in the file; a name match counts 1), `snippet` (~120 chars around the first content match, single line), and `rel` (path relative to the search root). Sorted by mtime desc, at most `limit` (default 200, max 1000) files.

### Persistent index

The server keeps a persistent full-text index in `index.db` next to `config.json` via Node's built-in `node:sqlite` (FTS5 trigram; needs >= Node 22.5 — if the module is missing the server silently keeps live-scanning). A background crawler starts ~2 s after boot, incrementally re-crawls every 10 minutes, and refreshes any directory's direct files when `/api/list` is called for it. Indexed scope = config `roots` + `pinned` (not whole drives). Searching a path outside that scope answers with a live scan and remembers the path as an extra index root, so the next search there is instant.

When the index has completed a crawl covering the search path, `/api/search` answers from the index (`indexed: true`): trigram FTS for queries of 3+ characters; 1–2 character queries match **file names only** (a trigram index needs 3+ characters, and the search text itself is not stored, so the old DB-side `LIKE` is impossible). Results are re-statted before returning, so a file edited after indexing never produces a stale hit (its row is re-read and fixed on the fly). `hits`/`snippet` are computed by re-reading the file head and checking the exact substring (case-insensitive) — this also filters the trigram-AND false positives that `detail='none'` can produce. The verification pass runs with a small parallel pool and is bounded by a wall-clock budget and a read budget (`VERIFY_BUDGET_MS` / `VERIFY_CONCURRENCY` / `MAX_VERIFY_READS`), so a query with a huge candidate set returns its first verified matches with `truncated: true` rather than grinding through all of them (for stopword-scale gram sets the SQL-side mtime sort is skipped too — see `BIG_GRAM_SET`).

Disk budget (learned the hard way — the first version hit 37 GB):

**Two layers**: the *metadata* layer (path/name/ext/kind/size/mtime) is always on — it alone powers `/api/list` `deepCount` and fast file-name search. The *content* layer (the FTS tables) is optional: config **`indexContent`** (`true`/`false`) plus a runtime toggle `POST /api/index/content` with JSON body `{"on": true|false}` (same JSON + same-origin-Origin rules as the other write endpoints; the new value is persisted into `config.json`). Turning it off **drops** the content tables and VACUUMs the DB; all searches then fall back to the live scan (`indexed: false`). Turning it back on re-creates the empty tables and the next crawl pass attaches content to files that never had it. `/api/index/status` reports `contentEnabled`.

- **No second copy of the text, no positions**: the FTS table is contentless with no positional detail (FTS5 `content='', contentless_delete=1, detail='none'`); the content layer is ≈0.22x of the *indexed* text (vs ≈2.3x contentless with positions, ≈3.6x with the text stored).
- **The metadata layer stores each path string ONCE**: a `dirs` table holds directory paths (norm'd + real-case), and `files` rows carry only `dirid + name`. Storing path+rpath+dir per file measured ≈620 B/file (235 MB for 378k files); normalised, the metadata layer is < 100 MB for a full workspace crawl.
- **Content caps**: only text kinds are content-indexed (`md/txt/code/json/html/csv/tsv`, `table` kind included), only for files ≤ 5 MB, and only the **first 64 KB** of each file (the start of a document is what people search for). Binary-looking files (NUL/control chars in the head) are metadata-only, as is everything else — still name-searchable.
- **Skipped directories** are never indexed at all: built-ins `node_modules, __pycache__, site-packages, venv, .venv, target, bower_components, dist, build, .git, data, ticks, cache, logs, .cache` plus anything in config **`indexSkipDirs`** (array of dir names, case-insensitive). Files under them are absent from indexed search (a live scan still finds them on unindexed roots).
- **Hard size budget**: config **`indexMaxMB`** (default 2048). When `index.db` grows past it, the crawler switches to metadata-only for everything else and logs a warning; it auto-recovers (re-indexes content) once the DB shrinks under 90%. `/api/index/status` reports `capped: true` and `filesWithContent`.

Privacy/retention: extra index roots (from out-of-scope searches) are refused at filesystem roots and capped at 10 (oldest evicted). The index never stores file *contents* (only n-grams); a row for a trashed file is removed immediately by `/api/trash` (and lingering rows are swept on the next crawl). To wipe all path names too: delete `index.db*` and restart.

`/api/list` additionally reports `deepCount` per subdirectory: the number of files matching the request's `exts` filter anywhere under that dir (one indexed prefix query — `null` when that subtree has not been crawled yet).

`GET /api/index/status` → `{ ok, available, files, filesWithContent, capped, roots, crawling, lastCrawlMs, lastCrawlAt }`. Set `RIFFLEDESK_INDEX=off` to disable indexing entirely. `index.db*` is git-ignored.

Two implementation notes, for anyone touching this:

- All index **writes and heavy queries run in a worker thread** (`indexer-worker.js`); the main thread keeps a query-only connection for the cheap paths (`deepCount`, status). Reason: `node:sqlite` is synchronous, and real-text trigram inserts measured 30–85 ms per write chunk on this corpus, so main-thread writes stalled `/api/list` far past the < 100 ms mid-crawl budget. With the worker, mid-crawl `/api/list` stays ≈ 10–20 ms.
- `ftsmap(fileid, rowid)` maps a `files.id` to its FTS rowid so deletions hit rows by rowid — `DELETE … WHERE path = ?` on an FTS5 table is a full scan (and `idx_ftsmap_rowid(rowid)` exists because the search-side join without it was a per-candidate full scan: a 45k-candidate query hung > 100 s). Two FTS5 traps caught here: on a contentless-delete table an *aliased* `ft MATCH ?` errors with `no such column: ft` (MATCH must name the real table), and with `detail='none'` *any* trigram query token longer than 3 chars is rejected as a phrase — so search issues one MATCH per query trigram and ANDs the rowid sets with `INTERSECT`, then verifies candidates against the actual file text.

## File operations

All four are `POST` with a JSON body, and refuse cross-site calls: they require `content-type: application/json` **and** an `Origin` header matching this server's own origin.

- `POST /api/reveal {path}` → show the file, selected, in the OS file manager.
- `POST /api/open {path}` → open with the OS default app, but only for data/document extensions (md, txt, json, csv/tsv, xlsx/xls, pdf, png/jpg/etc, svg, html, docx, pptx). Scripts and executables (js, exe, bat, ps1, py, lnk, …) get `403` — on Windows opening them would *run* them.
- `POST /api/rename {path, newName}` → validates `newName` as a plain file name (no separators/drive chars, no Windows reserved names, no trailing dot/space, no clash with an existing file; a pure case-change of the same name is allowed). Returns `{ ok, file }` with the renamed file's info.
- `POST /api/trash {path}` → move the file to the OS recycle bin / trash (recoverable, never a hard delete; Windows uses the VisualBasic FileIO `SendToRecycleBin` API). Returns `{ ok }` after verifying the file is gone. Tests can set `RIFFLEDESK_TRASH_DRYRUN=1` to validate without touching the bin.
- `POST /api/undo {}` → undo the most recent rename/trash (Ctrl+Z in the UI; the last 20 ops are kept, in memory only — a server restart forgets the stack). Undo of a rename renames back, only while the new name still exists and the old name is free (a pure case-change back to the original spelling is allowed); undo of a trash restores the file from the Windows recycle bin (matched by original path + closest deletion time, then size-verified), never overwriting an existing file — **trash-undo is Windows-only**: on macOS/Linux a trash is simply not recorded for undo. `/api/rename` and `/api/trash` accept an optional `group` string: ops sharing a group merge into ONE undo step (batch delete = one Ctrl+Z; merging applies within a 30-minute window and at most 500 items per group). A failed undo stays on the stack so it can be retried after fixing the blocker. Response: `{ ok, op: 'rename'|'trash', restored: [...], failed: [{name, error}], paths: [...] }` — `404` when the stack is empty, `409` when every item failed.

- `POST /api/save {path, content, baseMtime, baseSize}` → write an edited text file back from the reader (md / txt / json / csv-tsv / code / html source). UTF-8 only (with or without BOM), 5 MB max, text kinds only. The write is atomic (temp `.rdtmp-*` file in the same directory + rename, short EBUSY retry); the disk edition's BOM and dominant line ending are re-applied, so a CRLF file stays CRLF. `baseMtime`/`baseSize` are the version the editor started from: if the file moved on disk since (an AI rewriting it, say) the call answers `409` with `{ error: 'conflict', content, mtime, size }` and **writes nothing** — the UI shows a diff dialog (overwrite / take the disk version). On success returns `{ ok, size, mtime, bom, crlf, undoable }`; the previous bytes go on the undo stack (so Ctrl+Z / `/api/undo` restores them) unless the file is over 2 MB.

Rename, trash and save update the index and invalidate the directory cache; undo does the same in reverse.

## Revamp mode (the user pushes a change list at the AI)

The reverse direction of projection. In the reader's ✎ **revamp** mode an HTML page is served
through a sandboxed iframe (`/raw/<token>/<path>?revise=1`) with `revise-agent.js` injected from
the app's own `public/` directory. The agent script inside the frame only records changes and
reports them to its parent with `postMessage`; the same-origin parent does the HTTP call.

- `POST /api/revise/save { path, changes: [...], png?, summary? }` → writes `<file>.changes.json`
  (and optionally `<file>.changes.png`) next to the HTML file and returns
  `{ ok, json, png }`. JSON body + same-origin `Origin` required, like the other writes.
  `path` must be an existing `.html`/`.htm` file inside the allowed scopes.

Each change is `{ op, rdId?, selector, textHint?, before?, after?, note?, rect?, dx?, dy?, w?, h? }`
with `op` one of `edit-text | move | resize | delete | note | region-note`. Items are normalised
(4000-char text cap, coordinates rounded to 2 decimals) and numbered `n` from 1; invalid items are
skipped, at most 500 survive (`413` beyond `REVISE_MAX_ITEMS`), and an all-invalid body answers `400`.
The document is
`{ version: 1, file, createdAt, status: 'pending', screenshot, summary, items }` — a fixed contract
because an AI reads it. Any previous list is kept as one generation in `<file>.changes.prev.json`.

The CLI half is `riffledesk changes` / `riffledesk wait`; the standard loop is
`open page.html` → user presses *hand to AI* → `wait page.html` → edit per the list →
`changes page.html --done` → `open page.html` again for review.

## Projection (an AI pushes a file at you)

An AI agent working in a terminal can show you the file it just wrote instead of telling you to go look:

```
POST /api/project        { "path": "<absolute path>", "line"?: <n>, "source"?: "claude-code" }
```

Every open tab receives a `project` event over `/api/events` and opens the file (with `line`, it scrolls there and draws a marker line). It **never steals the screen**: a background tab holds the file back, raises one system notification per burst (several within 3 s merge into "the AI opened N files"), and opens the file when you click the notification or come back to the tab. The ⚙ settings carry a projection block: notifications on/off, an independent chime on/off (synthesized, throttled to one beep per 10 s), always-jump-to-the-front, and the permission button.

Guards: the usual loopback `Host` check plus the `/api/` cross-site `Sec-Fetch-Site` guard apply, so a web page on another site still cannot call it. Because the CLI is not a browser it sends no `Origin` — the route accepts a request when *either* the same-origin `Origin` rule holds (a tab using `fetch`) *or* the caller presents `X-RiffleDesk-CLI: 1` **and** no `Origin`; a browser's cross-site POST always carries an `Origin`, so it cannot dress up as the CLI. The path must exist, be a file, and pass `isAllowed`. Response `{ ok: true, delivered: <tabs reached>, diff }` (`delivered: 0` → start a browser yourself), 4xx with `{ ok: false, error }` otherwise. `diff` is `{ adds, dels }` from `git diff --numstat HEAD` when the file is tracked and locally modified in a repository — the card-title "+N −M" badge — and `null` otherwise (no repo, clean, untracked, binary, or no git); it is decoration and never blocks a projection. The route only reads the file system: a spoofed call can at worst open a card.

## Piles (an AI hands you a shortlist)

Instead of opening one file, an agent can hand over a whole set — the search hits it found, the files it just produced — and the user sees exactly those cards and nothing else:

```
POST /api/pile           { "paths": ["<abs>", …], "title"?: "…", "source"?: "claude-code" }
GET  /api/pile?id=<id>   → { ok, id, title, source, createdAt, files: [{ name, path, size, mtime, ext, kind, diff }], missing }
                             (diff: same rule as /api/project, only computed for the first 60 files)
GET  /api/piles          → { ok, piles: [{ id, title, count, source, createdAt }] }   newest first
```

A pile is `{ id, title, paths, source, createdAt }`, held in memory and in `piles.json` beside `config.json`; the newest 20 are kept. Duplicates collapse, paths that are missing / not files / out of scope are dropped and returned in `dropped` (all dropped → 400). Paths beyond 500 → 400. An empty title falls back to the first file's name.

Tabs get a `pile` event over `/api/events`; it **never steals the screen** — a foreground tab shows a quiet toast with an "open this pile" link, a background tab raises the same system notification as a projection (one per burst, shared chime throttle). The left column lists recent piles, `/?pile=<id>` opens one directly, and the stack bar carries a "back to the folder" button (Esc).

Guards are identical to `/api/project` (loopback `Host`, `/api/` `Sec-Fetch-Site`, and same-origin `Origin` *or* `X-RiffleDesk-CLI: 1` without `Origin`). Like projection it only stats files: a spoofed call can at worst show cards.

## Secret scan (suspected keys/passwords in text files)

AI agents happily write API keys into notes. RiffleDesk flags such files so nobody shares a folder full of secrets:

- Detection lives in `secrets.js` (regexes for `sk-`/`sk-ant-` keys, AWS `AKIA…`, GitHub `ghp_/gho_/ghs_/github_pat_`, Google `AIza…`, Slack `xox…`, `-----BEGIN … PRIVATE KEY-----`, and generic `password:…` / `api_key=…` — documentation placeholders like `xxx`, `<your-key>`, `example`, `changeme` are ignored to keep false positives low). Only the **first 64 KB** of a text file is ever scanned, and matched values are **never** logged or sent anywhere — the API masks everything but a short prefix (see below).
- Where the flag comes from: during index crawls each content-read file stores `files.secret` in the DB (schema v7 migrates v6 DBs with a plain `ALTER TABLE` — the existing index is kept, not rebuilt). `/api/list` marks matching file entries `secret: true`; files the index has not scanned yet (or on servers with indexing off) get a cheap on-demand scan (text files ≤ 64 KB only, cached by path+size+mtime).
- Config: **`secretScan`** (bool, default `true`) turns the whole feature off; **`secretScanSkipDirs`** (array of dir NAMES) skips the scan under any matching path segment (a name-spam folder can opt out without hiding its files from listing).
- `GET /api/secretscan?path=…` → `{ ok, secret, matches: [{ line, kind, masked }] }` (one entry per line; a masked value shows at most 4 leading characters — never more than a third of the value — so even short secrets cannot leak through the mask).
- UI: flagged cards get a small `⚠` badge; the reader shows a warning strip ("這個檔案可能含有密碼或金鑰，分享前請檢查") with the matched line numbers. The front end (Ctrl+Z, toasts) strings are in `public/i18n.js`, zh/en.

## Security

Reads are free-for-scope by design; writes are guarded. Aside from the pinned list in `config.json` (`POST /api/pin`), the only mutating endpoints are `/api/reveal`, `/api/open`, `/api/rename` and `/api/trash` — all require a JSON body **and** a same-origin `Origin` header, launch helpers detached with no console window, never delete permanently (trash only), and refuse to open anything executable. Every API call checks the Host header (loopback only), `Sec-Fetch-Site` (same-origin) and realpath scope escapes, and sends `Cross-Origin-Resource-Policy: same-origin`, so other web pages cannot read your files through this server.

---

## API 一覽（中文）

## API

- `GET /api/drives` → `{ drives:[{path,label}], roots, pinned }`（label＝path，本地化標籤由前端產生）
- `GET /api/search?path=…&q=…&exts=…&limit=…` → 遞迴全文＋檔名搜尋（大小寫不敏感；只掃文字類型；深度 8、跳過 node_modules／點開頭目錄／大於 5MB 的檔案；預算 4 秒／20000 檔，超出回 `truncated: true`）→ `{ok, path, q, files:[{…list 檔名欄位＋hits, snippet, rel}], scanned, truncated, ms, indexed}`。伺服器會把索引建在 `config.json` 旁的 `index.db`（node:sqlite FTS5 trigram；開機 2 秒後背景爬、每 10 分鐘增量重爬、`/api/list` 順手更新該目錄直屬檔案）；涵蓋範圍＝config `roots`＋`pinned`，索引涵蓋到的路徑直接由索引回答（`indexed: true`，回傳前還會重新 stat 驗證不給過期結果）；範圍外的路徑先走即時掃描，並記成額外索引根，下次就快了。`RIFFLEDESK_INDEX=off` 可整個關掉。
- `GET /api/index/status` → `{ok, available, files, filesWithContent, capped, contentEnabled, roots, crawling, lastCrawlMs, lastCrawlAt}`。索引分兩層：檔案名/metadata 層永遠開（路徑字串在 dirs 表只存一份，<100MB 等級）；內容層可用 config `indexContent` 或 `POST /api/index/content {"on":bool}` 開關（關＝drop 內容表＋VACUUM、搜尋退回即時掃描；開＝重建空表、下一輪爬蟲補回內容）。索引沒存原文（contentless FTS）；只有 md/txt/code/json/html/csv/tsv 且 ≤5MB 的檔案索引前 64KB 內容（FTS 用 detail='none' 只存 trigram 對，搜尋時用每個 trigram 的 INTERSECT 再回讀原文驗證）；data/ticks/cache/logs/venv/dist/build/.git 這類目錄整個略過（config `indexSkipDirs` 加名單）；DB 超過 `indexMaxMB`（預設 2048MB）就只建檔案名索引並警示（`capped:true`）
- `GET /api/list?path=…&exts=…[&nofiles=1]` → 子資料夾（含 ai/pinned 標記、符合篩選的檔案數 fileCount、hasSubdirs、以及 `deepCount`＝該子資料夾底下遞迴符合 exts 篩選的檔案總數，由索引一次 prefix 查詢回答；該子樹還沒爬完時為 `null`）＋該資料夾的檔案清單（**不截 30 個**，`exts` 為逗號分隔副檔名、`readable`、或 `all`；`nofiles=1` 只回資料夾層級，給樹用）
- 寫入端點（一律 `POST`＋JSON body＋必須帶本站 `Origin` 標頭，否則 403）：`POST /api/reveal {path}`（在檔案總管中選取）、`POST /api/open {path}`（只放行文件／資料型副檔名，腳本與執行檔一律 403）、`POST /api/rename {path, newName[, group]}`（純檔名驗證、Windows 保留名檢查、允許純大小寫改名）、`POST /api/trash {path[, group]}`（進資源回收筒，絕不硬刪；測試可用 `RIFFLEDESK_TRASH_DRYRUN=1` 只驗證不動檔）
- `POST /api/undo {}` → Ctrl＋Z 復原上一個改名／刪除（記憶體留存最近 20 步，重開機即失效；改名＝改回來（新名還在、舊名沒被佔才動；純大小寫改名可還原原始拼法）；刪除＝從 Windows 回收筒按「原始路徑＋最近刪除時間」找回並校驗大小，**絕不覆蓋現有檔案**——回收筒還原只支援 Windows，macOS/Linux 的刪除不會進復原堆疊；帶相同 `group` 的批次操作算一步（30 分鐘內、每組至多 500 項）。回 `{ok, op, restored, failed, paths}`，沒東西可復原 → 404、全部失敗 → 409。
- `GET /api/secretscan?path=…` → `{ok, secret, matches:[{line, kind, masked}]}`：偵測文字檔疑似密碼／金鑰（規則在 `secrets.js`：sk-/sk-ant-、AKIA、ghp_/gho_/ghs_/github_pat_、AIza、xox、私鑰區塊、password/api_key；xxx、<your-key>、example、changeme 這類範例值不算）。**只掃前 64 KB，回傳值一律遮罩到只見前 4 字元、永不記錄明文**。索引爬蟲會把結果存進 `files.secret`（schema v7，僅 `ALTER TABLE` 加欄、不重建舊索引），`/api/list` 檔案項命中時帶 `secret: true`；索引還沒掃到的檔走即時掃描（只掃 ≤64 KB 文字檔、依 path+size+mtime 快取）。設定：`secretScan`（預設開）＋`secretScanSkipDirs`（目錄名清單，命中任一路徑段就跳過掃描）。介面上旗標卡有 ⚠ 標章，閱讀區出現「這個檔案可能含有密碼或金鑰，分享前請檢查」警告列（中英雙語，`i18n.js`）。
- `GET /api/file?path=…[&head=N]` → 檔案內容（`head=N` 上限 65536 只串前 N bytes 給縮圖用；文字截斷 512KB；圖片／pdf 串流正確 content-type；影片 mp4/m4v/webm/ogv/mov 串流且支援單段 `Range: bytes=`（206／416），拖時間軸靠它；xlsx 回原始位元組給前端 SheetJS 解析）
- `POST /api/save {path, content, baseMtime, baseSize}` → 從閱讀區把編輯內容寫回（只收 UTF-8、≤5MB、文字類）。原子寫入（同資料夾 `.rdtmp-*` 暫存＋改名，Windows EBUSY 短重試），保留磁碟原檔的 BOM 與主要換行（CRLF 檔仍是 CRLF）。`baseMtime`／`baseSize` 是編輯起點的版本：磁碟上的檔已經變了（例如 AI 剛寫入）就回 `409 {error:'conflict', content, mtime, size}` 且**一個字都不寫**，由前端跳差異對話框；成功回 `{ok, size, mtime, bom, crlf, undoable}`，舊版進復原堆疊（>2MB 不存）。
- `POST /api/pin` body `{path, pinned}` → 更新釘選
- `POST /api/pile {paths:[…], title?, source?}` → 把一組檔交成一疊（`{id, title, paths, source, createdAt}`，記憶體＋`config.json` 旁的 `piles.json`，只留最近 20 疊）。去重複、不合格路徑丟掉並列在 `dropped`（全不合格 400）、超過 500 檔 400、空標題用第一個檔名。防護同 `/api/project`（同源 `Origin` 或無 `Origin` ＋ `X-RiffleDesk-CLI: 1`），只 stat 不寫檔。前端收到 `pile` SSE 事件只跳提示／通知**不搶畫面**，左欄列出最近的疊，`/?pile=<id>` 直接開。`GET /api/pile?id=…` 回 `{ok, id, title, files:[同 list 欄位], missing}`；`GET /api/piles` 回清單（新→舊）。
- `GET /api/convos?days=N` → AI 對話清單（掃 Claude Code `~/.claude/projects/*/*.jsonl`、Codex `~/.codex*/sessions/**/rollout-*.jsonl`、Gemini CLI `~/.gemini/tmp/*/chats/**`、Cline/Roo/Kilo 的 VS Code globalStorage `tasks/*/api_conversation_history.json`、Pi `~/.pi/agent/sessions/**/*.jsonl`、Grok Build `~/.grok/sessions/*/*/updates.jsonl` 的寫檔紀錄；工具明細與來源見 [docs/ai-sources.md](ai-sources.md)；最新在前，只回 metadata＋fileCount 不回落差的檔案清單）→ `{ok, days, convos:[{id, agent, title, project, started, updated, fileCount}], scanned, ms}`；`agent` ∈ `claude|codex|gemini|cline|roo|kilo|pi|grok`
- `GET /api/convo?id=<agent>:<session>` → 該對話寫過的檔案（同 `/api/list` 檔案欄位，按首次寫入排序，只回還存在的檔案）→ `{ok, id, title, files, ms}`
- `GET /api/recent?hours=N&exts=…` → 最近 N 小時所有對話寫過的檔案（同 `/api/list` 欄位＋`convoId`/`convoTitle`/`firstAt`/`lastAt`，最新在前；`exts` 語意同 `/api/list`）
- `GET /api/recentmod?hours=N&exts=…` → 「最近改動（不確定是誰改的）」：標記專案資料夾（有 AGENTS.md/CLAUDE.md/GEMINI.md、.claude/.cursor/.git 子目錄、或同層 ≥5 個 Markdown）裡 mtime 在窗內的檔案，扣掉各 AI 對話寫過的；只用既有索引查（`indexed:false` 表示索引沒跑就回空）→ `{ok, hours, indexed, files:[同 /api/list 檔案欄位], ms}`
- `GET /api/whichconvo?path=…` → 哪些對話寫過這個檔案（最新在前）→ `{ok, path, convos:[…同 /api/convos 項目]}`
- 對話掃描跨平台（`os.homedir()`）、串流逐行解析不整檔 JSON.parse（Cline 系列的整檔 JSON 例外，上限 128MB），以 (size,mtime) 快取；`config.json` 可用 `convoRoots: [{kind:'claude'|'codex'|'gemini'|'cline'|'roo'|'kilo'|'pi'|'grok', dir}]` 自訂來源（不設＝預設；`[]`＝關閉掃描）

路徑安全與威脅模型（在單人本機工具的定位下）：

- 瀏覽範圍預設很寬（所有固定磁碟＋roots）——這是刻意設計：這是歐哥自己電腦上的本機工具，不是共享服務。代價是 Web 側攻擊面變大，所以 API 有下面幾道防線：
- **Host 檢查**：伺服器只回應 Host 為 loopback 的請求（擋 DNS rebinding）。
- **同源檢查**：所有 `/api/*` 請求若帶 `Sec-Fetch-Site` 且不是 `same-origin/same-site/none` 一律 403（瀏覽器對跨站子資源請求必帶此 header），且每個回應都附 `Cross-Origin-Resource-Policy: same-origin`——其他網站既讀不到內容，也無法用 `<img>`/no-cors 做存在性探測。curl／其他本機程式不帶該 header 不受影響（它們本來就有使用者權限可直接讀檔）。
- **寫入防護**：`/api/pin`（整個服務唯一的寫點）要求 `content-type: application/json`（跨站表單無法偽造，會先被 CORS preflight 擋下）＋Origin 必須是本站。
- **路徑白名單**：`/api/list`、`/api/file` 與 `/api/search` 只接受位於平台磁碟／掛載點、roots 或 pinned 底下的路徑（含 symlink／junction 真實路徑檢查，路徑穿不出允許範圍）；純 `..` 越界一律 403。
- 前端讀到的檔案內容一律視為不可信：markdown 經 DOMPurify 消毒、html 放進無 token 的 sandbox iframe、整頁有 CSP（`script-src` 只限 self＋白名單 CDN＋一個 importmap 的 SHA-384 hash）。
- 效能取捨：`/api/list` 不加量也沒有 30 筆上限（設計要求卡片堆看得到全部檔案）；超大目錄（如 System32）首次列舉會回數 MB JSON，伺服器端有以 mtime 為 key 的目錄快取（上限 300 筆）緩解重複掃描。

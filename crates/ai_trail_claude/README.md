# ai_trail_claude

掃 Claude Code 的對話紀錄（`%USERPROFILE%\.claude\projects\<專案>\*.jsonl`，舊檔可能是 `.jsonl.gz`），
把 AI **寫過**的檔案與**回覆中提到**的絕對 Windows 路徑撈出來，給 3jsfloder 前端畫「AI 足跡」。

逐行串流讀，不整檔載入；單行上限 16 MiB，超過的部分丟棄但仍會撿回該行開頭的 `file_path`。
壞行（截斷、半個 JSON）直接略過不 panic。同一路徑去重，只留最新一筆。

## API

| 函式 | 說明 |
|---|---|
| `scan(projects_dir, since: Option<SystemTime>) -> Vec<TrailItem>` | 掃整個目錄（含子層），回傳最新在前的足跡，並在每個路徑上做一次 `exists()` |
| `scan_light(...) -> Vec<TrailItem>` | 同上但不碰磁碟：`exists` 一律 `false`。**Tauri command 建議用這個**，慢速／離線網路磁碟才不會拖垮整趟掃描 |
| `TrailItem` | `{ path, kind, timestamp, project_dir, session_id, exists }`，`#[derive(Serialize)]`，可直接丟給 Tauri command 回前端 |
| `TrailItem::system_time() -> Option<SystemTime>` | `timestamp`（epoch 毫秒）轉回 `SystemTime`，溢位回 `None` |
| `TrailKind` | `Written`（`Write`/`Edit`/`NotebookEdit` 的 `file_path`）或 `Mentioned`（assistant 文字中的路徑）；序列化成 `"written"` / `"mentioned"` |
| `normalize(raw)` | 正規化：`/`→`\`、收斂重複分隔符（UNC 開頭 `\\` 保留）、磁碟代號轉大寫、詞法解析 `.`/`..`、去掉尾端分隔符 |
| `extract_paths(text)` | 從散文抽出絕對 Windows 路徑，去掉尾端標點／反引號／markdown 括號／緊貼的中文句讀，並在文內去重 |
| `is_absolute_windows(path)` | 判斷 `D:\x` 或 `\\server\share` |
| `parse_iso8601_ms(s)` | 解析事件時間戳成 epoch 毫秒 |

`path` 一定是正規化後的絕對路徑（只認帶副檔名的候選）。`exists` 是**當下**磁碟狀態。
根目錄不存在或讀不到就回空 `Vec`，不報錯。

## 範例

```rust
use ai_trail_claude::scan;
use std::time::{Duration, SystemTime};

let projects = std::env::var("USERPROFILE").unwrap() + r"\.claude\projects";
let week_ago = SystemTime::now() - Duration::from_secs(7 * 86_400);

for item in scan(projects, Some(week_ago)) {
    println!("{:?} {} (exists={})", item.kind, item.path, item.exists);
}
```

## 測試

`cargo test`、`cargo clippy --all-targets -- -D warnings` 皆須乾淨。
`tests/fixtures/real_*.jsonl` 是從真實對話紀錄剪下、只留結構的最小片段。
實測全量（`~/.claude/projects`，12k+ 路徑、GB 級）release 掃描約 26 秒；追加 `exists()` 約 +6 秒。

## 已知限制

- 只認 Windows 絕對路徑（本專案是 Windows 桌面程式），POSIX 路徑不撿。
- 只收帶副檔名的候選，`D:\folder\` 這種純資料夾引用會被丟掉；`.gitignore` 這類點檔收得到，但 `C:\Users\x\.claude` 這種「名字帶點、其實是資料夾」也會被當成檔案收進來。
- `\\` 在中文散文裡也常是換行記號，所以 UNC 至少要求 `\\server\share` 兩段，`\\ 從 .env` 這類會被丟掉。
- 路徑中的空白會保留（`C:\Program Files\x.exe`）；代價是「路徑後面直接接英文句子」時可能多吃一兩個英文詞。
- 被 JSON 轉義成 `\\` 的路徑若同時被換行切斷，該行殘段無法還原。
- 同路徑多筆時 `kind` 取最新那筆，較早的 written/mentioned 差異不保留。
- 掃描是同步、不可取消、無進度回報；Tauri 端請放進 `spawn_blocking`。
- `exists` 依賴宿主平台：非 Windows 上 `D:\...` 恆為 `false`。

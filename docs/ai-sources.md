# RiffleDesk 找得到哪些 AI 工具的紀錄

調查日期：2026-11-01。每一條都對照過官方文件、原始碼或 issue，來源網址附在後面；「信心」欄是我們對這條線索的把握程度。

**大原則：跟終端機／IDE 無關，只看 AI 工具的紀錄檔。** 同一個 AI 不管從哪裡開（terminal、VS Code、桌面 App），只要它的紀錄落在下表「支援」的位置，就掃得到。

## 一覽表

| 工具 | 支援 | 紀錄位置 | 格式 | 跟自家 CLI 共用？ | 信心 |
|---|---|---|---|---|---|
| Claude Code（CLI） | ✅ 內建 | `~/.claude/projects/<專案slug>/*.jsonl` | JSONL | 本體 | 高 |
| Claude 桌面 App 的 Code 分頁 | ✅ 內建 | 同上（`~/.claude/projects/`） | JSONL | 是 | 高 |
| Claude 桌面 App 的 Cowork 分頁 | ❌ | `%AppData%\Claude\local-agent-mode-sessions\`（隔離 VM 內） | 未公開格式 | 否 | 中 |
| Claude Code VS Code 擴充 | ✅ 內建 | 同上（`~/.claude/projects/`；擴充是 CLI 的 GUI） | JSONL | 是 | 中高 |
| Claude Code JetBrains 外掛 | ✅ 內建 | 同上（外掛直接跑 CLI） | JSONL | 是 | 中高 |
| Codex（CLI） | ✅ 內建 | `~/.codex*/sessions/**/rollout-*.jsonl` | JSONL | 本體 | 高 |
| Codex 桌面 App（2026-02 起） | ✅ 內建 | 同上 `~/.codex/sessions/` | JSONL | 是 | 中高 |
| Codex VS Code 擴充 | ✅ 內建 | 同上 `~/.codex/sessions/` | JSONL | 是 | 中高 |
| Gemini CLI | ✅ 本票新增 | `~/.gemini/tmp/<專案識別>/chats/**`（`GEMINI_CLI_HOME` 可改 `~/.gemini`） | JSONL；舊版單一 `.json` | 本體 | 高 |
| Cline（VS Code 擴充） | ✅ 本票新增 | VS Code globalStorage `saoudrizwan.claude-dev/tasks/<taskId>/api_conversation_history.json` | JSON（Anthropic 訊息陣列） | 不適用 | 高 |
| Roo Code（VS Code 擴充） | ✅ 本票新增 | globalStorage `rooveterinaryinc.roo-cline/tasks/…`（同 Cline 版面） | JSON | 不適用 | 高 |
| Kilo Code（舊版 Roo 分支） | ✅ 本票新增 | globalStorage `kilocode.kilo-code/tasks/…`（同 Cline 版面） | JSON | 不適用 | 高 |
| Kilo Code（2026 現行，opencode 核心） | ❌ | `Global.Path.data/kilo.db` | SQLite | — | 高 |
| Pi（badlogic/pi-mono） | ✅ 本票新增 | `~/.pi/agent/sessions/--<路徑>--/<時間戳>_<sessionId>.jsonl`（`PI_CODING_AGENT_SESSION_DIR` 可改） | JSONL | 本體 | 高 |
| Grok Build（xAI 官方 coding agent） | ✅ 本票新增 | `~/.grok/sessions/<編碼路徑>/<session-id>/updates.jsonl`（`GROK_HOME` 可改） | JSONL（ACP 串流） | 本體 | 高 |
| superagent-ai/grok-cli（第三方） | ❌ | `~/.grok/grok.db` | SQLite（bun:sqlite） | 否 | 高 |
| opencode（現行 v1 分支） | ❌ | 資料目錄的 SQLite（drizzle） | SQLite | — | 中高 |
| opencode（舊版 JSON） | 記錄，不解析 | `~/.local/share/opencode/storage/{session,message,part}/` | 每筆一個 JSON | — | 中 |
| Cursor | ❌ | `Cursor/User/workspaceStorage/<hash>/state.vscdb` | SQLite | — | 高 |
| Windsurf（Cascade） | ❌ | `~/.codeium/windsurf/` 下，格式私有/封存 | 私有 | — | 中 |
| GitHub Copilot（VS Code Chat） | ❌ | `workspaceStorage/<hash>/chatSessions/*.jsonl`（+state.vscdb 索引） | JSONL，workspace hash 無對應表 | 否 | 中高 |
| GitHub Copilot CLI | ❌ | `~/.copilot/session-state/<id>/events.jsonl` | JSONL（私有格式） | — | 中 |
| Aider | ❌（文件即可） | 各專案目錄 `.aider.chat.history.md` | Markdown | 本體 | 高 |
| Continue | ❌ | `~/.continue/sessions.json` | JSON（工具呼叫細節未公開） | — | 中 |

不支援的工具的替代方案：

- `riffledesk open <檔>` 可以把任何檔案直接投影進 RiffleDesk（AI 要在自己的回答裡呼叫）。
- 左樹「最近改動（不確定是誰改的）」列出不記名的新改檔案：只看「有 AGENTS.md／CLAUDE.md／GEMINI.md／.claude／.cursor／.git 標記，或同層 ≥5 個 Markdown 的資料夾」，用既有索引查 mtime，不額外掃碟。

## 「grok bot」到底是什麼

使用者口語的「grok bot」要拆開來看：

- **Grok 本身**＝xAI 的聊天助理（grok.com、X 內），是聊天機器人，沒有自己的本機程式碼紀錄檔。
- **xAI 官方的寫程式代理**＝**Grok Build**（binary 名 `grok`，終端 TUI／ACP），公告見 x.ai/news/grok-build-cli，紀錄格式如上表，本票已支援。
- **第三方的 Grok CLI**＝`superagent-ai/grok-cli`（GitHub 同名 repo 不少，注意這不是 xAI 出的），紀錄是 SQLite `~/.grok/grok.db`，不解析。它跟 Grok Build**共用 `~/.grok` home 但檔案不同**（`grok.db` vs `sessions/`），掃描不會互踩。
- 未找到 xAI 官方的 IDE 內機器人。

## 各工具細節＋來源

### Claude Code（CLI / VS Code / JetBrains / 桌面 App Code 分頁）

- 轉錄檔：`~/.claude/projects/<專案slug>/<session-id>.jsonl`；slug＝工作目錄把非英數字換成 `-`。來源：<https://code.claude.com/docs/en/sessions>（信心：高）。
- 桌面 App 的 **Code** 分頁寫到同一個 `~/.claude/projects/`：官方第三方文件 <https://claude.com/docs/third-party/claude-desktop/data-storage>（信心：高）。桌面 App 自己另存 session 清單，但不會擋住我們直接掃目錄（issue 參考 <https://github.com/anthropics/claude-code/issues/67118>）。
- **Cowork** 分頁跑在隔離 VM 裡，紀錄落在 `%AppData%\Claude\local-agent-mode-sessions\`（macOS：`~/Library/Application Support/Claude/`），非公開格式，不支援。來源：<https://brycewatson.com/blog/13-cowork-conversation-transcripts>（信心：中，第三方部落格）。
- VS Code 擴充是「the CLI 的原生圖形介面」：<https://code.claude.com/docs/en/vs-code>；JetBrains 外掛直接啟動 CLI：<https://code.claude.com/docs/en/jetbrains>（信心：中高）。session 落在同一個 `~/.claude/projects/`（issue <https://github.com/anthropics/claude-code/issues/12872> 提到「conversation transcripts are stored locally」亦證）。

### Codex（CLI／桌面 App／VS Code 擴充）

- 三種入口都寫 `~/.codex/sessions/YYYY/MM/DD/rollout-<時間戳>-<uuid>.jsonl`。
- 來源：codex-acp session 存進 `~/.codex/sessions/` 但未在 App 列出（<https://github.com/openai/codex/issues/16385>）；桌面 App 讀 `~/.codex`（<https://community.openai.com/t/codex-desktop-stopped-showing-local-threads...1377125>）；（中高）。

### Gemini CLI

- 位置：`~/.gemini/tmp/<projectIdentifier>/chats/`。`GEMINI_CLI_HOME` 環境變數可取代 `~/.gemini`；沙箱模式（`SANDBOX=sandbox-exec`）改用 `~/.cache/.gemini`。
- 專案識別：舊版 sha256(projectRoot)、新版 slug（註冊表 `~/.gemini/projects.json`）。
- 主 session：`chats/session-<ts>-<shortId>.jsonl`；子代理：`chats/<parentSessionId>/<sessionId>.jsonl`；更早的版本是單一 `session-*.json` 物件（我們也解析）。
- 格式（JSONL）：第一行是中繼 `{sessionId, projectHash, startTime, lastUpdated, kind:'main'|'subagent', directories:[...]}`；其後每行 `{id, timestamp, type:'user'|'gemini'|…, content:[{text}]}`，`type:'gemini'` 的紀錄帶 `toolCalls:[{id,name,args,status,timestamp}]`。另有 `$set`、`$patch`、`$rewindTo` 中繼更新。
- 寫檔工具名（legacy 預設集）：`write_file`、`replace`，引數都是 `args.file_path`。
- 來源（google-gemini/gemini-cli main）：`packages/core/src/services/chatRecordingService.ts`、`chatRecordingTypes.ts`、`packages/core/src/utils/storage.ts`、`packages/core/src/utils/paths.ts`、`packages/core/src/config/definitions/model-family-sets/default-legacy.ts`，repo <https://github.com/google-gemini/gemini-cli>（信心：高）。

### Cline / Roo Code / Kilo Code（VS Code globalStorage）

- Cline：`<vscode-user-data>/User/globalStorage/saoudrizwan.claude-dev/tasks/<taskId>/api_conversation_history.json`（Anthropic 訊息陣列，tool_use 區塊）；同目錄另有 `ui_messages.json`、`task_metadata.json`。來源：cline repo `apps/vscode/src/core/storage/disk.ts`（<https://github.com/cline/cline>，信心：高）。
- Roo Code：`rooveterinaryinc.roo-cline/tasks/…` 同版面。來源：RooCodeInc/Roo-Code issue #4174、#3080（高）。
- Kilo Code 舊版（Roo 分支時代）：`kilocode.kilo-code/tasks/…` 同版面。**現行 2026 版已改用 opencode 核心，session 存 SQLite `kilo.db`**（`packages/core/src/database/database.ts`：`join(Global.Path.data, "kilo.db")`，repo <https://github.com/Kilo-Org/kilocode>；issue #7000）——現行版不解析。
- VS Code user-data 預設路徑：Windows `%APPDATA%\Code\User\globalStorage`、macOS `~/Library/Application Support/Code/User/globalStorage`、Linux `~/.config/Code/User/globalStorage`；另有 `Code - Insiders`、`VSCodium`、`Cursor`、`Windsurf` 幾顆編輯器變體，預設路徑都會掃。
- 寫檔工具：`write_to_file`、`replace_in_file`（Roo 另有 `apply_diff`、`insert_content`、`apply_patch`、`edit_file`），路徑引數掃 `path`／`file_path`／`target_file`。

### Pi（badlogic/pi-mono 的 `pi` CLI）

- 位置：`~/.pi/agent/sessions/--<路徑>--/<時間戳>_<session-id>.jsonl`；`PI_CODING_AGENT_SESSION_DIR` 環境變數、`--session-dir` 參數、sessionDir 設定可改。路徑 slug 是把前導分隔去掉、`/ \ :` 換成 `-`。
- 格式：JSONL。第一行 `{"type":"session","version":3,"id":…,"timestamp":…,"cwd":…}`；條目用 id/parentId 組成樹；`type:'message'` 條目帶 AgentMessage（assistant 的 content block 有 `{"type":"toolCall","id","name","arguments"}`）；`type:'session_info'` 的 `name` 欄位就是 session 標題。
- 寫檔工具：`write`（arguments `{path, content}`）、`edit`。
- 來源：badlogic/pi-mono `docs/sessions.md`、`docs/session-format.md`、`docs/message-types.md`（<https://github.com/badlogic/pi-mono>，信心：高）。

### Grok Build（xai-org/grok-build，官方 coding agent，binary `grok`）

- 位置：`~/.grok/sessions/<編碼後 cwd>/<session-id>/updates.jsonl`（ACP session/update 串流，權威來源）；同目錄有 `chat_history.jsonl`、`summary.json`（title、model、時間）。`GROK_HOME` 可改 `~/.grok`。
- updates.jsonl 每行：`{"timestamp":<unix 秒>,"method":"session/update","params":{"sessionId":…,"update":{"sessionUpdate":"tool_call","toolCallId":…,"rawInput":{…},"_meta":{"x.ai/tool":{"version":1,"name":"…"}}}}}`；sessionUpdate 種類另有 user_message_chunk、agent_thought_chunk、agent_message_chunk、tool_call_update、turn_completed。
- 寫檔工具（tool_taxonomy.rs）：`write`（Write，rawInput.file_path）、`search_replace`／`edit`／`hashline_edit`／`apply_patch`（Edit）。路徑不絕對時沒有可靠 cwd（目錄名編碼不可逆），會略過。
- 公告：<https://x.ai/news/grok-build-cli>（SuperGrok／X Premium+ beta）。來源：xai-org/grok-build `crates/codegen/xai-grok-pager/docs/user-guide/17-sessions.md`、`tool_taxonomy.rs`（<https://github.com/xai-org/grok-build>，信心：高）。

### 其餘工具（僅記錄位置，不解析）

- **superagent-ai/grok-cli**：SQLite `~/.grok/grok.db`（bun:sqlite）。來源：repo `src/storage/db.ts`（<https://github.com/superagent-ai/grok-cli>，高）。
- **opencode（sst/opencode）**：舊版每筆一個 JSON 放 `~/.local/share/opencode/storage/{session,message,part}/`；現行 dev 分支（v1）改 SQLite（`packages/core/src/database/schema.sql.ts`，effect-drizzle）。來源：deepwiki sst/opencode、<https://www.prismmd.app/blog/opencode-chat-history>、<https://promptwake.com/blog/where-opencode-stores-session-history>（中高）。
- **Cursor**：chat 在每個 workspace 的 `state.vscdb` SQLite（`Cursor/User/workspaceStorage/<hash>/`）。來源：<https://forum.cursor.com/t/chat-history-folder/7653>、<https://vibe-replay.com/blog/cursor-local-storage/>（高）。
- **Windsurf**：Cascade 對話落碟但為私有／封存格式（`~/.codeium/windsurf/`）。來源：<https://vshulcz.github.io/deja-vu/guide/memory-for-windsurf.html>（中）。
- **GitHub Copilot（VS Code Chat）**：`User/workspaceStorage/<hash>/chatSessions/*.jsonl`，索引在 state.vscdb；workspace hash 沒有可還原對應表，不解析。Copilot CLI：`~/.copilot/session-state/<id>/events.jsonl`。來源：microsoft/vscode issue #334228、<https://usekibble.com/blog/where-github-copilot-keeps-its-usage-logs>（中高）。
- **Aider**：每個專案目錄的 `.aider.chat.history.md`（Markdown；`--chat-history-file` 可改）。分散在各專案、沒有中央目錄，且 edit 格式偵測脆弱——交給「最近改動（不確定是誰改的）」涵蓋。來源：<https://github.com/Aider-AI/aider>（位置：高）。
- **Continue**：`~/.continue/sessions.json`（格式細節未從官方來源確認）。來源：continuedev/continue discussion #6992（中）。

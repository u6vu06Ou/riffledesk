# 表格排版夾具（寬文字欄）

一張仿 GitHub 雷達索引的窄表：前三欄極短，最後一欄是長段中文。用來驗收短欄單行、長文欄不被壓成細條。

| 條目 | 道 | 狀態 | 日期 | 一句話 |
|---|---|---|---|---|
| [alpha/repo-one](https://example.com/1) | 世道 | 🆕 | 2026-11-05 | 免費後端線直系更新：開權重但 HN 留言口徑一致潑冷水，自架門檻不在桌機射程；對自家的意義是等上游接模型再換，而不是自己吃權重。 |
| [beta/repo-two](https://example.com/2) | 補洞 | 🆕 | 2026-11-05 | 持久記憶外掛：session 全程錄下來→壓縮→下次開局自動注入相關上下文，附隱私排除清單；跟自家精寫卡片的路線互為對照組。 |
| [gamma/post](https://example.com/3) | 世道 | 🆕 | 2026-11-05 | 以老漏洞為例說明沉睡十幾年的技術債正被 AI 規模化挖出，「能跑就別動」的折舊假設正在失效，攻擊面要重新估。 |
| [delta/tool](https://example.com/4) | 世道 | 🆕 | 2026-11-05 | 平行 worktree GUI 宣布加入大廠，agent 殼賽道從一週一員進入巨頭收編階段；走 API/CLI 無頭派工的路線沒被這波覆蓋。 |
| [epsilon/model](https://example.com/5) | 世道 | 🆕 | 2026-11-05 | 開放權重的 coding 模型自稱 SOTA，但只是 Preview、單一來源無第三方複測，照規矩等實測再評，不急著當候選後端。 |
| [zeta/guard](https://example.com/6) | 補洞 | 🆕 | 2026-11-04 | 在每次 LLM 呼叫與工具觸發落地前做 block/warn/audit，攔在 HTTP 層繞不過；正是自家 proxy 攔截路線的獨立驗證。 |
| [eta/memory](https://example.com/7) | 補洞 | 🆕 | 2026-11-04 | 圖譜原生的 agent 記憶分三層，實驗品無 SLA、要吃重基礎設施；但三層劃分的思路值得抄進記憶重建步驟。 |
| [theta/agent](https://example.com/8) | 世道 | 🆕 | 2026-11-04 | 讓 computer-use agent 從任務經驗自己演化工作介面，同模型固定介面的三點八倍——介面設計可以補模型差距。 |
| [iota/cli](https://example.com/9) | 補洞 | 🆕 | 2026-11-04 | worktree CLI 給平行 agent 用，把 worktree 當 branch 使，外加 hooks 自動收尾；直接對到誰開誰收鐵律的痛。 |
| [kappa/engine](https://example.com/10) | 世道 | 🆕 | 2026-11-04 | 純 C 零依賴的階層式推理引擎，權重分層放 GPU／RAM／SSD；README 自帶 SSD 磨耗警告，速度只到堪用。 |
| [lambda/heretic](https://example.com/11) | 世道 | 🆕 | 2026-11-04 | Training-free 模型修改器，去審查、降諂媚，直接動權重；改過權重的降智要自己量，進工單前先跑自家 evals。 |
| [mu/studios](https://example.com/12) | 世道 | 🆕 | 2026-11-04 | 把 coding agent 變成完整工作室的一大包 skill，可當素材庫拆角色定義；但最後一推停在兩週前，維護訊號轉弱。 |
| [nu/qa](https://example.com/13) | 世道 | 🆕 | 2026-11-04 | agent 驅動的 QA 平台，留言區口徑一致開嗆又一個收 token 錢的 SaaS，共同創辦人自曝護城河存疑。 |
| [xi/weights](https://example.com/14) | 世道 | 🆕 | 2026-11-03 | 不靠 fine-tune 讓前沿模型直接看懂並手寫權重張量，高分串一致震驚；若成立，手握開源權重的價值跳一級。 |
| [omicron/gui](https://example.com/15) | 世道 | 🆕 | 2026-11-03 | 極簡 coding agent 桌面殼今日榜首，但 open issue 逾四千、HN 近乎零留言，爆量靠作者社群而非口碑。 |

## 引言裡的表

> 引言區塊裡的表不該跳出引言框，裡面的欄位也不用 nowrap 分類。
>
> | 項目 | 說明 |
> |---|---|
> | alpha | 這是一段刻意寫長一點的說明文字，足夠超過十六個視覺寬度讓它變成候選長欄。 |
> | beta | 短句 |

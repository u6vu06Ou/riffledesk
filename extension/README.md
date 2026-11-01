# RiffleDesk Tabs Bridge（瀏覽器分頁橋接擴充）

讓 RiffleDesk 的「分頁」按鈕顯示你瀏覽器（Chrome／Firefox）目前開著的所有分頁：每張卡是一個分頁（favicon＋標題＋網域，正在看的分頁附截圖），點卡片可直接把瀏覽器切到那個分頁；卡角落的「預覽」鈕則在右欄讀那個分頁的截圖＋文字／DOM。

## 安裝（2 分鐘）

### Chrome

1. Chrome 網址列輸入 `chrome://extensions` 打開擴充功能頁。
2. 右上角打開「**開發人員模式**」。
3. 點「**載入未封裝項目**」，選這個資料夾（`extension/`，也就是本檔案所在的那層）。
4. 出現「RiffleDesk Tabs Bridge」就完成了。RiffleDesk 正在跑的話，打開它按工具列的「分頁」就能看到卡片。

### Firefox

同一份程式碼，Firefox 版只是換一份 manifest（`manifest.firefox.json`，多了 `browser_specific_settings.gecko.id`、背景頁寫法改 `background.scripts`）。先打包出 Firefox 版：

```bash
npm run build:ext
# → dist/extension-firefox.zip，解開成一個資料夾
```

- **臨時安裝（開發／自己用）**：Firefox 網址列輸入 `about:debugging#/runtime/this-firefox` →「**臨時載入附加元件**」→ 選解開資料夾裡的 `manifest.json`。重開 Firefox 會消失，要重載一次。
- **永久安裝**：Firefox 正式版只吃簽章過的副檔名，得把 `dist/extension-firefox.zip` 上傳 [addons.mozilla.org](https://addons.mozilla.org/developers/) 走 AMO 簽章（未列公開也能簽「自用」版），簽完下載 `.xpi` 再拖進 Firefox。`gecko.id` 已固定成 `riffledesk-tabs@u6vu06Ou`，之後更新要沿用同一個 id。

> **裝好後要開權限**：Firefox MV3 的網站權限（`<all_urls>`）預設**不會**自動給。about:addons → 本擴充 →「權限」把「存取所有網站資料」打開，截圖與「預覽」讀內容才有作用；沒開的話卡片仍會出現，只是沒有截圖、按預覽會失敗。

> 不用這個功能時，到同一頁把它關掉或移除即可。分頁清單與截圖只存在伺服器的記憶體裡；擴充自己在瀏覽器 profile 的 `storage.local` 記埠號與配對金鑰（本機、不同步）。

## 設定

- **埠號**：RiffleDesk 預設跑在 5177。你用別的埠（例如 `PORT=5180`）才需要改。Chrome：chrome://extensions → RiffleDesk Tabs Bridge →「詳細資料」→「擴充功能選項」；Firefox：about:addons → 本擴充 →「偏好設定」。
- **重新安裝擴充後連不上**（選項頁顯示 token mismatch）：擴充每個安裝有自己的隨機金鑰，而伺服器只記得一把。**把 RiffleDesk 伺服器重開一次**就會重新配對。

## 側邊欄（快翻模式）與一鍵回到 RiffleDesk

- **側邊欄**：點 Chrome 工具列上的擴充圖示（或收在拼圖選單裡的那一顆）就開／關側邊欄——它是 RiffleDesk 的精簡快翻模式：搜尋框＋篩選鈕（含「分頁」）＋卡堆，沒有資料夾樹與閱讀欄。點分頁卡＝切到那個分頁；點檔案卡＝把檔投影到完整的 RiffleDesk 視窗（並帶它到前景），沒有完整視窗時改開一個新分頁。伺服器沒在跑時側邊欄顯示啟動教學，跑起來後 3 秒內自動接上。
- **點卡自動開側欄（Chrome）**：在 RiffleDesk 主畫面點分頁卡時，頁面會把點擊直接送給擴充（`chrome.runtime.sendMessage`，manifest 的 `externally_connectable` 只放行 `127.0.0.1`／`localhost`），擴充趁使用者手勢還在打開側欄、停在剛點的那張卡，並切到該分頁；側欄本來就開著時不再重開、只捲動到位。開不成（被拒／PWA 視窗／舊版擴充／Firefox）就只切分頁，主畫面秀一行退路提示。
- **一鍵回到 RiffleDesk**：按 `Alt+Shift+R` 把開著的 RiffleDesk（獨立 App 視窗或一般分頁，網址在 `127.0.0.1`／`localhost` 的設定埠上）帶到前景；一個都沒開就幫你開一個。manifest 把這個鍵標成 **global**——只有 ChromeOS 上才真的全系統生效；Windows/macOS 上你只用在「瀏覽器有焦點」的情況下按（`chrome://` 系統頁除外）。不順手或被佔走時，到 **chrome://extensions/shortcuts** 自己改建——找到「把開著的 RiffleDesk 帶到前景」那一條改掉即可（瀏覽器規定快捷鍵只能由使用者更改或預設值生效）。
- **Firefox**：側邊欄以 `sidebar_action` 提供（about:addons 不需要另外設定，Ctrl+B 以外的快速方式是用檢視選單的「側邊欄」切換）。快捷鍵同樣叫「把開著的 RiffleDesk 帶到前景」，在 about:addons 右上角齒輪 →「管理擴充功能快捷鍵」查看或修改；Firefox **不支援** Chrome 的 global 屬性，所以它只在 Firefox 有焦點時有效。

## 自動收合側欄（右緣抽屜；預設關）

Chrome 的真側邊欄不能自動收起來（瀏覽器沒有把它縮成一條的 API，打開也非得使用者手勢）。所以「平常不佔位、滑鼠往右碰到畫面邊緣才出現」是擴充自己在頁面上做的**右緣抽屜**：選項頁勾「自動收合側欄（滑鼠碰右邊緣展開）」後，每個一般網頁的右邊緣有一條 6px 的隱形觸發條——滑鼠碰過去停片刻就從右邊滑出 RiffleDesk 面板（覆疊在頁面上，不改版面寬度）；滑鼠移開約 0.4 秒自動收合，Esc 也收，抽屜標頭的 📌 釘住不收，左緣可拖拉調寬（會記住）。點網頁卡＝主視窗切分頁（與真側欄相同），切過去後那個分頁的抽屜一開始是收著的。真側邊欄在同一視窗開著時抽屜自動停用，不會一窗兩面板。

**用不到的地方**（瀏覽器不讓擴充內容腳本進這些頁面）：`chrome://` 系統頁、Chrome 線上應用程式商店（chromewebstore.google.com）、內建 PDF 檢視器；沒給「存取所有網站資料」權限的網站也一樣。改開關會即時套用到已開的分頁，不用重整理；但改了 manifest（例如升級擴充檔）後，已開分頁要重整才會換上新內容腳本。

## 它做了什麼（隱私說明）

- 只在分頁有變動時，把分頁清單（標題、網址、favicon、各視窗目前正在顯示的分頁截圖）送到 `http://127.0.0.1:<埠>/api/tabs`。**清單與截圖全部留在你自己的電腦，不上傳任何地方。**
- 埠號與配對金鑰存在擴充的 `storage.local`——也就是本機這個瀏覽器 profile 的資料夾，**不會同步到你的帳號或其他裝置**（Firefox 的擴充儲存也不跟 Sync 走）。連線狀態（上次推送時間／錯誤）存在 `storage.session`，關掉瀏覽器就消失。
- 你在 RiffleDesk 裡點「預覽」要讀內容時，它才在那個分頁裡執行一小段唯讀指令碼，取出標題＋頁面文字（≤200KB）＋DOM 原始碼（≤2MB，截斷會標示）傳回本機伺服器顯示。這個讀取**在你想要它時才發生，且只有本機 RiffleDesk 分頁能發起**（同源檢查＋金鑰配對兩道把關）。
- 「切到這個分頁」會把那個分頁帶到前景。Firefox 用 `tabs.update`＋`windows.update`，行為相同。
- 伺服器沒在跑時它會安靜地定期重試，不跳通知、不噴錯。
- **截圖快取（IndexedDB）**：縮小後的卡面截圖同時存進擴充自己的 IndexedDB（同一個網址去掉 `#` 後共用一張，上限 300 張／100MB，最少用到的先丟）。重開瀏覽器或擴充後，卡面立刻從快取補回來（放超過一週的舊圖不補），不用等重拍；剛拍過（30 分鐘內、同網址）的真截圖不重拍。選項頁有「**清除截圖快取**」鈕可一次清空。
- **背景分頁的 DOM 繪圖**：http／https 背景分頁沒有截圖時，擴充會進頁面把可視範圍（約 1280×800）直接畫成一張暫用卡面（`drawn`）——一次一個分頁、間隔 1 秒、3 秒畫不完就放棄（同一個分頁的同一網址記住不再碰，網址變了才再試），真截圖一下來就蓋掉畫出來的（畫出來的絕不蓋掉真截圖）。重站（Google 文件／Gmail／Slack／Figma……`DRAW_BLACKLIST` 可自行加）不畫。用的 html-to-image v1.11.11（MIT © bubkoo）釘在 `vendor/html-to-image.js`，不走 CDN。
- **無痕／隱私視窗**：除非你手動幫本擴充允許（Chrome：chrome://extensions「在無痕模式中允許」；Firefox：about:addons「在隱私視窗中執行」），隱私視窗的分頁不會被收進來。打開了的話，那些分頁的標題／網址／截圖當然也會一起推送。

## 安全模型（給好奇的人）

伺服器端三道關卡，全在記憶體、零設定：

1. 擴充的每個請求帶 `X-RiffleDesk-Ext: 1`，且不得帶一般網頁的 Origin（跨站網頁既設不出自訂標頭，也過不了 Sec-Fetch-Site 全域檢查）。
2. 擴充第一次啟動時產生隨機 48-hex 金鑰（storage.local）隨每個請求送出；伺服器記下第一次看到的金鑰，之後長不一樣的直接 403——擋掉「猜中標頭」的本機冒名者。
3. 「讀內容／切分頁」這類動作只有本機 RiffleDesk 介面發得起（同源規則），而且只能對擴充最新推播清單裡的分頁下手。主畫面「點卡開側欄」的直送訊息（`externally_connectable`）同樣只放行 `http://127.0.0.1`／`http://localhost` 且埠號必須等於設定值。

## 需要的權限（manifest 裡那幾項）

| 權限 | 用途 |
|---|---|
| `tabs` | 列出開著的分頁、切換分頁 |
| `scripting` + 所有網站 | 你點「預覽」要讀某個分頁時，進那頁抓文字與 DOM（瀏覽器規定要有 host 權限才進得去；Firefox 要在 about:addons 手動開啟網站權限，見上面安裝說明） |
| `storage` | 記住埠號、配對金鑰、最近連線狀態（全部本機） |
| `alarms` | 每分鐘補推一次清單，防止事件漏接 |
| `sidePanel`（僅 Chrome） | 點工具列圖示開／關側邊欄（快翻模式） |
| `127.0.0.1` / `localhost` | 跟本機 RiffleDesk 伺服器講話 |

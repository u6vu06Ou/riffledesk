# GitHub 現成專案調查：three.js 3D 檔案抽屜瀏覽器

- 調查日：2026-10-29。工具：`gh search repos`（13 組關鍵字）＋ `gh api` 逐案驗證語言／推進日期／外掛清單。
- 目標需求回顧：本機檔案瀏覽器，three.js 3D 呈現——左邊 45° 俯瞰「檔案櫃抽屜」、抽屜裡檔案卡可見內容縮圖（.md/.html/.json/.xlsx/圖片）、滑鼠把檔案拉到右邊展開閱讀。痛點：Windows 檔案總管看不到 .md 內容、看不出母資料夾下有哪些檔。
- 星數與更新日皆取自 GitHub API 回傳當日值。

## A. 3D／空間化檔案瀏覽器

| 專案 | 星 | 最近更新 | 一句話它做什麼 | 相似度 | 可借什麼 |
|---|---|---|---|---|---|
| [mcuelenaere/fsv](https://github.com/mcuelenaere/fsv) | 543 | 2026-10-24 | 經典 fsv：把檔案系統畫成賽博空間——資料夾＝房間、檔案＝積木、45° 俯瞰巡走。 | 高 | 整套視覺隱喻幾乎就是「檔案櫃」的原型；但它是原生 C/OpenGL，不是 three.js，也不做內容預覽。 |
| [thiekus/fsvwin](https://github.com/thiekus/fsvwin) | 110 | 2026-10-08 | fsv 的 Windows（MSVC）建置版，可直接在 Win11 跑。 | 高 | 直接裝來玩、確認 45° 檔案櫃手感和導航方式，再決定自製的抽屜幾何。 |
| [smourier/Treemapolis](https://github.com/smourier/Treemapolis) | 10 | 2026-10-24 | Windows 磁碟變可飛行的 3D 城市：資料夾＝板、檔案＝依大小的大樓；DirectX 12 ＋ C# NativeAOT，直接接 Windows shell namespace。 | 高（隱喻）/中（用途） | 借「接 Windows 命名空間、資料夾→3D 物件」的工程做法；它做磁碟空間分析，不做檔案內容閱讀。 |
| [Cyxuan0311/Fcon](https://github.com/Cyxuan0311/Fcon) | 1 | 2026-04-24 | Vue3 ＋ Three.js 的檔案系統教學視覺化工具。 | 中 | three.js 同源技術堆疊可抄架構；但本質是教學工具、星數低。 |
| [andrinr/three-js-asset-browser](https://github.com/andrinr/three-js-asset-browser) | 0 | 2025-01 | three.js drag & drop asset browser 概念驗證：3D 容器裡把素材拖出來用。 | 中低 | 概念最貼近「從 3D 容器拖出檔案」，但只是 PoC、零星、成品度低。 |

雜訊備註：搜尋另見多個 0~8 星的自造 hackathon 案（FileQuest、Layered-Management、Glomp 為 2012 年 C# 舊作等），成品度低，不建議參考。

## B. 快速預覽 markdown／文件的本機工具

| 專案 | 星 | 最近更新 | 一句話它做什麼 | 相似度 | 可借什麼 |
|---|---|---|---|---|---|
| [QL-Win/QuickLook](https://github.com/QL-Win/QuickLook) | 25,563 | 2026-10-28 | Windows 版 macOS Quick Look：檔案總管選檔按空白鍵即時預覽。 | 高 | 直接解痛點：核心已內建 MarkdownViewer 外掛（`QuickLook.Plugin/QuickLook.Plugin.MarkdownViewer`，code search 驗證），.md 是渲染後預覽、不是純文字。 |
| [QL-Win/QuickLook.Plugin.OfficeViewer](https://github.com/QL-Win/QuickLook.Plugin.OfficeViewer) | 577 | 2025-12-17 | QuickLook 的 Word／Excel／PowerPoint 預覽外掛（另有 OfficeViewer-Native 189★，改用 MS Office/WPS 元件渲染）。 | 高 | 補足 .xlsx 預覽這一塊。 |
| [microsoft/PowerToys](https://github.com/microsoft/PowerToys) | 140,136 | 2026-10-28 | 官方工具集，內含 Peek：空白鍵連續預覽多個檔案（程式碼／PDF／Web／Office 等）。 | 中高 | 與 QuickLook 二選一的替代方案。 |
| [secure-77/Perlite](https://github.com/secure-77/Perlite) | 1,997 | 2026-10-28 | 讀取一整個資料夾（Obsidian vault）的 .md，側欄樹狀導航＋渲染預覽＋全文搜尋的 web 檢視器（需 PHP 端）。 | 高 | 正中「看不出母資料夾下有哪些檔」：整個資料夾一覽無遺的現成方案。 |
| [k1LoW/mo](https://github.com/k1LoW/mo) | 1,074 | 2026-10-27 | CLI：`mo 檔.md` 直接用瀏覽器開渲染結果。 | 中高 | 輕量、可掛進 agent／腳本流程快速看 .md。 |
| [vaibhav-kakde-in/mdhero](https://github.com/vaibhav-kakde-in/mdhero) | 308 | 2026-10-28 | ~8MB 原生跨平台（Win/mac/Linux）Markdown 檢視器＋輕編輯。 | 中 | 想要獨立 app 而非外掛時的選項。 |
| [Skardyy/mcat](https://github.com/Skardyy/mcat) | 1,448 | 2026-10-28 | 終端機裡直接看圖／影片／PDF／md（Go 單檔執行檔）。 | 中（給歐哥個人流） | 歐哥常在終端工作，終端內快速瞄 .md 可用。 |

## C. three.js 拖曳卡片／抽屜／翻頁互動

| 專案 | 星 | 最近更新 | 一句話它做什麼 | 相似度 | 可借什麼 |
|---|---|---|---|---|---|
| [mrdoob/three.js](https://github.com/mrdoob/three.js) misc_controls_drag 例 | 117,133 | 2026-10-28 | 官方 DragControls 範例（`examples/misc_controls_drag.html`）：拖起 3D 物件、hover 高亮、限定平面拖曳。 | 高 | 「把檔案卡從抽屜拉出」的基本功直接抄這。 |
| [pmndrs/drei](https://github.com/pmndrs/drei) | 10,070 | 2026-10-28 | react-three-fiber 助手集：DragControls wrapper、`Html` 把 DOM 浮印在 3D 物件上。 | 高 | 走 React 路線直接用；`Html` 正是「檔案卡上疊真 DOM 縮圖/標籤」的捷徑，不用自己做 3D 貼字。 |
| [pmndrs/drei-vanilla](https://github.com/pmndrs/drei-vanilla) | 618 | 2026-10-05 | 同 drei 的理念但給純 three.js（不綁 React）。 | 高 | 歐哥若走 vanilla three.js（不引 React）用這套。 |
| [bbdaii/three-pivot-controls](https://github.com/bbdaii/three-pivot-controls) | 20 | 2026-10-09 | vanilla three.js 的 pivot 控制器：拖曳平移／旋轉／縮放，滑鼠＋觸控。 | 中 | 小而完整、可直接抄的 vanilla 拖曳控制碼。 |
| [Nodlik/StPageFlip](https://github.com/Nodlik/StPageFlip) | 899 | 2026-10-28 | 實感翻頁動畫庫（另有 react-pageflip 757★ 的 React wrapper）。 | 中 | 「拉出到右邊展開閱讀」的翻頁手法。 |
| [codrops/PageFlipLayout](https://github.com/codrops/PageFlipLayout) | 173 | 2026-10-22 | 雜誌式版面＋平坦翻頁動畫（Codrops 範本）。 | 中 | 閱讀展開的另一種（更扁平、更快）動畫範本。 |
| [finktheartist/book-shelf](https://github.com/finktheartist/book-shelf) | 0 | 2026-08-25 | three.js 書架 web component：書背花紋由書名／作者程序化生成，不需封面圖。 | 中（概念） | 「程序化生成書脊視覺」對檔案卡美術化有啟發（.md/.json 沒有縮圖，可程序生卡片面）；但零星、成品度低。 |

## 結論

**沒有「已經能直接用」的成品**——沒有任何專案同時做到 three.js ＋ 抽屜/檔案櫃隱喻 ＋ 縮圖內容預覽 ＋ 拉出展開閱讀。這四件事要湊，得自己組。

推薦參考（依用途）：

1. **fsv / fsvwin（先裝 fsvwin 玩手感）**：45° 俯瞰檔案系統的視覺隱喻是最接近歐哥想像的老前輩，「母資料夾→房間/抽屜、檔案→積木/卡片」它 20 年前就畫了；用它校準抽屜幾何與巡走視角。
2. **QuickLook（立刻止血）＋ Perlite/mo（資料夾級總覽）**：QuickLook 內建 .md 渲染預覽、外加 OfficeViewer 補 .xlsx，今天就能讓 .md/.xlsx 在檔案總管裡按空白鍵看內容——與自製 3D 瀏覽器兩條腿走路不衝突；「母資料夾下有哪些檔」的整夾總覽，Perlite（側欄樹＋渲染預覽）是現成方案，輕量另有 `mo`。
3. **動手開發的技術組合**：`three.js misc_controls_drag`（拖曳基本功）＋ `drei-vanilla` 的 `Html`（DOM 縮圖直接浮在 3D 檔案卡上，.md/.json 沒縮圖的用程序化卡面，參考 book-shelf 的書脊生成）＋ `StPageFlip`／`PageFlipLayout`（展開閱讀動畫）。

另記：`QuickLook.WebPlugins`（QuickLook 的 WebView2 HTML 外掛機制，0★）——未來自製 3D 瀏覽器成熟後，甚至有機會塞進 QuickLook 的預覽視窗當外掛，僅供記錄。

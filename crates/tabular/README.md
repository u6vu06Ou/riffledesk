# tabular

把試算表與分隔符文字檔讀成可序列化的 `Table`，供 Tauri command 直接回傳給前端。

## 支援格式

| 格式 | 說明 |
|---|---|
| `.xlsx` / `.xlsm` / `.xlsb` / `.xls` / `.ods` | 走 calamine；可取工作表清單、指定工作表 |
| `.csv` / `.tsv` / `.txt` | 自動偵測分隔符（`,` `\t` `;` `\|`）、BOM、編碼（UTF-8 / UTF-16 BOM / Big5、GBK 等），解不開的位元組變 U+FFFD |

## API

```rust
pub fn read_table(path: &str, max_rows: usize, max_cols: usize) -> Result<Table, TabularError>
```
讀第一個可見工作表（文字檔則是整份文件）。`max_rows` / `max_cols` 為 `0` 表示「不特別限」，
但**任何情況都不會超過**硬天花板與儲存格預算（見下方「記憶體與上限」）；指定了超過上限的值
也會被靜默降下來，是否因而截斷看 `truncated`。

```rust
pub fn read_sheet(path: &str, sheet_name: &str, max_rows: usize, max_cols: usize) -> Result<Table, TabularError>
```
讀指定名稱的工作表。文字檔只有一個空名稱的工作表（`""`）。

```rust
pub struct Table {
    pub sheet_names: Vec<String>, // 檔案裡所有工作表名稱；文字檔固定 [""]
    pub sheet: String,            // 實際讀出的工作表
    pub headers: Vec<String>,     // 第一列
    pub rows: Vec<Vec<String>>,   // 資料列，長度補齊到 headers
    pub total_rows: usize,        // 檔案資料列總數（不受 max_rows 影響）
    pub truncated: bool,          // 是否因上限被截斷
}
```

```rust
pub struct TabularError { pub kind: &'static str, pub message: String, pub path: Option<PathBuf> }
```
`kind` 為穩定字串：`unsupported` / `io` / `open` / `parse` / `sheet_not_found` / `not_a_worksheet` / `empty_workbook`。

## 格式化規則

- 日期 → `YYYY-MM-DD`；日期時間 → `YYYY-MM-DD HH:MM:SS`；純時間／時長 → `HH:MM:SS`
- 浮點整數值不帶小數點；其餘用最短往返表示（`0.1`、`1e-12` 都不失真）
- 布林 → `TRUE` / `FALSE`；Excel 錯誤值保留 `#DIV/0!` 等原樣；空格子 → `""`

## 記憶體與上限

文字檔全程串流：只讀前 64 KiB 判編碼與分隔符，之後逐記錄解析，只保留前 `max_rows` 列。
`total_rows` 要準確，所以**整份檔案仍會被解析一遍**（記憶體不隨列數成長，CPU 會）；前端
若只要前幾列、不需要總數，仍會付出一次完整掃描。試算表受 calamine 限制必須先讀成整張
`Range`，本 crate 只控制回傳量。

回傳量另有兩道閘門：硬天花板 `HARD_ROW_CAP = 1_000_000` / `HARD_COL_CAP = 10_000`，以及
**儲存格預算 `HARD_CELL_BUDGET = 2_000_000`**——累計回傳格數一到就停止保留（仍繼續讀完計數）。
所以「標題一行、資料列超寬」的檔案也擋得住，`max_rows = 0` 不會爆掉。

calamine 本身沒有上限保護：zip bomb 或超大 sharedStrings 會在 `max_rows` 生效前就被解開。

## 已知限制

- 沒有 BOM 的 UTF-16 只有兩種情形猜得到：ASCII 為主（靠 NUL 分佈）與中日韓為主
  （靠成對字元檢查）。夾雜大量拉丁字母的 UTF-16 仍可能被判成別的東西。
- 沒有 BOM 的 Big5／GBK 靠統計猜測，短檔或大量混雜西歐重音字時可能猜錯；猜錯時位元組
  會變 U+FFFD，不會靜默掉資料。
- 分隔符偵測只看前 64 KiB 的前 50 行，且只認 `, \t ; |`。
- `sheet_names` 照原樣回傳，圖表頁也會列在裡面；讀它會拿到 `not_a_worksheet`。

## 範例

```rust
use tabular::read_table;

let table = read_table(r"C:\data\report.xlsx", 200, 0)?;
println!("{} 欄 {} 列（總計 {} 列）", table.headers.len(), table.rows.len(), table.total_rows);
```

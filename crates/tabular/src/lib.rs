//! `tabular` — 把試算表與分隔符文字檔轉成可序列化的 `Table`。
//!
//! 支援 `.xlsx` / `.xlsm` / `.xls` / `.xlsb` / `.ods`（透過 calamine）與
//! `.csv` / `.tsv` / `.txt`（自動偵測分隔符、BOM、編碼；解不開的位元組走 lossy）。
//!
//! 記憶體：文字檔全程串流，只保留前 `max_rows` 列；試算表受 calamine 限制必須先
//! 由它把整張工作表讀成 `Range`，本 crate 只控制回傳給前端的量。
//!
//! 所有公開函式都回傳 `Result<Table, TabularError>`，`Table` 可 `serde::Serialize`
//! 直接丟給 Tauri command 回傳給前端。

use std::fs::File;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};

use calamine::{open_workbook_auto, Data, Reader, Sheets, SheetType};
use encoding_rs_io::DecodeReaderBytesBuilder;
use serde::Serialize;

/// 上限保護用的硬天花板（避免前端亂傳超大值）。
/// 列數用「儲存格預算」算，不用固定列數：10M 列 × 多欄的 `String` 可以吃掉數 GB，
/// 但同樣 10M 列、只回 3 欄卻很輕鬆。
const HARD_ROW_CAP: usize = 1_000_000;
const HARD_COL_CAP: usize = 10_000;
/// `max_rows` / `max_cols` 都給 0 時，回傳量最多這麼多格（約 500 MB 的 String 上限）。
const HARD_CELL_BUDGET: usize = 2_000_000;
/// 分隔符偵測最多看幾個位元組。
const SNIFF_BYTES: usize = 64 * 1024;
const CANDIDATE_DELIMS: [u8; 4] = [b',', b'\t', b';', b'|'];

/// 錯誤型別。可直接序列化成 `{"kind": ..., "message": ...}`。
#[derive(Debug, Serialize)]
pub struct TabularError {
    /// 錯誤種類（穩定字串，前端可 switch）。
    pub kind: &'static str,
    /// 人看得懂的訊息。
    pub message: String,
    /// 出錯的檔案路徑（若已知）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<PathBuf>,
}

impl TabularError {
    fn new(kind: &'static str, message: impl Into<String>) -> Self {
        Self { kind, message: message.into(), path: None }
    }

    fn with_path(mut self, path: &Path) -> Self {
        self.path = Some(path.to_path_buf());
        self
    }

    fn io(path: &Path, err: &std::io::Error) -> Self {
        Self::new("io", err.to_string()).with_path(path)
    }
}

impl std::fmt::Display for TabularError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.kind, self.message)
    }
}

impl std::error::Error for TabularError {}

/// 轉換結果。欄位名固定，直接對應前端表格。
#[derive(Debug, Clone, Serialize)]
pub struct Table {
    /// 檔案裡所有工作表名稱（文字檔固定為 `[""]`）。
    pub sheet_names: Vec<String>,
    /// 實際讀出的那一個工作表名稱。
    pub sheet: String,
    /// 第一列的標題。
    pub headers: Vec<String>,
    /// 資料列（不含標題），每列長度補齊到 `headers` 長度。
    pub rows: Vec<Vec<String>>,
    /// 檔案中的資料列總數（不含標題；受 truncation 影響前的最終數）。
    pub total_rows: usize,
    /// 是否因為 `max_rows` / `max_cols` 而截斷。
    pub truncated: bool,
}

/// 讀第一個工作表（文字檔則是整份）。
///
/// `max_rows` / `max_cols` 為 0 表示「不特別限」，實際仍受硬天花板與儲存格預算約束
/// （見 `HARD_CELL_BUDGET`），避免前端傳 0 時把幾 GB 的字串一次塞給 JSON。
/// 是不是因而被截斷，看回傳的 `truncated`。
pub fn read_table(path: &str, max_rows: usize, max_cols: usize) -> Result<Table, TabularError> {
    let p = Path::new(path);
    let kind = Kind::of(p)?;
    match kind {
        Kind::Text => read_text(p, None, max_rows, max_cols),
        Kind::Book => {
            let mut book = open_workbook_auto(p)
                .map_err(|e| TabularError::new("open", format!("{e}")).with_path(p))?;
            let names = book.sheet_names();
            let sheet = first_worksheet(&book)
                .ok_or_else(|| TabularError::new("empty_workbook", "檔案沒有任何工作表").with_path(p))?;
            // 整本都是圖表頁時，`first_worksheet` 會勉為其難挑第一個；這裡跟 `read_sheet`
            // 用同一個錯誤種類，前端不必分辨兩條路徑。
            if !sheet_metadata(&book).iter().any(|s| s.name == sheet && s.typ == SheetType::WorkSheet) {
                return Err(TabularError::new(
                    "not_a_worksheet",
                    format!("{sheet:?} 不是資料工作表（可能是圖表頁）"),
                )
                .with_path(p));
            }
            read_book_sheet(&mut book, &names, &sheet, max_rows, max_cols).map_err(|e| e.with_path(p))
        }
    }
}

/// 讀指定名稱的工作表。
pub fn read_sheet(
    path: &str,
    sheet_name: &str,
    max_rows: usize,
    max_cols: usize,
) -> Result<Table, TabularError> {
    let p = Path::new(path);
    let kind = Kind::of(p)?;
    match kind {
        Kind::Text => {
            // 文字檔只有一個「工作表」（名字固定是空字串），名稱不符就當找不到。
            if sheet_name != TEXT_SHEET {
                return Err(TabularError::new(
                    "sheet_not_found",
                    format!("文字檔沒有工作表 {sheet_name:?}"),
                )
                .with_path(p));
            }
            read_text(p, Some(sheet_name), max_rows, max_cols)
        }
        Kind::Book => {
            let mut book = open_workbook_auto(p)
                .map_err(|e| TabularError::new("open", format!("{e}")).with_path(p))?;
            let names = book.sheet_names();
            let sheets = sheet_metadata(&book);
            match sheets.iter().find(|s| s.name == sheet_name) {
                None => {
                    return Err(TabularError::new(
                        "sheet_not_found",
                        format!("找不到工作表 {sheet_name:?}"),
                    )
                    .with_path(p));
                }
                // 圖表頁沒有儲存格，先講清楚而不是讓 worksheet_range 丟籠統錯誤。
                Some(s) if s.typ != SheetType::WorkSheet => {
                    return Err(TabularError::new(
                        "not_a_worksheet",
                        format!("{sheet_name:?} 不是資料工作表（可能是圖表頁）"),
                    )
                    .with_path(p));
                }
                Some(_) => {}
            }
            read_book_sheet(&mut book, &names, sheet_name, max_rows, max_cols).map_err(|e| e.with_path(p))
        }
    }
}

const TEXT_SHEET: &str = "";

enum Kind {
    Text,
    Book,
}

impl Kind {
    fn of(p: &Path) -> Result<Self, TabularError> {
        let ext = p
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        match ext.as_str() {
            "csv" | "tsv" | "txt" => Ok(Kind::Text),
            "xlsx" | "xls" | "xlsm" | "xlsb" | "ods" => Ok(Kind::Book),
            _ => Err(TabularError::new("unsupported", format!("不支援的副檔名: {ext:?}")).with_path(p)),
        }
    }
}

/// 各格式的 `Sheets` 變體都只是把 `sheets_metadata()` 轉發出去，這裡一口氣抹平。
fn sheet_metadata<RS: Read + std::io::Seek>(book: &Sheets<RS>) -> Vec<calamine::Sheet> {
    match book {
        Sheets::Xls(b) => b.sheets_metadata().to_vec(),
        Sheets::Xlsx(b) => b.sheets_metadata().to_vec(),
        Sheets::Xlsb(b) => b.sheets_metadata().to_vec(),
        Sheets::Ods(b) => b.sheets_metadata().to_vec(),
    }
}

/// 挑第一個「能讀」的工作表：可見的資料工作表優先，其次任何資料工作表，最後才退而求其次。
/// 圖表頁沒有儲存格，只在整本都沒有資料工作表時才選它。
fn first_worksheet<RS: Read + std::io::Seek>(book: &Sheets<RS>) -> Option<String> {
    let sheets = sheet_metadata(book);
    sheets
        .iter()
        .find(|s| s.typ == SheetType::WorkSheet && s.visible == calamine::SheetVisible::Visible)
        .or_else(|| sheets.iter().find(|s| s.typ == SheetType::WorkSheet))
        .or_else(|| sheets.first())
        .map(|s| s.name.clone())
}

fn read_book_sheet<RS: Read + std::io::Seek>(
    book: &mut Sheets<RS>,
    names: &[String],
    sheet: &str,
    max_rows: usize,
    max_cols: usize,
) -> Result<Table, TabularError> {
    let (cap_rows, cap_cols) = (cap(max_rows, HARD_ROW_CAP), cap(max_cols, HARD_COL_CAP));
    let range = match book {
        Sheets::Xls(b) => b.worksheet_range(sheet).map_err(|e| format!("{e}")),
        Sheets::Xlsx(b) => b.worksheet_range(sheet).map_err(|e| format!("{e}")),
        Sheets::Xlsb(b) => b.worksheet_range(sheet).map_err(|e| format!("{e}")),
        Sheets::Ods(b) => b.worksheet_range(sheet).map_err(|e| format!("{e}")),
    }
    .map_err(|e| TabularError::new("parse", e))?;

    let width = range.width().min(cap_cols);
    let mut iter = range.rows();
    let mut headers: Vec<String> = Vec::with_capacity(width);
    if let Some(hdr) = iter.next() {
        for c in 0..width {
            headers.push(hdr.get(c).map(fmt_cell).unwrap_or_default());
        }
    }

    // 只需要前 cap_rows 列內容；總列數用 height 直接算，不必把剩下的也都走一遍。
    let cap_rows = row_budget(cap_rows, width);
    let mut rows = Vec::new();
    for row in iter.take(cap_rows) {
        let mut out = Vec::with_capacity(width);
        for c in 0..width {
            out.push(row.get(c).map(fmt_cell).unwrap_or_default());
        }
        rows.push(out);
    }

    let total = range.height().saturating_sub(1);
    Ok(Table {
        sheet_names: names.to_vec(),
        sheet: sheet.to_string(),
        headers,
        rows,
        total_rows: total,
        truncated: total > cap_rows || range.width() > cap_cols,
    })
}

fn cap(v: usize, hard: usize) -> usize {
    if v == 0 {
        hard
    } else {
        v.min(hard)
    }
}

/// 已知欄寬後，把列預算壓到「欄 × 列 ≤ `HARD_CELL_BUDGET`」。
/// 這是 `max_rows = 0`（不限）時避免爆記憶體的第二道閘門：欄多的表自然少回幾列。
/// 前端明確指定 `max_rows` 且沒超過時不會被壓（`cap_rows` 就先命中了）。
fn row_budget(cap_rows: usize, width: usize) -> usize {
    let per_row = width.max(1);
    let by_cells = (HARD_CELL_BUDGET / per_row).max(1);
    cap_rows.min(by_cells).max(1)
}

fn read_text(
    path: &Path,
    sheet_name: Option<&str>,
    max_rows: usize,
    max_cols: usize,
) -> Result<Table, TabularError> {
    let (cap_rows, cap_cols) = (cap(max_rows, HARD_ROW_CAP), cap(max_cols, HARD_COL_CAP));

    let file = File::open(path).map_err(|e| TabularError::io(path, &e))?;
    let mut file = BufReader::new(file);

    // 先讀前導原始位元組：用它判編碼與分隔符，之後才解碼，全程串流不整檔載入。
    let mut head_raw = Vec::with_capacity(SNIFF_BYTES);
    let mut buf = [0u8; 8192];
    while head_raw.len() < SNIFF_BYTES {
        let n = file.read(&mut buf).map_err(|e| TabularError::io(path, &e))?;
        if n == 0 {
            break;
        }
        head_raw.extend_from_slice(&buf[..n]);
    }

    let (head_bytes, bom_enc) = split_bom(&head_raw);
    let enc = bom_enc.unwrap_or_else(|| sniff_encoding(head_bytes));
    // 分隔符只在前導片段上判斷，解碼結果本身不會拿去餵 csv，所以這裡的損耗無所謂。
    let delim = detect_delimiter(decode_lossy(head_bytes, enc).as_bytes());

    // 真正的解析把「前導原始位元組 + 剩下的檔案」接成單一條串流再解碼：
    // 這樣跨前導邊界的一個字元只會被解一次，不會變成兩個 U+FFFD。
    // `utf8_passthru(false)` 讓非法位元組一律變 U+FFFD，而不是原樣漏給 csv。
    let mut builder = DecodeReaderBytesBuilder::new();
    builder.encoding(Some(enc as &_)).bom_sniffing(false).utf8_passthru(false);
    let decoded = builder.build(std::io::Cursor::new(head_bytes.to_vec()).chain(file));

    let mut rdr = csv::ReaderBuilder::new()
        .delimiter(delim)
        .flexible(true)
        .has_headers(false)
        .from_reader(decoded);

    let mut records = rdr.records();
    let mut headers: Vec<String> = Vec::new();
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut total = 0usize;
    let mut saw_wide_row = false;

    if let Some(rec) = records.next() {
        let rec = rec.map_err(|e| csv_err(path, e))?;
        saw_wide_row |= rec.len() > cap_cols;
        headers = rec.iter().take(cap_cols).map(str::to_string).collect();
    }

    // 儲存格預算：文字檔的列寬不受標題寬度約束（`flexible(true)` 允許每列長短不一），
    // 所以不能只拿標題寬度去算，改成邊收邊扣。用完就停止保留，但仍繼續讀完整檔計數。
    let mut cells_left = HARD_CELL_BUDGET.saturating_sub(headers.len());
    let mut hit_budget = false;
    for rec in records {
        let rec = rec.map_err(|e| csv_err(path, e))?;
        total += 1;
        saw_wide_row |= rec.len() > cap_cols;
        if rows.len() >= cap_rows {
            continue; // 仍要計數，但不再保留內容
        }
        if cells_left == 0 {
            hit_budget = true;
            continue;
        }
        let mut out: Vec<String> = rec.iter().take(cap_cols).map(str::to_string).collect();
        out.resize(headers.len().max(out.len()), String::new());
        cells_left = cells_left.saturating_sub(out.len());
        rows.push(out);
    }

    let width = headers.len().max(rows.iter().map(Vec::len).max().unwrap_or(0));
    headers.resize(width, String::new());
    for r in &mut rows {
        r.resize(width, String::new());
    }

    Ok(Table {
        sheet_names: vec![TEXT_SHEET.to_string()],
        sheet: sheet_name.unwrap_or(TEXT_SHEET).to_string(),
        headers,
        rows,
        total_rows: total,
        truncated: total > cap_rows || hit_budget || saw_wide_row,
    })
}

/// csv 解析／讀取錯誤 → 分得出「讀檔失敗」與「格式壞掉」。
fn csv_err(path: &Path, e: csv::Error) -> TabularError {
    let kind = if e.is_io_error() { "io" } else { "parse" };
    TabularError::new(kind, e.to_string()).with_path(path)
}

/// 剝掉開頭的 BOM，回傳（去掉 BOM 的內容, BOM 指定的編碼）。
fn split_bom(bytes: &[u8]) -> (&[u8], Option<&'static encoding_rs::Encoding>) {
    if let Some((enc, len)) = encoding_rs::Encoding::for_bom(bytes) {
        (&bytes[len..], Some(enc))
    } else {
        (bytes, None)
    }
}

/// 沒有 BOM 時猜編碼。
///
/// 順序很重要：先看 UTF-16 的 NUL 分佈（沒有 BOM 的 UTF-16 每個 ASCII 字元都夾一個 NUL，
/// 而這種位元組「是合法 UTF-8」，先做 UTF-8 檢查就會把它當成正常內容而滿是 NUL）。
/// 再確認是否整段都是合法 UTF-8——注意要容忍尾端被切斷的半個字元，否則大檔會誤判成 legacy。
/// 以上都不是才交給 chardetng 猜（能辨識 Big5／GBK）；猜到單一位元組碼時再做一次
/// Big5／GBK 交叉檢查。
fn sniff_encoding(bytes: &[u8]) -> &'static encoding_rs::Encoding {
    if bytes.is_empty() {
        return encoding_rs::UTF_8;
    }
    if let Some(enc) = sniff_utf16(bytes) {
        return enc;
    }
    if let Some(enc) = sniff_utf16_by_pairs(bytes) {
        return enc;
    }
    match std::str::from_utf8(bytes) {
        Ok(_) => encoding_rs::UTF_8,
        // `error_len() == None` 表示只是尾端被切成半個字元，前面全都合法 → 就是 UTF-8。
        Err(e) if e.error_len().is_none() => encoding_rs::UTF_8,
        Err(_) => {
            // 注意要餵「整段」位元組，不能只餵 `valid_up_to()` 之前的片段：
            // 整份檔案都是 Big5／GBK 時，第一個位元組就非法，前綴會是空的，
            // 偵測器拿到空輸入只能回 windows-1252。
            let mut det = chardetng::EncodingDetector::new(chardetng::Iso2022JpDetection::Allow);
            det.feed(bytes, true);
            let guessed = det.guess(None, chardetng::Utf8Detection::Deny);
            // 單一位元組編碼幾乎不會產生 U+FFFD，卻常吃掉東亞雙位元組序列，
            // 所以猜成單位元組碼時再跟 Big5／GBK 交叉檢查。
            if is_single_byte(guessed) {
                prefer_clean_cjk(bytes, guessed)
            } else {
                guessed
            }
        }
    }
}

/// 以中日韓為主的 UTF-16 幾乎沒有 NUL（「中」＝ `2D 4E`），上面靠 NUL 的啟發式會漏掉，
/// 而位元組又剛好是合法 UTF-8，於是整份被當成 UTF-8 讀成一堆怪字。
/// 這裡補一層：檢查位元組是否「每兩個一組都像同一個平面上的字」（ASCII／CJK／標點），
/// 且這一組的組成比例要高，才判成 UTF-16。
fn sniff_utf16_by_pairs(bytes: &[u8]) -> Option<&'static encoding_rs::Encoding> {
    let sample = &bytes[..bytes.len().min(4096) & !1];
    if sample.len() < 32 {
        return None;
    }
    let plausible = |le: bool| {
        let mut good = 0usize;
        for chunk in sample.chunks_exact(2) {
            let unit = if le {
                u16::from_le_bytes([chunk[0], chunk[1]])
            } else {
                u16::from_be_bytes([chunk[0], chunk[1]])
            };
            if matches!(unit, 0x09 | 0x0A | 0x0D | 0x20..=0x7E | 0x3000..=0x30FF | 0x3400..=0x9FFF | 0xFF00..=0xFFEF)
            {
                good += 1;
            }
        }
        good
    };
    // ASCII 為主的內容（UTF-16 每字都夾 NUL）已由上面那層擋掉，這裡只處理中日韓為主的檔案。
    // 中日韓 UTF-16 的位元組幾乎一半是高位元組，所以要求高位元組至少有兩成；
    // 否則 `aaaa…中` 這種幾乎純 ASCII 的 UTF-8 也會被每兩個一組湊成假的漢字。
    let high = sample.iter().filter(|&&b| b >= 0x80).count();
    if high * 5 < sample.len() {
        return None;
    }
    let total = sample.len() / 2;
    let needs_hero = total * 9 / 10;
    let (le, be) = (plausible(true), plausible(false));
    if le >= needs_hero && le > be {
        Some(encoding_rs::UTF_16LE)
    } else if be >= needs_hero {
        Some(encoding_rs::UTF_16BE)
    } else {
        None
    }
}

/// 猜測結果是不是單位元組編碼（windows-125x、ISO-8859-x 等）——chardetng 在大檔案上的
/// 常見誤判區。用 `is_single_byte()` 做結構判斷，比列舉名字完整：換成 1251／1253／
/// ISO-8859-7 也照樣能觸發救援。
fn is_single_byte(enc: &'static encoding_rs::Encoding) -> bool {
    enc.is_single_byte()
}

/// 猜成西歐單一位元組碼時，考慮改用 Big5／GBK。
///
/// 東亞雙位元組檔案被猜成 windows-1252 時，整段會變成「Ã¥ÂÂ°」這種亂碼，
/// 但因為每個位元組都合法，U+FFFD 數是 0，光比錯誤數翻不回來。所以先做結構檢查：
/// 高位元組是不是幾乎都成對（lead 0x81–0xFE + trail 0x40–0x7E 或 0xA1–0xFE）。
/// 像 `café` 的單一個 0xE9 後面接逗號，湊不成對 → 維持西歐碼；真 Big5／GBK 幾乎全成對。
///
/// 過了結構檢查才比「解壞幾個字」，平手時比誰解出比較多中日韓字。
fn prefer_clean_cjk(bytes: &[u8], western: &'static encoding_rs::Encoding) -> &'static encoding_rs::Encoding {
    let (high, paired) = pair_ratio(bytes);
    if high < 2 || paired * 5 < high * 4 {
        return western;
    }
    let stats = |enc: &'static encoding_rs::Encoding| {
        let text = enc.decode(bytes).0;
        (text.matches('\u{FFFD}').count(), text.chars().filter(|c| is_cjk(*c)).count())
    };
    let (base_broken, base_cjk) = stats(western);
    let mut best = western;
    let mut best_stat = (base_broken, base_cjk);
    for cand in [encoding_rs::BIG5, encoding_rs::GBK] {
        let stat = stats(cand);
        // 錯誤更少，或錯誤一樣多但中文更多 → 換。
        // 注意 `broken` 幾乎永遠是 0（西歐碼對任何位元流都解得出東西，合法雙位元組也一樣），
        // 所以真正決定勝負的是下一段的 CJK 數，方向必須是「越大越好」。
        if stat.0 < best_stat.0 || (stat.0 == best_stat.0 && stat.1 > best_stat.1) {
            best = cand;
            best_stat = stat;
        }
    }
    // 兩邊都零錯誤、也都解不出中文（例如純 ASCII 夾一兩個高位元組）→ 不值得換。
    if best_stat.1 == 0 && base_cjk == 0 {
        return western;
    }
    best
}

/// 回傳（高位元組數, 其中「能構成雙位元組字」的數量）。
///
/// 兩個數字都以「lead」為單位算：配對成功時 trail 位元組直接跳過，不再計入分母，
/// 所以真正的雙位元組文字 paired/high 會接近 1。
fn pair_ratio(bytes: &[u8]) -> (usize, usize) {
    let mut high = 0usize;
    let mut paired = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        let b = bytes[i];
        if b < 0x80 {
            i += 1;
            continue;
        }
        high += 1;
        match bytes.get(i + 1) {
            // Big5 的 trail 是 0x40–0x7E / 0xA1–0xFE，GBK 另外還用 0x80–0xA0；
            // 取聯集，免得純 GBK 過不了門檻（0x7F 兩者都不用）。
            Some(&t) if (0x40..=0xFE).contains(&t) && t != 0x7F => {
                paired += 1;
                i += 2;
            }
            _ => i += 1,
        }
    }
    (high, paired)
}

fn is_cjk(c: char) -> bool {
    matches!(c as u32, 0x3400..=0x9FFF | 0xF900..=0xFAFF)
}

/// 沒有 BOM 的 UTF-16：高比例的 NUL 落在固定奇偶位置。
fn sniff_utf16(bytes: &[u8]) -> Option<&'static encoding_rs::Encoding> {
    let sample = &bytes[..bytes.len().min(4096)];
    if sample.len() < 16 {
        return None;
    }
    let even_nul = sample.iter().step_by(2).filter(|&&b| b == 0).count();
    let odd_nul = sample.iter().skip(1).step_by(2).filter(|&&b| b == 0).count();
    let half = sample.len() / 2;
    let threshold = half * 2 / 5; // 四成以上 → 幾乎確定是 UTF-16
    if odd_nul > threshold && odd_nul > even_nul * 4 {
        Some(encoding_rs::UTF_16LE)
    } else if even_nul > threshold && even_nul > odd_nul * 4 {
        Some(encoding_rs::UTF_16BE)
    } else {
        None
    }
}

/// 用指定編碼解碼，位元組解不開就變 U+FFFD。
fn decode_lossy(bytes: &[u8], enc: &'static encoding_rs::Encoding) -> String {
    let (cow, _, _) = enc.decode(bytes);
    cow.into_owned()
}

/// 從前置緩衝挑出「最像分隔符」的位元組。
///
/// 判準是「引號外每行欄數是否一致」——這比出現次數可靠得多：
/// `1,5;2,5` 這種逗號當小數點的檔案，逗號出現次數比較多，但它是每行固定兩個分號。
/// 同分時才比總數，再同分就取候選順序（逗號優先），最後才看誰真的出現過。
fn detect_delimiter(head: &[u8]) -> u8 {
    const MAX_LINES: usize = 50;

    // 先把前幾行切出來（引號內的換行不算行界）。行尾 `\r` 要剝掉，
    // 否則 CRLF 檔每行最後一格都帶著 `\r`，`1,5\r` 就判斷不出是小數。
    let mut lines: Vec<Vec<u8>> = Vec::new();
    let mut cur: Vec<u8> = Vec::new();
    let mut in_quotes = false;
    let mut i = 0usize;
    while i < head.len() {
        let b = head[i];
        match b {
            // CSV 的 `""` 是引號內的字面引號，不是「關閉再開啟」。先在引號內吃掉成對的
            // 第二個引號，`"""` 這種「開引號＋字面引號」才不會被當成收尾。
            b'"' if in_quotes && head.get(i + 1) == Some(&b'"') => {
                cur.push(b);
                cur.push(b);
                i += 2;
                continue;
            }
            b'"' => {
                in_quotes = !in_quotes;
                cur.push(b);
            }
            b'\n' if !in_quotes => {
                if lines.len() >= MAX_LINES {
                    break;
                }
                if cur.last() == Some(&b'\r') {
                    cur.pop();
                }
                lines.push(std::mem::take(&mut cur));
            }
            // 老 Mac 的單獨 `\r` 也是換行；`\r\n` 的情況交給上面的 `\n` 收拾。
            b'\r' if !in_quotes && head.get(i + 1) != Some(&b'\n') => {
                if lines.len() >= MAX_LINES {
                    break;
                }
                lines.push(std::mem::take(&mut cur));
            }
            _ => cur.push(b),
        }
        i += 1;
    }
    // 尾行沒有換行收尾（單行檔、或視窗剛好切在行中）也要算進去。
    if lines.len() < MAX_LINES {
        if cur.last() == Some(&b'\r') {
            cur.pop();
        }
        if !cur.is_empty() {
            lines.push(cur);
        }
    }

    // 每個候選算分數，全部「越小越像分隔符」：
    // ① 切完還夾著別的候選的殘渣比例（依殘渣長相加權）　② 欄數不一致的行數
    // ③ 沒出現的行數　④ 欄數總和取負（多欄比少欄好）
    // ① 處理 `1,5;2,5`：用逗號切會留下 `5;2` 這種殘渣，用分號切留下的 `1,5`
    // 是「數字＋逗號＋數字」，一看就是小數點，權重低。加權也讓
    // `a;Hello, World`（分號分隔、內文有逗號）不會因為候選順序而誤選逗號。
    let mut best: Option<([usize; 4], usize)> = None;
    for (i, &delim) in CANDIDATE_DELIMS.iter().enumerate() {
        let mut widths: Vec<usize> = Vec::new();
        let mut fields = 0usize;
        let mut junk = 0usize;
        for line in &lines {
            // 引號內的東西不算分隔符：先把引號段落遮成普通字元再切。
            let masked = mask_quoted(line);
            if !masked.contains(&delim) {
                continue; // 這行沒有這個分隔符 → 這行不投票
            }
            widths.push(masked.iter().filter(|&&b| b == delim).count() + 1);
            for field in masked.split(|&b| b == delim) {
                fields += 1;
                junk += junk_weight(field);
            }
        }
        if widths.is_empty() {
            continue; // 這個候選在這段緩衝裡根本沒出現
        }
        let modal = widths
            .iter()
            .copied()
            .max_by_key(|w| widths.iter().filter(|x| *x == w).count())
            .unwrap_or(0);
        let disagree = widths.iter().filter(|&&w| w != modal).count();
        let score = [
            junk * 1000 / fields.max(1),
            disagree,
            lines.len() - widths.len(),
            usize::MAX - widths.iter().sum::<usize>(),
        ];
        if best.as_ref().is_none_or(|(b, _)| score < *b) {
            best = Some((score, i));
        }
    }
    best.map_or(b',', |(_, i)| CANDIDATE_DELIMS[i])
}

/// 一個欄位裡「夾著別的候選分隔符」算幾分殘渣（0 ＝乾淨）。
///
/// 分數排序刻意是「小數 1 < 文章標點 3 < 真的切錯 4」：
/// - 數字裡的 `1,5` 是寫法的一部分，幾乎不算殘渣；
/// - 逗號後面跟著空白（`Hello, World`）是文章標點——用逗號切文章時留得下來，
///   但用分號切時這格本來就該含逗號，所以它比「沒切乾淨」輕；
/// - `5;2` 這種殘渣代表上一個分隔符切錯位置，最重。
fn junk_weight(field: &[u8]) -> usize {
    let mut weight = 0usize;
    let mut has_mark = false;
    for (i, b) in field.iter().enumerate() {
        if !CANDIDATE_DELIMS.contains(b) {
            continue;
        }
        has_mark = true;
        let spaced_before = i > 0 && field[i - 1] == b' ';
        let spaced_after = field.get(i + 1) == Some(&b' ');
        if spaced_before || spaced_after {
            weight += 3;
        }
    }
    if !has_mark {
        0
    } else if is_decimal_like(field) {
        1
    } else if weight > 0 {
        weight
    } else {
        4
    }
}

/// `12,5` / `1.5` / `1,234,567` 這種數字寫法（小數或千分位）。
///
/// 只認逗號與句點——分號、Tab、直線不是小數點，夾在欄位裡就是沒切乾淨。
/// 千分位（多個分隔符但每組剛好三位）也放行，否則歐洲檔的 `1.234,5` 會被誤判成殘渣。
fn is_decimal_like(field: &[u8]) -> bool {
    const DECIMAL_MARKS: [u8; 2] = [b',', b'.'];
    let mut groups: Vec<&[u8]> = Vec::new();
    let mut start = 0usize;
    let mut marks = 0usize;
    for (pos, &b) in field.iter().enumerate() {
        if DECIMAL_MARKS.contains(&b) {
            groups.push(&field[start..pos]);
            start = pos + 1;
            marks += 1;
        }
    }
    groups.push(&field[start..]);
    if marks == 0 || groups.len() < 2 {
        return false;
    }
    let digits = |s: &[u8]| !s.is_empty() && s.iter().all(u8::is_ascii_digit);
    if !groups.iter().all(|g| digits(g)) {
        return false;
    }
    // 單一分隔符 → 小數（`1,5`）；多個 → 千分位，首組 1–3 位、中間組剛好三位
    // （`1,234,567`、`1.234,5` 都算），最後一組是小數或整組，不再限制長度。
    marks == 1
        || ((1..=3).contains(&groups[0].len())
            && groups[1..groups.len() - 1].iter().all(|g| g.len() == 3))
}

/// 把引號包住的內容遮成 `x`（長度不變），讓分隔符統計看不到引號內的逗號分號。
///
/// 跟斷行器一樣要認得 `""` 跳脫：`"a""b"` 若逐個引號翻轉狀態，中間那組會把後面
/// 當成「引號外」，於是引號內的逗號就被算成分隔符。已經在引號內又看到 `"` 時
/// 多吞一個字元即可。
fn mask_quoted(line: &[u8]) -> Vec<u8> {
    let mut out = line.to_vec();
    let mut in_quotes = false;
    let mut i = 0usize;
    while i < out.len() {
        match out[i] {
            b'"' if in_quotes && out.get(i + 1) == Some(&b'"') => {
                out[i] = b'x';
                out[i + 1] = b'x';
                i += 2;
                continue;
            }
            b'"' => {
                in_quotes = !in_quotes;
                out[i] = b'x';
            }
            _ if in_quotes => out[i] = b'x',
            _ => {}
        }
        i += 1;
    }
    out
}

fn fmt_cell(d: &Data) -> String {
    match d {
        Data::Empty => String::new(),
        Data::Int(i) => i.to_string(),
        Data::Float(f) => fmt_float(*f),
        Data::String(s) => s.clone(),
        Data::Bool(b) => if *b { "TRUE" } else { "FALSE" }.to_string(),
        Data::DateTime(dt) => fmt_datetime(dt),
        Data::DateTimeIso(s) | Data::DurationIso(s) => s.clone(),
        Data::Error(e) => e.to_string(),
    }
}

fn fmt_float(f: f64) -> String {
    if f.is_nan() {
        return "NaN".to_string();
    }
    if f.is_infinite() {
        return if f > 0.0 { "Inf" } else { "-Inf" }.to_string();
    }
    // 整數值去掉小數點（Excel 常把整數存成浮點）；其餘交給 Display，
    // 它就是最短往返表示，不會像固定位數那樣把 1e-12 捨成 0。
    if f.fract() == 0.0 && f.abs() < 9.007_199_254_740_992e15 {
        return format!("{}", f as i64);
    }
    format!("{f}")
}

fn fmt_datetime(dt: &calamine::ExcelDateTime) -> String {
    let (y, mo, d, h, mi, s, ms) = dt.to_ymd_hms_milli();
    // 毫秒只有在真的有值時才顯示，否則一般的日期時間會多出 `.000` 雜訊。
    let frac = |ms: u16| if ms == 0 { String::new() } else { format!(".{ms:03}") };

    if dt.is_duration() || !dt.is_datetime() {
        // 用毫秒整數算，避免「先四捨五入到秒、又沿用原始毫秒」算出 03.600 這種鬼東西。
        let total_ms = (dt.as_f64() * 86_400_000.0).abs().round() as u64;
        let sign = if dt.as_f64() < 0.0 { "-" } else { "" };
        let (hh, mm, ss) = (total_ms / 3_600_000, (total_ms % 3_600_000) / 60_000, (total_ms % 60_000) / 1000);
        return format!("{sign}{hh:02}:{mm:02}:{ss:02}{}", frac((total_ms % 1000) as u16));
    }
    if (0.0..1.0).contains(&dt.as_f64()) {
        let _ = (y, mo, d); // 純時間沒有日期，這三個值無意義
        return format!("{h:02}:{mi:02}:{s:02}{}", frac(ms));
    }
    // 負的序列值＝1900 年之前的日期，仍然要印日期，不能當成純時間。
    let date_part = format!("{y:04}-{mo:02}-{d:02}");
    if h == 0 && mi == 0 && s == 0 && ms == 0 {
        date_part
    } else {
        format!("{date_part} {h:02}:{mi:02}:{s:02}{}", frac(ms))
    }
}

#[cfg(test)]
mod unit {
    use super::*;
    use calamine::{ExcelDateTime, ExcelDateTimeType};

    #[test]
    fn delimiter_prefers_consistent_width_not_frequency() {
        // 逗號出現 6 次、分號 3 次，但分號每行固定 → 選分號
        assert_eq!(detect_delimiter(b"1,5;2,5\n3,5;4,5\n5,5;6,5\n"), b';');
        assert_eq!(detect_delimiter(b"a\tb\n1\t2\n"), b'\t');
        // 單一行、沒有換行收尾
        assert_eq!(detect_delimiter(b"a|b|c"), b'|');
        // 全空 → 退回逗號
        assert_eq!(detect_delimiter(b""), b',');
        // 引號內的候選字元不投票
        assert_eq!(detect_delimiter(b"\"a;b\";c\n\"d;e\";f\n"), b';');
        // `""` 是引號內的字面引號，不該提前關閉引號狀態
        assert_eq!(detect_delimiter(b"\"a\"\"x,y\";c\n\"b\"\"p,q\";d\n"), b';');
        // 老 Mac 的單獨 `\r` 也算換行，否則整檔會縮成一行
        assert_eq!(detect_delimiter(b"a;b\r1;2\r3;4\r"), b';');
        // 分號分隔、內文含逗號＋空白：逗號是文章裡的，不能因為候選順序就贏
        assert_eq!(detect_delimiter(b"a;Hello, World\nb;Foo, Bar\nc;Baz, Qux\n"), b';');
    }

    #[test]
    fn junk_weight_orders_decimal_prose_and_missplits() {
        assert_eq!(junk_weight(b"plain"), 0);
        assert_eq!(junk_weight(b"1,5"), 1, "小數最輕");
        assert_eq!(junk_weight(b"Hello, World"), 3, "文章標點居中");
        assert_eq!(junk_weight(b"a;b"), 4, "沒切乾淨最重");
    }

    #[test]
    fn row_budget_caps_by_cells() {
        assert_eq!(row_budget(1_000_000, 1), 1_000_000, "單欄不會被砍");
        assert_eq!(row_budget(1_000_000, 10), 200_000, "十欄砍到儲存格預算");
        assert!(row_budget(5, 10) == 5, "前端指定的小值優先");
        assert_eq!(row_budget(1_000_000, 10_000_000), 1, "欄比預算還多也要留一列");
    }

    #[test]
    fn floats_are_shortest_roundtrip() {
        assert_eq!(fmt_float(42.0), "42");
        assert_eq!(fmt_float(-3.0), "-3");
        assert_eq!(fmt_float(3.5), "3.5");
        assert_eq!(fmt_float(0.1), "0.1");
        assert_eq!(fmt_float(1e-12), "0.000000000001", "固定位數會把它捨成 0");
        assert_eq!(fmt_float(f64::NAN), "NaN");
        assert_eq!(fmt_float(f64::NEG_INFINITY), "-Inf");
    }

    #[test]
    fn datetimes_use_human_readable_layout() {
        let date = ExcelDateTime::new(45943.0, ExcelDateTimeType::DateTime, false);
        assert_eq!(fmt_datetime(&date), "2025-10-13");
        let stamp = ExcelDateTime::new(45943.541, ExcelDateTimeType::DateTime, false);
        assert_eq!(fmt_datetime(&stamp), "2025-10-13 12:59:02.400");
        let time = ExcelDateTime::new(0.5, ExcelDateTimeType::DateTime, false);
        assert_eq!(fmt_datetime(&time), "12:00:00");
        let dur = ExcelDateTime::new(0.5, ExcelDateTimeType::TimeDelta, false);
        assert_eq!(fmt_datetime(&dur), "12:00:00");
        let neg = ExcelDateTime::new(-0.25, ExcelDateTimeType::TimeDelta, false);
        assert_eq!(fmt_datetime(&neg), "-06:00:00");
        // 負的日期序列值（1900 年之前）要印日期，不能退化成純時間
        let old = ExcelDateTime::new(-1.5, ExcelDateTimeType::DateTime, false);
        let s = fmt_datetime(&old);
        assert!(s.starts_with("1899-"), "負序列值要印日期：{s}");
    }

    #[test]
    fn cjk_only_utf16_is_detected_without_bom() {
        // 全中文的 UTF-16LE 幾乎沒有 NUL，而且位元組是合法 UTF-8；靠「成對字元」判斷。
        let text = "台北,250\n台中,280\n高雄,300\n新竹,50\n";
        let bytes: Vec<u8> = text.encode_utf16().flat_map(u16::to_le_bytes).collect();
        assert_eq!(sniff_encoding(&bytes), encoding_rs::UTF_16LE);
        let be: Vec<u8> = text.encode_utf16().flat_map(u16::to_be_bytes).collect();
        assert_eq!(sniff_encoding(&be), encoding_rs::UTF_16BE);
        // 純 ASCII 的 UTF-8 不能被誤判成 UTF-16（每組兩個 ASCII 也「像」字）
        assert_eq!(sniff_encoding(b"a,b\n1,2\n3,4\n5,6\n"), encoding_rs::UTF_8);
        // 一大段中文 UTF-8 也一樣：位元組雖多，成對切成 u16 大多是無意義的漢字
        let utf8 = "台北,250\n台中,280\n高雄,300\n新竹,50\n".repeat(20);
        assert_eq!(sniff_encoding(utf8.as_bytes()), encoding_rs::UTF_8);
    }

    #[test]
    fn bom_split_and_sniff() {
        assert_eq!(split_bom(&[0xEF, 0xBB, 0xBF, b'a']).0, b"a");
        assert!(split_bom(&[0xEF, 0xBB, 0xBF, b'a']).1.is_some());
        assert!(split_bom(b"a").1.is_none());
        assert_eq!(sniff_encoding(b"abc"), encoding_rs::UTF_8);
        // 真實的 Big5 CSV 內容（「台北,250 / 台中,280」）
        let big5: [u8; 19] = [
            0xA5, 0x78, 0xA5, 0x5F, b',', b'2', b'5', b'0', b'\n', 0xA5, 0x78, 0xA4, 0xA4, b',',
            b'2', b'8', b'0', b'\n', b'\n',
        ];
        assert_eq!(sniff_encoding(&big5), encoding_rs::BIG5);
    }

    #[test]
    fn western_text_stays_western() {
        // `café,naïve`（windows-1252）：高位元組是散的單一個，不該被當成 Big5/GBK
        let latin = [b'c', b'a', b'f', 0xE9, b',', b'n', b'a', 0xEF, b'v', b'e', b'\n'];
        assert!(is_single_byte(sniff_encoding(&latin)), "{}", sniff_encoding(&latin).name());
        let (cow, _, _) = sniff_encoding(&latin).decode(&latin);
        assert_eq!(cow, "café,naïve\n");
    }

    #[test]
    fn pair_ratio_counts_pairs_not_trails() {
        // 純 Big5：四個位元組 → 兩對
        assert_eq!(pair_ratio(&[0xA5, 0x78, 0xA5, 0x5F]), (2, 2));
        // 西歐：0xE9 後面接逗號（0x2C 不在 trail 範圍）→ 沒有成對
        assert_eq!(pair_ratio(&[0xE9, b',']), (1, 0));
    }

    #[test]
    fn rescue_switches_off_western_when_cjk_appears() {
        // 直接餵「已被誤判成 windows-1252」的情況：錯的是 `guessed`，不是 chardetng。
        // 台北/台中/高雄 的 Big5 位元組
        let big5: Vec<u8> = vec![
            0xA5, 0x78, 0xA5, 0x5F, b',', b'2', b'5', b'0', b'\n', 0xA5, 0x78, 0xA4, 0xA4, b',',
            b'2', b'8', b'0', b'\n', 0xB0, 0xAA, 0xB6, 0xAF, b',', b'3', b'0', b'0', b'\n',
        ];
        let picked = prefer_clean_cjk(&big5, encoding_rs::WINDOWS_1252);
        assert_ne!(picked, encoding_rs::WINDOWS_1252, "零錯誤平手時要選解得出中文的那邊");
        let (text, _, _) = picked.decode(&big5);
        assert!(text.starts_with("台北"), "{text}");

        // 純西歐文字：高位元組湊不成對 → 保持 windows-1252
        let latin = [b'c', b'a', b'f', 0xE9, b',', b'n', 0xEF, b'\n'];
        assert_eq!(prefer_clean_cjk(&latin, encoding_rs::WINDOWS_1252), encoding_rs::WINDOWS_1252);
    }

    #[test]
    fn thousands_separators_are_not_junk() {
        assert!(is_decimal_like(b"1,234,567"), "首組 1-3 位、其餘三位是千分位");
        assert!(is_decimal_like(b"1.234,5"), "歐洲寫法：千分位 + 逗號小數");
        assert!(is_decimal_like(b"12,5"));
        // 單一分隔符一律當小數（`1,23` 是 1.23）；多個時中間組必須剛好三位
        assert!(is_decimal_like(b"1,23"));
        assert!(!is_decimal_like(b"1,2,345"), "中間組只有 1 位 → 不像千分位");
        assert!(!is_decimal_like(b"abc,def"));
        assert!(!is_decimal_like(b"123"));
    }
}

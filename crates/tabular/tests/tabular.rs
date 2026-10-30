use std::fs;
use std::path::PathBuf;

use rust_xlsxwriter::{ExcelDateTime, Format, Workbook};
use tabular::{read_sheet, read_table};

struct Tmp(PathBuf);

impl Tmp {
    fn new(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("tabular_test_{tag}_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Tmp(dir)
    }
    fn file(&self, name: &str) -> String {
        self.0.join(name).to_string_lossy().to_string()
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

// ---------- xlsx 產生器 ----------

fn book_multi_sheet(path: &str) {
    let mut wb = Workbook::new();
    let date_fmt = Format::new().set_num_format("yyyy-mm-dd");
    let dt_fmt = Format::new().set_num_format("yyyy-mm-dd hh:mm:ss");

    let s1 = wb.add_worksheet().set_name("第一張").unwrap();
    s1.write_string(0, 0, "姓名").unwrap();
    s1.write_string(0, 1, "報到日").unwrap();
    s1.write_string(0, 2, "備註").unwrap();
    s1.write_string(1, 0, "王小明").unwrap();
    let d1 = ExcelDateTime::from_ymd(2025, 1, 15).unwrap();
    s1.write_datetime_with_format(1, 1, &d1, &date_fmt).unwrap();
    // 空格子：整列留空
    let d2 = ExcelDateTime::from_ymd(2025, 3, 2).unwrap().and_hms(14, 30, 5.0).unwrap();
    s1.write_datetime_with_format(2, 1, &d2, &dt_fmt).unwrap();
    s1.write_string(3, 0, "李小華").unwrap();
    s1.write_string(3, 2, "含,逗號").unwrap();
    s1.write_number(4, 0, 3.5).unwrap();
    s1.write_number(5, 0, 42.0).unwrap();
    s1.write_boolean(6, 0, true).unwrap();

    let s2 = wb.add_worksheet().set_name("第二張").unwrap();
    s2.write_string(0, 0, "k").unwrap();
    s2.write_string(1, 0, "v").unwrap();

    wb.add_worksheet().set_name("第三張").unwrap();
    wb.save(path).unwrap();
}

fn book_wide(path: &str) {
    let mut wb = Workbook::new();
    let s = wb.add_worksheet();
    for c in 0..8u16 {
        s.write_string(0, c, format!("c{c}")).unwrap();
    }
    for r in 1..=5u32 {
        for c in 0..8u16 {
            s.write_string(r, c, format!("{r}-{c}")).unwrap();
        }
    }
    wb.add_worksheet().set_name("空的").unwrap();
    wb.save(path).unwrap();
}

fn book_long(path: &str, n: usize) {
    let mut wb = Workbook::new();
    let s = wb.add_worksheet();
    s.write_string(0, 0, "idx").unwrap();
    for r in 1..=n as u32 {
        s.write_number(r, 0, r as f64).unwrap();
    }
    wb.save(path).unwrap();
}

// ---------- ods 產生器 ----------

/// 手寫最小 ODS（OpenDocument 就是一包 zip），驗證非 xlsx 的分支也走得通。
fn write_ods(path: &str) {
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    let content = r#"<?xml version="1.0" encoding="UTF-8"?>
<office:document-content
  xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  office:version="1.2">
  <office:body><office:spreadsheet>
    <table:table table:name="第一頁">
      <table:table-row><table:table-cell office:value-type="string"><text:p>姓名</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p>分數</text:p></table:table-cell></table:table-row>
      <table:table-row><table:table-cell office:value-type="string"><text:p>王小明</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="90"><text:p>90</text:p></table:table-cell></table:table-row>
    </table:table>
  </office:spreadsheet></office:body>
</office:document-content>"#;

    let file = fs::File::create(path).unwrap();
    let mut z = zip::ZipWriter::new(file);
    let stored = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    z.start_file("mimetype", stored).unwrap();
    z.write_all(b"application/vnd.oasis.opendocument.spreadsheet").unwrap();
    let deflated = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    // calamine 開 ODS 前會先要 manifest，沒有就 open 失敗
    let manifest = r#"<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
  <manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/>
  <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
</manifest:manifest>"#;
    z.start_file("META-INF/manifest.xml", deflated).unwrap();
    z.write_all(manifest.as_bytes()).unwrap();
    z.start_file("content.xml", deflated).unwrap();
    z.write_all(content.as_bytes()).unwrap();
    z.finish().unwrap();
}

// ---------- csv 產生器 ----------

fn write_bytes(path: &str, bytes: &[u8]) {
    fs::write(path, bytes).unwrap();
}

// ---------- xlsx 測試 ----------

#[test]
fn xlsx_first_sheet_with_dates_blank_and_chinese() {
    let t = Tmp::new("xlsx1");
    let p = t.file("a.xlsx");
    book_multi_sheet(&p);

    let table = read_table(&p, 0, 0).unwrap();
    assert_eq!(table.sheet, "第一張");
    assert_eq!(table.sheet_names, vec!["第一張", "第二張", "第三張"]);
    assert_eq!(table.headers, vec!["姓名", "報到日", "備註"]);
    assert_eq!(table.rows.len(), 6);
    assert!(!table.truncated);

    assert_eq!(table.rows[0][0], "王小明");
    // 日期被格式成人看得懂的字串
    assert_eq!(table.rows[0][1].len(), 10, "{}", table.rows[0][1]);
    assert!(table.rows[0][1].starts_with("2025-"), "{}", table.rows[0][1]);
    // 空格子
    assert_eq!(table.rows[1][0], "");
    assert_eq!(table.rows[1][2], "");
    assert!(table.rows[1][1].contains(':'), "{}", table.rows[1][1]);
    // 逗號不影響
    assert_eq!(table.rows[2][2], "含,逗號");
    assert_eq!(table.rows[3][0], "3.5");
    assert_eq!(table.rows[4][0], "42");
    assert_eq!(table.rows[5][0], "TRUE");
    // 每列都補齊到標題寬度
    assert!(table.rows.iter().all(|r| r.len() == 3));
}

#[test]
fn xlsx_read_named_sheet_and_missing() {
    let t = Tmp::new("xlsx2");
    let p = t.file("b.xlsx");
    book_multi_sheet(&p);

    let table = read_sheet(&p, "第二張", 0, 0).unwrap();
    assert_eq!(table.sheet, "第二張");
    assert_eq!(table.headers, vec!["k"]);
    assert_eq!(table.rows, vec![vec!["v"]]);

    let err = read_sheet(&p, "不存在", 0, 0).unwrap_err();
    assert_eq!(err.kind, "sheet_not_found");
}

#[test]
fn xlsx_truncation_and_empty_sheet() {
    let t = Tmp::new("xlsx3");
    let p = t.file("c.xlsx");
    book_wide(&p);

    let table = read_table(&p, 2, 3).unwrap();
    assert!(table.truncated);
    assert_eq!(table.headers, vec!["c0", "c1", "c2"]);
    assert_eq!(table.rows.len(), 2);
    assert_eq!(table.total_rows, 5, "total_rows 要反映完整列數");

    let empty = read_sheet(&p, "空的", 0, 0).unwrap();
    assert!(empty.headers.is_empty());
    assert!(empty.rows.is_empty());
    assert!(!empty.truncated);

    let p2 = t.file("d.xlsx");
    book_long(&p2, 50);
    let t2 = read_table(&p2, 5, 0).unwrap();
    assert_eq!(t2.rows.len(), 5);
    assert_eq!(t2.total_rows, 50);
    assert!(t2.truncated);
}

// ---------- ods 測試 ----------

#[test]
fn ods_reads_first_sheet() {
    let t = Tmp::new("ods");
    let p = t.file("a.ods");
    write_ods(&p);

    let table = read_table(&p, 0, 0).unwrap();
    assert_eq!(table.sheet, "第一頁");
    assert_eq!(table.sheet_names, vec!["第一頁"]);
    assert_eq!(table.headers, vec!["姓名", "分數"]);
    assert_eq!(table.rows, vec![vec!["王小明", "90"]]);
}

// ---------- csv / tsv 測試 ----------

#[test]
fn csv_with_bom_and_utf8() {
    let t = Tmp::new("csv1");
    let p = t.file("bom.csv");
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice("城市,人口\n台北,250\n台中,280\n".as_bytes());
    write_bytes(&p, &bytes);

    let table = read_table(&p, 0, 0).unwrap();
    assert_eq!(table.headers, vec!["城市", "人口"]);
    assert_eq!(table.rows, vec![vec!["台北", "250"], vec!["台中", "280"]]);
    assert_eq!(table.total_rows, 2);
}

#[test]
fn csv_quoted_newline_inside_field() {
    let t = Tmp::new("csv2");
    let p = t.file("q.csv");
    write_bytes(&p, "\"第一行\n第二行\",b\nc,d\n".as_bytes());

    let table = read_table(&p, 0, 0).unwrap();
    assert_eq!(table.headers, vec!["第一行\n第二行", "b"]);
    assert_eq!(table.rows, vec![vec!["c", "d"]]);
}

#[test]
fn tsv_and_semicolon_detected() {
    let t = Tmp::new("csv3");
    let p = t.file("a.tsv");
    write_bytes(&p, "姓名\t分數\n小明\t90\n小美\t95\n".as_bytes());
    let table = read_table(&p, 0, 0).unwrap();
    assert_eq!(table.headers, vec!["姓名", "分數"]);
    assert_eq!(table.rows.len(), 2);

    let p2 = t.file("s.csv");
    write_bytes(&p2, "a;b\n1;2\n3;4\n".as_bytes());
    let t2 = read_table(&p2, 0, 0).unwrap();
    assert_eq!(t2.headers, vec!["a", "b"], "要偵測到分號");

    // 逗號當小數點 + 分號分隔：逗號出現次數更多，但一致的是分號
    let p3 = t.file("dec.csv");
    write_bytes(&p3, "量;價\n1,5;2,5\n3,5;4,5\n5,5;6,5\n".as_bytes());
    let t3 = read_table(&p3, 0, 0).unwrap();
    assert_eq!(t3.headers, vec!["量", "價"]);
    assert_eq!(t3.rows[0], vec!["1,5", "2,5"]);
}

#[test]
fn semicolon_file_with_prose_commas_and_gbk() {
    // 中文句子裡的逗號＋空白不算分隔符（分號才是）
    let t = Tmp::new("prose");
    let p = t.file("p.csv");
    write_bytes(&p, "名稱;備註\n甲;Hello, World\n乙;Foo, Bar\n".as_bytes());
    let table = read_table(&p, 0, 0).unwrap();
    assert_eq!(table.headers, vec!["名稱", "備註"]);
    assert_eq!(table.rows[0], vec!["甲", "Hello, World"]);

    // GBK 檔案（簡體 Excel 的 ANSI 預設）：要解成中文，不是 U+FFFD
    let p2 = t.file("gbk.csv");
    // 「北京,1 / 上海,2 / 广州,3」
    write_bytes(
        &p2,
        &[
            0xB1, 0xB1, 0xBE, 0xA9, b',', b'1', b'\n', 0xC9, 0xCF, 0xBA, 0xA3, b',', b'2', b'\n',
            0xB9, 0xE3, 0xD6, 0xDD, b',', b'3', b'\n',
        ],
    );
    let t2 = read_table(&p2, 0, 0).unwrap();
    assert_eq!(t2.headers[0], "北京");
    assert_eq!(t2.rows[1][0], "广州");
}

#[test]
fn single_line_file_still_detects_tab() {
    // 視窗裡沒有換行時，尾行也要參與判斷，否則永遠退回逗號
    let t = Tmp::new("single");
    let p = t.file("one.tsv");
    write_bytes(&p, "a\tb\tc".as_bytes());
    let table = read_table(&p, 0, 0).unwrap();
    assert_eq!(table.headers, vec!["a", "b", "c"]);
    assert!(table.rows.is_empty());
}

#[test]
fn big5_and_utf16_files_decode_to_text() {
    let t = Tmp::new("enc");
    // 「台北」的 Big5 位元組，Big5 是台灣 Excel 存 CSV 的預設 ANSI 編碼
    let p = t.file("big5.csv");
    write_bytes(&p, &[0xA5, 0x78, 0xA5, 0x5F, b',', b'9', b'\n', b'1', b',', b'2', b'\n']);
    let table = read_table(&p, 0, 0).unwrap();
    assert_eq!(table.headers[0], "台北", "Big5 要解成中文而不是 U+FFFD");
    assert_eq!(table.rows[0][1], "2");

    // UTF-16LE 帶 BOM（Excel「Unicode 文字」）
    let p2 = t.file("u16.csv");
    let mut bytes = vec![0xFF, 0xFE];
    for u in "a,b\n1,2\n".encode_utf16() {
        bytes.extend_from_slice(&u.to_le_bytes());
    }
    write_bytes(&p2, &bytes);
    let t2 = read_table(&p2, 0, 0).unwrap();
    assert_eq!(t2.headers, vec!["a", "b"], "UTF-16 BOM 要處理，不能留 NUL");

    // 沒有 BOM 的 UTF-16LE：每位元組偶數位置都是 NUL，不能被當成合法 UTF-8 直接放行
    let p3 = t.file("u16_nobom.csv");
    let mut bytes = Vec::new();
    for u in "a,b\n1,2\n".encode_utf16() {
        bytes.extend_from_slice(&u.to_le_bytes());
    }
    write_bytes(&p3, &bytes);
    let t3 = read_table(&p3, 0, 0).unwrap();
    assert_eq!(t3.headers, vec!["a", "b"]);
}

#[test]
fn multibyte_char_split_across_sniff_window() {
    // 前導偵測窗是 65536 位元組；把一個 3 位元組的中文字剛好卡在邊界上，
    // 解碼必須接得回來，不能變成 U+FFFD。
    let t = Tmp::new("boundary");
    let p = t.file("b.csv");
    let mut content = "a".repeat(65_535);
    content.push('中');
    content.push_str(",b\n1,2\n");
    write_bytes(&p, content.as_bytes());

    let table = read_table(&p, 0, 0).unwrap();
    assert_eq!(table.headers[0], format!("{}中", "a".repeat(65_535)));
    assert_eq!(table.rows, vec![vec!["1", "2"]]);
}

#[test]
fn csv_truncation_and_ragged_rows() {
    let t = Tmp::new("csv4");
    let p = t.file("r.csv");
    write_bytes(&p, "a,b,c\n1\n1,2,3,4\n5,6\n".as_bytes());

    let table = read_table(&p, 1, 0).unwrap();
    assert!(table.truncated);
    assert_eq!(table.total_rows, 3);
    assert_eq!(table.rows.len(), 1);
    assert_eq!(table.rows[0], vec!["1", "", ""]);

    let full = read_table(&p, 0, 0).unwrap();
    assert_eq!(full.headers.len(), 4, "最寬的那列決定寬度");
    assert!(full.rows.iter().all(|r| r.len() == 4));
}

#[test]
fn unsupported_extension_and_missing_file() {
    let t = Tmp::new("err");
    let p = t.file("x.json");
    write_bytes(&p, b"{}");
    assert_eq!(read_table(&p, 0, 0).unwrap_err().kind, "unsupported");

    let missing = t.file("nope.csv");
    let e = read_table(&missing, 0, 0).unwrap_err();
    assert_eq!(e.kind, "io");
    assert_eq!(e.path.unwrap(), PathBuf::from(&missing));
}

#[test]
fn serializes_to_json_shape() {
    let t = Tmp::new("json");
    let p = t.file("j.csv");
    write_bytes(&p, "a\n1\n".as_bytes());
    let table = read_table(&p, 0, 0).unwrap();
    let json = serde_json::to_string(&table).unwrap();
    assert!(json.contains("\"headers\""));
    assert!(json.contains("total_rows"));
}

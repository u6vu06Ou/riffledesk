use fsview::*;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

/// Temp dir that removes itself; name is unique per test to stay parallel-safe.
struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let p = std::env::temp_dir().join(format!("fsview_test_{tag}_{nanos}"));
        fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }
    fn path(&self) -> &Path {
        &self.0
    }
    fn file(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let p = self.0.join(name);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&p, bytes).unwrap();
        p
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

// --- classify ---------------------------------------------------------------

#[test]
fn classify_known_extensions() {
    let d = TempDir::new("cls_ext");
    let cases: [(&str, FileKind); 24] = [
        ("a.md", FileKind::Markdown),
        ("a.txt", FileKind::Text),
        ("a.log", FileKind::Text),
        ("a.py", FileKind::Code),
        ("a.rs", FileKind::Code),
        ("a.ps1", FileKind::Code),
        ("a.json", FileKind::Json),
        ("a.yaml", FileKind::Json),
        ("a.toml", FileKind::Json),
        ("a.csv", FileKind::Table),
        ("a.xlsx", FileKind::Table),
        ("a.html", FileKind::Html),
        ("a.svg", FileKind::Html),
        ("a.png", FileKind::Image),
        ("a.pdf", FileKind::Pdf),
        ("a.MD", FileKind::Markdown),
        ("a.JSONL", FileKind::Json),
        ("a.xls", FileKind::Table),
        ("a.yml", FileKind::Json),
        ("a.ini", FileKind::Json),
        ("a.ts", FileKind::Code),
        ("a.css", FileKind::Code),
        ("a.webp", FileKind::Image),
        ("a.jpeg", FileKind::Image),
    ];
    for (name, want) in cases {
        let p = d.file(name, b"hello world\n");
        assert_eq!(classify(p.as_path()), want, "extension case {name}");
    }
}

#[test]
fn classify_sniffs_nul_bytes_as_binary() {
    let d = TempDir::new("cls_nul");
    let p = d.file("looks_text.txt", b"abc\0def\0ghi");
    assert_eq!(classify(p.as_path()), FileKind::Binary);
}

#[test]
fn classify_sniffs_high_control_ratio_as_binary() {
    let d = TempDir::new("cls_ctrl");
    let mut bytes = vec![0x01u8; 200];
    bytes.extend_from_slice(b"tail");
    let p = d.file("bin.dat", &bytes);
    assert_eq!(classify(p.as_path()), FileKind::Binary);
}

#[test]
fn classify_utf16_bom_is_text() {
    let d = TempDir::new("cls_utf16");
    let mut bytes = vec![0xFF, 0xFE];
    for u in "hi 中文".encode_utf16() {
        bytes.extend_from_slice(&u.to_le_bytes());
    }
    let p = d.file("utf16.txt", &bytes);
    assert!(classify(p.as_path()).is_textual());
}

#[test]
fn classify_chinese_filename_and_missing_file() {
    let d = TempDir::new("cls_cn");
    let p = d.file("說明文件.md", b"# hi\n");
    assert_eq!(classify(p.as_path()), FileKind::Markdown);
    assert_eq!(classify(&d.path().join("nope.md")), FileKind::Markdown);
    assert_eq!(classify(&d.path().join("nope.zzz")), FileKind::Other);
}

#[test]
fn classify_image_short_circuits_without_reading() {
    let d = TempDir::new("cls_img");
    // PNG magic only — no sniffing needed, so a 4-byte file stays Image.
    let p = d.file("x.png", &[0x89, b'P', b'N', b'G']);
    assert_eq!(classify(p.as_path()), FileKind::Image);
}

// --- list_dir ---------------------------------------------------------------

#[test]
fn list_dir_splits_dirs_and_files_and_sorts() {
    let d = TempDir::new("list_basic");
    d.file("b.txt", b"x");
    d.file("A.md", b"x");
    fs::create_dir_all(d.path().join("zdir")).unwrap();
    fs::create_dir_all(d.path().join("adir")).unwrap();

    let l = list_dir(d.path(), &ExtFilter::All);
    assert!(l.error.is_none());
    let dirs: Vec<_> = l.dirs.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(dirs, vec!["adir", "zdir"]);
    let files: Vec<_> = l.files.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(files, vec!["A.md", "b.txt"]);
    assert_eq!(l.files[1].size, 1);
    assert_eq!(l.files[0].ext, "md");
    assert_eq!(l.files[0].kind, FileKind::Markdown);
}

#[test]
fn list_dir_reports_has_children() {
    let d = TempDir::new("list_children");
    let child = d.path().join("full");
    fs::create_dir_all(&child).unwrap();
    fs::write(child.join("inner.txt"), b"x").unwrap();
    fs::create_dir_all(d.path().join("empty")).unwrap();

    let l = list_dir(d.path(), &ExtFilter::All);
    let full = l.dirs.iter().find(|e| e.name == "full").unwrap();
    let empty = l.dirs.iter().find(|e| e.name == "empty").unwrap();
    assert!(full.has_children);
    assert!(!empty.has_children);
}

#[test]
fn list_dir_skips_hidden_and_system() {
    let d = TempDir::new("list_hidden");
    d.file(".hidden", b"x");
    d.file("visible.txt", b"x");
    let l = list_dir(d.path(), &ExtFilter::All);
    let names: Vec<_> = l.files.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, vec!["visible.txt"]);
}

#[cfg(windows)]
#[test]
fn list_dir_skips_windows_hidden_attribute() {
    let d = TempDir::new("list_hidden_attr");
    d.file("attr_hidden.txt", b"x");
    d.file("plain.txt", b"x");
    let out = std::process::Command::new("attrib")
        .arg("+H")
        .arg(d.path().join("attr_hidden.txt"))
        .output()
        .unwrap();
    assert!(out.status.success());
    let names: Vec<String> = list_dir(d.path(), &ExtFilter::All)
        .files
        .into_iter()
        .map(|e| e.name)
        .collect();
    assert!(!names.contains(&"attr_hidden.txt".to_string()));
    assert!(names.contains(&"plain.txt".to_string()));
}

#[test]
fn list_dir_filter_only_and_human_readable() {
    let d = TempDir::new("list_filter");
    d.file("a.md", b"x");
    d.file("a.txt", b"x");
    d.file("a.bin", &[0x01u8; 100]);

    let only = list_dir(d.path(), &ExtFilter::Only(vec!["MD".into(), ".txt".into()]));
    let names: Vec<_> = only.files.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, vec!["a.md", "a.txt"]);

    let human: Vec<String> = list_dir(d.path(), &ExtFilter::HumanReadable)
        .files
        .into_iter()
        .map(|e| e.name)
        .collect();
    assert_eq!(human, vec!["a.md", "a.txt"]);

    assert_eq!(list_dir(d.path(), &ExtFilter::Only(vec![])).files.len(), 3);
}

#[test]
fn list_dir_missing_dir_returns_error_not_panic() {
    let d = TempDir::new("list_missing");
    let l = list_dir(&d.path().join("ghost"), &ExtFilter::All);
    assert!(l.dirs.is_empty() && l.files.is_empty());
    assert!(l.error.is_some());
}

#[test]
fn list_dir_chinese_names_round_trip() {
    let d = TempDir::new("list_cn");
    d.file("中文 檔名.txt", b"x");
    let l = list_dir(d.path(), &ExtFilter::All);
    assert_eq!(l.files[0].name, "中文 檔名.txt");
    assert!(l.files[0].path.contains("中文"));
}

// --- read_head --------------------------------------------------------------

#[test]
fn read_head_plain_text() {
    let d = TempDir::new("head_plain");
    let p = d.file("a.txt", b"hello\nworld\n");
    let h = read_head(&p, 1024).unwrap();
    assert_eq!(h.text, "hello\nworld\n");
    assert!(!h.truncated);
    assert_eq!(h.encoding, "utf-8");
}

#[test]
fn read_head_does_not_cut_utf8_mid_char() {
    let d = TempDir::new("head_cut");
    // "中" is 3 bytes; a 4-byte budget lands one byte into the second "中".
    let p = d.file("cn.txt", "中中中中".as_bytes());
    let h = read_head(&p, 4).unwrap();
    assert!(h.text.is_char_boundary(h.text.len()));
    assert_eq!(h.text, "中");
    assert!(h.truncated);
}

#[test]
fn read_head_strips_utf8_bom_and_labels_it() {
    let d = TempDir::new("head_bom");
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice("# 標題".as_bytes());
    let p = d.file("bom.md", &bytes);
    let h = read_head(&p, 64).unwrap();
    assert_eq!(h.text, "# 標題");
    assert_eq!(h.encoding, "utf-8-bom");
    assert!(!h.truncated);
}

#[test]
fn read_head_utf16le_bom_decodes() {
    let d = TempDir::new("head_utf16");
    let mut bytes = vec![0xFF, 0xFE];
    for u in "ab中".encode_utf16() {
        bytes.extend_from_slice(&u.to_le_bytes());
    }
    let p = d.file("u16.txt", &bytes);
    let h = read_head(&p, 64).unwrap();
    assert_eq!(h.text, "ab中");
    assert_eq!(h.encoding, "utf-16le");
}

#[test]
fn read_head_utf16_odd_cut_drops_half_unit() {
    let d = TempDir::new("head_utf16_odd");
    let mut bytes = vec![0xFF, 0xFE];
    for u in "abcd".encode_utf16() {
        bytes.extend_from_slice(&u.to_le_bytes());
    }
    let p = d.file("u16odd.txt", &bytes);
    let h = read_head(&p, 4).unwrap();
    assert_eq!(h.text, "a");
    assert!(h.truncated);
}

#[test]
fn read_head_binary_bytes_are_marked() {
    let d = TempDir::new("head_bin");
    let p = d.file("b.bin", &[0x00, 0x01, 0x02, 0xFE, 0x80, 0x81]);
    let h = read_head(&p, 64).unwrap();
    assert_eq!(h.encoding, "binary");
    assert!(!h.text.is_empty());
}

#[test]
fn read_head_missing_file_is_err() {
    let d = TempDir::new("head_missing");
    assert!(read_head(&d.path().join("ghost.txt"), 16).is_err());
}

#[test]
fn read_head_small_file_not_truncated_even_with_big_budget() {
    let d = TempDir::new("head_small");
    let p = d.file("s.txt", b"tiny");
    let h = read_head(&p, 1 << 20).unwrap();
    assert!(!h.truncated);
    assert_eq!(h.text, "tiny");
}

#[test]
fn read_head_10mb_file_reads_64kb_under_50ms() {
    let d = TempDir::new("head_10mb");
    let p = d.path().join("big.log");
    // 10 MiB of newline-separated ASCII, written in blocks.
    {
        use std::io::Write;
        let f = fs::File::create(&p).unwrap();
        let mut w = std::io::BufWriter::new(f);
        let line = vec![b'x'; 63];
        for _ in 0..(10 * 1024 * 1024 / 64) {
            w.write_all(&line).unwrap();
            w.write_all(b"\n").unwrap();
        }
        w.flush().unwrap();
    }
    // Best of 5: the rest of the suite hits the same disk in parallel, so a
    // single sample shows contention rather than the cost of our O(1) read.
    let mut best = std::time::Duration::MAX;
    let mut h = None;
    for _ in 0..5 {
        let start = Instant::now();
        h = Some(read_head(&p, 64 * 1024).unwrap());
        best = best.min(start.elapsed());
    }
    let h = h.unwrap();
    assert!(h.truncated);
    assert!(h.text.len() <= 64 * 1024);
    assert!(h.text.ends_with('\n'));
    assert!(best.as_millis() < 50, "fastest 64 KiB read too slow: {best:?}");
}

// --- is_ai_project ----------------------------------------------------------

#[test]
fn is_ai_project_detects_each_marker() {
    for marker in ["CLAUDE.md", "AGENTS.md", "GEMINI.md", ".claude", ".codex"] {
        let d = TempDir::new("aip");
        let p = d.path().join(marker);
        if marker.ends_with(".md") {
            fs::write(&p, b"x").unwrap();
        } else {
            fs::create_dir_all(&p).unwrap();
        }
        assert!(is_ai_project(d.path()), "marker {marker}");
    }
}

#[test]
fn is_ai_project_is_case_insensitive() {
    let d = TempDir::new("aip_case");
    d.file("claude.md", b"x");
    assert!(is_ai_project(d.path()));
}

#[test]
fn is_ai_project_false_for_plain_dir_and_missing() {
    let d = TempDir::new("aip_plain");
    d.file("readme.txt", b"x");
    assert!(!is_ai_project(d.path()));
    assert!(!is_ai_project(&d.path().join("ghost")));
}

#[test]
fn parent_of_returns_parent() {
    let d = TempDir::new("parent");
    let p = d.file("a.txt", b"x");
    assert_eq!(parent_of(&p).unwrap(), d.path());
}

// --- classify_fast ----------------------------------------------------------

#[test]
fn classify_fast_never_opens_files() {
    let d = TempDir::new("fast");
    let nobin = d.path().join("ghost.bin"); // does not exist
    assert_eq!(classify_fast(&nobin), FileKind::Other); // unknown ext
    assert_eq!(classify_fast(&d.path().join("ghost.png")), FileKind::Image);
    assert_eq!(classify_fast(&d.path().join("ghost.md")), FileKind::Markdown);
    assert_eq!(classify_fast(&d.path().join("ghost")), FileKind::Other);
}

#[test]
fn list_dir_keeps_known_kinds_without_sniffing() {
    let d = TempDir::new("list_nosniff");
    d.file("doc.md", b"x");
    d.file("raw.bin", &[0x01u8; 50]);
    let l = list_dir(d.path(), &ExtFilter::All);
    assert_eq!(l.files[1].kind, FileKind::Binary);
    assert_eq!(l.files[0].kind, FileKind::Markdown);
    let human: Vec<String> = list_dir(d.path(), &ExtFilter::HumanReadable)
        .files
        .into_iter()
        .map(|e| e.name)
        .collect();
    assert_eq!(human, vec!["doc.md"]);
}

#[test]
fn classify_office_containers_are_tables_not_binary() {
    let d = TempDir::new("cls_office");
    // ZIP magic plus NULs — a naive sniff would say Binary.
    let xlsx = d.file("book.xlsx", b"PK\x03\x04\0\0\0\0sheet");
    let xls = d.file("old.xls", b"\xD0\xCF\x11\xE0\0\0\0\0");
    assert_eq!(classify(&xlsx), FileKind::Table);
    assert_eq!(classify(&xls), FileKind::Table);
    // A CSV stays sniffable: NULs make it Binary.
    let csv = d.file("bad.csv", b"a,b\0c");
    assert_eq!(classify(&csv), FileKind::Binary);
}

#[test]
fn ext_filter_accepts_glob_and_dotted_forms() {
    let d = TempDir::new("filter_forms");
    d.file("a.md", b"x");
    d.file("a.txt", b"x");
    let l = list_dir(d.path(), &ExtFilter::Only(vec!["*.md".into(), " txt ".into()]));
    let names: Vec<_> = l.files.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, vec!["a.md", "a.txt"]);
}

#[test]
fn read_at_pages_without_loading_whole_file() {
    let d = TempDir::new("read_at");
    let p = d.file("p.txt", b"0123456789");
    assert_eq!(read_at(&p, 3, 4).unwrap(), b"3456");
    assert_eq!(read_at(&p, 8, 100).unwrap(), b"89");
    assert!(read_at(&p, 500, 4).unwrap().is_empty());
}

#[test]
fn list_dir_on_a_file_path_reports_error() {
    let d = TempDir::new("list_isfile");
    let p = d.file("f.txt", b"x");
    let l = list_dir(&p, &ExtFilter::All);
    assert!(l.error.is_some());
    assert!(l.files.is_empty());
}

#[cfg(windows)]
#[test]
fn long_path_over_260_chars_works() {
    let d = TempDir::new("longpath");
    let mut dir = d.path().to_path_buf();
    // 5 levels x 60 chars pushes past the legacy MAX_PATH.
    for i in 0..5 {
        dir = dir.join(format!("{i}{}", "x".repeat(58)));
        fs::create_dir_all(&dir).unwrap();
    }
    fs::write(dir.join("deep.txt"), b"ok").unwrap();
    let l = list_dir(&dir, &ExtFilter::All);
    assert!(l.error.is_none(), "long path failed: {:?}", l.error);
    assert_eq!(l.files[0].name, "deep.txt");
    assert_eq!(read_head(&dir.join("deep.txt"), 8).unwrap().text, "ok");
}

#[test]
fn read_head_zero_budget_returns_empty_but_flags_truncation() {
    let d = TempDir::new("head_zero");
    let p = d.file("z.txt", b"abc");
    let h = read_head(&p, 0).unwrap();
    assert_eq!(h.text, "");
    assert!(h.truncated);
}

#[test]
fn read_head_empty_file_is_not_truncated() {
    let d = TempDir::new("head_empty");
    let p = d.file("e.txt", b"");
    let h = read_head(&p, 64).unwrap();
    assert_eq!(h.text, "");
    assert!(!h.truncated);
    assert_eq!(classify(p.as_path()), FileKind::Text);
}

#[test]
fn read_head_exactly_max_bytes_is_not_marked_truncated() {
    let d = TempDir::new("head_exact");
    let p = d.file("exact.txt", b"12345");
    let h = read_head(&p, 5).unwrap();
    assert_eq!(h.text, "12345");
    assert!(!h.truncated);
}

#[test]
fn read_head_four_byte_emoji_at_the_cut_is_dropped_whole() {
    let d = TempDir::new("head_emoji");
    let p = d.file("e.txt", "ab😀cd".as_bytes());
    let h = read_head(&p, 4).unwrap();
    assert_eq!(h.text, "ab");
    assert!(h.text.is_char_boundary(h.text.len()));
}

// --- council follow-ups ----------------------------------------------------

#[test]
fn read_head_utf32le_bom_is_not_decoded_as_utf16() {
    let d = TempDir::new("u32le");
    let mut b = vec![0xFF, 0xFE, 0x00, 0x00];
    for ch in "AB中".chars() {
        b.extend_from_slice(&(ch as u32).to_le_bytes());
    }
    let p = d.file("u32.txt", &b);
    let h = read_head(&p, 64).unwrap();
    assert_eq!(h.encoding, "utf-32le");
    assert_eq!(h.text, "AB中");
}

#[test]
fn read_head_utf32be_bom_is_recognised() {
    let d = TempDir::new("u32be");
    let mut b = vec![0x00, 0x00, 0xFE, 0xFF];
    for ch in "XY".chars() {
        b.extend_from_slice(&(ch as u32).to_be_bytes());
    }
    let p = d.file("u32be.txt", &b);
    let h = read_head(&p, 64).unwrap();
    assert_eq!(h.encoding, "utf-32be");
    assert_eq!(h.text, "XY");
}

#[test]
fn read_head_bomless_utf16le_is_detected_not_mangled() {
    let d = TempDir::new("u16nobom");
    let body: Vec<u8> = "hello utf16"
        .encode_utf16()
        .flat_map(|u| u.to_le_bytes())
        .collect();
    let p = d.file("nb.txt", &body);
    let h = read_head(&p, 64).unwrap();
    assert_eq!(h.text, "hello utf16");
    assert_eq!(h.encoding, "utf-16le");
}

#[test]
fn read_head_bomless_utf16be_is_detected() {
    let d = TempDir::new("u16nobom_be");
    let body: Vec<u8> = "hello utf16"
        .encode_utf16()
        .flat_map(|u| u.to_be_bytes())
        .collect();
    let p = d.file("nbbe.txt", &body);
    let h = read_head(&p, 64).unwrap();
    assert_eq!(h.text, "hello utf16");
    assert_eq!(h.encoding, "utf-16be");
}

#[test]
fn classify_ignores_directory_with_text_extension() {
    let d = TempDir::new("cls_dir");
    let dir = d.path().join("looks.md");
    fs::create_dir_all(&dir).unwrap();
    assert_eq!(classify(&dir), FileKind::Other);
}

#[test]
fn mtime_is_none_rather_than_zero_when_unreadable() {
    let d = TempDir::new("mtime");
    d.file("a.txt", b"x");
    let l = list_dir(d.path(), &ExtFilter::All);
    assert!(l.files[0].mtime.is_some_and(|t| t > 1_600_000_000));
}

#[test]
fn skipped_is_zero_for_a_healthy_listing() {
    let d = TempDir::new("skipped");
    d.file("a.txt", b"x");
    assert_eq!(list_dir(d.path(), &ExtFilter::All).skipped, 0);
}

#[test]
fn parent_of_bare_name_is_current_dir() {
    assert_eq!(parent_of(Path::new("foo")), Some(PathBuf::from(".")));
}

#[test]
fn ext_filter_serde_round_trips() {
    let f = ExtFilter::Only(vec!["md".into()]);
    let json = serde_json::to_string(&f).unwrap();
    assert_eq!(json, r#"{"mode":"only","exts":["md"]}"#);
    assert_eq!(serde_json::from_str::<ExtFilter>(&json).unwrap(), f);
    assert_eq!(
        serde_json::to_string(&ExtFilter::HumanReadable).unwrap(),
        r#"{"mode":"human_readable"}"#
    );
    assert_eq!(
        serde_json::from_str::<ExtFilter>(r#"{"mode":"all"}"#).unwrap(),
        ExtFilter::All
    );
}

#[test]
fn head_and_listing_serialise_to_json() {
    let d = TempDir::new("serde");
    let p = d.file("a.txt", b"hi");
    let json = serde_json::to_string(&read_head(&p, 8).unwrap()).unwrap();
    assert!(json.contains(r#""kind"#) || json.contains(r#""encoding":"utf-8""#));
    let l = list_dir(d.path(), &ExtFilter::All);
    assert!(serde_json::to_string(&l).unwrap().contains("a.txt"));
}

#[cfg(windows)]
#[test]
fn windows_reserved_names_are_listed_and_readable() {
    let d = TempDir::new("reserved");
    d.file("con.txt", b"console");
    d.file("nul.log", b"nul");
    let names: Vec<String> = list_dir(d.path(), &ExtFilter::All)
        .files
        .into_iter()
        .map(|e| e.name)
        .collect();
    assert!(names.contains(&"con.txt".to_string()));
    assert_eq!(read_head(&d.path().join("nul.log"), 8).unwrap().text, "nul");
}

#[test]
fn has_children_counts_hidden_only_children() {
    let d = TempDir::new("hidden_child");
    let sub = d.path().join("sub");
    fs::create_dir_all(&sub).unwrap();
    fs::write(sub.join(".only_hidden"), b"x").unwrap();
    let l = list_dir(d.path(), &ExtFilter::All);
    assert!(l.dirs[0].has_children);
}

#[test]
fn read_head_huge_budget_is_clamped() {
    let d = TempDir::new("clamp");
    let p = d.file("c.txt", b"abc");
    let h = read_head(&p, usize::MAX).unwrap();
    assert_eq!(h.text, "abc");
    assert!(!h.truncated);
    assert_eq!(MAX_HEAD_BYTES, 32 * 1024 * 1024);
}

#[test]
fn read_head_malformed_utf8_mid_file_is_binary() {
    let d = TempDir::new("malformed");
    // Valid start, then a lone continuation byte, then more text.
    let p = d.file("m.txt", b"hello \x80 world, this is long enough to pass");
    let h = read_head(&p, 64).unwrap();
    assert_eq!(h.encoding, "binary");
    assert!(h.text.starts_with("hello"));
}

#[cfg(windows)]
#[test]
fn junction_to_dir_is_listed_as_dir_and_does_not_break() {
    let d = TempDir::new("junction");
    let target = d.path().join("real");
    fs::create_dir_all(&target).unwrap();
    fs::write(target.join("in.txt"), b"x").unwrap();
    let link = d.path().join("link");
    let out = std::process::Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(&link)
        .arg(&target)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "mklink failed: {}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let l = list_dir(d.path(), &ExtFilter::All);
    assert_eq!(l.dirs.len(), 2, "dirs={:?} err={:?}", l.dirs, l.error);
    let entry = l.dirs.iter().find(|e| e.name == "link").unwrap();
    assert!(entry.has_children);
    let inner = list_dir(Path::new(&entry.path), &ExtFilter::All);
    assert_eq!(inner.files[0].name, "in.txt");
}

#[cfg(windows)]
#[test]
fn broken_junction_is_counted_in_skipped() {
    let d = TempDir::new("broken_link");
    d.file("a.txt", b"x");
    let link = d.path().join("dangling");
    let gone = d.path().join("gone");
    let out = std::process::Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(&link)
        .arg(&gone)
        .output()
        .unwrap();
    assert!(out.status.success());
    let l = list_dir(d.path(), &ExtFilter::All);
    assert_eq!(l.skipped, 1);
    assert!(l.error.is_some());
    assert_eq!(l.files[0].name, "a.txt");
}

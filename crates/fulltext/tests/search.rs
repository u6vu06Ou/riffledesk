use std::fs;
use std::path::{Path, PathBuf};

use fulltext::Index;

/// Removes the scratch directory on drop, so a failed assertion does not leak it.
struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

impl std::ops::Deref for Scratch {
    type Target = Path;
    fn deref(&self) -> &Path {
        &self.0
    }
}

fn tmpdir(tag: &str) -> PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!(
        "fulltext_{tag}_{}_{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&p).unwrap();
    p
}

fn write(dir: &Path, name: &str, body: &str) {
    let p = dir.join(name);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(p, body).unwrap();
}

fn root(d: &Path) -> PathBuf {
    fs::canonicalize(d).unwrap()
}

fn index_of(d: &Path) -> Index {
    let mut idx = Index::open(":memory:").unwrap();
    idx.update(&[root(d)], &["txt", "rs", "log"], |_| {}).unwrap();
    idx
}

/// 20 files: Chinese (long + 2-char), English, digits, plus noise dirs.
fn corpus(tag: &str) -> PathBuf {
    let d = tmpdir(tag);
    write(&d, "a_zh.txt", "這是一份關於機器學習的文件，主要在講梯度下降。");
    write(&d, "b_zh.txt", "梯度下降是最佳化演算法，適合訓練模型。");
    write(&d, "c_zh2.txt", "裡面有兩個字的詞：機器。");
    write(&d, "d_en.txt", "The quick brown fox jumps over the lazy dog.");
    write(&d, "e_en.txt", "Rust ownership and borrowing explained.");
    write(&d, "f_num.txt", "訂單編號 123456 已出貨。");
    write(&d, "g_num.txt", "批次 99123 完成。");
    write(&d, "h.rs", r#"fn main() { println!("梯度下降"); }"#);
    for i in 0..12 {
        write(&d, &format!("noise_{i}.log"), &format!("noise line {i} nothing here"));
    }
    write(&d, "node_modules/skip.txt", "梯度下降 in node_modules");
    write(&d, "target/skip.rs", "梯度下降 in target");
    write(&d, ".git/skip.txt", "梯度下降 in git");
    d
}

#[test]
fn chinese_three_or_more_chars() {
    let d = corpus("zh");
    let idx = index_of(&d);

    let hits = idx.search("梯度下降", None, 10).unwrap();
    assert_eq!(hits.len(), 3, "got {:?}", hits.iter().map(|h| &h.path).collect::<Vec<_>>());
    for h in &hits {
        assert!(!h.snippets.is_empty());
        assert!(h.snippets.iter().any(|s| s.contains("[[梯度下降]]")));
        assert!(h.score.is_finite() && h.score > 0.0);
        assert!(h.size > 0);
        assert!(h.mtime > 0);
        assert!(h.path.contains("a_zh.txt") || h.path.contains("b_zh.txt") || h.path.ends_with("h.rs"));
    }
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn chinese_two_chars_falls_back_to_like() {
    let d = corpus("zh2");
    let idx = index_of(&d);

    let hits = idx.search("機器", None, 10).unwrap();
    assert_eq!(hits.len(), 2);
    assert!(hits.iter().all(|h| h.snippets.iter().any(|s| s.contains("[[機器]]"))));
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn english_and_digits() {
    let d = corpus("en");
    let idx = index_of(&d);

    assert_eq!(idx.search("brown fox", None, 10).unwrap().len(), 1);
    assert_eq!(idx.search("BROWN", None, 10).unwrap().len(), 1, "case-insensitive");

    let digits = idx.search("123", None, 10).unwrap();
    assert_eq!(digits.len(), 2, "partial digits must match both records");
    assert!(digits
        .iter()
        .any(|h| h.snippets.iter().any(|s| s.contains("[[123]]456"))));
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn fts_operators_in_query_do_not_break() {
    let d = corpus("ops");
    let idx = index_of(&d);

    for q in ["\"梯度下降\"", "gradient*", "not AND", "a OR b", "NEAR(a b)", "(梯度下降)", "-abc", "C:\\temp"] {
        idx.search(q, None, 5).unwrap_or_else(|e| panic!("query {q:?} failed: {e}"));
    }
    // Operator words are quoted phrases, i.e. they need to appear in the body.
    assert_eq!(idx.search("quick brown fox", None, 5).unwrap().len(), 1);
    assert!(idx.search("brown AND fox", None, 5).unwrap().is_empty());
    assert!(idx.search("quick OR fox", None, 5).unwrap().is_empty());
    assert_eq!(idx.search("\"brown fox\"", None, 5).unwrap().len(), 1);
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn skipped_dirs_are_ignored() {
    let d = corpus("skip");
    let idx = index_of(&d);
    assert_eq!(idx.len().unwrap(), 20);
    assert!(idx.search("node_modules", None, 10).unwrap().is_empty());
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn incremental_update_reindexes_and_removes() {
    let d = corpus("incr");
    let mut idx = Index::open(":memory:").unwrap();
    let r = root(&d);

    let first = idx.update(std::slice::from_ref(&r), &["txt", "rs", "log"], |_| {}).unwrap();
    assert_eq!(first.added, 20);

    let second = idx.update(std::slice::from_ref(&r), &["txt", "rs", "log"], |_| {}).unwrap();
    assert_eq!(second.unchanged, 20);
    assert_eq!(second.added + second.updated + second.removed, 0);

    write(&d, "a_zh.txt", "這份文件改成講貝氏推論，舊的主題不提了。");
    let third = idx.update(std::slice::from_ref(&r), &["txt", "rs", "log"], |_| {}).unwrap();
    assert_eq!(third.updated, 1);
    assert_eq!(idx.search("貝氏推論", None, 10).unwrap().len(), 1);
    assert_eq!(idx.search("梯度下降", None, 10).unwrap().len(), 2, "old body replaced");
    assert_eq!(idx.len().unwrap(), 20, "no duplicate rows");

    fs::remove_file(d.join("d_en.txt")).unwrap();
    let fourth = idx.update(std::slice::from_ref(&r), &["txt", "rs", "log"], |_| {}).unwrap();
    assert_eq!(fourth.removed, 1);
    assert!(idx.search("brown fox", None, 10).unwrap().is_empty());
    assert_eq!(idx.len().unwrap(), 19);

    let _ = fs::remove_dir_all(&d);
}

#[test]
fn unreadable_root_keeps_existing_entries() {
    let d = corpus("uni");
    let mut idx = Index::open(":memory:").unwrap();
    let r = root(&d);
    idx.update(std::slice::from_ref(&r), &["txt"], |_| {}).unwrap();
    let before = idx.len().unwrap();
    assert!(before > 0);

    let missing = r.join("does_not_exist");
    let stats = idx.update(&[missing, r.clone()], &["txt"], |_| {}).unwrap();
    assert_eq!(stats.unreadable_roots.len(), 1);
    assert_eq!(idx.len().unwrap(), before, "nothing dropped");
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn extension_filter_applies_to_search() {
    let d = corpus("ext");
    let idx = index_of(&d);

    let only_rs = idx.search("梯度下降", Some(&["rs"]), 10).unwrap();
    assert_eq!(only_rs.len(), 1);
    assert!(only_rs[0].path.ends_with("h.rs"));

    let only_txt = idx.search("梯度下降", Some(&[".TXT"]), 10).unwrap();
    assert_eq!(only_txt.len(), 2);

    assert_eq!(idx.search("梯度下降", Some(&[]), 10).unwrap().len(), 3, "empty fixer = no filter");
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn overlapping_roots_are_deduped() {
    let d = corpus("dup");
    let mut idx = Index::open(":memory:").unwrap();
    let r = root(&d);
    let sub = {
        let mut s = r.clone();
        s.push("sub");
        fs::create_dir_all(&s).unwrap();
        fs::write(s.join("x.txt"), "梯度下降 在子資料夾").unwrap();
        s
    };
    let stats = idx.update(&[r.clone(), sub, r.join(".")], &["txt"], |_| {}).unwrap();
    assert_eq!(stats.added, 8);
    assert_eq!(idx.len().unwrap(), 8);
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn large_file_is_truncated_and_binary_is_lossy() {
    let d = tmpdir("big");
    let mut body = "A".repeat(fulltext::MAX_INDEX_BYTES);
    body.push_str("ZZLATE");
    write(&d, "big.txt", &body);
    fs::write(d.join("bin.dat"), [0xffu8, 0xfe, b'a', b'b', b'c', 0x80]).unwrap();

    let mut idx = Index::open(":memory:").unwrap();
    idx.update(&[root(&d)], &["txt", "dat"], |_| {}).unwrap();
    assert_eq!(idx.len().unwrap(), 2);
    assert!(idx.search("ZZLATE", None, 10).unwrap().is_empty(), "past the 2 MiB cut");
    assert_eq!(idx.search("abc", None, 10).unwrap().len(), 1);
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn index_moves_to_another_thread_and_persists() {
    let d = corpus("send");
    let path = d.join("db.sqlite");
    let r = root(&d);
    let worker = std::thread::spawn(move || {
        let mut idx = Index::open(&path).unwrap();
        let stats = idx.update(&[r], &["txt", "rs", "log"], |_| {}).unwrap();
        (stats.added, idx.search("梯度下降", None, 5).unwrap().len())
    });
    let (added, hits) = worker.join().unwrap();
    assert_eq!(added, 20);
    assert_eq!(hits, 3);
    let _ = fs::remove_dir_all(&d);
}

/// The index must be usable from a background Tauri task: it has to be `Send`
/// and it has to stay valid when moved *after* it holds rows.
#[test]
fn open_index_moves_to_another_thread_with_rows() {
    fn assert_send<T: Send>() {}
    assert_send::<Index>();
    assert_send::<fulltext::Hit>();
    assert_send::<fulltext::UpdateStats>();

    let d = Scratch(corpus("send2"));
    let mut idx = Index::open(":memory:").unwrap();
    idx.update(&[root(&d)], &["txt", "rs", "log"], |_| {}).unwrap();
    // Read the expectations off the index instead of hardcoding them, so a
    // change to the shared corpus does not break this test.
    let indexed = idx.len().unwrap();
    let expected_hits = idx.search("梯度下降", None, 10).unwrap().len();
    assert!(indexed > 0 && expected_hits > 0);

    // Move the populated index: the connection must survive the handover.
    let worker = std::thread::spawn(move || {
        let hits = idx.search("梯度下降", None, 10).unwrap().len();
        let n = idx.len().unwrap();
        (hits, n)
    });
    assert_eq!(worker.join().unwrap(), (expected_hits, indexed));
}

#[test]
fn dangling_link_is_dropped_but_a_vanished_file_keeps_the_directory_safe() {
    let d = tmpdir("dangling");
    write(&d, "keep.txt", "梯度下降 保留");
    let mut idx = Index::open(":memory:").unwrap();
    let r = root(&d);
    idx.update(std::slice::from_ref(&r), &["txt"], |_| {}).unwrap();
    assert_eq!(idx.len().unwrap(), 1);

    // A dangling link is skipped and does not protect the directory: a real
    // deletion in the same run is still noticed.
    #[cfg(windows)]
    let linked = std::process::Command::new("cmd")
        .args(["/C", "mklink"])
        .arg(d.join("dead.txt"))
        .arg(d.join("nope.txt"))
        .status();
    #[cfg(not(windows))]
    let linked = std::os::unix::fs::symlink(d.join("nope.txt"), d.join("dead.txt"));

    if !matches!(linked, Ok(s) if s.success()) {
        eprintln!("skipped: cannot create a symlink here");
        let _ = fs::remove_dir_all(&d);
        return;
    }
    fs::remove_file(d.join("keep.txt")).unwrap();
    let stats = idx.update(std::slice::from_ref(&r), &["txt"], |_| {}).unwrap();
    assert_eq!(stats.removed, 1);
    assert_eq!(idx.len().unwrap(), 0);
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn db_path_with_uri_metacharacters_stays_literal() {
    // `#` starts a URI fragment and a space needs escaping; without the URI
    // parsing being switched off the name would be truncated at `#`
    // (`?` is not even a legal Win32 filename character, so it is not tested).
    let d = tmpdir("metachar");
    let db = d.join("idx #1.db");
    let mut idx = Index::open(&db).unwrap();
    idx.update(&[root(&d)], &["txt"], |_| {}).unwrap();
    drop(idx);
    assert!(db.is_file(), "the literal file name must exist");
    assert_eq!(fs::read_dir(&d).unwrap().count(), 1, "no stray extra file");
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn clear_and_empty_guards() {
    let d = corpus("clr");
    let mut idx = index_of(&d);
    assert!(!idx.is_empty().unwrap());
    idx.clear().unwrap();
    assert!(idx.is_empty().unwrap());
    assert_eq!(idx.len().unwrap(), 0);
    assert!(idx.search("   ", None, 5).unwrap().is_empty());
    assert!(idx.search("梯度下降", None, 0).unwrap().is_empty());
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn thousand_file_build_time() {
    let d = tmpdir("perf");
    for i in 0..1000 {
        write(
            &d,
            &format!("f{i}.txt"),
            &format!("文件 {i} 內容 梯度下降 測試資料 padding padding padding"),
        );
    }
    let mut idx = Index::open(":memory:").unwrap();
    let stats = idx.update(&[root(&d)], &["txt"], |_| {}).unwrap();
    println!("1000 files: {} added in {} ms", stats.added, stats.elapsed_ms);
    assert_eq!(stats.added, 1000);
    assert_eq!(idx.search("梯度下降", None, 5).unwrap().len(), 5);
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn unicode_paths() {
    let d = tmpdir("中文路徑");
    write(&d, "中文檔名.txt", "內容有 梯度下降 字樣");
    let mut idx = Index::open(d.join("db.sqlite")).unwrap();
    idx.update(&[root(&d)], &["txt"], |_| {}).unwrap();
    let hits = idx.search("梯度下降", None, 5).unwrap();
    assert_eq!(hits.len(), 1);
    assert!(hits[0].name.ends_with("中文檔名.txt"));
    assert!(!hits[0].path.starts_with(r"\\?\"));
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn mtime_is_milliseconds() {
    let d = tmpdir("ms");
    write(&d, "a.txt", "梯度下降");
    let idx = index_of(&d);
    let hit = &idx.search("梯度下降", None, 1).unwrap()[0];
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    assert!(hit.mtime > now_ms - 3_600_000, "mtime looks like ns: {}", hit.mtime);
    assert!(hit.mtime <= now_ms + 5_000);
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn all_roots_unreadable_is_reported_not_an_error() {
    let mut idx = Index::open(":memory:").unwrap();
    let stats = idx
        .update(&[PathBuf::from(r"Z:\nope\nope")], &[], |_| {})
        .unwrap();
    assert_eq!(stats.unreadable_roots.len(), 1);
    assert_eq!(stats.scanned, 0);
}

#[test]
fn newer_schema_is_refused() {
    let d = tmpdir("schema");
    let db = d.join("db.sqlite");
    drop(Index::open(&db).unwrap());
    {
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.pragma_update(None, "user_version", 99i64).unwrap();
    }
    let err = Index::open(&db).unwrap_err();
    assert!(matches!(err, fulltext::Error::SchemaVersion { found: 99, .. }));
    assert!(serde_json::to_string(&err).unwrap().contains("schema_version"));
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn progress_callback_panic_leaves_index_usable() {
    let d = corpus("panic");
    let mut idx = Index::open(":memory:").unwrap();
    let r = root(&d);
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = idx.update(std::slice::from_ref(&r), &["txt"], |_| panic!("boom"));
    }));
    assert!(res.is_err());
    let stats = idx.update(std::slice::from_ref(&r), &["txt"], |_| {}).unwrap();
    assert!(stats.added > 0, "transaction was rolled back cleanly");
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn empty_roots_does_not_wipe_the_index() {
    let d = corpus("emptyroots");
    let mut idx = index_of(&d);
    let before = idx.len().unwrap();
    let stats = idx.update(&[], &["txt"], |_| {}).unwrap();
    assert_eq!(stats.scanned, 0);
    assert_eq!(idx.len().unwrap(), before);
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn truncation_does_not_split_a_multibyte_char() {
    let d = tmpdir("cut");
    // `梯` is 3 bytes; MAX_INDEX_BYTES is a multiple of 3 plus 2, so the cut
    // lands inside a character and the file is one byte past the cap.
    let body = "梯".repeat(fulltext::MAX_INDEX_BYTES / 3 + 1);
    write(&d, "cut.txt", &body);

    let idx = index_of(&d);
    let hits = idx.search("梯梯", None, 5).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].size as usize, body.len(), "the file itself is not truncated");
    let snippet = &hits[0].snippets[0];
    assert!(!snippet.contains('\u{FFFD}'), "no U+FFFD at the cut: {snippet}");
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn limit_is_capped() {
    let d = tmpdir("lim");
    for i in 0..30 {
        write(&d, &format!("f{i}.txt"), "共同關鍵字 梯度下降");
    }
    let idx = index_of(&d);
    assert_eq!(idx.search("梯度下降", None, 5).unwrap().len(), 5);
    assert_eq!(idx.search("梯度下降", None, 10_000).unwrap().len(), 30);
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn ascii_root_beside_multibyte_paths_does_not_panic() {
    // `é` is 2 bytes; slicing "中文/a.txt" at byte 2 lands inside `中`.
    // Both roots are passed, so every stored CJK path is compared with `é`.
    let d = tmpdir("mbprefix");
    write(&d, "中文/a.txt", "梯度下降 內容");
    let e = d.join("é");
    fs::create_dir_all(&e).unwrap();
    fs::write(e.join("b.txt"), "梯度下降 在 e").unwrap();

    let mut idx = Index::open(":memory:").unwrap();
    idx.update(&[root(&d)], &["txt"], |_| {}).unwrap();
    assert_eq!(idx.len().unwrap(), 2);

    let stats = idx.update(&[root(&d), root(&e)], &["txt"], |_| {}).unwrap();
    assert_eq!(stats.unchanged, 2);
    assert_eq!(idx.len().unwrap(), 2);
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn deep_tree_is_walked() {
    let d = tmpdir("deep");
    let mut deep = d.clone();
    for i in 0..80 {
        deep.push(format!("l{i}"));
    }
    fs::create_dir_all(&deep).unwrap();
    fs::write(deep.join("bottom.txt"), "梯度下降 在最底層").unwrap();

    let idx = index_of(&d);
    let hits = idx.search("梯度下降", None, 5).unwrap();
    assert_eq!(hits.len(), 1);
    assert!(hits[0].path.ends_with("bottom.txt"));
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn like_fallback_treats_wildcards_literally() {
    let d = tmpdir("wild");
    write(&d, "pct.txt", "進度 50% 完成，代號 a_b");
    write(&d, "other.txt", "進度 5X 完成，代號 axb");
    let idx = index_of(&d);

    assert_eq!(idx.search("0%", None, 5).unwrap().len(), 1);
    assert_eq!(idx.search("a_", None, 5).unwrap().len(), 1);
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn punctuation_only_query_works() {
    let d = tmpdir("punct");
    write(&d, "a.txt", "待辦 !!! 與 ... 都要處理");
    let idx = index_of(&d);
    assert_eq!(idx.search("!!!", None, 5).unwrap().len(), 1);
    assert_eq!(idx.search("..", None, 5).unwrap().len(), 1);
    let _ = fs::remove_dir_all(&d);
}

#[cfg(windows)]
#[test]
fn case_only_rename_replaces_the_row() {
    let d = tmpdir("case");
    write(&d, "sub/File.txt", "梯度下降 舊");
    let mut idx = Index::open(":memory:").unwrap();
    let r = root(&d);
    idx.update(std::slice::from_ref(&r), &["txt"], |_| {}).unwrap();
    assert_eq!(idx.len().unwrap(), 1);

    fs::rename(d.join("sub/File.txt"), d.join("sub/file.txt")).unwrap();
    let stats = idx.update(std::slice::from_ref(&r), &["txt"], |_| {}).unwrap();
    assert_eq!(stats.removed, 1);
    assert_eq!(idx.len().unwrap(), 1, "no duplicate row for the same file");
    assert_eq!(idx.search("梯度下降", None, 5).unwrap().len(), 1);
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn narrowed_ext_filter_drops_disallowed_files() {
    let d = corpus("narrow");
    let mut idx = Index::open(":memory:").unwrap();
    let r = root(&d);
    idx.update(std::slice::from_ref(&r), &["txt", "rs", "log"], |_| {}).unwrap();
    let stats = idx.update(std::slice::from_ref(&r), &["rs"], |_| {}).unwrap();
    assert_eq!(stats.removed, 19);
    assert_eq!(idx.len().unwrap(), 1);
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn punctuation_terms_go_through_the_verbatim_path() {
    // `ab!` and `a-b` contain separator characters: the trigram tokenizer
    // cannot index them as one token, so FTS would silently miss them.
    let d = tmpdir("punct2");
    write(&d, "a.txt", "版本 v1.2 標記 ab! 結尾");
    write(&d, "b.txt", "另一行 v9.9 與 ab 開頭");
    let idx = index_of(&d);

    assert_eq!(idx.search("ab!", None, 5).unwrap().len(), 1);
    assert_eq!(idx.search("1.2", None, 5).unwrap().len(), 1);
    assert_eq!(idx.search("v1.2", None, 5).unwrap().len(), 1, "match is literal");
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn snippets_highlight_the_whole_term_not_a_prefix() {
    let d = tmpdir("longfirst");
    write(&d, "a.txt", "這份文件講梯度下降，後面才提梯度。");
    let idx = index_of(&d);
    let hit = &idx.search("梯度 梯度下降", None, 5).unwrap()[0];
    assert!(hit.snippets.iter().any(|s| s.contains("[[梯度下降]]")), "{:?}", hit.snippets);
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn ext_filter_tolerates_surrounding_dots_and_spaces() {
    let d = tmpdir("dots");
    write(&d, "a.txt", "梯度下降");
    let idx = index_of(&d);
    assert_eq!(idx.search("梯度下降", Some(&[".txt."]), 5).unwrap().len(), 1);
    assert_eq!(idx.search("梯度下降", Some(&[" TXT "]), 5).unwrap().len(), 1);
    let _ = fs::remove_dir_all(&d);
}

#[cfg(windows)]
#[test]
fn junction_loop_terminates() {
    // A junction pointing back at its own parent is the classic hang: the path
    // text grows on every lap, so only the canonical target can stop it.
    let d = tmpdir("loop");
    let sub = d.join("sub");
    fs::create_dir_all(&sub).unwrap();
    fs::write(sub.join("a.txt"), "梯度下降").unwrap();
    let status = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(sub.join("back"))
        .arg(&sub)
        .status();
    if !matches!(status, Ok(s) if s.success()) {
        eprintln!("skipped: mklink /J unavailable");
        return;
    }
    let idx = index_of(&d);
    assert_eq!(idx.len().unwrap(), 1, "the loop must not be walked twice");
    assert_eq!(idx.search("梯度下降", None, 5).unwrap().len(), 1);
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn a_file_may_be_a_root() {
    let d = tmpdir("fileroot");
    write(&d, "a.txt", "梯度下降 單檔根");
    write(&d, "b.txt", "梯度下降 別人");
    let mut idx = Index::open(":memory:").unwrap();
    let file = fs::canonicalize(d.join("a.txt")).unwrap();

    let stats = idx.update(std::slice::from_ref(&file), &["txt"], |_| {}).unwrap();
    assert!(stats.unreadable_roots.is_empty(), "{:?}", stats.unreadable_roots);
    assert_eq!(stats.added, 1);
    assert_eq!(idx.len().unwrap(), 1);

    let again = idx.update(std::slice::from_ref(&file), &["txt"], |_| {}).unwrap();
    assert!(again.unreadable_roots.is_empty(), "{:?}", again.unreadable_roots);
    assert_eq!(again.unchanged, 1, "a file root must be seen as already indexed");
    assert_eq!(again.updated + again.added, 0, "no duplicate row is written");
    assert_eq!(idx.len().unwrap(), 1, "no duplicate row");

    fs::remove_file(&file).unwrap();
    let gone = idx.update(std::slice::from_ref(&file), &["txt"], |_| {}).unwrap();
    assert_eq!(gone.removed, 0, "a missing file root keeps its entry");
    assert_eq!(idx.len().unwrap(), 1);
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn narrowing_exts_drops_a_file_root_row() {
    let d = tmpdir("fileroot2");
    write(&d, "a.txt", "梯度下降");
    let mut idx = Index::open(":memory:").unwrap();
    let file = fs::canonicalize(d.join("a.txt")).unwrap();
    idx.update(std::slice::from_ref(&file), &["txt"], |_| {}).unwrap();
    assert_eq!(idx.len().unwrap(), 1);

    let stats = idx.update(std::slice::from_ref(&file), &["rs"], |_| {}).unwrap();
    assert_eq!(stats.removed, 1, "a no-longer-allowed file root is dropped");
    assert_eq!(idx.len().unwrap(), 0);
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn early_return_still_reports_elapsed() {
    let mut idx = Index::open(":memory:").unwrap();
    let stats = idx.update(&[], &[], |_| {}).unwrap();
    assert_eq!(stats.scanned, 0);
    assert!(stats.elapsed_ms.checked_add(1).is_some(), "a duration is reported");
}

#[test]
fn absurdly_long_query_is_truncated_not_rejected() {
    let d = tmpdir("manyterms");
    write(&d, "a.txt", "alpha 梯度下降");
    let idx = index_of(&d);
    let q = std::iter::repeat("alpha").take(20_000).collect::<Vec<_>>().join(" ");
    assert_eq!(idx.search(&q, None, 5).unwrap().len(), 1);
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn uri_db_path_is_not_created_as_a_directory() {
    let d = tmpdir("uri");
    let db = d.join("idx.db");
    let uri = format!("file:{}?mode=rwc", db.to_string_lossy().replace('\\', "/"));
    let mut idx = Index::open(&uri).unwrap();
    assert!(db.is_file(), "the db file itself is created");
    assert_eq!(idx.len().unwrap(), 0);
    idx.clear().unwrap();
    let _ = fs::remove_dir_all(&d);
}

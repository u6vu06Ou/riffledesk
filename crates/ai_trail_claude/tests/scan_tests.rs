use ai_trail_claude::{scan, TrailItem, TrailKind};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

/// Build a scratch projects tree: `<tmp>/<project>/<session>.jsonl`.
struct Sandbox {
    root: PathBuf,
}

impl Sandbox {
    fn new(tag: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "ai_trail_claude_test_{tag}_{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        Self { root }
    }

    fn project(&self, name: &str) -> PathBuf {
        let p = self.root.join(name);
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn write(&self, project: &str, session: &str, body: &str) -> PathBuf {
        let p = self.project(project).join(format!("{session}.jsonl"));
        fs::write(&p, body).unwrap();
        p
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn assistant_line(ts: &str, content: &str) -> String {
    format!(
        r#"{{"type":"assistant","timestamp":"{ts}","message":{{"role":"assistant","content":[{content}]}}}}"#
    )
}

fn write_block(path: &str) -> String {
    format!(
        r#"{{"type":"tool_use","name":"Write","input":{{"file_path":{}}}}}"#,
        serde_json::to_string(path).unwrap()
    )
}

fn text_block(text: &str) -> String {
    format!("{{\"type\":\"text\",\"text\":{}}}", serde_json::to_string(text).unwrap())
}

fn paths_of(items: &[TrailItem]) -> Vec<&str> {
    items.iter().map(|i| i.path.as_str()).collect()
}

#[test]
fn real_transcripts_yield_writes_and_mentions() {
    let items = scan(fixtures(), None);
    assert!(!items.is_empty(), "fixtures must produce hits");

    let written: Vec<&TrailItem> = items.iter().filter(|i| i.kind == TrailKind::Written).collect();
    assert!(!written.is_empty(), "fixtures contain Write calls");
    assert!(written
        .iter()
        .all(|i| i.path.starts_with("D:\\workspace\\demo\\APP\\")));
    assert!(written.iter().all(|i| !i.path.contains('/')));
    assert!(written.iter().all(|i| !i.session_id.is_empty()));
    assert!(written.iter().all(|i| i.project_dir == "fixtures"));

    // Latest event first.
    assert!(items.windows(2).all(|w| w[0].timestamp >= w[1].timestamp));

    // Nothing bogus: every path is absolute and deduplicated.
    let mut seen = std::collections::HashSet::new();
    for item in &items {
        assert!(item.path.starts_with("D:\\"), "not absolute: {}", item.path);
        assert!(seen.insert(item.path.clone()), "duplicate: {}", item.path);
    }
}

#[test]
fn duplicate_paths_collapse_to_newest_with_newest_kind() {
    let sb = Sandbox::new("dedupe");
    let body = [
        assistant_line("2026-10-01T00:00:01Z", &text_block("看 D:\\p\\a.md 就好")),
        assistant_line("2026-10-01T00:00:05Z", &write_block("D:/p/a.md")),
        assistant_line("2026-10-01T00:00:09Z", &text_block("D:\\p\\a.md 又提一次")),
    ]
    .join("\n");
    sb.write("proj", "s1", &body);

    let items = scan(&sb.root, None);
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].path, "D:\\p\\a.md");
    assert_eq!(items[0].kind, TrailKind::Mentioned);
    assert_eq!(items[0].timestamp, 1_790_812_809_000);
}

#[test]
fn since_filters_by_event_time() {
    let sb = Sandbox::new("since");
    let body = [
        assistant_line("2026-10-01T00:00:00Z", &write_block("D:\\p\\old.md")),
        assistant_line("2026-10-05T00:00:00Z", &write_block("D:\\p\\new.md")),
    ]
    .join("\n");
    sb.write("proj", "s1", &body);

    let cutoff = UNIX_EPOCH + Duration::from_secs(1_791_158_400); // 2026-10-03
    let items = scan(&sb.root, Some(cutoff));
    assert_eq!(paths_of(&items), vec!["D:\\p\\new.md"]);
}

#[test]
fn skips_broken_lines_and_non_transcripts() {
    let sb = Sandbox::new("broken");
    let body = [
        "not json at all".to_string(),
        String::new(),
        assistant_line("2026-10-01T00:00:01Z", &write_block("D:\\p\\ok.md")),
        r#"{"type":"assistant","timestamp":"2026-10-01T00:00:02Z","message":{"content":[{"type":"tool_use""#
            .to_string(),
        assistant_line("2026-10-01T00:00:03Z", &write_block("D:\\p\\also_ok.md")),
        String::new(),
    ]
    .join("\n");
    sb.write("proj", "s1", &body);
    fs::write(sb.project("proj").join("notes.txt"), "{}\n").unwrap();
    fs::write(sb.project("proj").join("empty.jsonl"), "").unwrap();

    let items = scan(&sb.root, None);
    let mut got = paths_of(&items);
    got.sort();
    assert_eq!(got, vec!["D:\\p\\also_ok.md", "D:\\p\\ok.md"]);
}

#[test]
fn path_split_across_two_lines_is_skipped_not_fatal() {
    let sb = Sandbox::new("split");
    // A path cut by a newline inside the JSON string still parses as a value
    // split at the boundary; the tail line has no drive letter, so nothing is
    // invented, but the rest of the file must still be scanned.
    let body = [
        r#"{"type":"assistant","timestamp":"2026-10-01T00:00:01Z","message":{"content":[{"type":"text","text":"存到 D:\\p\\half"#.to_string(),
        "renamed.md 了\"}]}}".to_string(),
        assistant_line("2026-10-01T00:00:02Z", &write_block("D:\\p\\after.md")),
    ]
    .join("\n");
    sb.write("proj", "s1", &body);
    let items = scan(&sb.root, None);
    assert_eq!(paths_of(&items), vec!["D:\\p\\after.md"]);
}

#[test]
fn chinese_paths_and_backtick_wrapping_survive() {
    let sb = Sandbox::new("cjk");
    let body = assistant_line(
        "2026-10-01T00:00:01Z",
        &text_block("報告在 `D:/工作/報告/驗收.md`，別忘了。"),
    );
    sb.write("proj", "s1", &body);
    let items = scan(&sb.root, None);
    assert_eq!(paths_of(&items), vec!["D:\\工作\\報告\\驗收.md"]);
    assert_eq!(items[0].kind, TrailKind::Mentioned);
}

#[test]
fn nonexistent_paths_report_exists_false() {
    let sb = Sandbox::new("exists");
    let real = Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
    let real_arg = real.to_string_lossy().to_string();
    let body = [
        assistant_line("2026-10-01T00:00:01Z", &write_block("D:\\no\\such\\file.md")),
        assistant_line("2026-10-01T00:00:02Z", &write_block(&real_arg)),
    ]
    .join("\n");
    sb.write("proj", "s1", &body);

    let items = scan(&sb.root, None);
    let missing = items.iter().find(|i| i.path.ends_with("file.md")).unwrap();
    let present = items.iter().find(|i| i.path.ends_with("Cargo.toml")).unwrap();
    assert!(!missing.exists);
    assert!(present.exists);
}

#[test]
fn only_write_tools_count_as_written() {
    let sb = Sandbox::new("tools");
    let body = assistant_line(
        "2026-10-01T00:00:01Z",
        &format!(
            "{},{}",
            r#"{"type":"tool_use","name":"Read","input":{"file_path":"D:\\p\\read.md"}}"#,
            r#"{"type":"tool_use","name":"NotebookEdit","input":{"file_path":"D:\\p\\nb.ipynb"}}"#
        ),
    );
    sb.write("proj", "s1", &body);
    let items = scan(&sb.root, None);
    assert_eq!(paths_of(&items), vec!["D:\\p\\nb.ipynb"]);
    assert_eq!(items[0].kind, TrailKind::Written);
}

#[test]
fn gzipped_transcripts_are_read() {
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;

    let sb = Sandbox::new("gz");
    let dir = sb.project("proj");
    let body = assistant_line("2026-10-01T00:00:01Z", &write_block("D:\\p\\zip.md"));
    let mut enc = GzEncoder::new(Vec::new(), Compression::default());
    enc.write_all(body.as_bytes()).unwrap();
    fs::write(dir.join("s9.jsonl.gz"), enc.finish().unwrap()).unwrap();

    let items = scan(&sb.root, None);
    assert_eq!(paths_of(&items), vec!["D:\\p\\zip.md"]);
    assert_eq!(items[0].session_id, "s9");
}

#[test]
fn missing_root_returns_empty() {
    let items = scan("D:\\definitely\\not\\here\\at\\all", Some(UNIX_EPOCH));
    assert!(items.is_empty());
}

#[test]
fn item_serialises_to_frontend_json() {
    let item = TrailItem {
        path: "D:\\p\\a.md".into(),
        kind: TrailKind::Written,
        timestamp: 1_700_000_000_000,
        project_dir: "proj".into(),
        session_id: "s1".into(),
        exists: true,
    };
    let json = serde_json::to_string(&item).unwrap();
    assert!(json.contains(r#""kind":"written""#));
    assert!(json.contains(r#""exists":true"#));
    assert_eq!(
        item.system_time(),
        Some(SystemTime::UNIX_EPOCH + Duration::from_millis(1_700_000_000_000))
    );
}


#[test]
fn oversized_line_is_capped_and_stream_stays_aligned() {
    let sb = Sandbox::new("huge");
    // One ~17 MB event line (a Write with a giant inline payload) followed by a
    // normal one: the giant line must not blow memory nor swallow the next.
    let huge = format!(
        r#"{{"type":"assistant","timestamp":"2026-10-01T00:00:01Z","message":{{"content":[{{"type":"tool_use","name":"Write","input":{{"file_path":"D:\\p\\big.md","content":"{}"}}}}]}}}}"#,
        "x".repeat(17 * 1024 * 1024)
    );
    let body = [
        huge,
        assistant_line("2026-10-01T00:00:02Z", &write_block(r"D:\p\after_big.md")),
    ]
    .join("\n");
    sb.write("proj", "s1", &body);

    let items = scan(&sb.root, None);
    let got = paths_of(&items);
    assert!(got.contains(&r"D:\p\big.md"));
    assert!(got.contains(&r"D:\p\after_big.md"));
}

#[test]
fn scan_survives_a_nested_project_tree() {
    let sb = Sandbox::new("nested");
    let deep = sb.project("outer").join("inner");
    fs::create_dir_all(&deep).unwrap();
    fs::write(
        deep.join("s2.jsonl"),
        assistant_line("2026-10-01T00:00:01Z", &write_block(r"D:\p\nested.md")),
    )
    .unwrap();

    let items = scan(&sb.root, None);
    assert_eq!(paths_of(&items), vec![r"D:\p\nested.md"]);
    assert_eq!(items[0].project_dir, "inner");
}

#[test]
fn string_content_falls_back_to_prose_scan() {
    let sb = Sandbox::new("strcontent");
    let body = r#"{"type":"assistant","timestamp":"2026-10-01T00:00:01Z","message":{"role":"assistant","content":"已寫入 D:\\p\\strcontent.md 了"}}"#;
    sb.write("proj", "s1", body);
    let items = scan(&sb.root, None);
    assert_eq!(paths_of(&items), vec![r"D:\p\strcontent.md"]);
    assert_eq!(items[0].kind, TrailKind::Mentioned);
}

#[test]
fn multi_member_gzip_is_fully_read() {
    use flate2::write::GzEncoder;
    use flate2::{Compression, GzBuilder};
    use std::io::Write;

    let sb = Sandbox::new("multigz");
    let dir = sb.project("proj");
    let mut enc = GzEncoder::new(Vec::new(), Compression::default());
    let l1 = format!("{}
", assistant_line("2026-10-01T00:00:01Z", &write_block(r"D:\p\m1.md")));
    enc.write_all(l1.as_bytes()).unwrap();
    let first = enc.finish().unwrap();
    let mut enc = GzBuilder::new().write(Vec::new(), Compression::default());
    let l2 = format!("{}
", assistant_line("2026-10-01T00:00:02Z", &write_block(r"D:\p\m2.md")));
    enc.write_all(l2.as_bytes()).unwrap();
    let second = enc.finish().unwrap();
    let mut joined = first;
    joined.extend_from_slice(&second);
    fs::write(dir.join("s1.jsonl.gz"), joined).unwrap();

    let items = scan(&sb.root, None);
    let mut got = paths_of(&items);
    got.sort();
    assert_eq!(got, vec![r"D:\p\m1.md", r"D:\p\m2.md"]);
}


#[test]
fn notebook_edit_uses_notebook_path() {
    let sb = Sandbox::new("nb");
    let body = assistant_line(
        "2026-10-01T00:00:01Z",
        r#"{"type":"tool_use","name":"NotebookEdit","input":{"notebook_path":"D:\\p\\nb.ipynb"}}"#,
    );
    sb.write("proj", "s1", &body);
    assert_eq!(paths_of(&scan(&sb.root, None)), vec!["D:\\p\\nb.ipynb"]);
}

#[test]
fn unc_only_line_passes_the_pre_filter() {
    // No drive colon, no tool_use: only the UNC escape can let it through.
    let sb = Sandbox::new("unconly");
    let body = assistant_line("2026-10-01T00:00:01Z", &text_block("看 \\\\nas\\share\\x.txt 就好"));
    sb.write("proj", "s1", &body);
    assert_eq!(paths_of(&scan(&sb.root, None)), vec!["\\\\nas\\share\\x.txt"]);
}

#[test]
fn duplicate_paths_differing_only_by_case_collapse() {
    let sb = Sandbox::new("case");
    let body = [
        assistant_line("2026-10-01T00:00:01Z", &write_block("D:\\Src\\A.rs")),
        assistant_line("2026-10-01T00:00:05Z", &write_block("d:\\src\\a.rs")),
    ]
    .join("\n");
    sb.write("proj", "s1", &body);
    let items = scan(&sb.root, None);
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].path, "D:\\src\\a.rs");
}

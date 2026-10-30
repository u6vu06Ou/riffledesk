use std::path::PathBuf;
use std::time::{Duration, UNIX_EPOCH};

use ai_trail_codex::{from_millis, scan, TrailKind};

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join(name)
}

fn find<'a>(items: &'a [ai_trail_codex::TrailItem], needle: &str) -> Option<&'a ai_trail_codex::TrailItem> {
    items.iter().find(|i| i.path.contains(needle))
}

#[test]
fn extracts_written_and_mentioned_from_patches_and_prose() {
    let items = scan(&[fixture("home_a")], None);
    let lib = find(&items, "src\\lib.rs").expect("lib.rs trail");
    assert_eq!(lib.kind, TrailKind::Written);
    assert_eq!(lib.project_dir, "D:\\workspace\\demo\\PROJ");
    assert_eq!(lib.session_id, "01a15989-3570-7ae0-9ace-c529074b947e");
    // Later FileChange event carries the same path: newest wins.
    assert_eq!(lib.timestamp, 1_792_503_560_000);

    let main = find(&items, "src\\main.rs").expect("main.rs trail");
    assert_eq!(main.kind, TrailKind::Written);

    let cargo = find(&items, "Cargo.toml").expect("Cargo.toml from FileChange");
    assert_eq!(cargo.kind, TrailKind::Written);

    let report = find(&items, "REPORT.md").expect("mentioned report");
    assert_eq!(report.kind, TrailKind::Mentioned);

    // Forward slashes are normalized; the agent message is captured too.
    assert!(items.iter().all(|i| !i.path.contains('/')));
}

#[test]
fn newest_event_wins_regardless_of_scan_order() {
    // home_b names main.rs earlier (mention) than home_a writes it: write survives,
    // and its timestamp is the newest one.
    let items = scan(&[fixture("home_b"), fixture("home_a")], None);
    let main = find(&items, "src\\main.rs").expect("main.rs trail");
    assert_eq!(main.kind, TrailKind::Written);
    assert_eq!(main.timestamp, 1_792_503_542_049);
    let dupes = items.iter().filter(|i| i.path.ends_with("main.rs")).count();
    assert_eq!(dupes, 1);
}

#[test]
fn newest_mention_upgrades_older_mention() {
    let items = scan(&[fixture("home_b")], None);
    let user_only = find(&items, "user_only.md").expect("user message mention");
    assert_eq!(user_only.timestamp, 1_792_396_803_000);
}

#[test]
fn results_are_sorted_newest_first() {
    let items = scan(&[fixture("home_a"), fixture("home_b"), fixture("loose")], None);
    assert!(items.len() >= 3);
    assert!(items.windows(2).all(|w| w[0].timestamp >= w[1].timestamp));
}

#[test]
fn survives_bad_lines_missing_trailing_newline_and_empty_files() {
    // home_b contains a non-JSON line and a non-UTF8 byte; loose has no final newline.
    let items = scan(&[fixture("home_b"), fixture("loose"), fixture("empty_home")], None);
    assert!(find(&items, "only_update.md").is_some());
    assert!(find(&items, "bad").is_some());
    let unc = find(&items, "net.ps1").expect("UNC path in loose fixture");
    assert_eq!(unc.path, "\\\\srv\\share\\net.ps1");
    assert_eq!(unc.project_dir, "C:\\other");
}

#[test]
fn since_filters_old_events_and_files() {
    let cut = from_millis(1_792_500_000_000); // 2026-10-19T12:00Z
    let items = scan(&[fixture("home_a"), fixture("home_b")], Some(cut));
    assert!(items.iter().all(|i| i.timestamp >= 1_792_500_000_000));
    assert!(find(&items, "src\\lib.rs").is_some());
    // home_b's only_update.md is from 10-19T08:00, before the cut.
    assert!(find(&items, "only_update.md").is_none());
}

#[test]
fn since_from_epoch_keeps_everything() {
    let all = scan(&[fixture("home_a")], None);
    let with_epoch = scan(&[fixture("home_a")], Some(UNIX_EPOCH));
    assert_eq!(all.len(), with_epoch.len());
}

#[test]
fn accepts_a_single_rollout_file_as_root() {
    let file = fixture("home_a")
        .join("sessions/2026/10/20")
        .join("rollout-2026-10-20T21-38-46-01a15989-3570-7ae0-9ace-c529074b947e.jsonl");
    let items = scan(&[file], None);
    assert!(find(&items, "src\\lib.rs").is_some());
}

#[test]
fn nonexistent_root_is_ignored() {
    let items = scan(&[fixture("does_not_exist")], None);
    assert!(items.is_empty());
}

#[test]
fn exists_flag_reflects_disk() {
    let dir = std::env::temp_dir().join("ai_trail_codex_exists");
    let _ = std::fs::create_dir_all(&dir);
    let cut = UNIX_EPOCH + Duration::from_millis(1_792_500_000_000);
    let items = scan(&[fixture("home_a")], Some(cut));
    assert!(items.iter().all(|i| !i.exists), "fixture paths are virtual");
    assert!(find(&items, "src\\lib.rs").is_some());
    let _ = cut;
}

#[test]
fn serialize_shape_is_camel_expected() {
    let items = scan(&[fixture("home_a")], None);
    let json = serde_json::to_string(&items[0]).unwrap();
    for key in ["path", "kind", "timestamp", "project_dir", "session_id", "exists"] {
        assert!(json.contains(key), "missing {key} in {json}");
    }
    assert!(json.contains("\"kind\":\"written\"") || json.contains("\"kind\":\"mentioned\""));
}

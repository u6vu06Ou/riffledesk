//! Scan Claude Code JSONL transcripts for file paths the AI wrote or mentioned.
//!
//! Transcripts live in `%USERPROFILE%\.claude\projects\<encoded-cwd>\<session>.jsonl`
//! (older ones may be `.jsonl.gz`). Each line is one JSON event. We stream them
//! line by line — no whole-file buffering — and surface two kinds of hits:
//!
//! * [`TrailKind::Written`]: `file_path` of a `Write` / `Edit` / `NotebookEdit` tool call.
//! * [`TrailKind::Mentioned`]: an absolute Windows path appearing in assistant prose.
//!
//! Broken lines (truncated by a crash, half-written JSON) are skipped, never fatal.

pub mod normalize;

use serde::Serialize;
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub use normalize::{extract_paths, is_absolute_windows, normalize};

/// Which tool produced the file reference.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TrailKind {
    /// The AI wrote or edited the file.
    Written,
    /// The AI only talked about the file (path in its reply text).
    Mentioned,
}

impl TrailKind {
    /// Parsed marker used by the frontend filters.
    pub fn as_str(self) -> &'static str {
        match self {
            TrailKind::Written => "written",
            TrailKind::Mentioned => "mentioned",
        }
    }
}

/// One hit. Serialises straight to the frontend as JSON.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TrailItem {
    /// Normalised absolute Windows path (single `\` separators).
    pub path: String,
    pub kind: TrailKind,
    /// Event time, epoch milliseconds since the Unix epoch.
    pub timestamp: u64,
    /// Project folder the transcript belongs to (encoded cwd name).
    pub project_dir: String,
    /// Session id (transcript file stem).
    pub session_id: String,
    /// Whether the path still exists on disk right now.
    pub exists: bool,
}

impl TrailItem {
    /// Event time as a [`SystemTime`], or `None` if the stamp overflows
    /// (a corrupt transcript can carry any `u64`).
    pub fn system_time(&self) -> Option<SystemTime> {
        UNIX_EPOCH.checked_add(Duration::from_millis(self.timestamp))
    }
}

/// Tool names whose path input counts as a write.
const WRITE_TOOLS: [&str; 4] = ["Write", "Edit", "MultiEdit", "NotebookEdit"];

/// Input keys carrying a written path. `NotebookEdit` uses the second one.
const FILE_PATH_KEY: &str = "file_path";
const NOTEBOOK_PATH_KEY: &str = "notebook_path";

/// Scan every transcript under `projects_dir`.
///
/// `since` filters by event time (and cheaply pre-filters whole files by
/// modification time). Duplicate paths collapse to the newest hit.
/// Returns hits sorted newest first. Unreadable folders/files are skipped.
pub fn scan(projects_dir: impl AsRef<Path>, since: Option<SystemTime>) -> Vec<TrailItem> {
    let mut items = scan_light(projects_dir, since);
    for it in &mut items {
        it.exists = path_exists(&it.path);
    }
    items
}

/// Same as [`scan`] but never touches the disk again after reading: every
/// `exists` stays `false`.
///
/// A Tauri command should prefer this and fill `exists` lazily — on a slow or
/// offline UNC share one `exists` call can block for seconds, and a GB-scale
/// transcript scan must not wait on it.
pub fn scan_light(projects_dir: impl AsRef<Path>, since: Option<SystemTime>) -> Vec<TrailItem> {
    let root = projects_dir.as_ref();
    let mut best: HashMap<String, TrailItem> = HashMap::new();
    if !root.is_dir() {
        return Vec::new();
    }

    let since_ms = since.map(to_epoch_ms);
    let mut files = Vec::new();
    collect_transcripts(root, &mut files);

    for (file, project_dir) in files {
        // Cheap whole-file pre-filter. Transcripts only ever grow, so a file
        // older than the cutoff cannot hold a newer event... unless it was
        // touched after being written (copy, restore), hence `mtime` alone is
        // treated as a hint, not proof: only skip when *and* we have a filter.
        if let Some(limit) = since_ms {
            if file_mtime_ms(&file).is_some_and(|m| m < limit) {
                continue;
            }
        }
        let session_id = session_id_of(&file);
        scan_file(&file, &project_dir, &session_id, since_ms, &mut best);
    }

    let mut items: Vec<TrailItem> = best.into_values().collect();
    items.sort_by(|a, b| b.timestamp.cmp(&a.timestamp).then_with(|| a.path.cmp(&b.path)));
    items
}

fn path_exists(path: &str) -> bool {
    Path::new(path).exists()
}

fn collect_transcripts(dir: &Path, out: &mut Vec<(PathBuf, String)>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut subdirs = Vec::new();
    let project_dir = dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            subdirs.push(path);
            continue;
        }
        if !meta.is_file() {
            continue;
        }
        // `file_name` is already lowercase-safe to compare on Windows, but the
        // check itself stays case-insensitive for ports and odd archives.
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if name.ends_with(".jsonl") || name.ends_with(".jsonl.gz") {
            out.push((path, project_dir.clone()));
        }
    }
    for sub in subdirs {
        collect_transcripts(&sub, out);
    }
}

fn session_id_of(file: &Path) -> String {
    let name = file.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    name.trim_end_matches(".gz").trim_end_matches(".jsonl").to_string()
}

fn file_mtime_ms(path: &Path) -> Option<u64> {
    std::fs::metadata(path)
        .ok()?
        .modified()
        .ok()
        .map(to_epoch_ms)
}

fn to_epoch_ms(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Reader that transparently gunzips `.gz` transcripts.
///
/// `MultiGzDecoder`, not `GzDecoder`: archives written incrementally (and
/// tool-made `.gz` bundles) hold several members, and the single-member
/// decoder stops silently at the first boundary.
fn open_reader(path: &Path) -> std::io::Result<Box<dyn Read>> {
    let file = File::open(path)?;
    if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("gz")) {
        Ok(Box::new(flate2::read::MultiGzDecoder::new(file)))
    } else {
        Ok(Box::new(file))
    }
}

fn scan_file(
    path: &Path,
    project_dir: &str,
    session_id: &str,
    since_ms: Option<u64>,
    best: &mut HashMap<String, TrailItem>,
) {
    let Ok(reader) = open_reader(path) else { return };
    let mut reader = BufReader::new(reader);
    // Sized for a typical event (~2 KB) but capped: a single runaway line must
    // not drag the whole transcript's megabytes into memory.
    let mut buf: Vec<u8> = Vec::with_capacity(8 * 1024);
    loop {
        buf.clear();
        match read_line_capped(&mut reader, &mut buf) {
            Ok((0, _)) => break,
            Ok((_, dropped)) => {
                while matches!(buf.last(), Some(b'\n') | Some(b'\r')) {
                    buf.pop();
                }
                if buf.is_empty() {
                    continue;
                }
                let line = String::from_utf8_lossy(&buf);
                if dropped {
                    // A cut line never closes its JSON, so a full parse is
                    // hopeless; salvage what the retained head shows verbatim.
                    salvage_line(&line, project_dir, session_id, since_ms, best);
                } else {
                    parse_event(&line, project_dir, session_id, since_ms, best);
                }
            }
            Err(_) => break,
        }
    }
}

/// Hard ceiling on one event line. Real events are far smaller; anything past
/// this is bulk payload we only need the head of.
const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;

/// Read up to `\n`, keeping at most [`MAX_LINE_BYTES`] bytes (the rest of an
/// oversized line is consumed and discarded so the stream stays aligned).
///
/// Returns how many bytes were consumed and whether any were dropped — a byte
/// count alone cannot tell a full 16 MiB line from a truncated one.
fn read_line_capped<R: BufRead>(reader: &mut R, buf: &mut Vec<u8>) -> std::io::Result<(usize, bool)> {
    let mut total = 0;
    let mut dropped = false;
    loop {
        let available = match reader.fill_buf() {
            Ok(a) => a,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        if available.is_empty() {
            return Ok((total, dropped));
        }
        let (take, done) = match available.iter().position(|b| *b == b'\n') {
            Some(pos) => (pos + 1, true),
            None => (available.len(), false),
        };
        let room = MAX_LINE_BYTES.saturating_sub(buf.len());
        let keep = take.min(room);
        if keep < take {
            dropped = true;
        }
        buf.extend_from_slice(&available[..keep]);
        reader.consume(take);
        total += take;
        if done {
            return Ok((total, dropped));
        }
    }
}

/// Best-effort recovery from a line that hit [`MAX_LINE_BYTES`].
///
/// The tail is gone, so the JSON will not parse. Everything we need (the
/// timestamp and the `file_path` values) sits near the front of an event, so a
/// dumb scan of the retained bytes still beats dropping the event entirely.
fn salvage_line(
    line: &str,
    project_dir: &str,
    session_id: &str,
    since_ms: Option<u64>,
    best: &mut HashMap<String, TrailItem>,
) {
    let Some(ts) = line
        .find("\"timestamp\":\"")
        .and_then(|at| line.get(at + 13..at + 13 + 40))
        .and_then(parse_iso8601_ms)
    else {
        return;
    };
    if since_ms.is_some_and(|limit| ts < limit) {
        return;
    }
    for key in [FILE_PATH_KEY, NOTEBOOK_PATH_KEY] {
        for value in raw_json_strings(line, key) {
            let norm = normalize(&value);
            if is_absolute_windows(&norm) {
                record(best, norm, TrailKind::Written, ts, project_dir, session_id);
            }
        }
    }
    // Prose arrives JSON-escaped; unescape the window before extracting.
    for (at, _) in line.match_indices("\"type\":\"text\"") {
        let window = char_slice(line, at, at.saturating_add(4000));
        for p in extract_paths(&json_unescape(window)) {
            record(best, p, TrailKind::Mentioned, ts, project_dir, session_id);
        }
    }
}

/// Raw JSON string values following `"<key>":"` in `text`.
fn raw_json_strings(text: &str, key: &str) -> Vec<String> {
    let needle = format!("\"{key}\":\"");
    let mut out = Vec::new();
    for (at, _) in text.match_indices(&needle) {
        let start = at + needle.len();
        let Some(len) = text[start..].find('"') else { continue };
        out.push(json_unescape(&text[start..start + len]));
    }
    out
}

/// Single left-to-right JSON unescape.
///
/// Sequential `str::replace` calls get this wrong: after `\\` -> `\`, a later
/// `\n` -> newline pass also eats the `n` of a decoded `C:\new\a.txt`.
fn json_unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some('"') => out.push('"'),
            Some('\'') => out.push('\''),
            Some('\\') => out.push('\\'),
            Some('/') => out.push('/'),
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

fn char_slice(s: &str, from: usize, to: usize) -> &str {
    let mut end = to.min(s.len());
    while end > from && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[from.min(end)..end]
}

/// Parse one event line and record its hits. `None` when the line is not a
/// usable assistant event.
fn parse_event(
    line: &str,
    project_dir: &str,
    session_id: &str,
    since_ms: Option<u64>,
    best: &mut HashMap<String, TrailItem>,
) -> Option<()> {
    // Cheap pre-filter before paying for JSON: most lines are bookkeeping.
    // `tool_use` covers writes; a path in prose needs a drive or a UNC prefix
    // (which JSON escapes to four leading backslashes).
    if !line.contains("\"tool_use\"")
        && !line.contains(":\\")
        && !line.contains(":/")
        && !line.contains("\\\\\\\\")
    {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    if value.get("type").and_then(|t| t.as_str()) != Some("assistant") {
        return None;
    }
    let ts = value
        .get("timestamp")
        .and_then(|t| t.as_str())
        .and_then(parse_iso8601_ms)
        .or_else(|| value.get("timestamp").and_then(|t| t.as_u64()))?;

    // Assistant text occasionally arrives as a bare string instead of blocks;
    // fall back to a one-element slice so a whole event is not lost.
    let message = value.get("message")?;
    if since_ms.is_some_and(|limit| ts < limit) {
        return Some(());
    }
    let Some(content) = message.get("content").and_then(|c| c.as_array()) else {
        if let Some(text) = message.get("content").and_then(|c| c.as_str()) {
            for p in extract_paths(text) {
                record(best, p, TrailKind::Mentioned, ts, project_dir, session_id);
            }
        }
        return Some(());
    };
    let mut found: Vec<(String, TrailKind)> = Vec::new();
    for block in content {
        match block.get("type").and_then(|t| t.as_str()) {
            Some("tool_use") => {
                let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("");
                if !WRITE_TOOLS.contains(&name) {
                    continue;
                }
                let input = block.get("input");
                let path = input
                    .and_then(|i| i.get(FILE_PATH_KEY).or_else(|| i.get(NOTEBOOK_PATH_KEY)))
                    .and_then(|p| p.as_str());
                if let Some(fp) = path {
                    let norm = normalize(fp);
                    if is_absolute_windows(&norm) {
                        found.push((norm, TrailKind::Written));
                    }
                }
            }
            Some("text") => {
                if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                    for p in extract_paths(text) {
                        found.push((p, TrailKind::Mentioned));
                    }
                }
            }
            _ => {}
        }
    }

    for (path, kind) in found {
        record(best, path, kind, ts, project_dir, session_id);
    }
    Some(())
}

/// Keep the newest hit per path. Key and struct share one `String`, so only
/// one clone happens and it is never allocated twice.
fn record(
    best: &mut HashMap<String, TrailItem>,
    path: String,
    kind: TrailKind,
    ts: u64,
    project_dir: &str,
    session_id: &str,
) {
    // Windows filesystems are case-insensitive, so `D:\Src\a.rs` and
    // `D:\src\a.rs` are one file; key on lowercase, keep the newest spelling.
    let key = path.to_lowercase();
    if best.get(&key).is_some_and(|prev| prev.timestamp >= ts) {
        return;
    }
    best.insert(
        key,
        TrailItem {
            path,
            kind,
            timestamp: ts,
            project_dir: project_dir.to_string(),
            session_id: session_id.to_string(),
            exists: false,
        },
    );
}

/// Parse `2026-10-19T11:19:24.164Z` (or without millis / with offset) to epoch ms.
pub fn parse_iso8601_ms(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || (b[10] != b'T' && b[10] != b' ') {
        return None;
    }
    let num = |r: std::ops::Range<usize>| -> Option<u64> { s.get(r)?.parse::<u64>().ok() };
    let (year, month, day) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (hour, min, sec) = (num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || min > 59 || sec > 60 {
        return None;
    }
    let mut millis = 0u64;
    let mut idx = 19;
    if b.get(19) == Some(&b'.') {
        let start = 20;
        let mut end = start;
        while end < b.len() && b[end].is_ascii_digit() {
            end += 1;
        }
        let frac = &s[start..end];
        let mut digits = frac.chars().take(3).collect::<String>();
        while digits.len() < 3 {
            digits.push('0');
        }
        millis = digits.parse().ok()?;
        idx = end;
    }
    let mut offset_min = 0i64;
    match b.get(idx) {
        Some(b'Z') | Some(b'z') | None => {}
        Some(sign @ (b'+' | b'-')) => {
            let oh = num(idx + 1..idx + 3)? as i64;
            let om = num(idx + 4..idx + 6).unwrap_or(0) as i64;
            offset_min = if *sign == b'+' { oh * 60 + om } else { -(oh * 60 + om) };
        }
        _ => return None,
    }
    let days = days_from_civil(year as i64, month as i64, day as i64);
    let secs = days * 86_400 + hour as i64 * 3600 + min as i64 * 60 + sec as i64 - offset_min * 60;
    if secs < 0 {
        return None;
    }
    Some(secs as u64 * 1000 + millis)
}

/// Howard Hinnant's civil-date algorithm; days since 1970-01-01.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_iso_timestamps() {
        assert_eq!(parse_iso8601_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(parse_iso8601_ms("1970-01-01T00:00:01Z"), Some(1000));
        assert_eq!(parse_iso8601_ms("1970-01-01T01:00:00+01:00"), Some(0));
        assert_eq!(parse_iso8601_ms("garbage"), None);
        assert_eq!(parse_iso8601_ms("2026-13-01T00:00:00Z"), None);
    }

    #[test]
    fn kind_serialises_lowercase() {
        assert_eq!(serde_json::to_string(&TrailKind::Written).unwrap(), "\"written\"");
        assert_eq!(TrailKind::Mentioned.as_str(), "mentioned");
    }
}

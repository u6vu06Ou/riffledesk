//! Scan Codex session rollouts and extract the files an AI agent touched.
//!
//! Codex writes append-only JSONL rollout logs under
//! `<home>/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`. This crate streams
//! those files line by line (never loading a whole file into memory), pulls out
//! write operations (`apply_patch` hunks, `FileChange` items) and file paths the
//! assistant merely talked about, and returns them as a deduplicated trail.
//!
//! The public API is a single [`scan`] call that is safe to expose directly to a
//! Tauri command: everything returned is `Serialize`.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;

/// How the agent related to the file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TrailKind {
    /// The path was named in assistant prose only.
    Mentioned,
    /// The agent wrote to the path (patch hunk or recorded file change).
    Written,
}

impl TrailKind {
    /// Stable machine name, for logs and assertions.
    pub fn as_str(self) -> &'static str {
        match self {
            TrailKind::Mentioned => "mentioned",
            TrailKind::Written => "written",
        }
    }
}

/// One file the agent touched, ready to be serialized to the frontend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TrailItem {
    /// Normalized absolute Windows path.
    pub path: String,
    /// Whether the agent wrote it or only mentioned it.
    pub kind: TrailKind,
    /// Unix epoch milliseconds of the event that produced this entry.
    pub timestamp: u64,
    /// Working directory of the session (`project_dir`).
    pub project_dir: String,
    /// Session identity (from the rollout filename or its header).
    pub session_id: String,
    /// Whether the path still exists on disk right now.
    pub exists: bool,
}

/// Scan every rollout under `roots` and return the merged trail, newest first.
///
/// Each root may be either a Codex home (containing `sessions/`) or a
/// `sessions/` directory itself. Bare rollout `.jsonl` files inside a
/// `sessions` tree are picked up. With `since`, rollouts whose mtime is older
/// than the cut-off are skipped without being opened, and events older than the
/// cut-off are dropped.
///
/// Malformed lines, unreadable files and non-UTF-8 bytes are skipped; one bad
/// session never aborts the scan. Duplicates keep the newest event, and a write
/// beats a mere mention at the same millisecond.
pub fn scan(roots: &[PathBuf], since: Option<SystemTime>) -> Vec<TrailItem> {
    let mut best: HashMap<String, TrailItem> = HashMap::new();
    let cut_ms = since.and_then(to_millis);

    for file in rollout_files(roots) {
        if let Some(cut) = since {
            if let Ok(meta) = file.metadata() {
                if let Ok(modified) = meta.modified() {
                    if modified < cut {
                        continue;
                    }
                }
            }
        }
        scan_file(&file, cut_ms, &mut best);
    }

    let mut out: Vec<TrailItem> = best
        .into_values()
        .map(|mut item| {
            item.exists = exists_locally(&item.path);
            item
        })
        .collect();
    out.sort_by(|a, b| {
        b.timestamp
            .cmp(&a.timestamp)
            .then_with(|| b.kind.cmp(&a.kind))
            .then_with(|| a.path.cmp(&b.path))
    });
    out
}

/// Collect every `*.jsonl` rollout below the given roots (sorted, deduplicated).
///
/// A root may be a Codex home, a `sessions/` tree, or a single rollout file.
fn rollout_files(roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for root in roots {
        let sessions = root.join("sessions");
        if sessions.is_dir() {
            walk(&sessions, &mut files);
        } else if root.is_dir() {
            walk(root, &mut files);
        } else if root.is_file() {
            files.push(root.clone());
        }
    }
    files.sort();
    files.dedup();
    files
}

/// Depth-limited recursive walk.
///
/// `file_type()` does not follow links, so a symlinked/junctioned directory is
/// skipped rather than descended — that also means a link loop cannot hang us.
/// `MAX_DEPTH` bounds a legitimately deep tree; exceeding it silently stops
/// descending, which is fine for `sessions/YYYY/MM/DD`.
fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let mut stack = vec![(dir.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        if depth > MAX_DEPTH {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            let path = entry.path();
            if ft.is_dir() {
                stack.push((path, depth + 1));
            } else if is_rollout(&path) {
                out.push(path);
            }
        }
    }
}

const MAX_DEPTH: usize = 5;

/// Longest single JSONL line kept; longer ones are skipped, not buffered whole.
const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;

/// Discard the rest of an over-long line, buffered chunk by chunk so the cast-off
/// bytes never accumulate.
fn drain_to_newline<R: BufRead>(reader: &mut R) {
    loop {
        let chunk = match reader.fill_buf() {
            Ok(&[]) | Err(_) => return,
            Ok(chunk) => chunk,
        };
        match chunk.iter().position(|&b| b == b'\n') {
            Some(pos) => {
                reader.consume(pos + 1);
                return;
            }
            None => {
                let len = chunk.len();
                reader.consume(len);
            }
        }
    }
}

fn is_rollout(path: &Path) -> bool {
    path.extension().is_some_and(|e| e.eq_ignore_ascii_case("jsonl"))
        && path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with("rollout-"))
}

/// Streaming read of one rollout file.
fn scan_file(file: &Path, cut: Option<u64>, best: &mut HashMap<String, TrailItem>) {
    let fallback_ts = file
        .metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(to_millis)
        .unwrap_or(0);
    let mut session_id = session_id_from_name(file);
    let mut project_dir = String::new();
    let mut buf: Vec<u8> = Vec::with_capacity(8192);

    let Ok(handle) = File::open(file) else {
        return;
    };
    let mut reader = BufReader::with_capacity(64 * 1024, handle);

    loop {
        buf.clear();
        // Bounded read: one runaway line (embedded base64, blob) must not pull the
        // whole file into memory.
        match reader
            .by_ref()
            .take(MAX_LINE_BYTES as u64 + 1)
            .read_until(b'\n', &mut buf)
        {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => break,
        }
        // Over-long line: skip the remainder, then drop the partial prefix instead
        // of parsing truncated JSON. `buf` is shrunk so 8 MiB is not held to EOF.
        // A short final line without a trailing newline is kept.
        if buf.len() > MAX_LINE_BYTES && buf.last() != Some(&b'\n') {
            drain_to_newline(&mut reader);
            buf = Vec::with_capacity(8192);
            continue;
        }
        let line = String::from_utf8_lossy(&buf);
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };

        let ts = value
            .get("timestamp")
            .and_then(serde_json::Value::as_str)
            .and_then(parse_rfc3339_millis)
            .unwrap_or(fallback_ts);
        if let Some(cut) = cut {
            if ts < cut {
                continue;
            }
        }

        let payload = value.get("payload").unwrap_or(&serde_json::Value::Null);
        // Session cwd, for resolving relative targets. Dead in the meta arm, so
        // that arm may still overwrite `project_dir`.
        let cwd = (!project_dir.is_empty()).then_some(project_dir.as_str());

        // `session_meta`/`turn_context` carry their discriminator at top level;
        // every other line declares it inside `payload`.
        let top_type = value.get("type").and_then(serde_json::Value::as_str);
        let payload_type = payload.get("type").and_then(serde_json::Value::as_str);
        let kind = match top_type {
            // `session_meta` and `turn_context` are top-level lines; `item_completed`
            // is normally nested in `event_msg`, but guard both shapes.
            Some(t @ ("session_meta" | "turn_context")) => Some(t),
            Some("item_completed") if payload.get("item").is_some() => Some("item_completed"),
            _ => payload_type,
        };

        match kind {
            Some("session_meta") | Some("turn_context") => {
                // A later turn may set a new cwd; relative targets must follow it.
                if let Some(cwd) = payload.get("cwd").and_then(serde_json::Value::as_str) {
                    project_dir = cwd.to_string();
                }
                // Some Codex builds write `id`, others `session_id`; the filename
                // fallback already yields the same UUID, but read both.
                for field in ["session_id", "id"] {
                    if let Some(id) = payload.get(field).and_then(serde_json::Value::as_str) {
                        session_id = id.to_string();
                        break;
                    }
                }
            }
            // `custom_tool_call.input` holds a JS snippet whose first argument is
            // usually the patch. `function_call` carries the same payload JSON-
            // encoded in `arguments`. Both are strings, so scan them for markers.
            Some("custom_tool_call" | "function_call" | "function_call_output") => {
                // `input`/`arguments` carry the request; `output` is the echoed
                // result of a `function_call` (a read-back, but the only record
                // when the call itself was cut short).
                for field in ["input", "arguments", "output"] {
                    if let Some(text) = payload.get(field).and_then(serde_json::Value::as_str) {
                        for path in patch_paths(text, cwd) {
                            insert(best, path, TrailKind::Written, ts, &project_dir, &session_id);
                        }
                    }
                }
            }
            Some("message")
                if payload.get("role").and_then(serde_json::Value::as_str) == Some("assistant") =>
            {
                for text in content_texts(payload) {
                    for path in text_paths(text, cwd) {
                        insert(best, path, TrailKind::Mentioned, ts, &project_dir, &session_id);
                    }
                }
            }
            Some("item_completed") => {
                let item = payload
                    .get("item")
                    .or_else(|| value.get("item"))
                    .unwrap_or(&serde_json::Value::Null);
                match item.get("type").and_then(serde_json::Value::as_str) {
                    Some("FileChange") => {
                        if let Some(changes) = item.get("changes").and_then(|c| c.as_object()) {
                            for raw in changes.keys() {
                                if let Some(path) = normalize_path(raw, cwd) {
                                    insert(
                                        best,
                                        path,
                                        TrailKind::Written,
                                        ts,
                                        &project_dir,
                                        &session_id,
                                    );
                                }
                            }
                        }
                    }
                    Some("AgentMessage") => {
                        for text in content_texts(item) {
                            for path in text_paths(text, cwd) {
                                insert(
                                    best,
                                    path,
                                    TrailKind::Mentioned,
                                    ts,
                                    &project_dir,
                                    &session_id,
                                );
                            }
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
}

/// Merge one hit, keeping the newest event (and a write over a mention).
fn insert(
    best: &mut HashMap<String, TrailItem>,
    path: String,
    kind: TrailKind,
    ts: u64,
    project_dir: &str,
    session_id: &str,
) {
    let key = path.to_lowercase();
    // A hit replaces the entry when it is newer, or equally new but a write; kind
    // itself only ever upgrades, so a later mention cannot bury a known write.
    let entry = match best.remove(&key) {
        None => TrailItem {
            exists: false,
            path,
            kind,
            timestamp: ts,
            project_dir: project_dir.to_string(),
            session_id: session_id.to_string(),
        },
        Some(old) => {
            let newer = (ts, kind) >= (old.timestamp, old.kind);
            TrailItem {
                kind: old.kind.max(kind),
                timestamp: if newer { ts } else { old.timestamp },
                // Keep the original metadata unless the new hit is newer *and*
                // actually carries a value; an empty field never erases one.
                path: old.path,
                project_dir: if newer && !project_dir.is_empty() {
                    project_dir.to_string()
                } else {
                    old.project_dir
                },
                session_id: if newer && !session_id.is_empty() {
                    session_id.to_string()
                } else {
                    old.session_id
                },
                exists: false,
            }
        }
    };
    best.insert(key, entry);
}

/// `exists()` without touching the network: a UNC path makes Windows open an SMB
/// connection (seconds per host, and an NTLM handshake to whoever answers).
/// `false` for those is preferable to a stalling scan.
fn exists_locally(path: &str) -> bool {
    if path.starts_with("\\\\") {
        return false;
    }
    Path::new(path).exists()
}

/// `content: [{type, text}]` → the text fields (string content also accepted).
/// Text of a `content` field — a plain string, or `[{text}]` items. Falls back to
/// a bare `text`/`message` field, which some item shapes use instead.
fn content_texts(node: &serde_json::Value) -> Vec<&str> {
    match node.get("content") {
        Some(serde_json::Value::String(s)) => vec![s.as_str()],
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .filter_map(|i| i.get("text").and_then(serde_json::Value::as_str))
            .collect(),
        _ => ["text", "message", "output"]
            .iter()
            .filter_map(|f| node.get(f).and_then(serde_json::Value::as_str))
            .collect(),
    }
}

/// Extract `*** Add File:` / `*** Update File:` targets from an apply_patch body.
fn patch_paths(input: &str, base: Option<&str>) -> Vec<String> {
    // The patch body often sits inside a JS string literal, so its newlines are
    // the two characters `\` `n` and quotes are `\"`. Expand those first, or the
    // `\n@@` hunk header ends up glued to the file name.
    let mut out = Vec::new();
    for marker in ["*** Add File: ", "*** Update File: ", "*** Delete File: "] {
        let mut from = 0usize;
        while let Some(rel) = input[from..].find(marker) {
            let start = from + rel + marker.len();
            let end = input[start..]
                .find("***")
                .map_or(input.len(), |e| start + e);
            let raw = cut_at_hunk(&input[start..end]).trim();
            // Prefer the literal text: a real path may itself contain `\n`
            // (`D:\new\x.md`). Only if that is unusable, expand JS escapes and take
            // the first resulting line.
            let path = normalize_path(raw, base).filter(|p| is_plausible_patch_path(p)).or_else(|| {
                let unescaped = raw.replace("\\n", "\n").replace("\\\"", "\"");
                let first = unescaped.lines().next().unwrap_or_default().trim();
                normalize_path(first, base).filter(|p| is_plausible_patch_path(p))
            });
            if let Some(path) = path {
                out.push(path);
            }
            from = end.max(start);
        }
    }
    out
}

/// Cut a raw slice at the first real newline, or at a literal `\n` that is
/// followed by hunk syntax (`+`, `-`, ` `, `@`, `*`). That keeps paths holding a
/// genuine `\n` sequence (`D:\new\x.md`) intact while dropping `\n@@` headers.
fn cut_at_hunk(s: &str) -> &str {
    let bytes = s.as_bytes();
    for i in 0..bytes.len() {
        if bytes[i] == b'\n' || bytes[i] == b'\r' {
            return &s[..i];
        }
        // Literal `\n` / `\r` from the JS wrapper. `\r` always ends the name;
        // `\n` ends it at the slice end (no hunk body follows, as after
        // `*** Delete File:`) or when hunk syntax follows, but stays when it is
        // part of the name (`D:\new\x.md`).
        if bytes[i] == b'\\' && matches!(bytes.get(i + 1), Some(b'n' | b'r')) {
            let after = bytes.get(i + 2);
            if bytes[i + 1] == b'r' || after.is_none() || matches!(after, Some(b'+' | b'-' | b' ' | b'@' | b'*')) {
                return &s[..i];
            }
        }
    }
    s
}

/// A patch target must survive as a plausible file name.
///
/// Unlike prose, a patch target is structured data: `D:\repo\Makefile` is a real
/// file with no extension, so any non-empty last segment is accepted. `@` is fine
/// inside the path (npm `@scope`, `user@host`); `cut_at_hunk` already removed the
/// `@@` header.
fn is_plausible_patch_path(path: &str) -> bool {
    !path.contains(['\n', '\r'])
        && path
            .rsplit('\\')
            .next()
            .is_some_and(|name| !name.is_empty() && !name.contains(['\n', '\r']))
}

/// Pull Windows absolute paths out of free-form prose.
fn text_paths(text: &str, base: Option<&str>) -> Vec<String> {
    // Invalid UTF-8 bytes arrive as U+FFFD; drop them so `bad<FF>.md` keeps its
    // extension instead of being cut in half.
    let cleaned = text.replace('\u{FFFD}', "");
    let text = cleaned.as_str();
    let mut out = Vec::new();
    let mut iter = text.char_indices().peekable();

    while let Some((i, c)) = iter.next() {
        let prev = text[..i].chars().next_back();
        let starts = match c {
            c if c.is_ascii_alphabetic() => {
                at_boundary(prev)
                    && text[i + 1..].starts_with(':')
                    && text[i + 2..].starts_with(['\\', '/'])
            }
            '\\' => {
                at_boundary(prev)
                    && text[i..].starts_with("\\\\")
                    && text[i + 2..]
                        .chars()
                        .next()
                        .is_some_and(|n| n.is_ascii_alphanumeric() || n == '.')
            }
            _ => false,
        };
        if !starts {
            continue;
        }

        // Walk to the end. CJK is a legal path character, but prose often runs
        // straight into a path (`D:\a\b.md保存`), so a CJK character ends the run
        // once the current segment already looks like a file name.
        let mut end = i;
        let mut segment_has_dot = false;
        // `:` stops the run (so `D:\a\b.md:12` loses the line number and
        // `b.md#frag` loses the anchor), except the one right after the drive.
        let drive_colon = i + 1;
        while let Some(&(j, ch)) = iter.peek() {
            if ch == ':' && j == drive_colon {
                end = j + 1;
                iter.next();
                continue;
            }
            if is_stop(ch) || (!ch.is_ascii() && segment_has_dot) {
                break;
            }
            segment_has_dot = match ch {
                '\\' | '/' => false,
                '.' => true,
                _ => segment_has_dot,
            };
            end = j + ch.len_utf8();
            iter.next();
        }

        let raw = text[i..end].trim_end_matches(['.', ':', ',']);
        if let Some(path) = normalize_path(raw, base) {
            if looks_like_file(&path) {
                out.push(path);
            }
        }
    }
    out
}

/// A path may start right after a Chinese character (`修改了D:\a\b.md`), so only
/// ASCII word characters and separators count as "glued to the left".
fn at_boundary(prev: Option<char>) -> bool {
    prev.is_none_or(|p| !(p.is_ascii_alphanumeric() || p == '_' || p == '\\' || p == '/'))
}

fn is_stop(c: char) -> bool {
    matches!(
        c,
        ' ' | '\t'
            | '\r'
            | '\n'
            | '"'
            | '\''
            | '`'
            | '('
            | ')'
            | '['
            | ']'
            | '{'
            | '}'
            | ','
            | ';'
            | '|'
            | '<'
            | '>'
            | '*'
            | '?'
            | ':'
            | '#'
            | '='
            | '、'
            | '，'
            | '。'
            | '：'
            | '！'
            | '？'
            | '；'
            | '（'
            | '）'
            | '「'
            | '」'
            | '《'
            | '》'
    )
}

/// Require a real-looking target: a trailing `\`, or a last segment with a dot.
fn looks_like_file(path: &str) -> bool {
    if path.ends_with('\\') {
        return path.len() > 3;
    }
    let name = path.rsplit('\\').next().unwrap_or_default();
    name.chars().count() > 1 && name.contains('.')
}

/// Normalize a path to absolute form: strip `file://`, unify separators, drop
/// trailing punctuation. A relative path is resolved against `base` (the session
/// cwd) — patch targets are frequently relative — and dropped if there is none.
fn normalize_path(raw: &str, base: Option<&str>) -> Option<String> {
    let mut s = raw.trim().trim_matches('"');
    if let Some(rest) = s.strip_prefix("file://") {
        // `file:///D:/x` → `D:/x`; `file://D:/x` → `D:/x`; `file://host/share/x`
        // → `\\host\share\x`.
        s = match rest.strip_prefix('/') {
            Some(drive) => drive,
            // A single-letter host is a drive, not a machine name.
            None if rest.as_bytes().get(1) == Some(&b':') => rest,
            None => return normalize_path(&format!("\\\\{rest}"), None),
        };
    }
    let s = s.trim().trim_end_matches(['.', ',', ':']);
    let s = s.replace('/', "\\");
    if s.is_empty() || s.contains('\u{0}') {
        return None;
    }
    if is_absolute(&s) {
        return Some(s);
    }
    let base = base.filter(|b| is_absolute(b))?;
    Some(join_relative(base, &s))
}

fn is_absolute(path: &str) -> bool {
    let bytes = path.as_bytes();
    let drive = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && bytes[2] == b'\\';
    drive || path.starts_with("\\\\")
}

/// Join `rel` onto `base`, honouring `.` / `..` and keeping drive-relative
/// segments (`D:x`) as written.
fn join_relative(base: &str, rel: &str) -> String {
    let mut parts: Vec<&str> = base.split('\\').filter(|p| !p.is_empty()).collect();
    for seg in rel.split('\\') {
        match seg {
            "" | "." => {}
            ".." => {
                if parts.len() > 1 {
                    parts.pop();
                }
            }
            other => parts.push(other),
        }
    }
    let joined = parts.join("\\");
    if base.starts_with("\\\\") {
        format!("\\\\{joined}")
    } else {
        joined
    }
}

fn session_id_from_name(file: &Path) -> String {
    let name = file
        .file_stem()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    // rollout-<date>-<time>-<uuid> → <uuid> (the last five dash segments).
    let parts: Vec<&str> = name.split('-').collect();
    if parts.len() >= 5 && parts[0] == "rollout" {
        return parts[parts.len() - 5..].join("-");
    }
    name.to_string()
}

/// Convert a `SystemTime` to epoch millis (pre-1970 clamps to 0).
fn to_millis(t: SystemTime) -> Option<u64> {
    t.duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as u64)
}

/// Parse `2026-10-20T13:38:49.156Z` (or with an offset) to epoch millis.
fn parse_rfc3339_millis(s: &str) -> Option<u64> {
    let bytes = s.as_bytes();
    if bytes.len() < 19 || bytes[4] != b'-' || bytes[10] != b'T' {
        return None;
    }
    let year: i64 = s.get(0..4)?.parse().ok()?;
    let month: u32 = s.get(5..7)?.parse().ok()?;
    let day: u32 = s.get(8..10)?.parse().ok()?;
    let hour: u64 = s.get(11..13)?.parse().ok()?;
    let minute: u64 = s.get(14..16)?.parse().ok()?;
    let second: u64 = s.get(17..19)?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 || second > 60
    {
        return None;
    }

    let mut rest = &s[19..];
    let mut millis: u64 = 0;
    if let Some(frac) = rest.strip_prefix('.') {
        let digits: String = frac.chars().take_while(char::is_ascii_digit).collect();
        if !digits.is_empty() {
            let mut padded = digits.clone();
            padded.truncate(3);
            while padded.len() < 3 {
                padded.push('0');
            }
            millis = padded.parse().ok()?;
        }
        rest = &frac[digits.len()..];
    }
    // A numeric offset must be applied, not dropped: the value feeds ordering,
    // deduplication and the `since` cut-off.
    let mut offset_secs: i64 = 0;
    match rest {
        "" | "Z" | "z" => {}
        _ => {
            let sign = match rest.as_bytes().first() {
                Some(b'+') => 1,
                Some(b'-') => -1,
                _ => return None,
            };
            let digits = rest[1..].replace(':', "");
            if digits.len() != 4 || !digits.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            let oh: i64 = digits[0..2].parse().ok()?;
            let om: i64 = digits[2..4].parse().ok()?;
            if oh > 23 || om > 59 {
                return None;
            }
            offset_secs = sign * (oh * 3_600 + om * 60);
        }
    }

    let days = days_from_civil(year, month, day);
    let secs = days * 86_400 + (hour * 3_600 + minute * 60 + second) as i64 - offset_secs;
    u64::try_from(secs).ok().map(|s| s * 1_000 + millis)
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Hinnant's algorithm).
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let m = i64::from(month);
    let d = i64::from(day);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Convenience helper: `SystemTime` from epoch millis.
pub fn from_millis(ms: u64) -> SystemTime {
    UNIX_EPOCH + Duration::from_millis(ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_patch_targets() {
        let input = "*** Begin Patch\n*** Add File: D:/a/b.py\n+hi\n*** Update File: C:\\x\\y.rs\n@@\n-old\n+new\n*** End Patch";
        assert_eq!(patch_paths(input, None), vec!["D:\\a\\b.py", "C:\\x\\y.rs"]);
    }

    #[test]
    fn strips_escaped_newline_before_hunk_header() {
        // Real Codex logs embed the patch in a JS string literal.
        let input = "text(await tools.apply_patch(\"*** Begin Patch\\n*** Update File: D:/a/r.md\\n@@\\n-x\\n+y\\n*** End Patch\"));";
        assert_eq!(patch_paths(input, None), vec!["D:\\a\\r.md"]);
    }

    #[test]
    fn keeps_genuine_backslash_n_in_file_name() {
        let input = "*** Update File: D:/a\\new\\x.md\n@@\n";
        assert_eq!(patch_paths(input, None), vec!["D:\\a\\new\\x.md"]);
    }

    #[test]
    fn ignores_related_file_and_encoded_bodies() {
        let input = "*** Add File: D:/a/c.md\n*** End Patch";
        assert_eq!(patch_paths(input, None), vec!["D:\\a\\c.md"]);
    }

    #[test]
    fn finds_paths_in_prose_only_with_boundaries() {
        let text = "見 D:\\work\\x.md 與 `C:/q/y.json`, 但 xD:\\no 不算, 還有 \\\\srv\\share\\z.ps1。";
        assert_eq!(
            text_paths(text, None),
            vec!["D:\\work\\x.md", "C:\\q\\y.json", "\\\\srv\\share\\z.ps1"]
        );
    }

    #[test]
    fn skips_bare_drive_and_folder_only_paths() {
        assert_eq!(text_paths("C: 和 D:\\folder 和 D:\\a.md", None), vec!["D:\\a.md"]);
    }

    #[test]
    fn parses_timestamps() {
        assert_eq!(parse_rfc3339_millis("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            parse_rfc3339_millis("2026-10-20T13:38:49.156Z"),
            Some(1_792_503_529_156)
        );
        assert_eq!(parse_rfc3339_millis("2026-13-01T00:00:00Z"), None);
        assert_eq!(parse_rfc3339_millis("nope"), None);
    }

    #[test]
    fn applies_timezone_offset_instead_of_dropping_it() {
        let utc = parse_rfc3339_millis("2026-10-20T13:38:49Z").unwrap();
        let plus8 = parse_rfc3339_millis("2026-10-20T21:38:49+08:00").unwrap();
        assert_eq!(utc, plus8);
        assert_eq!(
            parse_rfc3339_millis("2026-10-20T13:38:49-02:30").unwrap(),
            utc + 9_000_000
        );
        assert_eq!(
            parse_rfc3339_millis("2026-10-20T13:38:49+0800").unwrap(),
            utc - 28_800_000
        );
        assert_eq!(parse_rfc3339_millis("2026-10-20T13:38:49+99:00"), None);
    }

    #[test]
    fn cjk_after_a_file_name_stops_the_path() {
        assert_eq!(text_paths("改了 D:\\a\\b.md保存", None), vec!["D:\\a\\b.md"]);
        assert_eq!(text_paths("看 D:\\a\\b.md，然後", None), vec!["D:\\a\\b.md"]);
        // A CJK segment without an extension yet must not be cut short.
        assert_eq!(text_paths("在 D:\\資料\\x.md 裡", None), vec!["D:\\資料\\x.md"]);
    }

    #[test]
    fn markup_around_a_path_is_not_swallowed() {
        assert_eq!(text_paths("**D:\\a\\b.md**", None), vec!["D:\\a\\b.md"]);
        assert_eq!(text_paths("`D:\\a\\b.md`", None), vec!["D:\\a\\b.md"]);
    }

    #[test]
    fn path_glued_to_a_chinese_character_is_found() {
        assert_eq!(
            text_paths("修改了D:\\a\\b.md", None),
            vec!["D:\\a\\b.md"]
        );
        assert_eq!(text_paths("見D:\\a\\b.md。", None), vec!["D:\\a\\b.md"]);
        // Still glued when the left neighbour is an ASCII word character.
        assert!(text_paths("xD:\\a\\b.md", None).is_empty());
    }

    #[test]
    fn relative_targets_resolve_against_the_session_cwd() {
        let input = "*** Add File: src/lib.rs\n*** Update File: ../other/x.py\n";
        assert_eq!(
            patch_paths(input, Some("D:\\proj\\sub")),
            vec!["D:\\proj\\sub\\src\\lib.rs", "D:\\proj\\other\\x.py"]
        );
        // Without a base a relative target is dropped.
        assert!(patch_paths(input, None).is_empty());
    }

    #[test]
    fn relative_resolution_skips_dot_segments() {
        let input = "*** Update File: .\\a\\.\\b.md\n";
        assert_eq!(
            patch_paths(input, Some("C:\\w")),
            vec!["C:\\w\\a\\b.md"]
        );
    }

    #[test]
    fn file_url_with_a_drive_is_not_a_host() {
        assert_eq!(
            normalize_path("file://D:/x.md", None).as_deref(),
            Some("D:\\x.md")
        );
    }

    #[test]
    fn file_url_with_host_becomes_unc() {
        assert_eq!(
            normalize_path("file://srv/share/x.md", None).as_deref(),
            Some("\\\\srv\\share\\x.md")
        );
    }

    #[test]
    fn trailing_escaped_newline_is_cut() {
        // `*** Delete File:` has no hunk body, so the escape is the last thing.
        assert_eq!(
            patch_paths("*** Delete File: D:/a/gone.md\\n*** End Patch", None),
            vec!["D:\\a\\gone.md"]
        );
        // Escaped CRLF must not leave a `\r` on the name.
        assert_eq!(
            patch_paths("*** Update File: D:/a/b.md\\r\\n@@\\n-x\\n+y\\n", None),
            vec!["D:\\a\\b.md"]
        );
    }

    #[test]
    fn extensionless_patch_target_is_kept() {
        assert_eq!(
            patch_paths("*** Add File: D:/repo/Makefile\n", None),
            vec!["D:\\repo\\Makefile"]
        );
    }

    #[test]
    fn prose_path_drops_line_numbers_and_anchors() {
        assert_eq!(text_paths("見 D:\\a\\b.rs:12 行", None), vec!["D:\\a\\b.rs"]);
        assert_eq!(text_paths("D:\\a\\b.html#frag", None), vec!["D:\\a\\b.html"]);
    }

    #[test]
    fn python_style_function_call_arguments_are_scanned() {
        let args = "*** Begin Patch\\n*** Add File: D:/a/f.py\\n*** End Patch";
        assert_eq!(patch_paths(args, None), vec!["D:\\a\\f.py"]);
    }

    #[test]
    fn function_call_output_field_carries_the_patch() {
        let payload = serde_json::json!({
            "type": "function_call_output",
            "output": "Success. Updated: D:/a/from_output.md"
        });
        assert_eq!(
            content_texts(&payload),
            vec!["Success. Updated: D:/a/from_output.md"]
        );
    }

    #[test]
    fn delete_file_counts_as_a_target() {
        assert_eq!(
            patch_paths("*** Delete File: D:/a/gone.md\n", None),
            vec!["D:\\a\\gone.md"]
        );
    }

    #[test]
    fn scoped_package_path_is_kept() {
        let input = "*** Update File: D:/repo/node_modules/@scope/pkg/index.js\n@@\n";
        assert_eq!(
            patch_paths(input, None),
            vec!["D:\\repo\\node_modules\\@scope\\pkg\\index.js"]
        );
    }

    #[test]
    fn unc_paths_skip_the_exists_check() {
        assert!(!exists_locally("\\\\srv\\share\\x.md"));
    }

    #[test]
    fn over_long_line_is_skipped_not_buffered() {
        // Per-process path so concurrent runs cannot overwrite each other.
        let dir = std::env::temp_dir().join(format!(
            "ai_trail_codex_longline_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("rollout-long.jsonl");
        let mut body = String::from(
            "{\"timestamp\":\"2026-10-20T00:00:00Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"",
        );
        body.push_str(&"x".repeat(MAX_LINE_BYTES + 10));
        body.push_str("\"}]}}\n");
        body.push_str("{\"timestamp\":\"2026-10-20T00:00:01Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"custom_tool_call\",\"input\":\"*** Add File: D:/a/after.md\\n\"}}\n");
        std::fs::write(&file, body).unwrap();

        let mut best = HashMap::new();
        scan_file(&file, None, &mut best);
        assert!(best.keys().any(|k| k.ends_with("after.md")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn normalizes_file_urls_and_separators() {
        assert_eq!(
            normalize_path("file:///D:/a/b.png", None).as_deref(),
            Some("D:\\a\\b.png")
        );
        assert_eq!(normalize_path("D:/a/b.png", None).as_deref(), Some("D:\\a\\b.png"));
        assert_eq!(normalize_path("relative\\x.md", None), None);
    }

    #[test]
    fn session_id_falls_back_to_stem() {
        let p = Path::new("rollout-2026-10-20T21-38-46-01a15989-3570-7ae0-9ace-c529074b947e.jsonl");
        assert!(!session_id_from_name(p).is_empty());
    }
}

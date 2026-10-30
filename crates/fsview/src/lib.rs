//! fsview — filesystem browsing primitives for the 3jsfloder desktop app.
//!
//! Four small, allocation-conscious entry points: [`classify`], [`list_dir`],
//! [`read_head`], [`is_ai_project`]. No whole-file reads, no panics on I/O
//! errors — every failure comes back as data.
//!
//! Everything takes `&Path`; the `*_str` twins take `&str` so a Tauri command
//! body stays a one-liner (`list_dir_str(&path, &filter)`), because
//! `impl AsRef<Path>` arguments do not survive the command macro.
//!
//! Paths come back as lossy UTF-8 strings. A Windows path with an unpaired
//! surrogate (or a Unix path with invalid UTF-8) will list but may not reopen
//! from its string form.
//!
//! Note: `classify` opens the file, so on a FIFO it can block until the writer
//! closes; `list_dir` is immune because it only classifies `is_file()` entries.

use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// How many bytes of a file are sniffed to decide whether it is text.
const SNIFF_BYTES: usize = 8 * 1024;

/// Above this share of non-text bytes in the sniff window a file is Binary.
const NON_TEXT_RATIO: f64 = 0.30;

/// Hard ceiling on [`read_head`], so a stray `usize::MAX` cannot try to
/// allocate the whole address space. 32 MiB is far past any preview pane.
pub const MAX_HEAD_BYTES: usize = 32 * 1024 * 1024;

// ---------------------------------------------------------------------------
// FileKind
// ---------------------------------------------------------------------------

/// Broad category of a filesystem entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileKind {
    Markdown,
    Text,
    Code,
    Json,
    Html,
    Table,
    Image,
    Pdf,
    Binary,
    Other,
}

impl FileKind {
    /// True for kinds the viewer can render as text.
    pub fn is_textual(self) -> bool {
        matches!(
            self,
            FileKind::Markdown
                | FileKind::Text
                | FileKind::Code
                | FileKind::Json
                | FileKind::Html
                | FileKind::Table
        )
    }
}

fn kind_from_ext(ext: &str) -> Option<FileKind> {
    let k = match ext {
        "md" | "markdown" => FileKind::Markdown,
        "txt" | "log" => FileKind::Text,
        "py" | "js" | "ts" | "rs" | "css" | "sh" | "ps1" | "bat" => FileKind::Code,
        "json" | "jsonl" | "yaml" | "yml" | "toml" | "ini" | "cfg" => FileKind::Json,
        "html" | "htm" | "xml" | "svg" => FileKind::Html,
        "csv" | "tsv" | "xlsx" | "xls" => FileKind::Table,
        "png" | "jpg" | "jpeg" | "gif" | "webp" => FileKind::Image,
        "pdf" => FileKind::Pdf,
        _ => return None,
    };
    Some(k)
}

/// Extensions that are container/binary formats by construction. These skip the
/// text sniff, which would otherwise call a ZIP-based `.xlsx` (or an OLE2
/// `.xls`) "binary" even though the table viewer handles it.
const OPAQUE_EXTS: [&str; 7] = ["png", "jpg", "jpeg", "gif", "webp", "pdf", "xlsx"];

fn is_opaque_ext(ext: &str) -> bool {
    OPAQUE_EXTS.contains(&ext) || ext == "xls"
}

fn ext_of(path: &Path) -> String {
    path.extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

/// Classify a path by extension, falling back to sniffing the first 8 KiB.
///
/// Known text extensions are still sniffed, so a `.txt` full of NULs reports
/// `Binary`. Opaque containers (images, PDF, xlsx/xls) short-circuit unread. A
/// directory keeps `Other`; an unreadable file keeps its extension kind; an
/// unknown extension becomes `Other` or `Binary` per the sniff.
pub fn classify(path: &Path) -> FileKind {
    if path.is_dir() {
        return FileKind::Other;
    }
    let ext = ext_of(path);

    if let Some(kind) = kind_from_ext(&ext) {
        if is_opaque_ext(&ext) {
            return kind;
        }
        return match sniff(path) {
            Some(true) => kind,
            Some(false) => FileKind::Binary,
            None => kind,
        };
    }

    match sniff(path) {
        Some(true) => FileKind::Other,
        Some(false) => FileKind::Binary,
        None => FileKind::Other,
    }
}

/// [`classify`] for a `&str` path (Tauri command bodies).
pub fn classify_str(path: &str) -> FileKind {
    classify(Path::new(path))
}

/// Extension-only classify: no file is opened.
///
/// Unknown or missing extensions come back as `Other`, so this is cheap enough
/// for a whole large or network directory. Use [`classify`] when the
/// binary/text distinction actually matters.
pub fn classify_fast(path: &Path) -> FileKind {
    kind_from_ext(&ext_of(path)).unwrap_or(FileKind::Other)
}

/// `Some(true)` = looks textual, `Some(false)` = binary, `None` = unreadable.
fn sniff(path: &Path) -> Option<bool> {
    let mut buf = [0u8; SNIFF_BYTES];
    let mut f = File::open(path).ok()?;
    let mut n = 0usize;
    while n < buf.len() {
        match f.read(&mut buf[n..]) {
            Ok(0) => break,
            Ok(k) => n += k,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    if n == 0 {
        return Some(true); // empty file: harmless to treat as text
    }
    let head = &buf[..n];
    if head.starts_with(&[0xFF, 0xFE]) || head.starts_with(&[0xFE, 0xFF]) {
        return Some(true); // UTF-16 with BOM: NULs are expected
    }
    if head.contains(&0) {
        return Some(false);
    }
    let non_text = head.iter().filter(|b| is_non_text(**b)).count();
    if (non_text as f64 / n as f64) > NON_TEXT_RATIO {
        return Some(false);
    }
    // Invalid UTF-8 that is not merely cut short at the window edge is a strong
    // binary signal (compressed data, media).
    match std::str::from_utf8(head) {
        Ok(_) => Some(true),
        Err(e) => Some(e.error_len().is_none()),
    }
}

fn is_non_text(b: u8) -> bool {
    // Control characters other than tab/LF/CR/FF/BS/VT, plus 0x7F (DEL).
    (b < 0x20 && !matches!(b, b'\t' | b'\n' | b'\r' | 0x0C | 0x08 | 0x0B)) || b == 0x7F
}

// ---------------------------------------------------------------------------
// ExtFilter / list_dir
// ---------------------------------------------------------------------------

/// Which files [`list_dir`] should return.
///
/// Serialises as `{"mode":"only","exts":["md"]}` / `{"mode":"human_readable"}`
/// / `{"mode":"all"}` so the frontend can build one.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", content = "exts", rename_all = "snake_case")]
pub enum ExtFilter {
    /// Only these extensions. Case-insensitive; `md`, `.md` and `*.md` all work.
    /// An empty list means "accept everything".
    Only(Vec<String>),
    /// Only kinds a human can read in the viewer (text kinds, images, PDFs).
    #[default]
    HumanReadable,
    /// Everything, binaries included.
    All,
}

impl ExtFilter {
    fn accepts(&self, ext: &str, kind: FileKind) -> bool {
        match self {
            ExtFilter::All => true,
            ExtFilter::HumanReadable => {
                kind.is_textual() || kind == FileKind::Image || kind == FileKind::Pdf
            }
            ExtFilter::Only(list) => {
                list.is_empty() || list.iter().any(|want| normalise_ext(want) == ext)
            }
        }
    }
}

fn normalise_ext(want: &str) -> String {
    want.trim()
        .trim_start_matches("*.")
        .trim_start_matches('.')
        .to_ascii_lowercase()
}

/// A subdirectory row.
#[derive(Debug, Clone, Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    /// Seconds since the Unix epoch; `None` when unknown.
    pub mtime: Option<i64>,
    pub has_children: bool,
}

/// A file row.
#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub mtime: Option<i64>,
    pub ext: String,
    pub kind: FileKind,
}

/// Result of [`list_dir`].
///
/// `error` is set when the directory could not be opened (both vectors are then
/// empty) and, on a partial listing, carries the first per-entry failure while
/// the rows gathered so far are still returned.
#[derive(Debug, Clone, Serialize)]
pub struct DirListing {
    pub path: String,
    pub dirs: Vec<DirEntry>,
    pub files: Vec<FileEntry>,
    pub error: Option<String>,
    /// Entries dropped because metadata or the read failed — never silent.
    pub skipped: u32,
}

fn mtime_secs(md: &std::fs::Metadata) -> Option<i64> {
    let t = md.modified().ok()?;
    Some(match t.duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => d.as_secs() as i64,
        Err(e) => -(e.duration().as_secs() as i64),
    })
}

#[cfg(windows)]
fn is_hidden_or_system(name: &str, md: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const HIDDEN: u32 = 0x2;
    const SYSTEM: u32 = 0x4;
    name.starts_with('.') || md.file_attributes() & (HIDDEN | SYSTEM) != 0
}

#[cfg(not(windows))]
fn is_hidden_or_system(name: &str, _md: &std::fs::Metadata) -> bool {
    name.starts_with('.')
}

/// True for an OneDrive-style placeholder whose data is not local. Reading it
/// would hydrate the file, so the lister avoids sniffing these.
#[cfg(windows)]
fn is_cloud_placeholder(md: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const RECALL_ON_DATA_ACCESS: u32 = 0x400000;
    md.file_attributes() & RECALL_ON_DATA_ACCESS != 0
}

#[cfg(not(windows))]
fn is_cloud_placeholder(_md: &std::fs::Metadata) -> bool {
    false
}

fn has_children(dir: &Path) -> bool {
    // Hidden-only children still count: the frontend needs its chevron.
    match std::fs::read_dir(dir) {
        Ok(mut it) => it.next().is_some(),
        Err(_) => false,
    }
}

/// List one directory level, sorted case-insensitively by name.
///
/// Hidden and system entries are skipped. Permission errors never panic: an
/// unreadable entry is counted in `skipped`, an unreadable directory fills
/// `error` and returns both lists empty.
pub fn list_dir(path: &Path, filter: &ExtFilter) -> DirListing {
    let mut listing = DirListing {
        path: path.to_string_lossy().into_owned(),
        dirs: Vec::new(),
        files: Vec::new(),
        error: None,
        skipped: 0,
    };

    let reader = match std::fs::read_dir(path) {
        Ok(r) => r,
        Err(e) => {
            listing.error = Some(format!("{}: {e}", path.display()));
            return listing;
        }
    };

    for entry in reader {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                // SMB drop mid-listing: keep what we have, report the first.
                listing.skipped += 1;
                listing.error.get_or_insert_with(|| e.to_string());
                continue;
            }
        };
        let md = match entry.metadata() {
            Ok(m) => m,
            Err(e) => {
                listing.skipped += 1;
                listing
                    .error
                    .get_or_insert_with(|| format!("{}: {e}", entry.path().display()));
                continue;
            }
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_hidden_or_system(&name, &md) {
            continue;
        }

        let full = entry.path();
        // A junction or directory symlink reports `is_dir() == false` (Rust
        // lumps reparse points under `is_symlink`), so resolve it explicitly.
        // A broken link resolves to nothing and is counted, not dropped.
        let (is_dir, is_file) = if md.is_symlink() {
            match std::fs::metadata(&full) {
                Ok(target) => (target.is_dir(), target.is_file()),
                Err(e) => {
                    listing.skipped += 1;
                    listing
                        .error
                        .get_or_insert_with(|| format!("{}: {e}", full.display()));
                    continue;
                }
            }
        } else {
            (md.is_dir(), md.is_file())
        };

        if is_dir {
            listing.dirs.push(DirEntry {
                name,
                path: full.to_string_lossy().into_owned(),
                mtime: mtime_secs(&md),
                has_children: has_children(&full),
            });
            continue;
        }
        if !is_file {
            continue; // device, socket
        }

        let ext = ext_of(&full);
        // Known extensions need no sniff; unknown ones do. A cloud placeholder
        // is never sniffed because that would hydrate the file.
        let known = kind_from_ext(&ext).is_some();
        let kind = if known || is_cloud_placeholder(&md) {
            classify_fast(&full)
        } else {
            classify(&full)
        };
        if !filter.accepts(&ext, kind) {
            continue;
        }
        listing.files.push(FileEntry {
            name,
            path: full.to_string_lossy().into_owned(),
            size: md.len(),
            mtime: mtime_secs(&md),
            ext,
            kind,
        });
    }

    // Lower-cased name first; the original breaks ties so order is stable.
    listing
        .dirs
        .sort_by_key(|a| (a.name.to_lowercase(), a.name.clone()));
    listing
        .files
        .sort_by_key(|a| (a.name.to_lowercase(), a.name.clone()));
    listing
}

/// [`list_dir`] for a `&str` path (Tauri command bodies).
pub fn list_dir_str(path: &str, filter: &ExtFilter) -> DirListing {
    list_dir(Path::new(path), filter)
}

// ---------------------------------------------------------------------------
// read_head
// ---------------------------------------------------------------------------

/// Text preview of a file's first bytes.
#[derive(Debug, Clone, Serialize)]
pub struct Head {
    /// Decoded text, never cut inside a character.
    pub text: String,
    /// True when the file continues past what was returned.
    pub truncated: bool,
    /// `utf-8`, `utf-8-bom`, `utf-16le`, `utf-16be`, `utf-32le`, `utf-32be` or
    /// `binary`. A BOM is stripped from `text`.
    pub encoding: &'static str,
}

/// Read at most `max_bytes` from the start of a file, capped at
/// [`MAX_HEAD_BYTES`].
///
/// The returned text never ends mid-character: an incomplete trailing UTF-8
/// sequence, an odd trailing UTF-16 byte or a lone surrogate is dropped and
/// `truncated` is set, so `text` never carries more than `max_bytes` of
/// payload. Content invalid in every recognised encoding comes back as
/// `binary`.
pub fn read_head(path: &Path, max_bytes: usize) -> std::io::Result<Head> {
    let max_bytes = max_bytes.min(MAX_HEAD_BYTES);
    let mut f = File::open(path)?;
    let size = f.metadata()?.len();

    let mut raw = vec![0u8; max_bytes];
    let mut n = 0usize;
    while n < raw.len() {
        match f.read(&mut raw[n..]) {
            Ok(0) => break,
            Ok(k) => n += k,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    raw.truncate(n);

    let (text, used, encoding) = if raw.starts_with(&[0xFF, 0xFE, 0, 0]) {
        let (t, u) = decode_utf32(&raw[4..], true, max_bytes);
        (t, u + 4, "utf-32le")
    } else if raw.starts_with(&[0, 0, 0xFE, 0xFF]) {
        let (t, u) = decode_utf32(&raw[4..], false, max_bytes);
        (t, u + 4, "utf-32be")
    } else if raw.starts_with(&[0xFF, 0xFE]) || raw.starts_with(&[0xFE, 0xFF]) {
        // A UTF-32LE BOM starts with the UTF-16LE one, so it is tested first.
        let be = raw.starts_with(&[0xFE, 0xFF]);
        let (t, u) = decode_utf16(&raw[2..], be, max_bytes);
        (t, u + 2, if be { "utf-16be" } else { "utf-16le" })
    } else if raw.starts_with(&[0xEF, 0xBB, 0xBF]) {
        let (t, u, _) = decode_utf8(&raw[3..], max_bytes);
        (t, u + 3, "utf-8-bom")
    } else if let Some(be) = guess_bomless_utf16(&raw) {
        // BOM-less UTF-16: NULs everywhere, but they line up on one parity. A
        // naive UTF-8 decode would hand back "h i " soup.
        let (t, u) = decode_utf16(&raw, be, max_bytes);
        (t, u, if be { "utf-16be" } else { "utf-16le" })
    } else {
        decode_utf8(&raw, max_bytes)
    };

    Ok(Head {
        text,
        truncated: size > used as u64,
        encoding,
    })
}

/// [`read_head`] for a `&str` path (Tauri command bodies).
pub fn read_head_str(path: &str, max_bytes: usize) -> std::io::Result<Head> {
    read_head(Path::new(path), max_bytes)
}

/// Detect text that is UTF-16 without a BOM.
///
/// Requires a decent sample, a high NUL share, and the NULs concentrated on one
/// byte parity — ASCII-ish UTF-16 puts them all on the same one.
fn guess_bomless_utf16(raw: &[u8]) -> Option<bool> {
    if raw.len() < 16 {
        return None;
    }
    let sample = &raw[..raw.len().min(4096) & !1];
    let nul_at_even = sample.iter().step_by(2).filter(|b| **b == 0).count();
    let nul_at_odd = sample.iter().skip(1).step_by(2).filter(|b| **b == 0).count();
    let pairs = sample.len() / 2;
    let total_nul = nul_at_even + nul_at_odd;
    if (total_nul as f64) < 0.20 * (pairs as f64) {
        return None;
    }
    // Heavy NULs on the high byte = little endian; on the low byte = big endian.
    if nul_at_odd * 4 >= pairs * 3 {
        Some(false)
    } else if nul_at_even * 4 >= pairs * 3 {
        Some(true)
    } else {
        None
    }
}

fn decode_utf8(body: &[u8], max_bytes: usize) -> (String, usize, &'static str) {
    let cap = body.len().min(max_bytes);
    match std::str::from_utf8(&body[..cap]) {
        Ok(_) => (
            String::from_utf8_lossy(&body[..cap]).into_owned(),
            cap,
            "utf-8",
        ),
        // `None`: the cut landed inside a multi-byte sequence — drop the stump.
        Err(e) if e.error_len().is_none() => {
            let valid = e.valid_up_to();
            (
                String::from_utf8_lossy(&body[..valid]).into_owned(),
                valid,
                "utf-8",
            )
        }
        // `Some`: a genuinely invalid byte, so this is not UTF-8 at all.
        Err(_) => (
            String::from_utf8_lossy(&body[..cap]).into_owned(),
            cap,
            "binary",
        ),
    }
}

fn decode_utf16(body: &[u8], be: bool, max_bytes: usize) -> (String, usize) {
    // Whole code units only, never more than `max_bytes` of payload — an odd
    // `max_bytes` therefore costs one payload byte, which is harmless.
    let cap = body.len().min(max_bytes) & !1;
    let mut units: Vec<u16> = body[..cap]
        .chunks_exact(2)
        .map(|c| {
            if be {
                u16::from_be_bytes([c[0], c[1]])
            } else {
                u16::from_le_bytes([c[0], c[1]])
            }
        })
        .collect();
    // A high surrogate dangling at the cut means we stopped mid-character.
    if matches!(units.last(), Some(u) if (0xD800..0xDC00).contains(u)) {
        units.pop();
    }
    let used = units.len() * 2;
    (String::from_utf16_lossy(&units), used)
}

fn decode_utf32(body: &[u8], le: bool, max_bytes: usize) -> (String, usize) {
    let cap = body.len().min(max_bytes) & !3;
    let mut out = String::with_capacity(cap / 2);
    for c in body[..cap].chunks_exact(4) {
        let v = if le {
            u32::from_le_bytes([c[0], c[1], c[2], c[3]])
        } else {
            u32::from_be_bytes([c[0], c[1], c[2], c[3]])
        };
        out.push(char::from_u32(v).unwrap_or('\u{FFFD}'));
    }
    (out, cap)
}

/// Read a byte window at `offset` — the paging primitive behind scrolling
/// previews. Returns fewer bytes near EOF, never the whole file.
pub fn read_at(path: &Path, offset: u64, len: usize) -> std::io::Result<Vec<u8>> {
    let mut f = File::open(path)?;
    f.seek(SeekFrom::Start(offset))?;
    let mut buf = vec![0u8; len];
    let mut n = 0;
    while n < len {
        match f.read(&mut buf[n..]) {
            Ok(0) => break,
            Ok(k) => n += k,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    buf.truncate(n);
    Ok(buf)
}

// ---------------------------------------------------------------------------
// is_ai_project
// ---------------------------------------------------------------------------

const AI_MARKERS: [&str; 5] = ["CLAUDE.md", "AGENTS.md", "GEMINI.md", ".claude", ".codex"];

/// Heuristic: does this directory look like a project worked on by an AI agent?
///
/// Case-insensitive marker match on the immediate children only; an unreadable
/// directory returns `false`.
pub fn is_ai_project(dir: &Path) -> bool {
    let reader = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return false,
    };
    reader.flatten().any(|entry| match entry.file_name().to_str() {
        // No String allocation on the hot path.
        Some(name) => AI_MARKERS.iter().any(|m| name.eq_ignore_ascii_case(m)),
        None => {
            let name = entry.file_name().to_string_lossy().into_owned();
            AI_MARKERS.iter().any(|m| name.eq_ignore_ascii_case(m))
        }
    })
}

/// [`is_ai_project`] for a `&str` path (Tauri command bodies).
pub fn is_ai_project_str(dir: &str) -> bool {
    is_ai_project(Path::new(dir))
}

/// Parent of a path, `None` at a root.
///
/// A bare `"foo"` has an empty parent, which `File::open("")` cannot open, so
/// that case maps to the current directory instead.
pub fn parent_of(path: &Path) -> Option<PathBuf> {
    match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => Some(p.to_path_buf()),
        Some(_) => Some(PathBuf::from(".")),
        None => None,
    }
}

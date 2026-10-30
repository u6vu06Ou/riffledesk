//! Incremental full-text file index backed by SQLite FTS5 with the `trigram`
//! tokenizer (substring search, including CJK).
//!
//! See `README.md` for the public API.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Take};
use std::path::{Path, PathBuf};
use std::time::Instant;

use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection};
use serde::{Serialize, Serializer};

/// Files larger than this are truncated to this many bytes before indexing.
pub const MAX_INDEX_BYTES: usize = 2 * 1024 * 1024;

/// Characters of context kept on each side of a match inside a snippet.
const SNIPPET_RADIUS: usize = 40;
/// Maximum snippets per hit.
const MAX_SNIPPETS: usize = 3;
/// Schema version stored in `PRAGMA user_version`.
const SCHEMA_VERSION: i64 = 1;
/// Rows written before the FTS segments are merged (`optimize` is a full
/// merge, so doing it after every small run degrades incremental updates).
const OPTIMIZE_EVERY_ROWS: usize = 2_000;
/// …or this long since the last merge, whichever comes first.
const OPTIMIZE_EVERY_SECS: u64 = 300;
/// Query terms honoured per search. Every term costs a `MATCH` fragment or
/// three bound parameters, and `SQLITE_MAX_VARIABLE_NUMBER` is 32766.
const MAX_TERMS: usize = 64;
/// Changed files per write transaction. Small enough that a big first build
/// releases the write lock regularly, large enough to keep fsyncs amortised.
const COMMIT_EVERY_FILES: usize = 256;
/// …and a byte ceiling per batch, so a tree of 2 MiB files does not pin
/// hundreds of megabytes of body text before the first commit.
const COMMIT_EVERY_BYTES: usize = 32 * 1024 * 1024;

/// Directory names skipped entirely while walking (case-insensitive).
const SKIP_DIRS: [&str; 9] = [
    "node_modules", ".git", "target", ".svn", ".hg", ".venv", "venv", "__pycache__", ".idea",
];

/// Errors surfaced by this crate.
#[derive(Debug)]
#[non_exhaustive]
pub enum Error {
    /// SQLite level failure.
    Sql(rusqlite::Error),
    /// Filesystem failure.
    Io(std::io::Error),
    /// The database was written by a newer schema version.
    SchemaVersion {
        /// Version found in the file.
        found: i64,
        /// Version this build understands.
        expected: i64,
    },
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Sql(e) => write!(f, "sqlite error: {e}"),
            Error::Io(e) => write!(f, "io error: {e}"),
            Error::SchemaVersion { found, expected } => {
                write!(f, "index schema v{found} is not supported (this build uses v{expected})")
            }
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::Sql(e) => Some(e),
            Error::Io(e) => Some(e),
            Error::SchemaVersion { .. } => None,
        }
    }
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let kind = match self {
            Error::Sql(_) => "sql",
            Error::Io(_) => "io",
            Error::SchemaVersion { .. } => "schema_version",
        };
        let mut st = s.serialize_struct("Error", 2)?;
        st.serialize_field("kind", kind)?;
        st.serialize_field("message", &self.to_string())?;
        st.end()
    }
}

impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        Error::Sql(e)
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Io(e)
    }
}

/// Shorthand result type.
pub type Result<T> = std::result::Result<T, Error>;

/// Progress event handed to the update callback.
#[derive(Debug, Clone, Serialize)]
pub struct Progress {
    /// `"index"`.
    pub phase: &'static str,
    /// Files handled so far.
    pub done: usize,
    /// Files in scope for this run.
    pub total: usize,
    /// Path currently being handled.
    pub path: String,
}

/// Summary of one `update` run.
#[derive(Debug, Clone, Default, Serialize)]
pub struct UpdateStats {
    /// Files newly added to the index.
    pub added: usize,
    /// Files whose content changed and were re-indexed.
    pub updated: usize,
    /// Files deleted from disk and dropped from the index.
    pub removed: usize,
    /// Files seen but unchanged (same path, mtime and size).
    pub unchanged: usize,
    /// Files skipped because they could not be read.
    pub failed: usize,
    /// Roots that could not be read; their existing entries were kept.
    pub unreadable_roots: Vec<String>,
    /// Candidate files handled this run (after the extension filter and
    /// de-duplication).
    pub scanned: usize,
    /// Wall-clock duration in milliseconds.
    pub elapsed_ms: u64,
}

/// One search result.
#[derive(Debug, Clone, Serialize)]
pub struct Hit {
    /// Absolute path (verbatim `\\?\` prefix removed).
    pub path: String,
    /// File name including extension.
    pub name: String,
    /// Lowercase extension without the dot (`""` when none).
    pub ext: String,
    /// Last modification time, milliseconds since the Unix epoch (ns would
    /// overflow JavaScript's safe integer range once serialised).
    pub mtime: i64,
    /// File size in bytes.
    pub size: i64,
    /// Up to three context windows; the match is wrapped in `[[` and `]]`.
    pub snippets: Vec<String>,
    /// Relevance score, higher is better and always finite (`> 0`).
    pub score: f64,
}

struct Found {
    path: PathBuf,
    path_str: String,
    name: String,
    ext: String,
    mtime_ns: i64,
    size: i64,
}

/// A full-text index over file contents. Moves across threads; not `Sync`.
#[derive(Debug)]
pub struct Index {
    conn: Connection,
    /// Rows written since the last FTS `optimize`, and when that was.
    dirty: usize,
    last_optimize: Instant,
}

impl Index {
    /// Open (or create) the index database at `db_path`.
    ///
    /// `db_path` may be `":memory:"` for a throwaway index. A *literal* path is
    /// opened with SQLite's URI parsing switched **off**, so `?`, `#` and `%`
    /// are ordinary filename characters. A path spelled as a URI (starting with
    /// `file:`) is the opt-in for URI features such as `?mode=ro`, and then the
    /// usual URI escaping applies. Missing parent directories are created. WAL
    /// is enabled for on-disk databases, with `synchronous` raised to `FULL`
    /// when that fails.
    pub fn open(db_path: impl AsRef<Path>) -> Result<Self> {
        let db_path = db_path.as_ref();
        let is_uri = db_path.to_string_lossy().starts_with("file:");
        if db_path != Path::new(":memory:") && !is_uri {
            if let Some(parent) = db_path.parent() {
                if !parent.as_os_str().is_empty() {
                    std::fs::create_dir_all(parent)?;
                }
            }
        }
        let mut flags = rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE
            | rusqlite::OpenFlags::SQLITE_OPEN_CREATE
            | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX;
        if is_uri {
            flags |= rusqlite::OpenFlags::SQLITE_OPEN_URI;
        }
        let conn = Connection::open_with_flags(db_path, flags)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;

        // Check the version before anything writes, so a foreign schema is not
        // silently touched by the DDL below.
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version != 0 && version != SCHEMA_VERSION {
            return Err(Error::SchemaVersion {
                found: version,
                expected: SCHEMA_VERSION,
            });
        }

        // `pragma_update` drops the result row, so the mode is read back:
        // `journal_mode` reports the mode actually in effect. Without WAL
        // (network share, read-only media) NORMAL is not durable enough, so
        // durability is raised instead of silently downgraded.
        let wal = db_path != Path::new(":memory:")
            && conn
                .query_row("PRAGMA journal_mode=WAL", [], |r| r.get::<_, String>(0))
                .map(|m| m.eq_ignore_ascii_case("wal"))
                .unwrap_or(false);
        conn.pragma_update(None, "synchronous", if wal { "NORMAL" } else { "FULL" })?;

        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS files (
                id       INTEGER PRIMARY KEY,
                path     TEXT NOT NULL UNIQUE,
                name     TEXT NOT NULL,
                ext      TEXT NOT NULL,
                mtime_ns INTEGER NOT NULL,
                size     INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS files_ext ON files(ext);
            CREATE VIRTUAL TABLE IF NOT EXISTS fts
                USING fts5(body, tokenize='trigram');
            "#,
        )?;
        if version == 0 {
            conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        }
        Ok(Self {
            conn,
            dirty: 0,
            last_optimize: Instant::now(),
        })
    }

    /// Number of indexed files.
    pub fn len(&self) -> Result<usize> {
        let n: i64 = self
            .conn
            .query_row("SELECT count(*) FROM files", [], |r| r.get(0))?;
        Ok(usize::try_from(n).unwrap_or(usize::MAX))
    }

    /// True when the index holds no files.
    pub fn is_empty(&self) -> Result<bool> {
        let mut stmt = self.conn.prepare("SELECT 1 FROM files LIMIT 1")?;
        let empty = stmt.query([])?.next()?.is_none();
        Ok(empty)
    }

    /// Drop every entry.
    pub fn clear(&mut self) -> Result<()> {
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        tx.execute("DELETE FROM fts", [])?;
        tx.execute("DELETE FROM files", [])?;
        // Reclaims the trigram segments; `delete-all` is unavailable because
        // this is a regular (content-storing) FTS5 table.
        tx.execute("INSERT INTO fts(fts) VALUES ('optimize')", [])?;
        tx.commit()?;
        self.dirty = 0;
        self.last_optimize = Instant::now();
        Ok(())
    }

    /// Incrementally bring the index in line with the files under `roots`.
    ///
    /// A file is only re-read when its path, mtime or size changed (an edit
    /// that keeps both — e.g. a same-size rewrite within the filesystem's
    /// timestamp granularity — is therefore missed).
    ///
    /// Deletion is the timid direction: files that vanished from a *readable*
    /// root are dropped, but entries under a root — or a directory below one —
    /// that could not be opened are kept. The same goes for a directory whose
    /// listing broke or whose entry failed with an error other than
    /// "not found": the whole directory is treated as not fully seen, so one
    /// locked file cannot wipe its neighbours. Only a confirmed gone entry (a
    /// dangling link, a file that vanished mid-walk) is dropped.
    /// `exts` is an extension allow-list without dots, case-insensitive and
    /// whitespace-tolerant; an empty slice accepts every file.
    ///
    /// Writes go out in batches of `COMMIT_EVERY_FILES` files (or
    /// `COMMIT_EVERY_BYTES` bytes), so a large build
    /// does not hold the write lock (or grow the WAL) for its whole duration and
    /// other connections keep working. The price is atomicity per batch, not per
    /// run: a failure or a panic in the callback leaves the batches already
    /// committed in place. Because of that the callback may fire outside a
    /// transaction, but it must still not re-enter the same `Index` — a second
    /// connection would block on the write lock.
    pub fn update<F>(
        &mut self,
        roots: &[PathBuf],
        exts: &[&str],
        mut progress: F,
    ) -> Result<UpdateStats>
    where
        F: FnMut(Progress),
    {
        let started = Instant::now();
        // Every early exit reports a duration too, so callers can log uniformly.
        macro_rules! early {
            ($stats:expr) => {{
                let s = UpdateStats {
                    elapsed_ms: started.elapsed().as_millis() as u64,
                    ..$stats
                };
                return Ok(s);
            }};
        }
        if roots.is_empty() {
            early!(UpdateStats::default());
        }
        let wanted = normalize_exts(exts);

        // 1. Resolve roots once, dropping duplicates after normalisation
        //    (`C:\a` and `c:\a\` are the same root). Fold case only on
        //    case-insensitive filesystems.
        let mut scanned_roots: Vec<PathBuf> = Vec::new();
        let mut unreadable: Vec<String> = Vec::new();
        let mut seen_roots: HashSet<String> = HashSet::new();
        for root in roots {
            match normalize(root) {
                Ok(p) => {
                    let key = root_key(&p);
                    if seen_roots.insert(key) {
                        scanned_roots.push(p);
                    }
                }
                Err(_) => unreadable.push(root.display().to_string()),
            }
        }
        if scanned_roots.is_empty() {
            // Nothing could be read at all: report it, but keep every entry.
            early!(UpdateStats {
                unreadable_roots: unreadable,
                ..UpdateStats::default()
            });
        }

        // 2. Discover candidates. A root that cannot be opened at all is
        //    discarded entirely (all-or-nothing) so its entries are neither
        //    half-written nor mass-deleted. A *sub*directory that cannot be
        //    opened is remembered in `blind`: files below it are still on disk
        //    even though the walk could not see them, so they must not be
        //    deleted (one `icacls`/chmod must not wipe part of the index).
        let mut found: Vec<Found> = Vec::new();
        let mut seen_paths: HashSet<String> = HashSet::new();
        let mut walked: Vec<PathBuf> = Vec::new();
        let mut blind: Vec<PathBuf> = Vec::new();
        for root in &scanned_roots {
            let mark = found.len();
            let mut visited = HashSet::new();
            match collect(root, &wanted, &mut visited, &mut found, &mut blind) {
                Ok(()) => walked.push(root.clone()),
                Err(_) => {
                    found.truncate(mark);
                    // A root that is a plain file is legal, and must be
                    // re-indexed singly rather than reported as unreadable.
                    if let Ok(meta) = std::fs::metadata(root) {
                        if meta.is_file() {
                            if let Some(f) = found_from(root, &meta, &wanted) {
                                found.push(f);
                            }
                            walked.push(root.clone());
                            continue;
                        }
                    }
                    unreadable.push(root.display().to_string());
                }
            }
        }
        found.retain(|f| seen_paths.insert(f.path_str.clone()));
        let total = found.len();
        let seen = seen_paths;

        let mut stats = UpdateStats {
            unreadable_roots: unreadable,
            ..UpdateStats::default()
        };

        // 3. Snapshot the rows this run is responsible for. Read outside the
        //    transaction: nothing else writes this database except `update`.
        let indexed = snapshot(&self.conn, &walked)?;

        // 4. Apply the changes in fixed-size batches. A single transaction over
        //    a 100k-file tree would hold the write lock (and grow the WAL) for
        //    the whole build, so concurrent readers/writers would time out. The
        //    trade-off is documented on the method: a failure or a panic in the
        //    callback now rolls back only the current batch, not the run.
        let mut pending: Vec<(&Found, String)> = Vec::with_capacity(COMMIT_EVERY_FILES);
        // Bytes held by `pending`: 256 files of up to 2 MiB each would otherwise
        // pin ~512 MiB before the first commit.
        let mut pending_bytes = 0usize;

        for (done, f) in found.iter().enumerate() {
            stats.scanned += 1;
            progress(Progress {
                phase: "index",
                done: done + 1,
                total,
                path: f.path_str.clone(),
            });

            // Unchanged files are never opened, so an incremental pass stays
            // cheap on a large tree.
            if let Some((_, mtime, size)) = indexed.get(&f.path_str) {
                // 0 = timestamp unknown, so it can never prove "unchanged".
                if f.mtime_ns != 0 && *mtime == f.mtime_ns && *size == f.size {
                    stats.unchanged += 1;
                    continue;
                }
            }

            let Some(text) = read_head(&f.path) else {
                stats.failed += 1;
                continue; // metadata of a failed read stays untouched -> retried
            };
            pending_bytes += text.len();
            pending.push((f, text));
            if pending.len() >= COMMIT_EVERY_FILES || pending_bytes >= COMMIT_EVERY_BYTES {
                write_batch(&mut self.conn, &pending, &indexed, &mut stats)?;
                pending.clear();
                pending_bytes = 0;
            }
        }
        if !pending.is_empty() {
            write_batch(&mut self.conn, &pending, &indexed, &mut stats)?;
        }

        // 5. Drop rows that disappeared: only under roots that were readable
        //    this run, and never below a directory the walk could not open.
        if !indexed.is_empty() {
            let blind_keys: Vec<RootKey> = blind.iter().map(|b| RootKey::new(b)).collect();
            let tx = self
                .conn
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            {
                let mut del_fts = tx.prepare_cached("DELETE FROM fts WHERE rowid = ?1")?;
                let mut del_file = tx.prepare_cached("DELETE FROM files WHERE id = ?1")?;
                for (path, (id, _, _)) in &indexed {
                    if !seen.contains(path) && !blind_keys.iter().any(|b| under_root(path, b)) {
                        del_fts.execute(params![id])?;
                        del_file.execute(params![id])?;
                        stats.removed += 1;
                    }
                }
            }
            tx.commit()?;
        }
        // `optimize` merges every segment, i.e. it costs the whole index, so a
        // watch-mode run that touches two files must not trigger it each time.
        self.dirty += stats.added + stats.updated + stats.removed;
        if self.dirty > 0
            && (self.dirty >= OPTIMIZE_EVERY_ROWS
                || self.last_optimize.elapsed() >= std::time::Duration::from_secs(OPTIMIZE_EVERY_SECS))
        {
            let _ = self
                .conn
                .execute("INSERT INTO fts(fts) VALUES ('optimize')", []);
            self.dirty = 0;
            self.last_optimize = Instant::now();
        }
        stats.elapsed_ms = started.elapsed().as_millis() as u64;
        Ok(stats)
    }

    /// Search indexed contents.
    ///
    /// `query` is split on whitespace; every term must occur, literally and
    /// case-insensitively (quotes and `*` are not operators). A term the
    /// trigram tokenizer cannot serve — shorter than three characters, or
    /// containing anything but letters/digits (`ab!`, `a b`, `😀`) — sends the
    /// whole query to a `LIKE` scan instead. `Some(&[])` filters nothing. Up to
    /// `limit` hits come back (capped at 500), best first. At most
    /// `MAX_TERMS` terms are used; the rest are ignored.
    pub fn search(
        &self,
        query: &str,
        exts_filter: Option<&[&str]>,
        limit: usize,
    ) -> Result<Vec<Hit>> {
        let query = query.trim();
        if query.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        // Surrounding double quotes are stripped per term so both `"x y"` and
        // `x y` behave the same; every term is re-quoted for FTS below.
        let terms: Vec<String> = query
            .split_whitespace()
            .map(|t| t.trim_matches('"').to_string())
            .filter(|t| !t.is_empty())
            .take(MAX_TERMS)
            .collect();
        if terms.is_empty() {
            return Ok(Vec::new());
        }
        let exts: Vec<String> = exts_filter
            .map(|e| normalize_exts(e).into_iter().collect())
            .unwrap_or_default();

        let limit = limit.min(500);
        if terms.iter().all(|t| fts_can_serve(t)) {
            self.search_fts(&terms, &exts, limit)
        } else {
            self.search_like(&terms, &exts, limit)
        }
    }

    fn search_fts(&self, terms: &[String], exts: &[String], limit: usize) -> Result<Vec<Hit>> {
        // Every term is a quoted phrase, so FTS operators in user input are
        // neutralised; `"` inside a term is doubled.
        let match_expr = terms
            .iter()
            .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" ");
        // Two phases: ranks are computed first, so only `limit` bodies (up to
        // 2 MiB each) are ever pulled through the sort.
        let mut sql = String::from(
            "SELECT fts.rowid, bm25(fts) AS rank \
             FROM fts JOIN files f ON f.id = fts.rowid WHERE fts MATCH ?1",
        );
        let mut args: Vec<Value> = vec![Value::Text(match_expr)];
        push_ext_filter(&mut sql, &mut args, exts);
        sql.push_str(" ORDER BY rank LIMIT ?");
        args.push(Value::Integer(limit.min(i64::MAX as usize) as i64));

        let mut stmt = self.conn.prepare(&sql)?;
        let mut rows = stmt.query(params_from_iter(args))?;
        let mut ranked: Vec<(i64, f64)> = Vec::new();
        while let Some(row) = rows.next()? {
            ranked.push((row.get(0)?, row.get(1)?));
        }
        drop(rows);
        drop(stmt);

        let mut hits = Vec::with_capacity(ranked.len());
        for (id, rank) in ranked {
            // bm25 returns a negative number, better = more negative.
            let score = 1.0 + (-rank).max(0.0);
            if let Some((mut hit, text)) = self.row_by_id(id)? {
                hit.snippets = make_snippets(&text, terms);
                hit.score = clamp_score(score);
                hits.push(hit);
            }
        }
        Ok(hits)
    }

    /// One indexed row without its snippets; the body comes back for the
    /// caller to build them. `None` when the row vanished under us.
    fn row_by_id(&self, id: i64) -> Result<Option<(Hit, String)>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT path, name, ext, mtime_ns, size, body FROM files f \
             JOIN fts ON fts.rowid = f.id WHERE f.id = ?1",
        )?;
        let mut rows = stmt.query(params![id])?;
        let Some(row) = rows.next()? else {
            return Ok(None);
        };
        let text: String = row.get(5)?;
        let hit = Hit {
            path: strip_verbatim(&row.get::<_, String>(0)?),
            name: row.get(1)?,
            ext: row.get(2)?,
            mtime: row.get::<_, i64>(3)? / 1_000_000,
            size: row.get(4)?,
            snippets: Vec::new(),
            score: 0.0,
        };
        Ok(Some((hit, text)))
    }

    fn search_like(&self, terms: &[String], exts: &[String], limit: usize) -> Result<Vec<Hit>> {
        // Nothing indexes a term the tokenizer cannot serve, so this path
        // always scans: filtering and counting stay in SQL (`instr`/`length`)
        // so only `limit` rows are lifted into Rust, and the CTE lowercases each
        // body once instead of once per term. The scan cost is unavoidable.
        //
        // `lower()` is SQLite's, i.e. ASCII-only: exact for English and for
        // CJK (no case); `É`/`é` do NOT fold here, while snippets do fold them
        // with Rust's Unicode-aware lowering.
        let mut sql = String::from(
            "WITH c AS (SELECT f.id AS id, f.size AS size, lower(fts.body) AS lb \
             FROM files f JOIN fts ON fts.rowid = f.id WHERE 1 = 1",
        );
        let mut args: Vec<Value> = Vec::new();
        push_ext_filter(&mut sql, &mut args, exts);
        sql.push_str(") SELECT id, size, (0");
        for t in terms {
            // (len(body) - len(body without term)) / len(term) = occurrences.
            sql.push_str(" + (length(lb) - length(replace(lb, lower(?), ''))) / length(lower(?))");
            args.push(Value::Text(t.clone()));
            args.push(Value::Text(t.clone()));
        }
        sql.push_str(") AS occ FROM c WHERE 1 = 1");
        for t in terms {
            sql.push_str(" AND instr(lb, lower(?)) > 0");
            args.push(Value::Text(t.clone()));
        }
        sql.push_str(" ORDER BY occ DESC LIMIT ?");
        args.push(Value::Integer(limit.min(i64::MAX as usize) as i64));

        let mut stmt = self.conn.prepare(&sql)?;
        let mut rows = stmt.query(params_from_iter(args))?;
        let mut ranked: Vec<(i64, f64)> = Vec::new();
        while let Some(row) = rows.next()? {
            let id: i64 = row.get(0)?;
            let size: i64 = row.get(1)?;
            let occ: i64 = row.get(2)?;
            // Occurrence density, damped by document length.
            let score = occ.max(0) as f64 / (1.0 + size.max(0) as f64 / 4096.0);
            ranked.push((id, score));
        }
        drop(rows);
        drop(stmt);

        let mut hits = Vec::with_capacity(ranked.len());
        for (id, score) in ranked {
            if let Some((mut hit, text)) = self.row_by_id(id)? {
                hit.snippets = make_snippets(&text, terms);
                hit.score = clamp_score(score);
                hits.push(hit);
            }
        }
        Ok(hits)
    }
}


/// Everything the index already knows under `roots`, keyed by path.
///
/// The `LIKE` prefilter runs in SQL so a large index is not fully materialised
/// in Rust; `in_scope` then does the exact check, which also rejects the
/// over-long prefixes `LIKE` lets through (`C:\a` vs a stored `C:\ab\…`).
///
/// `LIKE` is ASCII-case-insensitive, so it also prefilters case variants; the
/// non-ASCII case difference it would miss cannot slip through, because roots
/// are canonicalised and therefore carry the on-disk spelling.
fn snapshot(conn: &Connection, roots: &[PathBuf]) -> Result<HashMap<String, (i64, i64, i64)>> {
    let keys: Vec<RootKey> = roots.iter().map(|r| RootKey::new(r)).collect();
    let mut sql = String::from("SELECT id, path, mtime_ns, size FROM files WHERE 1 = 0");
    let mut args: Vec<Value> = Vec::new();
    for r in &keys {
        sql.push_str(" OR path LIKE ? ESCAPE '\\'");
        args.push(Value::Text(format!("{}%", escape_like(&r.trimmed))));
    }

    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(params_from_iter(args))?;
    let mut out = HashMap::new();
    while let Some(row) = rows.next()? {
        let path: String = row.get(1)?;
        // `path_key` allocates the whole path lowercased; once per row, not
        // once per root.
        let key = path_key(trim_seps(&path));
        if keys.iter().any(|r| in_scope(&path, &key, r)) {
            out.insert(path, (row.get(0)?, row.get(2)?, row.get(3)?));
        }
    }
    Ok(out)
}

fn normalize_exts(exts: &[&str]) -> HashSet<String> {
    exts.iter()
        .map(|e| e.trim().trim_matches('.').to_lowercase())
        .filter(|e| !e.is_empty())
        .collect()
}

/// Drop the Windows verbatim prefix, mapping `\\?\UNC\server` back to
/// `\\server` so the path is usable by ordinary Win32 APIs again.
fn strip_verbatim(s: &str) -> String {
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        s.to_string()
    }
}

/// Absolute, prefix-normalised form of `p` (no `.`/`..`).
///
/// The Windows `\\?\` prefix is deliberately *kept*: the long-path form is what
/// makes I/O work past `MAX_PATH`, and every path the crate handles internally
/// (stored rows, walk results) uses it too, so prefix comparisons stay
/// consistent. Only [`Hit::path`] is stripped for display.
fn normalize(p: &Path) -> std::io::Result<PathBuf> {
    std::fs::canonicalize(p)
}

/// Dedup key for a root: trailing separators are irrelevant; the case is only
/// folded on filesystems that ignore it.
fn root_key(p: &Path) -> String {
    let s = p.to_string_lossy();
    let s = trim_seps(&s);
    if cfg!(windows) || cfg!(target_os = "macos") {
        s.to_lowercase()
    } else {
        s.to_string()
    }
}

fn escape_like(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

fn push_ext_filter(sql: &mut String, args: &mut Vec<Value>, exts: &[String]) {
    if exts.is_empty() {
        return;
    }
    sql.push_str(" AND f.ext IN (");
    for (i, ext) in exts.iter().enumerate() {
        if i > 0 {
            sql.push(',');
        }
        sql.push('?');
        args.push(Value::Text(ext.clone()));
    }
    sql.push(')');
}

/// Write one batch of changed files in its own transaction.
fn write_batch(
    conn: &mut Connection,
    batch: &[(&Found, String)],
    indexed: &HashMap<String, (i64, i64, i64)>,
    stats: &mut UpdateStats,
) -> Result<()> {
    // Rolls back on drop, so a failure leaves the index consistent at the
    // previous batch boundary.
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    {
        let mut del_fts = tx.prepare_cached("DELETE FROM fts WHERE rowid = ?1")?;
        let mut upd = tx.prepare_cached(
            "UPDATE files SET name = ?2, ext = ?3, mtime_ns = ?4, size = ?5 WHERE id = ?1",
        )?;
        let mut ins = tx.prepare_cached(
            "INSERT INTO files(path, name, ext, mtime_ns, size) VALUES (?1, ?2, ?3, ?4, ?5)",
        )?;
        let mut ins_fts = tx.prepare_cached("INSERT INTO fts(rowid, body) VALUES (?1, ?2)")?;

        for (f, text) in batch {
            match indexed.get(&f.path_str) {
                Some((id, _, _)) => {
                    del_fts.execute(params![id])?;
                    upd.execute(params![id, &f.name, &f.ext, f.mtime_ns, f.size])?;
                    ins_fts.execute(params![id, text])?;
                    stats.updated += 1;
                }
                None => {
                    ins.execute(params![&f.path_str, &f.name, &f.ext, f.mtime_ns, f.size])?;
                    ins_fts.execute(params![tx.last_insert_rowid(), text])?;
                    stats.added += 1;
                }
            }
        }
    }
    tx.commit()?;
    Ok(())
}

/// `score` as documented: finite and strictly positive.
fn clamp_score(score: f64) -> f64 {
    if score.is_finite() && score > 0.0 {
        score
    } else {
        f64::MIN_POSITIVE
    }
}

fn lowered_chars(s: &str) -> Vec<char> {
    s.chars()
        .map(|c| c.to_lowercase().next().unwrap_or(c))
        .collect()
}

/// Up to [`MAX_SNIPPETS`] non-overlapping context windows around matches, the
/// match wrapped in `[[` / `]]`, elided ends marked with `…`.
///
/// Longest term first, so `梯度下降` is not highlighted as just `梯度`.
fn make_snippets(text: &str, terms: &[String]) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let lower = lowered_chars(text);
    let mut needles: Vec<Vec<char>> = terms
        .iter()
        .map(|t| lowered_chars(t))
        .filter(|n| !n.is_empty())
        .collect();
    needles.sort_by_key(|b| std::cmp::Reverse(b.len()));
    if needles.is_empty() {
        return Vec::new();
    }

    // A hit can come from the tokenizer without the term appearing verbatim
    // (e.g. `foo bar` matching a stored `foo\nbar`); fall back to the head of
    // the body rather than returning nothing.
    let fallback = || {
        let to = SNIPPET_RADIUS.min(chars.len());
        let mut s = String::new();
        s.extend(&chars[..to]);
        if to < chars.len() {
            s.push('…');
        }
        s
    };

    let mut out = Vec::new();
    let mut i = 0usize;
    while i < lower.len() && out.len() < MAX_SNIPPETS {
        let hit = needles
            .iter()
            .find(|n| n.len() <= lower.len() - i && lower[i..i + n.len()] == n[..]);
        let Some(needle) = hit else {
            i += 1;
            continue;
        };
        let end = i + needle.len();
        let from = i.saturating_sub(SNIPPET_RADIUS);
        let to = (end + SNIPPET_RADIUS).min(chars.len());
        let mut s = String::new();
        if from > 0 {
            s.push('…');
        }
        s.extend(&chars[from..i]);
        s.push_str("[[");
        s.extend(&chars[i..end]);
        s.push_str("]]");
        s.extend(&chars[end..to]);
        if to < chars.len() {
            s.push('…');
        }
        out.push(s);
        i = to.max(end); // windows never overlap
    }
    if out.is_empty() && !chars.is_empty() {
        out.push(fallback());
    }
    out
}

/// Whether the trigram tokenizer can actually answer `term`.
///
/// Two ways it cannot: fewer than three characters (no trigram is produced) and
/// characters the tokenizer treats as separators — anything that is not a
/// letter or a digit, e.g. `ab!`, `a b`, `😀`. The check is conservative: a false
/// negative only costs a `LIKE` scan, a false positive loses hits.
fn fts_can_serve(term: &str) -> bool {
    term.chars().count() >= 3 && term.chars().all(|c| c.is_alphanumeric())
}

/// Comparison key for a path on this platform's usual filesystem: full Unicode
/// lowercase where paths are case-insensitive, unchanged otherwise.
fn path_key(s: &str) -> String {
    if cfg!(any(windows, target_os = "macos")) {
        s.to_lowercase()
    } else {
        s.to_string()
    }
}

/// Whether the walk separator can be `b` here. `\` is an ordinary filename
/// character on Unix, so only `/` separates there.
fn is_sep(b: u8) -> bool {
    b == b'/' || (cfg!(windows) && b == b'\\')
}

/// Strip trailing separators, mirroring [`is_sep`]: a Unix directory may
/// legitimately end in `\`, so trimming it there would corrupt the path.
fn trim_seps(s: &str) -> &str {
    if cfg!(windows) {
        s.trim_end_matches(['\\', '/'])
    } else {
        s.trim_end_matches('/')
    }
}

/// True when `path` is `root` or lies below it.
///
/// `get(..len)` rather than `[..len]`: a byte slice that lands inside a
/// multi-byte character would panic, and both sides are user data (CJK paths
/// are the point of this crate). Folding is Unicode-wide, because a case-only
/// rename has to be recognised as the same file or the stale row never dies.
fn in_scope(path: &str, path_key_cached: &str, root: &RootKey) -> bool {
    if path_key_cached == root.key {
        return true;
    }
    below(path, root)
}

/// True when `path` lies strictly below `root`.
fn under_root(path: &str, root: &RootKey) -> bool {
    below(path, root)
}

/// A root prepared for repeated comparison: trailing separators trimmed and the
/// case-folded form built once, so a scan over many rows does not re-allocate
/// it per row.
struct RootKey {
    trimmed: String,
    key: String,
}

impl RootKey {
    fn new(root: &Path) -> Self {
        let trimmed = trim_seps(&root.to_string_lossy()).to_string();
        let key = path_key(&trimmed);
        Self { trimmed, key }
    }
}

/// Byte-prefix test: `path` is cut at `root.trimmed.len()` and only that head is
/// case-folded and compared, so the offsets are the *unfolded* ones.
///
/// The cut can land inside a character when the root contains non-ASCII
/// (`C:\資料` cut short by a row of another root) — `get(..)` then returns
/// `None` and no prefix is claimed. A fold that changes byte length (`İ` →
/// `i`+U+0307) is compensated by comparing the folded head against the folded
/// root instead of the folded path against a byte offset.
fn below(path: &str, root: &RootKey) -> bool {
    let Some(head) = path.get(..root.trimmed.len()) else {
        return false;
    };
    path.len() > root.trimmed.len()
        && is_sep(path.as_bytes()[root.trimmed.len()])
        && path_key(head) == root.key
}

/// First [`MAX_INDEX_BYTES`] of `path`, streamed and decoded lossily.
///
/// If the cut lands inside a multi-byte sequence the incomplete tail is dropped
/// instead of turning into a replacement character.
fn read_head(path: &Path) -> Option<String> {
    let f = File::open(path).ok()?;
    let mut buf = Vec::with_capacity(64 * 1024);
    let mut head: Take<File> = f.take(MAX_INDEX_BYTES as u64);
    head.read_to_end(&mut buf).ok()?;
    if buf.len() == MAX_INDEX_BYTES {
        // The cut may have landed inside a multi-byte sequence. An incomplete
        // suffix is reported by `error_len() == None`, and can only be at the
        // very end, so dropping those bytes is safe and avoids a U+FFFD.
        if let Err(e) = std::str::from_utf8(&buf) {
            if e.error_len().is_none() {
                buf.truncate(e.valid_up_to());
            }
        }
    }
    let mut text = String::from_utf8_lossy(&buf).into_owned();
    // A truncation cut can leave replacement characters dangling at the very
    // end; they carry no searchable information.
    if buf.len() == MAX_INDEX_BYTES {
        let kept = text.trim_end_matches('\u{FFFD}').len();
        text.truncate(kept);
    }
    Some(text)
}

/// Modification time in nanoseconds since the epoch, saturating at the `i64`
/// range (a raw `as_nanos() as i64` wraps for dates before ~1601, which would
/// fire a needless re-index of the whole tree).
fn mtime_ns(meta: &std::fs::Metadata) -> i64 {
    fn sat(v: u128) -> i64 {
        i64::try_from(v).unwrap_or(i64::MAX)
    }
    let Ok(t) = meta.modified() else { return 0 };
    match t.duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => sat(d.as_nanos()),
        Err(e) => -sat(e.duration().as_nanos()),
    }
}

/// Collect files below `dir`.
///
/// Iterative (a deep tree must not blow the stack). Symlink/junction loops are
/// stopped by canonicalising every directory before it is pushed, since the
/// path *text* alone differs on each lap (`a\l\a\l\…`). Failing to read `dir`
/// itself is an error; a failing *sub*directory is skipped so one permission
/// problem cannot cost the whole root.
fn collect(
    dir: &Path,
    exts: &HashSet<String>,
    visited: &mut HashSet<PathBuf>,
    out: &mut Vec<Found>,
    blind: &mut Vec<PathBuf>,
) -> Result<()> {
    visited.insert(dir.to_path_buf());
    let mut stack = vec![dir.to_path_buf()];

    while let Some(current) = stack.pop() {
        let is_root = current == dir;
        let entries = match std::fs::read_dir(&current) {
            Ok(e) => e,
            Err(e) if is_root => return Err(e.into()),
            Err(_) => {
                blind.push(current);
                continue;
            }
        };

        for entry in entries {
            // An entry-level readdir error is not a root failure, but the file
            // may well still be on disk: remembering the directory as `blind`
            // keeps its indexed rows instead of deleting them just because one
            // read hiccuped. The next successful walk fixes it up anyway.
            // (`blind` is only ever read as a set later, and every push here is
            // for the same `current`, so one entry is enough.)
            let entry = match entry {
                Ok(e) => e,
                Err(_) => {
                    mark_blind(blind, &current);
                    continue;
                }
            };
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();

            // `metadata` (unlike `DirEntry::file_type`) follows symlinks, so
            // linked files are indexed and linked dirs are walked; `visited`
            // stops loops.
            let meta = match std::fs::metadata(&path) {
                Ok(m) => m,
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                    // Exists but cannot be stat'ed (locked, ACL): keep its row.
                    mark_blind(blind, &current);
                    continue;
                }
                Err(_) => {
                    // NotFound. Either a dangling link (skip quietly — it is a
                    // link with a missing target, nothing to index) or a file
                    // that vanished between `read_dir` and `metadata`, which is
                    // a plain race and may be dropped.
                    continue;
                }
            };

            if meta.is_dir() {
                if SKIP_DIRS.iter().any(|s| name.eq_ignore_ascii_case(s)) {
                    continue;
                }
                // Dedupe on the canonical target (a junction resolves to a
                // directory already seen under another spelling, so only the
                // real path can stop the loop), but keep walking the path as
                // spelled, so files stay reported under the root that was
                // passed in.
                let real = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
                if visited.insert(real) {
                    stack.push(path);
                }
                continue;
            }
            if !meta.is_file() {
                continue; // fifo, device, socket
            }

            if let Some(f) = found_from(&path, &meta, exts) {
                out.push(f);
            }
        }
    }
    Ok(())
}

/// Record `dir` as not fully seen, without collecting duplicates.
fn mark_blind(blind: &mut Vec<PathBuf>, dir: &Path) {
    if blind.last() != Some(&dir.to_path_buf()) {
        blind.push(dir.to_path_buf());
    }
}

/// `Found` for one existing file, or `None` when the extension is filtered out
/// (or the metadata cannot be read).
fn found_from(path: &Path, meta: &std::fs::Metadata, exts: &HashSet<String>) -> Option<Found> {
    if !meta.is_file() {
        return None;
    }
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if !exts.is_empty() && !exts.contains(&ext) {
        return None;
    }
    Some(Found {
        path_str: path.to_string_lossy().into_owned(),
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        path: path.to_path_buf(),
        ext,
        mtime_ns: mtime_ns(meta),
        size: meta.len() as i64,
    })
}

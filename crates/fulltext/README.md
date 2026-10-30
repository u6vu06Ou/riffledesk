# fulltext

Incremental full-text index for local file contents. Backed by SQLite FTS5 with the
`trigram` tokenizer, so substring and CJK queries work. Everything is a local file
read — no network. Designed to be called from a Tauri command on a background thread.

## API

```rust
impl Index { pub fn open(db_path: impl AsRef<Path>) -> Result<Index>
```
A *literal* path is opened with SQLite's URI parsing switched off, so `?`, `#`, `%`
and spaces are ordinary filename characters. Spell the path as `file:idx.db?mode=ro`
to opt into URI features. Missing parent directories are created, WAL is
enabled for on-disk files (a no-op for `":memory:"`; if it cannot be enabled,
`synchronous` is raised to `FULL` instead of downgraded), and a 5 s busy timeout is
set. A database stamped with a newer `user_version` is refused with
`Error::SchemaVersion`.

```rust
impl Index { pub fn update<F: FnMut(Progress)>(&mut self, roots: &[PathBuf], exts: &[&str], progress: F) -> Result<UpdateStats>
```
Bring the index in line with `roots`. Incremental: a file is only re-read when its
path, mtime or size changed (mtime is compared at nanosecond resolution); files that disappeared are dropped. If a
root cannot be read at all its existing entries are kept and the root is listed in
`UpdateStats::unreadable_roots`. Files above 2 MiB are indexed on their first 2 MiB
only. Non-UTF-8 bytes go through lossy conversion. `node_modules`, `.git`, `target`, `.svn`, `.hg`, `.venv`, `venv`, `__pycache__` and
`.idea` are skipped at any depth, case-insensitively. `exts` is an extension allow-list
without dots, case-insensitive, surrounding dots/whitespace tolerated (`&[]` =
everything). Roots are canonicalised and de-duplicated; an empty `roots` is a no-op
that returns zeroed stats. If the root itself cannot be opened its entries are kept
and it is reported; an unreadable *sub*directory or an entry that vanishes mid-walk
is skipped and the rest of the root is still indexed, so one permission problem
never costs a whole tree.

Deletion is deliberately the timid direction: entries under a directory that could
not be opened are kept, and so is the whole directory when one of its entries fails
with an error other than "not found" (a lock, an ACL) or when the directory listing
itself breaks — the files are probably still there and the next clean walk
reconciles them. Only a *confirmed* gone entry is dropped: a dangling link, or a
file that vanished between `read_dir` and `metadata` (a plain race). Narrowing
`exts` does drop files that are no longer allowed. If no root could be read at all the call returns `Ok` with zeroed counters
and every entry kept. `progress` fires once per candidate file, *outside* the write
transaction (see the note on batching below).

Rows outside every root passed this run are left alone: `update` reconciles the
given roots, it does not mirror the whole database. Call `clear` (or pass every root
you care about) when the root set shrinks for good.

```rust
impl Index { pub fn search(&self, query: &str, exts_filter: Option<&[&str]>, limit: usize) -> Result<Vec<Hit>>
```
Whitespace in `query` splits it into terms, all of which must match; each term is
matched literally and case-insensitively (FTS operators are neutralised, surrounding
quotes are ignored, `*` is not a wildcard). `Hit.snippets` holds up to three context
windows (~40 chars each side) with the match wrapped in `[[` `]]`; if the term is
present only in a normalised form the first window of the body is returned instead
of nothing.

A term the trigram tokenizer cannot serve sends the whole query to a `LIKE` scan:
fewer than three characters, or containing anything that is not a letter or digit
(`ab!`, `a b`, `😀`, `1.2`). That path is correct but always scans, so it is the
slow one. `Some(&[])` filters nothing. `limit` is capped at 500. A query split into
several terms is an AND; quoting the whole query does not make it one phrase.

```rust
impl Index { pub fn len(&self) -> Result<usize>   // number of indexed files
impl Index { pub fn is_empty(&self) -> Result<bool>
impl Index { pub fn clear(&mut self) -> Result<()>
```

Types: `Progress { phase, done, total, path }`, `UpdateStats { added, updated,
removed, unchanged, failed, unreadable_roots, scanned, elapsed_ms }`, `Hit { path,
name, ext, mtime, size, snippets, score }`, `Error { Sql, Io, SchemaVersion }`.
All data types derive `Serialize`, and `Error` serialises as `{ "kind", "message" }`,
so results can go straight back to the frontend. `score` is always finite and `> 0`; higher is better. `Hit.mtime` is in
milliseconds since the Unix epoch so it survives JSON/JS, while the index itself
compares nanosecond mtimes.

## Example

```rust
use fulltext::Index;
use std::path::PathBuf;

fn main() -> fulltext::Result<()> {
    let mut idx = Index::open(r"C:\Users\me\AppData\Local\3jsfolder\idx.sqlite")?;
    let stats = idx.update(&[PathBuf::from(r"D:\works")], &["md", "rs", "txt"], |p| {
        println!("{}/{} {}", p.done, p.total, p.path);
    })?;
    println!("{stats:?}");

    for hit in idx.search("梯度下降", Some(&["md"]), 20)? {
        println!("{} {:?}", hit.path, hit.snippets);
    }
    Ok(())
}
```

## Notes

- This crate is currently standalone (its own `Cargo.lock`); when it becomes a
  workspace member, move the lock and `[profile.release]` to the workspace root.

- `Index` is not `Sync` (single `Connection`) but moves fine across threads — see
  the `index_moves_to_another_thread_and_persists` test.
- Written for Windows (the target), and builds and passes on Unix too; there a
  directory name may end in `\`, which is only treated as a separator on Windows.
- Roots and hits are canonicalised, so a hit reports the resolved path, not the
  spelling the caller passed in (a symlinked root resolves to its target). `Hit.path`
  is the display form (no `\\?\`); `Progress.path` and `unreadable_roots` keep the
  internal form, which is what a caller needs to act on a failure.
- Paths come back verbatim (no `\\?\` prefix) as UTF-8; a path that is not valid
  UTF-8 is stored lossily and may then need re-resolution by the caller.
- Symlinked files are indexed and symlinked directories are walked, deduplicated on
  the canonical target so junction/symlink loops terminate. FIFOs/devices are skipped.
  The loop set is per root, so a link that crosses into a *second* root stores the
  same physical file twice — once under each spelling — and both entries match a
  search. An overlapping root (a subdirectory passed next to its parent) is walked
  twice; that costs bytes, not rows, because the walk yields identical paths and
  they are de-duplicated.
- Build cost: measured 0.40–0.44 s per 1000 small files on the dev box (`--release`,
  in-memory DB, 4 runs), i.e. ~2.5k files/s of ~60-byte text. `optimize`
  is throttled (every 2000 written rows or 5 minutes, and on `clear`) because it is
  a full merge and would make a frequent small update cost the whole index.
- The LIKE fallback filters and counts in SQL (`instr`/`length`, one `lower()` per
  body) and reads bodies only for the `limit` rows kept, but nothing indexes a short
  term: it still scans every indexed body. Use it for short CJK terms, not broad ones.
- Snippets are cut in Rust over the stored body, so a hit costs a scan of up to 2 MiB
  (a few ms) — up to `limit` (≤500) hits per query. Worst case, a 500-hit query over
  large files takes seconds and holds bodies one at a time, never all of them.
- Only mtime + size are compared, so an edit that preserves both — same bytes count,
  inside the filesystem's timestamp granularity (2 s on FAT32) — is missed. A file that
  is on disk but unreadable keeps its old entry (counted in `failed`, not removed), and
  so do all files below a directory the walk could not open.
- `progress` fires outside the write transaction (it runs while the batch is being
  accumulated): do not re-enter the same `Index` from it.
- A plain `db_path` is opened without SQLite's URI parsing, so `#`/`%`/spaces in the
  file name are literal; only a `file:` prefixed path is treated as a URI.
- Long paths: the internal walk and stored rows keep the verbatim `\\?\` form, so
  paths past 260 characters work; it is stripped from `Hit.path` for display only.
- `clear` deletes every row and runs FTS `optimize` (FTS5 `delete-all` does not apply to a content-storing table); the file does not shrink (no
  `VACUUM`).
- A root may be a single file (it is indexed on its own and kept if it disappears). A root that exists but cannot be indexed from keeps
  its entries and is reported in `unreadable_roots`.
- `PRAGMA user_version` is stamped as a schema marker; there is no migration path
  yet. Bump `SCHEMA_VERSION` when the FTS schema changes and recreate the DB — a DB
  carrying any other version is refused rather than silently reused.
- Writes go out in transactions of at most 256 files / 32 MiB of body text, so a
  large build releases the write lock regularly instead of holding it for its whole
  duration (and the WAL stays bounded). Atomicity is per batch: a failure or a panic in the callback leaves the
  batches already committed in place, and the next run finishes the job because
  unchanged files are skipped. The progress callback can fire outside a transaction
  but must still not re-enter the same `Index`.

# fsview

Filesystem browsing primitives for the 3jsfloder file browser. Pure library, no
state, no whole-file reads. Every I/O failure comes back as data instead of a
panic, so a Tauri command can return it straight to the frontend as JSON.

## Public API

| Function | One-line description |
|---|---|
| `classify(path) -> FileKind` | Categorise a path by extension plus an 8 KiB NUL / non-text sniff. |
| `classify_fast(path) -> FileKind` | Extension-only classify, opens no file; unknown extensions are `Other`. |
| `list_dir(path, &ExtFilter) -> DirListing` | List one directory level: `dirs` + filtered `files`, hidden/system skipped, errors captured in `error`. |
| `read_head(path, max_bytes) -> io::Result<Head>` | Read a bounded prefix, cut on a character boundary, BOM stripped and reported in `encoding`. Capped at `MAX_HEAD_BYTES`. |
| `read_at(path, offset, len) -> io::Result<Vec<u8>>` | Byte window at an offset — the paging primitive for scrolling previews. |
| `is_ai_project(dir) -> bool` | True when the directory holds `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` / `.claude` / `.codex`. |
| `parent_of(path) -> Option<PathBuf>` | Convenience wrapper around `Path::parent`. |

`ExtFilter::Only` accepts `md`, `.md` and `*.md` alike.

Types: `FileKind` (Markdown, Text, Code, Json, Html, Table, Image, Pdf, Binary,
Other), `ExtFilter` (`Only(Vec<String>)`, `HumanReadable`, `All`), `DirEntry`,
`FileEntry`, `DirListing`, `Head`. All result types derive `serde::Serialize`.

## Example

```rust
use fsview::{classify, is_ai_project, list_dir, read_head, ExtFilter, FileKind};

let listing = list_dir("D:/notes", &ExtFilter::HumanReadable);
for f in &listing.files {
    println!("{} ({:?}, {} B)", f.name, f.kind, f.size);
}
if let Some(err) = &listing.error {
    eprintln!("unreadable: {err}");
}

let head = read_head("D:/notes/a.md", 4096)?;
println!("{} bytes shown, truncated={}", head.text.len(), head.truncated);

if is_ai_project("D:/proj") {
    assert_eq!(classify("D:/proj/pic.png"), FileKind::Image);
}
```

## Behaviour notes

- Hidden = leading `.` or the Windows HIDDEN/SYSTEM attribute.
- `read_head` never splits a UTF-8 sequence or a UTF-16 code unit: a straddling
  character is dropped and `truncated` is set. Bills a 4-byte read slack, so a
  64 KiB preview of a 10 MB log costs one small `read`, not the file.
- `classify` short-circuits on image/PDF extensions; everything else is sniffed
  only up to 8 KiB.

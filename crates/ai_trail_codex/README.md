# ai_trail_codex

Reads Codex session rollouts (`<codex-home>/sessions/YYYY/MM/DD/rollout-*.jsonl`) and
returns which files the agent **wrote** or merely **mentioned**, newest first.
Everything returned is `Serialize`, so the result can go straight out of a Tauri
command as JSON.

Rollouts are streamed line by line — a 200 MB session is never held in memory.
Bad lines, non-UTF-8 bytes, unreadable files and empty files are skipped; one
broken session never aborts a scan.

## Public API

| Item | Description |
| --- | --- |
| `scan(roots: &[PathBuf], since: Option<SystemTime>) -> Vec<TrailItem>` | Merge the trail of every rollout under `roots`. A root may be a Codex home, a `sessions/` tree, or a single rollout file. `since` skips older files by mtime and drops older events. Duplicates keep the newest event, and a write beats a mention at the same millisecond. |
| `TrailItem { path, kind, timestamp, project_dir, session_id, exists }` | One hit. `path` is a normalized absolute Windows path (`/` → `\`, `file:///` stripped). `kind` is `written` or `mentioned`. `timestamp` is epoch milliseconds. `exists` reports whether the file is on disk right now. |
| `TrailKind::{Written, Mentioned}` | Why the path is in the trail. `Written` beats `Mentioned` when deduplicating. |
| `TrailKind::as_str() -> &'static str` | Stable machine name (`"written"` / `"mentioned"`). |
| `from_millis(ms: u64) -> SystemTime` | Convenience constructor for the `since` cut-off. |

What counts as a hit:

* `apply_patch` bodies — `*** Add File:` / `*** Update File:` → `written`
* `FileChange` items (`changes` map) → `written`
* assistant prose (`message` with `role: "assistant"`, `AgentMessage`) containing a
  Windows absolute path (`D:\…` or `\\server\share\…`) → `mentioned`

Bare drive roots (`C:`), folder-only paths and relative paths are ignored.

## Example

```rust
use std::path::PathBuf;
use ai_trail_codex::{scan, TrailKind};

let roots = vec![PathBuf::from(r"C:\Users\User\.codex")];
for item in scan(&roots, None) {
    if item.kind == TrailKind::Written {
        println!("{}", item.path);
    }
}
```

Restrict to the last day:

```rust
use std::time::{Duration, SystemTime};
let since = SystemTime::now() - Duration::from_secs(86_400);
let recent = scan(&roots, Some(since));
```

## Notes

* Read-only. Nothing in the session tree is modified.
* Since a Codex home may be a copy or backup (`C:\Users\User\.codex-*`), pass
  every home at once: results are merged and deduplicated across all of them.
* `kind` only ever upgrades — a later mention never downgrades a recorded write.
* Lines longer than 8 MiB are skipped rather than buffered whole.
* `exists` is `false` for UNC paths (`\\host\share\…`) so a scan never blocks on
  SMB. Re-check those on the frontend if you need them.
* Paths with spaces are cut at the first space, so `C:\Users\John Doe\x.md` is
  missed. Prose extraction is a best-effort hint; patch/`FileChange` hits are exact.

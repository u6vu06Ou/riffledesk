---
name: riffledesk
description: Use when the user asks to find a file ("find the file where…", 找檔／哪個檔案), when you finish files they should look at (report, note, page, shortlist), or when they hand back HTML revamp feedback. Drives the local riffledesk CLI — full-text search, opening or piling files into their browser tabs, and the HTML revamp-list round trip.
---

# riffledesk

The user's local file browser. On Windows always call `riffledesk.cmd`, never the
bare `riffledesk` — that shim is a POSIX sh script, Git Bash forks several sh
children per run, and enterprise EDR (Trend Micro Apex One behavior monitoring)
blocks each fork as process injection, so bare calls fail and retry. On
macOS/Linux plain `riffledesk` is fine. `node <repo>/bin/riffledesk.js` works
everywhere. (Examples below write the short name — on Windows substitute
`riffledesk.cmd`.)
Port: `RIFFLEDESK_PORT`, then `PORT`, else 5177; pass `--port N` when unsure.

## Finding a file
Inside a known project use grep/ripgrep — faster, gives line numbers. Use
`riffledesk search` when you do NOT know where the file is (other projects, whole
drives, "the file an AI gave me last week"): `riffledesk search "text" --in ~/notes
--ext .md --json` → `[{path, mtime, size, hits, snippet}]`, exit 1 = no matches.

## Handing a file to the user
No pop-up, no context theft; the user gets a notification, tabs stay put.
`riffledesk open path/to/report.md` (`--line 42` reveals a line) reports `pushed to
N tab(s)`, or `no browser tab connected` plus a URL on stderr. With no server it
starts one headless first; with no desktop it prints the URL — give it to them.
`--print-url` forces printing.

## Showing several files at once
When the answer is a set — search hits to scroll, the files you just produced,
everything gathered on one topic — send ONE pile. Only those cards show;
unrelated files in the same folder stay hidden.

```sh
riffledesk show a.md b.md --title "Retry budget — 3 notes"
riffledesk search "retry budget" --json | riffledesk show --title "Retry budget"
```

Paths come as arguments or on stdin (JSON array from `search --json`, or one per
line). Duplicates collapse, unusable paths go to stderr, at most 500. Like `open`
it only notifies — the user clicks the notification or the left column — and it
prints `/?pile=<id>` when no tab is connected. Prefer `show` over N × `open`.

## When you generate HTML
- Choose the format that explains the user's task. Markdown remains valid;
  HTML may mix text, images, SVG diagrams and an embedded interactive three.js
  figure. No extra skill or fixed template is required. See [delivery capabilities](DELIVERABLES.md)
  only when richer output would help.
- Mark editable regions `data-rd-id="unique-name"` — the revamp list finds
  elements by that id, so feedback survives edits.
- Relative paths, no `file:///C:/...`; layout and text in the DOM, not a canvas.

## Revamp feedback loop
The user edits the page and presses "hand to AI", which writes
`<file>.changes.json` (plus a screenshot) beside it. Start `wait` *before* they
press — it only accepts a `pending` list newer than when it started (exit 3 =
timeout).

```sh
riffledesk open page.html            # 1. show the page
riffledesk wait page.html            # 2. block until they hand it over
riffledesk changes page.html         # 3. read: summary + per-item locator
riffledesk changes page.html --done  # 4. mark handled, after editing
riffledesk open page.html            # 5. show the result
```

Item fields: `op` (`edit-text|move|resize|delete|note|region-note`),
`rdId`/`selector`/`textHint`, `before`/`after`, `note`, `rect`/`dx`/`dy`. A done
list still prints, prefixed `(already handled)`. Apply every item, then `--done`.

## Other
- `riffledesk install-skill [--claude] [--dest <dir>]` (identical copy left
  alone; a different one backed up under `skills-backup/riffledesk-<time>/`, so
  it is not loaded as a second skill).
- `riffledesk --help` / `<cmd> --help` for flags and exit codes (2 = bad usage
  or missing path; read stderr first).

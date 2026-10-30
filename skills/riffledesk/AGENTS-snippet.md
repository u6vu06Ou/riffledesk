## riffledesk (local file browser)

`riffledesk` is on PATH. Port: `RIFFLEDESK_PORT`, else `PORT`, else 5177 (`--port N`).

- Find a file: in a known project use grep; when you don't know where it is (other projects, whole drives, "what an AI gave me") use `riffledesk search "text" [--in <dir>] --json` (exit 1 = no match).
- After writing a file the user should read: `riffledesk open <file>` — pushes into their tabs, no pop-up.
- Several related files as a set: `riffledesk show a.md b.md --title "…"` (or pipe `search --json`) — one stack, only those cards.
- HTML you generate: editable elements get `data-rd-id="name"`, relative paths, no editable content in canvas.
- Revamp loop: `riffledesk open p.html` → user presses "hand to AI" → `riffledesk wait p.html` (start it *before* they press; exit 3 = timeout) → `riffledesk changes p.html` → edit → `riffledesk changes p.html --done`.
- No server: `open`/`search` start one headless (10 s), or print the URL when there is no desktop. Exit 2 = bad usage, read stderr.

# Changes

## 0.4.3 — 2026-11-05

- Tests no longer depend on the browsable-drive allowance: `collectDrives()` honours a test-only `RIFFLEDESK_TEST_DRIVES` (path-delimiter separated, active only with `NODE_ENV=test`, appended to by tests so a narrow scope can be forced on any host) and the fixtures that live in `os.tmpdir()` declare their temp dir as a "drive". On Windows the temp dir merely happens to sit on an allowed drive; on POSIX (`/var/folders/…` on macOS) it is outside home + mounts, so indexer (deepCount / outside-the-indexed-scope search), revise `/raw/` revise, server `/api/drives` and the POSIX-only project 403 assertion were getting 403s. Index scope is untouched (temp dirs are browsable but not indexed). Production drive discovery is unchanged.
- Polish UI wording (zh-TW and English): agent delivery copy no longer reads 「AI 給你看／AI 打開了」 — notifications are now 「已交付：{name}」/「已交付 {n} 個檔案」 (en "Delivered…"), the pile breadcrumb is 「交付：{title}（{n} 個）」, the just-projected sidebar section is 「剛收到的檔案」 ("Just received"), and the settings slab is 「投影（Agent 交付檔案）」. Glossary unified: 卡片堆, 閱讀區, 側邊欄（模式）, full-width punctuation in zh strings; en filter hint says "filters what is on screen, not what agents deliver"; extension drawer note reworded （抽屜位置， 拖抽屜內緣把手可調整寬度 / "Drawer position"）.
- macOS/Linux drivable scope: the drives list no longer offers the filesystem root `/` (which made every path — system folders included — browsable and made out-of-scope tests impossible to write portably). POSIX now lists the user's home plus mounted volumes: macOS gets `/Volumes/*` except the boot volume and its data twin (a realpath of `/` or `/System/Volumes/…` — both would re-open the whole disk, Catalina+ makes that reachable through `Macintosh HD`/`Macintosh HD - Data`), Linux/WSL gets `/mnt/*` and `/media/<user>/*` plus `/run/media/<user>/*` (udisks2), or all of `/media/*` when the user cannot be resolved (the bare `/media` directory itself is not listed). A mount whose realpath cannot be resolved is still offered. Windows is unchanged (still every fixed drive letter). Everything else stays available through config `roots`/`pinned`; see README "Platform notes".
- macOS test fixes: `t.test.skip` (not a TestContext method, TypeError on Node 24) replaced by the `{ skip }` option; writeAtomic's Windows-only rename-retry + in-place-overwrite tests are now skipped off-win32 instead of failing; out-of-scope 403 tests (server/save/project/revise/raw/fileops) pick a path that is out of scope on every OS; case-variant tests probe the fixture filesystem's case sensitivity at runtime instead of assuming (default APFS is case-insensitive), including the convos `fileCount`/file-list expectations for `BETA.MD` vs `beta.md`.
- Fix `install-skill` backup pruning to order backups chronologically instead of lexicographically: past the 10th same-second backup, lexicographic order ranks `riffledesk-…-10` before `riffledesk-…-2`, so an older backup could survive while a newer one was pruned. A seeded same-second regression test pins the order on every OS.
- Every browser e2e script shares `tests/chrome-path.mjs`: `$CHROME_PATH` first, then Windows Program Files/%LOCALAPPDATA% Chrome & Edge, macOS `/Applications/*.app`, Linux `google-chrome`/`chromium` on PATH; extension tests prefer a playwright-bundled Chromium (branded Chrome headless skips extensions). Replaces the hardcoded `C:\Program Files\…\chrome.exe` in 34 scripts.
- package.json "description" said "read-only"; now "local-first … edits, renames and deletes are explicit, opt-in and undoable" (they exist: save/rename/trash/undo).
- New `tests/drives-platform.test.mjs`: simulates darwin/linux volume layouts with stubbed I/O so the POSIX scope semantics are covered without a Mac.
- Bump the extension manifest to 0.4.3 (Chrome and Firefox).

Validation: Windows 318 unit tests, 317 passed, one POSIX-only skip, no failures. Real macOS 12.7.6 (Intel, Node 22.23.4): 317 unit tests, 309 passed, 8 Windows-only skips, no failures; drives list = home + external volumes, boot volume excluded. Browser e2e results on macOS match Windows except a frame-rate check on a 2014 Intel Mac mini.

## 0.4.2 — 2026-11-04

- Add `riffledesk hook install|uninstall|status|check`: an opt-in Claude Code Stop hook that reminds the agent once, as it is about to finish, when it wrote deliverable files without handing them over via `riffledesk open` / `riffledesk show`. `install` merges into the settings file (other hooks untouched, .bak first, idempotent, invalid JSON refused); `check` reads only the transcript tail, never loops on stop_hook_active, and exits silently on any error so the nudge can never block a session.
- Drawer no longer changes the page zoom / shows Chrome's zoom bubble when the pointer moves in and out. It used to switch the tab's zoom mode on every hover, which resets the zoom level; now Ctrl+wheel, pinch and Ctrl +/-/0 are swallowed inside the drawer only. A one-time startup migration restores any tab left in the old disabled zoom mode.
- Bump the extension manifest to 0.4.2 (Chrome and Firefox).

Validation: 303 unit tests passed, one skipped, no failures. drawer (44 checks) and drawer-view (19 checks) e2e passed.

## 0.4.1 — 2026-11-04

- Fix the auto-hide drawer being unreachable on pages with a classic (non-overlay) Windows scrollbar: the invisible trigger strip aligns to the layout viewport, which excludes the scrollbar, so a pointer slammed to the physical screen edge sat on the scrollbar and never touched the strip. The strip is wider now (12 px) and a window-level mousemove fallback runs the same dwell logic once the pointer reaches the layout-viewport edge (classic scrollbars still deliver mousemove past documentElement.clientWidth); button-held moves (scrollbar drags) do not trigger.
- Add a drawer side setting (right/left, default right) on the options page that live-applies to open tabs: trigger strip, slide direction, and resize grip all mirror.
- Make the drawer orphan-safe: extension API calls that can throw "Extension context invalidated" after a reload now tear the drawer UI down and clear its occupancy flag instead of leaving a dead shell, so background re-seeding revives it.
- Bump the extension manifest from 0.1.0 to 0.4.1 (both Chrome and Firefox copies) so a reload fires onInstalled and re-seeds old tabs. From now on the extension and the npm package share one version number and are bumped together; any change under extension/ requires a bump.
- Compute card change badges (git +N −M) off the event loop (async execFile with a concurrency cap in pile listings) instead of blocking it with execFileSync.
- Release all blob URLs a PPTX parse created once a thumbnail is produced, instead of leaking them until the next render.
- Replace hardcoded developer machine paths in two test/verification scripts with repo-root-relative resolution.

Validation: 270 unit tests passed, one skipped, no failures. drawer-scrollbar (27 checks), drawer, drawer-view and pptx e2e passed. The classic-scrollbar case is verified with synthetic events because headless Chromium renders no layout-width scrollbar.

## 0.4.0 — 2026-11-03

- Add book-style Markdown reading and optional illustrated and interactive 3D document examples, with bundled three.js assets and no required agent template.
- Keep reader headers on one line and size/close controls in the same corner across reader sizes; support videos within documents and picture-in-picture playback.
- Replace the crowded file-type buttons with a persistent multi-select menu. Agent handoff piles always show all delivered files and count only files that still exist.
- Add collapsible Agent delivery/recent sections, native conversation titles when available, first-prompt tooltips, and conversation details with session IDs and original transcript locations.
- Reuse browser-tab thumbnail textures when only active state or header text changes, preserving card order and position.
- Keep file-update notifications out of browser-tab mode and refresh the current mode without switching to files. Use updated delivery wording in Chinese and English.
- Preserve the loaded side-panel view through health-check failures and recovery, showing a connection status instead of unloading the app.

Validation: 270 unit tests passed, one skipped, no failures. Targeted reader-layout, side-panel, extension side-panel/reconnection, browser-tab, pile and projection checks passed. Existing headless hover/geometry failures documented under 0.3.0 remain separate investigations.

## 0.3.0 — 2026-11-03

- Start a detached background server by default from the CLI, npm start, and platform launchers. Repeated launches reuse the same port. Foreground mode remains available for development.
- Show the running version and restart/stop buttons in Settings; add equivalent status, restart, and stop CLI commands. Lifecycle requests require the current instance ID and same-origin or explicit local CLI requests.
- Include the pending PowerPoint preview implementation: slide text/images, first-slide thumbnails, file-type filtering, and reader search. Preview is approximate; PowerPoint content is not included in full-text indexing.
- Hide git subprocess windows when computing file-change badges on Windows.
- Use the Windows command shim in bundled agent instructions to avoid Git Bash antivirus interference.
- Include the bundled ZIP reader's MIT license.

Validation: the unit suite passed 265 tests with one skipped test and no failures. Targeted PowerPoint, projection, and background lifecycle/browser checks passed. The main headless browser suite has 35 existing failures with identical failure lists on the unchanged baseline. Two conversation-hover regression checks also failed on both this release and an independently extracted unchanged baseline; these remain separate investigations.

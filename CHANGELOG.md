# Changes

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

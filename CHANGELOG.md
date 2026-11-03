# Changes

## 0.3.0 — 2026-11-03

- Start a detached background server by default from the CLI, npm start, and platform launchers. Repeated launches reuse the same port. Foreground mode remains available for development.
- Show the running version and restart/stop buttons in Settings; add equivalent status, restart, and stop CLI commands. Lifecycle requests require the current instance ID and same-origin or explicit local CLI requests.
- Include the pending PowerPoint preview implementation: slide text/images, first-slide thumbnails, file-type filtering, and reader search. Preview is approximate; PowerPoint content is not included in full-text indexing.
- Hide git subprocess windows when computing file-change badges on Windows.
- Use the Windows command shim in bundled agent instructions to avoid Git Bash antivirus interference.
- Include the bundled ZIP reader's MIT license.

Validation: the unit suite passed 265 tests with one skipped test and no failures. Targeted PowerPoint, projection, and background lifecycle/browser checks passed. The main headless browser suite has 35 existing failures with identical failure lists on the unchanged baseline. Two conversation-hover regression checks also failed on both this release and an independently extracted unchanged baseline; these remain separate investigations.

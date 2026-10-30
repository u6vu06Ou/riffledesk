// countcache.js — decides WHETHER a caller may re-run an expensive counter.
//
// /api/index/status is polled by the UI and historically ran two full-table
// COUNT(*) scans of a 380k-row `files` table on every single poll. Those scans
// hold a WAL read snapshot for their duration, so with polling on they were
// effectively continuous and the worker's TRUNCATE checkpoint lost its race
// over and over — the -wal file never shrank (399 MB observed in the field).
//
// The counters only feed a number on screen, so they are cached instead:
//   - reused while the worker's change generation (`gen`) is unchanged,
//   - reused for at most `ttlMs` even then (a quiet index still refreshes),
//   - and, while a crawl is running (it ticks `gen` constantly), at most one
//     scan per `minGapMs`. Once the crawl ends the next call always rescans,
//     so a finished crawl is reflected immediately instead of 5 s later.
//
// Kept as a separate module so the policy is unit-testable without a server.
'use strict';

function createCountCache({ ttlMs = 60000, minGapMs = 5000, now = Date.now } = {}) {
  const state = { gen: -1, at: 0, files: null, filesWithContent: null };
  let populated = false;

  // True when the caller should actually run the scans. `gen` is the current
  // change generation and `crawling` the worker's crawl flag; neither read
  // costs a table scan.
  function shouldScan(gen, crawling = false) {
    const t = now();
    if (!populated) return true;                          // never scanned
    if (t - state.at >= ttlMs) return true;               // max staleness hit
    if (state.gen !== gen) return crawling ? t - state.at >= minGapMs : true;
    return false;
  }

  // Record a completed scan attempt for `gen` at the current time. Value may be
  // null when the scan failed; `populated` still flips so a persistently
  // failing scan backs off instead of hammering every call.
  function record(gen, files, filesWithContent) {
    state.gen = gen;
    state.at = now();
    state.files = files;
    state.filesWithContent = filesWithContent;
    populated = true;
  }

  // copy, so callers cannot mutate the invariants through the returned object
  function peek() { return { ...state }; }

  return { shouldScan, record, peek };
}

module.exports = { createCountCache };

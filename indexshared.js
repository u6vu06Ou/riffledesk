// indexshared.js — pure helpers shared by indexer.js (main thread) and
// indexer-worker.js (worker thread; cannot receive functions via postMessage).
// Each is an EXACT copy of the same-named function in server.js — if you change
// a copy in server.js (norm/parseExts/countOccurrences/makeSnippet), change it
// here too, or indexed results will drift from live-scan results.
'use strict';

const path = require('node:path');

// server.js norm(): win32 → lowercase + unified separators, no trailing sep;
// POSIX strips only trailing '/'. Root '/' survives.
function makeNorm(IS_WIN) {
  return function norm(p) {
    let r = path.resolve(p).replace(IS_WIN ? /[/\\]+$/ : /\/+$/, '');
    if (!r) r = '/';
    return IS_WIN ? r.toLowerCase() : r;
  };
}

// server.js parseExts(): 'all' → everything; 'readable' → known kinds; else list
function parseExts(raw) {
  if (raw == null || raw === '') return { mode: 'readable' };
  if (raw === 'all') return { mode: 'all' };
  if (raw === 'readable') return { mode: 'readable' };
  const set = new Set(raw.split(',').map(s => {
    s = s.trim().toLowerCase();
    return s && !s.startsWith('.') ? '.' + s : s;
  }).filter(s => s.length > 1));
  return { mode: 'set', set };
}

// server.js countOccurrences()
function countOccurrences(hay, needle) {
  let n = 0, i = 0;
  for (;;) {
    i = hay.indexOf(needle, i);
    if (i === -1) return n;
    n++; i += needle.length;
  }
}

// server.js makeSnippet(): ~120 chars around the first match, single line
function makeSnippet(content, idx, qlen) {
  const start = Math.max(0, idx - 40);
  let snip = content.slice(start, Math.min(content.length, idx + qlen + 80))
    .replace(/\s+/g, ' ').trim();
  if (snip.length > 120) snip = snip.slice(0, 117) + '…';
  return snip;
}

// node:sqlite prints an ExperimentalWarning on require; swallow exactly that one.
function loadSqlite() {
  const origEmit = process.emitWarning;
  process.emitWarning = function (warning, ...args) {
    const text = typeof warning === 'string' ? warning : (warning && warning.message) || '';
    if (/SQLite is an experimental feature/.test(text)) return;
    return origEmit.call(process, warning, ...args);
  };
  try {
    return require('node:sqlite');
  } catch (_) {
    return null;
  } finally {
    process.emitWarning = origEmit;
  }
}

module.exports = { makeNorm, parseExts, countOccurrences, makeSnippet, loadSqlite };

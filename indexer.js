// indexer.js — persistent full-text index for /api/search + /api/list deep counts
// (node:sqlite, FTS5 trigram). Zero dependencies beyond Node itself.
//
// Two halves:
//   - indexer-worker.js (worker thread) owns the DB for ALL writes and runs the
//     crawler + heavy searches. Real-text trigram inserts cost 30–85 ms per
//     256 KB chunk on the production corpus, and COMMITs occasionally 50+ ms —
//     on the main loop those stalled /api/list to 130–270 ms, over the < 100 ms
//     crawl-time budget. Off-thread, stalls simply cannot reach the API.
//   - this file (main thread) keeps a query-only connection for the CHEAP paths:
//     deepCounts/status/covered. WAL mode lets these read while the worker writes.
//
// If node:sqlite or the worker is unavailable, `available` stays false and every
// method degrades to a no-op / null so the server falls back to the live scan.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { loadSqlite } = require('./indexshared');
const { createCountCache } = require('./countcache');

// Full recrawl cadence: once a day. fs.watch keeps the index live within ~1.5 s
// between crawls (watcher errors self-heal by resyncing the root, and roots that
// cannot be watched at all get a slower periodic rescan in the worker), so the
// hourly pass was pure churn. config.indexRecrawlHours tunes it; the env vars
// stay as test overrides. Exported for unit tests.
const DEFAULT_RECRAWL_HOURS = 24;
function resolveRecrawlMs(env, opts) {
  const e = Number(env && env.RIFFLEDESK_RECRAWL_MS);
  if (Number.isFinite(e) && e > 0) return e;
  const h = opts ? Number(opts.recrawlHours) : NaN;
  return (Number.isFinite(h) && h > 0 ? h : DEFAULT_RECRAWL_HOURS) * 3600000;
}
function resolveBootStaleMs(env, opts) {
  const e = Number(env && env.RIFFLEDESK_BOOT_STALE_MS);
  if (Number.isFinite(e) && e > 0) return e;
  return resolveRecrawlMs(env, opts);
}
function fmtAge(ms) { return ms < 2 * 3600000 ? `${Math.round(ms / 60000)} min` : `${(ms / 3600000).toFixed(1)} h`; }

function createIndexer(deps) {
  const {
    dbPath, norm, parseExts, getRoots, getScopes, getIndexOptions,
    READABLE_EXTS, KIND, TEXTLIKE,
    log = () => {}
  } = deps;

  const sqlite = loadSqlite();
  const idx = {
    available: false,
    crawling: false,
    lastCrawlMs: null,
    lastCrawlAt: null,
    schedule, crawlAll, crawlRoot, stop,
    search, deepCounts, status, reindexDir, noteListDir, noteSearchOutside,
    renamed, removed, setContentEnabled, secretFlags, directCounts, listPage,
    recentModified, nameSearch
  };
  if (!sqlite) return idx;

  const IS_WIN = process.platform === 'win32';
  const SEP = path.sep;
  const READABLE_LIST = [...READABLE_EXTS];

  // ---------- worker lifecycle ----------
  let worker = null;
  let ready = false;
  let stopping = false;
  let spawned = false;
  let backlog = [];
  let lastKnownFiles = 0;
  let nextSearchId = 1;
  const pendingSearches = new Map();

  function failWorker(reason) {
    if (!worker && !ready) return;
    log(`index: worker ${reason} — live scan only`);
    idx.available = false;
    idx.crawling = false;
    ready = false;
    for (const p of pendingSearches.values()) p.resolve(null);
    pendingSearches.clear();
    for (const p of pendingToggles.values()) p.resolve(null);
    pendingToggles.clear();
    try { worker && worker.terminate(); } catch (_) {}
    worker = null;
  }

  function spawnWorker() {
    if (spawned) return;
    spawned = true;
    try {
      worker = new Worker(path.join(__dirname, 'indexer-worker.js'), {
        workerData: {
          dbPath,
          isWin: IS_WIN,
          sep: SEP,
          kind: KIND,
          textlike: [...TEXTLIKE],
          readable: READABLE_LIST,
          debugFlush: process.env.RIFFLEDESK_DEBUG_FLUSH === '1'
        }
      });
      worker.unref(); // never keep the server process alive just for the index
    } catch (err) {
      spawned = false;
      log(`index: worker spawn failed (${err.message}) — live scan only`);
      worker = null;
      return;
    }
    worker.on('message', m => {
      if (!m || typeof m !== 'object') return;
      if (m.type === 'ready') {
        if (m.available) {
          idx.available = true;
          ready = true;
          if (typeof m.lastCrawlMs === 'number') idx.lastCrawlMs = m.lastCrawlMs;
          if (typeof m.lastCrawlAt === 'number') idx.lastCrawlAt = m.lastCrawlAt;
          if (typeof m.files === 'number') lastKnownFiles = m.files;
          aggPendingFromWorker = !!m.aggPending;
          for (const msg of backlog) { try { worker.postMessage(msg); } catch (_) {} }
          backlog = [];
          scheduleActuallyCalled && maybeBootCrawl();
        } else {
          log(`index: worker reports unavailable (${m.error || 'no node:sqlite'}) — live scan only`);
          failWorker('unavailable');
        }
      } else if (m.type === 'status') {
        idx.crawling = !!m.crawling;
        if (typeof m.lastCrawlMs === 'number') idx.lastCrawlMs = m.lastCrawlMs;
        if (typeof m.lastCrawlAt === 'number') idx.lastCrawlAt = m.lastCrawlAt;
        if (typeof m.files === 'number') lastKnownFiles = m.files;
      } else if (m.type === 'log') {
        log(m.msg);
      } else if (m.type === 'contentToggled') {
        const p = pendingToggles.get(m.id);
        if (p) { pendingToggles.delete(m.id); p.resolve(m.on); }
      } else if (m.type === 'search') {
        const p = pendingSearches.get(m.id);
        if (p) {
          pendingSearches.delete(m.id);
          if (m.error) log(`index: search failed in worker (${m.error}) — live scan fallback`);
          p.resolve(m.result || null);
        }
      }
    });
    worker.on('error', err => failWorker(`error (${err.message})`));
    worker.on('exit', code => { if (!stopping && code !== 0) failWorker(`exited (code ${code})`); });
  }

  function send(message) {
    if (worker && ready) {
      try { worker.postMessage(message); return; } catch (_) {}
    }
    if (worker) backlog.push(message); // arrived before 'ready'
  }

  // ---------- main-side read-only queries (cheap ones only) ----------
  let readDb = null, readFailed = false, readStmtCache = new Map();
  function openRead() {
    if (readDb || readFailed) return readDb;
    try {
      readDb = new sqlite.DatabaseSync(dbPath);
      readDb.exec('PRAGMA query_only = ON');
      // same reason as the worker's: a writer holding the WAL lock must not make
      // these reads return SQLITE_BUSY instantly. 1 s (not the worker's 2 s)
      // because this runs on the main loop and the callers are poll endpoints.
      readDb.exec('PRAGMA busy_timeout = 1000');
      return readDb;
    } catch (_) {
      // a half-configured connection must not be handed out on later calls
      try { readDb && readDb.close(); } catch (_) {}
      readDb = null;
      readFailed = true; // DB not created yet (worker not ready) — try again later
      return null;
    }
  }
  function rprep(sql) {
    let s = readStmtCache.get(sql);
    if (!s) { s = readDb.prepare(sql); readStmtCache.set(sql, s); }
    return s;
  }

  function extraRootsLive() {
    const d = openRead();
    if (!d) return [];
    try {
      const r = rprep('SELECT value FROM meta WHERE key = ?').get('extraRoots');
      const arr = JSON.parse(r ? r.value : '[]');
      return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
  }

  function mainRoots() {
    const out = [];
    const seen = new Set();
    for (const r of getRoots()) {
      const n = norm(r);
      if (!seen.has(n)) { seen.add(n); out.push(r); }
    }
    for (const r of extraRootsLive()) {
      const n = norm(r);
      if (!seen.has(n)) { seen.add(n); out.push(r); }
    }
    return out;
  }

  function rootCovering(absNorm) {
    for (const r of mainRoots()) {
      const rn = norm(r);
      if (absNorm === rn) return rn;
      if (rn === SEP && absNorm.startsWith(SEP)) return rn;             // POSIX '/'
      if (absNorm.startsWith(rn + SEP)) return rn;
    }
    return null;
  }

  function covered(absNorm) {
    const rn = rootCovering(absNorm);
    if (rn === null) return false;
    const d = openRead();
    if (d) {
      try {
        const r = rprep('SELECT value FROM meta WHERE key = ?').get('crawled:' + rn);
        if (r) return true;
      } catch (_) { /* busy: fall through to false */ }
    }
    return false;
  }

  // ---------- crawl control (timers live here; work happens in the worker) ----------
  let crawlTimer = null, intervalTimer = null;
  let scheduleActuallyCalled = false;
  let aggPendingFromWorker = false;
  let bootCrawlFired = false;

  function crawlJob() {
    const { scopes, realScopes } = getScopes();
    const opts = getIndexOptions ? getIndexOptions() : {};
    return {
      op: 'crawl', roots: getRoots(), scopes, realScopes,
      skipDirs: opts.skipDirs || [],
      maxMB: (typeof opts.maxMB === 'number' ? opts.maxMB : 2048),
      contentEnabled: opts.contentEnabled !== false,
      secretScan: opts.secretScan !== false,
      secretSkipDirs: Array.isArray(opts.secretSkipDirs) ? opts.secretSkipDirs : []
    };
  }

  // boot crawl only when the index is MISSING or STALE (fresh boot scans every
  // launch burned ~40% of a core for 1-2 min on the production corpus). The
  // crawler is mostly a safety net now: fs.watch between crawls keeps the DB
  // (and the diragg rollups) current within seconds.
  function recrawlMs() { return resolveRecrawlMs(process.env, getIndexOptions ? getIndexOptions() : null); }
  function bootStaleMs() { return resolveBootStaleMs(process.env, getIndexOptions ? getIndexOptions() : null); }

  function maybeBootCrawl() {
    if (bootCrawlFired) return;
    bootCrawlFired = true;
    const stale = !idx.lastCrawlAt || (Date.now() - idx.lastCrawlAt > bootStaleMs());
    if (stale || aggPendingFromWorker) {
      if (aggPendingFromWorker && !stale) log('index: diragg rollup missing — boot crawl to build it');
      send(crawlJob());
    } else {
      log(`index: boot crawl skipped (last crawl ${fmtAge(Date.now() - idx.lastCrawlAt)} ago; watchers keep the index live)`);
    }
  }

  function schedule() {
    spawnWorker();
    scheduleActuallyCalled = true;
    maybeBootCrawl(); // no-op until the worker's 'ready' set lastCrawlAt
    const { scopes, realScopes } = getScopes();
    send({ op: 'watch', roots: getRoots(), scopes, realScopes }); // watchers do not need a crawl
    intervalTimer = setInterval(() => send(crawlJob()), recrawlMs());
    intervalTimer.unref();
  }

  function stop() {
    stopping = true;
    if (crawlTimer) clearTimeout(crawlTimer);
    if (intervalTimer) clearInterval(intervalTimer);
    for (const p of pendingSearches.values()) p.resolve(null);
    pendingSearches.clear();
    for (const p of pendingToggles.values()) p.resolve(null);
    pendingToggles.clear();
    if (worker) { try { worker.terminate(); } catch (_) {} worker = null; }
    if (readDb) { try { readDb.close(); } catch (_) {} readDb = null; }
  }

  function crawlAll() { send(crawlJob()); }
  function crawlRoot(_rootAbs) { send(crawlJob()); } // jobs always refresh all roots
  function reindexDir(abs) { send({ op: 'reindexDir', abs }); }

  function renamed(oldAbs, newAbs) { send({ op: 'renamed', oldAbs, newAbs }); }
  function removed(abs) { send({ op: 'removed', abs }); }

  // content layer (FTS) on/off, from the worker's meta — when off, indexed
  // search declines so the server falls back to the live scan by contract
  function contentLayerOn() {
    const d = openRead();
    if (!d) return true;
    try {
      const r = rprep('SELECT value FROM meta WHERE key = ?').get('indexContent');
      return !(r && r.value === '0');
    } catch (_) { return true; }
  }

  // ---------- search: delegated to the worker (heavy; keep off the main loop) ----------
  async function search(rootAbs, q, extsRaw, limit) {
    if (!idx.available || !ready) return null;
    const absNorm = norm(rootAbs);
    if (!covered(absNorm)) return null;
    if (!contentLayerOn()) return null; // content layer off → live scan
    const id = nextSearchId++;
    return await new Promise(resolve => {
      const timer = setTimeout(() => {
        pendingSearches.delete(id);
        resolve(null); // worker wedged → caller falls back to the live scan
      }, 60000);
      pendingSearches.set(id, { resolve: r => { clearTimeout(timer); resolve(r); } });
      send({ op: 'search', id, rootAbs, q, extsRaw, limit });
    });
  }

  // toggle the content layer at runtime (POST /api/index/content); resolves to
  // the layer state the worker applied, or null when the index is unavailable
  const pendingToggles = new Map();
  function setContentEnabled(on) {
    if (!idx.available || !ready) return Promise.resolve(null);
    const id = nextSearchId++;
    return new Promise(resolve => {
      const timer = setTimeout(() => { pendingToggles.delete(id); resolve(null); }, 30000);
      pendingToggles.set(id, { resolve: r => { clearTimeout(timer); resolve(r); } });
      send({ op: 'contentToggle', id, on: !!on });
    });
  }

  // a whole-drive / filesystem root would turn one stray search into a marathon
  // crawl, so those never become extra roots (results still come from live scan)
  function isFsRoot(np) {
    return IS_WIN ? /^[a-z]:$/i.test(np) : np === SEP;
  }

  function noteSearchOutside(abs) {
    if (!idx.available) return;
    const absNorm = norm(abs);
    if (rootCovering(absNorm)) return; // inside a known root: the next crawl picks it up
    if (isFsRoot(absNorm)) { log(`index: not indexing filesystem root ${abs} (searched outside roots)`); return; }
    send({ op: 'extraRoot', abs });
  }

  const dirReindexInFlight = new Set();
  function noteListDir(abs) {
    if (!idx.available) return;
    const n = norm(abs);
    if (!rootCovering(n)) return;
    if (dirReindexInFlight.has(n)) return;
    dirReindexInFlight.add(n);
    send({ op: 'reindexDir', abs });
    setTimeout(() => dirReindexInFlight.delete(n), 5000).unref?.();
  }

  // ---------- queries answered locally (cheap; run on the query-only connection) ----------
  // on-disk footprint of index.db (+ WAL/SHM sidecars); null when no DB exists
  function dbBytesOnDisk() {
    let n = null;
    try { n = fs.statSync(dbPath).size; } catch (_) { return null; }
    for (const sfx of ['-wal', '-shm']) { try { n += fs.statSync(dbPath + sfx).size; } catch (_) {} }
    return n;
  }

  // ---------- status() counts, cached ----------
  // The UI polls /api/index/status, and both counts are FULL TABLE SCANS of a
  // 380k-row table. Doing that on every poll kept a read snapshot open almost
  // continuously, so the worker's TRUNCATE checkpoint lost its race over and
  // over and the WAL never shrank. The policy (gen-keyed, TTL, min gap) lives
  // in countcache.js so it is unit-tested without a server; see its header.
  const countCache = createCountCache({ ttlMs: 60000, minGapMs: 5000 });
  function statusCounts() {
    const gen = currentGen(); // one cheap meta lookup, not a table scan
    if (countCache.shouldScan(gen, idx.crawling)) {
      // gen read before the scans and recorded with them: a change landing
      // mid-scan is recorded under the older gen, so the next poll rescans —
      // slightly early beats serving a number we know may be stale.
      let files = null, filesWithContent = null;
      try { files = rprep('SELECT COUNT(*) AS n FROM files').get().n; } catch (_) {}
      try { filesWithContent = rprep('SELECT COUNT(*) AS n FROM files WHERE has_content = 1').get().n; } catch (_) {}
      // record even on failure (nulls) so a persistently failing scan still
      // honours the TTL/min-gap instead of re-running on every single poll
      countCache.record(gen, files, filesWithContent);
    }
    return countCache.peek();
  }

  function status() {
    if (!idx.available) {
      return { available: false, files: 0, filesWithContent: 0, capped: false, contentEnabled: null, roots: [], crawling: false, lastCrawlMs: null, lastCrawlAt: null, dbBytes: dbBytesOnDisk() };
    }
    let files = lastKnownFiles;
    let filesWithContent = null;
    let capped = false;
    let contentEnabled = null;
    const d = openRead();
    if (d) {
      const c = statusCounts();
      if (c.files != null) files = c.files;
      if (c.filesWithContent != null) filesWithContent = c.filesWithContent;
      try { capped = (rprep('SELECT value FROM meta WHERE key = ?').get('indexCapped') || {}).value === '1'; } catch (_) {}
      try { contentEnabled = (rprep('SELECT value FROM meta WHERE key = ?').get('indexContent') || {}).value !== '0'; } catch (_) {}
    }
    return {
      available: true,
      files,
      filesWithContent,
      capped,
      contentEnabled,
      roots: mainRoots(),
      crawling: idx.crawling,
      lastCrawlMs: idx.lastCrawlMs,
      lastCrawlAt: idx.lastCrawlAt,
      dbBytes: dbBytesOnDisk()
    };
  }

  // prefix match without substr: half-open range [n+SEP, n+SEP+1) — sargable on
  // dirs.path's UNIQUE index, no JS-vs-SQLite string-length disagreement
  function underPrefix(col, n) {
    const lo = n + SEP;
    const hi = n + String.fromCharCode(SEP.charCodeAt(0) + 1);
    return { sql: `(${col} = ? OR (${col} >= ? AND ${col} < ?))`, args: [n, lo, hi] };
  }

  function prefixClause(absNorm) {
    if (absNorm === '/') return { sql: '', args: [] };
    const up = underPrefix('path', absNorm);
    return {
      sql: ` AND f.dirid IN (SELECT id FROM dirs WHERE ${up.sql})`,
      args: up.args
    };
  }

  function deepExtClause(filter) {
    // /api/list semantics: 'all' → every file; 'readable' → all known kinds;
    // 'set' → the given extensions.
    if (!filter || filter.mode === 'all') return { sql: '', args: [] };
    if (filter.mode === 'readable') {
      return { sql: ` AND f.ext IN (${READABLE_LIST.map(() => '?').join(',')})`, args: [...READABLE_LIST] };
    }
    if (!filter.set.size) return { sql: ' AND 1 = 0', args: [] };
    return { sql: ' AND f.ext IN (' + [...filter.set].map(() => '?').join(',') + ')', args: [...filter.set] };
  }

  // One indexed prefix query bucketed per direct subdir in JS — no filesystem
  // walk. Returns Map(norm(subdirPath) -> count | null): null when that subdir's
  // tree has not completed a crawl yet.
  // per-name secret flags for ONE directory (used by /api/list to mark files).
  // value: true = suspected secret, false = scanned clean; names with NULL
  // ("never scanned") are ABSENT so the caller can fall back to a cheap
  // on-demand scan. Returns null when the index cannot answer (unavailable,
  // worker still on a pre-v7 schema — the caller then treats every file as
  // unknown).
  function secretFlags(absNorm) {
    if (!idx.available) return null;
    const d = openRead();
    if (!d) return null;
    try {
      const dirRow = rprep('SELECT id FROM dirs WHERE path = ?').get(absNorm);
      if (!dirRow) return new Map();
      const m = new Map();
      const fold = IS_WIN ? s => s.toLowerCase() : s => s;
      for (const r of rprep('SELECT name, secret FROM files WHERE dirid = ?').all(dirRow.id)) {
        if (r.secret !== null && r.secret !== undefined) m.set(fold(r.name), r.secret === 1);
      }
      return m;
    } catch (_) { return null; }
  }

  // ---------- v8 rollup queries (diragg): counts no longer scale with subtree size ----------
  // The worker's meta 'gen' ticks on every committed data change; we memoize the
  // folded rollup per (folder, exts) and recompute only when gen moved. Between
  // crawls the worker keeps diragg exact via write-path deltas / fs.watch, and
  // crawls rebuild it wholesale; 'aggready:<root>' marks a root whose rollup
  // exists. Without it the API returns null counts ('… 稍後填入') instead of
  // blocking the click on a subtree scan.
  function metaVal(k) {
    const d = openRead();
    if (!d) return null;
    try { const r = rprep('SELECT value FROM meta WHERE key = ?').get(k); return r ? r.value : null; } catch (_) { return null; }
  }
  function currentGen() { const v = metaVal('gen'); return v == null ? 0 : Number(v) || 0; }
  function aggReady(rootNorm) { return rootNorm !== null && metaVal('aggready:' + rootNorm) != null; }

  // same semantics as deepExtClause but against a.ext (diragg) / used for files too
  function aggExtClause(filter, col) {
    if (!filter || filter.mode === 'all') return { sql: '', args: [] };
    if (filter.mode === 'readable') {
      return { sql: ` AND ${col} IN (${READABLE_LIST.map(() => '?').join(',')})`, args: [...READABLE_LIST] };
    }
    if (!filter.set.size) return { sql: ' AND 1 = 0', args: [] };
    return { sql: ` AND ${col} IN (${[...filter.set].map(() => '?').join(',')})`, args: [...filter.set] };
  }

  const deepMemo = new Map(); // `${absNorm}|${extsRaw}` -> { gen, fold: Map(normSub -> deep) }

  // Per-subdir recursive counts from diragg — O(#subdirs × diragg rows under
  // each), never O(#files). Works for ANY prefix (a subdir may sit under an
  // indexed root even when the listed folder itself is outside all roots, e.g.
  // listing a dir that CONTAINS a configured root). Returns
  // Map(norm(subdirPath) -> count | null): null when that subdir's rollup is
  // not built yet (the UI shows the placeholder and fills it in later).
  function deepCounts(abs, subdirs, extsRaw) {
    const counts = new Map();
    for (const sd of subdirs) counts.set(norm(sd), 0);
    if (!idx.available || !subdirs.length) return subdirs.length ? null : counts;
    const d = openRead();
    if (!d) return null;
    const absNorm = norm(abs);
    const gen = currentGen();
    const key = absNorm + '|' + extsRaw;
    let ent = deepMemo.get(key);
    if (!ent || ent.gen !== gen) {
      const filter = parseExts(extsRaw);
      const ext = aggExtClause(filter, 'a.ext');
      const fold = new Map();
      let fail = false;
      for (const sd of subdirs) {
        const n = norm(sd);
        if (!covered(n)) { fold.set(n, null); continue; }
        const rn = rootCovering(n);
        if (!rn || !aggReady(rn)) { fold.set(n, null); continue; } // rollup not built yet → unknown
        let n2 = null;
        try {
          const up = underPrefix('d.path', n);
          n2 = rprep(`SELECT COALESCE(SUM(a.n), 0) AS n FROM diragg a JOIN dirs d ON d.id = a.dirid
              WHERE ${up.sql}${ext.sql}`)
            .get(...up.args, ...ext.args).n;
        } catch (_) { fail = true; break; } // pre-v8 DB or busy: unknown
        fold.set(n, n2);
      }
      if (fail) return null;
      ent = { gen, fold };
      deepMemo.set(key, ent);
      if (deepMemo.size > 200) deepMemo.delete(deepMemo.keys().next().value); // cheap LRU
    }
    for (const sd of subdirs) counts.set(norm(sd), ent.fold.get(norm(sd)) ?? null);
    return counts;
  }

  // per-DIRECT-subdir own-file counts (one /api/list side: the tree's number
  // badges use deepCounts; the list uses this for the immediate children)
  // Map(norm(subdirPath) -> count) — null when the rollup is not ready.
  function directCounts(absNorm, subdirPaths, extsRaw) {
    if (!idx.available) return null;
    const d = openRead();
    if (!d || !subdirPaths.length) return null;
    const rn = rootCovering(absNorm);
    if (!aggReady(rn)) return null;
    const filter = parseExts(extsRaw);
    const ext = aggExtClause(filter, 'a.ext');
    const m = new Map();
    const norms = subdirPaths.map(p => norm(p));
    for (let i = 0; i < norms.length; i += 400) {
      const slice = norms.slice(i, i + 400);
      try {
        for (const r of rprep(`SELECT d.path AS dp, SUM(a.n) AS n FROM diragg a JOIN dirs d ON d.id = a.dirid
              WHERE d.path IN (${slice.map(() => '?').join(',')})${ext.sql} GROUP BY d.id`)
          .all(...slice, ...ext.args)) m.set(r.dp, r.n);
      } catch (_) { return null; }
    }
    for (const n of norms) if (!m.has(n)) m.set(n, covered(n) ? 0 : null);
    return m;
  }

  // /api/list file page straight from the index (no per-file statSync):
  // first click on a 20k+-file folder must not stat every entry. Returns
  // { total, rows: [{name,size,mtime,ext,kind}] } or null when not indexable.
  const PAGE_SORT_SQL = {
    new: 'mtime DESC, name', old: 'mtime ASC, name',
    big: 'size DESC, name', small: 'size ASC, name', name: 'name'
  };
  function listPage(absNorm, extsRaw, sort, off, limit) {
    if (!idx.available) return null;
    const d = openRead();
    if (!d) return null;
    const dirRow = rprep('SELECT id FROM dirs WHERE path = ?').get(absNorm);
    if (!dirRow) return null;
    const filter = parseExts(extsRaw);
    const ext = aggExtClause(filter, 'f.ext');
    const order = PAGE_SORT_SQL[sort] || PAGE_SORT_SQL.new;
    try {
      let total;
      const rn = rootCovering(absNorm);
      if (aggReady(rn)) {
        total = rprep(`SELECT COALESCE(SUM(n), 0) AS n FROM diragg WHERE dirid = ?${aggExtClause(filter, 'diragg.ext').sql}`)
          .get(dirRow.id, ...aggExtClause(filter, 'diragg.ext').args).n;
      } else {
        total = rprep(`SELECT COUNT(*) AS n FROM files f WHERE f.dirid = ?${ext.sql}`).get(dirRow.id, ...ext.args).n;
      }
      const rows = rprep(`SELECT f.name, f.size, f.mtime, f.ext, f.kind FROM files f
          WHERE f.dirid = ?${ext.sql} ORDER BY ${order} LIMIT ? OFFSET ?`)
        .all(dirRow.id, ...ext.args, limit, off);
      return { total, rows };
    } catch (_) { return null; }
  }

  // ---------- global FILE-NAME search (/api/names) ----------
  // The search box used to filter only the folder on screen: someone looking at
  // folder A typing a name that lives in folder B concluded the file did not
  // exist. This searches names across the whole indexed scope — index-only, no
  // filesystem walk. LIKE '%q%' walks the files table (~45 ms on 360k rows);
  // ordering in SQL keeps the candidate set bounded. Ranking: exact name, then
  // name-starts-with, then contains, newest first inside each bucket.
  // Scope is enforced by the caller (isAllowed on every returned path) because
  // extra roots can point outside; skip/secret rules are already crawl-time.
  function escapeLike(s) {
    return s.replace(/[\\%_]/g, c => '\\' + c);
  }
  function nameSearch(q, limit, filter = { mode: 'all' }) {
    if (!idx.available) return null;
    const ext = deepExtClause(filter);
    const d = openRead();
    if (!d) return null;
    const like = '%' + escapeLike(q) + '%';
    const prefix = escapeLike(q) + '%';
    const out = [];
    try {
      const rows = rprep(`SELECT f.name, f.size, f.mtime, f.ext, COALESCE(d.rpath, d.path) AS dp
          FROM files f JOIN dirs d ON d.id = f.dirid
          WHERE f.name LIKE ? ESCAPE '\\'${ext.sql}
          ORDER BY (lower(f.name) = lower(?) OR lower(f.name) = lower(?) || lower(f.ext)) DESC,
                   (f.name LIKE ? ESCAPE '\\') DESC,
                   f.mtime DESC
          LIMIT ?`).all(like, ...ext.args, q, q, prefix, limit);
      for (const r of rows) {
        const ln = String(r.name).toLowerCase();
        if (ln === 'index.db' || ln === 'index.db-wal' || ln === 'index.db-shm') continue;
        if (ln.startsWith('.rdtmp-')) continue;
        out.push({ name: r.name, path: path.join(r.dp, r.name), dir: r.dp, mtime: r.mtime, size: r.size, ext: r.ext });
      }
      return out;
    } catch (_) { return null; }
  }

  // ---------- 「最近改動（不確定是誰改的）」(/api/recentmod) ----------
  // Files modified since cutoffMs under marker-project dirs — markers mirror
  // server.js detectAI: a direct child file named agents.md/claude.md/gemini.md,
  // a child dir in {.claude,.cursor,.git}, or >=5 markdown files in one dir.
  // Index-only (no filesystem walk), project set memoized (gen-moved + 30 s TTL).
  // excludeNorms: normKey'd paths already attributed to AI conversations —
  // dropped here so the two lists never mix. Returns rows or null on failure.
  const RECENT_MOD_MAX_PROJECTS = 800;
  const RECENT_MOD_LIMIT = 1200;
  let rmProjectsCache = { gen: -2, t: 0, set: null };

  function recentModProjects() {
    const now = Date.now();
    const gen = currentGen();
    const c = rmProjectsCache;
    if (c.set && c.gen === gen) return c.set;
    if (c.set && now - c.t < 30000) return c.set;   // watchers tick gen often; don't rescan the markers every poll
    const d = openRead();
    if (!d) return c.set || new Set();
    const projs = new Set();
    try {
      const markerIds = [];
      for (const r of rprep("SELECT DISTINCT dirid FROM files WHERE lower(name) IN ('agents.md','claude.md','gemini.md')").all()) markerIds.push(r.dirid);
      // same >=5-markdown heuristic as detectAI
      for (const r of rprep("SELECT dirid FROM files WHERE ext IN ('.md','.markdown') GROUP BY dirid HAVING COUNT(*) >= 5").all()) markerIds.push(r.dirid);
      for (let i = 0; i < markerIds.length; i += 400) {
        const slice = markerIds.slice(i, i + 400);
        for (const r of rprep(`SELECT path FROM dirs WHERE id IN (${slice.map(() => '?').join(',')})`).all(...slice)) projs.add(r.path);
      }
      // marker dirs (.claude/.cursor/.git): the PARENT is the project folder. GLOB so
      // the case-folded norm column still matches; separator is platform-correct.
      for (const name of ['.claude', '.cursor', '.git']) {
        for (const r of rprep('SELECT path FROM dirs WHERE path GLOB ?').all('*' + SEP + name)) {
          projs.add(r.path.slice(0, r.path.length - name.length - 1));
        }
      }
    } catch (_) { return c.set || new Set(); }   // busy mid-crawl: serve the previous set
    rmProjectsCache = { gen, t: now, set: projs };
    return projs;
  }

  function recentModified(cutoffMs, excludeNorms) {
    if (!idx.available) return null;
    const d = openRead();
    if (!d) return null;
    const projs = [...recentModProjects()];
    if (!projs.length) return [];
    if (projs.length > RECENT_MOD_MAX_PROJECTS) projs.length = RECENT_MOD_MAX_PROJECTS;
    const out = [];
    const seen = new Set();
    const fold = IS_WIN ? s => s.toLowerCase() : s => s;
    for (let i = 0; i < projs.length; i += 200) {
      const slice = projs.slice(i, i + 200);
      const ups = slice.map(n => underPrefix('d.path', n));
      const args = ups.flatMap(u => u.args);
      let rows;
      try {
        rows = rprep(`SELECT COALESCE(d.rpath, d.path) AS dp, f.name, f.size, f.mtime, f.ext, f.kind
            FROM files f JOIN dirs d ON d.id = f.dirid
            WHERE f.mtime >= ? AND (${ups.map(u => u.sql).join(' OR ')})
            ORDER BY f.mtime DESC LIMIT ?`).all(cutoffMs, ...args, RECENT_MOD_LIMIT);
      } catch (_) { return null; }
      for (const r of rows) {
        const full = path.join(r.dp, r.name);
        const k = fold(full.replace(/\\/g, '/'));
        if (seen.has(k)) continue;
        seen.add(k);
        if (excludeNorms && (excludeNorms.has(full.replace(/\\/g, '/')) || excludeNorms.has(fold(full.replace(/\\/g, '/'))))) continue;
        const ln = String(r.name).toLowerCase();
        if (ln === 'index.db' || ln === 'index.db-wal' || ln === 'index.db-shm') continue;
        if (ln.startsWith('.rdtmp-')) continue;
        if (/(^|\/)\.(claude|cursor|git)\//.test(k)) continue;   // marker-tool internals churn constantly
        out.push({ name: r.name, path: full, size: r.size, mtime: r.mtime, ext: r.ext, kind: r.kind });
      }
    }
    out.sort((a, b) => b.mtime - a.mtime);
    if (out.length > RECENT_MOD_LIMIT) out.length = RECENT_MOD_LIMIT;
    return out;
  }

  return idx;
}

module.exports = { createIndexer, resolveRecrawlMs, resolveBootStaleMs };

// indexer-worker.js — worker thread that owns the index DB. ALL sqlite writes
// (crawl upserts, deletions, rename/move bookkeeping, search staleness fixes) and
// all heavy search runs happen HERE, so the server's main event loop never blocks
// on node:sqlite during a crawl (measured: real-text trigram inserts take
// 30–85 ms per 64 KB head row on this corpus — far over the /api/list < 100 ms budget).
//
// WAL mode lets the main thread keep a read-only connection for the cheap
// queries (/api/list deepCount, /api/index/status) while this worker writes.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');
const { makeNorm, parseExts, countOccurrences, makeSnippet, loadSqlite } = require('./indexshared');
const { scanText, anySegmentSkipped } = require('./secrets');

const MAX_TEXT_BYTES = 5 * 1024 * 1024;   // content indexing / search gate (same as live scan)
const CONTENT_CAP_CHARS = 64 * 1024;       // only the first 64 KB of a file is indexed (the head is what people search for)
const CONTENT_READ_BYTES = CONTENT_CAP_CHARS + 4096; // slice headroom over UTF-16 lead-in
const MAX_DEPTH = 8;                       // same as searchTree
// generated / data directories are never indexed (config.indexSkipDirs adds more)
const BASE_SKIP_DIRS = new Set(['node_modules', '__pycache__', 'site-packages', 'venv', '.venv',
  'target', 'bower_components', 'dist', 'build', '.git', 'data', 'ticks', 'cache', 'logs', '.cache']);
// only these kinds get their CONTENT indexed (raw text-ish); everything else is metadata-only
const CONTENT_KINDS = new Set(['markdown', 'text', 'code', 'json', 'html', 'table']);
const MAX_VERIFY_READS = 200;       // per-search floor for candidate file re-reads
const VERIFY_CONCURRENCY = 8;       // parallel candidate stat+head-read windows
const VERIFY_BUDGET_MS = 200;       // wall-clock budget for the verify pass per search
// gram-set size above which the SQL ORDER BY mtime is skipped: sorting 45k
// candidate rows cost 1.3 s measured, and result order for stopword-scale
// queries is moot anyway (the JS side still sorts the merged, verified page)
const BIG_GRAM_SET = 20000;
const SCHEMA_VERSION = '8'; // v6: path columns normalised into a dirs table (files carry dirid+name only —
                            // the strings stored once), ftsmap keys files.id. v5 measured 235 MB of metadata
                            // for 378k files; v6 targets < 100 MB. Trigram content layer unchanged since v5.
                            // v7 ONLY adds `files.secret` (1 = suspected secret found in the head 64 KB,
                            // 0 = scanned clean, NULL = never scanned) — migrated with a plain ALTER TABLE
                            // (NO rebuild: all existing rows, FTS data and meta survive).
                            // v8 adds `diragg` (per-dir direct file counts per ext): /api/list deep counts
                            // become an O(#dirs) rollup query instead of touching every file row under the
                            // prefix. Kept fresh by write-path deltas, rebuilt wholesale after each crawl
                            // (meta aggready:<root>). Tables only — all v7 rows survive.

const IS_WIN = workerData.isWin;
const SEP = workerData.sep;
const norm = makeNorm(IS_WIN);
const realNorm = p => { try { return norm(fs.realpathSync(p)); } catch (_) { return norm(p); } };
const KIND = workerData.kind;
const TEXTLIKE = new Set(workerData.textlike);
const TEXTLIKE_LIST = [...TEXTLIKE];
const DEBUG_FLUSH = workerData.debugFlush === true;

const post = m => { try { parentPort.postMessage(m); } catch (_) {} };
const wlog = msg => post({ type: 'log', msg });

const sqlite = loadSqlite();if (!sqlite) {
  post({ type: 'ready', available: false });
  // keep the worker alive but inert; every job answers with null
  parentPort.on('message', m => { if (m.op === 'search') post({ type: 'search', id: m.id, result: null }); });
  return; // eslint-disable-line no-unreachable
}

let db = null;
let stmtCache = new Map();
const dirCache = new Map(); // norm'd dir path -> dirs.id (evicted ids removed on purge)
// win32 file/dir names share one case-insensitive namespace per directory;
// rows are keyed (dirid, real name), so JS-side matching folds case on win
const normName = IS_WIN ? s => s.toLowerCase() : s => s;
let crawledRoots = new Set();
let extraRoots = [];
let configRoots = [];   // last known config roots+pinned (arrive with crawl jobs)
let scopes = null;      // allowed scope list (norm'd) for symlink checks
let realScopesL = null; // realpath'd scope list
let skipDirNames = new Set([...BASE_SKIP_DIRS]); // per job: BASE + config.indexSkipDirs
let maxBytesCap = 2048 * 1048576; // config.indexMaxMB; DB above it → metadata-only
let contentCapped = false;        // true once the DB grew past maxBytesCap
let contentOn = true;             // content layer (FTS) — config indexContent / POST /api/index/content
let secretScanOn = true;          // config.secretScan
let secretSkipNames = [];         // config.secretScanSkipDirs: name-list, any matching path segment skips SECRET scanning (file still indexed)
let diraggOn = false;             // true once the v8 schema exists (declared up here: openDb assigns it)
let aggDeltaOff = false;          // a full crawl maintains diragg wholesale at the end — suppress per-row deltas meanwhile

function dbBytes() {
  let b = 0;
  try { b += fs.statSync(workerData.dbPath).size; } catch (_) {}
  try { b += fs.statSync(workerData.dbPath + '-wal').size; } catch (_) {}
  return b;
}

function createSchema() {
  db.exec(`
    -- one row per directory: the full path strings live HERE only; files carry
    -- an integer dirid + name (v5 stored path+rpath+dir per file = 235 MB of
    -- metadata for 378k files; normalising targets < 100 MB)
    CREATE TABLE IF NOT EXISTS dirs (
      id    INTEGER PRIMARY KEY,
      path  TEXT NOT NULL UNIQUE, -- norm'd (case-folded on win32, separators unified)
      rpath TEXT                  -- real-case path; NULL when path is already real (POSIX, or lowercase dirs)
    );
    CREATE TABLE IF NOT EXISTS files (
      id    INTEGER PRIMARY KEY,
      dirid INTEGER NOT NULL REFERENCES dirs(id),
      name  TEXT NOT NULL,        -- real (entry) name
      ext   TEXT NOT NULL,
      kind  TEXT,
      size  INTEGER NOT NULL,
      mtime REAL NOT NULL,
      has_content INTEGER NOT NULL DEFAULT 0,
      secret INTEGER,             -- NULL = never scanned, 0 = scanned clean, 1 = suspected secret in the head 64 KB
      UNIQUE(dirid, name)
    );
    CREATE INDEX IF NOT EXISTS idx_files_dirid ON files(dirid);
    -- contentless-delete + detail='none': the text is NOT stored in the index
    -- (no second copy), and no positions either — only rowid<->trigram pairs.
    -- Measured: ~0.22x of indexed text vs ~2.3x with full detail (the stored-
    -- content v3 blew the DB to 37 GB on this workspace). Cost: detail='none'
    -- rejects phrases (a >3-char trigram token IS a phrase), so search ANDs the
    -- query's trigrams itself as one MATCH per gram joined by INTERSECT (see
    -- queryGrams) and verifies every reported hit against the actual text.
    CREATE VIRTUAL TABLE IF NOT EXISTS content_fts
      USING fts5(content, content='', contentless_delete=1, detail='none', tokenize='trigram');
    -- rowid map per indexed file; DELETE/UPDATE ... WHERE path = ? on an FTS5
    -- table is a FULL scan of indexed text (turned write flushes into 70–150 ms
    -- stalls), so deletes go through this table by rowid
    CREATE TABLE IF NOT EXISTS ftsmap (
      fileid INTEGER PRIMARY KEY, -- files.id
      rowid  INTEGER NOT NULL
    );
    -- searches resolve FTS rowids back through ftsmap; without this index the
    -- join was a per-candidate full scan (a 45k-candidate query hung >100 s)
    CREATE INDEX IF NOT EXISTS idx_ftsmap_rowid ON ftsmap(rowid);
    -- v8: per-directory DIRECT file counts per extension. Deep counts are
    -- answered by summing this table over the dirs of a prefix (O(#dirs), not
    -- O(#files)). Maintained by write-path deltas; rebuilt per root at the end
    -- of every crawl (see rebuildDirAgg). ext stored lowercase with dot ('.md').
    CREATE TABLE IF NOT EXISTS diragg (
      dirid INTEGER NOT NULL,
      ext   TEXT NOT NULL,
      n     INTEGER NOT NULL,
      PRIMARY KEY (dirid, ext)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    -- /api/list pages ORDER BY mtime/size inside one dir (huge folders)
    CREATE INDEX IF NOT EXISTS idx_files_dirid_mtime ON files(dirid, mtime);
    CREATE INDEX IF NOT EXISTS idx_files_dirid_size ON files(dirid, size);
  `);
}

// WAL housekeeping constants must live ABOVE openDb (it reads WAL_AUTOCAP_BYTES
// when setting wal_autocheckpoint; a later declaration would be a TDZ throw the
// caller used to swallow silently).
const WAL_AUTOCAP_BYTES = 32 * 1048576;  // autocheckpoint window; WAL stays well under ~64 MB
const CKPT_EVERY_FLUSHES = 24;           // PASSIVE every N write batches during a crawl
// journal_size_limit: a PASSIVE checkpoint moves frames into the main DB but
// never shrinks the -wal file; its LENGTH only falls at a TRUNCATE, or — with
// this limit set — at the next checkpoint that follows a commit. The default is
// -1 ("never shrink"), so once the file was blown up by a slow reader it stayed
// huge for good (399 MB seen in the field). 4 MB keeps it bounded without
// fighting the 32 MB autocheckpoint window above. NB: the pragma is
// CONNECTION-level, so any other writer connection touching this DB (a
// maintenance script, a future path) can grow the WAL again — nothing
// persists it in the file.
const JOURNAL_LIMIT_BYTES = 4 * 1048576;
let flushesSinceCkpt = 0;

function openDb() {
  if (db) return db;
  try {
    try { fs.mkdirSync(path.dirname(workerData.dbPath), { recursive: true }); } catch (_) {}
    db = new sqlite.DatabaseSync(workerData.dbPath);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 2000; -- a second server instance pointing at the same
                                  -- DB gets retries instead of instant SQLITE_BUSY
    `);
    flushesSinceCkpt = 0;
    // WAL housekeeping: the main thread holds a long-lived query_only connection, and
    // under an active UI its read snapshots can pin the WAL past the point where the
    // default autocheckpoint (~4 MB) completes — the WAL then grows for the whole crawl
    // (observed: index.db-wal at 399 MB after a migration recrawl). Cap the
    // autocheckpoint window at ~32 MB, run a PASSIVE checkpoint every N flush batches,
    // and TRUNCATE at the end of every crawl job (see checkpointWal).
    try {
      const ps = Number(db.prepare('PRAGMA page_size').get().page_size) || 4096;
      db.exec(`PRAGMA wal_autocheckpoint = ${Math.max(256, Math.floor(WAL_AUTOCAP_BYTES / ps))}`);
    } catch (e) { wlog('index: wal_autocheckpoint pragma failed: ' + e.message); }
    // A PASSIVE checkpoint moves frames into the main DB but never shrinks the
    // -wal file; see JOURNAL_LIMIT_BYTES above for why this is set.
    try { db.exec(`PRAGMA journal_size_limit = ${JOURNAL_LIMIT_BYTES}`); }
    catch (e) { wlog('index: journal_size_limit pragma failed: ' + e.message); }
    const sv = metaGet('schema');
    if (sv === '6') {
      // v6 -> v7: ONE new nullable column. Plain ALTER keeps every row, the whole
      // FTS content layer and all meta — no rebuild, no re-crawl of contents.
      // Column may already exist if a previous boot crashed between the ALTER and
      // the schema bump — check first so a retry can never fail openDb entirely.
      const hasSecret = db.prepare('PRAGMA table_info(files)').all().some(c => c.name === 'secret');
      if (hasSecret) wlog(`index: schema 6 -> ${SCHEMA_VERSION}: files.secret already present`);
      else {
        wlog(`index: schema 6 -> ${SCHEMA_VERSION}: adding files.secret (rows kept)`);
        db.exec('ALTER TABLE files ADD COLUMN secret INTEGER');
      }
    }
    if (sv !== SCHEMA_VERSION && sv !== '6' && sv !== '7') {
      // schema changed incompatibly (or a pre-v6 / meta-damaged DB: sv === null
      // still rebuilds — a fresh DB just no-ops the drops). A plain DELETE would
      // keep an old stored-content FTS5 table shape, so the tables go entirely.
      // v6/v7 keep everything (v7->v8 only needs the diragg table, created by
      // createSchema; it is populated by the next crawl per root).
      if (sv != null) wlog(`index: schema ${sv} -> ${SCHEMA_VERSION}: rebuilding index.db from scratch`);
      db.exec('DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS dirs; DROP TABLE IF EXISTS content_fts; DROP TABLE IF EXISTS ftsmap; DROP TABLE IF EXISTS meta; DROP TABLE IF EXISTS diragg;');
      crawledRoots = new Set();
      dirCache.clear();
    }
    if (sv === '7') wlog(`index: schema 7 -> ${SCHEMA_VERSION}: adding diragg rollup (rows kept; fills on next crawl)`);
    createSchema();
    diraggOn = true;
    metaSet('schema', SCHEMA_VERSION);
    try { extraRoots = JSON.parse(metaGet('extraRoots') || '[]'); } catch (_) { extraRoots = []; }
    if (!Array.isArray(extraRoots)) extraRoots = [];
    try {
      for (const r of prep("SELECT key FROM meta WHERE key LIKE 'crawled:%' ESCAPE '\\'").all()) {
        crawledRoots.add(r.key.slice('crawled:'.length));
      }
    } catch (_) {}
    contentOn = metaGet('indexContent') !== '0'; // persists across restarts; config reconciles per crawl
    stmtCache = new Map();
    return db;
  } catch (err) {
    post({ type: 'ready', available: false, error: String(err && err.message || err) });
    throw err;
  }
}

function prep(sql) {
  let s = stmtCache.get(sql);
  if (!s) { s = db.prepare(sql); stmtCache.set(sql, s); }
  return s;
}
function metaGet(k) {
  try { const r = prep('SELECT value FROM meta WHERE key = ?').get(k); return r ? r.value : null; } catch (_) { return null; }
}
function metaSet(k, v) {
  prep('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));
}
function metaDel(k) {
  try { prep('DELETE FROM meta WHERE key = ?').run(k); } catch (_) {}
}

// ---------- WAL checkpointing (constants live above openDb) ----------
// PASSIVE never blocks and is cheap: it copies frames into the main DB and lets
// the WAL wrap instead of growing — unless a reader pins an old mark (transient
// on the main thread), in which case we simply try again a few batches later.
// TRUNCATE (queue idle / boot) shrinks the file to zero when it can get the
// locks within busy_timeout; a busy return now triggers the truncateWalSoon
// retry series below instead of being silently fatal to the file size.
let ckptBusyLogN = 0; // rate-limit the busy log: first, then every 8th
function checkpointWal(mode, why) {
  if (!db) return null;
  // PRAGMA does not bind parameters — whitelist instead of interpolating blindly
  if (mode !== 'PASSIVE' && mode !== 'RESTART' && mode !== 'FULL' && mode !== 'TRUNCATE') mode = 'PASSIVE';
  try {
    const r = prep(`PRAGMA wal_checkpoint(${mode})`).get();
    if (!r) return null;
    if (mode === 'TRUNCATE') {
      // Log failures always (the live box once kept a fully-checkpointed 399 MB
      // WAL for days because a single-shot TRUNCATE kept racing readers and
      // nobody saw the busy returns); a landed try is logged by truncateWalSoon
      // only as the series result, so a retry series stays a few lines, and
      // statSync for the size only runs when it actually failed.
      if (r.busy) wlog(`index: wal_checkpoint(TRUNCATE) at ${why}: busy=${r.busy} log=${r.log} checkpointed=${r.checkpointed} walBytes=${walBytesOnDisk()}`);
    } else if (r.busy && ++ckptBusyLogN % 8 === 1) {
      const frames = typeof r.log === 'number' && r.log >= 0 ? r.log : 'unknown'; // busy=1 makes SQLite report log=-1
      wlog(`index: wal_checkpoint(${mode}) deferred at ${why} (readers pin the WAL, log ${frames} frames)`);
    }
    return r;
  } catch (e) { wlog(`index: wal_checkpoint(${mode}) at ${why} failed: ${e.message}`); return null; }
}

function walBytesOnDisk() {
  try { return fs.statSync(workerData.dbPath + '-wal').size; } catch (_) { return 0; }
}

// One TRUNCATE attempt races ANY momentarily active reader and loses; on the
// busy box that meant "never". At genuinely idle pipeline moments (crawl queue
// drained, boot housekeeping) run a short retry series — a few seconds apart —
// until one lands. PASSIVE checkpoints keep the file bounded in the meantime,
// so this is strictly about making the file eventually shrink to 0.
//
// Single-flight: a series is one timer handle, and a second caller (boot timer
// firing while a crawl-end series retries) joins it instead of running a
// second interleaved series. A crawl starting does NOT silently drop the
// series — it is re-armed every gap, so once the crawl ends it resumes.
const TRUNCATE_TRIES = 8;
const TRUNCATE_GAP_MS = 3000;
let truncateTimer = null, truncateTries = 0, truncateWhy = '';
function truncateWalSoon(why) {
  if (truncateTimer) return; // series already in flight — it will get there
  truncateTries = 0;
  truncateWhy = why;
  const attempt = () => {
    truncateTimer = null;
    if (!db) return;
    if (crawling) { // busy crawling: try again after the gap, the crawl end also calls us
      truncateTimer = setTimeout(attempt, TRUNCATE_GAP_MS);
      truncateTimer.unref?.();
      return;
    }
    truncateTries++;
    const r = checkpointWal('TRUNCATE', `${truncateWhy} (try ${truncateTries}/${TRUNCATE_TRIES})`);
    if (r && !r.busy) {
      wlog(`index: WAL truncated at ${truncateWhy} (try ${truncateTries}/${TRUNCATE_TRIES})`);
      return;
    }
    if (!r) return; // the PRAGMA itself threw (already logged) — retrying would just repeat it
    if (truncateTries >= TRUNCATE_TRIES) {
      wlog(`index: WAL still not truncatable after ${TRUNCATE_TRIES} tries at ${truncateWhy}; PASSIVE keeps it bounded until the next idle round`);
      return;
    }
    truncateTimer = setTimeout(attempt, TRUNCATE_GAP_MS);
    truncateTimer.unref?.();
  };
  attempt();
}

// ---------- v8 diragg rollup + change generation ----------
// meta 'gen' is a monotonically increasing change counter; the main thread
// memoizes /api/list rollups keyed by it, so ANY data-writing path must bump
// it once the transaction committed (never inside a BEGIN — a rollback would
// otherwise leave the counter ahead of the data).
// prefix match without substr: a half-open range [n+SEP, n+SEP+1) uses the
// UNIQUE index on dirs.path (sargable) and has no JS-vs-SQLite string-length
// semantics to disagree on (astral chars in a root broke substr(path,1,N)).
function underPrefix(col, n) {
  const lo = n + SEP;
  const hi = n + String.fromCharCode(SEP.charCodeAt(0) + 1); // '\'+1=']', '/'+1='0'
  return { sql: `(${col} = ? OR (${col} >= ? AND ${col} < ?))`, args: [n, lo, hi] };
}
function bumpGen() {
  try { metaSet('gen', String(Math.max(1, Math.floor(Number(metaGet('gen')) || 0) + 1))); } catch (_) {}
}
function aggAdd(dirid, ext, delta) {
  // ext === '' (extensionless files) IS counted — rebuildDirAgg groups them the
  // same way; only a true null is skipped. Failures log instead of vanishing so
  // rollup drift is at least visible in the log (the per-crawl rebuild self-heals).
  if (!diraggOn || aggDeltaOff || dirid == null || ext == null || !delta) return;
  try {
    prep('INSERT INTO diragg (dirid, ext, n) VALUES (?, ?, ?) ON CONFLICT(dirid, ext) DO UPDATE SET n = n + excluded.n')
      .run(dirid, ext, delta);
    prep('DELETE FROM diragg WHERE dirid = ? AND ext = ? AND n <= 0').run(dirid, ext);
  } catch (e) { wlog('index: diragg delta failed: ' + e.message); }
}
// wholesale per-root rebuild at the end of a crawl: one SQL aggregate over the
// root's files (C-speed even at ~400k rows). Between crawls the deltas above
// keep it exact; this pass absorbs any drift and prunes dirs rows that died.
function rebuildDirAgg(rootNorm) {
  const up = underPrefix('path', rootNorm);
  const ids = `SELECT id FROM dirs WHERE ${up.sql}`;
  const t0 = Date.now();
  const ownTxn = !db.isTransaction; // never roll back somebody else's transaction on failure
  if (ownTxn) db.exec('BEGIN');
  try {
    prep(`DELETE FROM diragg WHERE dirid IN (${ids})`).run(...up.args);
    prep(`INSERT INTO diragg (dirid, ext, n) SELECT dirid, ext, COUNT(*) FROM files
          WHERE dirid IN (${ids}) GROUP BY dirid, ext`)
      .run(...up.args);
    // dirs swept between crawls leave orphan rollup rows behind — prune them here
    prep('DELETE FROM diragg WHERE dirid NOT IN (SELECT id FROM dirs)').run();
    metaSet('aggready:' + rootNorm, String(Date.now()));
    if (ownTxn) db.exec('COMMIT');
    bumpGen();
    const ms = Date.now() - t0;
    if (ms >= 20) wlog(`index: diragg rollup rebuilt for ${rootNorm} in ${ms}ms`);
  } catch (e) {
    try { if (ownTxn) db.exec('ROLLBACK'); } catch (_) {}
    wlog('index: diragg rebuild failed: ' + e.message);
  }
}

// ---------- crawl pacing: duty-cycle so the WHOLE server process stays ≤25% of one core ----------
// Every busy slice of >= PACE_BUSY_MS work is followed by a long rest (capped) so the
// aggregate stays near a 1-in-8.5 duty in this worker's wall time. The worker is not the
// only burner: V8's background JIT/compiler threads and libuv's fs pool count into the
// same process and scale with how fast the worker churns — measured on a full recrawl
// (whole-process, 10 s rolling window): rest = busy*3.2 (duty 24%) → ~40-55% process;
// rest = busy*6.0 (duty 14%) → ~24-27% process; rest = busy*7.5 (duty ≈ 11.8%) → ≤25%
// with margin. The accumulator is SHARED by every paced loop: crawl roots and
// watch-triggered reindex trees run concurrently, and per-loop pacers would add up
// (two 12% duties + V8 helpers measured >50% process while a churny tree was being
// reindexed mid-crawl — watch re-syncs now DEFER until the crawl queue drains, so
// concurrent paced loops are the rare exception, not the norm). The accumulator is
// still shared so a brief overlap cannot double the duty budget either.
// busy is clamped at 200 ms: after a long idle stretch the first call would
// otherwise read the whole idle span as "busy" and sleep for the rest cap.
// The rest cap must satisfy rest >= 7.5*busy or the duty bound breaks — 4000 ms
// tolerates a ~500 ms slice without distorting normal pacing.
const PACE_BUSY_MS = 8;       // rest = min(busy * 7.5, 4000) → worker duty ≈ 12%, process ≤ 25%
const PACE_NULL = async () => {};
let paceShared = null;
function makePacer() {
  if (process.env.RIFFLEDESK_CRAWL_PACE === '0') return PACE_NULL;
  if (paceShared) return paceShared;
  let slice = performance.now();
  paceShared = async () => {
    const busy = Math.min(performance.now() - slice, 200);
    if (busy < PACE_BUSY_MS) return;
    const rest = Math.min(busy * 7.5, 4000);
    await new Promise(r => setTimeout(r, rest));
    slice = performance.now();
  };
  return paceShared;
}

// ---------- roots & scope (scope arrays arrive with jobs; see indexer.js) ----------
function roots() {
  const out = [];
  const seen = new Set();
  for (const r of configRoots) {
    const n = norm(r);
    if (!seen.has(n)) { seen.add(n); out.push(r); }
  }
  for (const r of extraRoots) {
    const n = norm(r);
    if (seen.has(n)) continue;
    try { if (!fs.statSync(r).isDirectory()) continue; } catch (_) { continue; }
    seen.add(n); out.push(r);
  }
  return out;
}

function rootCovering(absNorm) {
  for (const r of roots()) {
    const rn = norm(r);
    if (absNorm === rn) return rn;
    if (rn === SEP && absNorm.startsWith(SEP)) return rn;             // POSIX '/'
    if (absNorm.startsWith(rn + SEP)) return rn;
  }
  return null;
}

function covered(absNorm) {
  const rn = rootCovering(absNorm);
  return rn !== null && crawledRoots.has(rn);
}

function underAny(n, list) {
  return list.some(s =>
    (s === '/' && n.startsWith('/')) || n === s || n.startsWith(s + SEP));
}
// same rule as server.js isAllowed(), driven by the scope lists sent by main
function isAllowedHere(absPath) {
  if (!scopes || !realScopesL) return true; // no lists yet: only harmless crawl-time checks
  const n = norm(absPath);
  if (!underAny(n, scopes)) return false;
  if (!underAny(realNorm(absPath), realScopesL)) return false;
  return true;
}

// ---------- dirs (path strings live here once) ----------
function dirIdLookup(dirNorm) { // null when the dir is not indexed
  const c = dirCache.get(dirNorm);
  if (c != null) return c;
  const r = prep('SELECT id FROM dirs WHERE path = ?').get(dirNorm);
  if (!r) return null;
  dirCache.set(dirNorm, r.id);
  return r.id;
}
function ensureDir(dirNorm, dirReal) {
  const id = dirIdLookup(dirNorm);
  if (id != null) return id;
  prep('INSERT OR IGNORE INTO dirs (path, rpath) VALUES (?, ?)')
    .run(dirNorm, dirReal && dirReal !== dirNorm ? dirReal : null);
  const r = prep('SELECT id FROM dirs WHERE path = ?').get(dirNorm);
  dirCache.set(dirNorm, r.id);
  return r.id;
}

// ---------- content rows ----------
// One FTS row per file (content capped at CONTENT_CAP_CHARS when read), keyed
// by files.id through ftsmap. Content rows exist only for CONTENT_KINDS files;
// all other files are metadata-only (still name-searchable through files).

// printer-text sniff on the first bytes: treat NUL/'binary-looking' payloads as
// not-text (base64 blobs and minified bundles still cost ~2.3x of their capped
// bytes in the trigram index, so skip the clearly binary ones early)
function looksBinary(buf) {
  const n = Math.min(buf.length, 4096);
  if (n === 0) return false;
  let weird = 0;
  for (let i = 0; i < n; i++) {
    const c = buf[i];
    if (c === 0) return true;                       // NUL → definitely not utf8 text
    if (c < 9 || (c > 13 && c < 32)) weird++;       // control chars other than tab/LF/CR
  }
  return weird / n > 0.05;
}

// both no-op when the content layer is off: content_fts/ftsmap do not exist then
function insertFtsRow(fileid, content) {
  if (!contentOn) return;
  const r = prep('INSERT INTO content_fts (content) VALUES (?)').run(content);
  prep('INSERT OR REPLACE INTO ftsmap (fileid, rowid) VALUES (?, ?)')
    .run(fileid, Number(r.lastInsertRowid));
}

function deleteFtsRows(fileid) {
  if (!contentOn) return;
  const m = prep('SELECT rowid FROM ftsmap WHERE fileid = ?').get(fileid);
  if (m) prep('DELETE FROM content_fts WHERE rowid = ?').run(m.rowid);
  prep('DELETE FROM ftsmap WHERE fileid = ?').run(fileid);
}

// content === undefined → leave the FTS rows AND has_content alone; null →
// delete them (has_content → 0, e.g. not indexable at all); '' → tried but
// unusable (binary/unreadable — has_content → 2, so later crawls do not retry
// it every pass); a non-empty string → replace them (has_content → 1).
// rec.secret mirrors that discipline: undefined → leave files.secret alone
// (a NULL keeps meaning "never scanned"), 0/1 → set it.
// Returns the row's files.id.
function upsertRow(rec) {
  // diragg delta bookkeeping: know the previous (dirid, ext) before overwriting
  let prev = null;
  if (diraggOn) try { prev = prep('SELECT ext FROM files WHERE dirid = ? AND name = ?').get(rec.dirid, rec.name) || null; } catch (_) {}
  const row = prep(`INSERT INTO files (dirid, name, ext, kind, size, mtime, has_content, secret)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(dirid, name) DO UPDATE SET
          ext = excluded.ext, kind = excluded.kind,
          size = excluded.size, mtime = excluded.mtime,
          has_content = CASE WHEN ? = 1 THEN files.has_content ELSE excluded.has_content END,
          secret = CASE WHEN ? = 1 THEN files.secret ELSE excluded.secret END
        RETURNING id`)
    .get(rec.dirid, rec.name, rec.ext, rec.kind, rec.size, rec.mtime,
      rec.content ? 1 : (rec.content === '' ? 2 : 0),
      rec.secret == null ? null : rec.secret,          // VALUES #8 — must stay INSIDE the VALUES list
      rec.content === undefined ? 1 : 0,
      rec.secret === undefined ? 1 : 0);
  if (rec.content !== undefined) setRowContent(row.id, rec.content);
  if (diraggOn) {
    if (!prev) aggAdd(rec.dirid, rec.ext, 1);
    else if (prev.ext !== rec.ext) { aggAdd(rec.dirid, rec.ext, 1); aggAdd(rec.dirid, prev.ext, -1); }
  }
  return row.id;
}

function setRowContent(fileid, content) {
  deleteFtsRows(fileid);
  if (content === null || content === '') return;
  insertFtsRow(fileid, content);
}

function deleteRowId(id) {
  if (diraggOn) {
    try {
      const r = prep('SELECT dirid, ext FROM files WHERE id = ?').get(id);
      if (r) aggAdd(r.dirid, r.ext, -1);
    } catch (_) {}
  }
  prep('DELETE FROM files WHERE id = ?').run(id);
  deleteFtsRows(id);
}

const isTextIndexable = (kind, size) => !!kind && TEXTLIKE.has(kind) && size <= MAX_TEXT_BYTES;

// read the head of a file (bounded — no multi-MB reads during a crawl)
async function readContent(rpath) {
  let fh = null;
  try {
    fh = await fs.promises.open(rpath, 'r');
    const buf = Buffer.alloc(CONTENT_READ_BYTES);
    const { bytesRead } = await fh.read(buf, 0, CONTENT_READ_BYTES, 0);
    if (looksBinary(buf.subarray(0, bytesRead))) return null;
    let c = buf.subarray(0, bytesRead).toString('utf8');
    if (c.length > CONTENT_CAP_CHARS) c = c.slice(0, CONTENT_CAP_CHARS);
    return c;
  } catch (_) { return null; }
  finally { if (fh) try { await fh.close(); } catch (_) {} }
}

// should this file get a content row at all? (content layer + kind allowlist +
// size + DB budget)
const wantContent = (kind, size) => contentOn && CONTENT_KINDS.has(kind) && size <= MAX_TEXT_BYTES && !contentCapped;

// scan the head text for suspected secrets (missing values are NEVER printed
// anywhere; the DB stores only the boolean). Skipped when config.secretScan is
// off or any path segment of dirNorm matches config.secretScanSkipDirs.
const secretSkipCache = new Map(); // dirNorm -> bool (valid within one crawl job's settings)
function secretFor(dirNorm, content) {
  if (!secretScanOn || !content) return undefined;
  let skipped = secretSkipCache.get(dirNorm);
  if (skipped === undefined) { skipped = anySegmentSkipped(dirNorm, secretSkipNames); secretSkipCache.set(dirNorm, skipped); }
  if (skipped) return undefined;
  return scanText(content).length ? 1 : 0;
}

// read-and-prepare one discovered file: full rec for upsertRow.
async function makeRec(dirid, meta) {
  const base = { dirid, name: meta.name, ext: meta.ext, kind: meta.kind, size: meta.size, mtime: meta.mtime };
  if (!wantContent(meta.kind, meta.size)) return { ...base, content: null };
  const content = await readContent(meta.rpath);
  // binary/unreadable: content '' marks the row "tried, no content" so later
  // crawls skip it instead of re-reading it every pass
  if (content === null) return { ...base, content: '' };
  return { ...base, content, secret: secretFor(meta.dir, content) };
}

function findRowId(dirNorm, name) {
  const dirid = dirIdLookup(dirNorm);
  if (dirid == null) return null;
  const exact = prep('SELECT id FROM files WHERE dirid = ? AND name = ?').get(dirid, name);
  if (exact) return exact.id;
  // watcher events sometimes carry a different case than the stored entry
  const want = normName(name);
  for (const r of prep('SELECT id, name FROM files WHERE dirid = ?').all(dirid)) {
    if (normName(r.name) === want) return r.id;
  }
  return null;
}

function applyRenamed(oldAbs, newAbs) {
  const id = findRowId(norm(path.dirname(oldAbs)), path.basename(oldAbs));
  if (id == null) return; // not indexed (or missed): the next dir sync adds it
  const name = path.basename(newAbs);
  const ext = path.extname(name).toLowerCase();
  const kind = KIND[ext] || null;
  const newDirid = ensureDir(norm(path.dirname(newAbs)), path.resolve(path.dirname(newAbs)));
  let oldRow = null;
  if (diraggOn) try { oldRow = prep('SELECT dirid, ext FROM files WHERE id = ?').get(id) || null; } catch (_) {}
  try {
    prep('UPDATE files SET dirid = ?, name = ?, ext = ?, kind = ?, has_content = CASE WHEN ? THEN has_content ELSE 0 END WHERE id = ?')
      .run(newDirid, name, ext, kind, CONTENT_KINDS.has(kind) ? 1 : 0, id);
  } catch (_) {
    // a row for the new (dirid, name) already exists (rename onto it, or a
    // stale case-only twin) — drop ours and let the next dir sync settle it
    deleteRowId(id);
    bumpGen(); // files/diragg changed on this path too — the memo must not go stale
    return;
  }
  if (diraggOn && oldRow && (oldRow.dirid !== newDirid || oldRow.ext !== ext)) {
    aggAdd(oldRow.dirid, oldRow.ext, -1);
    aggAdd(newDirid, ext, 1);
  }
  bumpGen();
  // ftsmap keys files.id, so content rows survive renames untouched; only a
  // kind change out of the content allowlist drops them
  if (!CONTENT_KINDS.has(kind)) deleteFtsRows(id);
}

function applyRemoved(abs) {
  const id = findRowId(norm(path.dirname(abs)), path.basename(abs));
  if (id != null) { deleteRowId(id); bumpGen(); }
}

// ---------- fs.watch: near-instant incremental updates between crawls ----------
// Rollups stay exact without waiting for the hourly crawl: changed dirs are
// re-synced (and freshly-created subtrees crawled) within ~1.5 s. Events are
// lossy under load — the hourly full crawl remains the safety net. Recursive
// watching only exists on win32/macOS; elsewhere this silently no-ops.
const WATCH_DEBOUNCE_MS = 1500;
const WATCH_PER_ROUND_MAX = 24;
const watchers = new Map();   // rootNorm -> { watcher, pending:Set<dirNorm>, timer }
const postCrawlResync = new Set(); // rootNorms whose watcher died mid-crawl (resync after drain)
let desiredWatchRoots = new Set(); // roots from the last 'watch' message (for unwatch/re-arm)
const watchOk = process.env.RIFFLEDESK_WATCH !== '0' && (process.platform === 'win32' || process.platform === 'darwin');

function watchRoots(rs) {
  if (!watchOk || !db) return;
  const want = new Set(rs.map(r => norm(path.resolve(r))));
  desiredWatchRoots = want;
  // roots removed from the config stop watching instead of leaking the handle
  for (const [rn, entry] of watchers) {
    if (want.has(rn)) continue;
    try { entry.watcher.close(); } catch (_) {}
    if (entry.timer) clearTimeout(entry.timer);
    watchers.delete(rn);
    wlog(`index: unwatched ${rn} (no longer a root)`);
  }
  for (const r of rs) {
    const rn = norm(path.resolve(r));
    if (watchers.has(rn)) continue;
    let w;
    try { w = fs.watch(r, { recursive: true }, (type, rel) => noteWatch(rn, rel)); }
    catch (e) { wlog(`index: watch unavailable for ${r}: ${e.code || e.message}`); continue; }
    const entry = { watcher: w, pending: new Set(), timer: null };
    watchers.set(rn, entry);
    w.on('error', () => {
      try { w.close(); } catch (_) {}
      watchers.delete(rn);
      wlog(`index: watch on ${rn} errored — re-arming in 30 s (hourly crawl covers the gap)`);
      const t = setTimeout(() => {
        if (desiredWatchRoots.has(rn) && !watchers.has(rn)) {
          watchRoots([...desiredWatchRoots]);
          // events during the gap are lost — resync the root; while a crawl is
          // running the resync waits for the queue to drain (CPU duty reasons,
          // see scheduleWatchFlush) since that crawl re-walks most of it anyway
          if (crawling) postCrawlResync.add(rn);
          else reindexTree(rn, rn).catch(() => {});
        }
      }, 30000);
      if (t.unref) t.unref();
    });
    wlog(`index: watching ${r}`);
  }
}

function noteWatch(rootNorm, rel) {
  const w = watchers.get(rootNorm);
  if (!w) return;
  if (!rel) { w.pending.add(rootNorm); scheduleWatchFlush(rootNorm); return; } // null filename (event overflow): resync the whole root
  // watch events land per-file AND per-dir; batch by containing directory
  const segs = norm(String(rel)).split(SEP).filter(Boolean);
  if (!segs.length) return;
  if (segs.some(s => s.startsWith('.') || skipDirNames.has(s.toLowerCase()))) return;
  const dirSegs = segs.slice(0, -1);
  const dirNorm = dirSegs.length ? rootNorm + SEP + dirSegs.join(SEP) : rootNorm;
  w.pending.add(dirNorm);
  scheduleWatchFlush(rootNorm);
}

function scheduleWatchFlush(rootNorm) {
  const w = watchers.get(rootNorm);
  if (!w || w.timer) return;
  // While a crawl is running, watch-triggered re-syncs stay pending: the crawl
  // re-walks (and re-syncs) every touched dir anyway, and running reindexTree
  // CONCURRENTLY with the crawl measured 40-65% whole-process CPU — two paced
  // loops interleave their rests and the duties no longer add to the 1-in-8.5
  // budget. Deferring costs only the pending-dir Set entries; runCrawlQueue
  // re-arms every root's flush when the queue drains.
  if (crawling) return;
  w.timer = setTimeout(() => {
    w.timer = null;
    // a timer armed BEFORE the crawl started may still fire mid-crawl: stay
    // deferred (finishCrawlDrain re-arms every root with pending dirs when the
    // queue drains); reindex must never run concurrently with the crawl
    if (crawling) return;
    // take at most WATCH_PER_ROUND_MAX dirs; the REST stay pending (re-scheduled
    // below) instead of being dropped
    const dirs = [];
    for (const dn of w.pending) { if (dirs.length >= WATCH_PER_ROUND_MAX) break; dirs.push(dn); w.pending.delete(dn); }
    (async () => {
      for (const d of dirs) await reindexTree(d, rootNorm);
      if (w.pending.size) scheduleWatchFlush(rootNorm);
    })().catch(() => {});
  }, WATCH_DEBOUNCE_MS);
  if (w.timer.unref) w.timer.unref();
}

// watch-driven re-sync of a changed dir AND any subdirs the index has never
// seen (a folder that appeared between crawls gets crawled inline — small,
// stack-based, same guards as crawlRootInternal).
async function reindexTree(dirNorm, rootNorm) {
  let realDir;
  try { realDir = fs.realpathSync(dirNorm); } catch (_) { return; }
  try { if (!fs.statSync(realDir).isDirectory()) return; } catch (_) { return; }
  if (!isAllowedHere(realDir)) return;
  const stack = [{ dir: realDir, depth: 0 }];
  const pace = makePacer();
  const { writeQueue, flush } = makeWriteQueue();
  try {
    while (stack.length) {
      const { dir, depth } = stack.pop();
      const dNorm = norm(dir);
      if (depth > 0 && dirIdLookup(dNorm) != null) {
        // already indexed: the crawl owns it; a stale entry here would double-sync
        if (dNorm !== dirNorm) continue;
      }
      const { metas, entries } = await scanDirFiles(dir);
      if (entries === null) continue;
      await syncDirRows(dNorm, dir, metas, writeQueue, flush, pace);
      await pace();
      if (depth >= MAX_DEPTH) continue;
      for (const e of entries) {
        if (!e.isDirectory() && !e.isSymbolicLink()) continue;
        if (e.name.startsWith('.') || skipDirNames.has(e.name.toLowerCase())) continue;
        const sub = path.join(dir, e.name);
        if (e.isSymbolicLink()) {
          let target;
          try { target = await fs.promises.realpath(sub); } catch (_) { continue; }
          if (!isAllowedHere(target)) continue;
          let st; try { st = await fs.promises.stat(target); } catch (_) { continue; }
          if (!st.isDirectory()) continue;
          if (dirIdLookup(norm(target)) != null) continue;
          stack.push({ dir: target, depth: depth + 1 });
        } else {
          if (dirIdLookup(norm(sub)) != null) continue;
          stack.push({ dir: sub, depth: depth + 1 });
        }
      }
    }
    flush();
  } catch (_) {
    try { db.exec('ROLLBACK'); } catch (_) {}
  }
}

// ---------- walking ----------
const tick = (() => { let ops = 0; return async () => { if (++ops % 64 === 0) await new Promise(r => setImmediate(r)); }; })();

// entries === null signals a READDIR FAILURE (not an empty dir) — callers must
// not delete anything for such a dir (its rows may still be valid).
async function scanDirFiles(dir) {
  const metas = [];
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (_) { return { metas, entries: null }; }
  for (const e of entries) {
    if (!e.isFile() && !e.isSymbolicLink()) continue;
    await tick();
    const full = path.join(dir, e.name);
    let target = full, st;
    if (e.isSymbolicLink()) {
      try { target = await fs.promises.realpath(full); } catch (_) { continue; }
      if (!isAllowedHere(target)) continue;
      try { st = await fs.promises.stat(target); } catch (_) { continue; }
    } else {
      try { st = await fs.promises.stat(full); } catch (_) { continue; }
    }
    if (!st.isFile()) continue;
    const ext = path.extname(e.name).toLowerCase();
    metas.push({
      np: norm(full), rpath: full, dir: norm(dir), name: e.name, ext,
      kind: KIND[ext] || null, size: st.size, mtime: st.mtimeMs
    });
  }
  return { metas, entries };
}

function makeWriteQueue() {
  const writeQueue = [];
  const flush = () => {
    if (!writeQueue.length) return;
    const nItems = writeQueue.length;
    const t0 = Date.now();
    db.exec('BEGIN');
    for (const item of writeQueue) {
      const tI = DEBUG_FLUSH ? Date.now() : 0;
      if (item.del) for (const id of item.del) deleteRowId(id);
      else if (item.rec) upsertRow(item.rec);
      if (DEBUG_FLUSH) {
        const dI = Date.now() - tI;
        if (dI >= 15) {
          const what = item.rec ? `rec ${item.rec.name} (${item.rec.size}b, ${item.rec.content ? item.rec.content.length : '-'}c)`
            : `del:${item.del.length}`;
          wlog(`index: slow item ${dI}ms ${what}`);
        }
      }
    }
    writeQueue.length = 0;
    const tC = DEBUG_FLUSH ? Date.now() : 0;
    db.exec('COMMIT');
    bumpGen(); // data changed and is now visible — invalidate main-side rollups
    if (DEBUG_FLUSH && Date.now() - tC >= 15) wlog(`index: slow commit ${Date.now() - tC}ms`);
    if (++flushesSinceCkpt >= CKPT_EVERY_FLUSHES) {
      flushesSinceCkpt = 0;
      checkpointWal('PASSIVE', 'periodic flush batch');
    }
    const ms = Date.now() - t0;
    if (ms >= 15) wlog(`index: slow flush ${ms}ms (${nItems} items)`);
    // hard size budget (config.indexMaxMB): once the DB file exceeds it, all
    // further files are indexed metadata-only until the DB shrinks again
    if (!contentCapped && dbBytes() > maxBytesCap) {
      contentCapped = true;
      metaSet('indexCapped', '1');
      wlog(`index: DB size cap exceeded (> ${Math.round(maxBytesCap / 1048576)} MB) — indexing metadata only until it shrinks`);
    }
  };
  return { writeQueue, flush };
}

// Sync the DB rows of ONE directory. Reads happen outside any transaction;
// large content rows flush one-at-a-time so no single write batch blocks this
// worker's own job handling for long either. `pace` (crawl only) duty-cycles
// each flush burst so even a 100k-file directory cannot pin a core.
async function syncDirRows(dirNorm, dirReal, metas, writeQueue, flush, pace) {
  const yieldNow = () => new Promise(r => setImmediate(r));
  const paceOrYield = pace || yieldNow;
  const dirid = ensureDir(dirNorm, dirReal);
  const seen = new Set(metas.map(m => normName(m.name)));
  const existing = new Map(); // normName -> stored row
  for (const r of prep('SELECT id, name, size, mtime, has_content FROM files WHERE dirid = ?').all(dirid)) {
    existing.set(normName(r.name), r);
  }
  const stale = [];
  for (const [k, r] of existing) if (!seen.has(k)) stale.push(r.id);
  for (const meta of metas) {
    await paceOrYield(); // WALL budget at the TOP: no branch (unchanged-file continue,
                         // big-content flush, ...) may skip pacing, and dense loops
                         // also yield the event loop here
    const prev = existing.get(normName(meta.name));
    // case-only rename: same folded key, different stored spelling → replace
    if (prev && prev.name !== meta.name) stale.push(prev.id);
    else if (prev && prev.size === meta.size && Math.abs(prev.mtime - meta.mtime) < 1e-6) {
      // unchanged: skip — except a metadata-only row (has_content 0, never tried)
      // while the content layer is on again (toggle-on, or recovery under the DB
      // budget): attach its content now
      if (!(contentOn && prev.has_content === 0 && wantContent(meta.kind, meta.size))) continue;
    }
    if (stale.length) { writeQueue.push({ del: stale.splice(0) }); } // splice: the queue must OWN its copy
    const rec = await makeRec(dirid, meta);
    if (writeQueue.length >= 32) { await yieldNow(); flush(); }
    writeQueue.push({ rec });
    // a full-cap content row costs tens of ms of trigram insertion: flush it alone
    if (rec.content && rec.content.length >= CONTENT_CAP_CHARS / 2) { await yieldNow(); flush(); }
  }
  if (stale.length) writeQueue.push({ del: stale.splice(0) });
}

// INVARIANT: `crawling` is check-then-set in ONE synchronous turn by both crawl
// entry points (runCrawlQueue below, addExtraRoot's IIFE), and both run on the
// worker's single event loop — so the two crawl paths can never overlap: a
// second caller observes crawling === true and returns before any await.
// If an await is ever introduced between check and set, replace this boolean
// with a proper mutex/queue.
let crawling = false;
let lastCrawlMs = null;
let lastCrawlAt = null;
const crawlQueue = []; // jobs: { roots, scopes, realScopes } — one full crawl each

function fileCount() {
  try { return prep('SELECT COUNT(*) AS n FROM files').get().n; } catch (_) { return 0; }
}

function postStatus() {
  post({ type: 'status', crawling, files: fileCount(), lastCrawlMs, lastCrawlAt, capped: contentCapped, contentEnabled: contentOn });
}

// Streamed per directory (never holds the whole tree in memory). Returns files seen.
async function crawlRootInternal(rootAbs) {
  const resolved = path.resolve(rootAbs);
  const rootNorm = norm(resolved);
  const seenDirs = new Set();
  const seenReal = new Set([realNorm(resolved)]);
  const { writeQueue, flush } = makeWriteQueue();
  let total = 0;
  aggDeltaOff = true; // per-row diragg deltas suppressed: rebuildDirAgg below re-derives the whole root

  try {
    const stack = [{ dir: resolved, depth: 0 }];
    const pace = makePacer();
    let first = true;
    while (stack.length) {
      const { dir, depth } = stack.pop();
      const { metas, entries } = await scanDirFiles(dir);
      if (entries === null) {
        if (first) return 0; // unreadable ROOT: know nothing, abort without writing
        seenDirs.add(norm(dir)); // failed dir keeps its rows (final sweep spares it)
        continue;
      }
      first = false;
      seenDirs.add(norm(dir));
      total += metas.length;
      await syncDirRows(norm(dir), dir, metas, writeQueue, flush, pace);
      await pace();
      for (const e of entries) {
        if (!e.isDirectory() && !e.isSymbolicLink()) continue;
        if (e.name.startsWith('.') || skipDirNames.has(e.name.toLowerCase())) continue;
        if (depth >= MAX_DEPTH) continue;
        if (e.isSymbolicLink()) {
          let target;
          try { target = await fs.promises.realpath(path.join(dir, e.name)); } catch (_) { continue; }
          if (!isAllowedHere(target)) continue;
          let st;
          try { st = await fs.promises.stat(target); } catch (_) { continue; }
          if (!st.isDirectory()) continue;
          const key = realNorm(target);
          if (seenReal.has(key)) continue;
          seenReal.add(key);
          stack.push({ dir: target, depth: depth + 1 });
        } else {
          const key = realNorm(path.join(dir, e.name));
          if (seenReal.has(key)) continue;
          seenReal.add(key);
          stack.push({ dir: path.join(dir, e.name), depth: depth + 1 });
        }
      }
    }
    // sweep rows whose directory vanished entirely since the last crawl
    // (files first, then the dirs rows themselves + cache eviction)
    const sup = underPrefix('path', rootNorm);
    const staleDirs = prep(`SELECT id, path FROM dirs WHERE ${sup.sql}`)
      .all(...sup.args)
      .filter(r => !seenDirs.has(r.path));
    if (staleDirs.length) {
      flush(); // drain pending writes first so the sweep sees a settled table
      db.exec('BEGIN');
      try {
        for (const s of staleDirs) {
          for (const f of prep('SELECT id FROM files WHERE dirid = ?').all(s.id)) deleteRowId(f.id);
          prep('DELETE FROM dirs WHERE id = ?').run(s.id);
          prep('DELETE FROM diragg WHERE dirid = ?').run(s.id); // rollup must not keep counting dead dirs
        }
        db.exec('COMMIT');
        bumpGen();
      } catch (_) { try { db.exec('ROLLBACK'); } catch (_) {} throw _; }
      for (const s of staleDirs) dirCache.delete(s.path);
    }
    flush();
    crawledRoots.add(rootNorm);
    metaSet('crawled:' + rootNorm, Date.now());
    rebuildDirAgg(rootNorm);
    return total;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    wlog(`index: crawl of ${rootAbs} failed: ${err.message}`);
    return 0;
  } finally {
    aggDeltaOff = false;
    checkpointWal('PASSIVE', 'crawl root end');   // push the WAL back down per root; TRUNCATE only at job end
  }
}

// the two-layer split: the files table (metadata) is ALWAYS maintained; the
// content layer (content_fts + ftsmap + has_content) is dropped wholesale when
// indexContent is off. Turning on re-creates the empty tables; the next crawl
// pass then attaches content to has_content=0 rows (see syncDirRows). Must run
// between ops (never mid-search / mid-crawl).
function contentLayerApply(on) {
  on = !!on;
  if (on === contentOn) {
    // desired state already active — but if the layer ON was requested and the
    // tables are missing (crash between drop and create), re-create silently
    if (on) {
      const has = prep("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'content_fts'").get();
      if (!has) { createSchema(); stmtCache = new Map(); }
    }
    return;
  }
  if (!on) {
    try { prep('UPDATE files SET has_content = 0').run(); } catch (_) {}
    db.exec('DROP TABLE IF EXISTS content_fts');
    db.exec('DROP TABLE IF EXISTS ftsmap');
    metaSet('indexContent', '0');
    contentOn = false;
    stmtCache = new Map(); // cached statements may reference the dropped tables
    try { db.exec('VACUUM'); } catch (e) { wlog('index: VACUUM after content-off failed: ' + e.message); }
    wlog('index: content layer dropped (indexContent=false) — search falls back to live scan');
  } else {
    createSchema();
    stmtCache = new Map();
    metaSet('indexContent', '1');
    contentOn = true;
    wlog('index: content layer enabled — content attaches on the next crawl pass');
  }
  postStatus();
}

// Shared crawl-end drain used by BOTH crawl paths (runCrawlQueue and
// addExtraRoot): re-arms the watch flushes that deferred while crawling (only
// roots that actually hold pending dirs), resyncs roots whose watcher died
// mid-crawl, and gives the WAL a last TRUNCATE now that the worker is idle.
// The resyncs are awaited in series on purpose: reindexTree is paced, but
// running several concurrently would sum duties past the process budget again.
async function finishCrawlDrain(why) {
  // watch flushes that deferred while crawling (the crawl's own visit covered
  // most dirs already; these catch deltas that landed after each dir's walk)
  for (const [rn, w] of watchers) if (w.pending.size) scheduleWatchFlush(rn);
  for (const rn of postCrawlResync) {
    postCrawlResync.delete(rn);
    // the root may have left the config mid-crawl: never resurrect its rows
    if (!desiredWatchRoots.has(rn) && !watchers.has(rn)) continue;
    try { await reindexTree(rn, rn); }
    catch (e) { wlog(`index: post-crawl resync of ${rn} failed: ${e.message}`); }
  }
  // queue idle: shrink the WAL to 0, retrying past busy readers (see helper)
  truncateWalSoon(`${why} drained`);
}

async function runCrawlQueue() {
  if (crawling || !crawlQueue.length) return;
  crawling = true;
  postStatus();
  try {
    while (crawlQueue.length) {
      const job = crawlQueue.shift();
      configRoots = job.roots;
      scopes = job.scopes;
      realScopesL = job.realScopes;
      skipDirNames = new Set([...BASE_SKIP_DIRS, ...(Array.isArray(job.skipDirs) ? job.skipDirs.map(s => String(s).toLowerCase()) : [])]);
      secretScanOn = job.secretScan !== false;
      secretSkipNames = Array.isArray(job.secretSkipDirs) ? job.secretSkipDirs.map(s => String(s)) : [];
      secretSkipCache.clear();
      maxBytesCap = (typeof job.maxMB === 'number' && job.maxMB >= 0 ? job.maxMB : 2048) * 1048576;
      // config is the source of truth on every crawl: reconcile the content layer
      if (typeof job.contentEnabled === 'boolean' && job.contentEnabled !== contentOn) contentLayerApply(job.contentEnabled);
      // a zero/empty budget (or a DB already over budget) caps content right now
      if (!contentCapped && dbBytes() >= maxBytesCap) {
        contentCapped = true;
        metaSet('indexCapped', '1');
        if (job.maxMB === 0) wlog('index: indexMaxMB is 0 — metadata-only crawl');
      }
      // cap hysteresis: re-read content again once the DB shrank back under 90%
      if (contentCapped && dbBytes() < maxBytesCap * 0.9) {
        contentCapped = false;
        metaSet('indexCapped', '0');
      }
      const t0 = Date.now();
      let total = 0;
      const rs = roots();
      watchRoots(rs); // live updates between crawls (per-dir deltas keep diragg exact)
      for (const r of rs) total += await crawlRootInternal(r);
      lastCrawlMs = Date.now() - t0;
      lastCrawlAt = Date.now();
      metaSet('lastCrawlMs', lastCrawlMs);
      metaSet('lastCrawlAt', lastCrawlAt);
      wlog(`index: crawl done ${total} files in ${lastCrawlMs}ms (roots: ${rs.length})`);
      postStatus();
      // posted first: a contended TRUNCATE may block up to busy_timeout (2 s)
      checkpointWal('TRUNCATE', 'crawl job end');
    }
  } finally {
    crawling = false;
    postStatus();
    await finishCrawlDrain('crawl queue');
  }
}

function enqueueCrawl(roots_, scopes_, realScopes_, skipDirs, maxMB, contentEnabled, secretScan, secretSkipDirs) {
  crawlQueue.push({ roots: roots_, scopes: scopes_, realScopes: realScopes_, skipDirs, maxMB, contentEnabled, secretScan, secretSkipDirs });
  runCrawlQueue().catch(() => {});
}

async function reindexDir(abs) {
  const absResolved = path.resolve(abs);
  const dirNorm = norm(absResolved);
  const { metas, entries } = await scanDirFiles(absResolved);
  if (entries === null) return; // unreadable dir → keep its rows
  await new Promise(r => setImmediate(r));
  const { writeQueue, flush } = makeWriteQueue();
  try {
    await syncDirRows(dirNorm, absResolved, metas, writeQueue, flush);
    flush();
  } catch (_) {
    try { db.exec('ROLLBACK'); } catch (_) {}
  }
}

// ---------- search (the heavy part: trigram-AND candidates + exact verify) ----------
function likeEscape(s) { return s.replace(/[\\%_]/g, m => '\\' + m); }
// detail='none' rejects PHRASE queries, and under the trigram tokenizer ANY
// token longer than 3 chars is internally a phrase (of its trigrams) — so a
// plain MATCH can only ever name one 3-char term. The query therefore ANDs the
// rowid sets of the query's own trigrams via INTERSECT. Grams are extracted
// per alphanumeric run (the trigram tokenizer emits no gram across separator
// chars like spaces/hyphens), lowercased (tokenizer folds case; lowercase also
// keeps the FTS5 uppercase-only keywords AND/OR/NOT from being parsed). Every
// required gram lies inside one run, so any document containing the literal
// query is guaranteed to be in the candidate set — verification (exact
// substring, below) only ever drops false positives, never true matches.
const MAX_QUERY_GRAMS = 32; // a subset is still a superset of true matches
function queryGrams(q) {
  const seen = new Set(); const out = [];
  const runs = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  for (const run of runs) {
    for (let i = 0; i + 3 <= run.length; i++) {
      const g = run.slice(i, i + 3);
      if (!seen.has(g)) { seen.add(g); out.push(g); }
    }
  }
  return out.slice(0, MAX_QUERY_GRAMS);
}

function prefixClause(absNorm) {
  if (absNorm === '/') return { sql: '', args: [] };
  // dirs is small (≈#dirs) but the range form stays sargable on path's UNIQUE
  // index and has no JS-vs-SQLite length semantics; the files-side probe is an
  // integer IN either way
  const up = underPrefix('path', absNorm);
  return { sql: ` AND f.dirid IN (SELECT id FROM dirs WHERE ${up.sql})`, args: up.args };
}

function searchExtClause(filter) {
  // live-scan parity: search only ever sees textlike files ≤ 5 MB
  const sql = ` AND f.size <= ${MAX_TEXT_BYTES} AND f.kind IN (${TEXTLIKE_LIST.map(() => '?').join(',')})`;
  const args = [...TEXTLIKE_LIST];
  if (filter && filter.mode === 'set' && filter.set.size) {
    return { sql: sql + ' AND f.ext IN (' + [...filter.set].map(() => '?').join(',') + ')', args: [...args, ...filter.set] };
  }
  return { sql, args };
}

async function searchInternal(rootAbs, q, extsRaw, limit) {
  const absNorm = norm(rootAbs);
  if (!covered(absNorm)) return null; // main also gates this; belt and braces
  const t0 = Date.now();
  const qLow = q.toLowerCase();
  const filter = parseExts(extsRaw);
  const pre = prefixClause(absNorm);
  const ext = searchExtClause(filter);
  const fetchLimit = Math.min(2000, Math.max(limit * 2, limit + 25));

  const rows = new Map(); // files.id -> row
  // the FTS table is contentless: its rowid resolves to the file via ftsmap
  const FIELDS = 'f.id AS k, f.dirid, f.name, f.ext, f.kind, f.size, f.mtime, f.has_content, d.path AS dpath, d.rpath AS drpath';
  const FROM_JOINS = 'JOIN dirs d ON d.id = f.dirid';
  const grams = contentOn && q.length >= 3 ? queryGrams(q) : [];
  if (grams.length) {
    // MATCH must name the real table on contentless-delete FTS5 (aliasing it
    // errors with "no such column: ft"), and one MATCH per gram: a pure
    // 3-char lowercase term is a plain term, never a phrase
    const subQ = grams.map(() => 'SELECT rowid FROM content_fts WHERE content_fts MATCH ?').join(' INTERSECT ');
    // stopword-scale gram sets: skip the full-row mtime sort (see BIG_GRAM_SET)
    const gramCount = prep('SELECT COUNT(*) AS c FROM content_fts WHERE content_fts MATCH ?').get(grams[0]).c;
    const sortSql = gramCount > BIG_GRAM_SET ? '' : ' ORDER BY f.mtime DESC';
    const ftsSql =
      `SELECT ${FIELDS}, 1 AS contentHit
       FROM (${subQ}) g
       JOIN ftsmap m ON m.rowid = g.rowid JOIN files f ON f.id = m.fileid ${FROM_JOINS}
       WHERE 1 = 1${pre.sql}${ext.sql}${sortSql}
       LIMIT ?`;
    for (const r of prep(ftsSql).all(...grams, ...pre.args, ...ext.args, fetchLimit)) rows.set(r.k, r);
  }
  // name matches always come from the files table. 1–2 char queries are
  // name-only: trigram needs 3+ chars, and the old DB-side content LIKE is
  // impossible with a contentless table (documented in README)
  const nameSql =
    `SELECT ${FIELDS}, 0 AS contentHit
     FROM files f ${FROM_JOINS}
     WHERE f.name LIKE ? ESCAPE '\\'${pre.sql}${ext.sql}
     ORDER BY f.mtime DESC LIMIT ?`;
  for (const r of prep(nameSql).all('%' + likeEscape(qLow) + '%', ...pre.args, ...ext.args, fetchLimit)) {
    if (!rows.has(r.k)) rows.set(r.k, r);
  }

  const sorted = [...rows.values()].sort((a, b) => b.mtime - a.mtime);
  const out = [];
  const scanned = sorted.length;
  // every reported content hit is verified against the actual file text
  // (detail='none' can false-positive, and staleness must never leak through).
  // The pass is bounded by a wall-clock budget AND a read count, and runs with
  // VERIFY_CONCURRENCY parallel head reads (a serial pass measured 5 s for a
  // 400-candidate query on the HDD); candidates left unprocessed when a budget
  // fires are reported as truncated — the same flag the live scan uses.
  const readBudget = Math.max(limit * 2, MAX_VERIFY_READS);
  const deadline = Date.now() + VERIFY_BUDGET_MS;
  let reads = 0;
  let truncated = false;

  // reconstructed absolute path for fs ops / display: real when the dirs row
  // carries it, norm'd otherwise (lowercase display on win32 for all-lowercase
  // trees is the trade of normalisation; NTFS lookups are case-insensitive)
  const joinUnder = (dirReal, name) => dirReal.endsWith(SEP) ? dirReal + name : dirReal + SEP + name;
  const rowAbs = row => joinUnder(row.drpath || row.dpath, row.name);

  // one candidate: verify + refresh; returns the result row or null (not a hit)
  async function verifyRow(row) {
    const rAbs = rowAbs(row);
    // staleness guard: re-stat every result; on mtime/size drift re-read the
    // head, re-verify the match, and fix the index row
    let st;
    try { st = await fs.promises.stat(rAbs); } catch (_) { deleteRowId(row.k); return null; }
    const meta = { dirid: row.dirid, name: row.name, ext: row.ext, kind: row.kind, size: st.size, mtime: st.mtimeMs };
    const stale = row.size !== st.size || Math.abs(row.mtime - st.mtimeMs) > 1e-6;
    const nameHit = row.name.toLowerCase().includes(qLow) ? 1 : 0;
    let occ = 0, snippet = '';
    if (row.contentHit === 1) {
      if (!isTextIndexable(row.kind, st.size)) {
        if (stale) upsertRow({ ...meta, content: null }); // grew past the gate → metadata only
        if (nameHit === 0) return null;
      } else {
        reads++;
        const content = await readContent(rAbs);
        // the cap gates NEW content only; refreshing an existing row is not growth
        if (stale) upsertRow({ ...meta, content, secret: secretFor(row.dpath, content) });
        if (content === null) {
          if (nameHit === 0) return null; // unreadable/binary now: cannot verify
        } else {
          const low = content.toLowerCase();
          occ = countOccurrences(low, qLow);
          if (occ === 0) {
            if (nameHit === 0) return null; // trigram-AND false positive: drop
          } else {
            snippet = makeSnippet(content, low.indexOf(qLow), q.length);
          }
        }
      }
    } else if (stale && isTextIndexable(row.kind, st.size)) {
      // pure name hit whose content changed: refresh the (contentless) row
      reads++;
      const content = await readContent(rAbs);
      upsertRow({ ...meta, content, secret: secretFor(row.dpath, content) });
    } else if (stale) {
      upsertRow({ ...meta, content: null });
    }
    const hits = occ + nameHit;
    if (hits === 0) return null; // content changed: the match vanished
    return {
      name: row.name, path: rAbs, size: st.size, mtime: st.mtimeMs,
      ext: row.ext, kind: row.kind, hits, snippet,
      rel: path.relative(path.resolve(rootAbs), rAbs)
    };
  }

  let i = 0;
  while (i < sorted.length && out.length < limit) {
    const row = sorted[i];
    if (row.contentHit === 1 && reads >= readBudget) { truncated = true; break; }
    if (Date.now() > deadline) { truncated = true; break; }
    // one parallel window of candidates, order preserved within it
    const chunk = [];
    while (chunk.length < VERIFY_CONCURRENCY && i < sorted.length && out.length < limit) {
      const c = sorted[i];
      if (c.contentHit === 1 && reads >= readBudget) break; // leave it for the outer check
      chunk.push(c); i++;
    }
    if (!chunk.length) { truncated = true; break; } // next candidate needs a read we no longer budget
    const results = await Promise.all(chunk.map(verifyRow));
    for (const r of results) { if (r && out.length < limit) out.push(r); }
  }
  // hitting `limit` is plain capping (SQL-LIMIT semantics, not truncation):
  // truncated only means candidates went UNVERIFIED because a budget fired
  return { files: out, scanned, truncated, ms: Date.now() - t0, indexed: true };
}

// ---------- message loop ----------
// extra roots are user-driven (a search outside the configured roots); a drive /
// filesystem root + an unbounded list would make one stray search crawl a whole
// drive, so refuse roots and keep at most MAX_EXTRA_ROOTS (oldest evicted)
const MAX_EXTRA_ROOTS = 10;
function isFsRoot(np) {
  return IS_WIN ? /^[a-z]:$/i.test(np) : np === SEP;
}

function addExtraRoot(abs) {
  const absNorm = norm(abs);
  if (rootCovering(absNorm)) return;
  if (isFsRoot(absNorm)) { wlog(`index: refusing filesystem root ${abs} as extra root`); return; }
  extraRoots = extraRoots.filter(r => norm(r) !== absNorm);
  extraRoots.push(path.resolve(abs));
  while (extraRoots.length > MAX_EXTRA_ROOTS) {
    const evicted = extraRoots.shift();
    const en = norm(evicted);
    try { metaDel('crawled:' + en); } catch (_) {}
    crawledRoots.delete(en); // main's covered() reads meta live, worker uses this set
    wlog(`index: forgetting extra root ${evicted} (over ${MAX_EXTRA_ROOTS})`);
  }
  metaSet('extraRoots', JSON.stringify(extraRoots));
  wlog(`index: remembering extra root ${abs}`);
  crawlQueue.push({ roots: configRoots, scopes, realScopes: realScopesL, only: path.resolve(abs) });
  // the queue runner crawls all roots(); for an extra root alone we restrict:
  (async () => {
    if (crawling) return; // runCrawlQueue will pick the queue up when it finishes
    crawling = true;
    postStatus();
    try {
      crawlQueue.length = 0;
      const t0 = Date.now();
      watchRoots([abs]);
      const n = await crawlRootInternal(path.resolve(abs));
      lastCrawlMs = Date.now() - t0;
      lastCrawlAt = Date.now();
      metaSet('lastCrawlMs', lastCrawlMs);
      metaSet('lastCrawlAt', lastCrawlAt);
      checkpointWal('TRUNCATE', 'extra-root crawl end');
      wlog(`index: crawl done ${n} files in ${lastCrawlMs}ms (roots: 1)`);
    } finally {
      crawling = false;
      postStatus();
      // same drain as runCrawlQueue: pending watch flushes re-arm + TRUNCATE,
      // otherwise watch events that arrived during this extra-root crawl would
      // sit in w.pending until some unrelated event woke the timer
      await finishCrawlDrain('extra-root crawl');
      runCrawlQueue().catch(() => {});
    }
  })();
}

parentPort.on('message', m => {
  if (!m || typeof m !== 'object') return;
  try {
    switch (m.op) {
      case 'crawl':
        enqueueCrawl(m.roots || [], m.scopes || [], m.realScopes || [], m.skipDirs, m.maxMB, m.contentEnabled, m.secretScan, m.secretSkipDirs);
        break;
      case 'watch':
        // scopes land early (even when the boot crawl is skipped) so the
        // watchers can start immediately and isAllowedHere works for their flushes
        if (Array.isArray(m.scopes)) scopes = m.scopes;
        if (Array.isArray(m.realScopes)) realScopesL = m.realScopes;
        if (Array.isArray(m.roots) && m.roots.length) configRoots = m.roots;
        watchRoots(m.roots || []);
        break;
      case 'contentToggle':
        contentLayerApply(m.on);
        post({ type: 'contentToggled', id: m.id, on: contentOn });
        if (contentOn) enqueueCrawl(configRoots || [], scopes || [], realScopesL || [], [...skipDirNames].filter(d => !BASE_SKIP_DIRS.has(d)), maxBytesCap / 1048576, true, secretScanOn, secretSkipNames);
        break;
      case 'extraRoot':
        addExtraRoot(m.abs);
        break;
      case 'reindexDir':
        reindexDir(m.abs).catch(() => {});
        break;
      case 'renamed':
        applyRenamed(m.oldAbs, m.newAbs);
        break;
      case 'removed':
        applyRemoved(m.abs);
        break;
      case 'search':
        searchInternal(m.rootAbs, m.q, m.extsRaw, m.limit)
          .then(result => post({ type: 'search', id: m.id, result }))
          .catch(err => post({ type: 'search', id: m.id, result: null, error: String(err && err.message || err) }));
        break;
    }
  } catch (err) {
    wlog(`index: worker job error: ${err.message}`);
    if (m.op === 'search') post({ type: 'search', id: m.id, result: null, error: String(err.message) });
  }
});

// boot
try {
  openDb();
  lastCrawlMs = Number(metaGet('lastCrawlMs')) || null;
  lastCrawlAt = Number(metaGet('lastCrawlAt')) || null;
  // a root crawled under v7 has covered() true but no diragg rollup yet → the
  // main thread needs a boot crawl even when lastCrawlAt is fresh
  let aggPending = false;
  try {
    for (const rn of crawledRoots) if (!metaGet('aggready:' + rn)) { aggPending = true; break; }
  } catch (_) {}
  post({ type: 'ready', available: true, crawling, files: fileCount(), lastCrawlMs, lastCrawlAt, aggPending });
  // boot housekeeping: a WAL left behind by the previous run (the old process
  // may have died between checkpoints, or its final TRUNCATE raced a reader)
  // otherwise survives untouched whenever the boot crawl is skipped. journal_
  // size_limit only caps the file, so use a small threshold — a WAL parked at
  // the 4 MB limit is exactly what this should reclaim. 30 s in so the boot
  // crawl — if any — has claimed `crawling` and we stay out of it.
  const bootTrunc = setTimeout(() => {
    if (!crawling && walBytesOnDisk() > 1048576) truncateWalSoon('boot housekeeping');
  }, 30000);
  if (bootTrunc.unref) bootTrunc.unref();
} catch (_) {
  // openDb already posted ready:false
}

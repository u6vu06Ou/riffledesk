// riffledesk (formerly 3jsfloder) - local read-only file server for the 3D file browser (v2).
// Zero dependencies. Binds 127.0.0.1 only. Node >= 18. Windows / macOS / Linux / WSL.
'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { URL } = require('node:url');
const convos = require('./convos.js'); // AI-transcript scanner (no-op cost until /api/conv* is hit)
const { createIndexer } = require('./indexer');
const { createFileOps, writeAtomic } = require('./fileops');
const { scanText, maskValue, looksBinary: looksSecretBinary, anySegmentSkipped } = require('./secrets');

const HOST = '127.0.0.1';
const ROOT_DIR = __dirname;
const PKG = require('./package.json');
const IS_WIN = process.platform === 'win32';
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const envPick = (a, b) => process.env[a] || process.env[b]; // RIFFLEDESK_* preferred, FLODER_* kept for compatibility

// ---------- demo mode (RIFFLEDESK_DEMO=<dir>) ----------
// Browse exactly one folder, hide the drive list, read the fake AI transcripts inside
// it, and display a made-up home instead of the real one — so screenshots and videos
// carry no real user name. Every path crosses the API boundary translated: inbound
// paths are mapped fake→real (demoReal), outbound JSON real→fake (sendJson/sendSse).
// Nothing here runs unless the env var is set.
const DEMO_DIR = process.env.RIFFLEDESK_DEMO ? path.resolve(process.env.RIFFLEDESK_DEMO) : null;
const DEMO_SEP = IS_WIN ? '\\' : '/';
const DEMO_HOME_FAKE = IS_WIN ? 'C:\\Users\\demo' : '/home/demo';

// config + index.db + the fake transcripts live in a sibling ".state" folder, so the
// browsed tree stays exactly what the demo authored (nothing extra shows up in it).
const DEMO_STATE_DIR = DEMO_DIR ? DEMO_DIR + '.state' : null;

const CONFIG_PATH = envPick('RIFFLEDESK_CONFIG', 'FLODER_CONFIG')
  ? path.resolve(envPick('RIFFLEDESK_CONFIG', 'FLODER_CONFIG'))
  : (DEMO_DIR ? path.join(DEMO_STATE_DIR, 'config.json') : defaultConfigPath());

// The whole demo tree is the fake home; anything above it is never shown.
const DEMO_HOME_REAL = DEMO_DIR;

// fake → real (API input), and real → fake (API output). Both leave other paths alone.
function demoReal(p) {
  if (!DEMO_DIR || typeof p !== 'string' || !p) return p;
  const s = p.replace(/\//g, DEMO_SEP);
  if (s === DEMO_HOME_FAKE) return DEMO_HOME_REAL;
  if (s.startsWith(DEMO_HOME_FAKE + DEMO_SEP)) return DEMO_HOME_REAL + s.slice(DEMO_HOME_FAKE.length);
  return s;
}
function demoFake(p) {
  if (!DEMO_DIR || typeof p !== 'string' || !p) return p;
  const s = p.replace(/\//g, DEMO_SEP);
  const root = DEMO_HOME_REAL.replace(/\//g, DEMO_SEP);
  if (s === root) return DEMO_HOME_FAKE;
  if (s.startsWith(root + DEMO_SEP)) return DEMO_HOME_FAKE + s.slice(root.length);
  return s;
}
function demoFakeDeep(v) {          // walk a JSON-ish value and fake every path-ish string
  if (v == null) return v;
  if (typeof v === 'string') return demoFake(v);
  if (Array.isArray(v)) return v.map(demoFakeDeep);
  if (typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[k] = demoFakeDeep(v[k]);
    return out;
  }
  return v;
}

// content layer (full-text index) default when config.json lacks "indexContent".
// Chosen from the measured full-crawl projection — see README "Disk budget".
const DEFAULT_INDEX_CONTENT = true;

// User-level config when we are running from an installed package (npx npm cache /
// global node_modules is redrawn on updates — config must not live there).
function defaultConfigPath() {
  if (ROOT_DIR.includes(path.sep + 'node_modules' + path.sep)) {
    const dir = path.join(os.homedir(), '.' + PKG.name);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    return path.join(dir, 'config.json');
  }
  return path.join(ROOT_DIR, 'config.json');
}
const MAX_TEXT_BYTES = 512 * 1024;        // text preview cap (full read)
const MAX_SHEET_BYTES = 20 * 1024 * 1024; // xlsx raw download cap
const MAX_HEAD_BYTES = 64 * 1024;         // cap for ?head= partial reads

// ---------- file typing ----------
const KIND = {
  '.md': 'markdown', '.markdown': 'markdown',
  '.txt': 'text', '.log': 'text', '.rst': 'text', '.tex': 'text',
  '.html': 'html', '.htm': 'html',
  '.json': 'json',
  '.csv': 'table', '.tsv': 'table',
  '.xlsx': 'sheet', '.xls': 'sheet',
  '.yaml': 'code', '.yml': 'code', '.toml': 'code', '.ini': 'code', '.cfg': 'code',
  '.py': 'code', '.js': 'code', '.mjs': 'code', '.ts': 'code', '.tsx': 'code',
  '.jsx': 'code', '.css': 'code', '.scss': 'code', '.less': 'code',
  '.c': 'code', '.h': 'code', '.cpp': 'code', '.hpp': 'code', '.cc': 'code',
  '.cs': 'code', '.java': 'code', '.go': 'code', '.rs': 'code', '.rb': 'code',
  '.php': 'code', '.sh': 'code', '.bash': 'code', '.bat': 'code', '.ps1': 'code',
  '.sql': 'code', '.lua': 'code', '.vue': 'code', '.xml': 'code',
  '.svg': 'image', '.png': 'image', '.jpg': 'image', '.jpeg': 'image',
  '.gif': 'image', '.webp': 'image',
  '.pdf': 'pdf'
};
const READABLE_EXTS = new Set(Object.keys(KIND));
const TEXTLIKE = new Set(['markdown', 'text', 'html', 'json', 'table', 'code']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8', '.csv': 'text/plain; charset=utf-8',
  '.tsv': 'text/plain; charset=utf-8'
};

// ---------- /raw/ : whole-file serving for the "run page scripts" preview ----------
// The reader can opt one HTML file into script execution. That iframe is sandboxed
// WITHOUT allow-same-origin (opaque origin), loaded from /raw/<abs path> instead of
// the UI origin's srcdoc, so its scripts can never carry this origin's credentials —
// and the write APIs additionally require a same-origin Origin header, which an
// opaque origin cannot produce (it serializes as "null").
// /raw/ is path-style (/raw/D:/dir/page.html) precisely so relative URLs inside the
// page (./app.js, ../lib/x.css, images) resolve back under /raw/ naturally.
// Two header consequences: the default CORP:same-origin set for every response must
// be relaxed to cross-origin here (an opaque-origin document could not read its own
// subresources otherwise), and GETs need Access-Control-Allow-Origin:* because
// opaque-origin module scripts are fetched in CORS mode.
const RAW_MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.avif': 'image/avif', '.bmp': 'image/bmp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8', '.tsv': 'text/plain; charset=utf-8'
};
// text types that get the file:/// → /raw/ rewrite (read fully, up to the cap)
const RAW_REWRITE_EXTS = new Set(['.html', '.htm', '.js', '.mjs', '.cjs', '.css']);
const RAW_REWRITE_CAP = 32 * 1024 * 1024;

// Capability tokens for /raw/. A token is minted by GET /api/rawopen (same-origin
// only, like every /api/ read: Sec-Fetch-Site guard, no CORS headers) and is the
// first path segment of every raw URL: /raw/<token>/<encoded abs path>. The token
// is an unguessable 128-bit random value, so cross-origin pages — including any
// website's own opaque-origin iframe, which we cannot tell apart from OURS at the
// HTTP level — simply do not have one, and unknown tokens only ever answer 404
// (no existence oracle, no scope disclosure: the response looks identical to a
// missing file).
// Scoping: a token only serves files (a) under the directory of the HTML file it
// was opened for, plus (b) absolute paths this server itself emitted into that
// directory's pages via the file:/// rewrite (recorded in `allow` at rewrite time,
// so a leaked token still cannot read arbitrary disk paths outside that page's
// own web of references). Tokens live for the server session.
const rawTokens = new Map();   // token → { abs, dir: norm(dir of opened file), allow: Set(norm abs), revise }
function tokenEntry(token) {
  return typeof token === 'string' && /^[0-9a-f]{32}$/.test(token) ? rawTokens.get(token) : undefined;
}

// abs path → per-segment percent-encoded path tail (no '/raw/' prefix, no token;
// a POSIX absolute path keeps its leading slash as an empty first segment)
function rawPathFor(abs) {
  return path.resolve(abs).split(/[\\/]+/).map(s => encodeURIComponent(s)).join('/');
}
function rawUrlFor(abs, token) {
  return '/raw/' + token + '/' + rawPathFor(DEMO_DIR ? demoFake(abs) : abs);
}
// inverse of rawPathFor: path tail after '/raw/<token>/' → absolute path
function rawPathToAbs(tail) {
  const segs = tail.split('/').map(s => { try { return decodeURIComponent(s); } catch (_) { return s; } });
  return path.resolve(demoReal(segs.join(path.sep)));
}

// Rewrite `file:///D:/x/y.js`, `file:///C:\a\b.css`, `file:///home/u/x.js` (forward or
// back slashes) found in served text to the matching tokened /raw/ URL — but only
// when the target is inside an allowed scope; out-of-scope file:/// URLs are left
// untouched (an http(s) page cannot load file:// URLs anyway, so leaving them is
// inert & safe). Every emitted target is registered into the token's allowlist,
// which is how files OUTSIDE the opened page's own directory become reachable.
const FILE_URL_RE = /file:(?:[\\/]{2,3})([^'"()\s<>`]+)/gi;
function rewriteFileUrls(text, token) {
  const entry = tokenEntry(token);
  FILE_URL_RE.lastIndex = 0;
  return text.replace(FILE_URL_RE, (m, p1) => {
    let rel = p1;
    try { rel = decodeURIComponent(rel); } catch (_) {}
    if (/^\/[A-Za-z]:[\\/]/.test(rel)) rel = rel.slice(1);   // '/D:/x' → 'D:/x'
    if (IS_WIN ? !/^[A-Za-z]:[\\/]/.test(rel) : !rel.startsWith('/')) return m;
    if (rel.includes('\0')) return m;
    const abs = path.resolve(rel);
    if (!isAllowed(abs)) return m;
    if (entry) entry.allow.add(norm(abs));
    return rawUrlFor(abs, token);
  });
}

// ---------- revise mode ("✎ 改版"): inject the click-to-change agent ----------
// The revise agent is a normal /raw/-served script (the iframe is an opaque origin,
// so it cannot use /api/* — those are Sec-Fetch-Site-guarded). It is registered on
// the token's allowlist when the token is minted WITH the revise flag, and injected
// right before </body> of the opened page. The agent in turn posts to the parent
// window only; the parent (same origin) does the /api/revise/save call.
const REVISE_AGENT = path.join(PUBLIC_DIR, 'revise-agent.js');
// page <script> blocks — stripped in revise mode unless the user opted into running
const SCRIPT_RE = /<script\b[\s\S]*?<\/script\s*>|<script\b[^>]*\/>/gi;
const REVISE_BODY_RE = /<\/body\s*>/i;

function injectReviseAgent(html, token, abs, run) {
  if (!run) html = html.replace(SCRIPT_RE, '');
  const tag = `<script src="${rawUrlFor(REVISE_AGENT, token)}?target=${encodeURIComponent(abs)}"></script>`;
  if (REVISE_BODY_RE.test(html)) return html.replace(REVISE_BODY_RE, m => tag + m);
  return html + tag;
}

function serveRaw(req, res, tail) {
  // tail = <token>/<encoded abs path>. Anything without a live token is a plain
  // 404 — deliberately indistinguishable from a missing file (no oracles).
  const slash = tail.indexOf('/');
  const token = slash < 0 ? tail : tail.slice(0, slash);
  const pathTail = slash < 0 ? '' : tail.slice(slash + 1);
  const entry = tokenEntry(token);
  if (!entry) return sendJson(res, 404, { ok: false, error: 'not found' });
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { ok: false, error: 'GET/HEAD only' });
  }
  if (!pathTail || pathTail.includes('\0')) return sendJson(res, 400, { ok: false, error: 'bad path' });
  const abs = rawPathToAbs(pathTail);
  if (!isAllowed(abs)) return sendJson(res, 403, { ok: false, error: 'path not under allowed scopes' });
  // token scope: the opened page's own directory tree, or a file this server
  // itself emitted via the file:/// rewrite for one of that tree's pages.
  const nAbs = norm(abs);
  if (!(nAbs === entry.dir || nAbs.startsWith(entry.dir + path.sep)) && !entry.allow.has(nAbs)) {
    return sendJson(res, 404, { ok: false, error: 'not found' });
  }
  let st;
  try { st = fs.statSync(abs); } catch (_) { return sendJson(res, 404, { ok: false, error: 'not found' }); }
  if (!st.isFile()) return sendJson(res, 400, { ok: false, error: 'not a file' });
  const ext = path.extname(abs).toLowerCase();
  // override the cross-origin default set in requestHandler (setHeader replaces)
  res.setHeader('cross-origin-resource-policy', 'cross-origin');
  const head = {
    'content-type': RAW_MIME[ext] || 'application/octet-stream',
    'access-control-allow-origin': '*',
    // do not let the served page's URL (it carries the capability token) leave
    // this server in a Referer header when the page fetches third-party stuff
    'referrer-policy': 'no-referrer'
  };
  if (entry.revise && (ext === '.html' || ext === '.htm')) {
    // (the revise flag lives on the token, not the page URL, so a reload of the
    // same /raw/ URL keeps working)
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch (_) {
      return sendJson(res, 500, { ok: false, error: 'read failed' });
    }
    text = injectReviseAgent(text, token, entry.abs, entry.run);
    const out = Buffer.from(rewriteFileUrls(text, token), 'utf8');
    res.writeHead(200, { ...head, 'cache-control': 'no-store', 'content-length': out.length });
    if (req.method === 'HEAD') return res.end();
    return res.end(out);
  }
  if (RAW_REWRITE_EXTS.has(ext) && st.size <= RAW_REWRITE_CAP) {
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch (_) {
      return sendJson(res, 500, { ok: false, error: 'read failed' });
    }
    const buf = Buffer.from(rewriteFileUrls(text, token), 'utf8');
    res.writeHead(200, { ...head, 'content-length': buf.length });
    if (req.method === 'HEAD') return res.end();
    return res.end(buf);
  }
  res.writeHead(200, { ...head, 'content-length': st.size });
  if (req.method === 'HEAD' || st.size <= 0) return res.end();
  const s = fs.createReadStream(abs);
  s.pipe(res);
  s.on('error', () => res.end());
}

// ---------- config ----------
function defaultRoots() {
  const roots = [os.homedir()];
  const docs = path.join(os.homedir(), 'Documents');
  try { if (fs.statSync(docs).isDirectory()) roots.push(docs); } catch (_) {}
  return roots;
}

function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function loadConfig() {
  // demo mode: one root (the fake home), no pinned, transcripts read from inside it
  if (DEMO_DIR) {
    const project = path.join(DEMO_HOME_REAL, 'Documents', 'aurora-labs');
    const cfg = {
      roots: [DEMO_HOME_REAL],
      pinned: (() => { try { return fs.statSync(project).isDirectory() ? [project] : []; } catch (_) { return []; } })(),
      indexContent: false,
      convoRoots: [{ kind: 'claude', dir: path.join(DEMO_HOME_REAL, '.claude', 'projects') }, { kind: 'codex', dir: path.join(DEMO_HOME_REAL, '.codex', 'sessions') }],
      secretScan: true
    };
    try { fs.mkdirSync(DEMO_STATE_DIR, { recursive: true }); } catch (_) {}
    // the demo tree is browsed; its own dot-dirs (fake transcripts) must stay off-limits?
    // no: nothing lives outside DEMO_DIR, scope = the whole fake home
    return cfg;
  }
  const cfg = { roots: defaultRoots(), pinned: [], indexContent: DEFAULT_INDEX_CONTENT };
  try {
    let rawText = null;
    try { rawText = fs.readFileSync(CONFIG_PATH, 'utf8'); } catch (_) {}
    if (rawText) {
      let raw;
      try {
        raw = JSON.parse(rawText);
      } catch (err) {
        // keep the user's file untouched; just warn loudly
        console.error(`${PKG.name}: cannot parse ${CONFIG_PATH} (${err.message}) — using defaults in memory`);
        return cfg;
      }
      if (Array.isArray(raw.roots)) cfg.roots = raw.roots.map(expandHome);
      if (Array.isArray(raw.pinned)) cfg.pinned = raw.pinned.map(expandHome);
      if (Array.isArray(raw.convoRoots)) cfg.convoRoots = raw.convoRoots; // AI transcript roots (strings or {kind,dir})
      if (Array.isArray(raw.indexSkipDirs)) cfg.indexSkipDirs = raw.indexSkipDirs.map(String);
      if (Number.isFinite(Number(raw.indexMaxMB))) cfg.indexMaxMB = Number(raw.indexMaxMB);
      // content layer default: see README "Disk budget" — flipped only after a
      // measured full-crawl projection is known (indexContent in config wins)
      if (raw.indexContent !== undefined) cfg.indexContent = !!raw.indexContent;
      else cfg.indexContent = DEFAULT_INDEX_CONTENT;
      // suspected-secret scan: on by default; secretScanSkipDirs is a list of
      // plain dir NAMES — any matching path segment skips the scan (file still listed)
      if (raw.secretScan !== undefined) cfg.secretScan = !!raw.secretScan;
      else cfg.secretScan = true;
      if (Array.isArray(raw.secretScanSkipDirs)) cfg.secretScanSkipDirs = raw.secretScanSkipDirs.map(String);
    } else {
      // first run: persist platform defaults so the user has a file to edit
      try { saveConfig(cfg); } catch (_) {}
    }
  } catch (_) {}
  return cfg;
}

function saveConfig(cfg) {
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, CONFIG_PATH);
}

let config = loadConfig();
function persistConfig() { saveConfig(config); realScopesCache = null; }

// ---------- local fixed drives / mounts ----------
// Returns [{ path, label }] with label === path; the front end builds localized labels.
// Short-TTL cache so newly attached/unattached volumes show up without a restart
// and hot paths (allowedScopes per request) do not redo 26 sync stats each time.
let driveCache = null; // { t, list, fp }
function localDrives() {
  const now = Date.now();
  if (driveCache && now - driveCache.t < 10000) return driveCache.list;
  const items = [];
  const seen = new Set(); // dedupe by realpath (e.g. /Volumes/Macintosh HD -> /)
  const push = (p) => {
    try { if (!fs.statSync(p).isDirectory()) return; } catch (_) { return; }
    let key;
    try { key = norm(fs.realpathSync(p)); } catch (_) { key = norm(p); }
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ path: p, label: p });
  };
  if (IS_WIN) {
    for (let i = 65; i <= 90; i++) push(String.fromCharCode(i) + ':\\');
  } else {
    const subdirsOf = (base) => {
      let ents;
      try { ents = fs.readdirSync(base, { withFileTypes: true }); } catch (_) { return; }
      for (const e of ents) {
        // include real dirs and symlinked mounts (e.g. /Volumes/Macintosh HD -> /)
        if (e.isDirectory() || e.isSymbolicLink()) push(path.join(base, e.name));
      }
    };
    push('/');
    if (process.platform === 'darwin') {
      subdirsOf('/Volumes');
    } else { // linux (incl. WSL) and other POSIX: root + common mount points
      subdirsOf('/mnt');
      push('/media');
      let user;
      try { user = os.userInfo().username; } catch (_) {}
      if (user) subdirsOf(path.join('/media', user));
    }
  }
  const fp = items.map(i => i.path).join('\n');
  if (driveCache && driveCache.fp !== fp) realScopesCache = null; // mounts changed → redo realpath scopes
  driveCache = { t: now, list: items, fp };
  return items;
}

// ---------- path safety ----------
function norm(p) {
  // Windows only: case-insensitive compare, unified separators, no trailing sep.
  // (macOS default APFS is case-insensitive too, but kept case-sensitive on PURPOSE:
  //  a wrong-cased POSIX path then fails closed with 403 instead of reading the
  //  wrong file. POSIX strips only '/', since '\' is a legal filename char there.)
  let r = path.resolve(p).replace(IS_WIN ? /[/\\]+$/ : /\/+$/, '');
  if (!r) r = '/'; // POSIX root survives the trailing-sep strip
  return IS_WIN ? r.toLowerCase() : r;
}

function allowedScopes() {
  const scopes = new Set();
  if (!DEMO_DIR) for (const d of localDrives()) scopes.add(norm(d.path)); // demo: no real drives
  else scopes.add(norm(PUBLIC_DIR));   // the app's own assets are served through /raw/ too
  for (const r of config.roots) scopes.add(norm(r));
  for (const p of config.pinned) scopes.add(norm(p));
  return [...scopes];
}

// scopes additionally in realpath form so junctions/symlinks INSIDE an allowed
// tree that point OUTSIDE it cannot be used to escape (checked per request).
let realScopesCache = null;
function realNorm(p) {
  try { return norm(fs.realpathSync(p)); } catch (_) { return norm(p); }
}
function fixScopeForRealpath(s) {
  // Windows only: 磁碟根 norm 後是 'd:'，直接 realpath('d:') 會解成「該磁碟的目前目錄」
  // （伺服器在 D 槽跑時變成專案資料夾）→ 整個 D 槽被判出界。磁碟根要補回反斜線再 realpath。
  if (IS_WIN && /^[a-z]:$/i.test(s)) return s + path.sep;
  return s;
}
function realScopes() {
  if (!realScopesCache) realScopesCache = allowedScopes().map(s => realNorm(fixScopeForRealpath(s)));
  return realScopesCache;
}

function underAny(n, scopes) {
  return scopes.some(s =>
    (s === '/' && n.startsWith('/')) || n === s || n.startsWith(s + path.sep));
}

function isAllowed(absPath) {
  const n = norm(absPath);
  if (!underAny(n, allowedScopes())) return false;
  if (!underAny(realNorm(absPath), realScopes())) return false;
  return true;
}

function existingRoots() {
  const seen = new Set();
  const out = [];
  for (const r of [...config.roots, ...config.pinned]) {
    try {
      if (fs.statSync(r).isDirectory()) {
        const n = norm(r);
        if (!seen.has(n)) { seen.add(n); out.push(path.resolve(r)); }
      }
    } catch (_) {}
  }
  return out;
}

// ---------- directory listing (small mtime-keyed caches) ----------
const dirCache = new Map(); // normAbs -> { mtimeMs, entries: [{name, isDir, size, mtime}] }
function invalidateDir(absDir) { dirCache.delete(norm(absDir)); dirNamesCache.delete(norm(absDir)); }
// names+Booleans only — a 98k-file folder costs one readdir, NOT 98k statSync.
// Anything that merely COUNTS (subdir badges, totals, AI/dir detection) uses this.
const dirNamesCache = new Map(); // normAbs -> { mtimeMs, entries: [{name, isDir}] }
function readDirNames(abs) {
  let st;
  try { st = fs.statSync(abs); } catch (_) { return null; }
  if (!st.isDirectory()) return null;
  const key = norm(abs);
  const hit = dirNamesCache.get(key);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.entries;
  let raw;
  try { raw = fs.readdirSync(abs, { withFileTypes: true }); } catch (_) {
    dirNamesCache.set(key, { mtimeMs: st.mtimeMs, entries: [] });
    return [];
  }
  const entries = new Array(raw.length);
  for (let i = 0; i < raw.length; i++) entries[i] = { name: raw[i].name, isDir: raw[i].isDirectory(), _link: raw[i].isSymbolicLink() };
  if (dirNamesCache.size > 300) dirNamesCache.clear();
  dirNamesCache.set(key, { mtimeMs: st.mtimeMs, entries });
  return entries;
}
function readDirEntries(abs) {
  let st;
  try { st = fs.statSync(abs); } catch (_) { return null; }
  if (!st.isDirectory()) return null;
  const key = norm(abs);
  const hit = dirCache.get(key);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.entries;
  let raw;
  try { raw = fs.readdirSync(abs, { withFileTypes: true }); } catch (_) {
    dirCache.set(key, { mtimeMs: st.mtimeMs, entries: [] });
    return [];
  }
  const entries = [];
  for (const e of raw) {
    const full = path.join(abs, e.name);
    let size = 0, mtime = 0;
    try { const es = fs.statSync(full); size = es.size; mtime = es.mtimeMs; } catch (_) { continue; }
    entries.push({ name: e.name, isDir: e.isDirectory(), size, mtime });
  }
  if (dirCache.size > 300) dirCache.clear();
  dirCache.set(key, { mtimeMs: st.mtimeMs, entries });
  return entries;
}

// exts filter: 'all' → everything; 'readable' → all known kinds; else comma list
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

function extMatches(ext, filter) {
  if (filter.mode === 'all') return true;
  if (filter.mode === 'readable') return READABLE_EXTS.has(ext);
  return filter.set.has(ext);
}

function fileInfoOf(abs, name, size, mtime) {
  const ext = path.extname(name).toLowerCase();
  return { name, path: path.join(abs, name), size, mtime, ext, kind: KIND[ext] || null };
}

function countMatching(entries, filter) {
  let n = 0;
  for (const e of entries) {
    if (e.isDir) continue;
    if (extMatches(path.extname(e.name).toLowerCase(), filter)) n++;
  }
  return n;
}

function detectAI(abs, subEntries) {
  const markers = new Set(['claude.md', 'agents.md', 'gemini.md', '.claude']);
  let mdCount = 0;
  for (const e of subEntries) {
    const ln = e.name.toLowerCase();
    if (markers.has(ln)) return true;
    if (!e.isDir && (ln.endsWith('.md') || ln.endsWith('.markdown'))) mdCount++;
  }
  return mdCount >= 5;
}

// /api/list page size: folders with more DIRECT matching files are served from
// the index (300 newest/sorted per page + total), never stat-all'd.
const LIST_PAGE = 300;

// sortModes the API understands (must match public/stack.js setSort values)
const LIST_SORTS = new Set(['new', 'old', 'big', 'small', 'name']);

function listDir(dirPath, extsRaw, nofiles, off, sortMode) {
  const abs = path.resolve(dirPath);
  if (!isAllowed(abs)) {
    const e = new Error('path not under allowed scopes'); e.status = 403; throw e;
  }
  const names = readDirNames(abs);
  if (names === null) { const e = new Error('not found'); e.status = 404; throw e; }
  const filter = parseExts(extsRaw);
  const absNorm = norm(abs);

  const dirs = [];
  let total = 0;
  let hasMore = false;
  const pageFiles = [];

  // ---- subdirs: stat the dir ITSELF (mtime for sorting); counts prefer the
  // index rollup (O(#subdirs)) over per-subtree scans
  const subNames = names.filter(e => e.isDir);
  if (!off) {
    let directs = null;
    if (indexer && indexer.available && subNames.length) {
      try { directs = indexer.directCounts(absNorm, subNames.map(e => path.join(abs, e.name)), extsRaw); } catch (_) { directs = null; }
    }
    for (const e of subNames) {
      const full = path.join(abs, e.name);
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch (_) { continue; }
      const nw = norm(full);
      const sub = readDirNames(full); // needed for ai/hasSubdirs regardless of counts
      if (sub === null) continue;
      let fileCount = null;
      if (directs) fileCount = directs.get(nw) ?? null;
      if (fileCount == null) fileCount = countMatching(sub, filter);
      dirs.push({
        path: full, name: e.name, mtime,
        ai: detectAI(full, sub),
        pinned: config.pinned.some(p => norm(p) === nw),
        fileCount,
        hasSubdirs: sub.some(x => x.isDir)
      });
    }
  }
  dirs.sort((a, b) =>
    (b.pinned - a.pinned) || (b.ai - a.ai) || (b.mtime - a.mtime) || a.name.localeCompare(b.name));

  // ---- files: names are exact+cheap; stat only what goes over the wire
  if (!nofiles) {
    const matching = [];
    for (const e of names) {
      if (e.isDir) continue;
      if (extMatches(path.extname(e.name).toLowerCase(), filter)) matching.push(e.name);
    }
    total = matching.length;
    if (total <= LIST_PAGE && !off) {
      // small folder: exact stat of every entry (true mtime/size), as before
      for (const nm of matching) {
        let st;
        try { st = fs.statSync(path.join(abs, nm)); } catch (_) { continue; }
        if (!st.isFile()) continue;
        pageFiles.push(fileInfoOf(abs, nm, st.size, st.mtimeMs));
      }
      pageFiles.sort((a, b) => b.mtime - a.mtime);
      total = pageFiles.length;
    } else {
      // giant folder: serve the requested page from the index when possible
      let fromIndex = null;
      if (indexer && indexer.available) {
        try { fromIndex = indexer.listPage(absNorm, extsRaw, sortMode, off, LIST_PAGE); } catch (_) { fromIndex = null; }
      }
      if (fromIndex) {
        total = Math.max(total, fromIndex.total); // names are fresher; index may lag
        for (const r of fromIndex.rows) pageFiles.push(fileInfoOf(abs, r.name, r.size, r.mtime));
      } else {
        // no index yet: name-ordered page (approximate when sort != name) — stat
        // ONLY the page slice, so the first click on a 98k-file folder stays ms-fast
        matching.sort();
        for (const nm of matching.slice(off, off + LIST_PAGE)) {
          let st;
          try { st = fs.statSync(path.join(abs, nm)); } catch (_) { continue; }
          if (!st.isFile()) continue;
          pageFiles.push(fileInfoOf(abs, nm, st.size, st.mtimeMs));
        }
      }
      hasMore = off + pageFiles.length < total;
    }
  }
  return { path: abs, dirs, files: pageFiles, total, hasMore, off: off || 0 };
}

// ---------- full-text search ----------
// Recursive case-insensitive substring scan of text-like files' contents + names.
// Budgets are env-overridable (tests use a tiny FLODER_SEARCH_MAX_FILES).
const SEARCH_TIME_MS = Math.max(1, Number(envPick('RIFFLEDESK_SEARCH_TIME_MS', 'FLODER_SEARCH_TIME_MS')) || 8000);   // 大資料夾（整個 workspace）4 秒常掃不完；之後換成索引就不用等
const SEARCH_MAX_FILES = Math.max(1, Number(envPick('RIFFLEDESK_SEARCH_MAX_FILES', 'FLODER_SEARCH_MAX_FILES')) || 20000);
const SEARCH_MAX_FILE_BYTES = 5 * 1024 * 1024;
const SEARCH_MAX_DEPTH = 8;
// 大量非文件的目錄直接跳過（套件、虛擬環境、編譯輸出）：不跳的話 4 秒預算都耗在這裡
const SKIP_DIR_NAMES = new Set(['node_modules', '__pycache__', 'site-packages', 'venv', 'target', 'bower_components']);

function countOccurrences(hay, needle) {
  let n = 0, i = 0;
  for (;;) {
    i = hay.indexOf(needle, i);
    if (i === -1) return n;
    n++; i += needle.length;
  }
}

function makeSnippet(content, idx, qlen) {
  // ~120 chars around the first content match, single line, original casing
  const start = Math.max(0, idx - 40);
  let snip = content.slice(start, Math.min(content.length, idx + qlen + 80))
    .replace(/\s+/g, ' ').trim();
  if (snip.length > 120) snip = snip.slice(0, 117) + '…';
  return snip;
}

async function searchTree(rootAbs, q, extsRaw) {
  const t0 = Date.now();
  const qLow = q.toLowerCase();
  const filter = parseExts(extsRaw);
  const files = [];
  let scanned = 0, truncated = false, ops = 0;
  const deadline = t0 + SEARCH_TIME_MS;
  const stack = [{ dir: rootAbs, depth: 0 }];
  const seenDirs = new Set([realNorm(rootAbs)]); // junction/symlink cycle guard
  const tick = async () => { if (++ops % 32 === 0) await new Promise(r => setImmediate(r)); };

  while (stack.length) {
    if (Date.now() > deadline) { truncated = true; break; }
    const { dir, depth } = stack.pop();
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      if (scanned >= SEARCH_MAX_FILES) { truncated = true; break; }
      await tick(); // keep the event loop breathing; thumbnails stay responsive
      const full = path.join(dir, e.name);
      let target = full, st;
      if (e.isSymbolicLink()) {
        // only follow links that stay inside an allowed scope (realpath check)
        try { target = await fs.promises.realpath(full); } catch (_) { continue; }
        if (!isAllowed(target)) continue;
        try { st = await fs.promises.stat(target); } catch (_) { continue; }
      } else if (e.isFile()) {
        // 一般檔案：先用副檔名篩，符合的才 stat（大目錄裡每個檔都 stat 太慢）
        const ext0 = path.extname(e.name).toLowerCase(), k0 = KIND[ext0];
        if (!k0 || !TEXTLIKE.has(k0) || !extMatches(ext0, filter)) continue;
        try { st = await fs.promises.stat(full); } catch (_) { continue; }
      } else if (e.isDirectory()) {
        st = { isDirectory: () => true, isFile: () => false };
      } else continue;
      if (st.isDirectory()) {
        if (e.name.startsWith('.') || SKIP_DIR_NAMES.has(e.name)) continue;
        if (depth >= SEARCH_MAX_DEPTH) continue;
        const key = realNorm(target);
        if (seenDirs.has(key)) continue;
        seenDirs.add(key);
        stack.push({ dir: target, depth: depth + 1 });
        continue;
      }
      if (!st.isFile()) continue;
      scanned++;
      const ext = path.extname(e.name).toLowerCase();
      const kind = KIND[ext];
      if (!kind || !TEXTLIKE.has(kind)) continue;               // skip images/pdf/xlsx/binaries
      if (!extMatches(ext, filter)) continue;                   // same exts rule as /api/list
      if (st.size > SEARCH_MAX_FILE_BYTES) continue;
      const nameHit = e.name.toLowerCase().includes(qLow) ? 1 : 0;
      let occ = 0, snippet = '';
      try {
        const content = await fs.promises.readFile(target, 'utf8');
        const low = content.toLowerCase();
        occ = countOccurrences(low, qLow);
        if (occ > 0) snippet = makeSnippet(content, low.indexOf(qLow), q.length);
      } catch (_) {}
      const hits = occ + nameHit;
      if (hits === 0) continue;
      files.push({
        ...fileInfoOf(path.dirname(full), e.name, st.size, st.mtimeMs),
        hits, snippet, rel: path.relative(rootAbs, full)
      });
    }
    if (truncated) break;
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return { files, scanned, truncated, ms: Date.now() - t0 };
}

// ---------- persistent index + file operations (instances created in start()) ----------
let indexer = null; // createIndexer(...) or null when unavailable/disabled
let fileOps = null; // createFileOps(...)

// stricter than originAllowed: the write endpoints REQUIRE an Origin header,
// and it must be this server's own origin (no-Origin curl-style callers are refused
// here — they may still use the read APIs).
function writeOriginOk(req) {
  if (!req.headers.origin) return false;
  return originAllowed(req);
}

// shared guard for the write endpoints; returns the parsed payload or null after
// sending an error response. `cap` raises the body limit for routes like /api/save.
async function readWritePayload(req, res, cap) {
  if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST only' }); return null; }
  const ctype = String(req.headers['content-type'] || '').toLowerCase();
  if (!ctype.startsWith('application/json')) { sendJson(res, 415, { ok: false, error: 'json only' }); return null; }
  if (!writeOriginOk(req)) { sendJson(res, 403, { ok: false, error: 'write endpoints require a same-origin Origin header' }); return null; }
  let body;
  try { body = await readBody(req, cap); }
  catch (_) { sendJson(res, 413, { ok: false, error: 'body too large' }); return null; }
  try { return JSON.parse(body.toString('utf8')); } catch (_) {
    sendJson(res, 400, { ok: false, error: 'bad json' });
    return null;
  }
}
// demo mode: a write payload carries a fake path too — swap it for the real one
function demoTarget(payload) {
  if (!DEMO_DIR || !payload || typeof payload.path !== 'string') return;
  payload.path = demoReal(payload.path);
}

// ---------- revise save (POST /api/revise/save) ----------
// Body: { path, changes:[…], png?: data-url|<base64> }. Writes "<name>.changes.json"
// and optionally "<name>.changes.png" next to the HTML file. The item contract is
// fixed downstream (an AI reads it), so fields are normalised, not renamed.
const REVISE_OPS = new Set(['edit-text', 'move', 'resize', 'delete', 'note', 'region-note']);
const REVISE_MAX_ITEMS = 500;
const REVISE_TEXT_MAX = 4000;
const REVISE_PNG_MAX = 8 * 1024 * 1024;

function reviseNum(v) { return Number.isFinite(v) ? Math.round(v * 100) / 100 : null; }function reviseStr(v, cap = REVISE_TEXT_MAX) {
  if (typeof v !== 'string') return null;
  return v.length > cap ? v.slice(0, cap) : v;
}
function reviseRect(r) {
  if (!r || typeof r !== 'object') return { x: 0, y: 0, w: 0, h: 0 };
  return { x: reviseNum(r.x) ?? 0, y: reviseNum(r.y) ?? 0, w: reviseNum(r.w) ?? 0, h: reviseNum(r.h) ?? 0 };
}

function writeReviseSave(payload) {
  const target = payload && payload.path;
  if (!target || typeof target !== 'string' || target.includes('\0')) {
    return { status: 400, body: { ok: false, error: 'missing or bad path' } };
  }
  const abs = path.resolve(target);
  const ext = path.extname(abs).toLowerCase();
  if (ext !== '.html' && ext !== '.htm') return { status: 415, body: { ok: false, error: 'target must be an .html/.htm file' } };
  if (!isAllowed(abs)) return { status: 403, body: { ok: false, error: 'path not under allowed scopes' } };
  let st;
  try { st = fs.statSync(abs); } catch (_) { return { status: 404, body: { ok: false, error: 'not found' } }; }
  if (!st.isFile()) return { status: 400, body: { ok: false, error: 'not a file' } };

  const raw = Array.isArray(payload.changes) ? payload.changes : [];
  if (raw.length > REVISE_MAX_ITEMS) return { status: 413, body: { ok: false, error: 'too many changes' } };
  const items = [];
  let skipped = 0;
  for (const c of raw) {
    if (!c || typeof c !== 'object' || !REVISE_OPS.has(c.op)) { skipped++; continue; }
    items.push({
      n: items.length + 1,
      op: c.op,
      rdId: reviseStr(c.rdId, 200),
      selector: reviseStr(c.selector, 2000) || '',
      textHint: reviseStr(c.textHint, 200),
      before: reviseStr(c.before),
      after: reviseStr(c.after),
      note: reviseStr(c.note),
      rect: reviseRect(c.rect),
      dx: reviseNum(c.dx),
      dy: reviseNum(c.dy),
      w: reviseNum(c.w),
      h: reviseNum(c.h)
    });
  }
  if (!items.length) return { status: 400, body: { ok: false, error: 'no valid changes' } };

  // screenshot: accept a data: URL or bare base64; anything undecodable → null
  let pngBuf = null;
  if (typeof payload.png === 'string' && payload.png) {
    const b64 = payload.png.replace(/^data:image\/png;base64,/i, '');
    try { pngBuf = Buffer.from(b64, 'base64'); } catch (_) { pngBuf = null; }
    if (pngBuf && (!pngBuf.length || pngBuf.length > REVISE_PNG_MAX)) pngBuf = null;
  }

  const jsonPath = abs + '.changes.json';
  const prevPath = abs + '.changes.prev.json';
  const pngPath = pngBuf ? abs + '.changes.png' : null;
  const doc = {
    version: 1,
    file: abs,
    createdAt: new Date().toISOString(),
    status: 'pending',
    screenshot: pngPath ? path.basename(pngPath) : null,
    summary: reviseStr(payload.summary, 20000) || items.map(it =>
      `${it.n}. ${it.op}${it.selector ? ' ' + it.selector : ''}${it.note ? ': ' + it.note : ''}`).join('\n'),
    items
  };
  try {
    // keep the previous list as ONE generation before overwriting it
    if (fs.existsSync(jsonPath)) {
      try { fs.renameSync(jsonPath, prevPath); } catch (_) {}
    }
    writeAtomic(jsonPath, Buffer.from(JSON.stringify(doc, null, 2) + '\n', 'utf8'));
    if (pngPath) writeAtomic(pngPath, pngBuf);
  } catch (err) {
    return { status: 500, body: { ok: false, error: 'write failed: ' + err.message } };
  }
  invalidateDir(path.dirname(abs));
  return { status: 200, body: { ok: true, json: jsonPath, png: pngPath } };
}

// ---------- http helpers ----------
function sendJson(res, code, obj) {
  const body = JSON.stringify(DEMO_DIR ? demoFakeDeep(obj) : obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req, cap = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let over = false;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > cap) {
        if (!over) { over = true; reject(new Error('body too large')); }
        chunks.length = 0;              // stop growing; keep draining so the
        req.resume();                    // 413 can still reach the client
        return;
      }
      if (!over) chunks.push(c);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks)); });
    req.on('error', () => { if (!over) reject(new Error('body error')); });
  });
}

// DNS-rebinding / drive-by defence: accept requests addressed to loopback only.
// Port-resolved per request so a bin-launched server can run on any port.
function hostAllowed(req) {
  const port = req.socket.localPort;
  const h = (req.headers.host || '').toLowerCase();
  return h === '127.0.0.1:' + port || h === 'localhost:' + port || h === '[::1]:' + port;
}
const originReCache = new Map();
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const port = req.socket.localPort;
  let re = originReCache.get(port);
  if (!re) {
    re = new RegExp('^https?://(127\\.0\\.0\\.1|localhost|\\[::1\\]):' + port + '$');
    originReCache.set(port, re);
  }
  return re.test(origin);
}

function serveFile(req, res, absPath, u) {
  if (!isAllowed(absPath)) return sendJson(res, 403, { ok: false, error: 'path not under allowed scopes' });
  const ext = path.extname(absPath).toLowerCase();
  const kind = KIND[ext];
  if (!kind) return sendJson(res, 415, { ok: false, error: 'file type not supported' });
  let st;
  try { st = fs.statSync(absPath); } catch (_) { return sendJson(res, 404, { ok: false, error: 'not found' }); }
  if (!st.isFile()) return sendJson(res, 400, { ok: false, error: 'not a file' });

  // partial preview: first N bytes (thumbnail rendering only), text-ish kinds
  let head = Math.min(Number(u.searchParams.get('head')) || 0, MAX_HEAD_BYTES);
  if (head > 0 && !TEXTLIKE.has(kind)) head = 0;

  const streaming = (kind === 'image' || kind === 'pdf');
  const cap = kind === 'sheet' ? MAX_SHEET_BYTES : MAX_TEXT_BYTES;
  if (!streaming) {
    const want = head > 0 ? Math.min(head, st.size) : Math.min(cap, st.size);
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': want,
      'x-file-kind': kind,
      'x-truncated': st.size > want ? '1' : '0'
    });
    // 一律只讀到 stat 當下的長度：AI 正在寫的檔（log、對話紀錄）讀的途中會變長，
    // 多送的位元組會讓瀏覽器報 content-length 不符、整份載入失敗
    if (want <= 0) { res.end(); return; }
    const s = fs.createReadStream(absPath, { start: 0, end: want - 1 });
    s.pipe(res);
    s.on('error', () => res.end());
    return;
  }
  const type = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'x-file-kind': kind });
  if (st.size <= 0) { res.end(); return; }
  const s = fs.createReadStream(absPath, { start: 0, end: st.size - 1 });
  s.pipe(res);
  s.on('error', () => res.end());
}

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = path.join(PUBLIC_DIR, rel.replace(/^\/+/, ''));
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  let st;
  try { st = fs.statSync(full); } catch (_) { res.writeHead(404); return res.end('not found'); }
  if (!st.isFile()) { res.writeHead(404); return res.end('not found'); }
  const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'cache-control': 'no-cache' });
  fs.createReadStream(full).pipe(res);
}

// ==================== suspected-secret scan (secrets.js) ====================
// Flags files whose text head looks like it holds an API key / password, so the
// UI can warn before anyone shares a folder full of AI-written notes. Detection
// details in README ("Secret scan"). Matched VALUES never leave the process:
// /api/list carries only `secret: true`; /api/secretscan returns line numbers
// with each value masked to at most 4 leading characters.

const SECRET_SCAN_BYTES = 64 * 1024;   // only the first 64 KB is ever scanned
const SECRET_DEMAND_MAX = 64 * 1024;   // on-demand list scan: text files ≤ 64 KB only

function secretSkipNames() {
  return Array.isArray(config.secretScanSkipDirs) ? config.secretScanSkipDirs : [];
}

// scan one text file's head on demand (returns bool). Cached by path + size +
// mtime so a folder listing re-uses results until the file actually changes.
const secretDemandCache = new Map(); // norm(path) -> { size, mtime, secret }
function demandSecretFlag(f) {
  const n = norm(f.path);
  const hit = secretDemandCache.get(n);
  if (hit && hit.size === f.size && hit.mtime === f.mtime) return hit.secret;
  let secret = false;
  try {
    const fd = fs.openSync(f.path, 'r');
    try {
      const buf = Buffer.alloc(Math.min(SECRET_SCAN_BYTES, Math.max(0, f.size)));
      const bytes = f.size === 0 ? 0 : fs.readSync(fd, buf, 0, buf.length, 0);
      if (!looksSecretBinary(buf.subarray(0, bytes))) {
        secret = scanText(buf.subarray(0, bytes).toString('utf8')).length > 0;
      }
    } finally { fs.closeSync(fd); }
  } catch (_) { /* unreadable here = treat as clean; the reader reports read errors */ }
  if (secretDemandCache.size > 5000) secretDemandCache.clear();
  secretDemandCache.set(n, { size: f.size, mtime: f.mtime, secret });
  return secret;
}

// attach `secret: true` to /api/list file entries (key not emitted when false).
// Preference order: the persistent index (files.secret: 1/0/NULL) — NULL and an
// unavailable index both fall through to the cheap on-demand scan.
function markSecretFlags(abs, files) {
  if (!files.length) return;
  const skip = secretSkipNames();
  if (skip.length && anySegmentSkipped(abs, skip)) return;
  let idxFlags = null;
  if (indexer && indexer.available) {
    try { idxFlags = indexer.secretFlags(norm(abs)); } catch (_) { idxFlags = null; }
  }
  const fold = IS_WIN ? s => s.toLowerCase() : s => s;
  for (const f of files) {
    if (!f.kind || !TEXTLIKE.has(f.kind) || f.size > SECRET_DEMAND_MAX) continue;
    const fromIndex = idxFlags ? idxFlags.get(fold(f.name)) : undefined;
    if (fromIndex === true) { f.secret = true; continue; }
    if (fromIndex === false) continue;
    if (demandSecretFlag(f)) f.secret = true;
  }
}

// GET /api/secretscan?path=… → { secret, matches: [{ line, kind, masked }] }
function apiSecretScan(res, u) {
  const q = u.searchParams.get('path');
  if (!q || q.includes('\0')) return sendJson(res, 400, { ok: false, error: 'missing or bad path' });
  const abs = path.resolve(q);
  if (!isAllowed(abs)) return sendJson(res, 403, { ok: false, error: 'path not under allowed scopes' });
  if (config.secretScan === false) return sendJson(res, 200, { ok: true, secret: false, matches: [] });
  const skip = secretSkipNames();
  if (skip.length && anySegmentSkipped(abs, skip)) return sendJson(res, 200, { ok: true, secret: false, matches: [] });
  let st;
  try { st = fs.statSync(abs); } catch (_) { return sendJson(res, 404, { ok: false, error: 'not found' }); }
  if (!st.isFile()) return sendJson(res, 400, { ok: false, error: 'not a file' });
  const ext = path.extname(abs).toLowerCase();
  const kind = KIND[ext] || null;
  if (!kind || !TEXTLIKE.has(kind)) return sendJson(res, 200, { ok: true, secret: false, matches: [] });
  let buf;
  try {
    const fd = fs.openSync(abs, 'r');
    try {
      buf = Buffer.alloc(Math.min(SECRET_SCAN_BYTES, st.size || SECRET_SCAN_BYTES));
      const bytes = st.size === 0 ? 0 : fs.readSync(fd, buf, 0, buf.length, 0);
      buf = buf.subarray(0, bytes);
    } finally { fs.closeSync(fd); }
  } catch (_) { return sendJson(res, 200, { ok: true, secret: false, matches: [] }); }
  const matches = looksSecretBinary(buf) ? [] : scanText(buf.toString('utf8'));
  // one entry per line (the mask shows at most 4 leading chars — never the value)
  const byLine = new Map();
  for (const m of matches) if (!byLine.has(m.line)) byLine.set(m.line, m);
  const out = [...byLine.values()].slice(0, 50)
    .map(m => ({ line: m.line, kind: m.kind, masked: maskValue(m.value) }));
  return sendJson(res, 200, { ok: true, secret: out.length > 0, matches: out });
}

// ==================== AI conversation endpoints (transcripts; convos.js) ====================
// Read-only views over Claude Code / Codex session logs: which files an AI wrote, when.
// convoRoots configurable via config.json ("convoRoots": ["~/.claude/projects", {kind,dir}, …]);
// default = ~/.claude/projects + every ~/.codex*/sessions that exists.
function convoRootsNow() {
  return convos.normalizeRoots(config.convoRoots ? config.convoRoots.map(r =>
    typeof r === 'string' ? expandHome(r) : { kind: r.kind, dir: expandHome(r.dir) }) : null);
}
// transient-scan memo: endpoints answering bursts (boot loads several) share one scan result
let convoScanCache = null; // { t, cutoff, rootsKey, result }
async function convoScan(cutoffMs) {
  const roots = convoRootsNow();
  const rootsKey = roots.map(r => r.kind + ':' + r.dir).join('|');
  const hit = convoScanCache;
  if (hit && hit.rootsKey === rootsKey && hit.cutoff <= cutoffMs && Date.now() - hit.t < 5000) return hit.result;
  const result = await convos.scan({ roots, minUpdatedMs: cutoffMs });
  convoScanCache = { t: Date.now(), cutoff: cutoffMs, rootsKey, result };
  return result;
}
function convoFileInfo(absPath) { // same file-object shape as /api/list files (fileInfoOf)
  let st;
  try { st = fs.statSync(absPath); } catch (_) { return null; }
  if (!st.isFile()) return null;
  return fileInfoOf(path.dirname(absPath), path.basename(absPath), st.size, st.mtimeMs);
}
async function apiConvos(res, u) {
  const days = Math.min(3650, Math.max(1, Number(u.searchParams.get('days')) || 30));
  const t0 = Date.now();
  const data = await convoScan(t0 - days * 86400000);
  const list = data.convos
    .filter(c => c.fileCount > 0)
    .sort((a, b) => b.updated - a.updated)
    .map(c => ({ id: convos.mergeId(c), agent: c.agent, title: c.title, project: c.project, auto: !!c.auto,
      started: c.started, updated: c.updated, fileCount: c.fileCount }));
  return sendJson(res, 200, { ok: true, days, convos: list, scanned: data.transcripts, ms: Date.now() - t0 });
}
async function apiConvo(res, u) {
  const id = u.searchParams.get('id');
  if (!id) return sendJson(res, 400, { ok: false, error: 'missing id' });
  const data = await convoScan(0);
  const c = data.convos.find(x => convos.mergeId(x) === id);
  if (!c) return sendJson(res, 404, { ok: false, error: 'not found' });
  const files = c.files.filter(f => f.exists).map(f => convoFileInfo(f.path)).filter(Boolean);
  return sendJson(res, 200, { ok: true, id, agent: c.agent, title: c.title, project: c.project,
    started: c.started, updated: c.updated, files });
}
async function apiRecent(res, u) {
  const hours = Math.min(24 * 365, Math.max(1, Number(u.searchParams.get('hours')) || 24));
  const t0 = Date.now();
  const cutoff = t0 - hours * 3600000;
  const data = await convoScan(cutoff);
  const filter = parseExts(u.searchParams.get('exts'));
  const best = new Map(); // normKey -> { f, c, lastAt }
  for (const c of data.convos) {
    for (const f of c.files) {
      if (!f.exists || (f.lastAt || 0) < cutoff) continue;
      const k = convos.normKey(f.path);
      const cur = best.get(k);
      if (!cur || f.lastAt > cur.lastAt) best.set(k, { f, c, lastAt: f.lastAt });
    }
  }
  const files = [];
  for (const { f, c, lastAt } of best.values()) {
    const info = convoFileInfo(f.path);
    if (!info || !extMatches(info.ext, filter)) continue;
    files.push({ ...info, firstAt: f.firstAt, lastAt, convoId: convos.mergeId(c), convoTitle: c.title });
  }
  files.sort((a, b) => b.lastAt - a.lastAt);
  return sendJson(res, 200, { ok: true, hours, files, ms: Date.now() - t0 });
}
// 「最近改動（不確定是誰改的）」：marker-project folders (AGENTS.md/CLAUDE.md/GEMINI.md,
// .claude/.cursor/.git, or >=5 markdown in one dir — same idea as detectAI) whose files
// were modified within `hours`, MINUS everything an AI conversation provably wrote.
// Indexer-only (no full-disk scan); degraded response when the index is unavailable.
let recentModCache = null; // { t, hours, exts, files }
async function apiRecentMod(res, u) {
  const hours = Math.min(24 * 365, Math.max(1, Number(u.searchParams.get('hours')) || 24 * 7));
  const extsRaw = u.searchParams.get('exts') || '';
  const t0 = Date.now();
  if (recentModCache && recentModCache.hours === hours && recentModCache.exts === extsRaw && Date.now() - recentModCache.t < 10000) {
    return sendJson(res, 200, recentModCache.body);
  }
  const cutoff = t0 - hours * 3600000;
  if (!indexer || !indexer.available || !indexer.recentModified) {
    return sendJson(res, 200, { ok: true, hours, indexed: false, files: [], ms: Date.now() - t0 });
  }
  const aiPaths = new Set();
  try {
    const data = await convoScan(cutoff);
    for (const c of data.convos) {
      for (const f of c.files) if ((f.lastAt || f.firstAt || 0) >= cutoff) aiPaths.add(convos.normKey(f.path));
    }
  } catch (_) { /* scan failure must not blank the whole endpoint */ }
  let rows;
  try { rows = indexer.recentModified(cutoff, aiPaths); } catch (_) { rows = null; }
  if (!rows) return sendJson(res, 200, { ok: true, hours, indexed: true, files: [], ms: Date.now() - t0 });
  const filter = parseExts(extsRaw);
  const files = rows.filter(r => extMatches(r.ext, filter));
  const body = { ok: true, hours, indexed: true, files, ms: Date.now() - t0 };
  recentModCache = { t: Date.now(), hours, exts: extsRaw, body };
  return sendJson(res, 200, body);
}
async function apiWhichConvo(res, u) {
  const q = u.searchParams.get('path');
  if (!q) return sendJson(res, 400, { ok: false, error: 'missing path' });
  const data = await convoScan(0);
  const hits = data.convos
    .filter(c => convos.wroteFile(c, q))
    .sort((a, b) => b.updated - a.updated)
    .map(c => ({ id: convos.mergeId(c), agent: c.agent, title: c.title, project: c.project, auto: !!c.auto,
      started: c.started, updated: c.updated, fileCount: c.fileCount }));
  return sendJson(res, 200, { ok: true, path: q, convos: hits });
}
// ================== end AI conversation endpoints ==================

// ==================== live events (Server-Sent Events hub) ====================
// GET /api/events[?path=<open folder>] — one stream per tab. The client re-opens
// the stream when it switches folders. Per folder ONE shared fs.watch feeds every
// subscribed client (a handful of watchers total, not per client); transcript
// changes are polled once every CONVO_POLL_MS and broadcast to all clients.
const EVENT_MAX_CLIENTS = 8;
const CONVO_POLL_MS = Math.max(200, Number(process.env.RIFFLEDESK_CONVO_POLL_MS) || 10000);
const eventClients = new Set();              // live SSE responses
const panelSse = new Set();                  // subset of eventClients opened with ?panel=1（側邊欄精簡模式）
const dirWatchers = new Map();               // normKey -> { key, path, watcher, timer, snap:Set, subs:Set }
const convoHub = { subs: new Set(), timer: null, sig: null };

function sendSse(res, event, data) {
  try { res.write('event: ' + event + '\ndata: ' + JSON.stringify(DEMO_DIR ? demoFakeDeep(data) : data) + '\n\n'); } catch (_) {}
}

function snapshotNames(abs) {
  const s = new Set();
  try {
    for (const n of fs.readdirSync(abs)) {
      if (n.startsWith('.rdtmp-')) continue; // atomic-save temp files are never news
      s.add(n);
    }
  } catch (_) {}
  return s;
}

function dirArm(w) { // (re)attach fs.watch; may fail while the dir is gone — retried on keep-alive ticks
  if (w.watcher) return;
  try {
    w.watcher = fs.watch(w.path, { persistent: false }, () => dirPoke(w));
    w.watcher.on('error', () => dirDisarm(w));
  } catch (_) { w.watcher = null; }
}
function dirDisarm(w) {
  try { w.watcher && w.watcher.close(); } catch (_) {}
  w.watcher = null;
}
function dirWatchGet(abs) {
  const key = norm(abs);
  let w = dirWatchers.get(key);
  if (w) return w;
  w = { key, path: abs, watcher: null, timer: null, snap: snapshotNames(abs), subs: new Set() };
  dirWatchers.set(key, w);
  dirArm(w);
  return w;
}
function dirPoke(w) { // debounce 500 ms, then diff names → added/removed
  if (w.timer) return;
  w.timer = setTimeout(() => {
    w.timer = null;
    const now = snapshotNames(w.path);
    const added = [], removed = [];
    for (const n of now) if (!w.snap.has(n)) added.push(n);
    for (const n of w.snap) if (!now.has(n)) removed.push(n);
    w.snap = now;
    if (!added.length && !removed.length) return;
    invalidateDir(w.path);
    for (const res of w.subs) sendSse(res, 'dir', { path: w.path, added, removed });
  }, 500);
  w.timer.unref();
}
function dirWatchRelease(w, res) {
  if (!w.subs.delete(res)) return;
  if (w.subs.size) return;
  if (w.timer) clearTimeout(w.timer);
  dirDisarm(w);
  dirWatchers.delete(w.key);
}

// cheap change signal for the AI transcript roots: file count + total bytes +
// newest mtime over exactly the files convos.scan() would parse (convos.discoverFiles
// knows each kind's on-disk layout), so a transcript write flips the signature.
function convoTranscriptSig() {
  let files = 0, bytes = 0, newest = 0;
  for (const r of convoRootsNow()) {
    let found;
    try { found = convos.discoverFiles(r, 0); } catch (_) { continue; }
    for (const f of found) {
      files++; bytes += f.size;
      if (f.mtimeMs > newest) newest = f.mtimeMs;
    }
  }
  return files + ':' + bytes + ':' + Math.round(newest);
}
function convoHubStart() {
  if (convoHub.timer) return;
  convoHub.sig = convoTranscriptSig();
  convoHub.timer = setInterval(() => {
    let sig;
    try { sig = convoTranscriptSig(); } catch (_) { return; }
    if (sig === convoHub.sig) return;
    convoHub.sig = sig;
    for (const res of convoHub.subs) sendSse(res, 'convos', { at: Date.now() });
  }, CONVO_POLL_MS);
  convoHub.timer.unref();
}
function convoHubStop() {
  if (convoHub.timer) clearInterval(convoHub.timer);
  convoHub.timer = null;
}

function apiEvents(req, res, u) {
  if (eventClients.size >= EVENT_MAX_CLIENTS) {
    return sendJson(res, 429, { ok: false, error: 'too many event clients (max ' + EVENT_MAX_CLIENTS + ')' });
  }
  // path param: the folder the client is looking at. Unknown/forbidden paths are
  // tolerated (stream still serves convos events) instead of erroring out — an
  // EventSource retries HTTP errors forever and would just log-spam.
  let watchPath = null;
  const qp = u.searchParams.get('path');
  if (qp) {
    const abs = path.resolve(qp);
    try {
      const st = fs.statSync(abs);
      if (st.isDirectory() && isAllowed(abs)) watchPath = abs;
    } catch (_) {}
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no'
  });
  res.write(': open\n\n');
  eventClients.add(res);
  // ?panel=1＝側邊欄精簡模式：它自己不能打開檔案（沒有閱讀欄），所以投影／丟疊
  // 的廣播跳過它，「delivered」只數完整視窗——側邊欄靠這個決定要不要改開新分頁。
  const isPanel = u.searchParams.get('panel') === '1';
  if (isPanel) panelSse.add(res);
  const w = watchPath ? dirWatchGet(watchPath) : null;
  if (w) w.subs.add(res);
  convoHub.subs.add(res);
  convoHubStart();
  // keep-alive comment every 25 s; doubles as the fallback poll when fs.watch
  // could not be established (dir missing / platform limit)
  const ka = setInterval(() => {
    try { res.write(': ka ' + Date.now() + '\n\n'); } catch (_) {}
    if (w && !w.watcher) { dirArm(w); if (!w.watcher) dirPoke(w); }
  }, 25000);
  ka.unref();
  let closed = false;
  const onClose = () => {
    if (closed) return;
    closed = true;
    clearInterval(ka);
    eventClients.delete(res);
    panelSse.delete(res);
    if (w) dirWatchRelease(w, res);
    convoHub.subs.delete(res);
    if (!convoHub.subs.size) convoHubStop();
  };
  req.on('close', onClose);
  res.on('close', onClose);
}
// ================== end live events ==================

// ==================== projection: an AI CLI pushes a file to open tabs ====================
// POST /api/project {path, line?, source?} — see apiProject below.
//
// Guards, and why they still hold without a browser Origin:
//  - Host header check (hostAllowed) runs for every request: DNS rebinding is out.
//  - The /api/ Sec-Fetch-Site guard also runs for every request: a *browser* page on
//    another site that fetches this endpoint cross-site is refused (it always sends
//    Sec-Fetch-Site: cross-site), so adding a CLI path cannot open the endpoint to
//    web pages. The CLI is not a browser and sends no Origin / Sec-Fetch-Site at all.
//  - The endpoint is therefore accepted when EITHER the normal same-origin Origin rule
//    holds (a tab using fetch) OR the caller proves it is the CLI with the explicit
//    header `X-RiffleDesk-CLI: 1` and sends no Origin (so a browser's cross-site POST,
//    which always carries Origin, cannot masquerade as the CLI by omitting the header
//    — it can only fake the extra header too, which would then need a CORS preflight
//    it cannot pass and only ever leaks "did a projected path exist").
//  - It only reads the file system (stat + SSE broadcast): no writes, no opening of
//    executables, so the blast radius of a spoofed call is "a card opens".
function apiProject(req, res) {
  return (async () => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
    const ctype = String(req.headers['content-type'] || '').toLowerCase();
    if (!ctype.startsWith('application/json')) return sendJson(res, 415, { ok: false, error: 'json only' });
    const cli = req.headers['x-riffledesk-cli'];
    const isCli = cli === '1' && !req.headers.origin;
    if (!isCli && !writeOriginOk(req)) {
      return sendJson(res, 403, {
        ok: false,
        error: 'same-origin Origin, or X-RiffleDesk-CLI: 1 without Origin, required'
      });
    }
    let body;
    try { body = await readBody(req, 16 * 1024); } catch (_) {
      return sendJson(res, 413, { ok: false, error: 'body too large' });
    }
    let payload;
    try { payload = JSON.parse(body.toString('utf8')); } catch (_) {
      return sendJson(res, 400, { ok: false, error: 'bad json' });
    }
    const target = payload && payload.path;
    if (!target || typeof target !== 'string') return sendJson(res, 400, { ok: false, error: 'missing path' });
    if (target.includes('\0')) return sendJson(res, 400, { ok: false, error: 'bad path' });
    const abs = path.resolve(demoReal(target));
    let st;
    try { st = fs.statSync(abs); } catch (_) { return sendJson(res, 404, { ok: false, error: 'not found' }); }
    if (!st.isFile()) return sendJson(res, 400, { ok: false, error: 'not a file' });
    if (!isAllowed(abs)) return sendJson(res, 403, { ok: false, error: 'path not under allowed scopes' });
    const rawLine = Number(payload.line);
    const line = Number.isFinite(rawLine) && rawLine > 0 ? Math.floor(rawLine) : null;
    const source = typeof payload.source === 'string' ? payload.source.slice(0, 40) : null;
    const data = { path: abs, line, source, at: Date.now() };
    let delivered = 0;
    // 側邊欄（?panel=1 的 SSE 客戶）收不到投影：它沒有閱讀欄，檔案投影要投到完整視窗。
    for (const r of eventClients) { if (panelSse.has(r)) continue; sendSse(r, 'project', data); delivered++; }
    return sendJson(res, 200, { ok: true, delivered });
  })();
}
// ================== end projection ==================

// ==================== piles: an AI hands the user a shortlist to look at ====================
// POST /api/pile {title?, paths[], source?} → a pile {id, title, paths, source, createdAt}
// that the front end shows as its own card stack. Same guards as /api/project, plus a
// size cap. The pile list lives in memory and in a small JSON file beside config.json
// (the last PILE_KEEP are kept), never in the index or config itself.
const PILE_MAX = 500;
const PILE_KEEP = 20;
const PILE_PATH = path.join(path.dirname(CONFIG_PATH), 'piles.json');
let piles = [];   // newest last

function loadPiles() {
  try {
    const raw = JSON.parse(fs.readFileSync(PILE_PATH, 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw.filter(p => p && typeof p.id === 'string' && Array.isArray(p.paths))
      .map(p => ({
        id: p.id, title: String(p.title || ''), paths: p.paths.map(String),
        source: p.source ? String(p.source) : null,
        createdAt: Number(p.createdAt) || 0
      })).slice(-PILE_KEEP);
  } catch (_) { return []; }
}
function savePiles() {
  try {
    const tmp = PILE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(piles, null, 2));
    fs.renameSync(tmp, PILE_PATH);
  } catch (_) {}
}
piles = loadPiles();

function newPileId() {
  for (;;) {
    const id = crypto.randomBytes(9).toString('hex');
    if (!piles.some(p => p.id === id)) return id;
  }
}

// One card per existing, allowed file; duplicates collapse on the normalised path.
function pileFiles(paths) {
  const seen = new Set();
  const files = [];
  const dropped = [];
  for (const raw of paths) {
    if (typeof raw !== 'string' || !raw || raw.includes('\0')) { dropped.push(String(raw)); continue; }
    const abs = path.resolve(demoReal(raw));
    if (seen.has(norm(abs))) continue;
    seen.add(norm(abs));
    let st;
    try { st = fs.statSync(abs); } catch (_) { dropped.push(raw); continue; }
    if (!st.isFile() || !isAllowed(abs)) { dropped.push(raw); continue; }
    files.push(fileInfoOf(path.dirname(abs), path.basename(abs), st.size, st.mtimeMs));
  }
  return { files, dropped };
}

function apiPile(req, res) {
  return (async () => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
    const ctype = String(req.headers['content-type'] || '').toLowerCase();
    if (!ctype.startsWith('application/json')) return sendJson(res, 415, { ok: false, error: 'json only' });
    const cli = req.headers['x-riffledesk-cli'];
    const isCli = cli === '1' && !req.headers.origin;
    if (!isCli && !writeOriginOk(req)) {
      return sendJson(res, 403, {
        ok: false,
        error: 'same-origin Origin, or X-RiffleDesk-CLI: 1 without Origin, required'
      });
    }
    let body;
    try { body = await readBody(req, 256 * 1024); } catch (_) {
      return sendJson(res, 413, { ok: false, error: 'body too large' });
    }
    let payload;
    try { payload = JSON.parse(body.toString('utf8')); } catch (_) {
      return sendJson(res, 400, { ok: false, error: 'bad json' });
    }
    const rawPaths = payload && payload.paths;
    if (!Array.isArray(rawPaths) || !rawPaths.length) return sendJson(res, 400, { ok: false, error: 'missing paths' });
    if (rawPaths.length > PILE_MAX) return sendJson(res, 400, { ok: false, error: `too many paths (max ${PILE_MAX})` });
    const { files, dropped } = pileFiles(rawPaths);
    if (!files.length) return sendJson(res, 400, { ok: false, error: 'no usable paths', dropped });
    const title = String((payload.title == null ? '' : payload.title) || '').trim().slice(0, 200)
      || path.basename(files[0].path);
    const source = typeof payload.source === 'string' ? payload.source.slice(0, 40) : null;
    const pile = { id: newPileId(), title, paths: files.map(f => f.path), source, createdAt: Date.now() };
    piles.push(pile);
    if (piles.length > PILE_KEEP) piles = piles.slice(-PILE_KEEP);
    savePiles();
    const data = { id: pile.id, title, count: pile.paths.length, source, createdAt: pile.createdAt };
    let delivered = 0;
    // 同 /api/project：側邊欄精簡模式不接收疊（它沒有左欄可放）
    for (const r of eventClients) { if (panelSse.has(r)) continue; sendSse(r, 'pile', data); delivered++; }
    return sendJson(res, 200, { ok: true, delivered, id: pile.id, count: pile.paths.length, dropped });
  })();
}

function apiPileList(res) {
  return sendJson(res, 200, {
    ok: true,
    piles: piles.slice().reverse().map(p => ({
      id: p.id, title: p.title, count: p.paths.length, source: p.source, createdAt: p.createdAt
    }))
  });
}

function apiPileGet(res, u) {
  const id = u.searchParams.get('id');
  if (!id) return sendJson(res, 400, { ok: false, error: 'missing id' });
  const pile = piles.find(p => p.id === id);
  if (!pile) return sendJson(res, 404, { ok: false, error: 'no such pile' });
  const { files } = pileFiles(pile.paths);
  return sendJson(res, 200, {
    ok: true, id: pile.id, title: pile.title, source: pile.source,
    createdAt: pile.createdAt, files, missing: pile.paths.length - files.length
  });
}
// ================== end piles ==================

// ==================== shared UI prefs (view sync across full app / panel / drawer) ====================
// The auto-hide drawer's panel page rides in a third-party iframe under whatever
// site is open, so Chrome storage partitioning hands it a per-site, empty
// localStorage: it can never see the "★ 我的視角" saved in the full app. A small
// JSON file beside config.json (like piles.json) is the shared store instead —
// every surface fetches it at boot and mirrors its own saves back here.
// Guards: GET goes through the global /api/ Sec-Fetch-Site rule (cross-site
// fetches refused); POST goes through readWritePayload (JSON body + mandatory
// same-origin Origin — the drawer iframe IS same-origin with this server).
const PREFS_PATH = path.join(path.dirname(CONFIG_PATH), 'prefs.json');
// loose caps only — the clients clamp to their exact orbit ranges; this layer
// just rejects junk so a corrupt or hand-edited file can never break the UI
function prefView(v) {
  if (!v || typeof v !== 'object') return null;
  if (typeof v.yaw !== 'number' || typeof v.pitch !== 'number' || typeof v.zoom !== 'number') return null;
  if (!Number.isFinite(v.yaw) || !Number.isFinite(v.pitch) || !Number.isFinite(v.zoom)) return null;
  if (Math.abs(v.yaw) > 30 || v.pitch < 0 || v.pitch > 90 || v.zoom < 0.3 || v.zoom > 3) return null;
  return { yaw: v.yaw, pitch: v.pitch, zoom: v.zoom };
}
const PREF_SANITIZERS = {
  favView: prefView,     // ★ 我的視角（使用者按「存成我的視角」）
  lastView: prefView,    // 最近一次實際在用的視角（沒存過 favView 時的落點）
  // 側欄／抽屜的介面縮放
  panelZoom: v => (typeof v === 'number' && Number.isFinite(v) && v >= 0.5 && v <= 2) ? v : null
};
function loadPrefs() {
  try {
    const raw = JSON.parse(fs.readFileSync(PREFS_PATH, 'utf8'));
    const out = {};
    for (const k of Object.keys(PREF_SANITIZERS)) {
      const v = PREF_SANITIZERS[k](raw && raw[k]);
      if (v !== null) out[k] = v;
    }
    return out;
  } catch (e) {
    if (e && e.code !== 'ENOENT') console.warn('[prefs] load failed:', e.message || e);   // 第一次跑沒檔案是正常的
    return {};
  }
}
let sharedPrefs = loadPrefs();
function savePrefs() {
  try {
    const tmp = PREFS_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(sharedPrefs, null, 2));
    fs.renameSync(tmp, PREFS_PATH);
  } catch (e) { console.warn('[prefs] save failed:', (e && e.message) || e); }
}
async function apiPrefs(req, res) {
  if (req.method === 'GET') return sendJson(res, 200, { ok: true, prefs: sharedPrefs });
  const payload = await readWritePayload(req, res);
  if (!payload) return; // error already sent
  if (typeof payload !== 'object') return sendJson(res, 400, { ok: false, error: 'bad payload' });
  // 兩階段：先整包驗證、全過才一次套用——半途壞值不能留下「改了一半的記憶體狀態」
  const staged = {};
  for (const k of Object.keys(payload)) {
    if (!Object.hasOwn(PREF_SANITIZERS, k)) continue;   // 不認得的鍵靜默略過（前瞻相容）
    if (payload[k] === null) { staged[k] = null; continue; }   // null = 明確刪除（清掉 favView）
    const v = PREF_SANITIZERS[k](payload[k]);
    if (v === null) return sendJson(res, 400, { ok: false, error: 'bad value for ' + k });
    staged[k] = v;
  }
  let changed = false;
  for (const k of Object.keys(staged)) {
    if (staged[k] === null) { if (k in sharedPrefs) { delete sharedPrefs[k]; changed = true; } continue; }
    sharedPrefs[k] = staged[k];
    changed = true;
  }
  if (changed) savePrefs();
  return sendJson(res, 200, { ok: true, prefs: sharedPrefs });
}
// ================== end shared UI prefs ==================

// ==================== browser tabs bridge (Chrome extension → server → UI) ====================
// The web page cannot see the browser's other tabs, so a small MV3 extension
// (extension/) pushes the tab list here and long-polls for commands. Everything
// lives in memory: the list is rebuilt on every push, screenshots are kept per
// tab id, commands are a small queue. Nothing touches disk.
//
// Guards (same idea as /api/project, three layers, all cheap):
//  1. ext caller = `X-RiffleDesk-Ext: 1` header AND either no Origin or a
//     chrome-extension:// Origin. A cross-site *web page* cannot forge that
//     header without a CORS preflight (we answer none), and the /api/
//     Sec-Fetch-Site rule above refuses its requests anyway.
//  2. per-install token: the extension generates a random 48-hex token (stored
//     in chrome.storage.local) and sends it as `X-RiffleDesk-Token` on every
//     request. The first extension contact after the server starts pairs the
//     token; every later mismatch is 403 (restart the server to re-pair). This
//     closes the static-header hole even against another local process that
//     merely guesses the marker header.
//  3. UI-originated actions (/api/tabs/action) stay on the normal same-origin
//     write rules (Sec-Fetch-Site + Origin), and read/activate only address tab
//     ids from the extension's own latest pushed list. Reading page content is a
//     deliberate core capability of this feature, reachable ONLY from the local
//     RiffleDesk UI itself; other extensions / local malware are out of the
//     browser trust model.
const TABS_MAX = 500;
const TABS_TITLE_MAX = 300;
const TABS_URL_MAX = 2000;
const TABS_FAV_MAX = 24 * 1024;          // favicon as data: URL
const TABS_SHOT_MAX = 400 * 1024;        // one jpeg screenshot (base64 chars)
const TABS_BODY_MAX = 12 * 1024 * 1024;  // whole push (many shots)
const TABS_RESULT_MAX = 4 * 1024 * 1024; // text (≤200KB) + outerHTML (≤2MB) + slack
const TABS_TEXT_MAX = 200 * 1024;
const TABS_PREVIEW_TEXT_MAX = 1500;      // 卡片上給人看的可見文字（沒截圖的卡才有內容可讀）
const TABS_DESC_MAX = 500;               // meta description 摘要（卡面優先於主內容文字）
const TABS_HTML_MAX = 2 * 1024 * 1024;
const TABS_CMDQ_MAX = 50;
const TABS_READ_TIMEOUT = 12000;
const TABS_EXT_ALIVE_MS = 90000;

let tabList = [];                 // [{id, windowId, title, url, fav, active, discarded, lastAccessed, text, desc}]
// id -> {buf, ver}。截圖「跨推送保留」：擴充只拍到各視窗前景那張，若每次推送都把
// 整張表換掉，切走的分頁馬上沒圖、切回來才又長出來（卡片閃)。ver 讓前端知道
// 「同一個 tabId 的圖換了」而只重畫那一張。
let tabShots = new Map();
let tabShotVer = 1;
// og:image 代表圖：跟截圖同一套——記憶體 Map、跨推送保留、ver 版號、
// 擴充端去重（ogSent）只推新圖，server 缺哪張在推送回覆的 needOg 裡要回來
let tabOg = new Map();
let tabOgVer = 1;
let tabsAt = 0;                   // last full-list push
let tabsNeedsAllShots = false;    // 剛配對完：下一次回覆要求擴充把每一張截圖都重送
let extSeenAt = 0;                // last contact from the extension (any endpoint)
let tabsExtId = '';               // 擴充的 runtime id（頁面端直接 sendMessage 要用）
let tabsToken = null;             // per-install token, paired on first extension contact
const tabCmdQueue = [];           // commands waiting for the extension
const tabCmdWaiters = new Set();  // {res, timer} long-poll responses
const tabReadPend = new Map();    // reqId -> {resolve, timer}
let tabReqSeq = 1;

function extCallerOk(req) {
  if (req.headers['x-riffledesk-ext'] !== '1') return false;
  const o = req.headers.origin;
  // Firefox 的 extension fetch 會帶 Origin: moz-extension://…（Chrome 的 service
  // worker 不帶；這裡兩種都收）。一般網頁偽造不了自訂標頭，所以照樣安全。
  return !o || /^(chrome|moz)-extension:\/\//.test(String(o));
}

// Layer 2: pair the extension's per-install token on first contact, then
// require an exact match. `hostAllowed` (127.0.0.1 Host) already ran for every
// request before this handler.
function extTokenOk(req) {
  const tok = String(req.headers['x-riffledesk-token'] || '');
  if (!/^[0-9a-f]{32,128}$/.test(tok)) return { ok: false, error: 'X-RiffleDesk-Token required' };
  if (tabsToken === null) { tabsToken = tok; console.log('[tabs] extension token paired'); return { ok: true, paired: true }; }
  if (tok !== tabsToken) return { ok: false, error: 'extension token mismatch (restart the RiffleDesk server to re-pair)' };
  return { ok: true };
}

function clampStr(v, cap) {
  if (typeof v !== 'string') return '';
  return v.length > cap ? v.slice(0, cap) : v;
}

function sanTab(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = Number(raw.id);
  const windowId = Number(raw.windowId);
  if (!Number.isFinite(id) || !Number.isFinite(windowId)) return null;
  let fav = clampStr(raw.fav, TABS_FAV_MAX + 32);
  if (fav && !/^data:image\//i.test(fav) && !/^https?:\/\//i.test(fav)) fav = '';
  if (fav.length > TABS_FAV_MAX && !/^data:/i.test(fav)) fav = fav.slice(0, TABS_URL_MAX);
  return {
    id: Math.floor(id), windowId: Math.floor(windowId),
    title: clampStr(raw.title, TABS_TITLE_MAX),
    url: clampStr(raw.url, TABS_URL_MAX),
    fav,
    active: !!raw.active,
    discarded: !!raw.discarded,
    lastAccessed: Number.isFinite(Number(raw.lastAccessed)) ? Number(raw.lastAccessed) : 0,
    text: clampStr(raw.text, TABS_PREVIEW_TEXT_MAX).replace(/\s+/g, ' ').trim(),
    desc: clampStr(raw.desc, TABS_DESC_MAX).replace(/\s+/g, ' ').trim()
  };
}

function sanShot(v) {
  if (typeof v !== 'string' || v.length > TABS_SHOT_MAX * 1.4) return null;
  const m = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/i.exec(v);
  if (!m) return null;
  try {
    const buf = Buffer.from(m[2], 'base64');
    return buf.length && buf.length <= TABS_SHOT_MAX ? buf : null;
  } catch (_) { return null; }
}

function tabsBroadcast() {
  const data = { n: tabList.length, at: tabsAt };
  for (const r of eventClients) { try { sendSse(r, 'tabs', data); } catch (_) {} }
}

function apiTabsPush(req, res) {
  return (async () => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
    const ctype = String(req.headers['content-type'] || '').toLowerCase();
    if (!ctype.startsWith('application/json')) return sendJson(res, 415, { ok: false, error: 'json only' });
    const isExt = extCallerOk(req);
    if (!isExt && !writeOriginOk(req)) {
      return sendJson(res, 403, { ok: false, error: 'same-origin, or X-RiffleDesk-Ext: 1 with no/extension Origin, required' });
    }
    if (isExt) {
      const tk = extTokenOk(req);
      if (!tk.ok) return sendJson(res, 403, { ok: false, error: tk.error });
      extSeenAt = Date.now();
      // 重新配對（server 重開）＝擴充端的「送過了」記錄全部失效 → 要它整份重送截圖
      if (tk.paired) tabsNeedsAllShots = true;
    }
    let body;
    try { body = await readBody(req, TABS_BODY_MAX); } catch (_) {
      return sendJson(res, 413, { ok: false, error: 'body too large' });
    }
    let payload;
    try { payload = JSON.parse(body.toString('utf8')); } catch (_) {
      return sendJson(res, 400, { ok: false, error: 'bad json' });
    }
    // 擴充帶來自己的 runtime id：UI 要用 chrome.runtime.sendMessage(extId,…) 直接把
    // 點卡送給擴充（趁手勢開側邊欄），需要知道目標 id
    if (isExt && typeof payload.extId === 'string' && /^[\w@.\-]{3,128}$/.test(payload.extId)) {
      tabsExtId = payload.extId;
    }
    const rawTabs = payload && payload.tabs;
    if (!Array.isArray(rawTabs)) return sendJson(res, 400, { ok: false, error: 'missing tabs' });
    if (rawTabs.length > TABS_MAX) return sendJson(res, 400, { ok: false, error: `too many tabs (max ${TABS_MAX})` });
    const tabs = [];
    const shots = new Map();
    const ogs = new Map();
    const seen = new Set();
    for (const raw of rawTabs) {
      const tb = sanTab(raw);
      if (!tb || seen.has(tb.id)) continue;
      seen.add(tb.id);
      tabs.push(tb);
      const shot = sanShot(raw.shot);
      // 截圖來源標記：'drawn'＝擴充在背景用 DOM 繪圖畫的暫代圖，'shot'＝真截圖
      const kind = raw.shotKind === 'drawn' ? 'drawn' : 'shot';
      // 這次沒帶圖：沿用上一張（同 id 的分頁還在），卡片不會因為切走就變回空白面
      if (shot) shots.set(tb.id, { buf: shot, ver: ++tabShotVer, kind });
      else if (tabShots.has(tb.id)) shots.set(tb.id, tabShots.get(tb.id));
      const og = sanShot(raw.og);   // 代表圖同 sanShot 規格（jpeg ≤400KB）
      // ogClear：分頁導到「沒有 og:image」的頁面時擴充會明示，把舊圖丟掉，
      // 否則新網址會一直頂著上一頁的代表圖
      if (og) ogs.set(tb.id, { buf: og, ver: ++tabOgVer });
      else if (!raw.ogClear && tabOg.has(tb.id)) ogs.set(tb.id, tabOg.get(tb.id));
    }
    tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    tabList = tabs;
    tabShots = shots;
    tabOg = ogs;
    tabsAt = Date.now();
    tabsBroadcast();
    // 擴充只送「新拍的」截圖。哪些還是缺的報回去，擴充據此重送——
    // server 重開（記憶體清空）或 token 重新配對後，卡片才不會永遠空白。
    const needShot = tabsNeedsAllShots ? tabs.map(tb => tb.id)
      : tabs.filter(tb => !shots.has(tb.id)).map(tb => tb.id);
    const needOg = tabsNeedsAllShots ? tabs.map(tb => tb.id)
      : tabs.filter(tb => !ogs.has(tb.id)).map(tb => tb.id);
    tabsNeedsAllShots = false;
    return sendJson(res, 200, { ok: true, n: tabs.length, needShot, needOg });
  })();
}

function apiTabsList(res, u) {
  // ?meta=1＝輕量狀態包（完整版工具列的側欄鈕每 30 秒問一次，不能整份分頁清單來回搬）
  if (u && u.searchParams.get('meta') === '1') {
    return sendJson(res, 200, {
      ok: true, at: tabsAt, extId: tabsExtId,
      extAlive: extSeenAt > 0 && (Date.now() - extSeenAt) < TABS_EXT_ALIVE_MS,
      n: tabList.length
    });
  }
  return sendJson(res, 200, {
    ok: true,
    at: tabsAt,
    ext: extSeenAt,
    extId: tabsExtId,
    extAlive: extSeenAt > 0 && (Date.now() - extSeenAt) < TABS_EXT_ALIVE_MS,
    tabs: tabList.map(tb => ({
      ...tb,
      hasShot: tabShots.has(tb.id), shotVer: tabShots.has(tb.id) ? tabShots.get(tb.id).ver : 0,
      shotKind: tabShots.has(tb.id) ? (tabShots.get(tb.id).kind || 'shot') : null,
      hasOg: tabOg.has(tb.id), ogVer: tabOg.has(tb.id) ? tabOg.get(tb.id).ver : 0
    }))
  });
}

function apiTabsShot(res, u) {
  const id = Math.floor(Number(u.searchParams.get('id')));
  const e = Number.isFinite(id) ? tabShots.get(id) : null;
  const buf = e && e.buf;
  if (!buf) return sendJson(res, 404, { ok: false, error: 'no shot' });
  // ?v= 版號不同就是新圖：可快取，切來切去不用重抓
  res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=600' });
  return res.end(buf);
}

// og:image 代表圖：同 /api/tabs/shot，只是圖床是 tabOg（擴充端已縮成 ≤800px JPEG）
function apiTabsOg(res, u) {
  const id = Math.floor(Number(u.searchParams.get('id')));
  const e = Number.isFinite(id) ? tabOg.get(id) : null;
  const buf = e && e.buf;
  if (!buf) return sendJson(res, 404, { ok: false, error: 'no og image' });
  res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=600' });
  return res.end(buf);
}

function tabCmdEnqueue(cmd) {
  cmd.at = Date.now();
  tabCmdQueue.push(cmd);
  if (tabCmdQueue.length > TABS_CMDQ_MAX) tabCmdQueue.shift();
  for (const w of [...tabCmdWaiters]) {
    clearTimeout(w.timer);
    tabCmdWaiters.delete(w);
    const next = tabCmdQueue.shift();
    sendJson(w.res, 200, { ok: true, cmd: next || null });
  }
}

// UI asks the extension to do something with a tab. 'read' waits for the
// content round-trip; 'activate'/'open' are fire-and-forget.
function apiTabsAction(req, res) {
  return (async () => {
    const payload = await readWritePayload(req, res, 16 * 1024);
    if (!payload) return; // error already sent
    const op = payload.op;
    if (op !== 'read' && op !== 'activate' && op !== 'open' && op !== 'close' && op !== 'restore') {
      return sendJson(res, 400, { ok: false, error: 'bad op' });
    }
    const extAlive = extSeenAt > 0 && (Date.now() - extSeenAt) < TABS_EXT_ALIVE_MS;
    if (!extAlive) return sendJson(res, 503, { ok: false, error: 'extension not connected' });
    if (op === 'open') {
      const url = clampStr(payload.url, TABS_URL_MAX);
      if (!/^https?:\/\//i.test(url)) return sendJson(res, 400, { ok: false, error: 'http(s) url only' });
      tabCmdEnqueue({ reqId: tabReqSeq++, op, url });
      return sendJson(res, 200, { ok: true });
    }
    if (op === 'restore') {
      // 卡片 × 的「復原」：擴充 chrome.sessions.restore()。不帶 tabId（還原出來的是新 id）。
      tabCmdEnqueue({ reqId: tabReqSeq++, op });
      return sendJson(res, 200, { ok: true });
    }
    const tabId = Math.floor(Number(payload.tabId));
    if (!Number.isFinite(tabId)) return sendJson(res, 400, { ok: false, error: 'missing tabId' });
    if (op === 'close') {
      // 關掉的瞬間擴充下一次推送就會少這個 id；若剛好已關，404 也一樣算關成
      if (tabList.find(x => x.id === tabId)) {
        tabCmdEnqueue({ reqId: tabReqSeq++, op, tabId });
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 404, { ok: false, error: 'no such tab' });
    }
    const tb = tabList.find(x => x.id === tabId);
    if (!tb) return sendJson(res, 404, { ok: false, error: 'no such tab' });
    if (op === 'activate') {
      tabCmdEnqueue({ reqId: tabReqSeq++, op, tabId, windowId: tb.windowId });
      return sendJson(res, 200, { ok: true });
    }
    // read: queue + wait for the extension's /api/tabs/result
    const reqId = tabReqSeq++;
    const done = new Promise(resolve => {
      const timer = setTimeout(() => {
        tabReadPend.delete(reqId);
        resolve({ status: 504, body: { ok: false, error: 'extension timeout' } });
      }, TABS_READ_TIMEOUT);
      timer.unref();
      tabReadPend.set(reqId, { resolve, timer });
    });
    tabCmdEnqueue({ reqId, op, tabId });
    const r = await done;
    return sendJson(res, r.status, r.body);
  })();
}

// POST /api/tabs/focus {tabId} — 側欄「回到完整畫面」：叫所有非側欄客戶端（完整視窗）
// 捲到這張卡。來源兩種都收：頁面自己送（同源寫入規則）、擴充代送（擴充標頭＋配對 token）。
function apiTabsFocus(req, res) {
  return (async () => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
    const ctype = String(req.headers['content-type'] || '').toLowerCase();
    if (!ctype.startsWith('application/json')) return sendJson(res, 415, { ok: false, error: 'json only' });
    if (!writeOriginOk(req)) {
      if (!extCallerOk(req)) return sendJson(res, 403, { ok: false, error: 'bad origin' });
      const tk = extTokenOk(req);
      if (!tk.ok) return sendJson(res, 403, { ok: false, error: tk.error });
    }
    let body;
    try { body = await readBody(req, 4 * 1024); } catch (_) { return sendJson(res, 413, { ok: false, error: 'body too large' }); }
    let payload;
    try { payload = JSON.parse(body.toString('utf8')); } catch (_) { return sendJson(res, 400, { ok: false, error: 'bad json' }); }
    const tabId = Math.floor(Number(payload && payload.tabId));
    if (!Number.isFinite(tabId) || tabId <= 0) return sendJson(res, 400, { ok: false, error: 'bad tabId' });
    let delivered = 0;
    for (const r of eventClients) { if (panelSse.has(r)) continue; sendSse(r, 'tabfocus', { tabId }); delivered++; }
    return sendJson(res, 200, { ok: true, delivered });
  })();
}

// Extension long-poll: GET /api/tabs/cmd?wait=15000 → {cmd} or {cmd:null}
function apiTabsCmd(req, res, u) {
  if (!extCallerOk(req)) return sendJson(res, 403, { ok: false, error: 'X-RiffleDesk-Ext: 1 required' });
  const tk = extTokenOk(req);
  if (!tk.ok) return sendJson(res, 403, { ok: false, error: tk.error });
  extSeenAt = Date.now();
  if (tabCmdQueue.length) return sendJson(res, 200, { ok: true, cmd: tabCmdQueue.shift() });
  const wait = Math.max(0, Math.min(25000, Math.floor(Number(u.searchParams.get('wait')) || 0)));
  if (!wait) return sendJson(res, 200, { ok: true, cmd: null });
  const w = { res, timer: null };
  w.timer = setTimeout(() => {
    tabCmdWaiters.delete(w);
    sendJson(res, 200, { ok: true, cmd: null });
  }, wait);
  w.timer.unref();
  tabCmdWaiters.add(w);
  req.on('close', () => {
    if (!tabCmdWaiters.has(w)) return;
    tabCmdWaiters.delete(w);
    clearTimeout(w.timer);
  });
}

// Extension posts the result of a 'read' (or an ack for the fire-and-forget ops).
function apiTabsResult(req, res) {
  return (async () => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
    const ctype = String(req.headers['content-type'] || '').toLowerCase();
    if (!ctype.startsWith('application/json')) return sendJson(res, 415, { ok: false, error: 'json only' });
    if (!extCallerOk(req)) return sendJson(res, 403, { ok: false, error: 'X-RiffleDesk-Ext: 1 required' });
    const tk = extTokenOk(req);
    if (!tk.ok) return sendJson(res, 403, { ok: false, error: tk.error });
    extSeenAt = Date.now();
    let body;
    try { body = await readBody(req, TABS_RESULT_MAX); } catch (_) {
      return sendJson(res, 413, { ok: false, error: 'body too large' });
    }
    let payload;
    try { payload = JSON.parse(body.toString('utf8')); } catch (_) {
      return sendJson(res, 400, { ok: false, error: 'bad json' });
    }
    const reqId = Math.floor(Number(payload && payload.reqId));
    const pend = tabReadPend.get(reqId);
    if (!pend) return sendJson(res, 200, { ok: true, dropped: true }); // timed out already / non-read op
    tabReadPend.delete(reqId);
    clearTimeout(pend.timer);
    if (!payload.ok) {
      pend.resolve({ status: 502, body: { ok: false, error: clampStr(payload.error, 300) || 'extension failed' } });
    } else {
      const text = clampStr(payload.text, TABS_TEXT_MAX);
      let html = clampStr(payload.html, TABS_HTML_MAX + 64);
      const htmlTruncated = !!payload.htmlTruncated || (typeof payload.html === 'string' && payload.html.length > TABS_HTML_MAX);
      if (htmlTruncated) html = html.slice(0, TABS_HTML_MAX);
      pend.resolve({ status: 200, body: {
        ok: true, reqId,
        title: clampStr(payload.title, TABS_TITLE_MAX),
        url: clampStr(payload.url, TABS_URL_MAX),
        text, textTruncated: !!payload.textTruncated,
        html, htmlTruncated
      } });
    }
    return sendJson(res, 200, { ok: true });
  })();
}
// ================== end browser tabs bridge ==================

// ---------- request handler ----------
async function requestHandler(req, res) {
  try {
    if (!hostAllowed(req)) { res.writeHead(421); return res.end('misdirected request'); }

    // browser-mediated cross-site oracle defence: the UI is the only legit client;
    // any fetch navigated/embedded from another site carries Sec-Fetch-Site != same-origin.
    // (no-cors GET from a web page cannot read bodies, but this also kills existence/timing oracles.)
    // /raw/ gets the same rule: it relaxes CORP for the opaque-origin preview, so
    // cross-site embedding of it must still be refused.
    if (req.url.startsWith('/api/')) {
      const sfs = String(req.headers['sec-fetch-site'] || '').toLowerCase();
      if (sfs && sfs !== 'same-origin' && sfs !== 'same-site' && sfs !== 'none') {
        return sendJson(res, 403, { ok: false, error: 'cross-site fetch denied' });
      }
    }
    // /raw/ is NOT Sec-Fetch-Site-guarded and deliberately sends ACAO:* (an
    // opaque-origin iframe could not load its own page otherwise). Reads there
    // are instead capability-guarded: the URL's first segment must be a live
    // token (unguessable 128-bit, minted only by same-origin /api/rawopen), and
    // an unknown token answers a plain 404 — so cross-site pages, including
    // attacker-made opaque iframes that launder Origin:null, cannot read
    // anything at all under /raw/.
    // never allow this origin's resources to be embedded cross-origin
    res.setHeader('cross-origin-resource-policy', 'same-origin');
    const u = new URL(req.url, `http://${HOST}:${req.socket.localPort}`);
    // ?mode=panel 的主文件放寬框入限制：自動收合側欄（右緣抽屜）的面板殼掛在任意
    // 網頁裡（網頁 → chrome-extension 殼 → 這一頁），frame-ancestors 比對整條祖先鏈，
    // 不放的話抽屜在任何一般網頁上都載不出來。完整介面（沒有 mode=panel）維持只准
    // 自家與擴充框住；/api/ 上另有 Sec-Fetch-Site 把關，frame 內按鈕的寫入操作仍是
    // 同源 fetch，防線不變。
    // 只有帶對擴充配對 token（dk=）的抽屜面板才放寬：隨便哪個網站自己框
    // ?mode=panel 拿不到 token，照樣被擋（防點擊劫持關掉真分頁）。
    const dk = u.searchParams.get('dk');
    const isPanelDoc = (u.pathname === '/' || u.pathname === '/index.html') &&
      u.searchParams.get('mode') === 'panel' && !!tabsToken && typeof dk === 'string' && dk === tabsToken;
    // Framing lock: the UI may sit inside the browser extension's side panel
    // (a chrome-extension:// / moz-extension:// iframe, ?mode=panel). Any other
    // website trying to frame the full UI — say, to clickjack the file open/read
    // UI — is refused. frame-ancestors 'self' 的放行對自家頁面（分頁預覽之外）照樣有效。
    res.setHeader('content-security-policy',
      isPanelDoc
        ? "frame-ancestors 'self' chrome-extension://* moz-extension://* http: https:"
        : "frame-ancestors 'self' chrome-extension://* moz-extension://*");

    // demo mode: callers speak the fake home; the handlers work on real paths
    if (DEMO_DIR) {
      const qp = u.searchParams.get('path');
      if (qp) u.searchParams.set('path', demoReal(qp));
    }
    const p = u.pathname;

    if (p === '/api/drives') {
      return sendJson(res, 200, {
        ok: true,
        drives: DEMO_DIR ? [] : localDrives(),
        roots: existingRoots(),
        pinned: [...config.pinned]
      });
    }

    if (p === '/api/roots') { // kept for compatibility
      return sendJson(res, 200, { ok: true, roots: existingRoots(), pinned: [...config.pinned] });
    }

    if (p === '/api/list') {
      const q = u.searchParams.get('path');
      if (!q) return sendJson(res, 400, { ok: false, error: 'missing path' });
      const nofiles = u.searchParams.get('nofiles') === '1';
      const exts = u.searchParams.get('exts');
      const off = Math.max(0, Math.min(1e7, Math.floor(Number(u.searchParams.get('off')) || 0)));
      const sortRaw = u.searchParams.get('sort') || 'new';
      const sortMode = LIST_SORTS.has(sortRaw) ? sortRaw : 'new';
      const data = listDir(q, exts, nofiles, off, sortMode);
      // follow-up pages only need the files — skip subdir rollups entirely
      if (off > 0) {
        if (!nofiles && config.secretScan !== false) markSecretFlags(data.path, data.files);
        return sendJson(res, 200, { ok: true, path: data.path, files: data.files, total: data.total, hasMore: data.hasMore, off: data.off });
      }
      // deepCount: per-subdir recursive match counts from the index's pre-aggregated
      // rollup — O(#direct subdirs), never O(#files below); null when the tree has
      // not completed a crawl yet (the tree then fills numbers in a moment later)
      let dc = null;
      if (indexer && indexer.available) {
        dc = indexer.deepCounts(data.path, data.dirs.map(d => d.path), exts);
        indexer.noteListDir(data.path); // refresh this dir's direct files in the background
      }
      for (const d of data.dirs) d.deepCount = dc ? (dc.get(norm(d.path)) ?? null) : null;
      // the listed folder's own subtree total (pinned / quick-access rows show this)
      let deepCount = null;
      if (dc && data.dirs.every(d => d.deepCount != null)) {
        const direct = countMatching(readDirNames(data.path) || [], parseExts(exts));
        deepCount = data.dirs.reduce((s, d) => s + d.deepCount, direct);
      }
      if (!nofiles && config.secretScan !== false) markSecretFlags(data.path, data.files);
      return sendJson(res, 200, { ok: true, ...data, deepCount });
    }

    if (p === '/api/search') {
      const q0 = u.searchParams.get('path');
      if (!q0) return sendJson(res, 400, { ok: false, error: 'missing path' });
      const q = (u.searchParams.get('q') || '').trim();
      if (!q) return sendJson(res, 400, { ok: false, error: 'empty q' });
      if (q.length > 200) return sendJson(res, 400, { ok: false, error: 'q too long' });
      const rawLimit = Number(u.searchParams.get('limit'));
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(1000, Math.floor(rawLimit)) : 200;
      const abs = path.resolve(q0);
      if (!isAllowed(abs)) return sendJson(res, 403, { ok: false, error: 'path not under allowed scopes' });
      let st;
      try { st = fs.statSync(abs); } catch (_) { return sendJson(res, 404, { ok: false, error: 'not found' }); }
      if (!st.isDirectory()) return sendJson(res, 400, { ok: false, error: 'not a directory' });
      if (indexer && indexer.available) {
        // covered by a completed crawl → answer from the persistent index
        const fromIndex = await indexer.search(abs, q, u.searchParams.get('exts'), limit);
        if (fromIndex) return sendJson(res, 200, { ok: true, path: abs, q, ...fromIndex });
        // outside the indexed scope: live-scan now, remember the root for next time
        indexer.noteSearchOutside(abs);
      }
      const data = await searchTree(abs, q, u.searchParams.get('exts'));
      data.files = data.files.slice(0, limit);
      return sendJson(res, 200, { ok: true, path: abs, q, ...data, indexed: false });
    }

    if (p === '/api/file') {
      const q = u.searchParams.get('path');
      if (!q) return sendJson(res, 400, { ok: false, error: 'missing path' });
      if (q.includes('\0')) return sendJson(res, 400, { ok: false, error: 'bad path' });
      return serveFile(req, res, path.resolve(q), u);
    }

    // Mint a /raw/ capability token for one opened file. Same protection as every
    // /api/ read: no CORS headers and the Sec-Fetch-Site guard above mean only a
    // same-origin page can read the token out of this response. The token is
    // scoped to the file's directory tree (+ paths the file:/// rewrite emits).
    if (p === '/api/rawopen') {
      const q = u.searchParams.get('path');
      if (!q || q.includes('\0')) return sendJson(res, 400, { ok: false, error: 'missing path' });
      const abs = path.resolve(q);
      if (!isAllowed(abs)) return sendJson(res, 403, { ok: false, error: 'path not under allowed scopes' });
      const token = crypto.randomBytes(16).toString('hex');
      if (rawTokens.size >= 512) rawTokens.delete(rawTokens.keys().next().value);  // FIFO cap
      const revise = u.searchParams.get('revise') === '1';
      const entry = { abs, dir: norm(path.dirname(abs)), allow: new Set(), revise, run: revise && u.searchParams.get('run') === '1' };
      if (revise) entry.allow.add(norm(REVISE_AGENT));
      rawTokens.set(token, entry);
      let url = rawUrlFor(abs, token);
      if (revise) url += '?revise=1';
      return sendJson(res, 200, { ok: true, token, url });
    }

    if (p === '/api/secretscan') return apiSecretScan(res, u);

    // AI conversation endpoints (implementation in the fenced block above)
    if (p === '/api/events') return apiEvents(req, res, u); // SSE: dir + convos + project events

    if (p === '/api/project') return apiProject(req, res);

    if (p === '/api/pile') {
      if (req.method === 'POST') return apiPile(req, res);
      return apiPileGet(res, u);
    }
    if (p === '/api/piles') return apiPileList(res);

    // shared UI prefs (view sync across full app / side panel / auto-hide drawer)
    if (p === '/api/prefs') return apiPrefs(req, res);

    // browser tabs bridge (extension → server → UI); implementation above
    if (p === '/api/tabs') {
      if (req.method === 'POST') return apiTabsPush(req, res);
      return apiTabsList(res, u);
    }
    if (p === '/api/tabs/shot') return apiTabsShot(res, u);
    if (p === '/api/tabs/og') return apiTabsOg(res, u);
    if (p === '/api/tabs/action') return apiTabsAction(req, res);
    if (p === '/api/tabs/focus') return apiTabsFocus(req, res);
    if (p === '/api/tabs/cmd') return apiTabsCmd(req, res, u);
    if (p === '/api/tabs/result') return apiTabsResult(req, res);

    if (p === '/api/convos') return apiConvos(res, u);
    if (p === '/api/convo') return apiConvo(res, u);
    if (p === '/api/recent') return apiRecent(res, u);
    if (p === '/api/recentmod') return apiRecentMod(res, u);
    if (p === '/api/whichconvo') return apiWhichConvo(res, u);

    if (p === '/api/pin' && req.method === 'POST') {
      // CSRF guard: JSON content-type forces a CORS preflight cross-origin
      // (we answer none), and a present Origin must be this very origin.
      const ctype = String(req.headers['content-type'] || '').toLowerCase();
      if (!ctype.startsWith('application/json')) return sendJson(res, 415, { ok: false, error: 'json only' });
      if (!originAllowed(req)) return sendJson(res, 403, { ok: false, error: 'bad origin' });

      const body = await readBody(req);
      let payload;
      try { payload = JSON.parse(body.toString('utf8')); } catch (_) {
        return sendJson(res, 400, { ok: false, error: 'bad json' });
      }
      const target = payload && payload.path;
      if (!target || typeof target !== 'string') return sendJson(res, 400, { ok: false, error: 'missing path' });
      const abs = path.resolve(demoReal(target));
      let st;
      try { st = fs.statSync(abs); } catch (_) { return sendJson(res, 404, { ok: false, error: 'not found' }); }
      if (!st.isDirectory()) return sendJson(res, 400, { ok: false, error: 'not a directory' });
      // any existing local directory may be pinned (scopes are read-only for content)
      const nw = norm(abs);
      const idx = config.pinned.findIndex(x => norm(x) === nw);
      const want = payload.pinned !== false;
      if (want && idx === -1) { config.pinned.push(abs); persistConfig(); }
      if (!want && idx !== -1) { config.pinned.splice(idx, 1); persistConfig(); }
      return sendJson(res, 200, { ok: true, pinned: [...config.pinned] });
    }

    if (p === '/api/index/status') {
      const s = indexer && indexer.available
        ? indexer.status()
        : { available: false, files: 0, roots: [], crawling: false, lastCrawlMs: null, lastCrawlAt: null, contentEnabled: null, dbBytes: null };
      return sendJson(res, 200, { ok: true, ...s });
    }

    // content-layer toggle (metadata layer always stays on). Same CSRF/origin
    // rules as the file write endpoints; persists to config.json.
    if (p === '/api/index/content') {
      const payload = await readWritePayload(req, res);
      if (!payload) return; // error already sent
      if (typeof payload.on !== 'boolean') return sendJson(res, 400, { ok: false, error: 'on must be a boolean' });
      if (!indexer || !indexer.available) return sendJson(res, 503, { ok: false, error: 'index unavailable' });
      config.indexContent = payload.on;
      try { persistConfig(); } catch (err) {
        return sendJson(res, 500, { ok: false, error: 'config write failed: ' + err.message });
      }
      const applied = await indexer.setContentEnabled(payload.on);
      return sendJson(res, 200, { ok: true, contentEnabled: applied === null ? payload.on : !!applied });
    }

    // write endpoints (JSON body + mandatory same-origin Origin header)
    if (p === '/api/reveal' || p === '/api/open' || p === '/api/rename' || p === '/api/trash') {
      const payload = await readWritePayload(req, res);
      if (!payload) return; // error already sent
      demoTarget(payload);
      const group = typeof payload.group === 'string' ? payload.group.slice(0, 80) : undefined;
      let r;
      if (p === '/api/reveal') r = fileOps.reveal(payload.path);
      else if (p === '/api/open') r = fileOps.openFile(payload.path);
      else if (p === '/api/rename') r = fileOps.rename(payload.path, payload.newName, group);
      else r = await fileOps.trash(payload.path, group);
      return sendJson(res, r.status, r.body);
    }

    // undo the last rename/trash/save (Ctrl+Z). Same guards as the other write routes.
    if (p === '/api/undo') {
      const payload = await readWritePayload(req, res);
      if (!payload) return; // error already sent
      const r = await fileOps.undoLast();
      return sendJson(res, r.status, r.body);
    }

    // save an edited text file from the reader. Content up to 5 MB → the JSON
    // body cap is raised for this route only (other write routes stay small).
    if (p === '/api/save') {
      const payload = await readWritePayload(req, res, 12 * 1024 * 1024);
      if (!payload) return; // error already sent
      demoTarget(payload);
      const r = fileOps.saveEdit(payload.path, payload.content, payload.baseMtime, payload.baseSize);
      return sendJson(res, r.status, r.body);
    }

    // save a revise list ("✎ 改版") next to the HTML file it belongs to. Writes
    // <name>.changes.json (+ optional .changes.png screenshot) and keeps the
    // previous json as .changes.prev.json. The item contract is fixed — an AI CLI
    // reads these files.
    if (p === '/api/revise/save') {
      const payload = await readWritePayload(req, res, 20 * 1024 * 1024);
      if (!payload) return; // error already sent
      demoTarget(payload);
      const r = writeReviseSave(payload);
      return sendJson(res, r.status, r.body);
    }



    // /raw/<abs path> — whole-file serving for the opt-in "run page scripts" HTML
    // preview (sandboxed opaque-origin iframe). Same scope rules as /api/file.
    if (p.startsWith('/raw/')) return serveRaw(req, res, p.slice('/raw/'.length));

    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, p);
  } catch (err) {
    const code = err.status || 500;
    return sendJson(res, code, { ok: false, error: err.message || 'server error' });
  }
}

// ---------- startup ----------
function start(port) {
  // persistent full-text index next to config.json (set RIFFLEDESK_INDEX=off to
  // disable; when node:sqlite is missing the server just keeps live-scanning)
  if (String(process.env.RIFFLEDESK_INDEX || '').toLowerCase() !== 'off' && !indexer) {
    const idx = createIndexer({
      dbPath: path.join(path.dirname(CONFIG_PATH), 'index.db'),
      norm, parseExts, getRoots: existingRoots,
      getScopes: () => ({ scopes: allowedScopes(), realScopes: realScopes() }),
      getIndexOptions: () => {
        const mb = Number(config.indexMaxMB);
        return {
          skipDirs: Array.isArray(config.indexSkipDirs) ? config.indexSkipDirs : [],
          maxMB: Number.isFinite(mb) && mb >= 0 ? mb : 2048,
          contentEnabled: config.indexContent !== false,
          secretScan: config.secretScan !== false,
          secretSkipDirs: Array.isArray(config.secretScanSkipDirs) ? config.secretScanSkipDirs : []
        };
      },
      KIND, TEXTLIKE, READABLE_EXTS,
      log: m => console.log(`${PKG.name}: ${m}`)
    });
    // available flips true once the worker reports ready (async); every method
    // no-ops/falls back until then, so wiring unconditionally is safe
    indexer = idx;
    indexer.schedule();
  }
  if (!fileOps) {
    fileOps = createFileOps({ isAllowed, norm, indexer, KIND, invalidateDir });
  }
  const server = http.createServer(requestHandler);
  if (process.env.RIFFLEDESK_LOOPWATCH === '1') {
    // debug aid: report the worst event-loop stall per 5 s window
    let last = Date.now(), worst = 0;
    const t = setInterval(() => {
      const now = Date.now();
      const drift = now - last - 200;
      last = now;
      if (drift > worst) worst = drift;
      if (now % 5000 < 250 && worst > 30) { console.log(`${PKG.name}: loopwatch worst stall ${worst}ms`); worst = 0; }
    }, 200);
    t.unref();
  }
  server.listen(port, HOST, () => {
    console.log(`${PKG.name} listening: http://${HOST}:${port}/`);
    console.log(`drives: ${localDrives().map(d => d.path).join(' ')} | roots: ${existingRoots().join(' | ')}`);
  });
  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT || process.argv[2]) || 5177;
  const server = start(port);
  // 開機先在背景把對話紀錄掃一遍（第一次要好幾秒），使用者點開「對話」區時就是熱的
  setTimeout(() => { convoScan(Date.now() - 30 * 86400000).catch(() => {}); }, 1500).unref();
  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.error(`port ${port} is busy — set PORT or pass a port argument (riffledesk --port N)`);
      process.exit(1);
    }
    throw err;
  });
}

// small export surface for the bin launcher and tests
module.exports = { start, norm, isAllowed, searchTree, rawPathFor, rawUrlFor, rawPathToAbs, rewriteFileUrls, tokenEntry,
  _eventsState: () => ({ clients: eventClients.size, watchers: dirWatchers.size, convoSubs: convoHub.subs.size }) };

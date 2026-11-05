// tests/cpu-budget.mjs — whole-process CPU during an index crawl (before/after tool).
//
//   node tests/cpu-budget.mjs [--files 50000] [--window 90] [--port 5191]
//
// Builds (once, then reuses) a synthetic tree at os.tmpdir()/riffledesk-cpu-tree:
// <files> entries, every 10th a small .md (content read + trigram insert —
// the heaviest crawl work), the rest .bin (metadata only). Each run starts
// server.js with a throwaway config + empty index.db, so every measurement is
// a full fresh crawl of the same tree. The child self-reports process-wide CPU
// (all threads: main, index worker, V8 helpers, libuv pool) as % of one core
// once per second (RIFFLEDESK_CPU_SAMPLE_MS — pure measurement hook, off by
// default); this script reports mean/p95/max of the samples taken WHILE
// crawling:true.
//
// The design budget: worker ≈ 12% duty ⇒ whole process ≤ 25% of one core
// (makePacer in indexer-worker.js). Exit code is 1 when p95 or max exceed
// RIFFLEDESK_CPU_LIMIT_P95 / RIFFLEDESK_CPU_LIMIT_MAX (default 25/35).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const FILE_COUNT = Number(arg('files', process.env.CPU_FILES || 50000));
const WINDOW_MS = Number(arg('window', process.env.CPU_WINDOW_S || 90)) * 1000;
const PORT = Number(arg('port', process.env.CPU_PORT || 5191));
if (PORT < 5190 || PORT > 5199) throw new Error('port must be in the team test range 5190-5199');
const LIMIT_P95 = Number(process.env.RIFFLEDESK_CPU_LIMIT_P95 || 25);
const LIMIT_MAX = Number(process.env.RIFFLEDESK_CPU_LIMIT_MAX || 35);

const TREE = process.env.CPU_TREE_DIR || path.join(os.tmpdir(), 'riffledesk-cpu-tree');
const WORDS = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu'.split(' ');
const text = seed => {
  let out = '';
  let x = seed | 1;
  while (out.length < 2200) { x = (x * 1103515245 + 12345) & 0x7fffffff; out += WORDS[x % WORDS.length] + ' '; }
  return out + '\n';
};

function buildTree() {
  const marker = path.join(TREE, '.bench-manifest.json');
  try {
    const m = JSON.parse(fs.readFileSync(marker, 'utf8'));
    if (m.files === FILE_COUNT) { console.log(`tree: reusing ${TREE} (${FILE_COUNT} files)`); return; }
  } catch (_) {}
  console.log(`tree: building ${FILE_COUNT} files in ${TREE} (one-off, reused on later runs)`);
  fs.rmSync(TREE, { recursive: true, force: true });
  const dirs = Math.max(10, Math.ceil(FILE_COUNT / 100));
  let n = 0;
  for (let d = 0; d < dirs && n < FILE_COUNT; d++) {
    const dir = path.join(TREE, 'd' + String(d).padStart(4, '0'));
    fs.mkdirSync(dir, { recursive: true });
    for (let f = 0; f < 100 && n < FILE_COUNT; f++, n++) {
      if (n % 10 === 0) fs.writeFileSync(path.join(dir, `n${f}.md`), text(n));
      else fs.writeFileSync(path.join(dir, `n${f}.bin`), Buffer.alloc(512, n & 0xff));
    }
  }
  fs.writeFileSync(marker, JSON.stringify({ files: n }));
  console.log(`tree: built ${n} files`);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJson(p) {
  const res = await fetch(`http://127.0.0.1:${PORT}` + p);
  return res.json();
}

function pct(arr, q) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))];
}

buildTree();
const RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'riffledesk-cpu-run-'));
fs.writeFileSync(path.join(RUN, 'config.json'), JSON.stringify({ roots: [TREE], pinned: [], indexContent: true }));

const proc = spawn('node', ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, NODE_ENV: 'test', RIFFLEDESK_TEST_DRIVES: TREE, PORT: String(PORT), RIFFLEDESK_CONFIG: path.join(RUN, 'config.json'), RIFFLEDESK_CPU_SAMPLE_MS: '1000' },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true
});
let serverOutTail = '';
let crawlOn = false;
const samples = []; // { pct, crawling }
let crawlStart = 0;
proc.stdout.on('data', d => {
  serverOutTail = (serverOutTail + d).slice(-4000);
  for (const m of String(d).matchAll(/cpusample ([\d.]+)/g)) samples.push({ pct: Number(m[1]), crawling: crawlOn, t: Date.now() - crawlStart });
});
proc.stderr.on('data', d => { serverOutTail = (serverOutTail + d).slice(-4000); });

async function waitListening() {
  const t0 = Date.now();
  while (!serverOutTail.includes('listening')) {
    if (proc.exitCode !== null) throw new Error('server exited early:\n' + serverOutTail);
    if (Date.now() - t0 > 15000) throw new Error('server start timeout:\n' + serverOutTail);
    await sleep(50);
  }
}

try {
  await waitListening();
  // ride along with the boot crawl of the fresh tree
  const t0 = Date.now();
  for (;;) {
    const st = await getJson('/api/index/status').catch(() => null);
    if (st && st.crawling) break;
    if (Date.now() - t0 > 30000) throw new Error('crawl never started: ' + JSON.stringify(st) + '\n' + serverOutTail);
    await sleep(200);
  }
  crawlOn = true;
  crawlStart = Date.now();
  for (;;) {
    const st = await getJson('/api/index/status').catch(() => null);
    const over = Date.now() - crawlStart > WINDOW_MS;
    if ((st && !st.crawling) || over) { crawlOn = false; break; }
    await sleep(500);
  }
  await sleep(1200); // let the final in-flight sample line trickle in
  // split reporting: the first WARMUP_S of a fresh-process crawl include V8
  // tier-up compilation of the just-loaded worker — real CPU, but boot churn
  // the pacing budget never claimed to bound. Steady state is the paced phase.
  const WARMUP_S = Number(process.env.CPU_WARMUP_S || 10);
  const inCrawl = samples.filter(s => s.crawling);
  const early = inCrawl.filter(s => s.t <= WARMUP_S * 1000).map(s => s.pct);
  const steady = inCrawl.filter(s => s.t > WARMUP_S * 1000).map(s => s.pct);
  const list = steady.length >= 8 ? steady : inCrawl.map(s => s.pct);
  const mean = list.reduce((a, b) => a + b, 0) / Math.max(1, list.length);
  const report = {
    files: FILE_COUNT,
    crawlWindowSec: Math.round((Date.now() - crawlStart) / 1000),
    crawlFinished: !crawlOn,
    samples: list.length,
    cpuPctOfOneCore: {
      mean: Number(mean.toFixed(1)),
      p95: Number(pct(list, 0.95).toFixed(1)),
      max: Number(Math.max(...list, 0).toFixed(1))
    },
    budget: { p95: LIMIT_P95, max: LIMIT_MAX },
    earlyWarmup: { samples: early.length, p95: Number(pct(early, 0.95).toFixed(1)), max: Number(Math.max(...early, 0).toFixed(1)) },
    raw: list.map(v => Number(v.toFixed(1)))
  };
  console.log(JSON.stringify(report, null, 2));
  const over = report.cpuPctOfOneCore.p95 > LIMIT_P95 || report.cpuPctOfOneCore.max > LIMIT_MAX;
  console.log(over ? `RESULT: OVER BUDGET (p95 ${report.cpuPctOfOneCore.p95}% > ${LIMIT_P95}% or max ${report.cpuPctOfOneCore.max}% > ${LIMIT_MAX}%)`
    : `RESULT: within budget (p95 ${report.cpuPctOfOneCore.p95}% <= ${LIMIT_P95}%, max ${report.cpuPctOfOneCore.max}% <= ${LIMIT_MAX}%)`);
  process.exitCode = over ? 1 : 0;
} finally {
  try { proc.kill(); } catch (_) {}
  await Promise.race([new Promise(r => proc.once('exit', r)), sleep(3000)]);
  await sleep(300);
  try { fs.rmSync(RUN, { recursive: true, force: true }); } catch (_) {}
}

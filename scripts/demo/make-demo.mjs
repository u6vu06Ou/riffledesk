// make-demo.mjs — build a fully made-up file tree for screenshots, videos and manual
// demoing. Nothing in here is copied from a real machine: every name, path, title and
// body is invented, and the tree pretends to be somebody's home directory so the app
// can show a plausible "This computer" panel.
//
//   node scripts/demo/make-demo.mjs [--out <dir>] [--force]
//
// Default output: <os.tmpdir()>/riffledesk-demo/demo-home
// (the server wants RIFFLEDESK_DEMO=<that dir>; its config/index land in "<dir>.state").
//
// Zero dependencies. PNGs are drawn here with zlib + hand-rolled CRC.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};
const OUT = path.resolve(argOf('--out') || path.join(os.tmpdir(), 'riffledesk-demo', 'demo-home'));
const FORCE = argv.includes('--force');

if (fs.existsSync(OUT)) {
  if (!FORCE) {
    const nonEmpty = fs.readdirSync(OUT).length > 0;
    if (nonEmpty) {
      console.error(`${OUT} already has files — pass --force to overwrite the demo tree`);
      process.exit(1);
    }
  }
  if (FORCE) fs.rmSync(OUT, { recursive: true, force: true });
}
fs.rmSync(OUT + '.state', { recursive: true, force: true });

const HOME = OUT;                       // the tree IS the fake home
const P = (...parts) => path.join(HOME, ...parts);
const w = (rel, body) => {
  const abs = path.join(HOME, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
};
// a path as it will appear inside fake transcripts (real abs, so the scanner can stat it)
const abs = (...parts) => path.join(HOME, ...parts);

const SITE = 'Documents/aurora-labs/website';
const REPORT = 'Documents/aurora-labs/reports';
const SRC = 'Documents/aurora-labs/src';

// ---------------------------------------------------------------- tiny PNG encoder
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
// painter = (x, y) => [r,g,b]; 24-bit RGB, no interlace
function png(width, height, painter) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = painter(x, y);
      raw[o++] = r; raw[o++] = g; raw[o++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// deterministic pseudo-random so reruns look the same
let seed = 20261030;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

// ---------------------------------------------------------------- images
const BLUE = [42, 78, 132], SAND = [222, 202, 168], CREAM = [247, 242, 232];

function coverImage() { // 800x450 banner: soft diagonal bands + a "logo" mark
  return png(800, 450, (x, y) => {
    const t = (x / 800) * 0.6 + (y / 450) * 0.4;
    const band = Math.sin(t * 9 + rnd() * 0.02) > 0.55 ? 22 : 0;
    const cx = 400, cy = 210, d = Math.hypot(x - cx, y - cy);
    if (d < 78 && d > 52) return [CREAM[0] - band, CREAM[1] - band, CREAM[2] - band];
    if (d <= 52) return [BLUE[0] + band, BLUE[1] + band, BLUE[2] + band];
    return [
      BLUE[0] + t * 60 + band,
      BLUE[1] + t * 48 + band,
      BLUE[2] + t * 30 + band
    ];
  });
}

function chartImage() { // 640x340 report chart: grid, two series
  const vals = [12, 18, 15, 26, 31, 29, 38, 44, 41, 52];
  const series2 = [9, 11, 14, 17, 19, 22, 24, 27, 30, 33];
  const base = 300, top = 40, left = 56, right = 600;
  const colX = i => left + (i * (right - left)) / (vals.length - 1);
  const yOf = v => base - ((base - top) * v) / 56;
  return png(640, 340, (x, y) => {
    if (x === 0 || y === 0) return [250, 248, 244];
    if (x < left || x > right + 20 || y < 20 || y > base + 10) return CREAM;
    if ((y - top) % 52 === 0) return [232, 226, 214];
    for (let i = 0; i < vals.length; i++) {
      const x0 = colX(i);
      if (Math.abs(x - x0) < 12) {
        const yTop = yOf(vals[i]);
        if (y >= yTop && y <= base) return [BLUE[0], BLUE[1], BLUE[2]];
      }
      const y2 = yOf(series2[i]);
      if (Math.abs(y - y2) < 3 && x >= left && x <= right) return [196, 120, 74];
    }
    return CREAM;
  });
}

function avatarImage() { // 320x320 portrait-ish blob
  return png(320, 320, (x, y) => {
    const d = Math.hypot(x - 160, y - 150);
    if (y > 230 && y < 300 && Math.abs(x - 160) < 92) return SAND;
    if (d < 74) return [SAND[0] - 18, SAND[1] - 14, SAND[2] - 10];
    return [BLUE[0] + 26, BLUE[1] + 22, BLUE[2] + 16];
  });
}

// ---------------------------------------------------------------- markdown reports
w(`${REPORT}/q3-rollout-notes.md`, `# Q3 rollout notes

Working notes for the pricing page rollout. Written by the assistant during the
Thursday working session, cleaned up afterwards.

## What changed

- The pricing table now has a monthly/yearly toggle (defaults to monthly).
- The "compare plans" block moved above the FAQ — 18 testers, 14 preferred it.
- Copy on the starter tier was rewritten; it no longer says "unlimited" (it is 5 seats).

## What is still open

1. The yearly price labels need finance sign-off before the announcement.
2. Screenshots in the help centre still show the old table.
3. The FAQ answer on seat changes assumes the old wording.

## Numbers we used

| Tier | Seats | Monthly | Yearly |
|---|---|---|---|
| Starter | 5 | 19 | 190 |
| Studio | 20 | 59 | 590 |
| Scale | 50 | 129 | 1290 |

Prices are placeholder values from the workshop, not the final sheet.
`);

w(`${REPORT}/onboarding-audit.md`, `# Onboarding audit

Every new account was walked through sign-up by two of us, twice, on a clean browser
profile. The point was to count the places where someone can get stuck.

## Findings

- **Step 2 (workspace name)** — no example, and the hint appears after an error only.
- **Step 3 (invite)** — "skip" is the same weight as "invite"; most testers skipped.
- **Step 5 (first project)** — the template picker loads 800 ms late on a cold cache.
- **Step 7 (done)** — the confirmation is a toast that disappears in 1.8 s, so people
  were not sure the account existed.

## Suggested order

Fix step 7 first (cheap, big confidence win), then step 2 (one line of copy and an
example value), then step 5 (prefetch on step 4). Step 3 needs a design decision.

## Coverage

7 new accounts, 2 browsers, desktop and one phone. No data was kept from the testers.
`);

w(`${REPORT}/release-notes-0-9.md`, `# Release notes — 0.9 "Driftwood"

## Added

- Monthly/yearly toggle on the pricing table.
- Changelog page with an RSS feed.
- Compare-plans block, moved above the FAQ.

## Fixed

- Seat counter rounded down after a downgrade.
- "Contact sales" opened a blank tab when the mail client was missing.
- Long plan names wrapped under the icon on narrow screens.

## Known

- The yearly labels are still hard-coded; finance sign-off pending.
- Safari < 16 renders the toggle 2 px off-centre.
`);

w('Documents/aurora-labs/handbook.md', `# Team handbook (fragment)

Small company, short rules.

- **Writing** — decisions go in \`reports/\`, one file per topic, dated in the filename.
- **Reviews** — one reviewer is enough for copy, two for anything with prices.
- **Deploying** — Fridays before 15:00 only. After that, Monday.
- **Naming** — files are lower-case, hyphenated, no spaces.

The rest of the handbook lives in the shared drive; this fragment is the part the
engineering side actually needs.
`);

// ---------------------------------------------------------------- site (revise-mode target)
const SITE_CSS = `
  :root { --ink:#23201c; --dim:#6d655b; --line:#ddd2bd; --card:#fffcf5; --accent:#2f5d8a; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.65 ui-sans-serif, system-ui, sans-serif; color: var(--ink);
         background: #f6f2e8; }
  header { display:flex; align-items:center; gap:14px; padding:18px 28px; border-bottom:1px solid var(--line); }
  .mark { width:26px; height:26px; border-radius:50%; background:var(--accent); }
  nav { margin-left:auto; display:flex; gap:18px; font-size:14px; }
  nav a { color:var(--dim); text-decoration:none; }
  main { max-width: 860px; margin: 0 auto; padding: 40px 28px 80px; }
  h1 { font-size: 40px; line-height:1.15; margin: 0 0 14px; letter-spacing:-.5px; }
  p.lede { font-size: 19px; color: var(--dim); margin: 0 0 34px; max-width: 620px; }
  .plans { display:grid; grid-template-columns: repeat(3, 1fr); gap:16px; }
  .plan { border:1px solid var(--line); background:var(--card); border-radius:12px; padding:20px; }
  .plan h2 { font-size:17px; margin:0 0 6px; }
  .plan .price { font-size:28px; font-weight:650; margin:10px 0 2px; }
  .plan .per { font-size:13px; color:var(--dim); }
  .plan ul { margin:14px 0 18px; padding-left:18px; font-size:14px; color:var(--dim); }
  .plan button { width:100%; padding:10px 14px; border-radius:9px; border:1px solid var(--accent);
                 background:transparent; color:var(--accent); font:600 14px inherit; }
  .plan.hot { border-color: var(--accent); }
  .plan.hot button { background: var(--accent); color:#fff; }
  .toggle { display:inline-flex; border:1px solid var(--line); border-radius:999px; padding:3px;
            margin: 0 0 26px; }
  .toggle button { border:0; background:transparent; padding:7px 16px; border-radius:999px;
                   font:600 13px inherit; color:var(--dim); }
  .toggle button.on { background:var(--ink); color:#fff; }
  footer { border-top:1px solid var(--line); padding:22px 28px; font-size:13px; color:var(--dim); }
`;

w(`${SITE}/pricing.html`, `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Plans — Aurora Labs</title>
<link rel="stylesheet" href="site.css">
</head>
<body>
<header>
  <span class="mark"></span>
  <strong>Aurora Labs</strong>
  <nav><a href="index.html">Product</a><a href="pricing.html">Plans</a><a href="changelog.html">Changelog</a></nav>
</header>
<main>
  <h1>Pick a plan</h1>
  <p class="lede">Every plan starts with a 14-day trial. Change or stop whenever you like.</p>

  <div class="toggle">
    <button class="on">Monthly</button>
    <button>Yearly — save two months</button>
  </div>

  <div class="plans">
    <section class="plan">
      <h2>Starter</h2>
      <div class="price">$19</div>
      <div class="per">per month</div>
      <ul><li>5 seats</li><li>5 projects</li><li>Community support</li></ul>
      <button>Start free</button>
    </section>
    <section class="plan hot">
      <h2>Studio</h2>
      <div class="price">$59</div>
      <div class="per">per month</div>
      <ul><li>20 seats</li><li>Unlimited projects</li><li>Email support</li></ul>
      <button>Start free</button>
    </section>
    <section class="plan">
      <h2>Scale</h2>
      <div class="price">$129</div>
      <div class="per">per month</div>
      <ul><li>50 seats</li><li>Unlimited projects</li><li>Priority support</li></ul>
      <button>Talk to us</button>
    </section>
  </div>
</main>
<footer>© Aurora Labs. Prices in USD, taxes excluded.</footer>
</body>
</html>
`);

w(`${SITE}/site.css`, SITE_CSS);

w(`${SITE}/index.html`, `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Aurora Labs — a calmer project board</title>
<link rel="stylesheet" href="site.css">
</head>
<body>
<header>
  <span class="mark"></span>
  <strong>Aurora Labs</strong>
  <nav><a href="index.html">Product</a><a href="pricing.html">Plans</a><a href="changelog.html">Changelog</a></nav>
</header>
<main>
  <h1>A calmer project board</h1>
  <p class="lede">Three columns, no pings. Work stays where the team put it.</p>
  <p>Built by four people who kept losing the thread in chat apps. Aurora keeps boards
     small on purpose: one screen, no nesting, no bot notifications after 18:00.</p>
</main>
<footer>© Aurora Labs.</footer>
</body>
</html>
`);

w(`${SITE}/changelog.html`, `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Changelog — Aurora Labs</title>
<link rel="stylesheet" href="site.css">
</head>
<body>
<header>
  <span class="mark"></span>
  <strong>Aurora Labs</strong>
  <nav><a href="index.html">Product</a><a href="pricing.html">Plans</a><a href="changelog.html">Changelog</a></nav>
</header>
<main>
  <h1>Changelog</h1>
  <p class="lede">Small changes, written down as they ship.</p>
  <h2>0.9 — Driftwood</h2>
  <p>Monthly/yearly pricing toggle, a proper changelog, compare-plans block.</p>
  <h2>0.8 — Terracotta</h2>
  <p>Seat counter fix, narrower cards, better empty states.</p>
</main>
<footer>© Aurora Labs.</footer>
</body>
</html>
`);

// ---------------------------------------------------------------- source + data
w(`${SRC}/pricing.js`, `// Plan toggle + seat counter for the pricing page. No framework on purpose:
// the whole page is under 8 KB and should stay that way.
const PLANS = [
  { id: 'starter', seats: 5, monthly: 19, yearly: 190 },
  { id: 'studio', seats: 20, monthly: 59, yearly: 590 },
  { id: 'scale', seats: 50, monthly: 129, yearly: 1290 }
];

let yearly = false;

export function priceFor(planId) {
  const plan = PLANS.find(p => p.id === planId);
  if (!plan) throw new Error('unknown plan: ' + planId);
  return yearly ? plan.yearly / 12 : plan.monthly;
}

export function renderPrices(root) {
  for (const plan of PLANS) {
    const cell = root.querySelector('[data-price="' + plan.id + '"]');
    if (cell) cell.textContent = '$' + priceFor(plan.id).toFixed(0);
  }
}

export function setYearly(on, root) {
  yearly = !!on;
  root.querySelectorAll('.toggle button').forEach((b, i) => b.classList.toggle('on', (i === 1) === yearly));
  renderPrices(root);
}

export function seatsLeft(used, planId) {
  const plan = PLANS.find(p => p.id === planId);
  return plan ? Math.max(0, plan.seats - used) : 0;
}
`);

w(`${SRC}/seat_audit.py`, `"""Count how many seats each account is using.

Run against a CSV export of accounts; prints one line per account over its plan
limit. Read-only: nothing is written back to the billing system.
"""
import csv
import sys
from collections import Counter

LIMITS = {"starter": 5, "studio": 20, "scale": 50}


def load(path):
    with open(path, newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            yield row["account"], row["plan"], row["member"]


def main(path):
    used = Counter()
    plan_of = {}
    for account, plan, member in load(path):
        plan_of[account] = plan
        used[account] += 1
    over = 0
    for account, n in used.items():
        limit = LIMITS.get(plan_of[account], 0)
        if n > limit:
            over += 1
            print(f"{account}: {n} seats on {plan_of[account]} (limit {limit})")
    print(f"-- {over} account(s) over the limit", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1])
`);

w(`${SRC}/deploy.sh`, `#!/bin/sh
# Deploy the marketing site. Static files only — safe to rerun.
set -eu
BRANCH=$(git rev-parse --abbrev-ref HEAD)
[ "$BRANCH" = "main" ] || { echo "deploy from main, not $BRANCH"; exit 1; }
npm run build
rsync -a --delete dist/ deploy@static.aurora-labs.example:/srv/site/
echo "deployed $(git rev-parse --short HEAD)"
`);

w('Documents/aurora-labs/data/plans.json', JSON.stringify({
  updated: '2026-10-02',
  currency: 'USD',
  plans: [
    { id: 'starter', seats: 5, monthly: 19, yearly: 190, features: ['5 projects', 'community support'] },
    { id: 'studio', seats: 20, monthly: 59, yearly: 590, features: ['unlimited projects', 'email support'] },
    { id: 'scale', seats: 50, monthly: 129, yearly: 1290, features: ['unlimited projects', 'priority support'] }
  ],
  note: 'Yearly figures need finance sign-off before they go live.'
}, null, 2) + '\n');

w('Documents/aurora-labs/data/accounts.csv',
  'account,plan,member,joined\n' +
  'northwind,studio,ada,2026-03-04\n' +
  'northwind,studio,bo,2026-03-04\n' +
  'northwind,studio,cy,2026-05-19\n' +
  'harbourlight,starter,dee,2026-07-22\n' +
  'harbourlight,starter,eli,2026-07-22\n' +
  'harbourlight,starter,finn,2026-08-01\n' +
  'harbourlight,starter,gus,2026-08-01\n' +
  'harbourlight,starter,hal,2026-09-13\n' +
  'harbourlight,starter,ivy,2026-09-14\n' +
  'quay,scale,jon,2026-01-09\n');

w('Documents/aurora-labs/data/visits.csv',
  'week,page,visits\n' +
  '2026-W38,pricing,1840\n' +
  '2026-W38,index,6120\n' +
  '2026-W39,pricing,2110\n' +
  '2026-W39,index,5990\n' +
  '2026-W40,pricing,2650\n' +
  '2026-W40,index,6410\n');

w('Documents/aurora-labs/.gitignore', 'dist/\nnode_modules/\n*.log\n.env\n');

// images
{
  const a = path.join(HOME, 'Documents/aurora-labs/assets');
  fs.mkdirSync(a, { recursive: true });
  fs.writeFileSync(path.join(a, 'cover.png'), coverImage());
  fs.writeFileSync(path.join(a, 'signups.png'), chartImage());
  fs.writeFileSync(path.join(a, 'team.png'), avatarImage());
  fs.writeFileSync(path.join(a, 'notes.txt'), 'Cover: 800x450, used on the landing page hero.\nChart: weekly sign-ups, 10 weeks.\nTeam: placeholder portrait, replace before launch.\n');
}

w('Documents/aurora-labs/CLAUDE.md', `# Working with an assistant here

- Keep report files in \`reports/\`, one topic per file.
- The site is static; open a page and use "✎" (revamp) instead of describing edits in chat.
- Prices in copy must match \`data/plans.json\`.
`);

w('README.md', `# aurora-labs workspace

Loose notes and the marketing site for a fictional project board.

- \`Documents/aurora-labs/website/\` — static pages (open \`pricing.html\` to see the plans)
- \`Documents/aurora-labs/reports/\` — working notes
- \`Documents/aurora-labs/data/\` — exported tables
`);

// ---------------------------------------------------------------- fake AI transcripts
// Shapes matter here: the scanner only reads tool_use Write/Edit blocks, so these are
// ordinary Claude Code session lines. All timestamps stay inside the last weeks.
const PROJECT_SLUG = '-Users-demo-Documents-aurora-labs';
const now = Date.now();
const iso = (minAgo) => new Date(now - minAgo * 60000).toISOString();

function claudeSession(id, title, writes, startMinAgo) {
  const lines = [];
  let m = startMinAgo;
  lines.push(JSON.stringify({ type: 'user', sessionId: id, cwd: abs('Documents/aurora-labs'), message: { role: 'user', content: title }, timestamp: iso(m) }));
  for (const file of writes) {
    m -= 4;
    lines.push(JSON.stringify({
      type: 'assistant', sessionId: id, cwd: abs('Documents/aurora-labs'), timestamp: iso(m),
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Writing the file now.' },
          { type: 'tool_use', id: 'tu_' + Math.random().toString(36).slice(2, 10), name: 'Write', input: { file_path: file } }
        ]
      }
    }));
  }
  return lines.join('\n') + '\n';
}

const slugDir = P('.claude', 'projects', PROJECT_SLUG);
fs.mkdirSync(slugDir, { recursive: true });
fs.writeFileSync(path.join(slugDir, 'b1f4c2aa-5d31-4a7e-9b0c-demodemodemo1.jsonl'),
  claudeSession('b1f4c2aa-5d31-4a7e-9b0c-demodemodemo1', 'Draft the rollout notes from our workshop', [
    abs(REPORT, 'q3-rollout-notes.md'),
    abs(REPORT, 'release-notes-0-9.md')
  ], 210));
fs.writeFileSync(path.join(slugDir, 'c7a90d13-88e2-4b6f-a2f1-demodemodemo2.jsonl'),
  claudeSession('c7a90d13-88e2-4b6f-a2f1-demodemodemo2', 'Audit onboarding and write findings up', [
    abs(REPORT, 'onboarding-audit.md')
  ], 1440));
fs.writeFileSync(path.join(slugDir, 'd2e61b40-11c8-42f9-8d55-demodemodemo3.jsonl'),
  claudeSession('d2e61b40-11c8-42f9-8d55-demodemodemo3', 'Split the seat counter out of the page and add tests', [
    abs(SRC, 'pricing.js'),
    abs(SRC, 'seat_audit.py')
  ], 330));

// one Codex-shaped session (different accent in the conversation list)
{
  const d = P('.codex', 'sessions', '2026', '10', '28');
  fs.mkdirSync(d, { recursive: true });
  const cwd = abs('Documents', 'aurora-labs');
  const rows = [
    { type: 'session_meta', timestamp: iso(2600), payload: { id: 'codex-9f21', cwd } },
    { type: 'response_item', timestamp: iso(2598), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Tidy the weekly visit export' }] } },
    {
      type: 'response_item', timestamp: iso(2596),
      payload: {
        type: 'function_call', name: 'apply_patch',
        arguments: JSON.stringify({ patch:
          '*** Add File: ' + abs('Documents/aurora-labs/data/visits.csv') + '\n' +
          '+week,page,visits\n+2026-W38,pricing,1840\n+2026-W38,index,6120\n' })
      }
    },
    { type: 'response_item', timestamp: iso(2595), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Added the export as data/visits.csv.' }] } }
  ];
  fs.writeFileSync(path.join(d, 'rollout-2026-10-28T09-00-00-9f21.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

// touch mtimes so "newest first" ordering and the "recent" view look deliberate
const ages = [
  ['Documents/aurora-labs/reports/q3-rollout-notes.md', 30],
  ['Documents/aurora-labs/website/pricing.html', 90],
  ['Documents/aurora-labs/src/pricing.js', 120],
  ['Documents/aurora-labs/reports/onboarding-audit.md', 600],
  ['Documents/aurora-labs/data/visits.csv', 700],
  ['Documents/aurora-labs/data/accounts.csv', 800],
  ['Documents/aurora-labs/src/seat_audit.py', 900],
  ['Documents/aurora-labs/website/changelog.html', 1000],
  ['Documents/aurora-labs/handbook.md', 1600],
  ['README.md', 2000]
];
for (const [rel, minAgo] of ages) {
  try { fs.utimesSync(path.join(HOME, rel), new Date(now - minAgo * 60000), new Date(now - minAgo * 60000)); } catch (_) {}
}

// count what we made
let files = 0;
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) walk(path.join(dir, e.name));
    else files++;
  }
})(HOME);

console.log(`demo tree: ${HOME}`);
console.log(`${files} files`);
console.log(`run with: RIFFLEDESK_DEMO="${HOME}" node server.js 5197`);

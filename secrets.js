// secrets.js — detect likely API keys / passwords in text files (pure functions,
// shared by server.js and indexer-worker.js; tests import it too).
// Output of scanText() contains the RAW matched values in `value` — callers must
// mask with maskValue() before any display, and must NEVER log/print/send raw values.
'use strict';

// structural token shapes (high confidence; matched verbatim)
const RULES = [
  // OpenAI sk-… (incl. sk-proj-/sk-svcacct-) and Anthropic sk-ant-…
  { kind: 'apikey', re: /\bsk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'aws', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'github', re: /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}\b/g },
  { kind: 'github', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { kind: 'google', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'slack', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}/g },
  { kind: 'privatekey', re: /-----BEGIN [A-Z0-9 ]{0,24}PRIVATE KEY(?: BLOCK)?-----/g }
];

// contextual shapes (need the value captured + placeholder filtering)
const GENERIC_RULES = [
  { kind: 'password', re: /\bpassword[ \t]*[:=][ \t]*["'`]?([^\s"'`]{6,})/gi },
  { kind: 'apikey', re: /\bapi[-_]?key[ \t]*[:=][ \t]*["'`]?([^\s"'`]{6,})/gi }
];

// strip surrounding quotes and trailing punctuation from a captured value
// (incl. CJK sentence punctuation, so `api_key = <your-key>。` still reads
// as a placeholder and real values keep their interior characters)
function cleanValue(v) {
  return v.replace(/^["'`]+/, '').replace(/["'`),.\];:}。；，、：！？）》】」』]+$/u, '');
}

// obvious documentation placeholders must not trigger the generic rules
// (keeping false positives low is the point — e.g. `password = xxxxxx`)
function looksPlaceholder(v0) {
  const v = cleanValue(v0);
  if (v.length < 6) return true;
  const low = v.toLowerCase();
  if (/^(.)\1{5,}$/.test(low)) return true;              // aaaaaa, 111111
  if (/^(?:x+|\*+|\.+|-+|_+)$/.test(low)) return true;    // xxxxxx, ******
  if (/^<[^>]*>$/.test(low)) return true;                // <your-key>
  const WORD = /^(?:your|example|changeme|change[ _-]?me|change[ _-]?this|insert|put[ _-]|replace[ _-]|here[ _-]|password|passwd|secret|api[ _-]?key|test\b|dummy|sample|placeholder|none$|null$|undefined$|n\/a$|todo$|tbd$|foo|bar\b|real[ _-]|fake[ _-]|mock[ _-]|not[ _-]?set|unset$|forgot|enter|please|required|type[ _-])/i;
  return WORD.test(low);
}

// mask for display: NEVER more than the first 4 characters, and never more
// than a third of the value — short secrets show almost nothing so the mask
// itself cannot leak a short token (never log or send more than this)
function maskValue(v) {
  const x = String(v);
  const show = Math.min(4, Math.floor(x.length / 3));
  if (show <= 0) return '••••••••';
  return x.slice(0, show) + '••••••••';
}

// scan text (already truncated to the file's first 64 KB by callers) and return
// matches sorted by position: [{ line, kind, value }] — 1-based line numbers,
// one entry per (line, value) at most (a generic rule and a structural rule
// hitting the same token report once).
function scanText(text) {
  if (!text) return [];
  // 1-based line lookup from char index
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  const lineOf = idx => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= idx) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };

  const out = [];
  const seen = new Set(); // `${line}:${value}` dedupe
  const push = (idx, kind, value) => {
    const line = lineOf(idx);
    const k = line + ':' + value;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ line, kind, value });
  };
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text))) {
      if (m[0].length > 512) continue; // pathological runaway guard
      push(m.index, rule.kind, m[0]);
      if (out.length > 200) return finalize();
    }
  }
  for (const rule of GENERIC_RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text))) {
      const value = cleanValue(m[1]);
      if (value.length < 6) continue;
      if (looksPlaceholder(m[1])) continue;
      push(m.index, rule.kind, value);
      if (out.length > 200) return finalize();
    }
  }
  function finalize() { out.sort((a, b) => a.line - b.line); return out; }
  return finalize();
}

function hasSecrets(text) { return scanText(text).length > 0; }

// printer-text sniff (same rule as indexer-worker.looksBinary): NUL or a high
// control-char density in the head bytes means this is not scannable text
function looksBinary(buf) {
  const n = Math.min(buf.length, 4096);
  if (n === 0) return false;
  let weird = 0;
  for (let i = 0; i < n; i++) {
    const c = buf[i];
    if (c === 0) return true;
    if (c < 9 || (c > 13 && c < 32)) weird++;
  }
  return weird / n > 0.05;
}

// config.secretScanSkipDirs holds plain directory NAMES; a file "under" one of
// them (any path segment matches, case-insensitive) is not secret-scanned.
function anySegmentSkipped(pathStr, names) {
  if (!Array.isArray(names) || !names.length) return false;
  const parts = String(pathStr).toLowerCase().split(/[\\/]+/);
  for (const n of names) {
    const ln = String(n).toLowerCase();
    if (!ln) continue;
    if (parts.includes(ln)) return true;
  }
  return false;
}

module.exports = { scanText, hasSecrets, maskValue, looksBinary, anySegmentSkipped };

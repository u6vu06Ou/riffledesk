// tests/chrome-path.mjs — one shared way for every e2e script to find a
// Chrome-family executable, on any OS.
//
// Resolution order:
//   1. CHROME_PATH (or the older CHROME) env var — exact path wins, always.
//   2. Platform defaults:
//      win32 : Chrome / Edge in Program Files, Program Files (x86), %LOCALAPPDATA%
//      darwin: /Applications/… Chrome, Chromium, Edge .app bundles
//      linux : google-chrome / chromium / chromium-browser / microsoft-edge on PATH
//   3. A clear error saying what was tried (instead of ENOENT deep inside a launch).
//
// extensionChrome(): like chromeExecutable() but prefers a playwright-bundled
// Chromium from the local ms-playwright cache, because branded Chrome in headless
// mode does not load extensions. Point CHROME_PATH at a branded Chrome to override.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function fromPathEnv(names) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const canExec = process.platform === 'win32'
    ? (p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } }
    : (p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch (_) { return false; } };
  for (const dir of dirs) {
    for (const name of names) {
      const p = path.join(dir, name);
      if (canExec(p)) return p;
    }
  }
  return null;
}

function firstExisting(candidates) {
  for (const p of candidates) {
    try { if (p && fs.statSync(p).isFile()) return p; } catch (_) {}
  }
  return null;
}

function platformCandidates() {
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pfx = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const lad = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const out = [];
    for (const base of [pf, pfx, lad]) {
      out.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      out.push(path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
    return out;
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    ];
  }
  // linux and friends: PATH lookup with the usual binary names first
  const onPath = fromPathEnv(['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']);
  return onPath ? [onPath] : [];
}

export function chromeExecutable() {
  const env = process.env.CHROME_PATH || process.env.CHROME;
  if (env) return env;
  const found = firstExisting(platformCandidates());
  if (found) return found;
  throw new Error(
    'no Chrome/Chromium/Edge found (tried $CHROME_PATH plus the platform defaults — ' +
    'see tests/chrome-path.mjs). Set CHROME_PATH to your browser executable.');
}

// Descend into a playwright browsers cache and return the newest bundled chromium.
function playwrightChromium() {
  const caches = process.platform === 'win32'
    ? [path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright')]
    : process.platform === 'darwin'
      ? [path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')]
      : [path.join(os.homedir(), '.cache', 'ms-playwright')];
  for (const cache of caches) {
    let names;
    try { names = fs.readdirSync(cache); } catch (_) { continue; }
    const versions = names
      .filter(n => /^chromium-\d+$/.test(n))
      .map(n => ({ n, v: Number(n.split('-')[1]) }))
      .sort((a, b) => b.v - a.v);
    for (const { n } of versions) {
      const hits = process.platform === 'win32'
        ? [path.join(cache, n, 'chrome-win64', 'chrome.exe'), path.join(cache, n, 'chrome-win', 'chrome.exe')]
        : process.platform === 'darwin'
          ? [path.join(cache, n, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
             path.join(cache, n, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'chrome')]
          : [path.join(cache, n, 'chrome-linux', 'chrome')];
      const hit = firstExisting(hits);
      if (hit) return hit;
    }
  }
  return null;
}

export function extensionChrome() {
  if (process.env.CHROME_PATH || process.env.CHROME) return chromeExecutable();
  return playwrightChromium() || chromeExecutable();
}

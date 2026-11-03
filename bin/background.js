'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const logFileFor = port => path.join(os.tmpdir(), `riffledesk-server-${port}.log`);

// No inherited console, input, or pipes: the launching shell may exit immediately.
function startBackground(port, previousPid = null) {
  const logPath = logFileFor(port);
  let fd;
  try { if (fs.statSync(logPath).size > 2 * 1024 * 1024) fs.rmSync(logPath); } catch (_) {}
  try { fd = fs.openSync(logPath, 'a'); } catch (_) { fd = 'ignore'; }
  const args = previousPid
    ? [__filename, String(port), String(previousPid)]
    : [path.join(ROOT, 'server.js'), String(port)];
  const child = spawn(process.execPath, args, {
    cwd: ROOT, detached: true, windowsHide: true,
    stdio: ['ignore', fd, fd], env: { ...process.env, PORT: String(port) }
  });
  child.on('error', err => console.error(`riffledesk: background start failed: ${err.message}`));
  child.unref();
  if (typeof fd === 'number') fs.closeSync(fd);
  return logPath;
}

// Restart must wait for the old process (including its index worker) to exit.
if (require.main === module) {
  (async () => {
    const port = Number(process.argv[2]), previousPid = Number(process.argv[3]);
    const deadline = Date.now() + 15000;
    while (true) {
      try { process.kill(previousPid, 0); }
      catch (err) { if (err.code === 'ESRCH') break; throw err; }
      if (Date.now() > deadline) throw new Error('previous server did not exit');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    startBackground(port);
  })().catch(err => { console.error(err.message); process.exitCode = 1; });
}

module.exports = { startBackground, logFileFor };

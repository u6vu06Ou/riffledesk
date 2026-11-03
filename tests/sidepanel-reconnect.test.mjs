import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');

async function panel(available = true) {
  const nodes = Object.fromEntries(['frame', 'down', 'connection', 'retry'].map(id => [id, {
    src: '', style: {}, hidden: true, handlers: {}, contentWindow: { postMessage() {} },
    addEventListener(name, fn) { this.handlers[name] = fn; }
  }]));
  const listeners = {};
  const state = { available, probes: 0 };
  const context = vm.createContext({
    document: { getElementById: id => nodes[id] }, location: { search: '' },
    chrome: {
      runtime: { onMessage: { addListener() {} }, connect: () => ({ onDisconnect: { addListener() {} }, postMessage() {} }) },
      storage: { local: { get: async () => ({ port: 5177 }) }, session: { get: async () => ({ panelFocus: null }) },
        onChanged: { addListener: fn => { listeners.storage = fn; } } }
    },
    fetch: async () => { state.probes++; if (!state.available) throw new Error('timeout'); return { ok: true }; },
    AbortSignal, Date, URLSearchParams, setTimeout: () => 1, clearTimeout() {}, addEventListener() {}
  });
  vm.runInContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  return { nodes, state, listeners, tick: () => vm.runInContext('tick()', context) };
}

test('loaded panel survives repeated failed health probes and recovery without navigating', async () => {
  const p = await panel();
  const src = p.nodes.frame.src;
  assert.match(src, /mode=panel/);
  p.nodes.frame.handlers.load();
  p.state.available = false;
  for (let i = 0; i < 3; i++) await p.tick();
  assert.equal(p.nodes.frame.src, src);
  assert.equal(p.nodes.frame.style.display, 'block');
  assert.equal(p.nodes.down.style.display, 'none');
  assert.equal(p.nodes.connection.hidden, false);
  p.state.available = true;
  await p.tick();
  assert.equal(p.nodes.frame.src, src);
  assert.equal(p.nodes.connection.hidden, true);
});

test('initially offline panel still loads when server becomes available', async () => {
  const p = await panel(false);
  assert.equal(p.nodes.down.style.display, 'block');
  assert.equal(p.nodes.frame.src, '');
  p.state.available = true;
  await p.tick();
  assert.match(p.nodes.frame.src, /mode=panel/);
  assert.equal(p.nodes.frame.style.display, 'block');
});

test('explicit port change still replaces the old iframe', async () => {
  const p = await panel();
  p.nodes.frame.handlers.load();
  p.listeners.storage({ port: { newValue: 5180 } }, 'local');
  await new Promise(resolve => setImmediate(resolve));
  assert.match(p.nodes.frame.src, /^http:\/\/127\.0\.0\.1:5180\//);
});

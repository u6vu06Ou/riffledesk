// Shared constants. Loaded with importScripts() by background.js (MV3 classic
// service worker) and with a plain <script src> tag by options.html — keep it
// dependency-free and side-effect-free.
// 掛 globalThis 而非頂層 const：背景對既開分頁補種（executeScript）時本檔會在
// 同個 isolated world 再跑一次，頂層 const 重複宣告會整段 SyntaxError。
globalThis.RIFFLE_DEFAULT_PORT = globalThis.RIFFLE_DEFAULT_PORT ?? 5177;

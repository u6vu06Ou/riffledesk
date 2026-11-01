// RiffleDesk service worker — 存在的唯一理由是讓 Chrome 允許「安裝成 App」（PWA 要件之一）。
// 刻意不快取任何東西：伺服器是本機的、頁面資源自帶 no-cache 語意，
// 一快取就會有「舊卡片／舊資料在離線時冒出來」這種我們不想要的行為。
// fetch handler 不做任何事（不呼叫 respondWith）→ 請求原樣走網路，純粹是裝飾性註冊。
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', () => { /* pass-through: never intercept */ });

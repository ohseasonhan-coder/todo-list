// to do list 서비스워커 — 오프라인 캐시 + 알림 버튼 처리
const CACHE = 'todo-v8';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 앱 파일은 네트워크 우선(최신 반영), 실패하면 캐시. 외부 폰트는 캐시 우선.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('./index.html'))),
    );
  } else if (url.hostname === 'cdn.jsdelivr.net') {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })),
    );
  }
});

// 서버 푸시 수신 → 알림 표시 (iOS 잠금화면 포함)
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { notification: { title: 'to do list', body: e.data ? e.data.text() : '' } }; }
  const n = data.notification || data;
  const id = data.id || n.tag;
  e.waitUntil(self.registration.showNotification(n.title || 'to do list', {
    body: n.body || '',
    tag: n.tag || id,
    renotify: true,
    requireInteraction: true,
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    // __test__, __brief__ 같은 시스템 알림은 완료/미루기 버튼 없음
    data: { id: id && !id.startsWith('__') ? id : null },
    actions: id && !id.startsWith('__') ? [{ action: 'done', title: '완료' }, { action: 'snooze', title: '10분 뒤' }] : [],
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const id = e.notification.data && e.notification.data.id;
  const action = e.action || 'open';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (all.length) {
      const client = all[0];
      if (id) client.postMessage({ type: action, id });
      if (action === 'open' && 'focus' in client) await client.focus().catch(() => {});
      return;
    }
    const q = id ? `?action=${encodeURIComponent(action)}&id=${encodeURIComponent(id)}` : '';
    await self.clients.openWindow(`./${q}`);
  })());
});

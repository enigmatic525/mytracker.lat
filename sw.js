// Self-destructing service worker.
// The previous version cached index.html/script.js/style.css aggressively,
// which served stale files during development. This version installs, purges
// every cache, unregisters itself, and reloads open tabs so the browser goes
// straight to the network from now on. There is intentionally no fetch handler.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
        await self.registration.unregister();
        const clients = await self.clients.matchAll({ type: 'window' });
        clients.forEach((client) => client.navigate(client.url));
    })());
});

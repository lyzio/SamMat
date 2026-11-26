// SamMat service worker: makes the site installable as an app.
// Always goes to the network (orders and rounds must be live); only shows a small page when offline.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(() => new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<body style="background:#1e272e;color:#f1f2f6;font-family:system-ui;padding:40px;text-align:center">' +
    '<h1 style="color:#f53b57">SamMat</h1><p>Ingen anslutning just nu. Försök igen om en stund.</p></body>',
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
});

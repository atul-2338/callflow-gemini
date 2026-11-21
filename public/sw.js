/* CallFlow service worker — push alerts + notification click handling */
const FALLBACK = { title: 'CallFlow · Missed plumbing call', body: 'Tap to open your dispatch queue', url: '/app', tag: 'callflow-alert', urgency: 'standard' };

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = { ...FALLBACK };
  if (event.data) {
    try {
      const parsed = event.data.json();
      data = { ...data, ...parsed };
      // Backward compatibility: older payloads used /?lead= or only tag="lead-<id>".
      if (typeof data.url === 'string' && data.url.startsWith('/?lead=')) data.url = '/app' + data.url;
      if ((!data.url || data.url === '/' || data.url === '/app') && /^lead-/.test(String(data.tag || ''))) {
        data.url = '/app?lead=' + encodeURIComponent(String(data.tag).replace(/^lead-/, ''));
      }
    } catch {
      data.body = event.data.text();
    }
  }

  const emergency = data.urgency === 'emergency';
  const options = {
    body: data.body,
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: data.tag || FALLBACK.tag,
    renotify: true,
    requireInteraction: emergency,
    timestamp: Date.now(),
    data: { url: data.url || '/app', urgency: data.urgency || 'standard' },
    actions: [{ action: 'open', title: 'View lead' }],
  };
  if (emergency) options.vibrate = [180, 90, 180];

  event.waitUntil(self.registration.showNotification(data.title || FALLBACK.title, options));
});

async function openTarget(targetUrl) {
  const url = new URL(targetUrl, self.location.origin).href;
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of windows) {
    if (client.url.startsWith(self.location.origin)) {
      if ('navigate' in client) {
        try { await client.navigate(url); } catch { /* fall back to focus only */ }
      }
      if ('focus' in client) return client.focus();
    }
  }
  return self.clients.openWindow ? self.clients.openWindow(url) : undefined;
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/app';
  event.waitUntil(openTarget(targetUrl));
});

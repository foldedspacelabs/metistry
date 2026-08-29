// Metistry PoC-6 service worker.
// Payload-less web push: the push event carries NO encrypted body, so there is
// nothing to decrypt. We just show a fixed local notification.

self.addEventListener('install', (event) => {
  // Take over immediately so the first subscribe attempt has an active worker.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  // event.data is null for a payload-less push. Read it defensively anyway so
  // an encrypted push (future work) does not crash the handler.
  let body = 'Metistry PoC-6 push received';
  try {
    if (event.data) {
      const text = event.data.text();
      if (text) body = text;
    }
  } catch (e) {
    // ignore - fall back to the fixed body
  }

  event.waitUntil(
    self.registration.showNotification('Metistry PoC', {
      body: body,
      icon: '/icon-180.png',
      badge: '/icon-180.png',
      tag: 'metistry-poc6',
      data: { url: '/' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow('/'));
});

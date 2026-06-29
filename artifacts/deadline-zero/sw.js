// DeadlineZero — Service Worker
// Handles push notifications via ServiceWorkerRegistration.showNotification()

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/');
    })
  );
});

self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : {};
  e.waitUntil(
    self.registration.showNotification(data.title || '⏰ DeadlineZero', {
      body: data.body || 'Deadline approaching! Check your tasks.',
      icon: data.icon || '/favicon.svg',
      tag: data.tag || 'dz-notification',
    })
  );
});

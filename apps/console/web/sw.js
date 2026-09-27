// Service worker: push display + notification tap. No offline caching yet —
// the shell is served no-cache while the UI iterates.
//
// There is no fetch handler, so `GET /api/events` (the live-changes stream,
// T7-7) reaches the network untouched. A fetch handler added here (T7-4's
// offline shell) must let it through the same way — never answer it from a
// cache, never hold it: a stream the worker stands in front of is a stream
// the page cannot tell is down, and its polls would never restart.
self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : { title: "Metistry", body: "" };
  event.waitUntil(self.registration.showNotification(data.title, { body: data.body, data: { url: data.url ?? "/" } }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data?.url ?? "/"));
});

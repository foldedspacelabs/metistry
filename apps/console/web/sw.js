// Service worker: push display + notification tap. No offline caching yet —
// the shell is served no-cache while the UI iterates.
self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : { title: "metistry", body: "" };
  event.waitUntil(self.registration.showNotification(data.title, { body: data.body, data: { url: data.url ?? "/" } }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data?.url ?? "/"));
});

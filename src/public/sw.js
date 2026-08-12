/* Service Worker do Monitor Ipiranga — push notifications + cache do shell. */
self.addEventListener("install", (e) => {
	self.skipWaiting();
});

self.addEventListener("activate", (e) => {
	e.waitUntil(self.clients.claim());
});

// Push: mostra a notificação vinda do backend
self.addEventListener("push", (e) => {
	let data = {};
	try {
		data = e.data ? e.data.json() : {};
	} catch {
		data = { title: "Monitor Ipiranga", body: e.data ? e.data.text() : "" };
	}
	const options = {
		body: data.body || "",
		icon: "/icons/icon-192.png",
		badge: "/icons/icon-96.png",
		data: { url: data.url || "/" },
		tag: data.tag || "monitor-ipiranga",
		renotify: true,
		vibrate: [100, 60, 100],
	};
	e.waitUntil(self.registration.showNotification(data.title || "Monitor Ipiranga", options));
});

// Clique na notificação → abre o site
self.addEventListener("notificationclick", (e) => {
	e.notification.close();
	const url = (e.notification.data && e.notification.data.url) || "/";
	e.waitUntil(
		self.clients
			.matchAll({ type: "window", includeUncontrolled: true })
			.then((list) => {
				for (const client of list) {
					if ("focus" in client) return client.focus();
				}
				return self.clients.openWindow(url);
			}),
	);
});

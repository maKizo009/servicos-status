/* Service Worker do Monitor Ipiranga — push notifications + shell offline.
 *
 * POR QUE O HANDLER DE `fetch` É OBRIGATÓRIO AQUI: o Firefox e várias
 * versões/forks do Chromium (inclusive as que rodam em Android antigo) só
 * consideram o site INSTALÁVEL quando o service worker tem um handler de
 * `fetch`. Sem ele o navegador não oferece "Instalar app" no menu — sintoma
 * relatado em 29/09/2026 (instalava no Brave e não no Chrome). O handler também
 * entrega o que este comentário já prometia e não existia: o shell offline.
 *
 * Política de cache, deliberadamente conservadora:
 *  - navegação (HTML): REDE PRIMEIRO — quem está online nunca recebe HTML velho
 *    (a lição da "aba aberta desde o deploy anterior"); o cache é só o fallback
 *    quando a rede falha;
 *  - `/vendor`, `/icons`, `/brand`: cache primeiro (são versionados/imutáveis);
 *  - `/api/*`: NUNCA cacheado — chuva/energia/serviços têm que ser ao vivo.
 */
const VERSAO = "monitor-ipiranga-v3";
const CACHE_SHELL = `${VERSAO}-shell`;
const CACHE_ESTATICOS = `${VERSAO}-estaticos`;
/** Baixado na instalação: sem isto não existe shell offline. */
const SHELL_URLS = [
	"/",
	"/manifest.webmanifest",
	"/icons/icon-192.png",
	"/icons/icon-512.png",
];

self.addEventListener("install", (e) => {
	e.waitUntil(
		(async () => {
			const cache = await caches.open(CACHE_SHELL);
			// allSettled: um arquivo que falhe não impede a instalação do SW.
			await Promise.allSettled(
				SHELL_URLS.map((url) => cache.add(new Request(url, { cache: "reload" }))),
			);
			await self.skipWaiting();
		})(),
	);
});

self.addEventListener("activate", (e) => {
	e.waitUntil(
		(async () => {
			const nomes = await caches.keys();
			await Promise.all(
				nomes.filter((n) => !n.startsWith(VERSAO)).map((n) => caches.delete(n)),
			);
			await self.clients.claim();
		})(),
	);
});

self.addEventListener("fetch", (e) => {
	const req = e.request;
	if (req.method !== "GET") return;
	let url;
	try {
		url = new URL(req.url);
	} catch {
		return;
	}
	// Terceiros (CDN de tiles etc.) e API: passa direto, sem interceptar.
	if (url.origin !== self.location.origin) return;
	if (url.pathname.startsWith("/api/")) return;

	// Navegação: rede primeiro; cache do shell apenas como fallback offline.
	if (req.mode === "navigate") {
		e.respondWith(
			(async () => {
				try {
					const resp = await fetch(req);
					if (resp && resp.ok) {
						const cache = await caches.open(CACHE_SHELL);
						cache.put("/", resp.clone()).catch(() => {});
					}
					return resp;
				} catch {
					const cache = await caches.open(CACHE_SHELL);
					const offline = await cache.match("/");
					return offline ?? Response.error();
				}
			})(),
		);
		return;
	}

	// Estáticos imutáveis (vendor/ícones/marca): cache primeiro.
	if (/^\/(vendor|icons|brand)\//.test(url.pathname)) {
		e.respondWith(
			(async () => {
				const cache = await caches.open(CACHE_ESTATICOS);
				const hit = await cache.match(req);
				if (hit) return hit;
				const resp = await fetch(req);
				if (resp && resp.ok) cache.put(req, resp.clone()).catch(() => {});
				return resp;
			})(),
		);
	}
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

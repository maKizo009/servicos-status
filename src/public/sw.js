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
const CACHE_RADAR = `${VERSAO}-radar-v1`;
const RADAR_MAX_TILES = 250;
const RADAR_MAX_AGE_MS = 6 * 60 * 60 * 1000;
let radarWrites = 0;
let radarMaintenance = Promise.resolve();
let lastRadarCleanup = 0;
const radarFrameTimes = new Map();

function radarFrameToken(url) {
	if (url.origin !== "https://tilecache.rainviewer.com") return null;
	const match = /^\/v2\/radar\/([a-zA-Z0-9_-]+)\/256\/\d+\/\d+\/\d+\/\d+\/[^/]+\.png$/.exec(url.pathname);
	return match ? match[1] : null;
}

async function cleanRadarCache(cache) {
	const keys = await cache.keys();
	const metadata = new Map();
	for (const key of keys) {
		const token = radarFrameToken(new URL(key.url));
		if (!token || metadata.has(token)) continue;
		const meta = await cache.match(new Request(new URL(`/__radar_cache_meta__/${token}`, self.location.origin)));
		metadata.set(token, meta ? Number(await meta.text()) : 0);
	}
	const tiles = keys.filter((key) => radarFrameToken(new URL(key.url)));
	const cutoff = Date.now() - RADAR_MAX_AGE_MS;
	const obsolete = [];
	const remaining = [];
	for (const key of tiles) {
		const token = radarFrameToken(new URL(key.url));
		((metadata.get(token) || 0) < cutoff ? obsolete : remaining).push(key);
	}
	const overflow = remaining.slice(0, Math.max(0, remaining.length - RADAR_MAX_TILES));
	await Promise.all([...obsolete, ...overflow].map((key) => cache.delete(key)));
	const retained = new Set(remaining.slice(overflow.length).map((key) => radarFrameToken(new URL(key.url))));
	for (const token of metadata.keys()) {
		if (!retained.has(token)) {
			radarFrameTimes.delete(token);
			await cache.delete(new Request(new URL(`/__radar_cache_meta__/${token}`, self.location.origin)));
		}
	}
}

function queueRadarMaintenance(task) {
	radarMaintenance = radarMaintenance.then(task, task).catch(() => {});
	return radarMaintenance;
}

function cleanRadarCacheIfDue() {
	if (Date.now() - lastRadarCleanup < 5 * 60 * 1000) return radarMaintenance;
	lastRadarCleanup = Date.now();
	return queueRadarMaintenance(async () => cleanRadarCache(await caches.open(CACHE_RADAR)));
}

function cacheRadarTile(req, resp, token) {
	return queueRadarMaintenance(async () => {
		const cache = await caches.open(CACHE_RADAR);
		const meta = new Request(new URL(`/__radar_cache_meta__/${token}`, self.location.origin));
		const prior = await cache.match(meta);
		const priorTime = prior ? Number(await prior.text()) : 0;
		if (!priorTime || Date.now() - priorTime >= RADAR_MAX_AGE_MS) {
			const now = Date.now();
			await cache.put(meta, new Response(String(now)));
			radarFrameTimes.set(token, now);
		}
		await cache.put(req, resp);
		if (++radarWrites === 1 || radarWrites % 25 === 0) {
			lastRadarCleanup = Date.now();
			await cleanRadarCache(cache);
		}
	});
}
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
	const radarToken = radarFrameToken(url);
	if (radarToken) {
		const operation = (async () => {
			try {
				const cache = await caches.open(CACHE_RADAR);
				const cached = await cache.match(req);
				if (cached) {
					let stored = radarFrameTimes.get(radarToken);
					if (stored === undefined) {
						const meta = await cache.match(new Request(new URL(`/__radar_cache_meta__/${radarToken}`, self.location.origin)));
						stored = meta ? Number(await meta.text()) : 0;
						radarFrameTimes.set(radarToken, stored);
					}
					if (Date.now() - stored < RADAR_MAX_AGE_MS) return { response: cached, write: cleanRadarCacheIfDue() };
				}
			} catch {}
			const resp = await fetch(req);
			const isPng = /^image\/png(?:\s*;|$)/i.test(resp.headers.get("content-type") || "");
			const write = resp.ok && resp.type !== "opaque" && isPng ? cacheRadarTile(req, resp.clone(), radarToken) : null;
			return { response: resp, write };
		})();
		e.respondWith(operation.then((result) => result.response));
		e.waitUntil(operation.then((result) => result.write).catch(() => {}));
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

/**
 * Push Web (PWA) — inscrições + envio de notificações via Web Push API.
 *
 * Fluxo:
 *  - O frontend registra o Service Worker e assina via PushManager com a
 *    chave VAPID pública → POST /api/push/subscribe (salvo no Turso).
 *  - O backend envia notificações (alertas de temporal, quedas COPEL,
 *    interrupções Sanepar) com cooldown por evento (tabela push_sent).
 *
 * VAPID keys: geradas com `generateVAPIDKeys()` (lib web-push) e configuradas
 * nas envs da Vercel (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT).
 */
import webpush from "web-push";

const { sendNotification, setVapidDetails } = webpush;

import { loadConfig } from "./config.js";
import { getDbClient } from "./db.js";
import { logger } from "./logger.js";

export interface PushSubscription {
	endpoint: string;
	keys: { p256dh: string; auth: string };
}

/**
 * Hosts de push service aceitos (allowlist). Sem isso, o `endpoint` era uma URL
 * arbitrária que o servidor visitava em `sendNotification` = SSRF cego
 * (achado pentest 26/09/2026). Sufixo casa subdomínio (wns2-xyz.notify.windows.com).
 */
const PUSH_HOSTS = [
	"fcm.googleapis.com",
	"updates.push.services.mozilla.com",
	"push.services.mozilla.com",
	"notify.windows.com",
	"push.apple.com",
	"push.brave.com",
];

/** Extra (env, separado por vírgula) para provedor novo sem deploy. */
function hostsExtras(): string[] {
	return (process.env.PUSH_ENDPOINT_EXTRA_HOSTS ?? "")
		.split(",")
		.map((h) => h.trim().toLowerCase())
		.filter(Boolean);
}

/** Teto de inscrições: subscription falsa em massa incha a tabela e o envio. */
export const MAX_PUSH_SUBSCRIPTIONS = Number(
	process.env.MAX_PUSH_SUBSCRIPTIONS ?? 5000,
);

const RE_B64 = /^[A-Za-z0-9_\-+/=]{8,200}$/;
const RE_IP = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Normaliza chave do browser (base64url sem padding = base64 com padding). */
export function normalizarChave(k: unknown): string {
	return String(k ?? "")
		.trim()
		.replace(/ /g, "+")
		.replace(/-/g, "+")
		.replace(/_/g, "/")
		.replace(/=+$/, "");
}

/**
 * Valida um endpoint/keys vindos do cliente. Retorna a mensagem de recusa (para
 * o 400) ou `null` quando está tudo certo. Motivo do log: se algum provedor
 * legítimo ficar de fora da allowlist, o host aparece no log do servidor.
 */
export function validatePushEndpoint(
	endpoint: unknown,
	p256dh: unknown,
	auth: unknown,
): string | null {
	const url = String(endpoint ?? "").trim();
	if (!url || url.length > 2048) return "endpoint ausente ou longo demais";
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return "endpoint inválido";
	}
	if (parsed.protocol !== "https:") return "endpoint precisa ser https";
	// Push service sempre usa 443: porta explícita diferente é desvio (usaria a
	// allowlist de host para sondar outra porta do provedor).
	if (parsed.port && parsed.port !== "443") {
		return "endpoint com porta não permitida";
	}
	const host = parsed.hostname.toLowerCase();
	if (RE_IP.test(host) || host === "localhost" || host.endsWith(".local")) {
		return "endpoint com host não permitido";
	}
	const permitido = [...PUSH_HOSTS, ...hostsExtras()].some(
		(h) => host === h || host.endsWith(`.${h}`),
	);
	if (!permitido) {
		logger.warn("Push endpoint recusado (fora da allowlist)", { host });
		return "endpoint de push não suportado";
	}
	if (!RE_B64.test(String(p256dh ?? "")) || !RE_B64.test(String(auth ?? ""))) {
		return "chaves de inscrição inválidas";
	}
	return null;
}

export function pushConfigured(): boolean {
	const c = loadConfig();
	return Boolean(c.vapidPublicKey && c.vapidPrivateKey && c.vapidSubject);
}

/** Registra (ou atualiza) uma inscrição. */
export async function savePushSubscription(
	sub: PushSubscription,
): Promise<void> {
	const db = await getDbClient();
	const now = Date.now();
	await db.execute({
		sql: `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET
        p256dh = excluded.p256dh,
        auth = excluded.auth,
        last_seen_at = excluded.last_seen_at`,
		args: [sub.endpoint, sub.keys.p256dh, sub.keys.auth, now, now],
	});
}

/** Remove uma inscrição (unsubscribe ou endpoint inválido/expirou). */
export async function removePushSubscription(endpoint: string): Promise<void> {
	const db = await getDbClient();
	await db.execute({
		sql: "DELETE FROM push_subscriptions WHERE endpoint = ?",
		args: [endpoint],
	});
}

/**
 * Remove SÓ se as chaves baterem com a inscrição gravada — prova de posse.
 * Antes, `POST /api/push/unsubscribe` aceitava qualquer endpoint e apagava a
 * inscrição alheia (IDOR / DoS de notificação, achado pentest 26/09/2026).
 * Retorna false quando não existe ou quando a chave não confere.
 */
export async function removePushSubscriptionIfOwned(
	endpoint: string,
	keys: { p256dh?: unknown; auth?: unknown } | undefined,
): Promise<boolean> {
	const p256dh = normalizarChave(keys?.p256dh);
	const auth = normalizarChave(keys?.auth);
	if (!p256dh || !auth) return false;
	const db = await getDbClient();
	const res = await db.execute({
		sql: "SELECT p256dh, auth FROM push_subscriptions WHERE endpoint = ?",
		args: [endpoint],
	});
	const row = res.rows[0];
	if (!row) return false;
	if (
		normalizarChave(row.p256dh) !== p256dh ||
		normalizarChave(row.auth) !== auth
	) {
		return false;
	}
	await removePushSubscription(endpoint);
	return true;
}

export async function countPushSubscriptions(): Promise<number> {
	const db = await getDbClient();
	const res = await db.execute("SELECT COUNT(*) AS n FROM push_subscriptions");
	return Number(res.rows[0]?.n ?? 0);
}

export async function listPushSubscriptions(): Promise<PushSubscription[]> {
	const db = await getDbClient();
	const res = await db.execute(
		"SELECT endpoint, p256dh, auth FROM push_subscriptions",
	);
	return res.rows.map((r) => ({
		endpoint: String(r.endpoint),
		keys: { p256dh: String(r.p256dh), auth: String(r.auth) },
	}));
}

/**
 * Lista inscrições com metadados para o painel admin (ver QUEM está inscrito):
 * host do push service (fcm/mozilla/apple) + datas. Ajuda a distinguir
 * inscrições reais de visitantes das sintéticas de teste.
 */
export interface PushSubscriptionMeta {
	endpoint: string;
	host: string;
	createdAt: number;
	lastSeenAt: number;
}

export async function listPushSubscriptionsMeta(): Promise<
	PushSubscriptionMeta[]
> {
	const db = await getDbClient();
	const res = await db.execute(
		"SELECT endpoint, created_at, last_seen_at FROM push_subscriptions ORDER BY created_at DESC",
	);
	return res.rows.map((r) => {
		const endpoint = String(r.endpoint);
		let host = "";
		try {
			host = new URL(endpoint).host;
		} catch {
			host = "desconhecido";
		}
		return {
			endpoint,
			host,
			createdAt: Number(r.created_at),
			lastSeenAt: Number(r.last_seen_at),
		};
	});
}

/**
 * Cooldown por evento: só envia de novo depois de ttlMs (ex: alerta de
 * temporal não repete a cada ciclo de 10 min — 1x por hora).
 */
export async function canSendPush(
	evento: string,
	ttlMs: number,
): Promise<boolean> {
	const db = await getDbClient();
	const res = await db.execute({
		sql: "SELECT enviado_at FROM push_sent WHERE evento = ?",
		args: [evento],
	});
	if (res.rows.length === 0) return true;
	const enviadoAt = Number(res.rows[0].enviado_at);
	return Date.now() - enviadoAt >= ttlMs;
}

export async function markPushSent(evento: string): Promise<void> {
	const db = await getDbClient();
	await db.execute({
		sql: `INSERT INTO push_sent (evento, enviado_at) VALUES (?, ?)
      ON CONFLICT(evento) DO UPDATE SET enviado_at = excluded.enviado_at`,
		args: [evento, Date.now()],
	});
}

/**
 * Envia uma notificação para TODOS os inscritos. Endpoints que falham com
 * 404/410 (inscrição expirada) são removidos do banco. Retorna quantos
 * receberam.
 */
export async function sendPushAlert(
	titulo: string,
	corpo: string,
	url = "/",
): Promise<{ ok: number; falhas: number }> {
	const c = loadConfig();
	if (!pushConfigured()) {
		logger.warn("Push: VAPID não configurado, envio ignorado");
		return { ok: 0, falhas: 0 };
	}
	setVapidDetails(c.vapidSubject!, c.vapidPublicKey!, c.vapidPrivateKey!);

	const subs = await listPushSubscriptions();
	if (subs.length === 0) return { ok: 0, falhas: 0 };

	let ok = 0;
	let falhas = 0;
	const payload = JSON.stringify({ title: titulo, body: corpo, url });

	for (const sub of subs) {
		try {
			await sendNotification(
				{
					endpoint: sub.endpoint,
					keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
				},
				payload,
				{ TTL: 60 * 60 * 4 }, // 4h de vida se o aparelho estiver offline
			);
			ok++;
		} catch (err) {
			const status = (err as { statusCode?: number })?.statusCode;
			if (status === 404 || status === 410) {
				// Inscrição expirada/removida — limpa do banco
				logger.info("Push: inscrição expirada removida", {
					endpoint: sub.endpoint.slice(0, 60),
				});
				await removePushSubscription(sub.endpoint);
			} else {
				logger.warn("Push: falha ao enviar", {
					status,
					error: err instanceof Error ? err.message : String(err),
				});
			}
			falhas++;
		}
	}
	return { ok, falhas };
}

/**
 * Regra de push do alerta unificado próprio (10/09/2026): só laranja e
 * vermelho cutucam o celular; verde/amarelo ficam no site (sem spam).
 * Pura (testável): decide evento/emoji/cooldown a partir do nível.
 */
export function pushParaAlerta(
	nivel: "verde" | "amarelo" | "laranja" | "vermelho",
): { evento: string; emoji: string; ttlMs: number } | null {
	if (nivel === "vermelho")
		return { evento: "alerta:vermelho", emoji: "🔴", ttlMs: 30 * 60_000 };
	if (nivel === "laranja")
		return { evento: "alerta:laranja", emoji: "🟠", ttlMs: 90 * 60_000 };
	return null;
}

/**
 * Envia push com cooldown por evento (chave + TTL). Retorna true se enviou.
 * Usado pelo ciclo (api/cron): temporal (TTL 60min), copel:<id>, sanepar:<id>.
 */
export async function sendEventPush(
	evento: string,
	titulo: string,
	corpo: string,
	ttlMs = 0,
	url = "/",
): Promise<boolean> {
	if (ttlMs > 0 && !(await canSendPush(evento, ttlMs))) {
		return false;
	}
	const r = await sendPushAlert(titulo, corpo, url);
	if (r.ok > 0 || ttlMs === 0) {
		if (ttlMs > 0) await markPushSent(evento);
		return true;
	}
	return false;
}

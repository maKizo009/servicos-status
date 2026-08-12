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

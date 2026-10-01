/**
 * Rotas de Push Web (PWA) — extraídas de index.ts (01/10/2026).
 * Retorna Response quando tratou a rota, null caso contrário.
 */
import {
	getClientIp,
	getHeader,
	getReqJson,
	type IncomingRequest,
} from "./http-helpers.js";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import type { RotaCtx } from "./rotas-admin.js";

export async function handlePushRoutes(ctx: RotaCtx): Promise<Response | null> {
	const { req, path, method, url } = ctx;
	// ===== Push Web (PWA) — inscrições e teste =====
	if (path === "/api/push/status") {
		const { pushConfigured } = await import("./push.js");
		const config = loadConfig();
		// Sem `subscribers`: era dado interno (quantas pessoas seguem os
		// alertas) exposto em endpoint público e sem rate limit — achado
		// pentest 26/09/2026. O front não usa o campo.
		return Response.json({
			configured: pushConfigured(),
			vapidPublicKey: config.vapidPublicKey || null,
			timestamp: Date.now(),
		});
	}
	if (path === "/api/push/subscribe" && method === "POST") {
		try {
			const {
				savePushSubscription,
				validatePushEndpoint,
				countPushSubscriptions,
				MAX_PUSH_SUBSCRIPTIONS,
			} = await import("./push.js");
			const body = (await getReqJson(req)) as {
				endpoint?: string;
				keys?: { p256dh?: string; auth?: string };
			};
			if (!body?.endpoint || !body?.keys?.p256dh || !body?.keys?.auth) {
				return new Response(
					JSON.stringify({ error: "Inscrição incompleta (endpoint/keys)" }),
					{ status: 400, headers: { "Content-Type": "application/json" } },
				);
			}
			// Allowlist de host de push service: sem isso o `endpoint` era
			// uma URL arbitrária que o servidor visitava no envio = SSRF
			// cego + escrita pública (achado pentest 26/09/2026).
			const recusa = validatePushEndpoint(
				body.endpoint,
				body.keys.p256dh,
				body.keys.auth,
			);
			if (recusa) {
				logger.warn("Push subscribe recusado", { motivo: recusa });
				return new Response(JSON.stringify({ error: recusa }), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				});
			}
			const total = await countPushSubscriptions().catch(() => 0);
			if (total >= MAX_PUSH_SUBSCRIPTIONS) {
				logger.warn("Push subscribe: teto de inscrições atingido", { total });
				return new Response(
					JSON.stringify({ error: "Limite de inscrições atingido" }),
					{ status: 503, headers: { "Content-Type": "application/json" } },
				);
			}
			await savePushSubscription({
				endpoint: body.endpoint,
				keys: { p256dh: body.keys.p256dh, auth: body.keys.auth },
			});
			return Response.json({ status: "ok", timestamp: Date.now() });
		} catch (err: unknown) {
			const errMsg = err instanceof Error ? err.message : String(err);
			logger.error("Handler error", { path, error: errMsg });
			return new Response(JSON.stringify({ error: "Requisição inválida" }), {
				status: 400,
				headers: { "Content-Type": "application/json" },
			});
		}
	}
	if (path === "/api/push/unsubscribe" && method === "POST") {
		try {
			const { removePushSubscriptionIfOwned } = await import("./push.js");
			const body = (await getReqJson(req)) as {
				endpoint?: string;
				keys?: { p256dh?: string; auth?: string };
			};
			if (!body?.endpoint) {
				return new Response(JSON.stringify({ error: "endpoint ausente" }), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				});
			}
			// Posse: só apaga a inscrição de quem apresenta as chaves que
			// registrou (o front manda as mesmas). Antes, saber o endpoint
			// bastava para apagar a inscrição alheia — quem fazia isso
			// silenciava os alertas da vítima (IDOR, pentest 26/09/2026).
			// Mesma resposta para "não existe" e "chave errada" (sem oráculo).
			const removido = await removePushSubscriptionIfOwned(
				body.endpoint,
				body.keys,
			);
			if (!removido) {
				return new Response(
					JSON.stringify({ error: "Inscrição não encontrada" }),
					{ status: 400, headers: { "Content-Type": "application/json" } },
				);
			}
			return Response.json({ status: "ok", timestamp: Date.now() });
		} catch (err: unknown) {
			const errMsg = err instanceof Error ? err.message : String(err);
			logger.error("Handler error", { path, error: errMsg });
			return new Response(JSON.stringify({ error: "Requisição inválida" }), {
				status: 400,
				headers: { "Content-Type": "application/json" },
			});
		}
	}
	if (path === "/api/push/test" && method === "POST") {
		// Push para TODOS os inscritos do PWA: exige sessão admin
		// (achado pentest: endpoint público spammava todos os usuários).
		const { getSessionTokenFromCookie, verifySessionToken } = await import(
			"./admin.js"
		);
		if (
			!(await verifySessionToken(
				getSessionTokenFromCookie(getHeader(req, "cookie")),
			))
		) {
			return new Response(JSON.stringify({ error: "Não autenticado" }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			});
		}
		// Envia um push de teste pra todos os inscritos (validar o fluxo).
		const { sendPushAlert } = await import("./push.js");
		const r = await sendPushAlert(
			"🔔 Monitor Ipiranga",
			"Teste de alerta — notificações funcionando!",
			"/",
		);
		return Response.json({ ...r, timestamp: Date.now() });
	}
	// /api/signal-report (relato de sinal do morador por operadora) foi
	// removido em 22/09/2026: só alimentava o status das operadoras, que
	// saiu do produto. Não confundir com /api/track (telemetria de uso do
	// site — acessos/sessões/instalações), que continua.
	return null;
}

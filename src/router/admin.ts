/**
 * Rotas do painel admin + WebAuthn — extraídas de src/index.ts (01/10/2026).
 *
 * Retorna Response quando tratou a rota, null caso contrário (o router
 * principal continua). As funções de sessão/senha vivem em src/admin.ts —
 * este arquivo só liga HTTP para elas.
 */
import {
	getClientIp,
	getHeader,
	getReqJson,
	type IncomingRequest,
} from "../http-helpers.js";
import { loadConfig } from "../config.js";
import { logger } from "../logger.js";
import { checkRateLimitShared } from "../rate-limiter.js";

export interface RotaCtx {
	req: IncomingRequest;
	path: string;
	method: string;
	url: URL;
}

export async function handleAdminRoutes(ctx: RotaCtx): Promise<Response | null> {
	const { req, path, method, url } = ctx;
	// ===== Painel Admin (só o dono) =====
	if (path === "/api/admin/login" && method === "POST") {
		// Rate limit dedicado de login (5/min por IP), além do escopo
		// "admin" (20/min): corta rajadas de brute force. O atraso fixo
		// de 1.2s abaixo desacelera tentativas distribuídas.
		// Compartilhado (Turso): medido em 26/09/2026 — 12 logins errados em
		// PARALELO passavam 10 vezes (o Map por instância vê poucas
		// tentativas cada). O atraso de 1,2s abaixo não serializa sob
		// concorrência.
		const { allowed, retryAfter } = await checkRateLimitShared(
			getClientIp(req),
			5,
			"login",
		);
		if (!allowed) {
			return new Response(
				JSON.stringify({ error: "Too many requests", retryAfter }),
				{
					status: 429,
					headers: {
						"Content-Type": "application/json",
						"Retry-After": String(retryAfter),
					},
				},
			);
		}
		const {
			adminConfigured,
			adminEmail,
			createSessionToken,
			sessionCookie,
			verifyPassword,
		} = await import("../admin.js");
		if (!adminConfigured()) {
			// Mensagem genérica: "Admin não configurado" confirmava ao
			// visitante que existe painel e que falta configurar
			// (achado pentest 26/09/2026).
			return new Response(
				JSON.stringify({ error: "Serviço indisponível" }),
				{ status: 503, headers: { "Content-Type": "application/json" } },
			);
		}
		const body = (await getReqJson(req)) as {
			email?: string;
			password?: string;
		};
		const ok =
			String(body?.email ?? "").toLowerCase() ===
				adminEmail().toLowerCase() &&
			verifyPassword(
				String(body?.password ?? ""),
				loadConfig().adminPasswordHash,
			);
		// Atraso fixo anti brute-force (serverless não tem memória de
		// tentativas entre instâncias — o atraso uniformiza a força).
		await new Promise((r) => setTimeout(r, 1200));
		if (!ok) {
			return new Response(
				JSON.stringify({ error: "Credenciais inválidas" }),
				{ status: 401, headers: { "Content-Type": "application/json" } },
			);
		}
		// 2FA (26/09/2026): com passkey cadastrada a senha não abre sessão —
		// ela prova o 1º fator e o navegador segue para a passkey.
		const {
			passkeyRequired,
			createPendingToken,
			pendingCookie,
		} = await import("../admin.js");
		if (await passkeyRequired()) {
			const pend = await createPendingToken();
			return new Response(JSON.stringify({ status: "passkey_required" }), {
				status: 200,
				headers: {
					"Content-Type": "application/json",
					"Set-Cookie": pendingCookie(pend),
				},
			});
		}
		const token = await createSessionToken();
		return new Response(JSON.stringify({ status: "ok" }), {
			status: 200,
			headers: {
				"Content-Type": "application/json",
				"Set-Cookie": sessionCookie(token),
			},
		});
	}
	if (path === "/api/admin/logout" && method === "POST") {
		const {
			clearSessionCookie,
			getSessionTokenFromCookie,
			revokeAllSessions,
			verifySessionToken,
		} = await import("../admin.js");
		// Revoga de verdade: só incrementa a epoch (que invalida todo token
		// emitido antes) quando veio uma sessão VÁLIDA — assim um POST
		// anônimo não derruba a sessão do dono, e um logout real mata o
		// token copiado em outro dispositivo (achado pentest 26/09/2026:
		// antes o logout só limpava o cookie e o token valia 30 dias).
		const tokenAtual = getSessionTokenFromCookie(getHeader(req, "cookie"));
		if (tokenAtual && (await verifySessionToken(tokenAtual))) {
			await revokeAllSessions().catch((err: unknown) => {
				logger.warn("Falha ao revogar sessões no logout", {
					error: err instanceof Error ? err.message : String(err),
				});
			});
		}
		return new Response(JSON.stringify({ status: "ok" }), {
			status: 200,
			headers: {
				"Content-Type": "application/json",
				"Set-Cookie": clearSessionCookie(),
			},
		});
	}
	if (path === "/api/admin/me" && method === "GET") {
		const {
			adminConfigured,
			adminEmail,
			getSessionTokenFromCookie,
			verifySessionToken,
		} = await import("../admin.js");
		const token = getSessionTokenFromCookie(getHeader(req, "cookie"));
		const authed = await verifySessionToken(token);
		return Response.json({
			authed,
			// Não expor "admin existe" para quem não está autenticado
			// (achado pentest: recon via /api/admin/me sem auth).
			configured: authed ? adminConfigured() : false,
			email: authed ? adminEmail() : null,
			timestamp: Date.now(),
		});
	}
	if (path === "/api/admin/stats" && method === "GET") {
		const { getAdminStats, getSessionTokenFromCookie, verifySessionToken } =
			await import("../admin.js");
		const token = getSessionTokenFromCookie(getHeader(req, "cookie"));
		if (!(await verifySessionToken(token))) {
			return new Response(JSON.stringify({ error: "Não autenticado" }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			});
		}
		return Response.json(await getAdminStats());
	}
	// Lista de inscritos nos alertas (para o dono ver QUEM está inscrito —
	// host do push service + datas; ajuda a separar visitantes reais das
	// inscrições sintéticas de teste). Autenticado como o resto do admin.
	if (path === "/api/admin/push-subscriptions" && method === "GET") {
		const { getSessionTokenFromCookie, verifySessionToken } = await import(
			"../admin.js"
		);
		const token = getSessionTokenFromCookie(getHeader(req, "cookie"));
		if (!(await verifySessionToken(token))) {
			return new Response(JSON.stringify({ error: "Não autenticado" }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			});
		}
		const { listPushSubscriptionsMeta } = await import("../push.js");
		return Response.json({
			subscriptions: await listPushSubscriptionsMeta(),
		});
	}
	// ===== WebAuthn (impressão digital / passkey) =====
	const authOk = await (async () => {
		const { getSessionTokenFromCookie, verifySessionToken } = await import(
			"../admin.js"
		);
		return await verifySessionToken(
			getSessionTokenFromCookie(getHeader(req, "cookie")),
		);
	})();
	if (path === "/api/admin/webauthn/register/begin" && method === "POST") {
		if (!authOk) {
			return new Response(JSON.stringify({ error: "Não autenticado" }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			});
		}
		const { webauthnRegisterBegin } = await import("../admin.js");
		const out = await webauthnRegisterBegin(getHeader(req, "host"));
		if (!out) {
			return new Response(
				JSON.stringify({ error: "WebAuthn indisponível" }),
				{ status: 500, headers: { "Content-Type": "application/json" } },
			);
		}
		return Response.json(out);
	}
	if (path === "/api/admin/webauthn/register/complete" && method === "POST") {
		if (!authOk) {
			return new Response(JSON.stringify({ error: "Não autenticado" }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			});
		}
		const { webauthnRegisterComplete } = await import("../admin.js");
		const out = await webauthnRegisterComplete(
			await getReqJson(req),
			getHeader(req, "origin"),
		);
		if (!out.ok) {
			logger.warn("WebAuthn register/complete falhou", {
				error: String((out as { error?: string }).error ?? ""),
			});
			return Response.json(
				{ error: "Falha no cadastro da passkey" },
				{ status: 400 },
			);
		}
		return Response.json(out);
	}
	if (path === "/api/admin/webauthn/login/begin" && method === "POST") {
		const {
			webauthnLoginBegin,
			twoFactorRequired,
			verifyPendingToken,
			getPendingTokenFromCookie,
		} = await import("../admin.js");
		// No modo padrão a passkey é o SEGUNDO fator: sem a senha antes
		// (cookie curto mi_admin_2fa) ela não inicia. Sem isso, a passkey
		// sozinha abriria sessão e o 2FA seria decorativo.
		const pend = getPendingTokenFromCookie(getHeader(req, "cookie"));
		if (twoFactorRequired() && !verifyPendingToken(pend)) {
			return new Response(
				JSON.stringify({ error: "Informe e-mail e senha antes da passkey" }),
				{ status: 400, headers: { "Content-Type": "application/json" } },
			);
		}
		const out = await webauthnLoginBegin(getHeader(req, "host"));
		if (!out) {
			return new Response(
				JSON.stringify({ error: "Nenhuma passkey registrada" }),
				{ status: 404, headers: { "Content-Type": "application/json" } },
			);
		}
		return Response.json(out);
	}
	if (path === "/api/admin/webauthn/login/complete" && method === "POST") {
		const { sessionCookie, webauthnLoginComplete } = await import(
			"../admin.js"
		);
		const out = await webauthnLoginComplete(
			await getReqJson(req),
			getHeader(req, "origin"),
		);
		if (!out.ok || !out.token) {
			// Mensagem genérica: `out.error` podia trazer texto de biblioteca
			// (achado pentest 26/09/2026).
			logger.warn("WebAuthn login/complete falhou", {
				error: out.error,
			});
			return new Response(
				JSON.stringify({ error: "Falha na autenticação" }),
				{
					status: 400,
					headers: { "Content-Type": "application/json" },
				},
			);
		}
		const { clearPendingCookie } = await import("../admin.js");
		const headers = new Headers({ "Content-Type": "application/json" });
		headers.append("Set-Cookie", sessionCookie(out.token));
		// o token do 1º fator morre aqui (a passkey já cumpriu o papel)
		headers.append("Set-Cookie", clearPendingCookie());
		return new Response(JSON.stringify({ status: "ok" }), {
			status: 200,
			headers,
		});
	}
	return null;
}

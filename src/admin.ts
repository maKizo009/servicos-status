/**
 * Painel Admin — autenticação (email+senha, sessão por cookie HMAC) e
 * estatísticas de uso (acessos, instalações PWA, sessões ativas, push).
 *
 * Segurança:
 *  - Senha do admin nunca em texto puro: env ADMIN_PASSWORD_HASH no formato
 *    "scrypt:N:salt:hash" (gerado por scripts/hash-admin-password.ts).
 *  - Sessão: token HMAC-SHA256(SESSION_SECRET) com expiração de 12h, em
 *    cookie httpOnly + SameSite=Lax.
 *  - Login com atraso anti brute-force (1.5s) + comparação timing-safe.
 */
import {
	createHmac,
	randomBytes,
	scryptSync,
	timingSafeEqual,
} from "node:crypto";
import type {
	AuthenticationResponseJSON,
	AuthenticatorTransportFuture,
	PublicKeyCredentialCreationOptionsJSON,
	PublicKeyCredentialRequestOptionsJSON,
	RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { loadConfig } from "./config.js";
import { getDbClient } from "./db.js";

const SESSION_TTL_MS = 30 * 24 * 60 * 60_000; // 30 dias (sessão pessoal do Dave)

// ============ Senha (scrypt) ============

/** Verifica a senha contra o hash scrypt armazenado (formato scrypt:N:salt:hash). */
export function verifyPassword(password: string, stored: string): boolean {
	try {
		const [algo, nStr, salt, hash] = stored.split(":");
		if (algo !== "scrypt" || !nStr || !salt || !hash) return false;
		const n = Number(nStr);
		const derived = scryptSync(password, Buffer.from(salt, "hex"), 64, {
			N: n,
		});
		const expected = Buffer.from(hash, "hex");
		return (
			derived.length === expected.length && timingSafeEqual(derived, expected)
		);
	} catch {
		return false;
	}
}

/** Gera o hash no formato scrypt:N:salt:hash (para criar a env). */
export function hashPassword(password: string): string {
	const salt = randomBytes(16).toString("hex");
	const N = 16384;
	const derived = scryptSync(password, Buffer.from(salt, "hex"), 64, { N });
	return `scrypt:${N}:${salt}:${derived.toString("hex")}`;
}

// ============ Sessão (cookie HMAC) ============

export function adminConfigured(): boolean {
	const c = loadConfig();
	return Boolean(c.adminEmail && c.adminPasswordHash && c.sessionSecret);
}

export function adminEmail(): string {
	return loadConfig().adminEmail;
}

function signSession(payload: string): string {
	const c = loadConfig();
	return createHmac("sha256", c.sessionSecret).update(payload).digest("hex");
}

/** Cria o token de sessão (base64url(payload).hmac). */
export function createSessionToken(): string {
	const exp = Date.now() + SESSION_TTL_MS;
	const payload = Buffer.from(
		JSON.stringify({ exp, r: randomBytes(6).toString("hex") }),
	).toString("base64url");
	return `${payload}.${signSession(payload)}`;
}

/** Valida o token; retorna true se for assinatura válida e não expirou. */
export function verifySessionToken(token: string | null | undefined): boolean {
	if (!token) return false;
	const [payload, sig] = token.split(".");
	if (!payload || !sig) return false;
	const expected = signSession(payload);
	const sigBuf = Buffer.from(sig);
	const expBuf = Buffer.from(expected);
	if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
		return false;
	}
	try {
		const { exp } = JSON.parse(
			Buffer.from(payload, "base64url").toString("utf8"),
		) as { exp: number };
		return exp > Date.now();
	} catch {
		return false;
	}
}

export function sessionCookie(token: string): string {
	return `mi_admin=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${
		SESSION_TTL_MS / 1000
	}; Secure`;
}

export function clearSessionCookie(): string {
	return "mi_admin=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
}

/** Extrai o cookie mi_admin do header Cookie. */
export function getSessionTokenFromCookie(
	cookieHeader: string | null,
): string | null {
	if (!cookieHeader) return null;
	for (const part of cookieHeader.split(";")) {
		const [k, ...v] = part.trim().split("=");
		if (k === "mi_admin") return v.join("=");
	}
	return null;
}

// ============ Telemetria (acessos, instalações, sessões) ============

export async function trackEvent(
	tipo: string,
	sessionId: string | null,
): Promise<void> {
	const db = await getDbClient();
	const now = Date.now();
	await db.execute({
		sql: "INSERT INTO app_events (tipo, session_id, ts) VALUES (?, ?, ?)",
		args: [tipo, sessionId ?? null, now],
	});
	if (sessionId && (tipo === "pageview" || tipo === "heartbeat")) {
		await db.execute({
			sql: `INSERT INTO app_sessions (session_id, first_seen, last_seen)
        VALUES (?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET last_seen = excluded.last_seen`,
			args: [sessionId, now, now],
		});
	}
}

// ============ Estatísticas ============

/** Início do dia no fuso de São Paulo (UTC-3, sem DST). */
function startOfDayBr(now: number): number {
	const d = new Date(now);
	d.setUTCHours(d.getUTCHours() - 3, 0, 0, 0);
	return d.getTime();
}

function dayStartBr(offsetDays: number, now = Date.now()): number {
	return startOfDayBr(now) - offsetDays * 86_400_000;
}

export interface AdminStats {
	geradoEm: number;
	acessos: { hoje: number; semana: number; total: number };
	instalacoesPwa: number;
	inscritosPush: number;
	sessoesAtivasAgora: number;
	sessoesAtivas24h: number;
	sessoesHoje: number;
	acessosPorHora: Array<{ hora: string; n: number }>;
}

export async function getAdminStats(): Promise<AdminStats> {
	const db = await getDbClient();
	const now = Date.now();
	const hoje = dayStartBr(0, now);
	const semana = dayStartBr(7, now);
	const ativoAgora = now - 3 * 60_000;
	const ativo24h = now - 24 * 60 * 60_000;

	const count = async (
		sql: string,
		args: Array<string | number>,
	): Promise<number> => {
		const res = await db.execute({ sql, args });
		return Number(res.rows[0]?.n ?? 0);
	};

	const [
		pvHoje,
		pvSemana,
		pvTotal,
		installs,
		push,
		ativosAgora,
		ativos24h,
		sessoesHoje,
	] = await Promise.all([
		count(
			"SELECT COUNT(*) AS n FROM app_events WHERE tipo='pageview' AND ts >= ?",
			[hoje],
		),
		count(
			"SELECT COUNT(*) AS n FROM app_events WHERE tipo='pageview' AND ts >= ?",
			[semana],
		),
		count("SELECT COUNT(*) AS n FROM app_events WHERE tipo='pageview'", []),
		count("SELECT COUNT(*) AS n FROM app_events WHERE tipo='install'", []),
		count("SELECT COUNT(*) AS n FROM push_subscriptions", []),
		count("SELECT COUNT(*) AS n FROM app_sessions WHERE last_seen >= ?", [
			ativoAgora,
		]),
		count("SELECT COUNT(*) AS n FROM app_sessions WHERE last_seen >= ?", [
			ativo24h,
		]),
		count("SELECT COUNT(*) AS n FROM app_sessions WHERE first_seen >= ?", [
			hoje,
		]),
	]);

	// Acessos por hora (últimas 24h, fuso BRT) — buckets de 1h
	const res = await db.execute({
		sql: `SELECT (ts / 3600000) AS bucket, COUNT(*) AS n
      FROM app_events WHERE tipo='pageview' AND ts >= ?
      GROUP BY bucket ORDER BY bucket`,
		args: [ativo24h],
	});
	const porBucket = new Map<number, number>();
	for (const row of res.rows) {
		porBucket.set(Number(row.bucket), Number(row.n));
	}
	const acessosPorHora: Array<{ hora: string; n: number }> = [];
	for (let i = 23; i >= 0; i--) {
		const bucketStart = Math.floor(ativo24h / 3_600_000) + i;
		const d = new Date(bucketStart * 3_600_000);
		const horaBr = `${String((d.getUTCHours() - 3 + 24) % 24).padStart(
			2,
			"0",
		)}:00`;
		acessosPorHora.push({ hora: horaBr, n: porBucket.get(bucketStart) ?? 0 });
	}

	return {
		geradoEm: now,
		acessos: { hoje: pvHoje, semana: pvSemana, total: pvTotal },
		instalacoesPwa: installs,
		inscritosPush: push,
		sessoesAtivasAgora: ativosAgora,
		sessoesAtivas24h: ativos24h,
		sessoesHoje,
		acessosPorHora,
	};
}

// ============ WebAuthn (impressão digital / passkey) ============

/** Domínios aceitos para passkey (rpID = host da request, validado aqui). */
const WEBAUTHN_ALLOWED_HOSTS = [
	"servicos-status.vercel.app",
	"os-status.vercel.app", // alias legado que o Dave usa — manter funcionando
] as const;

const CHALLENGE_TTL_MS = 5 * 60_000;

function normalizeHost(host: string | null): string | null {
	if (!host) return null;
	return host.split(":")[0].toLowerCase();
}

function hostAllowed(host: string | null): boolean {
	const h = normalizeHost(host);
	return (
		h !== null && (WEBAUTHN_ALLOWED_HOSTS as readonly string[]).includes(h)
	);
}

function isValidOrigin(origin: string | null): boolean {
	if (!origin) return false;
	try {
		const u = new URL(origin);
		return hostAllowed(u.hostname) && u.protocol === "https:";
	} catch {
		return false;
	}
}

interface WebauthnCredential {
	id: string;
	publicKey: string;
	counter: number;
	transports: string[];
}

async function getCredentials(): Promise<WebauthnCredential[]> {
	const db = await getDbClient();
	const res = await db.execute(
		"SELECT id, public_key, counter, transports FROM webauthn_credentials",
	);
	return res.rows.map((r) => ({
		id: String(r.id),
		publicKey: String(r.public_key),
		counter: Number(r.counter),
		transports: JSON.parse(String(r.transports ?? "[]")) as string[],
	}));
}

async function saveChallenge(
	challenge: string,
	email: string,
	purpose: "register" | "login",
): Promise<void> {
	const db = await getDbClient();
	await db.execute({
		sql: `INSERT INTO webauthn_challenges (challenge, email, purpose, ts) VALUES (?, ?, ?, ?)
      ON CONFLICT(challenge) DO UPDATE SET email=excluded.email, purpose=excluded.purpose, ts=excluded.ts`,
		args: [challenge, email, purpose, Date.now()],
	});
}

async function takeChallenge(
	challenge: string,
	purpose: "register" | "login",
): Promise<string | null> {
	const db = await getDbClient();
	const res = await db.execute({
		sql: "SELECT email, ts FROM webauthn_challenges WHERE challenge = ? AND purpose = ?",
		args: [challenge, purpose],
	});
	// Consome o challenge (uso único) antes de validar
	await db.execute({
		sql: "DELETE FROM webauthn_challenges WHERE challenge = ?",
		args: [challenge],
	});
	if (res.rows.length === 0) return null;
	// TTL de 5 min — challenge velho nunca é aceito
	const ts = Number(res.rows[0].ts);
	if (Date.now() - ts >= CHALLENGE_TTL_MS) return null;
	return String(res.rows[0].email);
}

/** Passo 1 do registro de passkey (exige sessão por senha). */
export async function webauthnRegisterBegin(
	host: string | null,
): Promise<{ options: PublicKeyCredentialCreationOptionsJSON } | null> {
	if (!hostAllowed(host)) return null;
	const rpID = normalizeHost(host)!;
	const { generateRegistrationOptions } = await import(
		"@simplewebauthn/server"
	);
	const creds = await getCredentials();
	const options = await generateRegistrationOptions({
		rpName: "Monitor Ipiranga",
		rpID,
		userName: adminEmail(),
		userDisplayName: "Admin",
		userID: Buffer.from(adminEmail()).subarray(0, 16),
		timeout: 60_000,
		attestationType: "none",
		authenticatorSelection: {
			authenticatorAttachment: "platform",
			userVerification: "required",
		},
		excludeCredentials: creds.map((c) => ({
			id: c.id,
			transports: c.transports as AuthenticatorTransportFuture[],
		})),
	});
	await saveChallenge(options.challenge, adminEmail(), "register");
	return { options };
}

/** Passo 2 do registro: verifica a resposta do autenticador e salva a credencial. */
export async function webauthnRegisterComplete(
	body: unknown,
	origin: string | null,
): Promise<{ ok: boolean; error?: string }> {
	const { verifyRegistrationResponse } = await import("@simplewebauthn/server");
	if (!isValidOrigin(origin)) return { ok: false, error: "Origin inválida" };
	const res = body as {
		response?: { clientDataJSON?: string; attestationObject?: string };
	};
	const challenge = (() => {
		try {
			const cd = JSON.parse(
				Buffer.from(res.response?.clientDataJSON ?? "", "base64url").toString(),
			) as { challenge?: string };
			return cd.challenge ?? "";
		} catch {
			return "";
		}
	})();
	const email = await takeChallenge(challenge, "register");
	if (!email) return { ok: false, error: "Challenge inválido/expirado" };

	try {
		const verification = await verifyRegistrationResponse({
			response: body as RegistrationResponseJSON,
			expectedChallenge: challenge,
			expectedOrigin: origin!,
			expectedRPID: normalizeHost(new URL(origin!).hostname)!,
		});
		if (!verification.verified || !verification.registrationInfo) {
			return { ok: false, error: "Verificação falhou" };
		}
		const { credential } = verification.registrationInfo;
		const db = await getDbClient();
		await db.execute({
			sql: `INSERT INTO webauthn_credentials (id, public_key, counter, transports, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET public_key=excluded.public_key, counter=excluded.counter, transports=excluded.transports`,
			args: [
				credential.id,
				Buffer.from(credential.publicKey).toString("base64"),
				credential.counter,
				JSON.stringify([]),
				Date.now(),
			],
		});
		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

/** Passo 1 do login com passkey: gera o desafio para o autenticador. */
export async function webauthnLoginBegin(
	host: string | null,
): Promise<{ options: PublicKeyCredentialRequestOptionsJSON } | null> {
	if (!hostAllowed(host)) return null;
	const rpID = normalizeHost(host)!;
	const { generateAuthenticationOptions } = await import(
		"@simplewebauthn/server"
	);
	const creds = await getCredentials();
	if (creds.length === 0) return null;
	const options = await generateAuthenticationOptions({
		rpID,
		timeout: 60_000,
		allowCredentials: creds.map((c) => ({
			id: c.id,
			type: "public-key" as const,
			transports: c.transports as AuthenticatorTransportFuture[],
		})),
		userVerification: "required",
	});
	await saveChallenge(options.challenge, adminEmail(), "login");
	return { options };
}

/** Passo 2 do login: verifica a assinatura e abre a sessão. */
export async function webauthnLoginComplete(
	body: unknown,
	origin: string | null,
): Promise<{ ok: boolean; token?: string; error?: string }> {
	const { verifyAuthenticationResponse } = await import(
		"@simplewebauthn/server"
	);
	if (!isValidOrigin(origin)) return { ok: false, error: "Origin inválida" };
	const res = body as AuthenticationResponseJSON;
	const challenge = (() => {
		try {
			const cd = JSON.parse(
				Buffer.from(res.response?.clientDataJSON ?? "", "base64url").toString(),
			) as { challenge?: string };
			return cd.challenge ?? "";
		} catch {
			return "";
		}
	})();
	const email = await takeChallenge(challenge, "login");
	if (!email) return { ok: false, error: "Challenge inválido/expirado" };

	const creds = await getCredentials();
	const cred = creds.find((c) => c.id === res.id);
	if (!cred) return { ok: false, error: "Credencial não encontrada" };

	try {
		const verification = await verifyAuthenticationResponse({
			response: res,
			expectedChallenge: challenge,
			expectedOrigin: origin!,
			expectedRPID: normalizeHost(new URL(origin!).hostname)!,
			credential: {
				id: cred.id,
				publicKey: new Uint8Array(Buffer.from(cred.publicKey, "base64")),
				counter: cred.counter,
			},
		});
		if (!verification.verified)
			return { ok: false, error: "Assinatura inválida" };
		const db = await getDbClient();
		await db.execute({
			sql: "UPDATE webauthn_credentials SET counter = ? WHERE id = ?",
			args: [verification.authenticationInfo.newCounter, cred.id],
		});
		return { ok: true, token: createSessionToken() };
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

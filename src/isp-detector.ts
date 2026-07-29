import { getCachedIspInfo, saveCachedIspInfo } from "./db";
import { logger } from "./logger";
import type { OperatorName } from "./types";

export interface IspInfo {
	ip: string;
	operator: OperatorName | null;
	ispName: string;
	asn: string;
	isMobile: boolean;
}

export async function detectIsp(ip: string): Promise<IspInfo> {
	// Handle local/private IPs
	if (
		!ip ||
		ip === "127.0.0.1" ||
		ip === "::1" ||
		ip.startsWith("10.") ||
		ip.startsWith("192.168.") ||
		ip.startsWith("172.")
	) {
		return {
			ip: ip || "127.0.0.1",
			operator: null,
			ispName: "Rede Local (LAN)",
			asn: "LAN",
			isMobile: false,
		};
	}

	// 1. Check local DB cache
	const cached = getCachedIspInfo(ip);
	if (cached) {
		return cached;
	}

	// 2. Query IP-API
	try {
		const url = `http://ip-api.com/json/${ip}?fields=status,org,as,isp,mobile`;
		const resp = await fetch(url, { signal: AbortSignal.timeout(2500) });
		if (resp.ok) {
			const data = (await resp.json()) as {
				status?: string;
				org?: string;
				as?: string;
				isp?: string;
				mobile?: boolean;
			};

			if (data.status === "success") {
				const fullStr =
					`${data.org || ""} ${data.isp || ""} ${data.as || ""}`.toUpperCase();
				let operator: OperatorName | null = null;

				if (fullStr.includes("CLARO") || fullStr.includes("EMBRATEL")) {
					operator = "Claro";
				} else if (
					fullStr.includes("TELEFONICA") ||
					fullStr.includes("VIVO")
				) {
					operator = "Vivo";
				} else if (fullStr.includes("TIM S.A.") || fullStr.includes("TIM BRASIL") || fullStr.includes("TIM PERNAMBUCO")) {
					operator = "TIM";
				}

				const ispName = data.isp || data.org || "Desconhecido";
				const asn = data.as || "";
				const isMobile = Boolean(data.mobile || operator !== null);

				saveCachedIspInfo(ip, operator, ispName, asn, isMobile);

				return {
					ip,
					operator,
					ispName,
					asn,
					isMobile,
				};
			}
		}
	} catch (err) {
		logger.warn("ISP lookup failed for IP", { ip, error: String(err) });
	}

	// Fallback
	const fallback: IspInfo = {
		ip,
		operator: null,
		ispName: "Banda Larga / Provedor Local",
		asn: "",
		isMobile: false,
	};
	saveCachedIspInfo(ip, null, fallback.ispName, "", false);
	return fallback;
}

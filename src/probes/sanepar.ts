import { logger } from "../logger";
import { type EventTracker, makeHash } from "../state";
import type { SaneparInterruption } from "../types";

export async function getSaneparViewDomIds(
	pageUrl: string,
	timeoutMs: number,
): Promise<string[]> {
	try {
		const resp = await fetch(pageUrl, {
			signal: AbortSignal.timeout(timeoutMs),
			headers: { "User-Agent": "Mozilla/5.0" },
		});
		if (!resp.ok) return [];
		const html = await resp.text();
		const regex = /view_dom_id["']:\s*["']([^"']+)["']/g;
		const ids: string[] = [];
		for (;;) {
			const match = regex.exec(html);
			if (!match) break;
			ids.push(match[1]);
		}
		return ids;
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.error("Erro ao obter view_dom_ids Sanepar", { error: msg });
		return [];
	}
}

export async function fetchSaneparDisplay(
	viewsAjaxUrl: string,
	viewName: string,
	viewDisplayId: string,
	viewDomId: string,
	timeoutMs: number,
): Promise<string> {
	try {
		const params = new URLSearchParams();
		params.append("view_name", viewName);
		params.append("view_display_id", viewDisplayId);
		params.append("view_args", "");
		params.append("view_path", "/node/50951");
		params.append("view_base_path", "");
		params.append("view_dom_id", viewDomId);
		params.append("pager_element", "0");

		const resp = await fetch(viewsAjaxUrl, {
			method: "POST",
			signal: AbortSignal.timeout(timeoutMs),
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				"User-Agent": "Mozilla/5.0",
			},
			body: params.toString(),
		});
		if (!resp.ok) return "";

		const arr = (await resp.json()) as { command?: string; data?: string }[];
		for (const item of arr) {
			if (item.command === "insert" && item.data) {
				return item.data;
			}
		}
		return "";
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.error("Erro no fetch Sanepar display", {
			display: viewDisplayId,
			error: msg,
		});
		return "";
	}
}

function normalizeString(str: string): string {
	return str
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.trim();
}

export function parseSaneparHtml(
	html: string,
	targetMunicipio: string = "Ipiranga",
): SaneparInterruption[] {
	const interruptions: SaneparInterruption[] = [];
	const articleRegex =
		/<article[^>]*class="[^"]*feat-card-supplystop[^"]*"[^>]*>.*?<\/article>/gs;

	const normTarget = normalizeString(targetMunicipio);

	for (;;) {
		const articleMatch = articleRegex.exec(html);
		if (!articleMatch) break;
		const article = articleMatch[0];

		const cityMatch = article.match(/feat-card-supplystop-locale[^>]*>([^<]+)/);
		const cidade = cityMatch ? cityMatch[1].trim() : "N/A";

		if (!normalizeString(cidade).includes(normTarget)) continue;

		const bairroMatch = article.match(
			/feat-card-supplystop-locale[^>]*title="([^"]+)"/,
		);
		const bairro = bairroMatch ? bairroMatch[1].trim() : cidade;

		const startMatch = article.match(/start-date[^>]*>([^<]+)/);
		const inicio = startMatch ? startMatch[1].trim() : "N/A";

		const endMatch = article.match(/date-return[^>]*>([^<]+)/);
		const fim = endMatch ? endMatch[1].trim() : "N/A";

		const reasonMatch = article.match(
			/feat-card-supplystop-reason[^>]*>([^<]+)/,
		);
		const motivo = reasonMatch ? reasonMatch[1].trim() : "Não informado";

		const linkMatch = article.match(/href="([^"]+)"/);
		const link = linkMatch
			? linkMatch[1]
			: "https://www.sanepar.com.br/esta-sem-agua";

		interruptions.push({ cidade, bairro, inicio, fim, motivo, link });
	}

	return interruptions;
}

export interface SaneparCheckResult {
	allInterruptions: SaneparInterruption[];
	newInterruptions: SaneparInterruption[];
}

export async function checkSanepar(
	viewsAjaxUrl: string,
	pageUrl: string,
	viewName: string,
	displays: string[],
	timeoutMs: number,
	municipio: string,
	tracker: EventTracker,
): Promise<SaneparCheckResult> {
	const allInterruptions: SaneparInterruption[] = [];
	const newInterruptions: SaneparInterruption[] = [];
	const domIds = await getSaneparViewDomIds(pageUrl, timeoutMs);

	if (domIds.length === 0) {
		logger.warn("Sanepar: nenhum view_dom_id encontrado");
		return { allInterruptions: [], newInterruptions: [] };
	}

	for (let i = 0; i < Math.min(domIds.length, displays.length); i++) {
		const display = displays[i];
		const domId = domIds[i];
		const html = await fetchSaneparDisplay(
			viewsAjaxUrl,
			viewName,
			display,
			domId,
			timeoutMs,
		);
		if (!html) continue;

		const interruptions = parseSaneparHtml(html, municipio);
		for (const intr of interruptions) {
			allInterruptions.push(intr);
			const h = makeHash(intr.cidade, intr.bairro, intr.inicio, intr.fim);
			if (!tracker.isKnown("sanepar", h)) {
				tracker.markKnown("sanepar", h);
				newInterruptions.push(intr);
			}
		}
	}

	if (allInterruptions.length > 0) {
		logger.info("Sanepar: interrupções encontradas", {
			total: allInterruptions.length,
			novas: newInterruptions.length,
		});
	}

	return { allInterruptions, newInterruptions };
}

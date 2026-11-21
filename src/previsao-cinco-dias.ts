/** Valores de previsão são opcionais: fonte indisponível nunca é convertida em zero. */
export interface PrevisaoDia {
	data: string;
	minimaC: number | null;
	maximaC: number | null;
	chuvaMm: number | null;
	probabilidadeMaximaPct: number | null;
	rajadasKmh: number | null;
	codigoTempo: number | null;
}

type Daily = {
	time?: unknown;
	temperature_2m_min?: unknown;
	temperature_2m_max?: unknown;
	precipitation_sum?: unknown;
	precipitation_probability_max?: unknown;
	wind_gusts_10m_max?: unknown;
	weather_code?: unknown;
};

/** A data da API já está no fuso solicitado; não interpretá-la como UTC. */
export function normalizarPrevisaoDiaria(daily: Daily | null | undefined): PrevisaoDia[] {
	if (!daily || !Array.isArray(daily.time)) return [];
	const valor = (campo: unknown, i: number, min = -Infinity, max = Infinity): number | null => {
		if (!Array.isArray(campo)) return null;
		const v: unknown = campo[i];
		return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null;
	};
	const result: PrevisaoDia[] = [];
	const vistos = new Set<string>();
	for (let i = 0; i < daily.time.length && result.length < 5; i++) {
		const data: unknown = daily.time[i];
		if (typeof data !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(data) || vistos.has(data)) continue;
		vistos.add(data);
		result.push({
			data,
			minimaC: valor(daily.temperature_2m_min, i),
			maximaC: valor(daily.temperature_2m_max, i),
			chuvaMm: valor(daily.precipitation_sum, i, 0),
			probabilidadeMaximaPct: valor(daily.precipitation_probability_max, i, 0, 100),
			rajadasKmh: valor(daily.wind_gusts_10m_max, i, 0),
			codigoTempo: valor(daily.weather_code, i, 0, 99),
		});
	}
	return result;
}

export interface PrevisaoCincoDias {
	dias: PrevisaoDia[];
	consultadoEm: number;
	resumos: Record<string, string>;
	fonteResumo: "ia" | "automatico";
	geradoEm: number;
	chaveResumo?: string;
}

/** Atualiza apenas no cron. O visitante recebe o resultado compartilhado no estado. */
export async function prepararPrevisao(
	dias: PrevisaoDia[], anterior: PrevisaoCincoDias | null, apiKey: string,
): Promise<PrevisaoCincoDias | null> {
	const agora = Date.now();
	if (!dias.length) return anterior && agora - anterior.consultadoEm < 12 * 3600_000 ? anterior : null;
	const chave = JSON.stringify(dias.slice(0, 2));
	const resumos: Record<string, string> = {};
	for (const d of dias) {
		const chuva = d.chuvaMm === null ? "O volume de chuva está indisponível." : `O modelo prevê ${d.chuvaMm.toLocaleString("pt-BR")} mm de chuva no dia.`;
		const temp = d.minimaC === null || d.maximaC === null ? "" : ` As temperaturas previstas ficam entre ${Math.round(d.minimaC)}° e ${Math.round(d.maximaC)}°.`;
		resumos[d.data] = chuva + temp;
	}
	if (anterior?.chaveResumo === chave && agora - anterior.geradoEm < 6 * 3600_000) {
		return { dias, consultadoEm: agora, resumos: { ...resumos, ...anterior.resumos }, fonteResumo: anterior.fonteResumo, geradoEm: anterior.geradoEm, chaveResumo: chave };
	}
	// A tentativa também tem intervalo mínimo, inclusive quando o provedor falha.
	if (anterior && agora - anterior.geradoEm < 6 * 3600_000) {
		return { dias, consultadoEm: agora, resumos, fonteResumo: "automatico", geradoEm: anterior.geradoEm, chaveResumo: chave };
	}
	if (apiKey) {
		try {
			const resposta = await fetch("https://openrouter.ai/api/v1/chat/completions", {
				method: "POST", signal: AbortSignal.timeout(8000),
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
				body: JSON.stringify({ model: "meta/muse-spark-1.3-contributor", temperature: 0, max_tokens: 300,
					messages: [{ role: "user", content: `Resuma a previsão para cada data separadamente, com uma frase curta em português. Use somente os dados fornecidos, sem acrescentar horário, risco, tempestade ou outras condições. Não escreva números. Responda apenas JSON objeto de data para frase. Dados: ${JSON.stringify(dias.slice(0, 2))}` }] }),
			});
			if (resposta.ok) {
				const payload = await resposta.json() as { choices?: { message?: { content?: string } }[] };
				const conteudo = payload.choices?.[0]?.message?.content?.trim() ?? "";
				const textos = JSON.parse(conteudo.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")) as Record<string, unknown>;
				// A IA apenas descreve o dia. Eventos e valores permanecem nas fontes numéricas.
				const novosResumos: Record<string, string> = {};
				for (const dia of dias.slice(0, 2)) {
					const t = textos[dia.data];
					if (typeof t !== "string" || t.length < 10 || t.length > 180 || /\d|tempestade|temporal|granizo|alerta|risco|manhã|tarde|noite|garantid/i.test(t)) throw new Error("Resumo inválido");
					novosResumos[dia.data] = t;
				}
				return { dias, consultadoEm: agora, resumos: { ...resumos, ...novosResumos }, fonteResumo: "ia", geradoEm: agora, chaveResumo: chave };
			}
		} catch { /* A previsão numérica continua disponível. */ }
	}
	return { dias, consultadoEm: agora, resumos, fonteResumo: "automatico", geradoEm: agora, chaveResumo: chave };
}

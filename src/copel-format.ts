import type { CopelOutage } from "./types.js";

/**
 * Rótulos legíveis das faixas de duração da API da Copel (faixa_duracao).
 * A API usa códigos como "ate_1h" / "1h_3h" — o cidadão merece ler
 * "até 1 hora" / "de 1 a 3 horas".
 */
const FAIXA_DURACAO_LABELS: Record<string, string> = {
	ate_1h: "até 1 hora",
	"1h_3h": "de 1 a 3 horas",
	"3h_6h": "de 3 a 6 horas",
	"6h_12h": "de 6 a 12 horas",
	"12h_24h": "de 12 a 24 horas",
	"24h_48h": "de 24 a 48 horas",
	mais_48h: "mais de 48 horas",
};

/** Traduz o código bruto da faixa de duração para texto legível. */
export function formatCopelDuration(faixaDuracao: string | null | undefined): string {
	if (!faixaDuracao) return "";
	return FAIXA_DURACAO_LABELS[faixaDuracao] ?? faixaDuracao;
}

/**
 * Mensagem de previsão de retorno consistente:
 * - Com previsão concreta da Copel → a previsão (data/hora).
 * - Sem previsão concreta mas com faixa de duração → "Estimativa: <faixa>".
 * - Sem nenhum dado → "Sem previsão".
 * (Correção 2026-08-12: antes a UI mostrava "Sem previsão ainda
 * (Estimativa: ate_1h)" — contraditório: dizia não haver previsão ao mesmo
 * tempo que mostrava a estimativa da Copel.)
 */
export function formatCopelPrevisao(
	outage: Pick<CopelOutage, "previsaoRestabelecimento" | "faixaDuracao">,
): string {
	if (outage.previsaoRestabelecimento) {
		return outage.previsaoRestabelecimento;
	}
	const dur = formatCopelDuration(outage.faixaDuracao);
	if (dur) return `Estimativa: ${dur}`;
	return "Sem previsão";
}

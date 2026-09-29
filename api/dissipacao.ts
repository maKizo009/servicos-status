import { loadConfig } from "../src/config.js";
import { initDb, lerAmostrasDissipacao, lerCiclosAlerta } from "../src/db.js";
import {
	agruparEpisodios,
	formatarRelatorioTexto,
	resumoDissipacao,
} from "../src/dissipacao.js";

/**
 * GET /api/dissipacao?dias=14 — relatório do livro da dissipação.
 *
 * Fica em produção (e não num script local) porque as credenciais do Turso só
 * existem no ambiente da Vercel: qualquer arquivo que eu grave aqui com esses
 * segredos é redigido. Auth: SÓ Bearer do CRON_SECRET (mesmo padrão fail-closed
 * do /api/cron) — o livro é leitura, mas expõe padrão de chuva da cidade.
 */
export default async function handler(req: any, res: any) {
	const responder = (corpo: unknown, status = 200) => {
		if (res && typeof res.status === "function") {
			return res.status(status).json(corpo);
		}
		return Response.json(corpo, { status });
	};
	try {
		const config = loadConfig();
		if (!config.cronSecret) return responder({ error: "Serviço indisponível" }, 503);
		const headers = req?.headers ?? {};
		const auth = headers.authorization ?? headers.Authorization ?? "";
		if (auth !== `Bearer ${config.cronSecret}`) {
			return responder({ error: "Não autorizado" }, 401);
		}

		const url = new URL(req?.url ?? "/", "http://local");
		const dias = Math.min(365, Math.max(1, Number(url.searchParams.get("dias") ?? 14)));

		await initDb();
		const amostras = await lerAmostrasDissipacao(Date.now() - dias * 24 * 3600_000);
		const nucleos = amostras.filter((a) => a.kind === "nucleo");
		// Alimenta TODAS as amostras (não só núcleos): só NÚCLEO abre episódio, mas
		// uma amostra de ÁREA continua o episódio aberto — é assim que a regressão
		// núcleo → área de chuva vira "dissipou no caminho" em vez de sumir do livro
		// (correção 29/09/2026). `agoraMs` marca os episódios ainda em curso.
		const episodios = agruparEpisodios(amostras, { agoraMs: Date.now() });
		// Persistência do alerta: os últimos ciclos de radar com a evidência severa
		// e a decisão (confirmado? quantos ciclos?). É a auditoria de POR QUE o
		// nível subiu/desceu — sem ela a persistência seria caixa-preta.
		const ciclos = await lerCiclosAlerta(Date.now() - 6 * 3600_000);

		return responder({
			dias,
			amostras: amostras.length,
			nucleos: nucleos.length,
			areas: amostras.length - nucleos.length,
			primeiraEm: amostras[0]?.medidoEm ?? null,
			ultimaEm: amostras[amostras.length - 1]?.medidoEm ?? null,
			resumo: resumoDissipacao(episodios),
			ciclos: ciclos.slice(-12),
			texto: formatarRelatorioTexto(episodios, dias),
		});
	} catch (err) {
		return responder({ error: String(err) }, 500);
	}
}

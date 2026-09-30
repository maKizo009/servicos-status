import { loadConfig } from "../src/config.js";
import { initDb } from "../src/db.js";
import {
	lerMedicoesChuva,
	lerPrevisoes,
	reconciliarPendentes,
} from "../src/previsoes.js";
import {
	agregarAcuracia,
	falsosNegativos,
	formatarRelatorioAcuracia,
} from "../src/reconciliacao.js";

/**
 * GET /api/reconciliacao?dias=14 — boletim de acurácia do monitor.
 *
 * Roda a reconciliação das apostas cuja janela fechou (grava o desfecho) e
 * devolve as métricas: falso positivo (alertou e não choveu), falso negativo
 * (choveu e não alertou), erro de ETA, erro de mm do ECMWF e atraso do
 * restabelecimento da Copel. É o relatório semanal que calibra os limiares
 * com número em vez de feeling.
 *
 * Como o /api/dissipacao: fica em produção porque as credenciais do Turso só
 * existem no ambiente da Vercel (localmente elas são redigidas). Auth: SÓ
 * Bearer do CRON_SECRET (fail-closed — expõe padrão de chuva da cidade).
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
		if (!config.cronSecret)
			return responder({ error: "Serviço indisponível" }, 503);
		const headers = req?.headers ?? {};
		const auth = headers.authorization ?? headers.Authorization ?? "";
		if (auth !== `Bearer ${config.cronSecret}`) {
			return responder({ error: "Não autorizado" }, 401);
		}

		const url = new URL(req?.url ?? "/", "http://local");
		const dias = Math.min(
			365,
			Math.max(1, Number(url.searchParams.get("dias") ?? 14)),
		);

		await initDb();
		// Reconcilia o que já tem desfecho (idempotente — só fecha abertas
		// cuja janela passou). Depois agrega TUDO do período, o que faz o
		// relatório ser estável mesmo quando uma aposta fecha hoje de uma
		// semana atrás.
		const feitas = await reconciliarPendentes();
		const desde = Date.now() - dias * 24 * 3600_000;
		const previsoes = await lerPrevisoes(desde);
		const medidas = await lerMedicoesChuva(desde);
		const avaliacoes = previsoes
			.filter((p) => p.desfecho != null && p.acertou != null)
			.map((p) => ({
				id: p.id,
				tipo: p.tipo,
				acertou: p.acertou === 1,
				desfecho: p.desfecho ?? {},
			}));
		const fn = falsosNegativos(medidas, previsoes);
		const resumo = agregarAcuracia(previsoes, avaliacoes, fn);

		return responder({
			dias,
			avalicoesNestaRodada: feitas.length,
			medicoesChuva: medidas.length,
			resumo,
			falsosNegativos: fn.slice(-10),
			ultimasAvaliacoes: avaliacoes.slice(-12),
			texto: formatarRelatorioAcuracia(resumo, dias, medidas.length),
		});
	} catch (err) {
		return responder({ error: String(err) }, 500);
	}
}

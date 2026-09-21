/**
 * Camada JEV (TypeSafe "System One Model") sobre a previsão determinística do
 * Bitumirim — o "outside decision layer" que o Dave pediu em 21/09/2026:
 *
 *   "O que realmente seria útil é uma predição: vai sair da calha? sim, não.
 *    Se sim, quando? ... com um nível de confiança, pra gente não tirar
 *    conclusões do nada e dar uma margem pro leitor interpretar."
 *
 * DIVISÃO DE TRABALHO (importante, não misturar):
 *   - Os NÚMEROS são determinísticos (bitumirim-previsao.ts): a regra por regime,
 *     os vizinhos históricos e a confiança com teto por tamanho de amostra.
 *     Isso é auditável e é a fonte da verdade.
 *   - O JEV julga o mesmo estado e devolve probabilidade tipada + confiança
 *     própria. Ele NUNCA substitui a regra: se discordar, os dois aparecem lado
 *     a lado e o leitor vê a divergência.
 *   - Sem key, a função devolve null e o site mostra só a camada determinística.
 *     Nunca inventa veredito.
 *
 * ACESSO (21/09/2026): o TypeSafe está em waitlist, e o Dave determinou "use no
 * openrouter" — então a rota do OpenRouter que o jev-router usava está FORA.
 * Caminho: key do TypeSafe ou do Vercel AI Gateway (typesafe-ai/jev).
 *
 * Env:
 *   TYPESAFE_API_KEY    (ou VERCEL_AI_GATEWAY_KEY / AI_GATEWAY_API_KEY)
 *   TYPESAFE_BASE_URL   (default https://api.typesafe.ai)
 *   TYPESAFE_MODEL      (default jev-latest)
 *   JEV_TIMEOUT_MS      (default 8000)
 */

export interface JevDecisaoCalha {
	/** Veredito do Jev para "vai sair da calha?" */
	vaiSair: "sim" | "nao" | "indefinido";
	/** Probabilidade crua que o Jev devolveu (0–1). */
	probVaiSair: number | null;
	/** Confiança declarada pelo próprio modelo (0–1). */
	confianca: number | null;
	/** "se sair, transborda (cheia grande)?" — separa transbordo de cheia passável. */
	transborda: "sim" | "nao" | "indefinido";
	probTransborda: number | null;
	modelo: string;
	fonte: string;
	/** Quanto tempo o Jev levou (ms) — o custo de latência fica visível. */
	ms: number;
}

/** Contexto que vai como `state` para o Jev. É o MESMO que alimenta a regra. */
export interface EstadoCalha {
	regime: string;
	chuvaLocal96h: string;
	diasPesados: number;
	uvaiaCm: number | null;
	antecedente30dMm: number | null;
	regraAplicada: string;
	vizinhos: string;
	historico: string;
	agora: string;
}

function montarState(e: EstadoCalha): string {
	return [
		"Rio Bitumirim, Ipiranga/PR (Bacia do Tibagi). Não existe régua automática no rio: a referência é a régua de campo (~4,0 m = saída da calha).",
		`Momento: ${e.agora}.`,
		`Regime hidrológico: ${e.regime}.`,
		`Chuva local medida nas duas estações do município (96 h): ${e.chuvaLocal96h}.`,
		`Dias com chuva de bacia (>=40 mm nas DUAS estações): ${e.diasPesados}.`,
		`Nível da sentinela a montante (Uvaia): ${e.uvaiaCm ?? "sem dado"} cm.`,
		`Chuva antecedente de 30 dias: ${e.antecedente30dMm ?? "sem dado"} mm.`,
		`Regra calibrada que se aplica agora: ${e.regraAplicada}`,
		`Casos históricos parecidos: ${e.vizinhos}.`,
		`Histórico de desfechos já observados: ${e.historico}`,
		"Fatos duros do histórico: nos invernos o rio já saiu da calha com apenas 6–21 mm de chuva local em 96 h (quem manda é a bacia). Em janeiro/2025 choveu 143 mm num único dia em uma estação do norte e o rio NÃO fez nada, porque a bacia estava vazia e a célula não pegou as duas estações. O nível da sentinela a montante NÃO separa transbordo de não-transbordo (2015 com 986 cm e 2025 com 168 cm tiveram desfechos trocados).",
	].join("\n");
}

const QUESTIONS = {
	vai_sair_da_calha: {
		type: "noul" as const,
		instructions:
			"Usando SOMENTE o estado fornecido, o rio vai sair da calha nas próximas 72 horas? Aplique os mesmos critérios da regra calibrada descrita no estado — não invente variáveis que não estão no estado.",
	},
	transborda_se_sair: {
		type: "noul" as const,
		instructions:
			"SE o rio sair da calha, o transbordo será grande (água acima do nível de passagem, atingindo áreas baixas e casas) em vez de uma cheia passável em que ainda se atravessa? Se o estado não permitir separar, responda com a menor confiança possível.",
	},
};

/** Bun: o fetch pode travar no corpo mesmo após abort — race é o fix (ver skill
 *  bunjs-http-reliability). Cancelar o timer do perdedor, senão o setTimeout
 *  pendente segura o event loop e a duração vira exatamente o timeout. */
const raceTimeout = <T,>(p: Promise<T>, ms: number, msg: string) =>
	new Promise<T>((resolve, reject) => {
		const t = setTimeout(() => reject(new Error(msg)), ms);
		p.then(
			(v) => {
				clearTimeout(t);
				resolve(v);
			},
			(e) => {
				clearTimeout(t);
				reject(e);
			},
		);
	});

type Answer = {
	noul?: boolean;
	probability?: number;
	confidence?: number;
};

function chave(): string {
	return (
		process.env.TYPESAFE_API_KEY ||
		process.env.VERCEL_AI_GATEWAY_KEY ||
		process.env.AI_GATEWAY_API_KEY ||
		""
	);
}

/** Existe key configurada? Usado para decidir se vale chamar (não gastar à toa). */
export function jevDisponivel(): boolean {
	return chave().length > 0;
}

/** Pergunta ao Jev se o rio sai da calha. null = sem key ou falhou (nunca chuta). */
export async function decidirCalhaComJev(
	estado: EstadoCalha,
): Promise<JevDecisaoCalha | null> {
	const key = chave();
	if (!key) return null;

	const base = (process.env.TYPESAFE_BASE_URL || "https://api.typesafe.ai").replace(
		/\/+$/,
		"",
	);
	const model = process.env.TYPESAFE_MODEL || "jev-latest";
	const timeoutMs = Number(process.env.JEV_TIMEOUT_MS || 8000);
	const t0 = Date.now();

	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), timeoutMs);
	try {
		const res = await raceTimeout(
			fetch(`${base}/v1/systemone`, {
				method: "POST",
				signal: ctl.signal,
				headers: {
					Authorization: `Bearer ${key}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					state: montarState(estado),
					model,
					questions: QUESTIONS,
				}),
			}),
			timeoutMs + 500,
			"Jev sem resposta (timeout via race)",
		);
		if (!res.ok) return null;
		const data = (await raceTimeout(
			res.json() as Promise<{
				answers?: Record<string, Answer>;
				model?: string;
			}>,
			timeoutMs,
			"Jev JSON sem resposta",
		)) as { answers?: Record<string, Answer>; model?: string };

		const a = data.answers?.vai_sair_da_calha;
		const b = data.answers?.transborda_se_sair;
		if (!a && !b) return null;
		const veredito = (x?: Answer): "sim" | "nao" | "indefinido" =>
			x?.noul === true ? "sim" : x?.noul === false ? "nao" : "indefinido";
		return {
			vaiSair: veredito(a),
			probVaiSair: typeof a?.probability === "number" ? a.probability : null,
			confianca: typeof a?.confidence === "number" ? a.confidence : null,
			transborda: veredito(b),
			probTransborda: typeof b?.probability === "number" ? b.probability : null,
			modelo: data.model ?? model,
			fonte: base.includes("openrouter") ? "openrouter" : "typesafe",
			ms: Date.now() - t0,
		};
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

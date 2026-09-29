/**
 * PERSISTÊNCIA da evidência severa entre ciclos (pedido do dono 29/09/2026).
 *
 * O problema que isto resolve (incidente ao vivo 29/09/2026): o ciclo é
 * recalculado do zero a cada ~10 min e o alerta não tinha memória. Um núcleo de
 * 38 dBZ — piso da faixa "forte" — que JÁ vinha enfraquecendo (43 → 38 dBZ no
 * ciclo anterior), isolado, a 64 km, apareceu UMA vez e promoveu LARANJA, que é o
 * nível que interrompe o celular. No ciclo seguinte o mesmo sistema virou área
 * moderada e o nível caiu para amarelo sozinho. Sem memória, toda aparição
 * isolada cutuca o celular; com memória, interromper exige CONFIRMAÇÃO.
 *
 * REGRA: a evidência severa tem que se SUSTENTAR em ≥ CICLOS_PARA_CONFIRMAR
 * ciclos consecutivos (o ciclo é o frame de radar, ~10 min). Uma aparição única
 * fica no amarelo (vigilância no site), sem push.
 *
 * Exceção que NÃO espera: emergência local — núcleo EXTREMO já dentro de
 * EMERGENCIA_KM. Aí o sistema está em cima da cidade; esperar 10 min para
 * "confirmar" seria trocar segurança por elegância.
 *
 * Downgrade continua IMEDIATO: se o ciclo atual não tem evidência severa, o
 * nível já cai (maleabilidade do tom, 27/09/2026). A persistência só trava a
 * SUBIDA — é assimetria proposital: errar para menos no aviso, nunca para mais
 * na interrupção.
 *
 * Falha de leitura do histórico NÃO pode virar "nunca mais alerta": o veredito
 * abre (fail-open) e o motivo fica explícito no log/card. Silêncio por banco
 * fora é o pior dos mundos.
 *
 * Tudo aqui é PURO (testável sem banco): a leitura/gravação fica no db.ts.
 */

/** Gap máximo entre dois ciclos para contá-los como consecutivos (ciclo ≈ 10 min). */
export const JANELA_CICLO_MIN = 25;
/** Ciclos consecutivos exigidos para interromper o celular (1 atual + 1 anterior). */
export const CICLOS_PARA_CONFIRMAR = 2;
/** Núcleo EXTREMO dentro deste raio não espera confirmação (emergência local). */
export const EMERGENCIA_KM = 50;

/** Uma linha da persistência: o que o ciclo viu e no que deu. */
export interface CicloEvidenciaSevera {
	/** Id do ciclo = timestamp do frame de radar analisado (epoch ms) */
	ts: number;
	/** Havia núcleo de tempestade (heavy/extreme) na zona iminente */
	nucleoSevero: boolean;
	/** Núcleo EXTREMO dentro de EMERGENCIA_KM (dispensa confirmação) */
	imediato: boolean;
	maxDbz: number | null;
	distKm: number | null;
	tendencia: string | null;
	kind: string | null;
	/** Nível do alerta unificado no ciclo (permite narrar transição sem cache) */
	nivel: string | null;
	/** Motivo textual da decisão (auditoria do porquê subiu/desceu) */
	motivo?: string | null;
}

export type MotivoPersistencia =
	| "sem_nucleo_severo"
	| "emergencia_imediata"
	| "confirmado"
	| "aguardando_confirmacao"
	| "historico_indisponivel";

export interface VereditoPersistencia {
	/** Pode interromper o celular (laranja/vermelho + push) */
	persistiu: boolean;
	/** Quantos ciclos consecutivos (incluindo o atual) sustentam a evidência */
	ciclosConsecutivos: number;
	motivo: MotivoPersistencia;
	/** Frase curta para log/card — diz o PORQUÊ de subir ou esperar */
	descricao: string;
}

/**
 * Conta quantos ciclos ANTERIORES consecutivos (antes de `agoraMs`) sustentam
 * evidência severa. Para no primeiro buraco de tempo, no primeiro ciclo sem
 * evidência e em linha do próprio ciclo atual (o cron pode rodar mais de uma vez
 * por frame — a linha do ciclo corrente é regravada, não contada duas vezes).
 */
export function contarCiclosConsecutivos(
	historico: CicloEvidenciaSevera[],
	agoraMs: number,
	janelaMin = JANELA_CICLO_MIN,
): number {
	const janela = janelaMin * 60_000;
	const ordenado = [...historico].sort((a, b) => b.ts - a.ts);
	let ciclos = 0;
	let anterior = agoraMs;
	for (const c of ordenado) {
		if (c.ts >= agoraMs) continue; // linha do ciclo atual ou do futuro
		if (anterior - c.ts > janela) break; // buraco: o ciclo se perdeu
		if (!c.nucleoSevero) break; // evidência caiu: a contagem recomeça
		ciclos += 1;
		anterior = c.ts;
	}
	return ciclos;
}

/**
 * Avalia se a evidência severa do ciclo atual está CONFIRMADA.
 * `historico: null` = a leitura do banco falhou → fail-open (com motivo).
 */
export function avaliarPersistencia(opts: {
	historico: CicloEvidenciaSevera[] | null;
	agoraMs: number;
	nucleoSeveroAgora: boolean;
	imediatoAgora?: boolean;
	ciclosParaConfirmar?: number;
	janelaMin?: number;
}): VereditoPersistencia {
	const exigidos = opts.ciclosParaConfirmar ?? CICLOS_PARA_CONFIRMAR;

	if (!opts.nucleoSeveroAgora) {
		return {
			persistiu: false,
			ciclosConsecutivos: 0,
			motivo: "sem_nucleo_severo",
			descricao: "sem núcleo de tempestade na zona iminente neste ciclo",
		};
	}

	if (opts.imediatoAgora) {
		return {
			persistiu: true,
			ciclosConsecutivos: 1,
			motivo: "emergencia_imediata",
			descricao: `núcleo extremo a ≤${EMERGENCIA_KM} km — emergência local, não espera confirmação`,
		};
	}

	if (opts.historico === null) {
		return {
			persistiu: true,
			ciclosConsecutivos: 1,
			motivo: "historico_indisponivel",
			descricao:
				"histórico de ciclos indisponível — evidência do ciclo aceita sem confirmação (segurança primeiro)",
		};
	}

	const anteriores = contarCiclosConsecutivos(
		opts.historico,
		opts.agoraMs,
		opts.janelaMin ?? JANELA_CICLO_MIN,
	);
	const ciclosConsecutivos = 1 + anteriores;

	if (ciclosConsecutivos >= exigidos) {
		return {
			persistiu: true,
			ciclosConsecutivos,
			motivo: "confirmado",
			descricao: `núcleo severo confirmado em ${ciclosConsecutivos} ciclos seguidos`,
		};
	}

	return {
		persistiu: false,
		ciclosConsecutivos,
		motivo: "aguardando_confirmacao",
		descricao:
			`núcleo severo no 1º ciclo (exige ${exigidos} ciclos seguidos) — ` +
			"vigiando antes de interromper o celular",
	};
}

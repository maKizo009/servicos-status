/**
 * Verificação do GATE do boletim (Camada B) — fixtures DETERMINÍSTICAS.
 *
 * História: este script nasceu em 21/09/2026 (incidente Guarujá: núcleo a 556 km
 * narrado como "pode chegar em Ipiranga"). A 1ª versão rodava com o nowcast AO
 * VIVO e comparava com um contra-factual — só que as asserções dependiam do clima
 * do dia: quando o radar passou a ter uma tempestade REAL em zona de vigilância,
 * as asserções "diz que está distante" falharam sem nenhum bug no código.
 * Verificação que depende do tempo que faz NÃO é verificação.
 *
 * Agora: busca o nowcast de produção apenas como ESQUELETO estrutural (frames,
 * movimento global, campos que o boletim lê) e injeta ameaças FIXAS. O resultado
 * é o mesmo em qualquer dia e cobre os casos que importam:
 *   A. núcleo distante em monitor   → NÃO narra como ameaça a Ipiranga
 *   B. mesmo núcleo sem a zona      → narra (prova que o gate é o que barra)
 *   C. ÁREA DE CHUVA moderada vindo → narra como "área de chuva", sem prometer
 *      tempestade (fix 21/09/2026: chuva contínua era invisível ao alerta)
 *
 * Uso: bun run scripts/verify-gate-boletim.ts
 */
import { buildAnalystContext, buildAnalystPrompt } from "../src/llm-bulletin.js";
import { passaCoerenciaAmeaca } from "../src/bulletin-coherence.js";
import { buildHeuristicBulletin } from "../src/nowcast-vlm.js";
import type {
	MovementVector,
	NowcastResult,
	ThreatCell,
	ThreatVerdict,
} from "../src/radar-analysis.js";

let falhas = 0;
function check(nome: string, cond: boolean, detalhe = "") {
	if (cond) console.log(`✅ ${nome}`);
	else {
		console.error(`❌ ${nome}${detalhe ? ` — ${detalhe}` : ""}`);
		falhas++;
	}
}

// ── esqueleto estrutural vindo de produção (frames/movimento globais reais)
const r = await fetch("https://servicos-status.vercel.app/api/weather");
const d = (await r.json()) as Record<string, unknown>;
const base = d.nowcast as NowcastResult | null;
if (!base?.frames?.length) {
	console.error("❌ API sem nowcast/frames — nada a verificar");
	process.exit(1);
}

const ecmwf = {
	rainProbabilityPct: (d.rainProbabilityPct as number) ?? null,
	hourlyForecast: (d.hourlyForecast as never[]) ?? [],
};
const relevance = {
	alertLevel:
		(d.alertLevel as "alert" | "watch" | "monitor" | "none") ?? "monitor",
	nearestThreatKm: (d.nearestThreatKm as number) ?? null,
};
const ests = ((d.cemaden as Record<string, unknown>)?.estacoes ?? []) as {
	acc1hr: number | null;
	acc6hr: number | null;
	acc24hr: number | null;
}[];
const local = {
	acc1hrMax: Math.max(0, ...ests.map((e) => e.acc1hr ?? 0)),
	acc6hrMax: Math.max(0, ...ests.map((e) => e.acc6hr ?? 0)),
	acc24hrMax: Math.max(0, ...ests.map((e) => e.acc24hr ?? 0)),
	condition: (d.condition as string) ?? null,
};

console.log(
	`=== ESQUELETO de produção: ${base.frames.length} frames | movimento global ${base.movement?.directionDeg}° a ${base.movement?.speedKmh} km/h ===`,
);

// ── fixtures ────────────────────────────────────────────────────────────────
function movimento(dir: number, speed: number): MovementVector {
	return {
		directionDeg: dir,
		speedKmh: speed,
		intervalMin: 10,
		dxPx: 0,
		dyPx: 0,
		fromLat: 0,
		fromLon: 0,
		toLat: 0,
		toLon: 0,
		confirmed: true,
	};
}
function veredicto(
	approach: ThreatVerdict["approach"],
	etaMin: number | null,
): ThreatVerdict {
	return {
		bearingFromTargetDeg: 300,
		radialKmh: approach === "approaching" ? -60 : 5,
		radialFraction: approach === "approaching" ? -1 : 0.1,
		approach,
		etaMin,
	};
}
function ameaca(over: Partial<ThreatCell>): ThreatCell {
	return {
		intensity: "extreme",
		pixelCount: 5000,
		maxDbz: 58,
		meanDbz: 40,
		centroidX: 120,
		centroidY: 90,
		lat: -24.2,
		lon: -51.5,
		trackedMovement: movimento(150, 60),
		distToTargetKm: 147,
		movement: movimento(150, 60),
		threat: veredicto("approaching", 80),
		relevanceZone: "watch",
		kind: "nucleo",
		...over,
	};
}

// A. núcleo distante (556 km) em MONITOR — o caso Guarujá.
const guaruja = ameaca({
	distToTargetKm: 556,
	lat: -24.0,
	lon: -46.3,
	threat: veredicto("crossing", null),
	relevanceZone: "monitor",
});
const ncA = { ...base, threats: [guaruja] } as NowcastResult;
const txtA = buildHeuristicBulletin(ncA, ecmwf, relevance, local);
console.log(`\nA. núcleo distante em monitor:\n  "${txtA}"`);
check(
	"A1. NÃO promete chegada a Ipiranga (sem ETA)",
	!/pode chegar em|chegada estimada em/i.test(txtA),
	txtA.slice(0, 110),
);
check(
	"A2. diz que está distante / sem influência",
	/distante|sem influência|Sem chuva relevante|não tem influência/i.test(txtA),
	txtA.slice(0, 110),
);

// B. PAR DISCRIMINANTE: mesmo núcleo a 150 km, mudando SÓ a zona. Se a zona é o
//    gate, monitor não promete chegada e watch promete. (A 1ª versão deste script
//    apagava a zona para simular o código antigo — mas o boletim tem DUAS
//    proteções: zona de relevância E o ramo de "longe" (>200 km). A 150 km só a
//    zona barra, então esse par isola o gate.)
const a150 = {
	distToTargetKm: 150,
	lat: -24.489,
	lon: -51.542,
	trackedMovement: movimento(151, 98),
	movement: movimento(151, 98),
	threat: veredicto("approaching", 60),
};
const txtMonitor = buildHeuristicBulletin(
	{ ...base, threats: [ameaca({ ...a150, relevanceZone: "monitor" })] } as NowcastResult,
	ecmwf,
	relevance,
	local,
);
const txtWatch = buildHeuristicBulletin(
	{ ...base, threats: [ameaca({ ...a150, relevanceZone: "watch" })] } as NowcastResult,
	ecmwf,
	relevance,
	local,
);
console.log(`\nB. núcleo a 150 km | monitor:\n  "${txtMonitor}"`);
console.log(`\nB. núcleo a 150 km | watch:\n  "${txtWatch}"`);
check(
	"B1. em monitor NÃO promete chegada (a zona barra o núcleo a 150 km)",
	!/chegada estimada em|pode chegar em/i.test(txtMonitor),
	txtMonitor.slice(0, 110),
);
check(
	"B2. em watch o MESMO núcleo vira narrativa com ETA (prova que é a zona)",
	/chegada estimada em|pode chegar em/i.test(txtWatch) && txtWatch !== txtMonitor,
	txtWatch.slice(0, 110),
);

// C. ÁREA DE CHUVA moderada vindo (fix 21/09/2026) — 113 km, ETA ~79 min.
const area = ameaca({
	intensity: "moderate",
	pixelCount: 4504,
	maxDbz: 28,
	meanDbz: 24,
	distToTargetKm: 113,
	lat: -24.489,
	lon: -51.542,
	trackedMovement: movimento(151, 98),
	movement: movimento(151, 98),
	threat: veredicto("approaching", 79),
	relevanceZone: "watch",
	kind: "area",
});
const ncC = { ...base, threats: [area] } as NowcastResult;
const txtC = buildHeuristicBulletin(ncC, ecmwf, relevance, local);
console.log(`\nC. área de chuva moderada a 113 km vindo:\n  "${txtC}"`);
check(
	"C1. narra como ÁREA DE CHUVA (não como núcleo/tempestade)",
	/Área de chuva/i.test(txtC) && !/Núcleo/i.test(txtC),
	txtC.slice(0, 110),
);
check(
	"C2. cita distância e chegada (chuva que está vindo DEVE aparecer)",
	/\b11[0-9] km\b/.test(txtC) && /chegada estimada em|pode chegar em/i.test(txtC),
	txtC.slice(0, 160),
);
check(
	"C3. não chama chuva moderada de 'muito forte' nem promete temporal",
	!/muito forte|temporal/i.test(txtC),
	txtC.slice(0, 160),
);

// D. contexto do ANALISTA (LLM): a área precisa chegar no prompt, com instrução
//    explícita para não dizer "nenhum núcleo por perto" com área preenchida.
const ctxC = buildAnalystContext(ncC, {
	local: null,
	condition: (d.condition as string) ?? null,
	ecmwfPct: ecmwf.rainProbabilityPct,
	ecmwfProx6hMm: (d.ecmwfProx6hMm as number) ?? null,
	alertLevel: "watch",
	hidroWatch: false,
	avisosOficiais: [],
});
const promptC = buildAnalystPrompt(ctxC.analyst);
console.log("\nD. prompt do analista (linhas de chuva):");
for (const linha of promptC.split("\n")) {
	if (/CHUVA EM IPIRANGA|NÍVEL DA|NÚCLEOS|ÁREAS DE CHUVA|área de chuva/.test(linha))
		console.log(`  | ${linha.slice(0, 160)}`);
}
check(
	"D1. prompt do analista tem bloco ÁREAS DE CHUVA",
	promptC.includes("ÁREAS DE CHUVA"),
);
check(
	"D2. prompt descreve a área com distância e ETA",
	/área de chuva moderada .*\b11[0-9] km\b/i.test(promptC),
);
check(
	"D3. instrução proíbe 'nenhum núcleo por perto' a ≤200 km (núcleo OU área)",
	promptC.includes('PROIBIDO escrever "nenhum núcleo por perto"') &&
		promptC.includes("deve aparecer no boletim".replace("deve", "DEVE")),
);
check(
	"D4. tipo de ameaça (kind) chega ao contexto do analista",
	ctxC.analyst.threats[0]?.kind === "area",
	`deu ${ctxC.analyst.threats[0]?.kind}`,
);

// E. CENÁRIO REAL de 21/09 22:55 em produção: núcleo muito forte (58 dBZ) a
//    147 km, zona watch. O boletim do LLM dizia "nenhum núcleo por perto" E
//    descrevia o núcleo na frase seguinte — contradição que o Dave reportou.
//    A heurística tem de narrar com distância + ETA, e o prompt do analista tem
//    de PROIBIR a frase.
const real147 = ameaca({ distToTargetKm: 147, relevanceZone: "watch" });
const ncE = { ...base, threats: [real147] } as NowcastResult;
const txtE = buildHeuristicBulletin(ncE, ecmwf, relevance, local);
console.log(`\nE. núcleo a 147 km em vigilância (caso real):\n  "${txtE}"`);
check(
	"E1. narra com distância e chegada (não engole o núcleo em vigilância)",
	// A distância do boletim vem do haversine (lat/lon da fixture), não do campo
	// distToTargetKm — por isso a asserção aceita a faixa de 3 dígitos.
	/\b1[0-9]{2} km\b/.test(txtE) && /chegada estimada em|pode chegar em/i.test(txtE),
	txtE.slice(0, 130),
);
check(
	"E2. não abre dizendo que não há nada por perto com núcleo a ≤200 km",
	!/^Sem chuva relevante|nenhum núcleo por perto/i.test(txtE),
	txtE.slice(0, 130),
);
const ctxE = buildAnalystContext(ncE, {
	local: null,
	condition: (d.condition as string) ?? null,
	ecmwfPct: ecmwf.rainProbabilityPct,
	ecmwfProx6hMm: (d.ecmwfProx6hMm as number) ?? null,
	alertLevel: "watch",
	hidroWatch: false,
	avisosOficiais: [],
});
const promptE = buildAnalystPrompt(ctxE.analyst);
check(
	"E3. prompt lista o núcleo em português (sem enum cru 'heavy/extreme')",
	/núcleo de chuva muito forte \(temporal\) em .*\b14[0-9] km\b, se aproximando, ETA/i.test(
		promptE,
	),
	promptE.split("\n").find((l) => l.startsWith("- ")) ?? "(sem linha)",
);
check(
	"E4. prompt proíbe a frase contraditória também no caso de núcleo",
	promptE.includes('PROIBIDO escrever "nenhum núcleo por perto"'),
);

// F. GATE DE COERÊNCIA (determinístico, módulo puro): o texto do boletim não pode
//    contradizer o radar. Nasceu do caso real 21/09 22:55 — LLM escreveu "nenhum
//    núcleo por perto" com núcleo de 58 dBZ a 147 km em vigilância, e o texto
//    ficou 30 min no cache. Prompt não segura modelo; gate determinístico segura.
const incoerente =
	"Em Ipiranga não há chuva medida agora e nenhum núcleo por perto. O modelo indica 79 por cento de chance de chuva.";
check(
	"F1. rejeita 'nenhum núcleo por perto' com entidade em watch a ≤200 km",
	!passaCoerenciaAmeaca(incoerente, [
		{ distToTargetKm: 147, relevanceZone: "watch" },
	]),
);
check(
	"F2. aceita o mesmo texto quando nada está em watch/alert (radar não contradiz)",
	passaCoerenciaAmeaca(incoerente, [
		{ distToTargetKm: 147, relevanceZone: "monitor" },
	]),
);
const coerente =
	"Núcleo de chuva forte em Palmital, a 147 km de Ipiranga, se aproximando e pode chegar em cerca de 80 minutos.";
check(
	"F3. aceita texto coerente que cita a distância",
	passaCoerenciaAmeaca(coerente, [
		{ distToTargetKm: 147, relevanceZone: "watch" },
	]),
);
check(
	"F4. rejeita texto que OMITE a distância com entidade relevante",
	!passaCoerenciaAmeaca("Chuva se aproximando da região.", [
		{ distToTargetKm: 147, relevanceZone: "watch" },
	]),
);
check(
	"F5. em zona de ALERTA exige urgência no texto",
	!passaCoerenciaAmeaca("Chuva moderada a 70 km de Ipiranga se aproximando.", [
		{ distToTargetKm: 70, relevanceZone: "alert" },
	]),
);
check(
	"F6. e aceita o mesmo com urgência explícita",
	passaCoerenciaAmeaca(
		"Alerta: chuva a 70 km de Ipiranga, chegando nas próximas 2 horas.",
		[{ distToTargetKm: 70, relevanceZone: "alert" }],
	),
);
check("F7. texto vazio nunca passa", !passaCoerenciaAmeaca("", []));

console.log(
	`\n${falhas === 0 ? "✅ GATE VERIFICADO (fixtures determinísticas)" : `❌ ${falhas} VERIFICAÇÃO(ÕES) FALHARAM`}`,
);
process.exit(falhas === 0 ? 0 : 1);

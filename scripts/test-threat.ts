/**
 * Teste da análise de ameaça: veredicto + projeção de trajetória.
 * Cenário real: núcleo em Guaraqueçaba (-25.159, -48.5402) movendo 91° L.
 * Uso: bun run scripts/test-threat.ts
 *
 * Regressões cobertas (regras do Dave, 21/09/2026):
 *  - GATE DE DIREÇÃO ±60°: núcleo quase tangencial não é "aproximando"
 *    (caso real: Guarujá/SP a 556 km narrado como "pode chegar em Ipiranga")
 *  - TETO DE DISTÂNCIA (250 km): além disso é SEMPRE monitor
 *  - ETA MÁXIMO (24 h): acima disso não é ETA de nowcast
 *  - REVERSÃO DE RUMO entre pares consecutivos: vetor descartado
 *    ("núcleo que se move em direção contrária é ruído")
 */
import { getMunicipioComFallback } from "../src/geo-municipio.js";
import {
	assessAllThreats,
	assessThreat,
	classifyRelevanceZone,
	ETA_MAX_MIN,
	type FrameAnalysis,
	haversineKm,
	formatRainEntityAlert,
	markReversals,
	MODERATE_AREA_MIN_PX_AT_256,
	projectCell,
	type RainCell,
	RELEVANCE_ZONES,
} from "../src/radar-analysis.js";

const IPIRANGA = { lat: -25.0244, lon: -50.5847 };
let falhas = 0;

function check(nome: string, cond: boolean, detalhe = "") {
	if (cond) console.log(`✅ ${nome}`);
	else {
		console.error(`❌ ${nome}${detalhe ? ` — ${detalhe}` : ""}`);
		falhas++;
	}
}

function describe(
	nome: string,
	lat: number,
	lon: number,
	dir: number,
	speed: number,
	mostrarProjecao = true,
) {
	const v = assessThreat(
		lat,
		lon,
		{ directionDeg: dir, speedKmh: speed },
		IPIRANGA.lat,
		IPIRANGA.lon,
	);
	const { municipio } = getMunicipioComFallback(lat, lon, haversineKm);
	const d = haversineKm(lat, lon, IPIRANGA.lat, IPIRANGA.lon);
	const zona = classifyRelevanceZone(d, v.approach, v.etaMin, "extreme", speed);
	console.log(`\n=== ${nome} ===`);
	console.log(
		`  núcleo: ${municipio?.nome} (${lat.toFixed(2)}, ${lon.toFixed(2)}) | ${Math.round(d)} km de Ipiranga`,
	);
	console.log(`  movimento: ${dir}° a ${speed} km/h`);
	console.log(
		`  veredicto: ${v.approach} (radial ${v.radialKmh.toFixed(1)} km/h, fração ${v.radialFraction.toFixed(2)})${v.etaMin ? ` | ETA ~${Math.round(v.etaMin)} min` : ""} | zona: ${zona}`,
	);
	if (mostrarProjecao) {
		const proj = [30, 60, 120].map((t) => {
			const p = projectCell(
				lat,
				lon,
				{ directionDeg: dir, speedKmh: speed },
				t,
			);
			const pm = getMunicipioComFallback(p.lat, p.lon, haversineKm);
			return `${pm.municipio?.nome} (${t}min)`;
		});
		console.log(`  projeção: ${proj.join(" → ")}`);
	}
	return { v, zona, d };
}

// 1. O caso real reportado pelo Dave (Guaraqueçaba, L)
const c1 = describe(
	"CASO REAL (Guaraqueçaba → L)",
	-25.159,
	-48.5402,
	91,
	36.3,
);
check(
	"1. Guaraqueçaba indo pra L = afastando (receding)",
	c1.v.approach === "receding",
	`deu ${c1.v.approach}`,
);

// 2. Caso oposto: núcleo a oeste indo para leste = APROXIMANDO
const c2 = describe(
	"Núcleo a OESTE indo para L (deve APROXIMAR)",
	-25.1,
	-52.5,
	91,
	40,
);
check(
	"2. Núcleo a Oeste indo pra L = aproximando",
	c2.v.approach === "approaching",
	`deu ${c2.v.approach}`,
);

// 3. Caso tangencial: núcleo ao norte indo para leste
const c3 = describe(
	"Núcleo ao NORTE indo para L (tangencial)",
	-24.2,
	-50.5,
	91,
	40,
);
check(
	"3. Tangencial (N indo pra L) = crossing",
	c3.v.approach === "crossing",
	`deu ${c3.v.approach}`,
);

// 4. Ponta Grossa a 200° (SSW): passa a ~43 km de lado, NÃO chega em Ipiranga.
//    ATUALIZADO 21/09/2026: antes o radial pequeno (-5 de 30 km/h) marcava
//    "approaching" e o núcleo virava ameaça — é o falso positivo que o Dave
//    descreveu ("a seta aponta pra outra direção e o modelo acha que volta").
const c4 = describe(
	"Ponta Grossa → 200° SSW (passa de lado, NÃO chega)",
	-25.095,
	-50.158,
	200,
	30,
	false,
);
check(
	"4. PG a 200° = crossing (passa de lado)",
	c4.v.approach === "crossing",
	`deu ${c4.v.approach}`,
);

// 5. ⭐ CASO GUARUJÁ — a regressão que motivou tudo (boletim de 20/09 22:20).
//    Núcleo a 556 km, bearing 76°, movimento 327° a 11,4 km/h: radial −3,7
//    (32% da velocidade) marcava "approaching" e o VLM narrava "chuva forte
//    em Guarujá SP ... pode chegar em cerca de 19 horas".
const guaruja = projectCell(
	IPIRANGA.lat,
	IPIRANGA.lon,
	{ directionDeg: 76, speedKmh: 556 },
	60,
);
const c5 = describe(
	"CASO GUARUJÁ (556 km, 327° a 11,4 km/h)",
	guaruja.lat,
	guaruja.lon,
	327,
	11.4,
	false,
);
check(
	"5a. Guarujá = crossing (não 'approaching')",
	c5.v.approach === "crossing",
	`deu ${c5.v.approach}`,
);
check(
	"5b. Guarujá sem ETA (não inventa chegada)",
	c5.v.etaMin === null,
	`deu ${c5.v.etaMin}`,
);
check(
	"5c. Guarujá na zona monitor (não vira boletim)",
	c5.zona === "monitor",
	`deu ${c5.zona}`,
);
check(
	"5d. fração radial do Guarujá ≈ −0,33 (32% da velocidade)",
	Math.abs(c5.v.radialFraction + 0.326) < 0.01,
	`deu ${c5.v.radialFraction.toFixed(3)}`,
);
check(
	"5e. distância medida ≈ 556 km",
	Math.abs(c5.d - 556) < 2,
	`deu ${c5.d.toFixed(1)}`,
);

// 6. Controle positivo: núcleo a 60 km vindo DIRETO pra Ipiranga tem que
//    continuar dando approaching + alerta (senão o gate virou falso negativo).
const direto = projectCell(
	IPIRANGA.lat,
	IPIRANGA.lon,
	{ directionDeg: 100, speedKmh: 60 },
	60,
);
const c6 = describe(
	"CONTROLE: 60 km vindo direto (deve ALERTAR)",
	direto.lat,
	direto.lon,
	280,
	40,
	false,
);
check(
	"6a. Núcleo vindo direto = approaching",
	c6.v.approach === "approaching",
	`deu ${c6.v.approach}`,
);
check(
	"6b. ETA ~90 min",
	c6.v.etaMin != null && Math.abs(c6.v.etaMin - 90) < 2,
	`deu ${c6.v.etaMin}`,
);
check("6c. Zona alert", c6.zona === "alert", `deu ${c6.zona}`);

// 7. ETA absurdo: 200 km a 5 km/h = 40 h. Não é ETA → sem número, monitor.
const c7 = describe(
	"200 km a 5 km/h (ETA de 40 h = absurdo)",
	-25.1,
	-52.5,
	91,
	5,
	false,
);
check("7a. ETA absurdo vira null", c7.v.etaMin === null, `deu ${c7.v.etaMin}`);
check("7b. Zona monitor", c7.zona === "monitor", `deu ${c7.zona}`);
check("7c. ETA_MAX_MIN é 1440 (24 h)", ETA_MAX_MIN === 1440);
check("7d. Teto de relevância é 250 km", RELEVANCE_ZONES.maxRelevantKm === 250);

// 8. Reversão de rumo: vetor com flag reversal nunca vira aproximação.
const c8 = describe(
	"Rumo INVERTIDO (flag reversal)",
	-25.1,
	-52.5,
	91,
	40,
	false,
);
const vRev = assessThreat(
	-25.1,
	-52.5,
	{ directionDeg: 91, speedKmh: 40, reversal: true },
	IPIRANGA.lat,
	IPIRANGA.lon,
);
check(
	"8a. Vetor com reversal = crossing",
	vRev.approach === "crossing",
	`deu ${vRev.approach}`,
);
check("8b. Vetor com reversal sem ETA", vRev.etaMin === null);
check("8c. Flag reversal marcada no veredito", vRev.reversal === true);
void c8;

// 9. markReversals: núcleo que anda 90° e depois 270° (inverteu) é ruído;
//    núcleo que mantém o rumo é confirmado.
function celula(
	lat: number,
	lon: number,
	mv: RainCell["trackedMovement"],
): RainCell {
	return {
		intensity: "extreme",
		pixelCount: 5000,
		maxDbz: 55,
		meanDbz: 48,
		centroidX: 128,
		centroidY: 128,
		lat,
		lon,
		trackedMovement: mv,
	};
}
const mv = (
	dir: number,
	fromLat: number,
	fromLon: number,
	toLat: number,
	toLon: number,
) => ({
	directionDeg: dir,
	speedKmh: 40,
	intervalMin: 10,
	dxPx: 4,
	dyPx: 4,
	fromLat,
	fromLon,
	toLat,
	toLon,
});
function frames(celC: RainCell): FrameAnalysis[] {
	// A (antigo) → B (meio, andou pra LESTE) → C (novo)
	const A = { time: 0, cells: [celula(0, 0, null)], maxDbz: 55, coverage: 0.1 };
	const B = {
		time: 600_000,
		cells: [celula(0, 0.01, mv(90, 0, 0, 0, 0.01))],
		maxDbz: 55,
		coverage: 0.1,
	};
	const C = { time: 1_200_000, cells: [celC], maxDbz: 55, coverage: 0.1 };
	return [A, B, C];
}
// 9a. C voltou pra OESTE (270°) → inverteu o rumo → reversal
const rev = celula(0, 0, mv(270, 0, 0.01, 0, 0));
const fRev = frames(rev);
markReversals(fRev);
check(
	"9a. Rumo invertido (90° → 270°) = reversal",
	fRev[2].cells[0].trackedMovement?.reversal === true,
);
check(
	"9b. Guarda o rumo anterior pra auditoria",
	fRev[2].cells[0].trackedMovement?.previousDirectionDeg === 90,
	`deu ${fRev[2].cells[0].trackedMovement?.previousDirectionDeg}`,
);
// 9c. C continuou pra LESTE → rumo consistente → confirmado
const ok = celula(0, 0.02, mv(90, 0, 0.01, 0, 0.02));
const fOk = frames(ok);
markReversals(fOk);
check(
	"9c. Rumo consistente (90° → 90°) = confirmed",
	fOk[2].cells[0].trackedMovement?.confirmed === true,
);
check(
	"9d. Rumo consistente NÃO tem flag de reversal",
	!fOk[2].cells[0].trackedMovement?.reversal,
);
// 9e. Núcleo sem histórico (só no último par) = confirmed false
const semHist = celula(0, 5, mv(90, 0, 4.99, 0, 5));
const fSem = frames(semHist);
markReversals(fSem);
check(
	"9e. Sem par anterior = confirmed false",
	fSem[2].cells[0].trackedMovement?.confirmed === false,
);
check(
	"9f. Sem par anterior NÃO é reversal",
	!fSem[2].cells[0].trackedMovement?.reversal,
);

// ==========================================================================
// 10. ÁREA DE CHUVA MODERADA (fix 21/09/2026) — a regressão que motivou tudo.
//     Caso real 19:30 BRT: área de chuva moderada (28 dBZ) de 4.504 px no tile
//     512 a 113 km de Ipiranga (NW), movendo 151° a 98 km/h → ETA ~69 min.
//     Antes deste fix o gate só olhava heavy/extreme, então o site dizia
//     "nenhum núcleo por perto" e narrava um núcleo de 279 px a 153 km,
//     enquanto 10.554 px de chuva a ≤80 km eram ignorados (verify-anel-radar).
// ==========================================================================

/** Desloca um ponto (bearing 0=N, sentido horário) por km — Web Mercator local. */
function deslocar(lat: number, lon: number, bearingDeg: number, km: number) {
	const rad = (bearingDeg * Math.PI) / 180;
	const dLat = (km * Math.cos(rad)) / 111.32;
	const dLon = (km * Math.sin(rad)) / (111.32 * Math.cos((lat * Math.PI) / 180));
	return { lat: lat + dLat, lon: lon + dLon };
}

const areaReal = {
	lat: -24.489,
	lon: -51.542,
	pixelCount: 4504, // @512 (tileSize passado no assess)
	maxDbz: 28,
	meanDbz: 24,
	centroidX: 120,
	centroidY: 80,
	intensity: "moderate" as const,
	trackedMovement: { directionDeg: 151, speedKmh: 98, confirmed: true },
};
const th10 = assessAllThreats([areaReal], IPIRANGA.lat, IPIRANGA.lon, 512);
check(
	"10a. Área moderada de 4.504 px @512 vira ameaça avaliada (era invisível)",
	th10.length === 1,
	`deu ${th10.length} ameaça(s)`,
);
check(
	'10b. Vem marcada como kind="area" (não "nucleo")',
	th10[0]?.kind === "area",
	`deu ${th10[0]?.kind}`,
);
check(
	"10c. Área aproximando (movimento 151° rumo a Ipiranga)",
	th10[0]?.threat?.approach === "approaching",
	`deu ${th10[0]?.threat?.approach}`,
);
check(
	"10d. ETA ~80 min (113 km na velocidade RADIAL: 98 km/h × cos(29°) ≈ 86 km/h)",
	Math.abs((th10[0]?.threat?.etaMin ?? 0) - 80) < 10,
	`deu ${th10[0]?.threat?.etaMin?.toFixed(0)} min`,
);
check(
	"10e. Zona de relevância = watch (113 km, fora do gate de alerta ≤80 km)",
	th10[0]?.relevanceZone === "watch",
	`deu ${th10[0]?.relevanceZone}`,
);

// 11. A mesma área já dentro do gate de alerta (75 km): vira ALERTA.
const ponto75 = deslocar(IPIRANGA.lat, IPIRANGA.lon, 315, 75);
const th11 = assessAllThreats(
	[{ ...areaReal, lat: ponto75.lat, lon: ponto75.lon }],
	IPIRANGA.lat,
	IPIRANGA.lon,
	512,
);
check(
	"11. Área moderada a 75 km aproximando = ALERTA (≤80 km + ETA ≤120 min)",
	th11[0]?.relevanceZone === "alert",
	`deu ${th11[0]?.relevanceZone}`,
);

// 12. Área moderada GRANDE mas longe (>250 km) continua fora: teto de distância.
const ponto300 = deslocar(IPIRANGA.lat, IPIRANGA.lon, 315, 300);
const th12 = assessAllThreats(
	[{ ...areaReal, lat: ponto300.lat, lon: ponto300.lon, pixelCount: 9000 }],
	IPIRANGA.lat,
	IPIRANGA.lon,
	512,
);
check(
	"12. Área moderada a 300 km = monitor (teto de 250 km preservado)",
	th12.length === 0 || th12[0]?.relevanceZone === "monitor",
	`deu ${th12[0]?.relevanceZone ?? "fora da lista"}`,
);

// 13. GAROA moderada pequena (240 px @512 = 60 @256) NÃO pode virar ameaça —
//     senão todo chuvisco grande vira alerta (ruído).
const th13 = assessAllThreats(
	[{ ...areaReal, pixelCount: 240 }],
	IPIRANGA.lat,
	IPIRANGA.lon,
	512,
);
check(
	"13. Garoa moderada de 60 px @256 fica FORA (piso de área)",
	th13.length === 0,
	`deu ${th13.length} ameaça(s)`,
);

// 14. Núcleo heavy pequeno continua entrando (comportamento antigo intacto).
const th14 = assessAllThreats(
	[
		{
			...areaReal,
			pixelCount: 50,
			maxDbz: 42,
			intensity: "heavy" as const,
		},
	],
	IPIRANGA.lat,
	IPIRANGA.lon,
	512,
);
check(
	'14. Núcleo heavy de 50 px @512 continua sendo ameaça kind="nucleo"',
	th14.length === 1 && th14[0]?.kind === "nucleo",
	`deu ${th14.length} ameaça(s), kind ${th14[0]?.kind}`,
);

// 15. O piso de área escala com a resolução (256 x 512) — sem isto, o mesmo
//     sistema julgaria diferente em z6 e z7.
check(
	"15. Piso de área documentado escala com a resolução (250 @256 → 1000 @512)",
	MODERATE_AREA_MIN_PX_AT_256 === 250 &&
		assessAllThreats(
			[{ ...areaReal, pixelCount: 999 }],
			IPIRANGA.lat,
			IPIRANGA.lon,
			512,
		).length === 0,
	"piso não escalou",
);

// 16. TEXTO do alerta: área x núcleo. Núcleo TEM que continuar idêntico ao que
//     a produção emitiu em 21/09 19:30 (regressão de texto é regressão de UX).
const txtAreaWatch = formatRainEntityAlert({
	level: "watch",
	kind: "area",
	intensity: "moderate",
	distKm: 113,
	approach: "approaching",
	etaMin: 79,
});
check(
	"16a. Área moderada em watch fala 'área de chuva moderada' (não núcleo/forte)",
	txtAreaWatch.includes("área de chuva moderada") &&
		!txtAreaWatch.includes("núcleo") &&
		!txtAreaWatch.includes("forte"),
	txtAreaWatch,
);
check(
	"16b. Área em watch cita distância e chegada",
	txtAreaWatch.includes("~113 km") && txtAreaWatch.includes("chegada em ~79 min"),
	txtAreaWatch,
);
const txtNucleoWatch = formatRainEntityAlert({
	level: "watch",
	kind: "nucleo",
	intensity: "heavy",
	distKm: 153,
	approach: "approaching",
	etaMin: 113,
});
check(
	"16c. Núcleo em watch = texto IDÊNTICO ao que a produção emitiu em 21/09 19:30",
	txtNucleoWatch ===
		"👁️ Vigilância: núcleo de chuva forte detectado a ~153 km de Ipiranga (chegada em ~113 min). Sem alerta iminente, acompanhe.",
	txtNucleoWatch,
);
const txtAreaAlert = formatRainEntityAlert({
	level: "alert",
	kind: "area",
	intensity: "moderate",
	distKm: 74,
	approach: "approaching",
	etaMin: 45,
});
check(
	"16d. Área iminente (alerta) fala de acumulados e NÃO promete rede elétrica",
	txtAreaAlert.startsWith("🌧️ Área de chuva moderada detectada") &&
		txtAreaAlert.includes("acumulados") &&
		!txtAreaAlert.includes("COPEL"),
	txtAreaAlert,
);
const txtNucleoAlert = formatRainEntityAlert({
	level: "alert",
	kind: "nucleo",
	intensity: "extreme",
	distKm: 60,
	approach: "approaching",
	etaMin: 30,
});
check(
	"16e. Núcleo iminente mantém o aviso de rede elétrica (COPEL)",
	txtNucleoAlert.startsWith("🌩️ Núcleo de chuva muito forte (temporal) detectado") &&
		txtNucleoAlert.includes("COPEL"),
	txtNucleoAlert,
);
check(
	"16f. Sem ETA (movimento incerto) o texto não inventa tempo de chegada",
	!formatRainEntityAlert({
		level: "watch",
		kind: "area",
		intensity: "moderate",
		distKm: 120,
		approach: "crossing",
		etaMin: null,
	}).includes("chegada em"),
);

console.log(
	`\n${falhas === 0 ? "✅ TODOS OS CASOS PASSARAM" : `❌ ${falhas} CASO(S) FALHARAM`}`,
);
process.exit(falhas === 0 ? 0 : 1);

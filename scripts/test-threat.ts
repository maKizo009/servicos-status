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
	assessThreat,
	classifyRelevanceZone,
	ETA_MAX_MIN,
	type FrameAnalysis,
	haversineKm,
	markReversals,
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

console.log(
	`\n${falhas === 0 ? "✅ TODOS OS CASOS PASSARAM" : `❌ ${falhas} CASO(S) FALHARAM`}`,
);
process.exit(falhas === 0 ? 0 : 1);

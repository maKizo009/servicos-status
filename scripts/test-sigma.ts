/**
 * Teste do feed Sigma: parser (mapa de colunas), sanidade da pressão, gate de
 * cidade com núcleo e — o que importa — bateria AO VIVO contra o site.
 * Uso: bun run scripts/test-sigma.ts
 *
 * O teste ao vivo é deliberado: o parse só é confiável se os números fecharem
 * com o relógio (frescor) e a sanidade (pressão atual entre mín e máx).
 */
import {
	CIDADES_CORREDOR,
	caminhoArquivo,
	cidadesComNucleo,
	estacoesProximas,
	fetchSigmaRede,
	localParaEpoch,
	parseSigmaLinha,
	resumoSolo,
	SIGMA_FRESCOR_MAX_MIN,
	type SigmaEstacao,
	validarSanidade,
} from "../src/sigma-feed.js";

let falhas = 0;
function check(nome: string, cond: boolean, detalhe = "") {
	if (cond) console.log(`✅ ${nome}`);
	else {
		console.error(`❌ ${nome}${detalhe ? ` — ${detalhe}` : ""}`);
		falhas++;
	}
}

console.log("=== 1. PARSER (linha sintética com valores conhecidos) ===");
// Layout oficial: lat lon id ts temp ... vento dir raj1h .. chuva1h chuva24h
// ... raj24 .. pMax24 pMin24 pAtual .. rede .. acum .. rio  nome UF rede
const campos = new Array(50).fill("-999.9");
campos[0] = "-25.4672"; // lat
campos[1] = "-50.6511"; // lon
campos[2] = "12345"; // id
campos[3] = "2026-09-20_22:32"; // atualização (local)
campos[4] = "18.5"; // temp
campos[7] = "88.0"; // umidade
campos[16] = "12.2"; // vento
campos[17] = "285.0"; // direção
campos[18] = "22.0"; // rajada 1h
campos[20] = "3.4"; // chuva 1h
campos[21] = "18.9"; // chuva 24h
campos[30] = "41.7"; // rajada 24h
campos[31] = "Teste_-_Irati_(816_m)"; // nome
campos[34] = "1006.13"; // pressão MÁX 24h
campos[35] = "1001.32"; // pressão MÍN 24h
campos[36] = "1004.10"; // pressão atual
campos[41] = "WU";
campos[45] = "2.31"; // nível do rio
const linha = campos.join(" ");

const agoraMs = Date.UTC(2026, 8, 21, 1, 37); // 21/09 01:37 UTC = 22:37 local
const est = parseSigmaLinha(linha, agoraMs);
check("1a. Parser aceita a linha", est != null);
if (est) {
	check("1b. lat/lon", est.lat === -25.4672 && est.lon === -50.6511);
	check(
		"1c. rajada 1h = 22,0",
		est.rajada1hKmh === 22,
		`deu ${est.rajada1hKmh}`,
	);
	check("1d. chuva 1h = 3,4", est.chuva1hMm === 3.4, `deu ${est.chuva1hMm}`);
	check(
		"1e. chuva 24h = 18,9",
		est.chuva24hMm === 18.9,
		`deu ${est.chuva24hMm}`,
	);
	check(
		"1f. rajada 24h = 41,7",
		est.rajada24hKmh === 41.7,
		`deu ${est.rajada24hKmh}`,
	);
	check(
		"1g. nome sem underscores",
		est.nome === "Teste - Irati (816 m)",
		`deu ${est.nome}`,
	);
	check("1h. vento/direção", est.ventoKmh === 12.2 && est.ventoDirDeg === 285);
	check(
		"1i. nível do rio = 2,31",
		est.nivelRioM === 2.31,
		`deu ${est.nivelRioM}`,
	);
	// Queda de pressão: máx 1006,13 − atual 1004,10 = 2,03 → 2,0
	check(
		"1j. queda de pressão 24h = 2,0 hPa",
		est.quedaPressao24Hpa === 2,
		`deu ${est.quedaPressao24Hpa}`,
	);
	// 22:32 local (UTC-3) = 01:32 UTC; agora 01:37 UTC → 5 min
	check("1k. frescor = 5 min", est.frescorMin === 5, `deu ${est.frescorMin}`);
	check("1l. não está stale", est.stale === false);
	check("1m. rede = WU", est.rede === "WU", `deu ${est.rede}`);
}
// "-999.9" tem que virar null, NUNCA 0 (0 = "não choveu")
const semChuva = parseSigmaLinha(linha.replace("3.4", "-999.9"), agoraMs);
check(
	"1n. sentinela -999.9 vira null (não 0)",
	semChuva?.chuva1hMm === null,
	`deu ${semChuva?.chuva1hMm}`,
);

console.log("\n=== 2. SANIDADE DA PRESSÃO (teste de falsificação) ===");
check(
	"2a. atual entre mín e máx = coerente",
	validarSanidade({
		pressaoAtualHpa: 1004.1,
		pressaoMax24Hpa: 1006.13,
		pressaoMin24Hpa: 1001.32,
	}),
);
check(
	"2b. atual ACIMA do máx = incoerente (layout mudou)",
	!validarSanidade({
		pressaoAtualHpa: 1004.1,
		pressaoMax24Hpa: 1001.0,
		pressaoMin24Hpa: 990.0,
	}),
);
// Leitura invertida (s[34]=mín) tem que ser rejeitada: 4/4 estações reais falhariam
const invertida = parseSigmaLinha(
	campos
		.map((v, i) => (i === 34 ? "1001.32" : i === 35 ? "1006.13" : v))
		.join(" "),
	agoraMs,
);
check(
	"2c. layout invertido → extremos e queda descartados (não inventa número)",
	invertida?.quedaPressao24Hpa === null && invertida?.pressaoMax24Hpa === null,
	`queda=${invertida?.quedaPressao24Hpa}`,
);
check("2d. frescor máximo = 90 min", SIGMA_FRESCOR_MAX_MIN === 90);
check(
	"2e. estação de 3 meses atrás = stale",
	parseSigmaLinha(
		linha.replace("2026-09-20_22:32", "2026-06-20_22:32"),
		agoraMs,
	)?.stale === true,
);

console.log("\n=== 3. GATE: só bate no Sigma com núcleo perto de cidade ===");
const irati = CIDADES_CORREDOR.find((c) => c.nome === "Irati");
const nucleoLonge = [{ lat: -23.99, lon: -46.26 }]; // Guarujá/SP
const nucleoPerto = [{ lat: -25.5, lon: -50.6 }]; // ~5 km de Irati
check(
	"3a. núcleo em Guarujá/SP → NENHUMA cidade quente (zero requisição)",
	cidadesComNucleo(nucleoLonge, [...CIDADES_CORREDOR]).length === 0,
);
const quentes = cidadesComNucleo(nucleoPerto, [...CIDADES_CORREDOR], 40);
check(
	"3b. núcleo perto de Irati → Irati quente",
	quentes.some((c) => c.nome === "Irati"),
	JSON.stringify(quentes.map((c) => c.nome)),
);
check(
	"3c. cidades listadas do Dave estão no corredor",
	["Ivaí", "Guarapuava", "Prudentópolis", "Rio Azul", "Imbituva"].every((n) =>
		CIDADES_CORREDOR.some((c) => c.nome === n),
	),
);
check(
	"3d. Ipiranga está no corredor",
	CIDADES_CORREDOR.some((c) => c.nome === "Ipiranga"),
);

console.log("\n=== 4. CAMINHO DO ARQUIVO (hora LOCAL, não UTC) ===");
const p = caminhoArquivo("wu", new Date(Date.UTC(2026, 8, 21, 1, 37)));
check(
	"4a. 01:37 UTC = 22:00 local de 20/09",
	p === "/produtos/wu/2026-09-20/2200.txt",
	`deu ${p}`,
);
check(
	"4b. epoch local bate (22:32 local = 01:32 UTC)",
	localParaEpoch("2026-09-20 22:32") === Date.UTC(2026, 8, 21, 1, 32),
);

console.log("\n=== 5. AO VIVO: bateria contra o site (só 2 redes) ===");
const wu = await fetchSigmaRede("wu");
console.log(
	`  WU: arquivo=${wu.arquivo} estações=${wu.estacoes.length} erro=${wu.erro ?? "-"}`,
);
check(
	"5a. WU respondeu com estações",
	wu.estacoes.length > 100,
	`${wu.estacoes.length}`,
);
if (wu.estacoes.length > 0) {
	const frescos = wu.estacoes.filter((e) => !e.stale);
	check(
		"5b. maioria das estações WU fresca (<90 min)",
		frescos.length > wu.estacoes.length * 0.5,
		`${frescos.length}/${wu.estacoes.length}`,
	);
	const pr = wu.estacoes.filter((e) => e.uf.includes("Paran"));
	check("5c. tem estações no PR", pr.length > 50, `${pr.length}`);
	const comRajada = wu.estacoes.filter((e) => e.rajada1hKmh != null);
	const comPressao = wu.estacoes.filter((e) => e.quedaPressao24Hpa != null);
	check(
		"5d. tem rajada em muitas estações",
		comRajada.length > 50,
		`${comRajada.length}`,
	);
	check(
		"5e. tem queda de pressão calculável",
		comPressao.length > 20,
		`${comPressao.length}`,
	);
	// Sanidade global: quantas estações têm pressão atual entre mín e máx
	const comExtremos = wu.estacoes.filter(
		(e) =>
			e.pressaoAtualHpa != null &&
			e.pressaoMax24Hpa != null &&
			e.pressaoMin24Hpa != null,
	);
	const coerentes = comExtremos.filter((e) => validarSanidade(e));
	console.log(
		`  sanidade da pressão: ${coerentes.length}/${comExtremos.length} coerentes`,
	);
	check(
		"5f. layout da pressão continua válido (>80% coerentes)",
		comExtremos.length === 0 || coerentes.length / comExtremos.length > 0.8,
		`${coerentes.length}/${comExtremos.length}`,
	);
	const perto = estacoesProximas(wu.estacoes, -25.0244, -50.5847, 60);
	console.log(`  estações a ≤60 km de Ipiranga: ${perto.length}`);
	for (const e of perto) {
		console.log(
			`    ${e.nome} (${e.distanciaKm.toFixed(0)} km) raj1h=${e.rajada1hKmh} chuva1h=${e.chuva1hMm} queda=${e.quedaPressao24Hpa} ts=${e.atualizacao}`,
		);
	}
	check(
		"5g. tem estação WU a ≤60 km de Ipiranga",
		perto.length > 0,
		`${perto.length}`,
	);
}

// Segunda rede: SIMEPAR (a que o Cloudflare bloqueia no site deles)
const sp = await fetchSigmaRede("simepar");
console.log(
	`  SIMEPAR: arquivo=${sp.arquivo} estações=${sp.estacoes.length} erro=${sp.erro ?? "-"}`,
);
check(
	"5h. SIMEPAR respondeu (via Sigma, sem Cloudflare)",
	sp.estacoes.length > 20,
	`${sp.estacoes.length}`,
);

// Resumo de solo no formato que o boletim vai consumir
const porRede = [wu, sp];
const quentesReais = cidadesComNucleo(
	estacoesProximas(wu.estacoes, -25.0244, -50.5847, 60).map((e) => ({
		lat: e.lat,
		lon: e.lon,
	})),
	[...CIDADES_CORREDOR],
	40,
);
console.log(
	`  cidades quentes (núcleo sintético = as estações reais): ${quentesReais.map((c) => c.nome).join(", ") || "-"}`,
);
const solo = resumoSolo(quentesReais, porRede, 40);
console.log("  resumo de solo:");
for (const s of solo) {
	console.log(
		`    ${s.cidade}: ${s.estacao} (${s.rede}, ${s.distanciaKm} km, ${s.frescorMin} min) raj1h=${s.rajada1hKmh} queda=${s.quedaPressao24Hpa} chuva1h=${s.chuva1hMm} chuva24h=${s.chuva24hMm}`,
	);
}
check(
	"5i. resumo de solo monta com estação real",
	solo.length > 0,
	`${solo.length}`,
);

console.log(
	`\n${falhas === 0 ? "✅ TODOS OS CASOS PASSARAM" : `❌ ${falhas} CASO(S) FALHARAM`}`,
);
process.exit(falhas === 0 ? 0 : 1);

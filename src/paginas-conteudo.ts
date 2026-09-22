/**
 * Páginas de resposta direta (22/09/2026).
 *
 * Estratégia: responder, em HTML puro, as perguntas que as pessoas fazem e que
 * os buscadores querem entregar prontas — "vai chover hoje?", "como está o
 * rio?" — a partir do MESMO estado que o dashboard usa. Sem JavaScript: o texto
 * precisa existir para quem não executa script (crawler, agente de IA, leitor de
 * tela). É o lado de conteúdo da estratégia LLM-friendly que o /llms.txt já
 * começou.
 *
 * Regras de copy (decididas com o dono do projeto):
 * - resposta na PRIMEIRA frase, sem rodeio;
 * - zero jargão e ZERO nome de provedor de dado na interface (a fonte fica no
 *   código/payload, não na cara do leitor);
 * - risco/enchente sempre com "estimativa própria, não é aviso oficial";
 * - nada de texto enfeitado para "render" em buscador.
 */
import type { WeatherState } from "./types.js";

export const SITE = "https://servicos-status.vercel.app";

const escMapa: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
};

/** Escapa texto para HTML. Sem regex com barra invertida (já custou caro). */
export function esc(v: unknown): string {
	return String(v ?? "").replace(/[&<>"]/g, (c) => escMapa[c] ?? c);
}

function obj(v: unknown): Record<string, unknown> {
	return v && typeof v === "object" && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: {};
}

function arr(v: unknown): unknown[] {
	return Array.isArray(v) ? v : [];
}

function num(v: unknown, padrao = Number.NaN): number {
	const n = Number(v);
	return Number.isFinite(n) ? n : padrao;
}

function txt(v: unknown): string {
	if (typeof v === "string") return v;
	if (v == null) return "";
	return String(v);
}

function hora(ms: unknown): string {
	const n = num(ms, 0);
	if (!n) return "—";
	return new Date(n).toLocaleString("pt-BR", {
		day: "2-digit",
		month: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		timeZone: "America/Sao_Paulo",
	});
}

function inteiro(v: number): string {
	return Number.isFinite(v) ? String(Math.round(v)) : "—";
}

const ROTULO_INTENSIDADE: Record<string, string> = {
	light: "fraca",
	moderate: "moderada",
	heavy: "forte",
	extreme: "muito forte",
};

const ROTULO_FAIXA: Record<string, string> = {
	normal: "dentro do normal",
	media: "faixa média",
	alerta: "em nível de atenção",
	critico: "em nível crítico",
};

const AVISO_OFICIAL =
	"Texto gerado automaticamente a partir de radar meteorológico e pluviômetros da região. " +
	"É estimativa própria — não substitui aviso oficial. Em situação de risco, siga a Defesa Civil do seu município.";

const CSS = `:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#07130e;color:#e8f2ed;font:16px/1.65 Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:#5fd4a0}
header,main,footer{max-width:820px;margin:0 auto;padding:0 20px}
header{padding-top:28px;display:flex;flex-wrap:wrap;gap:14px;align-items:baseline;justify-content:space-between}
header .marca{font-weight:700;letter-spacing:-.01em;font-size:1.05rem}
header nav a{margin-left:14px;font-size:.9rem;color:#9fb8ac;text-decoration:none}
header nav a:hover{color:#5fd4a0}
h1{font-size:1.75rem;line-height:1.25;margin:26px 0 6px;letter-spacing:-.02em}
h2{font-size:1.15rem;margin:34px 0 10px;color:#9fe6c4}
p,li{margin:10px 0}
.resposta{background:#0d2018;border:1px solid #1d3a2c;border-left:4px solid #11875b;border-radius:12px;padding:16px 18px;font-size:1.06rem}
.resposta strong{color:#7ee2b3}
table{width:100%;border-collapse:collapse;margin:12px 0;font-size:.95rem}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #1d3a2c}
th{color:#9fb8ac;font-weight:600;font-size:.85rem;text-transform:uppercase;letter-spacing:.03em}
.alerta{border-left-color:#e8a33d}
.critico{border-left-color:#e2574c}
.mudo{color:#9fb8ac;font-size:.9rem}
footer{margin-top:40px;padding-bottom:40px;color:#9fb8ac;font-size:.85rem;border-top:1px solid #1d3a2c;padding-top:18px}
footer a{color:#7ee2b3}
.cartoes{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));margin:16px 0}
.cartao{background:#0d2018;border:1px solid #1d3a2c;border-radius:12px;padding:14px}
.cartao b{display:block;font-size:1.5rem;color:#7ee2b3;line-height:1.2}
.cartao span{font-size:.85rem;color:#9fb8ac}`;

interface PaginaOpts {
	titulo: string;
	descricao: string;
	caminho: string;
	cabecalho: string;
	corpo: string;
	jsonLd: unknown;
	modificadoEm: string;
}

function shell(o: PaginaOpts): string {
	const url = SITE + o.caminho;
	return [
		"<!DOCTYPE html>",
		'<html lang="pt-BR">',
		"<head>",
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width,initial-scale=1">',
		"<title>" + esc(o.titulo) + "</title>",
		'<meta name="description" content="' + esc(o.descricao) + '">',
		'<link rel="canonical" href="' + url + '">',
		'<meta name="robots" content="index,follow,max-snippet:-1,max-image-preview:large">',
		'<meta property="og:type" content="article">',
		'<meta property="og:title" content="' + esc(o.titulo) + '">',
		'<meta property="og:description" content="' + esc(o.descricao) + '">',
		'<meta property="og:url" content="' + url + '">',
		'<meta property="og:image" content="' + SITE + '/brand/og.png">',
		'<meta property="og:locale" content="pt_BR">',
		'<meta name="twitter:card" content="summary_large_image">',
		'<link rel="icon" href="/brand/favicon.svg" type="image/svg+xml">',
		'<link rel="preload" href="/vendor/fonts/inter-var.woff2" as="font" type="font/woff2" crossorigin fetchpriority="low">',
		"<style>" + CSS + "</style>",
		'<script type="application/ld+json">' + JSON.stringify(o.jsonLd) + "</script>",
		"</head>",
		"<body>",
		'<header><a class="marca" href="/">Monitor Ipiranga</a><nav>',
		'<a href="/chuva-hoje">Chuva hoje</a>',
		'<a href="/rio-bitumirim">Rio Bitumirim</a>',
		'<a href="/como-ler-radar">Como ler o radar</a>',
		"</nav></header>",
		"<main>",
		o.cabecalho,
		o.corpo,
		'<p class="mudo">Dados de referência atualizados em ' +
			esc(o.modificadoEm) +
			". Monitor Ipiranga · Ipiranga (PR).</p>",
		"</main>",
		"<footer>",
		"<p>" + esc(AVISO_OFICIAL) + "</p>",
		'<p><a href="/">Ver o monitor completo (radar ao vivo, rios e serviços)</a></p>',
		"</footer>",
		"</body></html>",
	].join("\n");
}

function organizacao(): Record<string, unknown> {
	return {
		"@type": "Organization",
		name: "Monitor Ipiranga",
		url: SITE + "/",
	};
}

function jsonLdPagina(
	titulo: string,
	descricao: string,
	caminho: string,
	modificadoEm: string,
	perguntas: Array<{ q: string; a: string }>,
): unknown {
	return {
		"@context": "https://schema.org",
		"@graph": [
			{
				"@type": "WebPage",
				name: titulo,
				description: descricao,
				url: SITE + caminho,
				inLanguage: "pt-BR",
				dateModified: modificadoEm,
				isPartOf: { "@type": "WebSite", name: "Monitor Ipiranga", url: SITE + "/" },
				publisher: organizacao(),
			},
			{
				"@type": "FAQPage",
				mainEntity: perguntas.map((p) => ({
					"@type": "Question",
					name: p.q,
					acceptedAnswer: { "@type": "Answer", text: p.a },
				})),
			},
		],
	};
}

/* ────────────────────────── estado → números ────────────────────────── */

interface Dados {
	agora: { tempC: number; condicao: string; probabilidade: number };
	chuva: { acc1: number; acc3: number; acc6: number; acc24: number; estacao: string; hora: string };
	horas: Array<{ time: string; tempC: number; prob: number; mm: number }>;
	nucleos: Array<{ intensidade: string; km: number; eta: number; dbz: number; direcao: number; velocidade: number }>;
	maxDbz: number;
	dominante: string;
	alerta: { nivel: string; titulo: string; descricao: string; motivos: string[] };
	avisosOficiais: number;
	hidro: Array<{ nome: string; rio: string; papel: string; nivel: number; delta6h: number; faixa: string; chuva: number }>;
	risco: { enxurrada: string; cheia: string; iflScore: number; iflNivel: string };
	previsaoRio: { vaiSair: string; confianca: number; regra: string; motivos: string[] };
}

function extrair(state: WeatherState | null): Dados {
	const s = obj(state);
	const cem = obj(s.cemaden);
	const estacoes = arr(cem.estacoes).map(obj);
	const estacaoIpiranga =
		estacoes.find((e) => txt(e.cidade).toUpperCase().indexOf("IPIRANGA") >= 0) ?? estacoes[0] ?? {};

	const nc = obj(s.nowcast);
	const nucleos = arr(nc.threats)
		.map(obj)
		.map((t) => {
			const mv = obj(t.movement ?? t.trackedMovement);
			const vel = num(mv.speedKmh, 0);
			const km = num(t.distToTargetKm, Number.NaN);
			return {
				intensidade: ROTULO_INTENSIDADE[txt(t.intensity)] ?? txt(t.intensity),
				km,
				eta: km > 0 && vel > 1 ? Math.round((km / vel) * 60) : Number.NaN,
				dbz: num(t.maxDbz, 0),
				direcao: num(mv.directionDeg, Number.NaN),
				velocidade: vel,
			};
		})
		.filter((t) => Number.isFinite(t.km))
		.sort((a, b) => a.km - b.km);

	const h = obj(s.hidro);
	const previsao = obj(h.previsao);
	const alerta = obj(s.alertaUnificado);

	return {
		agora: {
			tempC: num(s.tempC, Number.NaN),
			condicao: txt(s.condition),
			probabilidade: num(s.rainProbabilityPct, 0),
		},
		chuva: {
			acc1: num(estacaoIpiranga.acc1hr, 0),
			acc3: num(estacaoIpiranga.acc3hr, 0),
			acc6: num(estacaoIpiranga.acc6hr, 0),
			acc24: num(estacaoIpiranga.acc24hr, 0),
			estacao: txt(estacaoIpiranga.nome),
			hora: txt(estacaoIpiranga.dataHoraUltimoValor),
		},
		horas: arr(s.hourlyForecast)
			.map(obj)
			.map((f) => ({
				time: txt(f.time),
				tempC: num(f.tempC, Number.NaN),
				prob: num(f.rainProbabilityPct, 0),
				mm: num(f.precipitationMm, 0),
			})),
		nucleos,
		maxDbz: num(nc.currentMaxDbz, 0),
		dominante: ROTULO_INTENSIDADE[txt(nc.currentDominant)] ?? txt(nc.currentDominant),
		alerta: {
			nivel: txt(alerta.nivel),
			titulo: txt(alerta.titulo),
			descricao: txt(alerta.descricao),
			motivos: arr(alerta.motivos).map(txt),
		},
		avisosOficiais: arr(obj(s.alertasOficiais).avisos).length,
		hidro: arr(h.estacoes)
			.map(obj)
			.map((e) => ({
				nome: txt(e.nome),
				rio: txt(e.rio),
				papel: txt(e.papel),
				nivel: num(e.nivelCm, Number.NaN),
				delta6h: num(e.delta6hCm, Number.NaN),
				faixa: ROTULO_FAIXA[txt(e.faixa)] ?? txt(e.faixa),
				chuva: num(e.chuvaMm, 0),
			})),
		risco: {
			enxurrada: txt(h.riscoEnxurrada),
			cheia: txt(h.riscoCheia),
			iflScore: num(obj(h.ifl).score, 0),
			iflNivel: txt(obj(h.ifl).nivel),
		},
		previsaoRio: {
			vaiSair: txt(previsao.vaiSair),
			confianca: num(previsao.confianca, 0),
			regra: txt(previsao.regra),
			motivos: arr(previsao.motivos).map(txt),
		},
	};
}

function horaDe(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "agora";
	return new Date(ms).toLocaleString("pt-BR", {
		day: "2-digit",
		month: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		timeZone: "America/Sao_Paulo",
	});
}

function minutosTexto(min: number): string {
	if (!Number.isFinite(min) || min <= 0) return "instantes";
	if (min < 60) return "cerca de " + inteiro(min) + " minutos";
	const h = Math.floor(min / 60);
	const m = Math.round(min % 60);
	return "cerca de " + inteiro(h) + "h" + (m > 4 ? String(m).padStart(2, "0") : "");
}

/**
 * Frase de risco em português claro. O campo `resumoRisco` que o backend
 * publica é texto de diagnóstico ("triangulação", "faixas P90/P98", "Flash IFL
 * 0,00") — jargão que não vai para a cara do leitor. Montamos dos campos
 * estruturados, que são estáveis.
 */
const NIVEL_RISCO: Record<string, string> = {
	o: "dentro do normal",
	ok: "dentro do normal",
	normal: "dentro do normal",
	watch: "em observação",
	warn: "em atenção",
	warning: "em atenção",
	critical: "em nível crítico",
	critico: "em nível crítico",
	alerta: "em atenção",
};

function fraseRisco(r: { cheia: string; enxurrada: string }): string {
	const cheia = NIVEL_RISCO[r.cheia] ?? "";
	const enxurrada = NIVEL_RISCO[r.enxurrada] ?? "";
	const partes: string[] = [
		"O escoamento regional está " + (cheia || "sem classificação de risco") + ".",
	];
	if (enxurrada && enxurrada !== "dentro do normal") {
		partes.push("Há também condição de enxurrada " + enxurrada + ".");
	}
	return partes.join(" ");
}

/* ────────────────────────── /chuva-hoje ────────────────────────── */

function respostaChuva(d: Dados): string {
	const choveAgora = d.chuva.acc1 >= 0.2;
	const proximo = d.nucleos.find((n) => n.km <= 150);
	if (choveAgora && proximo) {
		return (
			"<strong>Sim.</strong> Está chovendo em Ipiranga: " +
			d.chuva.acc1.toFixed(1) +
			" mm na última hora" +
			(d.chuva.estacao ? " (" + esc(d.chuva.estacao) + ")" : "") +
			". E vem mais: um núcleo de chuva " +
			esc(proximo.intensidade) +
			" está a ~" +
			inteiro(proximo.km) +
			" km, com chegada estimada em " +
			minutosTexto(proximo.eta) +
			"."
		);
	}
	if (choveAgora) {
		return (
			"<strong>Sim, está chovendo agora.</strong> " +
			d.chuva.acc1.toFixed(1) +
			" mm na última hora em Ipiranga. " +
			esc(fraseRisco(d.risco))
		);
	}
	if (proximo) {
		return (
			"<strong>Ainda não, mas vem chuva.</strong> Neste momento não chove em Ipiranga, mas há um núcleo de chuva " +
			esc(proximo.intensidade) +
			" no radar a ~" +
			inteiro(proximo.km) +
			" km" +
			(proximo.velocidade > 1
				? ", andando a ~" + inteiro(proximo.velocidade) + " km/h na direção da cidade"
				: "") +
			". Se mantiver o rumo, chega em " +
			minutosTexto(proximo.eta) +
			"."
		);
	}
	const melhorHora = d.horas.slice().sort((a, b) => b.prob - a.prob)[0];
	return (
		"<strong>Não.</strong> Não chove em Ipiranga agora e o radar não mostra chuva a menos de 150 km. " +
		(melhorHora && melhorHora.prob > 0
			? "Nas próximas horas a maior chance de chuva é às " +
				esc(melhorHora.time) +
				", com " +
				inteiro(melhorHora.prob) +
				"% de probabilidade."
			: "A previsão das próximas horas indica tempo sem chuva.")
	);
}

export function renderChuvaHoje(state: WeatherState | null): string {
	const d = extrair(state);
	const atualizado = horaDe(num(obj(state).updatedAt, 0));
	const tabelaChuva = [
		["Última hora", d.chuva.acc1.toFixed(1) + " mm"],
		["Últimas 3 horas", d.chuva.acc3.toFixed(1) + " mm"],
		["Últimas 6 horas", d.chuva.acc6.toFixed(1) + " mm"],
		["Últimas 24 horas", d.chuva.acc24.toFixed(1) + " mm"],
	]
		.map(
			(l) =>
				"<tr><th>" + esc(l[0]) + "</th><td>" + esc(l[1]) + "</td></tr>",
		)
		.join("");

	const tabelaHoras = d.horas
		.map(
			(f) =>
				"<tr><th>" +
				esc(f.time) +
				"</th><td>" +
				(Number.isFinite(f.tempC) ? inteiro(f.tempC) + " °C" : "—") +
				"</td><td>" +
				inteiro(f.prob) +
				"%</td><td>" +
				f.mm.toFixed(1) +
				" mm</td></tr>",
		)
		.join("");

	const listaNucleos =
		d.nucleos.length === 0
			? "<li>Nenhum núcleo de chuva a menos de 150 km do município.</li>"
			: d.nucleos
					.slice(0, 4)
					.map(
						(n) =>
							"<li>Chuva <strong>" +
							esc(n.intensidade) +
							"</strong> a ~" +
							inteiro(n.km) +
							" km" +
							(Number.isFinite(n.direcao)
								? " (vindo de " + esc(grauParaRumo(n.direcao)) + ")"
								: "") +
							(n.dbz > 0 ? ", pico de " + inteiro(n.dbz) + " dBZ" : "") +
							(Number.isFinite(n.eta) && n.eta > 0
								? " — chegada estimada em " + minutosTexto(n.eta)
								: "") +
							"</li>",
					)
					.join("");

	const alertaBloco =
		d.alerta.nivel && d.alerta.nivel !== "verde"
			? '<div class="resposta ' +
				(d.alerta.nivel === "vermelho" ? "critico" : "alerta") +
				'"><strong>' +
				esc(d.alerta.titulo || "Atenção") +
				"</strong><br>" +
				esc(d.alerta.descricao || "") +
				(d.alerta.motivos.length
					? "<ul>" +
						d.alerta.motivos.map((m) => "<li>" + esc(m) + "</li>").join("") +
						"</ul>"
					: "") +
				"</div>"
			: "";

	const perguntaResposta = respostaChuva(d).replace(/<[^>]+>/g, "");
	const cabecalho =
		"<h1>Vai chover em Ipiranga hoje?</h1>" +
		'<p class="mudo">Ipiranga (PR) · leitura ' +
		esc(atualizado) +
		"</p>" +
		'<div class="resposta">' +
		respostaChuva(d) +
		"</div>" +
		alertaBloco +
		'<div class="cartoes">' +
		'<div class="cartao"><b>' +
		(d.chuva.acc1 > 0 ? d.chuva.acc1.toFixed(1) + " mm" : "0 mm") +
		"</b><span>chuva na última hora</span></div>" +
		'<div class="cartao"><b>' +
		(Number.isFinite(d.agora.tempC) ? inteiro(d.agora.tempC) + " °C" : "—") +
		"</b><span>" +
		esc(d.agora.condicao || "condição atual") +
		"</span></div>" +
		'<div class="cartao"><b>' +
		(d.nucleos.length ? "~" + inteiro(d.nucleos[0].km) + " km" : "—") +
		"</b><span>núcleo de chuva mais próximo</span></div>" +
		"</div>";

	const corpo =
		"<h2>Chuva medida em Ipiranga</h2>" +
		'<table><caption class="mudo">Acumulado nos pluviômetros do município' +
		(d.chuva.estacao ? " (estação " + esc(d.chuva.estacao) + ")" : "") +
		"</caption><tbody>" +
		tabelaChuva +
		"</tbody></table>" +
		(d.chuva.hora || d.chuva.estacao
			? '<p class="mudo">Última leitura: ' + esc(d.chuva.hora || "—") + "</p>"
			: "") +
		(d.horas.length
			? "<h2>As próximas horas</h2>" +
				"<table><thead><tr><th>Hora</th><th>Temp.</th><th>Chance de chuva</th><th>Chuva prevista</th></tr></thead><tbody>" +
				tabelaHoras +
				"</tbody></table>"
			: "") +
		"<h2>O que o radar mostra vindo</h2>" +
		"<p>O radar vê a chuva antes dela chegar. Neste momento o eco mais forte na área analisada é de <strong>" +
		inteiro(d.maxDbz) +
		" dBZ</strong> (intensidade " +
		esc(d.dominante || "não classificada") +
		").</p>" +
		"<ul>" +
		listaNucleos +
		"</ul>" +
		"<h2>Por que o pluviômetro pode marcar 0 mm com chuva vindo</h2>" +
		"<p>O pluviômetro mede só o que caiu <em>naquele ponto</em>. O radar mostra a chuva se deslocando na região: é comum o núcleo passar ao lado, ou chegar em minutos. Quando as duas fontes divergem, o monitor trata o radar como aviso (a chuva vem) e a medição como prova (a chuva caiu).</p>" +
		"<h2>Se a chuva chegar</h2>" +
		"<p>Chuva forte em pouco tempo molha o solo rápido e a água procura os pontos baixos. O rio Bitumirim costuma responder com atraso — a cheia chega depois da chuva, não durante. " +
		'<a href="/rio-bitumirim">Ver a situação do rio Bitumirim</a>.</p>' +
		"<h2>Como este número é calculado</h2>" +
		"<p>O acumulado vem dos pluviômetros do município; a parte de \"chuva vindo\" vem da análise do radar meteorológico, quadro a quadro, incluindo a velocidade e a direção de cada núcleo. A chegada estimada é uma projeção simples (distância dividida pela velocidade) — se o núcleo mudar de rumo ou se dissipar, muda também.</p>" +
		'<p><a href="/">Ver o radar ao vivo no monitor</a> · <a href="/como-ler-radar">Como ler o radar</a></p>';

	return shell({
		titulo: "Vai chover em Ipiranga hoje? Resposta agora — Monitor Ipiranga",
		descricao:
			"Resposta direta sobre chuva em Ipiranga (PR): chuva medida na última hora, próximo núcleo no radar, distância, chegada estimada e previsão das próximas horas.",
		caminho: "/chuva-hoje",
		cabecalho,
		corpo,
		modificadoEm: atualizado,
		jsonLd: jsonLdPagina(
			"Vai chover em Ipiranga hoje?",
			"Resposta direta sobre chuva em Ipiranga (PR), com medição em pluviômetros e análise de radar.",
			"/chuva-hoje",
			new Date().toISOString(),
			[
				{
					q: "Vai chover em Ipiranga hoje?",
					a: perguntaResposta,
				},
				{
					q: "Quanto já choveu em Ipiranga?",
					a:
						"Nas últimas 24 horas o acumulado no município foi de " +
						d.chuva.acc24.toFixed(1) +
						" mm; na última hora, " +
						d.chuva.acc1.toFixed(1) +
						" mm.",
				},
				{
					q: "Está chovendo agora em Ipiranga?",
					a:
						d.chuva.acc1 >= 0.2
							? "Sim: " +
								d.chuva.acc1.toFixed(1) +
								" mm na última hora segundo os pluviômetros do município."
							: "Não: os pluviômetros do município marcaram 0 mm na última hora.",
				},
			],
		),
	});
}

function grauParaRumo(grau: number): string {
	if (!Number.isFinite(grau)) return "";
	const rumos = ["norte", "nordeste", "leste", "sudeste", "sul", "sudoeste", "oeste", "noroeste"];
	const i = Math.round(((grau % 360) + 360) % 360 / 45) % 8;
	return rumos[i] ?? "";
}

/* ────────────────────────── /rio-bitumirim ────────────────────────── */

export function renderRioBitumirim(state: WeatherState | null): string {
	const d = extrair(state);
	const atualizado = horaDe(num(obj(state).updatedAt, 0));
	const uvaia = d.hidro.find((e) => e.nome.toLowerCase().indexOf("uvaia") >= 0) ?? d.hidro[0];
	const naoDeveSair = d.previsaoRio.vaiSair === "nao";

	const tendencia = (delta: number): string => {
		if (!Number.isFinite(delta)) return "sem variação medida";
		if (delta >= 2) return "subindo " + delta.toFixed(1) + " cm em 6 h";
		if (delta <= -2) return "descendo " + Math.abs(delta).toFixed(1) + " cm em 6 h";
		return "praticamente estável nas últimas 6 h";
	};

	const resposta =
		"<strong>" +
		(naoDeveSair
			? "A projeção indica que o rio NÃO deve sair da calha."
			: "Atenção: há indicação de que o rio pode sair da calha.") +
		"</strong> " +
		(uvaia
			? "A leitura de referência a montante está em " +
				inteiro(uvaia.nivel) +
				" cm e " +
				tendencia(uvaia.delta6h) +
				". "
			: "") +
		esc(fraseRisco(d.risco)) +
		" " +
		(Number.isFinite(d.previsaoRio.confianca) && d.previsaoRio.confianca > 0
			? "Confiança desta projeção: " + inteiro(d.previsaoRio.confianca) + "%."
			: "");

	const tabela = d.hidro
		.map(
			(e) =>
				"<tr><th>" +
				esc(e.nome) +
				"</th><td>" +
				(Number.isFinite(e.nivel) ? inteiro(e.nivel) + " cm" : "—") +
				"</td><td>" +
				esc(tendencia(e.delta6h)) +
				"</td><td>" +
				esc(e.faixa || "—") +
				"</td></tr>",
		)
		.join("");

	const motivos = d.previsaoRio.motivos.length
		? "<ul>" + d.previsaoRio.motivos.map((m) => "<li>" + esc(m) + "</li>").join("") + "</ul>"
		: "";

	const cabecalho =
		"<h1>Como está o rio Bitumirim em Ipiranga?</h1>" +
		'<p class="mudo">Ipiranga (PR) · leitura ' +
		esc(atualizado) +
		"</p>" +
		'<div class="resposta">' +
		resposta +
		"</div>" +
		'<div class="cartoes">' +
		'<div class="cartao"><b>' +
		(uvaia && Number.isFinite(uvaia.nivel) ? inteiro(uvaia.nivel) + " cm" : "—") +
		"</b><span>montante de referência" +
		(uvaia ? " (" + esc(uvaia.nome) + ")" : "") +
		"</span></div>" +
		'<div class="cartao"><b>' +
		esc(tendencia(uvaia ? uvaia.delta6h : Number.NaN).split(" ")[0]) +
		"</b><span>tendência nas últimas 6 horas</span></div>" +
		'<div class="cartao"><b>' +
		(d.risco.cheia === "watch" || d.risco.cheia === "warning"
			? "Atenção"
			: d.risco.cheia === "critical"
				? "Crítico"
				: "Normal") +
		"</b><span>situação do escoamento regional</span></div>" +
		"</div>";

	const corpo =
		"<h2>Leituras de referência</h2>" +
		"<p class=\"mudo\">Estações usadas como referência do escoamento regional. As duas de jusante (longe daqui) só confirmam o escoamento dias depois — não servem para prever Ipiranga.</p>" +
		"<table><thead><tr><th>Estação</th><th>Nível</th><th>Variação</th><th>Faixa</th></tr></thead><tbody>" +
		tabela +
		"</tbody></table>" +
		"<h2>Vai encher? O que a chuva manda</h2>" +
		(d.previsaoRio.regra ? "<p>" + esc(d.previsaoRio.regra) + "</p>" : "") +
		motivos +
		"<h2>Por que o rio não sobe na hora da chuva</h2>" +
		"<p>O Bitumirim responde a duas coisas: chuva forte <em>local</em> e a onda de água que vem de montante. Uma pancada de chuva em um ponto só aumenta a enxurrada das horas seguintes; para o rio sair da calha, o padrão observado no histórico é chuva acumulada de vários dias em estações diferentes. Por isso a cheia costuma chegar com atraso.</p>" +
		"<h2>Alagamento não é a mesma coisa que enchente</h2>" +
		"<p>Alagamento em ponto baixo de rua acontece com chuva forte e curta, independente do rio. Enchente é o rio ocupando a planície — depende do acumulado e da onda de montante. O monitor separa os dois sinais, e ambos são <strong>estimativa própria, não aviso oficial</strong>.</p>" +
		'<p><a href="/">Ver o monitor completo</a> · <a href="/chuva-hoje">Vai chover hoje?</a></p>';

	const respostaTexto = resposta.replace(/<[^>]+>/g, "");
	return shell({
		titulo: "Rio Bitumirim em Ipiranga: nível e risco agora — Monitor Ipiranga",
		descricao:
			"Como está o rio Bitumirim em Ipiranga (PR): leituras de referência, tendência das últimas horas e projeção de saída da calha, com estimativa própria.",
		caminho: "/rio-bitumirim",
		cabecalho,
		corpo,
		modificadoEm: atualizado,
		jsonLd: jsonLdPagina(
			"Como está o rio Bitumirim em Ipiranga?",
			"Nível e projeção do rio Bitumirim em Ipiranga (PR).",
			"/rio-bitumirim",
			new Date().toISOString(),
			[
				{ q: "O rio Bitumirim está cheio?", a: respostaTexto },
				{
					q: "O rio Bitumirim vai transbordar?",
					a:
						naoDeveSair
							? "A projeção do monitor indica que não deve sair da calha, com confiança de " +
								inteiro(d.previsaoRio.confianca) +
								"%. É estimativa própria, não aviso oficial."
							: "A projeção do monitor indica possibilidade de o rio sair da calha. Acompanhe os avisos oficiais da Defesa Civil.",
				},
				{
					q: "Quanto choveu nas últimas 24 horas em Ipiranga?",
					a: d.chuva.acc24.toFixed(1) + " mm nos pluviômetros do município.",
				},
			],
		),
	});
}

/* ────────────────────────── /como-ler-radar ────────────────────────── */

export function renderComoLerRadar(state: WeatherState | null): string {
	const d = extrair(state);
	const atualizado = horaDe(num(obj(state).updatedAt, 0));
	const agora =
		d.nucleos.length > 0
			? "Agora: o núcleo de chuva mais próximo está a ~" +
				inteiro(d.nucleos[0].km) +
				" km, de intensidade " +
				d.nucleos[0].intensidade +
				"."
			: "Agora: nenhum núcleo de chuva a menos de 150 km de Ipiranga.";

	const cabecalho =
		"<h1>Como ler o radar de chuva</h1>" +
		'<p class="mudo">Guia rápido do que as cores, as setas e as distâncias querem dizer · ' +
		esc(atualizado) +
		"</p>" +
		'<div class="resposta"><strong>' +
		esc(agora) +
		"</strong> Abaixo, o que cada sinal significa — e onde ele engana.</div>";

	const corpo =
		'<h2>As cores: quanto está chovendo</h2>' +
		"<p>O radar mede quanto da energia enviada volta das gotas de chuva (refletividade, em dBZ). A cor é a tradução visual disso:</p>" +
		"<ul>" +
		"<li><strong>Azul e verde claro</strong> — chuva fraca: molha, mas raramente causa problema.</li>" +
		"<li><strong>Verde escuro e amarelo</strong> — chuva moderada: começa a encharcar o solo.</li>" +
		"<li><strong>Laranja e vermelho</strong> — chuva forte: pancadas com potencial de alagamento em ponto baixo.</li>" +
		"<li><strong>Roxo</strong> — chuva muito forte: tempestade, granizo possível, rajadas.</li>" +
		"</ul>" +
		"<h2>As setas: para onde a chuva vai</h2>" +
		"<p>Cada núcleo com deslocamento medido ganha uma seta. O rastro mostra de onde ele veio e a ponta onde ele deve estar nos próximos 30 minutos. Setas só aparecem quando há movimento real medido entre dois quadros — núcleo parado não tem seta.</p>" +
		"<h2>\"Núcleo a 40 km chegando em 30 min\"</h2>" +
		"<p>Essa frase junta três medidas: a <strong>distância</strong> do núcleo até a cidade, a <strong>velocidade</strong> dele e a <strong>direção</strong> do deslocamento. A chegada é uma projeção linear: distância dividida pela velocidade. Se o núcleo virar, perder força ou se dividir, a chegada muda — por isso o número é sempre \"cerca de\".</p>" +
		"<h2>Por que o pluviômetro marca 0 mm com chuva vindo</h2>" +
		"<p>O radar enxerga a chuva <em>na região</em>; o pluviômetro mede só o que caiu <em>no ponto dele</em>. Um núcleo pode passar a 5 km de distância e não pingar nada na cidade. Quando os dois discordam, o monitor usa o radar para avisar (\"vem chuva\") e a medição para confirmar (\"caiu chuva\").</p>" +
		"<h2>Onde o radar engana</h2>" +
		"<ul>" +
		"<li><strong>Subestima núcleo pequeno e intenso:</strong> uma pancada curta e forte pode aparecer menor do que é. O monitor leva isso em conta e prefere o aviso a mais do que o aviso a menos.</li>" +
		"<li><strong>Alcance:</strong> longe do radar a leitura perde precisão e parte da chuva fica abaixo do que o sensor enxerga.</li>" +
		"<li><strong>Chuva muito fraca:</strong> garoa fina pode não aparecer em nada.</li>" +
		"<li><strong>Quadro desatualizado:</strong> a imagem é do último quadro disponível, não de agora ao segundo.</li>" +
		"</ul>" +
		"<h2>Como usar o monitor</h2>" +
		"<p>O card de chuva responde \"tem chuva vindo?\". O valor amarelo é atenção — chuva se aproximando — e não quer dizer que já está chovendo na cidade. Laranja e vermelho são reservados para o que realmente exige ação. Se o aviso chegar no celular, é porque o monitor considerou o caso grave.</p>" +
		'<p><a href="/">Abrir o radar ao vivo</a> · <a href="/chuva-hoje">Vai chover hoje?</a> · <a href="/rio-bitumirim">Situação do rio</a></p>';

	return shell({
		titulo: "Como ler o radar de chuva: cores, setas e distâncias — Monitor Ipiranga",
		descricao:
			"Guia direto de como ler o radar de chuva: o que cada cor significa, o que as setas mostram, como interpretar \"núcleo a X km\" e onde o radar engana.",
		caminho: "/como-ler-radar",
		cabecalho,
		corpo,
		modificadoEm: atualizado,
		jsonLd: jsonLdPagina(
			"Como ler o radar de chuva",
			"Guia de leitura do radar meteorológico: cores, setas de deslocamento, distância e limitações.",
			"/como-ler-radar",
			new Date().toISOString(),
			[
				{
					q: "O que significam as cores do radar de chuva?",
					a:
						"Azul e verde claro indicam chuva fraca; verde escuro e amarelo, chuva moderada; laranja e vermelho, chuva forte; roxo, chuva muito forte. A cor vem da refletividade medida (dBZ).",
				},
				{
					q: "O que quer dizer \"núcleo de chuva a 40 km\"?",
					a:
						"Quer dizer que o centro da área de chuva mais próxima está a 40 km da cidade, segundo a análise do radar. Com a velocidade e a direção do núcleo, o monitor projeta em quantos minutos ele chegaria — é uma estimativa que muda se o núcleo virar ou perder força.",
				},
				{
					q: "Por que o pluviômetro marca 0 mm se o radar mostra chuva perto?",
					a:
						"Porque o pluviômetro mede apenas o ponto onde está instalado, e o núcleo de chuva pode passar ao lado. O radar mostra a chuva na região; o pluviômetro confirma o que caiu na cidade.",
				},
			],
		),
	});
}

/**
 * Sitemap dinâmico (22/09/2026): as páginas de resposta direta mudam com o
 * dado, então o lastmod tem que vir do estado, não de um arquivo esquecido no
 * repositório. changefreq alto no que muda de hora em hora; o guia do radar
 * muda raramente.
 */
export function renderSitemap(state: WeatherState | null): string {
	const atual = num(obj(state).updatedAt, 0);
	const doDado = atual
		? new Date(atual).toISOString()
		: new Date().toISOString();
	const guia = new Date().toISOString();
	const url = (loc: string, lastmod: string, changefreq: string, priority: string) =>
		[
			"  <url>",
			"    <loc>" + SITE + loc + "</loc>",
			"    <lastmod>" + lastmod + "</lastmod>",
			"    <changefreq>" + changefreq + "</changefreq>",
			"    <priority>" + priority + "</priority>",
			"  </url>",
		].join("\n");
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
		url("/", doDado, "hourly", "1.0"),
		url("/chuva-hoje", doDado, "hourly", "0.9"),
		url("/rio-bitumirim", doDado, "hourly", "0.8"),
		url("/como-ler-radar", guia, "monthly", "0.6"),
		"</urlset>",
		"",
	].join("\n");
}

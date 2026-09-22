/**
 * Verificador das páginas de resposta direta (22/09/2026).
 *
 * Roda contra a produção e confere o que faz a página ser encontrável e legível
 * por buscador, agente de IA e leitor de tela: HTML servido sem depender de JS,
 * canonical, título, descrição, JSON-LD válido, link interno a partir da home,
 * sitemap com lastmod vindo do dado e listagem no /llms.txt.
 *
 * Uso: bun run scripts/verify-paginas-seo.ts
 */
export {};

const BASE = "https://servicos-status.vercel.app";

const PAGINAS = [
	{ caminho: "/chuva-hoje", h1: "Vai chover em Ipiranga hoje?" },
	{ caminho: "/rio-bitumirim", h1: "Como está o rio Bitumirim em Ipiranga?" },
	{ caminho: "/como-ler-radar", h1: "Como ler o radar de chuva" },
];

let ok = 0;
let falhas = 0;

function checar(nome: string, condicao: boolean, detalhe = ""): void {
	if (condicao) {
		ok++;
		console.log(`  ✔ ${nome}`);
	} else {
		falhas++;
		console.log(`  ✗ ${nome}${detalhe ? " — " + detalhe : ""}`);
	}
}

async function buscar(url: string): Promise<{ status: number; corpo: string; tipo: string }> {
	const r = await fetch(url + (url.indexOf("?") >= 0 ? "" : `?cb=${Date.now()}`));
	return { status: r.status, corpo: await r.text(), tipo: r.headers.get("content-type") ?? "" };
}

for (const p of PAGINAS) {
	console.log(`\n${p.caminho}`);
	const { status, corpo, tipo } = await buscar(BASE + p.caminho);
	checar("responde 200", status === 200, `status ${status}`);
	checar("é HTML", tipo.indexOf("text/html") >= 0, tipo);
	checar("tem o H1 esperado", corpo.indexOf(`<h1>${p.h1}</h1>`) >= 0);
	checar("tem canonical próprio", corpo.indexOf(`rel="canonical" href="${BASE}${p.caminho}"`) >= 0);
	checar("tem description", /<meta name="description" content=".{40,}"/.test(corpo));
	checar("tem og:title/og:image", corpo.indexOf('property="og:title"') >= 0 && corpo.indexOf('property="og:image"') >= 0);
	checar("não carrega script externo", !/<script[^>]+src=/.test(corpo));
	checar("texto existe sem JS", corpo.replace(/<[^>]+>/g, " ").trim().length > 1200);
	checar("avisa que é estimativa, não oficial", corpo.indexOf("não substitui aviso oficial") >= 0);
	checar("sem nome de provedor na interface", !/cemaden|inmet|simepar|rainviewer|ana hidro|open-meteo/i.test(corpo.replace(/<script[\s\S]*?<\/script>/g, "")));
	checar("decimal em pt-BR (sem ponto em número)", !/\d+\.\d+\s*(mm|cm|km\/h)/.test(corpo));
	checar("sem 'undefined'/'NaN'", !/undefined|NaN/.test(corpo));

	// JSON-LD: buscador não perdoa JSON inválido
	const m = corpo.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
	let tipos = "";
	try {
		const ld = JSON.parse(m?.[1] ?? "null");
		tipos = (ld?.["@graph"] ?? []).map((g: { "@type": string }) => g["@type"]).join("+");
	} catch {
		tipos = "inválido";
	}
	checar("JSON-LD válido (WebPage + FAQPage)", tipos === "WebPage+FAQPage", tipos);

	const perguntas = (m?.[1] ?? "").match(/"@type":"Question"/g)?.length ?? 0;
	checar("tem perguntas no FAQPage (≥3)", perguntas >= 3, `tem ${perguntas}`);
}

console.log("\nhome linka as páginas (descoberta pelo buscador)");
const home = await buscar(BASE + "/");
for (const p of PAGINAS) {
	checar(`link para ${p.caminho}`, home.corpo.indexOf(`href="${p.caminho}"`) >= 0);
}

console.log("\nsitemap.xml e llms.txt");
const sm = await buscar(BASE + "/sitemap.xml");
checar("sitemap é XML", sm.tipo.indexOf("xml") >= 0, sm.tipo);
checar("sitemap tem as 4 URLs", (sm.corpo.match(/<loc>/g) ?? []).length === 4);
checar("sitemap tem lastmod", sm.corpo.indexOf("<lastmod>") >= 0);

const llms = await buscar(BASE + "/llms.txt");
checar("llms.txt lista as páginas", PAGINAS.every((p) => llms.corpo.indexOf(BASE + p.caminho) >= 0));

console.log(`\n${ok} checks OK, ${falhas} falha(s)`);
if (falhas > 0) process.exit(1);

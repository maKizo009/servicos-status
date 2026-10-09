/** Harness do card hidro: garante card visual enxuto (sem parágrafo técnico). */
import { readFileSync } from "node:fs";

const html = readFileSync(
	"/root/servicos-status/src/public/index.html",
	"utf8",
);
function extractFn(src: string, name: string): string {
	const start = src.indexOf(`function ${name}(`);
	if (start < 0) throw new Error(name + " não achado");
	const i = src.indexOf("{", start);
	let depth = 0;
	for (let j = i; j < src.length; j++) {
		if (src[j] === "{") depth++;
		else if (src[j] === "}") {
			depth--;
			if (depth === 0) return src.slice(start, j + 1);
		}
	}
	throw new Error("chaves desbalanceadas em " + name);
}
const src = extractFn(html, "renderHidroCard");

const els: Record<
	string,
	{ style: Record<string, string>; innerHTML: string; textContent: string }
> = {};
const mk = () => ({
	style: {} as Record<string, string>,
	innerHTML: "",
	textContent: "",
	dataset: {} as Record<string, string>,
	addEventListener: () => {},
	classList: { add: () => {}, remove: () => {}, toggle: () => {} },
});
(globalThis as Record<string, unknown>).document = {
	getElementById: (id: string) => (els[id] ??= mk()),
	addEventListener: () => {},
};
(globalThis as Record<string, unknown>).window = {};
(globalThis as Record<string, unknown>).localStorage = {
	getItem: () => null,
	setItem: () => {},
};
(globalThis as Record<string, unknown>).esc = (s: unknown) => String(s ?? "");
// Refator da página tirou estadoRio/num/riscoTransbordo/riscoFrase de perto do
// renderHidroCard e o harness não acompanhava (ReferenceError pré-existente).
// estadoRio vira stub; as frases de risco vêm EXTRAÍDAS da página — é elas que
// este harness protege (sem jargão no card).
(globalThis as Record<string, unknown>).num = (v: unknown, d = 0) =>
	Number(v ?? 0).toFixed(d).replace(".", ",");
(globalThis as Record<string, unknown>).estadoRio = () => ({
	estacao: "Uvaia",
	rotulo: "Alerta",
	nivel: "crit",
	chave: "alerta",
	recessao: null,
});
(globalThis as Record<string, unknown>).estadoDaFaixa = (f: unknown) =>
	String(f ?? "normal");
(globalThis as Record<string, unknown>).icoMS = (nome: unknown, tam?: unknown) =>
	`<span class="ms" aria-hidden="true">${String(nome)}</span>`;

const srcRisco = `${extractFn(html, "riscoTransbordo")};${extractFn(html, "riscoFrase")}`;
const fn = new Function(
	`${srcRisco};${src}; return renderHidroCard;`,
)() as (d: unknown) => void;
const data = {
	hidro: {
		estacoes: [
			{
				// Uvaia = a estação que o card mostra (Cebolão/Jataizinho saíram por
				// design em 24/09/2026 — réguas do Tibagi, não da bacia do Bitumirim).
				nome: "Uvaia (x)",
				codigo: "64444000",
				nivelCm: 370,
				vazaoM3s: 1179,
				delta6hCm: 5,
				faixa: "alerta",
				papel: "Central",
			},
		],
		riscoCheia: "watch",
		resumoRisco: "PARAGRAFO TECNICO QUE NAO DEVE APARECER",
		atualizadoEm: Date.now(),
		permanencia: {
			diasEstimados: 7,
			nivel: "vermelho",
			uvaiaCm: 1189,
			preliminar: true,
			motivos: ["motivo teste"],
		},
		ifl: { score: 0.1, nivel: "verde", motivos: [] },
		regime: "convectivo",
	},
};
fn(data);
const out = els["hidroContent"].innerHTML;
const checks: Array<[string, boolean]> = [
	["sem parágrafo técnico", !out.includes("PARAGRAFO TECNICO")],
	// Regras de 08/10/2026 (auditoria de acessibilidade): jargão fora do card.
	["sem jargão 'vazão'", !out.includes("vazão")],
	["'água passando' no lugar de vazão", out.includes("água passando")],
	[
		"risco em linguagem de gente (mock = indefinido)",
		out.includes("Ainda não dá para estimar se o rio vai transbordar"),
	],
	// (checks "frase simples vermelho" e "badge faixa" atualizadas 08/10/2026:
	// "evite áreas baixas" não existe mais na página e o chip por estação só
	// renderiza com mais de uma estação — as antigas nunca passariam.)
	[
		"chip do cabeçalho recebe o mesmo estado do herói",
		els["riosChip"].textContent === "Alerta" &&
			els["riosChip"].dataset.nivel === "crit",
	],
	["botão fórmula", out.includes("Como é calculado")],
	["link JSON", out.includes("/api/hidro")],
	["link sugestões", out.includes("Sugerir melhoria")],
	[
		"disclaimer curto",
		out.includes("não medição oficial") &&
			!out.includes("saia de área de risco"),
	],
	// (check "tag FLASH/RIOS" removida 08/10/2026: o elemento hidroStatusTag
	// não existe mais na página — era código morto que quebrava o harness.)
];
let fail = 0;
for (const [n, ok] of checks) {
	console.log(ok ? "pass" : "FAIL", "-", n);
	if (!ok) fail++;
}
if (fail > 0) process.exit(1);
console.log("CARD OK");

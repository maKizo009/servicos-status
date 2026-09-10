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

const fn = new Function(`${src}; return renderHidroCard;`)() as (
	d: unknown,
) => void;
const data = {
	hidro: {
		estacoes: [
			{
				nome: "Cebolão (x)",
				codigo: "64504210",
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
	["frase simples vermelho", out.includes("evite áreas baixas")],
	["badge faixa", out.includes("alerta</span>")],
	["botão fórmula", out.includes("Como é calculado")],
	["link JSON", out.includes("/api/hidro")],
	["link sugestões", out.includes("Sugerir melhoria")],
	[
		"disclaimer curto",
		out.includes("não medição oficial") &&
			!out.includes("saia de área de risco"),
	],
	["tag FLASH/RIOS", els["hidroStatusTag"].textContent.includes("VERMELHO")],
];
let fail = 0;
for (const [n, ok] of checks) {
	console.log(ok ? "pass" : "FAIL", "-", n);
	if (!ok) fail++;
}
if (fail > 0) process.exit(1);
console.log("CARD OK");

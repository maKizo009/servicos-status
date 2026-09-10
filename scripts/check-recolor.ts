/** Harness: aplica a LUT Simepar (copiada do frontend) num tile real. */
import { PNG } from "pngjs";
import { readFileSync, writeFileSync } from "node:fs";

const html = readFileSync("/root/servicos-status/src/public/index.html", "utf8");
function grab(name: string): string {
	const m = html.match(new RegExp(`(const ${name} = \\[[\\s\\S]*?\\];|function ${name}\\([\\s\\S]*?\\n\\})`));
	if (!m) throw new Error("não achei " + name);
	return m[1];
}
const src = [grab("UB_STOPS"), grab("SIM_STOPS"), grab("ubDbz"), grab("simColor")].join("\n");
const fn = new Function(`${src}; return { ubDbz, simColor };`)() as {
	ubDbz: (r: number, g: number, b: number) => number;
	simColor: (d: number) => number[];
};

// sanity da LUT
for (const [rgb, want] of [
	[[0, 136, 191], "verde"],
	[[255, 197, 0], "amarelo"],
	[[217, 27, 0], "vermelho"],
	[[255, 139, 255], "rosa"],
] as const) {
	const dbz = fn.ubDbz(...rgb);
	console.log(rgb.join(","), "-> dbz", dbz, "->", fn.simColor(dbz).join(","));
}

const png = PNG.sync.read(readFileSync("/tmp/rv_tile.png"));
const out = new PNG({ width: png.width, height: png.height });
let n = 0;
for (let i = 0; i < png.data.length; i += 4) {
	const a = png.data[i + 3];
	out.data[i + 3] = a;
	if (a < 40) continue;
	const dbz = fn.ubDbz(png.data[i], png.data[i + 1], png.data[i + 2]);
	if (dbz < 5) {
		out.data[i + 3] = 0;
		continue;
	}
	const c = fn.simColor(dbz);
	out.data[i] = c[0];
	out.data[i + 1] = c[1];
	out.data[i + 2] = c[2];
	n++;
}
writeFileSync("/tmp/rv_recolor.png", PNG.sync.write(out));
console.log(`pixels recoloridos: ${n} de ${png.width * png.height}`);

// Gera os ícones do PWA (verde institucional #00923F + pin branco).
// Uso: bun run scripts/build-icons.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PNG } from "pngjs";

function makeIcon(size: number, path: string): void {
	const png = new PNG({ width: size, height: size });
	const buf = png.data;
	const bg: [number, number, number] = [0, 0x92, 0x3f];
	const fg: [number, number, number] = [255, 255, 255];
	// fundo verde arredondado (círculo inscrito no quadrado)
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const i = (y * size + x) * 4;
			// raio do canto ~22% (quadrado arredondado M3)
			const corner = Math.min(x, y, size - 1 - x, size - 1 - y);
			const r = Math.round(size * 0.22);
			if (corner < r) {
				const dx = x < size / 2 ? x - r : size - 1 - x - r;
				const dy = y < size / 2 ? y - r : size - 1 - y - r;
				if (dx * dx + dy * dy > r * r) {
					buf[i + 3] = 0;
					continue;
				}
			}
			buf[i] = bg[0];
			buf[i + 1] = bg[1];
			buf[i + 2] = bg[2];
			buf[i + 3] = 255;
		}
	}
	// pin de localização branco (círculo + gota simplificada)
	const cx = size / 2;
	const cy = size * 0.42;
	const rBig = size * 0.26;
	const rDot = size * 0.085;
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const dx = x - cx;
			const dy = y - cy;
			const inCircle = dx * dx + dy * dy <= rBig * rBig;
			const inStem =
				x >= cx - rBig * 0.35 &&
				x <= cx + rBig * 0.35 &&
				y >= cy &&
				y <= cy + rBig * 1.1;
			const dotDx = x - cx;
			const dotDy = y - (cy + rBig * 1.05);
			const inDot = dotDx * dotDx + dotDy * dotDy <= rDot * rDot;
			const holeDx = x - cx;
			const holeDy = y - cy;
			const inHole = holeDx * holeDx + holeDy * holeDy <= rDot * rDot * 0.9;
			if ((inCircle || inStem || inDot) && !inHole) {
				const i = (y * size + x) * 4;
				buf[i] = fg[0];
				buf[i + 1] = fg[1];
				buf[i + 2] = fg[2];
			}
		}
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, PNG.sync.write(png));
	console.log(`✓ ${path} (${size}x${size})`);
}

makeIcon(192, "src/public/icons/icon-192.png");
makeIcon(512, "src/public/icons/icon-512.png");
makeIcon(96, "src/public/icons/icon-96.png");

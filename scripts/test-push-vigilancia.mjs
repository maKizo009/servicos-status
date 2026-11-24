import { test } from "node:test";
import assert from "node:assert/strict";
import { conteudoPushVigilancia } from "../src/push-vigilancia.ts";

// Replay resumido do núcleo acompanhado em 24/11/2026.
const threats = [{ kind: "nucleo", intensity: "extreme", relevanceZone: "watch",
	trackedMovement: { confirmed: true }, framesVivo: 3, distToTargetKm: 185.351,
	threat: { approach: "approaching", etaMin: 230.95 } }];
const now = 1_800_000_000_000;
const changed = (patch) => [{ ...threats[0], ...patch }];
test("núcleo real confirmado em trajetória produz vigilância prudente", () => {
	const aviso = conteudoPushVigilancia(threats, now - 600_000, now);
	assert.match(aviso.titulo, /Vigilância/);
	assert.match(aviso.corpo, /185 km/);
	assert.match(aviso.corpo, /231 minutos/);
	assert.match(aviso.corpo, /Pode mudar/);
});
test("movimento não confirmado, afastamento, intensidade e dados antigos não avisam", () => {
	assert.equal(conteudoPushVigilancia(changed({ trackedMovement: { confirmed: false } }), now, now), null);
	assert.equal(conteudoPushVigilancia(changed({ framesVivo: 2 }), now, now), null);
	assert.equal(conteudoPushVigilancia(changed({ threat: { approach: "receding", etaMin: 100 } }), now, now), null);
	assert.equal(conteudoPushVigilancia(changed({ intensity: "heavy" }), now, now), null);
	assert.equal(conteudoPushVigilancia(changed({ threat: { approach: "approaching", etaMin: 241 } }), now, now), null);
	assert.equal(conteudoPushVigilancia(threats, now - 31 * 60_000, now), null);
});

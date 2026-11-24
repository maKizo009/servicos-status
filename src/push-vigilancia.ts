import type { ThreatCell } from "./radar-analysis.js";

/** Vigilância restrita a um núcleo extremo com trajetória individual confirmada. */
export function conteudoPushVigilancia(threats: ThreatCell[], frameTime: number | null, agora = Date.now()): { titulo: string; corpo: string } | null {
	if (frameTime == null || !Number.isFinite(frameTime) || frameTime > agora || agora - frameTime > 30 * 60_000) return null;
	const nucleo = threats.find((t) =>
		t.kind === "nucleo" && t.intensity === "extreme" &&
		t.relevanceZone === "watch" && t.trackedMovement?.confirmed === true && (t.framesVivo ?? 0) >= 3 &&
		t.threat?.approach === "approaching" &&
		Number.isFinite(t.distToTargetKm) && t.distToTargetKm <= 200 &&
		typeof t.threat.etaMin === "number" && Number.isFinite(t.threat.etaMin) && t.threat.etaMin > 0 && t.threat.etaMin <= 240,
	);
	if (!nucleo) return null;
	const distancia = Math.round(nucleo.distToTargetKm);
	const minutos = Math.round(nucleo.threat!.etaMin!);
	return {
		titulo: "⛈️ Vigilância de chuva forte para Ipiranga",
		corpo: `Núcleo de chuva muito forte a cerca de ${distancia} km, aproximando-se; chegada estimada em ${minutos} minutos se mantiver o rumo e a velocidade. Pode mudar de direção ou intensidade. Acompanhe o radar.`,
	};
}

/**
 * Preview local do Monitor Ipiranga — serve src/public e responde as rotas
 * /api/* com os fixtures reais capturados de produção (scripts/fixtures/).
 *
 * Por que existe: a página é um index.html monolítico que depende de 4 APIs
 * (services, weather, stats, push) para sair do esqueleto. Sem elas o preview
 * mostra só "Carregando..." e não dá pra julgar layout nenhum.
 *
 * Uso:  bun run scripts/preview-mock.ts        (porta 8099)
 *       PORT=9000 bun run scripts/preview-mock.ts
 *       ESTADO=tempestade bun run scripts/preview-mock.ts   (takeover laranja)
 *
 * Os fixtures vêm de `curl https://servicos-status.vercel.app/api/<rota>` —
 * recapture com `scripts/fixtures/atualizar.sh` quando quiser dados frescos.
 */
import { join, extname } from 'node:path';
import { existsSync } from 'node:fs';

const RAIZ = new URL('../src/public/', import.meta.url).pathname;
const FIXTURES = new URL('./fixtures/', import.meta.url).pathname;
const PORTA = Number(process.env.PORT || 8099);
const ESTADO = process.env.ESTADO || '';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function fixture(nome: string) {
  const f = Bun.file(join(FIXTURES, nome));
  if (!(await f.exists())) return null;
  return JSON.parse(await f.text());
}

/** Estado "tempestade": alertaUnificado laranja + núcleo perto — testa o takeover. */
function tempestade(w: any) {
  const c = structuredClone(w);
  c.alertaUnificado = {
    nivel: 'laranja',
    titulo: 'Alerta meteorológico — chuva forte se aproximando',
    descricao: 'Alerta meteorológico — chuva forte se aproximando. Motivos: núcleo de chuva forte a 32 km com deslocamento para Ipiranga (ETA ~55 min).',
    motivos: ['núcleo de chuva forte a 32 km', 'deslocamento para Ipiranga (ETA ~55 min)'],
    avisosOficiais: [{ fonte: 'INMET', titulo: 'Aviso de chuva intensa', nivel: 'laranja' }],
  };
  c.alertLevel = 'alert';
  c.nearestThreatKm = 32;
  c.hasRegionalRain = true;
  c.regionalRainAlert = 'Chuva forte a ~32 km, vindo para Ipiranga (ETA ~55 min).';
  if (c.nowcast?.nearestCell) {
    c.nowcast.nearestCell.lat = -25.16;
    c.nowcast.nearestCell.lon = -50.42;
  }
  return c;
}

Bun.serve({
  port: PORTA,
  idleTimeout: 30,
  async fetch(req) {
    const url = new URL(req.url);
    const p = decodeURIComponent(url.pathname);

    // ---- rotas de API (fixtures) ----
    if (p === '/api/services') {
      const d = await fixture('services.json');
      return d ? json(d) : json({ error: 'sem fixture' }, 500);
    }
    if (p === '/api/weather') {
      let d = await fixture('weather.json');
      if (!d) return json({ error: 'sem fixture' }, 500);
      if (ESTADO === 'tempestade') d = tempestade(d);
      return json(d);
    }
    if (p === '/api/stats/daily') {
      const d = await fixture('stats.json');
      return d ? json(d) : json({ error: 'sem fixture' }, 500);
    }
    if (p === '/api/push/status') return json({ configured: false });
    if (p === '/api/admin/me') return json({ authed: false });
    if (p === '/api/hidro') return json((await fixture('weather.json'))?.hidro ?? {});
    if (p === '/api/track') return new Response(null, { status: 204 });
    if (p.startsWith('/api/')) return json({ error: 'rota não mockada' }, 404);

    // ---- estáticos de src/public ----
    let alvo = p === '/' ? '/index.html' : p;
    if (alvo.endsWith('/')) alvo += 'index.html';
    const arquivo = join(RAIZ, alvo);
    if (!arquivo.startsWith(RAIZ) || !existsSync(arquivo)) {
      return new Response('não encontrado: ' + alvo, { status: 404 });
    }
    return new Response(Bun.file(arquivo), {
      headers: { 'content-type': MIME[extname(arquivo)] || 'application/octet-stream', 'cache-control': 'no-store' },
    });
  },
});

console.log(`preview: http://localhost:${PORTA}${ESTADO ? ` (estado=${ESTADO})` : ''}`);

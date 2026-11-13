import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8');
const names = ['montarRadarDoIndice', 'baixarIndiceRainViewer', 'bootstrapRadar', 'refreshRadar', 'fetchWeatherData'];
const functions = names.map((name) => {
  const start = html.search(new RegExp(`^(async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, name);
  return html.slice(start, html.indexOf('\n}', start) + 2);
}).join('\n');

const index = (...times) => ({ host: 'https://radar.test', radar: {
  past: times.map((time) => ({ time, path: `/radar/${time}` })), nowcast: []
} });

function setup() {
  const slider = { value: 0, max: 0 };
  const layers = new Set();
  let mounts = 0;
  const ctx = vm.createContext({
    console: { ...console, warn() {} }, AbortSignal, window: {}, navigator: { connection: { saveData: true } },
    document: { getElementById: (id) => id === 'radarSlider' ? slider : null },
    setTimeout: () => {},
    map: { removeLayer: (layer) => layers.delete(layer), hasLayer: (layer) => layers.has(layer) },
    L: { tileLayer: () => {
      mounts++;
      return { addTo() { layers.add(this); return this; }, on() {}, once() {} };
    } },
    renderNowcastCard() {}, renderCemadenCard() {}, renderHidroCard() {}, renderClimaIA() {},
    renderAlertaCard() {}, renderTopAlert() {}, entradaPainel() {},
    showRadarFrame(i) { ctx.shown = vm.runInContext(`radarFrames[${i}].time`, ctx); }
  });
  vm.runInContext('let radarFrames = [], radarTileLayers = [], radarPastCount = 0, currentFrameIndex = 0, radarIndexRequest = null;', ctx);
  vm.runInContext(functions, ctx);
  return { ctx, slider, mounts: () => mounts };
}

test('scripts inline mantêm sintaxe JavaScript válida', () => {
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (!match[1].includes('application/ld+json')) new vm.Script(match[2]);
  }
});

test('a API antiga não desfaz o radar fresco nem remonta os tiles a cada poll', async () => {
  const { ctx, mounts } = setup();
  ctx.montarRadarDoIndice(index(100, 200), false);
  ctx.fetch = async () => ({ ok: true, json: async () => ({ radar: index(10, 20) }) });
  for (let i = 0; i < 3; i++) await ctx.fetchWeatherData();
  assert.equal(ctx.shown, 200);
  assert.equal(mounts(), 2);
  assert.equal(ctx.window._radarUltimoFrame, '/radar/200');
});

test('boot busca imagem atual mesmo quando a API antiga chega primeiro', async () => {
  const { ctx } = setup();
  ctx.montarRadarDoIndice(index(10, 20), true);
  ctx.fetch = async () => ({ ok: true, json: async () => index(100, 200) });
  await ctx.bootstrapRadar();
  assert.equal(ctx.shown, 200);
  assert.equal(ctx.window._radarBootstrap, true);
});

test('resposta direta mais antiga não regride o radar nem o marcador de refresh', async () => {
  const { ctx, mounts } = setup();
  ctx.montarRadarDoIndice(index(100, 200), false);
  ctx.fetch = async () => ({ ok: true, json: async () => index(10, 20) });
  await ctx.refreshRadar();
  assert.equal(ctx.shown, 200);
  assert.equal(ctx.window._radarUltimoFrame, '/radar/200');
  assert.equal(mounts(), 2);
});

test('modo ao vivo avança para o último observado sem selecionar previsão', () => {
  const { ctx, slider } = setup();
  ctx.montarRadarDoIndice(index(100, 200), false);
  const next = index(200, 300, 400);
  next.radar.nowcast = [{ time: 500, path: '/forecast/500' }];
  ctx.montarRadarDoIndice(next, true);
  assert.equal(ctx.shown, 400);
  assert.equal(slider.value, 2);
});

test('seleção de histórico acompanha o horário quando a janela muda', () => {
  const { ctx } = setup();
  ctx.montarRadarDoIndice(index(100, 200, 300), false);
  vm.runInContext('currentFrameIndex = 1;', ctx);
  ctx.montarRadarDoIndice(index(200, 300, 400), true);
  assert.equal(ctx.shown, 200);
});

test('índice repetido não remonta camadas', () => {
  const { ctx, mounts } = setup();
  ctx.montarRadarDoIndice(index(100, 200), false);
  assert.equal(ctx.montarRadarDoIndice(index(100, 200), true), false);
  assert.equal(mounts(), 2);
});

test('boot e refresh simultâneos compartilham uma consulta e recuperam após erro', async () => {
  const { ctx } = setup();
  let calls = 0;
  let release;
  ctx.fetch = () => {
    calls++;
    return new Promise((resolve) => { release = resolve; });
  };
  const boot = ctx.bootstrapRadar();
  const refresh = ctx.refreshRadar();
  assert.equal(calls, 1);
  release({ ok: true, json: async () => index(100, 200) });
  await Promise.all([boot, refresh]);
  assert.equal(ctx.shown, 200);
  ctx.fetch = async () => { throw new Error('offline'); };
  await ctx.refreshRadar();
  ctx.fetch = async () => ({ ok: true, json: async () => index(200, 300) });
  await ctx.refreshRadar();
  assert.equal(ctx.shown, 300);
});

test('resposta recebida antes do mapa não impede a tentativa seguinte', async () => {
  const { ctx } = setup();
  const map = ctx.map;
  ctx.map = null;
  assert.equal(ctx.montarRadarDoIndice(index(100, 200), true), false);
  assert.equal(ctx.window._radarUltimoFrame, undefined);
  ctx.map = map;
  assert.equal(ctx.montarRadarDoIndice(index(100, 200), true), true);
  assert.equal(ctx.shown, 200);
});

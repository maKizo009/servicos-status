import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8');
const names = [
  'montarRadarDoIndice', 'baixarIndiceRainViewer', 'bootstrapRadar', 'refreshRadar',
  'radarTileUrl', 'showRadarFrame', 'fitIpiranga', 'fetchWeatherData',
];
const functions = names.map((name) => {
  const start = html.search(new RegExp(`^(async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, name);
  return html.slice(start, html.indexOf('\n}', start) + 2);
}).join('\n');

const index = (...times) => ({ host: 'https://radar.test', radar: {
  past: times.map((time) => ({ time, path: `/radar/${time}` })), nowcast: []
} });

function setup() {
  const layers = new Set();
  let mounts = 0;
  const ctx = vm.createContext({
    console: { ...console, warn() {} }, AbortSignal, window: {},
    document: { getElementById: () => null },
    map: { removeLayer: (layer) => layers.delete(layer), hasLayer: (layer) => layers.has(layer) },
    L: { tileLayer: () => {
      mounts++;
      return { addTo() { layers.add(this); return this; }, on() {}, once() {}, setOpacity() {} };
    } },
    renderNowcastCard() {}, renderCemadenCard() {}, renderHidroCard() {}, renderClimaIA() {},
    renderAlertaCard() {}, renderTopAlert() {}, entradaPainel() {},
    enableRadarBackground() {}, updateRadarDirection() {}, updateMapStatus() {},
    updateWeatherPlayer() { ctx.shown = vm.runInContext('radarFrames[currentFrameIndex].time', ctx); }
  });
  const state = html.slice(html.indexOf("let mapProduct = 'radar';"), html.indexOf('function localDateLabel'));
  vm.runInContext(`${state}\nlet radarIndexRequest = null;\n${functions}`, ctx);
  return { ctx, layers, mounts: () => mounts };
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
  const { ctx } = setup();
  ctx.montarRadarDoIndice(index(100, 200), false);
  const next = index(200, 300, 400);
  next.radar.nowcast = [{ time: 500, path: '/forecast/500' }];
  ctx.montarRadarDoIndice(next, true);
  assert.equal(ctx.shown, 400);
  assert.equal(vm.runInContext('currentFrameIndex', ctx), 2);
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

test('atualização recebida em Satélite prepara o radar sem montar seus tiles', () => {
  const { ctx, layers } = setup();
  vm.runInContext("mapProduct = 'satellite';", ctx);
  assert.equal(ctx.montarRadarDoIndice(index(100, 200), true), true);
  assert.equal(layers.size, 0);
  vm.runInContext("mapProduct = 'radar'; showRadarFrame(radarPastCount - 1);", ctx);
  assert.equal(layers.size, 1);
  assert.equal(ctx.shown, 200);
});


test('recentraliza no enquadramento de Ipiranga sem alterar o zoom mínimo', () => {
  const { ctx } = setup();
  ctx.ipiranga = [-25.0244, -50.5847];
  ctx.radarArea = {};
  ctx.map.getSize = () => ({ x: 360, y: 252 });
  ctx.map.getBoundsZoom = (area) => {
    assert.equal(area, ctx.radarArea);
    return 7.75;
  };
  let view;
  ctx.map.setView = (center, zoom) => { view = { center, zoom }; };
  ctx.fitIpiranga();
  assert.deepEqual(view, { center: ctx.ipiranga, zoom: 7.75 });
});

test('mantém apenas a camada do quadro em exibição ao percorrer o histórico', () => {
  const { ctx, layers } = setup();
  ctx.montarRadarDoIndice(index(100, 200, 300), false);
  const latest = [...layers][0];
  ctx.showRadarFrame(1);
  assert.equal(layers.size, 1);
  assert.equal(layers.has(latest), false);
  assert.equal(ctx.shown, 200);
});

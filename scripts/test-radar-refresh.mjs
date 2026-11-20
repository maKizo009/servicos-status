import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8');
const names = [
  'montarRadarDoIndice', 'baixarIndiceRainViewer', 'bootstrapRadar', 'refreshRadar',
  'radarTileUrl', 'showRadarFrame', 'fitIpiranga', 'fetchWeatherData',
  'cancelRadarPreparation', 'prepareRadarFrame', 'prefetchNextRadarFrame',
  'radarPlayNext', 'scheduleRadarFrame',
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
    console: { ...console, warn() {} }, AbortSignal, window: {}, setTimeout, clearTimeout,
    navigator: { connection: { saveData: true } },
    document: { hidden: false, getElementById: () => null },
    map: { removeLayer: (layer) => layers.delete(layer), hasLayer: (layer) => layers.has(layer) },
    L: { tileLayer: () => {
      mounts++;
      return { addTo() { layers.add(this); return this; }, on() {}, once() {}, off() {}, setOpacity() {}, isLoading() { return false; } };
    } },
    renderNowcastCard() {}, renderCemadenCard() {}, renderHidroCard() {}, renderClimaIA() {},
    renderAlertaCard() {}, renderTopAlert() {}, entradaPainel() {},
    enableRadarBackground() {}, updateRadarDirection() {}, updateMapStatus() {}, checkRadarEmpty() {}, pauseWeatherPlayer() {},
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

test('mantém a imagem até o próximo quadro carregar e cancela ouvintes obsoletos', async () => {
  const { ctx, layers } = setup();
  const created = [];
  ctx.L.tileLayer = () => {
    const listeners = new Map();
    const layer = {
      loading: false,
      addTo() { this.loading = true; layers.add(this); return this; },
      on(type, fn) { const list = listeners.get(type) || []; list.push(fn); listeners.set(type, list); },
      once(type, fn) { this.on(type, fn); },
      off(type, fn) { listeners.set(type, (listeners.get(type) || []).filter((f) => f !== fn)); },
      setOpacity(value) { this.opacity = value; },
      isLoading() { return this.loading; },
      emit(type) { if (type === 'load') this.loading = false; for (const fn of [...(listeners.get(type) || [])]) fn(); },
      listeners(type) { return (listeners.get(type) || []).length; }
    };
    created.push(layer);
    return layer;
  };
  ctx.montarRadarDoIndice(index(100, 200, 300), false);
  created[2].emit('load');
  ctx.showRadarFrame(0);
  assert.equal(ctx.shown, 300);
  assert.equal(layers.size, 2);
  ctx.showRadarFrame(2);
  assert.equal(layers.size, 1);
  assert.equal(created[0].listeners('load'), 1);
  ctx.showRadarFrame(0);
  ctx.showRadarFrame(1);
  assert.equal(layers.size, 2);
  assert.equal(created[0].listeners('load'), 1); // listener permanente da camada
  assert.equal(created[0].listeners('tileerror'), 1);
  created[1].emit('load');
  assert.equal(ctx.shown, 300); // Leaflet termina o callback antes da troca.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ctx.shown, 200);
  assert.equal(layers.size, 1);
  assert.equal(created[1].opacity, .75);
});

test('refresh reaproveita camadas ainda presentes no índice', () => {
  const { ctx, mounts } = setup();
  ctx.montarRadarDoIndice(index(100, 200, 300), false);
  ctx.montarRadarDoIndice(index(200, 300, 400), true);
  assert.equal(mounts(), 4);
  assert.equal(ctx.shown, 400);
});

test('preferências inválidas ou storage indisponível usam os padrões', () => {
  const { ctx } = setup();
  ctx.localStorage = { getItem: () => '{inválido' };
  assert.equal(vm.runInContext("readWeatherPreferences().product", ctx), 'radar');
  assert.equal(vm.runInContext("readWeatherPreferences().photo", ctx), false);
  ctx.localStorage = { getItem() { throw new Error('bloqueado'); } };
  assert.equal(vm.runInContext("readWeatherPreferences().product", ctx), 'radar');
  ctx.localStorage = { getItem: () => JSON.stringify({ product: 'satellite', photo: true }) };
  assert.equal(vm.runInContext("readWeatherPreferences().product", ctx), 'satellite');
  assert.equal(vm.runInContext("readWeatherPreferences().photo", ctx), true);
});


test('tile isolado com erro não interrompe quadro com outros tiles carregados', async () => {
  const { ctx, layers } = setup();
  const created = [];
  ctx.L.tileLayer = () => {
    const listeners = new Map();
    const layer = {
      loading: false,
      addTo() { this.loading = true; layers.add(this); this.emit('loading'); return this; },
      on(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]); },
      once(type, fn) { this.on(type, fn); },
      off(type, fn) { listeners.set(type, (listeners.get(type) || []).filter((f) => f !== fn)); },
      setOpacity(value) { this.opacity = value; },
      isLoading() { return this.loading; },
      emit(type) { if (type === 'load') this.loading = false; for (const fn of [...(listeners.get(type) || [])]) fn(); }
    };
    created.push(layer);
    return layer;
  };
  ctx.montarRadarDoIndice(index(100, 200, 300), false);
  created[2].emit('tileload');
  created[2].emit('load');
  ctx.showRadarFrame(0);
  created[0].emit('tileerror');
  created[0].emit('tileload');
  created[0].emit('load');
  assert.equal(ctx.shown, 300);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ctx.shown, 100);
  assert.equal(vm.runInContext('radarIndexError', ctx), false);

  // Um quadro inteiramente indisponível é pulado, conservando o último visível.
  vm.runInContext('playInterval = 1', ctx);
  ctx.radarPlayNext = (index) => { ctx.skipped = index; };
  ctx.showRadarFrame(1);
  created[1].emit('tileerror');
  created[1].emit('load');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ctx.skipped, 1);
  assert.equal(ctx.shown, 100);
  assert.equal(vm.runInContext('radarIndexError', ctx), false);
});

test('ao retornar ao quadro exibido durante reprodução, agenda outra tentativa', () => {
  const { ctx } = setup();
  ctx.montarRadarDoIndice(index(100, 200), false);
  ctx.scheduleRadarFrame = () => { ctx.scheduled = true; };
  vm.runInContext('playInterval = 1', ctx);
  ctx.showRadarFrame(1);
  assert.equal(ctx.scheduled, true);
});


test('status aguarda a primeira imagem e preserva foco durante aviso parcial', () => {
  const { ctx, layers } = setup();
  const created = [];
  ctx.L.tileLayer = () => {
    const listeners = new Map();
    const layer = {
      addTo() { layers.add(this); this.emit('loading'); return this; },
      on(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]); },
      once(type, fn) { this.on(type, fn); },
      off() {}, setOpacity() {}, isLoading() { return true; },
      emit(type) { for (const fn of listeners.get(type) || []) fn(); }
    };
    created.push(layer);
    return layer;
  };
  const status = { hidden: false, textContent: '' };
  const retry = { hidden: true };
  let focused = false;
  const product = { focus() { focused = true; } };
  ctx.document.getElementById = (id) => ({ radarMapStatus: { firstElementChild: status }, radarRetry: retry, radarProduct: product })[id];
  const start = html.indexOf('function updateMapStatus() {');
  vm.runInContext(html.slice(start, html.indexOf('\n}', start) + 2), ctx);
  ctx.montarRadarDoIndice(index(100, 200), false);
  assert.equal(status.textContent, 'Carregando imagem…');
  created[1].emit('tileload');
  assert.equal(status.hidden, true);
  // Um quadro de fundo ainda carregando não oculta o quadro já utilizável.
  vm.runInContext('radarPreparingLayer = {}', ctx);
  ctx.updateMapStatus();
  assert.equal(status.hidden, true);
  ctx.document.activeElement = retry;
  vm.runInContext('radarPartialTiles.add(radarDisplayedLayer)', ctx);
  ctx.updateMapStatus();
  assert.equal(status.textContent, 'Imagem parcialmente indisponível');
  assert.equal(retry.hidden, false);
  assert.equal(focused, false);
  vm.runInContext('radarPartialTiles.delete(radarDisplayedLayer)', ctx);
  ctx.updateMapStatus();
  assert.equal(focused, true);
});


test('boot prioriza índice ao vivo quando API persistida chegou antes do mapa', async () => {
  const { ctx, mounts } = setup();
  ctx.window.latestWeatherData = { radar: index(10, 20) };
  let release;
  ctx.fetch = () => new Promise((resolve) => { release = resolve; });
  const boot = ctx.bootstrapRadar();
  assert.equal(mounts(), 0);
  release({ ok: true, json: async () => index(100, 200) });
  await boot;
  assert.equal(ctx.shown, 200);
  assert.equal(mounts(), 2);
});

test('boot usa radar persistido quando índice ao vivo falha', async () => {
  const { ctx } = setup();
  ctx.window.latestWeatherData = { radar: index(10, 20) };
  ctx.fetch = async () => { throw new Error('offline'); };
  await ctx.bootstrapRadar();
  assert.equal(ctx.shown, 20);
  assert.equal(vm.runInContext('radarIndexError', ctx), false);
});

test('boot libera fallback após a espera curta e depois aceita índice mais novo', async () => {
  const { ctx } = setup();
  ctx.window.latestWeatherData = { radar: index(10, 20) };
  let release, expire;
  ctx.setTimeout = (fn, ms) => { if (ms === 1000) expire = fn; return 1; };
  ctx.clearTimeout = () => {};
  ctx.fetch = () => new Promise((resolve) => { release = resolve; });
  const boot = ctx.bootstrapRadar();
  expire();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(ctx.shown, 20);
  release({ ok: true, json: async () => index(100, 200) });
  await boot;
  assert.equal(ctx.shown, 200);
});

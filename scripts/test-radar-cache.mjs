import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/public/sw.js', import.meta.url), 'utf8');
const origin = 'https://servicos-status.vercel.app';
const rainViewer = 'https://tilecache.rainviewer.com';
const tile = (token, x = 45, style = '1_0') => `${rainViewer}/v2/radar/${token}/256/7/${x}/73/2/${style}.png`;
const recent = '9f661371f95c';

function worker(cacheStorage = new Map()) {
  const handlers = new Map();
  const cacheKey = (request) => typeof request === 'string' ? new URL(request, origin).href : request.url;
  const state = { calls: 0, clock: 1795116600000, outOfQuota: false, status: 200, type: 'image/png' };
  class Clock extends Date { static now() { return state.clock; } }

  const caches = {
    async open(name) {
      if (!cacheStorage.has(name)) cacheStorage.set(name, new Map());
      const entries = cacheStorage.get(name);
      return {
        async put(request, response) {
          if (state.outOfQuota) throw new Error('QuotaExceededError');
          entries.set(cacheKey(request), response.clone());
        },
        async match(request) { return entries.get(cacheKey(request))?.clone(); },
        async delete(request) { return entries.delete(cacheKey(request)); },
        async keys() { return [...entries.keys()].map((url) => new Request(url)); },
      };
    },
  };

  const fetch = async () => {
    state.calls++;
    return new Response('tile', { status: state.status, headers: { 'Content-Type': state.type } });
  };
  vm.runInNewContext(source, {
    self: { location: { origin }, addEventListener: (type, handler) => handlers.set(type, handler) },
    caches, fetch, URL, Request, Response, Date: Clock,
  }, { filename: 'sw.js' });

  return {
    cacheStorage,
    state,
    async request(url) {
      let handled;
      const extensions = [];
      const request = new Request(url, { mode: 'cors' });
      Object.defineProperty(request, 'destination', { value: 'image' });
      handlers.get('fetch')({
        request,
        respondWith: (promise) => { handled = promise; },
        waitUntil: (promise) => extensions.push(promise),
      });
      const response = await (handled || fetch(request));
      await Promise.all(extensions);
      return { intercepted: Boolean(handled), status: response.status };
    },
  };
}

test('o quadro recente e o histórico permanecem em cache após reabrir', async () => {
  const first = worker();
  const tiles = ['1795109400', '7449b1015ea3', recent].flatMap((token) => [tile(token), tile(token, 46)]);
  await Promise.all(tiles.map((url) => first.request(url)));
  assert.equal(first.state.calls, tiles.length);
  await Promise.all(tiles.map((url) => first.request(url)));
  assert.equal(first.state.calls, tiles.length);

  const reopened = worker(first.cacheStorage);
  await Promise.all(tiles.map((url) => reopened.request(url)));
  assert.equal(reopened.state.calls, 0);
  await reopened.request(tile(recent, 45, '1_1'));
  assert.equal(reopened.state.calls, 1);
});

test('o primeiro acesso após a expiração renova o quadro', async () => {
  const radar = worker();
  await radar.request(tile(recent));
  radar.state.clock += 7 * 60 * 60 * 1000;
  await radar.request(tile(recent));
  await radar.request(tile(recent));
  assert.equal(radar.state.calls, 2);
});

test('erros, respostas sem imagem e quota cheia permitem tentar o tile novamente', async () => {
  const radar = worker();
  const url = tile(recent);
  radar.state.status = 503;
  assert.equal((await radar.request(url)).status, 503);
  radar.state.status = 200;
  radar.state.type = 'text/html';
  await radar.request(url);
  radar.state.type = 'image/png';
  radar.state.outOfQuota = true;
  assert.equal((await radar.request(url)).status, 200);
  radar.state.outOfQuota = false;
  await radar.request(url);
  assert.equal(radar.state.calls, 4);
  await radar.request(url);
  assert.equal(radar.state.calls, 4);
});

test('o cache não intercepta o índice, as APIs do Monitor nem outros mapas', async () => {
  const radar = worker();
  const urls = [
    `${origin}/api/weather?view=dashboard`,
    'https://api.rainviewer.com/public/weather-maps.json',
    `${rainViewer}/v2/coverage/0/256/7/45/73/0/0_0.png`,
    'https://tile.openstreetmap.org/7/45/73.png',
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/7/73/45',
  ];
  for (const url of urls) assert.equal((await radar.request(url)).intercepted, false, url);
  assert.equal(radar.cacheStorage.size, 0);
});

test('a limpeza periódica impõe o limite de tiles após uso em vários enquadramentos', async () => {
  const radar = worker();
  const tokens = Array.from({ length: 11 }, (_, i) => i.toString(16).padStart(12, 'a')).concat(recent);
  for (const token of tokens) {
    await Promise.all(Array.from({ length: 25 }, (_, i) => radar.request(tile(token, 40 + i))));
  }
  const urls = [...radar.cacheStorage.values()].flatMap((cache) => [...cache.keys()]);
  const tiles = urls.filter((url) => url.startsWith(`${rainViewer}/`));
  assert.equal(tiles.length, 250);
  await radar.request(tile(recent, 64));
  assert.equal(radar.state.calls, 300);
});

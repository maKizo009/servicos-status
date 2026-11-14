import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizarPrevisaoDiaria } from '../src/previsao-cinco-dias.ts';

test('preserva data local, zeros reais e limite de cinco dias', () => {
  const dados = normalizarPrevisaoDiaria({time:['2026-11-14','2026-11-15','2026-11-16','2026-11-17','2026-11-18','2026-11-19'], precipitation_sum:[0,2,3,4,5,6], precipitation_probability_max:[0,10,20,30,40,50]});
  assert.equal(dados.length, 5);
  assert.equal(dados[0].data, '2026-11-14');
  assert.equal(dados[0].chuvaMm, 0);
  assert.equal(dados[0].probabilidadeMaximaPct, 0);
});

test('campos ausentes, inválidos e dias repetidos não fabricam valores', () => {
  const dados = normalizarPrevisaoDiaria({time:['2026-11-14','2026-11-14','inválida','2026-11-15'], precipitation_sum:[null,8,5,-1], precipitation_probability_max:[150,20,30,NaN]});
  assert.deepEqual(dados.map(d => d.data), ['2026-11-14','2026-11-15']);
  assert.equal(dados[0].chuvaMm, null);
  assert.equal(dados[1].chuvaMm, null);
  assert.equal(dados[0].probabilidadeMaximaPct, null);
  assert.equal(dados[1].probabilidadeMaximaPct, null);
  assert.deepEqual(normalizarPrevisaoDiaria(null), []);
});

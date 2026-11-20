import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8');
const functions = html.slice(html.indexOf('function formatarHoraAviso('), html.indexOf('function renderTopAlert('));
const { renderBoletinsInmet, avisosInmetUnicos } = vm.runInNewContext(
  `${functions}\n({ renderBoletinsInmet, avisosInmetUnicos })`,
  { URL, esc: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;') },
);

const principal = {
  titulo: 'Aviso de Tempestade. Severidade Grau: Perigo', nivel: 'laranja',
  inicio: '2026-11-20T09:16:00-03:00', fim: '2026-11-20T23:59:00-03:00',
  descricao: 'INMET publica aviso iniciando em: 20/11/2026 09:16. Há risco de granizo.',
  orientacoes: 'Não se abrigue debaixo de árvores.', link: 'https://avisos.inmet.gov.br/56457',
};
const secundario = {
  ...principal, titulo: 'Aviso de Tempestade. Severidade Grau: Perigo Potencial',
  nivel: 'amarelo', link: 'https://avisos.inmet.gov.br/56469',
};

test('detalhes exibem dois boletins distintos sem repetir o alerta principal', () => {
  const resultado = renderBoletinsInmet([secundario, principal], principal);
  assert.match(resultado, /56457[^<]*>Consultar boletim principal<\/a>/);
  assert.match(resultado, /56469[^<]*>Perigo Potencial<\/a>/);
  assert.ok(resultado.indexOf('56457') < resultado.indexOf('56469'));
  assert.doesNotMatch(resultado, /Aviso de Tempestade|09:16|Há risco de granizo|Não se abrigue/);
});

test('repetições do mesmo boletim têm um só link', () => {
  const repetido = { ...principal, link: `${principal.link}/#orientacoes` };
  const resultado = renderBoletinsInmet([secundario, repetido, principal], principal);
  assert.equal((resultado.match(/56457/g) || []).length, 1);
  assert.equal((resultado.match(/56469/g) || []).length, 1);
});

test('sem link oficial específico preserva o texto sem repetir a vigência principal', () => {
  const semLink = { ...principal, link: 'https://avisos.inmet.gov.br/' };
  const resultado = renderBoletinsInmet([semLink], semLink);
  assert.match(resultado, /Há risco de granizo/);
  assert.match(resultado, /Não se abrigue debaixo de árvores/);
  assert.doesNotMatch(resultado, /href=|Aviso de Tempestade|09:16/);
});

test('avisos diferentes com o mesmo endereço genérico permanecem disponíveis', () => {
  const avisos = [principal, secundario, principal].map(aviso => ({ ...aviso, link: 'https://avisos.inmet.gov.br/' }));
  assert.equal(avisosInmetUnicos(avisos).length, 2);
});

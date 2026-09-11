# Guia de Identidade Visual — Ipiranga Monitor

Manual técnico e prático de aplicação da marca oficial do **Ipiranga Monitor** (Ipiranga/PR).

---

## 1. Conceito e Anatomia Geométrica

A marca une **localização geográfica** e **monitoramento em tempo real**:
1. **Marcador Externo (Pin)**: Geometria limpa e cantos suavizados em verde vibrante, indicando o território de Ipiranga/PR.
2. **Arcos Concêntricos**: Dois arcos superiores concêntricos simbolizando radar meteorológico, pulsos de dados e conectividade sem fio.
3. **Ponto Central (Focal)**: Círculo em amarelo vibrante, demarcando a origem do sinal e a precisão do monitoramento.
4. **Base / Horizonte**: Forma horizontal sutil em verde sob o ponto focal, representando a topografia e a fixação no território local.

---

## 2. Paleta de Cores Oficial

| Papel | Nome | HEX | RGB | Aplicação Primária |
|---|---|---|---|---|
| **Dominante** | Verde Principal | `#00C853` | `rgb(0, 200, 83)` | Símbolo oficial, palavra "Monitor", estados normais |
| **Secundária** | Verde Escuro | `#0B3D2E` | `rgb(11, 61, 46)` | Fundo do ícone de app, containers de alto contraste |
| **Apoio** | Verde Intermediário | `#087F5B` | `rgb(8, 127, 91)` | Elementos de apoio, bordas e transições |
| **Destaque** | Amarelo Alerta | `#F0D835` | `rgb(240, 216, 53)` | Ponto central do símbolo (exclusivo) |
| **Neutro Escuro** | Grafite | `#1E1E1E` | `rgb(30, 30, 30)` | Textos em fundo claro, versão monocromática grafite |
| **Neutro Claro** | Branco / Gelo | `#F5F7FA` | `rgb(245, 247, 250)` | Wordmark em fundos escuros, versão mono branca |

> **Nota técnica**: O amarelo oficial é estritamente `#F0D835`. Não utilizar variações pastéis (#FDD835).

---

## 3. Tipografia

- **Família Principal**: `Montserrat` (Sans-serif geométrica limpa).
- **Pesos Oficiais**:
  - `Bold` (700) ou `ExtraBold` (800) para o Wordmark.
  - Tracking/Letter-spacing: `-0.02em` (`-0.5px`).
- **Pilha de Fallback Web**:
  `'Montserrat', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`
- **Composição do Wordmark**:
  - "Ipiranga": Branco (`#F5F7FA`) em fundos escuros ou Grafite (`#1E1E1E`) em fundos claros.
  - "Monitor": Sempre em Verde Principal (`#00C853`).

---

## 4. Arquivos e Versões Permitidas

Todos os arquivos estão disponíveis em `src/public/brand/` em SVG vetorial puro:

| Arquivo | Descrição | Contexto de Uso |
|---|---|---|
| `logo-horizontal.svg` | Símbolo + "Ipiranga Monitor" (texto branco/verde) | Header do site, fundos escuros, navbar |
| `logo-horizontal-grafite.svg` | Símbolo + "Ipiranga Monitor" (texto grafite/verde) | Documentos, impressos e fundos claros |
| `simbolo.svg` | Somente o símbolo isolado (fundo transparente) | Avatares, badges, botões, headers compactos |
| `logo-mono-branco.svg` | Versão 100% branca | Fundos fotográficos, cores sólidas, impressão mono |
| `logo-mono-grafite.svg` | Versão 100% grafite | Fundos brancos monocromáticos, carimbos |
| `icone-app.svg` | Símbolo sobre fundo `#0B3D2E` arredondado | PWA launcher, Android/iOS icon, splash screen |
| `favicon.svg` | Símbolo ultra-simplificado para 16x16 / 32x32 | Abas de navegadores, favoritos |

---

## 5. Proporções e Área de Proteção

- **Unidade de Medida (X)**: A área de proteção mínima ao redor de qualquer versão da marca equivale ao diâmetro do ponto focal amarelo ($X$).
- **Margem Mínima**: Nenhuma imagem, texto ou borda da interface deve invadir a área de $1.5X$ ao redor do símbolo ou do logotipo.
- **Proporção do Logotipo Horizontal**:
  - Altura do símbolo = 100% da altura da caixa alta das letras.
  - Distância entre símbolo e wordmark = $1.2X$.

---

## 6. Tamanhos Mínimos Recomendados

- **Símbolo Padrão (`simbolo.svg`)**: Altura mínima de `24px`.
- **Favicon Ultra-simplificado (`favicon.svg`)**: Otimizado para `16px` e `32px`.
- **Logotipo Horizontal (`logo-horizontal.svg`)**: Altura mínima de `24px` (largura proporcional ~124px).
- **Ícone de Aplicativo (`icone-app.svg`)**: Dimensão mínima de `48x48px` (gerado para 96, 192 e 512px).

---

## 7. Regras de Uso: Certo vs. Errado

### Permitido (Certo)
- Manter as proporções originais (bloqueio de aspect ratio 1:1 no símbolo).
- Utilizar o `favicon.svg` dedicado em tamanhos inferiores a 24px.
- Utilizar a versão mono branca sobre fundos escuros que não suportem a versão colorida.
- Aplicar o ícone oficial em cards de status e notificações do sistema.

### Proibido (Errado)
- **NUNCA** adicionar efeitos 3D, chanfros, gradientes radiais pesados ou sombras falsas.
- **NUNCA** alterar as cores da paleta oficial (ex.: trocar verde por azul ou amarelo por laranja).
- **NUNCA** distorcer, comprimir horizontalmente ou esticar a marca.
- **NUNCA** substituir o símbolo por antenas Wi-Fi genéricas, globos terrestres, escudos ou radares de biblioteca.
- **NUNCA** utilizar emojis como substitutos da logomarca oficial.

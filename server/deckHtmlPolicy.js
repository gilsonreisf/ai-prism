// PURE-HTML DECK ENGINE (feat/deck-html-engine) — the model writes flowing
// HTML/CSS per slide against the design system, instead of us laying out a tree
// of absolutely-positioned boxes. This kills the "one word per line" defect at
// its root: real HTML flow (flexbox/grid, natural wrapping) never produces it.
// See project_pure_html_deck_engine.
//
// Contract shape a deck-html block:
//   ```prism-block
//   {"type":"deck-html","title":"...","audience":"...","author":"...",
//    "slides":["<section class=\"slide\">…</section>", "<section …>…</section>"]}
//   ```
// Each slide is ONE self-contained <section> that flows. The renderer injects
// the design system's tokens (colors/fonts) so the same @token vocabulary the
// example slides use resolves at paint time — nothing brand-specific is baked.

// Build the design-system STYLE CONTRACT fed to the model: the brand tokens it
// must compose against, plus a couple of the DS's own slides as worked examples
// of the house style. Everything derives from the uploaded DS — zero hardcoded
// brand values, so any company's DS drives the look (feedback_no_ds_overfitting).
export function buildDsStyleContract(template) {
  if (!template) return ''
  const t = template
  const lines = []

  // 1) raw brand tokens (colors + fonts). These are the ONLY concrete values
  // the model may reference; everything else it composes with flowing CSS.
  const tokenLines = []
  if (t.primaryColor) tokenLines.push(`  --primary: ${t.primaryColor};   /* cor primária / texto escuro */`)
  if (t.secondaryColor) tokenLines.push(`  --secondary: ${t.secondaryColor};`)
  if (t.accentColor) tokenLines.push(`  --accent: ${t.accentColor};   /* acento da marca (destaques, ênfase) */`)
  if (t.backgroundColor) tokenLines.push(`  --background: ${t.backgroundColor};   /* fundo padrão do slide */`)
  // named palette tokens carry the FULL brand vocabulary (tints, semantic
  // colors) that the DS's own charts/components use — pass them through so the
  // model can reach for e.g. a success green or a chart tint the DS defines.
  for (const p of (t.palette || []).slice(0, 40)) {
    if (p?.varName && p?.value) tokenLines.push(`  ${p.varName.startsWith('--') ? p.varName : '--' + p.varName}: ${p.value};`)
  }
  const heading = t.headingFont || ''
  const body = t.bodyFont || ''
  if (heading) tokenLines.push(`  --font-heading: ${JSON.stringify(heading)};`)
  if (body) tokenLines.push(`  --font-body: ${JSON.stringify(body)};`)

  lines.push(
    'DESIGN SYSTEM ATIVO — você vai compor os slides na LINGUAGEM VISUAL desta marca. ' +
      'Os tokens abaixo são injetados como CSS custom properties na raiz do documento; ' +
      'use-os via var(--nome). NUNCA escreva hex de cor à mão — sempre var(--accent), ' +
      'var(--primary), etc. Fontes idem: font-family: var(--font-heading)/var(--font-body).'
  )
  if (tokenLines.length) lines.push(':root {\n' + tokenLines.join('\n') + '\n}')

  // 2) brand voice/copy rules (the DS README, condensed at import).
  if (t.brandRules) {
    lines.push(
      'REGRAS DE MARCA (voz, casing, tom — siga na redação):\n---\n' + t.brandRules.slice(0, 4000) + '\n---'
    )
  }

  // 3) worked examples: a few of the DS's OWN slides, verbatim, so the model
  // learns the house component vocabulary (.card/.dv-table/.kpi/…) and the
  // flowing-layout conventions from real specimens rather than from us naming
  // classes it can't see. Pick chart/table/content specimens when present.
  const cards = (t.dsCards || []).filter((c) => c?.html)
  const picked = pickExampleCards(cards)
  if (picked.length) {
    lines.push(
      'SLIDES DE EXEMPLO deste design system (HTML real da marca) — ESTUDE a estrutura, as ' +
        'classes de componente (ex.: .slide/.eyebrow/.title/.card/.dv-table/.kpi/.bullets/.stat), ' +
        'o uso dos tokens e o layout que FLUI. Reproduza este vocabulário; não invente um layout ' +
        'genérico:\n\n' +
        picked.map((c, i) => `--- EXEMPLO ${i + 1}${c.title ? ` (${c.title})` : ''} ---\n${trimExample(c.html)}`).join('\n\n')
    )
  }
  return lines.join('\n\n')
}

// Prefer specimens that teach the most transferable vocabulary: a content
// slide, a chart slide, a table slide. Fall back to the first few cards.
function pickExampleCards(cards) {
  if (!cards.length) return []
  const want = [/content|bullet|text/i, /chart|data.?viz|graph/i, /table/i, /card|kpi|stat/i]
  const chosen = []
  const used = new Set()
  for (const re of want) {
    const hit = cards.find((c, idx) => !used.has(idx) && re.test(`${c.title || ''} ${c.group || ''}`))
    if (hit) {
      chosen.push(hit)
      used.add(cards.indexOf(hit))
    }
    if (chosen.length >= 3) break
  }
  if (!chosen.length) return cards.slice(0, 2)
  return chosen.slice(0, 3)
}

// Example cards can be large (inlined data-URI art). Strip heavy data URIs and
// cap length so the contract stays token-affordable — the model needs the
// STRUCTURE/classes, not embedded rasters.
function trimExample(html, cap = 6000) {
  let out = html
    // drop inlined raster/font data URIs — keep the tag but blank the payload
    .replace(/data:image\/[^)"']{200,}/gi, 'data:image/svg+xml,<removed>')
    .replace(/data:font\/[^)"']+/gi, '')
    // drop <script> (the ds-base runtime) — irrelevant to composition
    .replace(/<script[\s\S]*?<\/script>/gi, '')
  if (out.length > cap) out = out.slice(0, cap) + '\n<!-- …exemplo truncado… -->'
  return out
}

// The generation policy appended to the system prompt when the turn is about a
// deck AND the pure-HTML engine is active. Kept separate from the legacy
// DECK_POLICY (server/blocks.js) so we can A/B and retire the tree path cleanly.
export const DECK_HTML_POLICY =
  '\n\n=== GERAÇÃO DE DECK (motor HTML) — O FORMATO DA ETAPA 2 ===\n' +
  'A Etapa 2 acima descreveu o CONTEÚDO e a qualidade editorial do deck; esta seção descreve o ' +
  'FORMATO técnico que materializa esse conteúdo. O fluxo de perguntas (bloco "deck-questions") ' +
  'continua valendo; ao gerar o deck em si, você SEMPRE emite um bloco "deck-html" (descrito ' +
  'aqui).\n' +
  'Um deck é um bloco ```prism-block``` do tipo "deck-html". Cada slide é UMA tag ' +
  '<section class="slide">…</section> auto-contida, em HTML que FLUI (flexbox/grid, ' +
  'quebra natural de texto) — NUNCA use position:absolute nem coordenadas fixas para ' +
  'dispor conteúdo, e NUNCA force largura/altura que corte texto. O documento tem ' +
  '1280×720 por slide (16:9); componha para caber com folga, deixando o conteúdo ' +
  'respirar. Formato:\n' +
  '```prism-block\n' +
  '{"type":"deck-html","title":"...","audience":"...(opcional, rodapé)","author":"...(opcional, capa)",' +
  '"slides":["<section class=\\"slide\\">…slide 1…</section>","<section class=\\"slide cover\\">…</section>"]}\n' +
  '```\n' +
  'REGRAS:\n' +
  '- Cada string de "slides" é UM <section> completo e válido. Estilos inline ou uma tag ' +
  '<style> DENTRO do <section> são permitidos; use os tokens var(--…) do design system ' +
  '(cores/fontes), nunca hex de cor cru.\n' +
  '- PRINCÍPIO GERAL DE FIDELIDADE: para QUALQUER ativo do design system (tabela, gráfico, card, ' +
  'kpi, lista, cabeçalho, etc.), use o ativo EXATAMENTE como o design system o define nos SLIDES ' +
  'DE EXEMPLO — reproduza a estrutura, as classes e as propriedades daquele ativo. NÃO invente um ' +
  'estilo próprio, NÃO prescreva você mesmo valores de acabamento (cantos, faixas, grade, eixos, ' +
  'alinhamento, cores) e NÃO sobrescreva as propriedades do ativo: o acabamento é sempre o que o ' +
  'design system determinar. Quando não houver um exemplo daquele ativo no DS, aí sim componha com ' +
  'flexbox/grid respeitando os tokens (var(--…)).\n' +
  '- Gráficos: desenhe SVG inline (barras, linhas, área, pizza) reproduzindo a MESMA linguagem ' +
  'visual dos gráficos dos SLIDES DE EXEMPLO do design system — o acabamento (grade, eixos, ' +
  'rótulos, marcadores, cantos, preenchimentos) é o que o DS mostra nesses exemplos, não algo que ' +
  'você define. Nunca entregue um gráfico mais "cru" do que os exemplos do DS.\n' +
  '- Ativos da marca (ícones, ilustrações/motivos, logo, imagens): use SEMPRE os assets REAIS do ' +
  'design system via `<img data-ds-asset-id="ID">` (logo: `<img data-ds-logo>`), com os ids ' +
  'listados na seção de ativos do design system — o renderizador injeta a arte real. NUNCA ' +
  'desenhe seu próprio ícone/logo/motivo em SVG ou CSS como substituto de um asset da marca, e ' +
  'NUNCA escreva `src="..."` à mão. SVG inline é só para GRÁFICOS de dados (conteúdo), nunca para ' +
  'decoração de marca. Se não houver asset adequado, deixe o espaço limpo.\n' +
  '- Texto SEMPRE flui e quebra naturalmente. Se um slide tem muito conteúdo, reduza o conteúdo ' +
  'ou divida em dois — jamais espremer numa caixa estreita.\n' +
  '- Honestidade de dados: só use números presentes nesta conversa (pedido, respostas, anexos, ' +
  'resultados de tools); estimativas só com nota explícita no slide.\n'

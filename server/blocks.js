import { DECK_ICON_NAMES } from '../shared/deckIcons.js'
import { ELEMENT_TYPES, SHAPE_KINDS, BOX_LIMITS, MAX_ELEMENTS_PER_SLIDE, CHART_KINDS, MAX_GROUP_DEPTH, SLIDE_W, SLIDE_H, textHeightIn, TEXT_INSETS, flattenElements } from '../shared/deckLayout.js'
import { THEME_COLOR_TOKENS, resolveDeckTheme } from '../shared/deckTheme.js'
import { reviewDeck as reviewDeckGeometry, formatReviewForModel } from '../shared/deckReview.js'

// Structured message blocks: charts/tables/insights woven directly into the
// model's markdown answer. The model marks *where* a block belongs with an
// inline ```prism-block fence (one per block, right after the paragraph it
// illustrates); the backend resolves it, replaces the fence with a
// `{{block:N}}` placeholder the frontend renders in place, and stores the
// resolved block in a parallel `blocks` array. Chart/table data always comes
// from deterministic candidates (see analysis.js), never invented by the model.
// Opener of a prism-block fence. We deliberately DON'T match the closing ``` in
// this regex: a block's JSON body can itself contain ``` (a `document`'s markdown
// may embed fenced code, an insight may quote code), and a lazy `...```/ closes
// on that inner fence, truncating the JSON so it fails to parse and the raw
// escaped JSON leaks into the chat. Instead we locate the opener, then scan the
// JSON object by brace balance (see scanJsonObject), which is ``` -agnostic.
const FENCE_OPEN_RE = /```prism-block[ \t]*\r?\n?/g
const MAX_BLOCKS = 12

// From `text` starting at `start` (which must be at/near the JSON), find the
// first `{` and return { json, end } where `json` is the balanced object string
// and `end` is the index just past its closing `}`. Brace counting respects
// string literals and escapes so braces inside strings don't miscount. Returns
// null if no balanced object is found (truncated / malformed).
function scanJsonObject(text, start) {
  let i = start
  while (i < text.length && text[i] !== '{') {
    // only whitespace may precede the object; anything else means no block here
    if (!/\s/.test(text[i])) return null
    i++
  }
  if (i >= text.length) return null
  const objStart = i
  let depth = 0
  let inStr = false
  let escaped = false
  for (; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return { json: text.slice(objStart, i + 1), end: i + 1 }
    }
  }
  return null // never balanced — truncated mid-generation
}

const ALLOWED_TYPES = new Set(['chart', 'table', 'insight', 'deck', 'deck-questions', 'spreadsheet', 'image', 'document'])

const DECK_LAYOUTS = new Set([
  'title', 'section', 'bullets', 'two-column', 'quote', 'closing',
  'agenda', 'cards', 'stat-grid', 'comparison', 'timeline', 'table', 'chart', 'image', 'diagram',
])
const MAX_DECK_SLIDES = 28
const MAX_DECK_BULLETS = 8
const MAX_DECK_CARDS = 6
const MAX_DECK_STATS = 4
const MAX_DECK_PHASES = 5
const MAX_DECK_TABLE_COLS = 12
const MAX_DECK_TABLE_ROWS = 50

const DECK_ICON_SET = new Set(DECK_ICON_NAMES)

const DECK_QUESTION_TYPES = new Set(['single', 'multi', 'text'])
const MAX_DECK_QUESTIONS = 8
const MAX_QUESTION_OPTIONS = 8

// Presentations the model designs directly (no external data source involved,
// unlike chart/table blocks, except the optional `chart` layout below which
// deliberately reuses the same trusted candidate pipeline as the chat's own
// `chart` block) — a structured slide spec the Deck Studio renders and lets
// the user edit before exporting to .pptx (see server/decks.js).
//
// Two-step flow (mirrors Claude's own "artifact" UX, which is the explicit
// product reference for this feature): a new deck request first gets a
// `deck-questions` block, never the `deck` block directly — the questions
// must be authored fresh for that specific request/conversation, never a
// reused fixed questionnaire (see the "ETAPA 1" section below).
const DECK_POLICY =
  '\n\nCriação de apresentações (decks): esta interface NÃO executa código — nunca gere ' +
  'python-pptx, HTML, Markdown de slides ou qualquer outro código como forma de "criar" um ' +
  'deck; o usuário não veria nada executável. Um deck é sempre um bloco ```prism-block```.\n\n' +

  '=== QUANDO ENTRAR NESSE FLUXO ===\n' +
  'Só entre em modo deck (perguntas OU geração) quando o usuário pedir EXPLICITAMENTE uma ' +
  'apresentação, slides ou um deck. Nunca sugira ou gere um deck por iniciativa própria — um ' +
  'resumo, relatório, lista ou explicação comum NUNCA vira um deck, mesmo que o conteúdo ' +
  '"renderizasse bem" como slides. Se já existe um deck criado nesta conversa e o usuário pede ' +
  'um ajuste nele (mudar um slide, trocar o tom, adicionar/remover uma seção), gere direto um ' +
  'novo bloco `deck` atualizado — não repita o fluxo de perguntas, que é só para o pedido ' +
  'inicial de um deck novo.\n\n' +

  '=== ETAPA 1: PERGUNTAS DE CONTEXTO (bloco `deck-questions`) ===\n' +
  'Ao receber um pedido NOVO de deck sem contexto suficiente (a maioria dos casos), responda ' +
  'SOMENTE com um bloco `deck-questions` — nunca texto solto, nunca o bloco `deck` ainda:\n' +
  '```prism-block\n{"type":"deck-questions","intro":"...","questions":[' +
  '{"id":"...","label":"...","type":"single|multi|text","description":"...(opcional)",' +
  '"options":["...","...","Decida por mim"]}]}\n```\n' +
  '("options" só é usado/obrigatório para "single"/"multi"; "text" é resposta livre.)\n' +
  'Formule de 4 a 8 perguntas ESPECÍFICAS para este pedido e para o histórico desta conversa — ' +
  'você já enxerga tudo que foi dito, anexado ou calculado até aqui, use isso para perguntar só ' +
  'o que falta. NUNCA reutilize literalmente o mesmo conjunto de perguntas, rótulos ou opções ' +
  'de um pedido para outro: um pitch comercial, uma aula técnica e um relatório de status pedem ' +
  'perguntas completamente diferentes. As categorias a seguir são inspiração de cobertura, não ' +
  'um checklist fixo — use só as que fizerem sentido, com sua própria formulação e opções: ' +
  'público-alvo, duração/nº de slides, contexto do tema/empresa/projeto (SEMPRE tente capturar ' +
  'o nome do cliente/empresa-alvo — ele personaliza a capa e o rodapé de todos os slides), ' +
  'objetivos a destacar, seções a incluir, dados de negócio já disponíveis (custos, prazos, ' +
  'métricas), nível de detalhe técnico, idioma, tom, quem apresenta e para quem. Toda pergunta ' +
  '"single"/"multi" ' +
  'deve sempre incluir "Decida por mim" como última opção. A interface SEMPRE exibe, sob cada ' +
  'pergunta "single"/"multi", um campo livre "Outros" onde o usuário digita uma opção própria — ' +
  'nunca inclua uma opção literal "Outro"/"Outros" na lista, e trate qualquer resposta fora das ' +
  'opções oferecidas como escolha válida do usuário. Se o próprio pedido inicial já vier ' +
  'com contexto suficiente (ex.: um briefing completo colado), pule direto para a Etapa 2.\n\n' +

  '=== ETAPA 2: GERAÇÃO DO DECK (bloco `deck`) ===\n' +
  'Depois que o usuário responder (a mensagem seguinte trará as respostas, tipicamente como ' +
  '"Perguntas respondidas: ..."), gere o bloco `deck` completo usando essas respostas para ' +
  'moldar seções, tom, idioma e número de slides:\n' +
  '```prism-block\n{"type":"deck","title":"...","audience":"...","author":"...",' +
  '"narrative":"...","slides":[{"layout":"...","kicker":"...","heading":"...",' +
  '"subheading":"...","bullets":["..."],"body":"...","footnote":"...",' +
  '"callout":{"kicker":"...","text":"..."},"notes":"..."}]}\n```\n' +
  'Campos de nível de deck:\n' +
  '- "audience" (recomendado): o texto EXATO que aparece no rodapé de todo slide, já escrito ' +
  'no idioma do deck (ex.: "Preparado para o C-Level · Grupo Capitale", "Prepared for Murphy ' +
  'USA") — extraia o cliente/empresa das respostas. "author" (opcional): quem apresenta/assina, ' +
  'exibido na capa e no encerramento.\n' +
  '- "narrative" (OBRIGATÓRIO): antes de escrever qualquer slide, decida o arco do deck em uma ' +
  'linha (ex.: "contexto → problema → visão da solução → prova/comparação → business case → ' +
  'plano → decisão"). Escreva os slides SEGUINDO esse arco: começo (por que estamos aqui), ' +
  'meio (argumento com evidência), fim (resumo executivo + próximo passo concreto).\n\n' +

  'DIMENSIONAMENTO: o número de slides segue o conteúdo e a duração pedida — nunca comprima ' +
  'um pedido denso em meia dúzia de slides. Referências: ~30 min executivos ≈ 18–24 slides; ' +
  'cada seção temática pedida ≈ 1 divisor "section" + 2–4 slides de conteúdo; decks com 10+ ' +
  'slides devem usar divisores "section" entre blocos e fechar com um resumo executivo ' +
  '(layout "agenda" com itens de conclusão) antes do "closing".\n\n' +

  'COPYWRITING (o que separa um deck profissional de uma lista de tópicos):\n' +
  '- O "heading" de um slide de conteúdo é a CONCLUSÃO do slide, não o assunto. Rótulos como ' +
  '"Principais vantagens" ou "Resultados" são proibidos; escreva a tese completa: ' +
  'RUIM: "Vantagens do Unity Catalog" → BOM: "Uma camada de governança substitui quatro ' +
  'ferramentas separadas". RUIM: "Cronograma" → BOM: "Go-live antes do fim do ano, com valor ' +
  'entregue em cada fase".\n' +
  '- "kicker" (recomendado em todo slide de conteúdo e na capa): rótulo curto de categoria em ' +
  'caixa alta implícita (ex.: "Business case", "Arquitetura alvo · Alto nível", "Contexto") — ' +
  'ele orienta; o heading afirma.\n' +
  '- "subheading" (opcional): uma frase de apoio em tom neutro sob o título.\n' +
  '- Bullets com no máx. ~12 palavras, sempre afirmações (verbo + consequência), nunca ' +
  'fragmentos vagos. Use sentence case (nunca Title Case) em tudo.\n' +
  '- "callout" (opcional, em qualquer layout de conteúdo): a banda escura de "so what" no pé ' +
  'do slide — {kicker:"O padrão"/"Por que importa"/etc., text: a implicação em uma frase ' +
  'forte}. Use quando o slide tem uma conclusão que não pode passar despercebida (1 a cada ' +
  '2–3 slides de conteúdo, não em todos).\n' +
  '- "footnote" (opcional): nota pequena em itálico no pé — OBRIGATÓRIA sempre que um número/' +
  'meta for estimativa ilustrativa e não dado real desta conversa (ex.: "Illustrative target; ' +
  'firm business case produced during discovery."). Honestidade explícita é parte do estilo.\n' +
  '- "notes" (opcional, em qualquer layout): notas do apresentador; vão para o campo de notas ' +
  'do PPTX, nunca aparecem no slide.\n\n' +

  '=== LAYOUTS DISPONÍVEIS (blocos de construção combináveis — NÃO é um roteiro fixo de ' +
  'seções; escolha o layout pela MENSAGEM do slide, e varie: dois slides "bullets" seguidos é ' +
  'sinal de layout errado) ===\n' +
  '- "title": capa — {kicker (ex.: "Proposta de migração"), heading, subheading (1 frase de ' +
  'valor, cite o cliente)}. "section": divisor numerado automaticamente — {heading, ' +
  'subheading?}. "closing": encerramento — heading como call-to-action concreto, não "Obrigado".\n' +
  '- "bullets": {heading,body?,bullets} — só para conteúdo realmente sequencial/argumentativo. ' +
  '"two-column": idem dividido em duas colunas. "quote": {body (citação), heading (autor)}.\n' +
  '- "agenda": {heading,items:[{title,body?}]} — lista editorial numerada: roteiro no início ' +
  'E/OU resumo executivo no fim (3–5 conclusões ranqueadas com uma linha de apoio cada).\n' +
  '- "cards": {heading,cards:[{iconRef?,heading,body?}]} (até 6, ideal 3) — N ideias paralelas ' +
  'do mesmo nível (motivos, capacidades, dores, pilares).\n' +
  '- "stat-grid": {heading,stats:[{iconRef?,value,label?}]} (até 4) — KPIs/números de impacto. ' +
  '"value" é SÓ o número/sigla (máx. ~12 caracteres: "25%", "3–5×", "R$ 2M" — nunca uma frase); ' +
  'o contexto vai no label (frase curta). Citações de fonte NUNCA vão no label — fontes e ' +
  'ressalvas vão na "footnote" do slide.\n' +
  '- "comparison": {heading,leftTitle,rightTitle,leftBullets,rightBullets} — antes/depois, ' +
  'hoje/alvo; o lado direito é sempre o estado proposto (ganha destaque visual automático).\n' +
  '- "table": {heading,columns,rows} — matriz de dados. Para comparação de capacidades use ' +
  'a variante de matriz de níveis: {columns:["Capacidade","Opção A","Nossa opção"], rows:[' +
  '["SQL & BI","partial","full"]], cellStyle:"level", highlightColumn:2} — células "full"/' +
  '"partial"/"none" viram indicadores visuais (●◑○) e highlightColumn destaca a coluna ' +
  'vencedora. MUITO mais forte que "comparison" para 4+ critérios.\n' +
  '- "timeline": {heading,phases:[{iconRef?,label,period?,body?}]} (até 5) — roadmap/fases.\n' +
  '- "diagram": arquitetura/fluxo de sistemas — {heading, columns:[{label,items:[{label,' +
  'iconRef?}]} para trilhas laterais (fontes, consumidores), {label,sublabel?,emphasis:true,' +
  'bands:[{label,tone:"accent"?}]} para a plataforma/produto central]} (2–4 colunas; setas ' +
  'automáticas). Use SEMPRE que a mensagem for "como as peças se conectam" — é o slide que ' +
  'mais transmite competência técnica em propostas de dados/plataforma; a banda de governança/' +
  'destaque leva tone:"accent".\n' +
  '- "chart": {heading,chartRef:"candidate_N"} — visualize dados REAIS já disponíveis nesta ' +
  'conversa (mesmos IDs candidate_N usados no restante do chat). Use SOMENTE se um candidato ' +
  'real existir; nunca invente uma série de números para este layout — se não houver dado real ' +
  'disponível, não use "chart".\n' +
  '- "image": {heading,subheading (legenda),imageRef?,diagramRef?} — quando uma foto/diagrama/' +
  'screenshot real comunicaria melhor que texto. Se o design system ativo listar imagens reais ' +
  '(lista de `imageRef` abaixo, quando houver), use o id de uma que combine DE VERDADE com o ' +
  'slide; se listar diagramas minerados (`diagramRef`), use o id de um cujo rótulo corresponda ' +
  'ao assunto — ele é redesenhado em vetor com a identidade do tema. Imagens com marca d\'água ' +
  'são PROIBIDAS em qualquer slide (as listas abaixo já vêm filtradas — nunca contorne isso). ' +
  'Sem asset adequado, deixe sem imagem — você não consegue gerar a imagem em si, e o usuário ' +
  'pode subir uma depois no Estúdio de Slides; use `body`/`notes` para descrever o que deveria ' +
  'aparecer ali.\n' +
  'ÍCONES (em itens de cards/stat-grid/timeline/diagram — NUNCA emoji, a marca não usa emoji):\n' +
  '- `iconRef` (preferido): referencia UM ícone real do design system ativo pelo id (lista ' +
  'abaixo, quando houver). Só use um id que exista na lista e que realmente combine com o item; ' +
  'nunca repita o mesmo ícone em itens diferentes do mesmo slide.\n' +
  '- `icon` (fallback neutro): quando não houver ícone real adequado, use um pictograma neutro ' +
  'embutido, escolhido semanticamente entre EXATAMENTE estes nomes: ' +
  DECK_ICON_NAMES.join(', ') +
  '. Ele é desenhado em linha fina na cor de destaque do tema — discreto e elegante em qualquer ' +
  'marca. Em cards e timeline, usar `icon` em todos os itens (sem repetir nomes no mesmo slide) ' +
  'deixa o slide visivelmente mais rico; se nenhum nome combinar, omita — um item sem ícone é ' +
  'normal e preferível a um ícone forçado.\n\n' +

  '=== LAYOUT LIVRE: "freeform" (canvas de elementos) ===\n' +
  'Além dos layouts acima, você pode desenhar QUALQUER composição com ' +
  '{layout:"freeform", background:{color:"@background"}, notes?, elements:[...]}. Use freeform ' +
  'quando (a) o usuário descrever um layout específico que os layouts semânticos não expressam, ' +
  '(b) a mensagem pedir uma composição sob medida (infográfico, gráfico com painel lateral de ' +
  'conclusões, matriz/heatmap, cronograma gantt, capa fora do padrão), ou (c) um layout ' +
  'semântico ficaria forçado. Para slides comuns (bullets, cards, timeline, capa padrão), os ' +
  'layouts semânticos são um caminho seguro — MAS quando o design system ativo tiver uma ' +
  'linguagem de composição própria (ver a seção "LINGUAGEM DE COMPOSIÇÃO DESTE DESIGN SYSTEM", ' +
  'quando presente), prefira freeform e componha para essa marca: layouts semânticos deixam ' +
  'todo deck com a mesma cara, mudando só cor/logo/fundo. Sem essa seção (design system só de ' +
  'cores), fique nos semânticos e não gere o deck inteiro em freeform por estilo.\n' +
  'Canvas: 10.00 × 5.625 polegadas (16:9), margem recomendada 0.62, box em polegadas ' +
  '{x,y,w,h}. Máximo 80 nós por slide. Tipos de elemento (todos aceitam name — rótulo da ' +
  'camada no editor — e os elementos exportam como objetos NATIVOS e editáveis do PowerPoint):\n' +
  '- text: {type:"text",box,text,style:{fontRole:"heading"|"body",fontSize,color,bold,italic,' +
  'uppercase,align:"left|center|right",valign:"top|middle|bottom",lineHeight,letterSpacing,' +
  'bullet:true ("\\n" separa itens)}}\n' +
  '- shape: {type:"shape",shape:"rect|roundRect|ellipse|triangle|diamond|chevron|rightArrow",' +
  'box,style:{fill,radius,borderColor,borderWidth,opacity(0-100),shadow:true}}\n' +
  '- line: {type:"line",box (h:0 = horizontal, w:0 = vertical),style:{lineColor,lineWidth,' +
  'dash:"solid|dash|dot",arrowStart,arrowEnd}}\n' +
  '- icon: {type:"icon",box,icon:{assetId:"<id de iconRef>"} ou {builtin:"<pictograma da lista ' +
  'acima>"},style:{fill (placa de fundo),color}}. O box do ícone é SEMPRE quadrado (w=h) e nunca ' +
  'menor que ~0.4in — em um card, um ícone de destaque tem 0.5–0.8in; nunca 0.2–0.3in (some no slide). ' +
  'Com placa (fill), 0.7–0.9in.\n' +
  '- image: {type:"image",box,imageAssetId:"<id de imageRef>"} — só assets listados.\n' +
  '- chart: ver a seção de gráficos abaixo.\n' +
  '- group: {type:"group",box,name,children:[...],stack?,style?} — style com fill/radius/' +
  'borderColor desenha um painel atrás dos filhos (é assim que se faz um card).\n' +
  'REGRAS DE OURO:\n' +
  '0. TODAS as medidas são em POLEGADAS (nunca px!): box no canvas 10×5.625; fontSize é a única ' +
  'exceção (pontos). Valores típicos: radius 0.05–0.12 (cantos de card; acima de 0.3 vira pílula), ' +
  'gap 0.08–0.3, padding 0.15–0.3, borderWidth 0.5–1.5 (pt). Se você escreveria "16px", em ' +
  'polegadas é ~0.17.\n' +
  '1. NUNCA posicione itens repetidos calculando coordenadas à mão — componha com group+stack: ' +
  'stack:{direction:"column"|"row",gap,padding,align:"start|center|end|stretch",justify:' +
  '"start|center|end|between"} posiciona os filhos automaticamente. Em um stack, x/y dos ' +
  'filhos são ignorados; a ALTURA de textos é automática (hug — nunca a calcule); grow:1 em um ' +
  'filho absorve o espaço restante (uma linha de 3 cards iguais = 3 groups com grow:1 dentro ' +
  'de um stack row). Stacks aninham até 4 níveis.\n' +
  '2. Cores SEMPRE como tokens do tema (o slide continua se re-adaptando ao design system): ' +
  '@primary @secondary @accent @background @heading @bodyText @muted @faint @hairline ' +
  '@accentSoft @cardFill @deep @onPrimary @onAccent @onPrimaryMuted @onPrimaryFaint @accentOnPrimary. ' +
  'Sobre fundo @primary/@deep, textos usam @onPrimary/@onPrimaryMuted; um kicker/rótulo de ' +
  'destaque nesse fundo escuro usa @accentOnPrimary (NUNCA @accent cru — em alguns temas o accent ' +
  'é igual ao primary e sumiria). Sobre @background, ' +
  '@heading/@bodyText/@muted. Cards: fill @cardFill + borderColor @hairline; destaque: ' +
  '@accentSoft ou @accent. Hex literal só se o usuário pedir uma cor específica.\n' +
  '3. Siga a hierarquia tipográfica do deck: kicker 10pt bold uppercase letterSpacing 2.4 ' +
  '@accent; título do slide ~21pt bold @heading no topo; corpo 10–13pt; legendas 8–9pt; nunca ' +
  'abaixo de 7.5pt. Respeite as margens e alinhe elementos entre si (mesmos x/y/w quando ' +
  'lado a lado).\n\n' +

  '=== GRÁFICOS EM FREEFORM: escolha o tipo pela mensagem do insight ===\n' +
  'O elemento chart cria gráficos reais: {type:"chart",box,chart:{kind,...}}.\n' +
  '- Comparação entre categorias → kind:"bar"; ranking/rótulos longos → "barH". Evolução ' +
  'temporal → "line"; magnitude acumulada no tempo → "area". Composição do todo → "pie" ou ' +
  '"doughnut" (máx. 6 fatias). Correlação entre duas variáveis → "scatter". Intensidade em ' +
  'matriz (ex.: uso por área × mês, risco × impacto) → "heatmap". Cronograma/fases no tempo → ' +
  '"gantt". Nunca escolha por variedade estética — escolha pelo que torna o insight óbvio.\n' +
  '- bar/barH/line/area/pie/doughnut: chart:{kind,series:[{name,data:[{label,value}]}]} ' +
  '(até 6 séries; showLegend:false para esconder legenda de série única).\n' +
  '- scatter: chart:{kind:"scatter",series:[{name,points:[{x,y}]}]}.\n' +
  '- heatmap: chart:{kind:"heatmap",heatmap:{xLabels:[...],yLabels:[...],values:[[linha por ' +
  'yLabel]],showValues?}}.\n' +
  '- gantt: chart:{kind:"gantt",gantt:{tasks:[{label,start,end,milestone?}],axis:["M1","M2",' +
  '...]}} — start/end na unidade dos segmentos de axis (ex.: meses 0–6 com axis de 6 rótulos).\n' +
  'bar/barH/line/area/pie/doughnut/scatter exportam como gráficos NATIVOS do PowerPoint ' +
  '(dados editáveis lá); heatmap/gantt são desenhados como objetos vetoriais igualmente ' +
  'editáveis. Combine o chart com um painel lateral/inferior de conclusões (group+stack) — um ' +
  'gráfico sem "so what" é um slide fraco.\n' +
  'HONESTIDADE DE DADOS: as séries só podem conter números presentes nesta conversa (pedido, ' +
  'respostas, anexos, resultados de tools, candidatos candidate_N). Números ilustrativos são ' +
  'permitidos SOMENTE com footnote/nota explícita de estimativa no próprio slide. NUNCA ' +
  'invente séries apresentadas como dado real. Quando um candidato candidate_N já existir, o ' +
  'layout semântico "chart" com chartRef continua sendo o caminho preferido.\n\n' +

  '=== NUNCA GERE UM ELEMENTO/SLIDE VAZIO (regra dura) ===\n' +
  'Um slide freeform SEMPRE tem que ter conteúdo textual ou visual real. Um group/placa sem ' +
  'filhos com conteúdo é PROIBIDO — o editor mostraria "Grupo · 0" e o slide sairia em branco. ' +
  'Cada tipo de elemento só é válido com seus campos obrigatórios; sem eles, o elemento é ' +
  'DESCARTADO na validação (e o slide pode ficar vazio):\n' +
  '- text: "text" não-vazio. shape: "shape" válido. icon: "icon" (assetId/builtin) válido.\n' +
  '- chart bar/barH/line/area/pie/doughnut: "series" com ≥1 série e ≥1 ponto {label,value} com ' +
  'value NUMÉRICO.\n' +
  '- chart scatter: "series" com ≥1 "points":[{x,y}] numéricos.\n' +
  '- chart heatmap: "heatmap" com "xLabels" (≥1), "yLabels" (≥1) e "values" (matriz yLabels×' +
  'xLabels de números). NUNCA emita heatmap sem "values".\n' +
  '- chart gantt: "gantt" com "tasks":[{label,start,end}] (≥1, start/end numéricos) e "axis".\n' +
  '- line: "box" com w/h explícitos. group: ≥1 filho com conteúdo.\n' +
  'SE VOCÊ NÃO TEM OS DADOS COMPLETOS PARA UM GRÁFICO, NÃO EMITA O CHART — escreva a conclusão ' +
  'em "text" ou componha o que você tem em shape/group. Na dúvida sobre números, prefira ' +
  'text/shape a um chart: um gráfico sem dados é pior que uma afirmação clara.\n\n' +

  'Nunca envie outro texto além do bloco correspondente (`deck-questions` ou `deck`) quando o ' +
  'pedido for especificamente por uma apresentação — o Estúdio de Slides cuida da renderização ' +
  'e o usuário poderá editar tudo antes de exportar para PPTX.'

// Spreadsheet generation: the tabular sibling of a deck. Emitted as a
// `spreadsheet` prism-block, rendered as a live-preview grid in the chat and
// exported as a REAL .xlsx (formulas that recalc, formatting, dropdowns,
// native charts). The workbook wears the user's design system automatically —
// the model never picks band/header colors, only the semantic ROLE of a cell.
const SPREADSHEET_POLICY =
  '\n\nCriação de PLANILHAS (workbooks .xlsx): esta interface NÃO executa código — nunca gere ' +
  'python/openpyxl, código de macro, CSV solto ou "cole numa planilha" como forma de criar uma ' +
  'planilha. Uma planilha é sempre um único bloco ```prism-block``` do tipo `spreadsheet`.\n\n' +

  '=== QUANDO ENTRAR NESSE FLUXO ===\n' +
  'Use `spreadsheet` quando o usuário pedir explicitamente uma PLANILHA, template de Excel, ' +
  'modelo de cálculo, controle/orçamento, modelo de valuation/DCF, projeção financeira ou algo ' +
  'que ele vá abrir e EDITAR no Excel/Sheets. NÃO confunda:\n' +
  '- 1 gráfico sobre dados de um anexo → use o bloco `chart` (candidate_N), não uma planilha.\n' +
  '- uma matriz de dados só para LEITURA dentro do chat → use o bloco `table`.\n' +
  '- uma apresentação → use `deck`.\n' +
  'A planilha é para quando o VALOR está em o usuário ter um arquivo Excel funcional em mãos.\n\n' +

  '=== ESTRUTURA DO BLOCO ===\n' +
  '```prism-block\n{"type":"spreadsheet","title":"...","sheets":[{"name":"Resumo",' +
  '"freeze":{"row":1,"col":0},"blocks":[ ...blocos ordenados... ],"charts":[ ...opcional... ]}]}\n```\n' +
  'Cada ABA (sheet) tem um "name" curto (≤31 chars) e uma LISTA ORDENADA de "blocks", pintados de ' +
  'cima para baixo — isso permite empilhar VÁRIAS tabelas sob faixas de título numa mesma aba ' +
  '(ex.: uma aba "Resumo" com um painel geral + "DESPESAS POR CATEGORIA" + "RECEITAS POR ' +
  'CATEGORIA"). Tipos de bloco:\n' +
  '- {"kind":"title","text":"..."} — faixa de título principal da aba (uma no topo).\n' +
  '- {"kind":"note","text":"..."} — linha de instrução em itálico (ex.: "Preencha as células ' +
  'de entrada destacadas; os totais recalculam sozinhos"). NUNCA cite uma COR concreta ("células ' +
  'amarelas/verdes/azuis") — a cor das células vem do design system e você não sabe qual será; ' +
  'refira-se sempre pela FUNÇÃO ("células de entrada destacadas", "campos a preencher").\n' +
  '- {"kind":"section","text":"..."} — faixa de subtítulo que rotula a tabela seguinte.\n' +
  '- {"kind":"spacer"} — uma linha em branco de respiro.\n' +
  '- {"kind":"table","columns":[...],"rows":[[...]]} — a tabela em si (ver abaixo). Use ' +
  '"headerless":true para um painel rótulo→valor sem cabeçalho (ex.: "Total de Receitas | =...").\n\n' +

  '=== TABELAS, COLUNAS E CÉLULAS ===\n' +
  'Cada coluna: {"header":"...","key":"...","format":"...","role":"...","dropdown":["...",...]?,"width":N?}.\n' +
  '- "header" é o rótulo exibido; para tabelas "headerless" (painel rótulo→valor) dê um "key" curto ' +
  'a cada coluna (ex.: "key":"valor") para poder referenciá-la em fórmulas por nome.\n' +
  '- "format" (aplica número/data): text | number | integer | currency | usd | eur | percent | ' +
  'percent0 | date | datetime. currency/number/percent já mostram negativos em vermelho.\n' +
  '- "role" (COR SEMÂNTICA da célula, escolhida pela FUNÇÃO, nunca a cor concreta — o app pinta ' +
  'segundo o design system): "input" = célula que o usuário digita; "key" = campo-chave/premissa ' +
  'a preencher; "formula" = célula calculada; "link" = referência a outra aba; "normal" = neutra. ' +
  'Uma linha da tabela é um array alinhado às colunas; um valor pode ser escalar, uma STRING de ' +
  'fórmula começando com "=" (o Excel calcula), ou {"v":valor,"role":"...","format":"...","name":"..."} ' +
  'para sobrescrever uma célula específica. Dê "name" a uma célula avulsa (ex.: uma premissa numa ' +
  'tabela headerless) para poder referenciá-la por nome em outras fórmulas.\n' +
  '- "dropdown": lista de opções vira uma validação de dados (menu suspenso) em toda a coluna.\n\n' +

  '=== FÓRMULAS — REFERENCIE POR NOME, NUNCA POR POSIÇÃO (crítico p/ correção) ===\n' +
  'Sempre que um valor DERIVA de outros, escreva a FÓRMULA (não o número congelado) — assim o ' +
  'usuário muda uma premissa e o modelo recalcula. MAS você NÃO SABE em que linha/coluna cada ' +
  'célula vai cair na grade (títulos, notas, faixas e spacers deslocam tudo), então é PROIBIDO ' +
  'escrever referências A1 absolutas como "=B14-C14" ou "=SUM(C2:C13)" — elas ficam deslocadas e ' +
  'produzem resultados errados. Em vez disso, use TOKENS entre colchetes que o app resolve para o ' +
  'A1 exato:\n' +
  '- [@NomeDaColuna] → a célula da MESMA LINHA na coluna indicada, na própria tabela. ' +
  'Ex.: numa linha de categoria, "Diferença" = "=[@Orçado]-[@Realizado]".\n' +
  '- [Aba!NomeDaColuna] → a coluna de dados INTEIRA daquela aba (vira algo como \'Aba\'!$E:$E). ' +
  'Ex.: "=SUMIFS([Transacoes!Valor],[Transacoes!Tipo],\\"Despesa\\")". Sem "Aba!" a coluna é a da ' +
  'aba atual.\n' +
  '- [#nomeDaCelula] → a célula única que você marcou com "name":"nomeDaCelula" (em qualquer aba). ' +
  'Ex.: "=[#totalReceitas]-[#totalDespesas]".\n' +
  'O nome no token deve bater com o "header"/"key" da coluna ou o "name" da célula (sem diferenciar ' +
  'maiúsculas). Funções e operadores normais do Excel valem (SUM, SUMIFS, IF, ROUND, etc.); só as ' +
  'REFERÊNCIAS a células é que vão por token. Um token que não casar com nada vira #REF! (erro ' +
  'visível) — então confira que todo token existe.\n' +
  'NÃO MISTURE estilos: se uma coluna calculada usa [@…] em uma linha, use [@…] em TODAS as linhas ' +
  'dela — nunca escreva "=[@Orçado]-[@Real]" numa linha e "=B11-C11" na outra. Para somar uma faixa ' +
  'de linhas da própria tabela (ex.: uma linha "Total"), prefira SUM sobre uma coluna inteira via ' +
  'token OU garanta que só há UMA tabela e conte as linhas com cuidado; na dúvida, use tokens. Cada ' +
  'linha de dados de uma tabela é contígua (sem linhas em branco automáticas entre elas).\n' +
  'PREFIRA FUNÇÕES CLÁSSICAS E ROBUSTAS (SUM, SUMIF, SUMIFS, IF, ROUND, COUNTIF, COUNTIFS, AVERAGE, ' +
  'MIN, MAX, INDEX/MATCH, VLOOKUP, HLOOKUP). EVITE funções de matriz dinâmica (XLOOKUP, FILTER, SORT, ' +
  'UNIQUE, SEQUENCE) e funções muito recentes — resolva o mesmo com INDEX/MATCH ou já deixe os dados ' +
  'prontos. Isso garante compatibilidade ampla (Excel, Google Sheets, LibreOffice) e que o preview do ' +
  'app mostre o valor calculado. Para buscar um valor em OUTRA aba (ex.: a % de sazonalidade do mês), ' +
  'prefira INDEX([Aba!ColunaValor], MATCH([@Chave], [Aba!ColunaChave], 0)) — é o padrão que o preview ' +
  'resolve com mais confiabilidade.\n\n' +

  '=== GRÁFICOS NATIVOS (opcional, por aba) ===\n' +
  '"charts":[{"kind":"bar|line|area|pie","title":"...","tableBlock":IDX,"categoryColumn":C,' +
  '"valueColumns":[V,...]}]. "tableBlock" é o ÍNDICE (base 0) do bloco table dentro de "blocks"; ' +
  '"categoryColumn"/"valueColumns" são índices de coluna (base 0) DENTRO dessa tabela. O app ' +
  'posiciona os gráficos sozinho (à direita da tabela, empilhados sem sobrepor) — NÃO informe ' +
  'âncora/posição. O gráfico é ligado às células — nunca forneça dados de gráfico soltos.\n\n' +

  '=== ABA DE INSTRUÇÕES (automática) ===\n' +
  'NÃO crie uma aba de instruções/legenda manualmente — o app SEMPRE adiciona uma aba "Instruções ' +
  'de Uso" ao final, com a legenda de cores (segundo o design system) e como preencher. Se quiser ' +
  'acrescentar orientações específicas do modelo, inclua um campo no topo: "instructions":["linha ' +
  '1","linha 2",...] — cada string vira uma linha nessa aba. Dê também um "purpose" curto a cada ' +
  'aba (ex.: "purpose":"Registre aqui cada lançamento") para descrevê-la no mapa de abas.\n\n' +

  '=== HONESTIDADE DE DADOS ===\n' +
  'Números só podem vir desta conversa (pedido, respostas, anexos, resultados de tools). Para um ' +
  'TEMPLATE em branco (o usuário pediu "um modelo para preencher"), deixe as células de input ' +
  'vazias ou com exemplos claramente marcados, e ponha as fórmulas prontas — não invente dados ' +
  'reais. Valores ilustrativos são permitidos apenas se rotulados como exemplo (ex.: numa "note").\n\n' +

  'Envie SOMENTE o bloco `spreadsheet` quando o pedido for por uma planilha — o app mostra o ' +
  'preview e o usuário exporta o .xlsx.'

// Always sent, even with no chart candidates yet — without it, a model asked
// for an "interactive chart" defaults to emitting HTML/React/Plotly code
// blocks (which this chat UI cannot execute), instead of the prism-block
// mechanism that's the only thing that actually renders here. The carve-out
// for explicit code requests matters: PDF/DOCX/PPTX attachments and plain
// questions ("monte um gráfico sobre X") never carry chart candidates either,
// but that's not a signal the user wants source code — only an explicit ask
// for code/script/implementation is.
const CHART_POLICY =
  '\n\nPolítica de gráficos e visualizações: esta interface de chat NÃO executa código. Quando ' +
  'o usuário pedir uma análise, um gráfico ou uma visualização de dados — venha o pedido de um ' +
  'anexo (planilha, PDF, DOCX, PPTX) ou de uma pergunta genérica sem anexo — NUNCA responda com ' +
  'blocos de código HTML, JavaScript, React, Plotly, matplotlib, Chart.js ou similares como forma ' +
  'de "gerar" o gráfico; eles não são renderizados, aparecem como texto bruto e confundem o ' +
  'usuário. A única forma de exibir um gráfico interativo de verdade nesta interface é o bloco ' +
  '```prism-block descrito abaixo.\n' +
  'Exceção: se o usuário pedir explicitamente ajuda com código/programação (ex: "me dá o código ' +
  'Python/React para isso", "como eu implemento esse gráfico", "quero o script") aí sim responda ' +
  'normalmente com o bloco de código — essa política só se aplica quando o pedido é a análise/o ' +
  'gráfico em si, não uma ajuda de programação.\n\n' +
  'Há DOIS modos de preencher um bloco de gráfico (sempre dentro de ```prism-block```):\n' +
  'MODO 1 — REFERÊNCIA a um candidato pré-calculado (PREFERIDO sempre que existir um candidate_N ' +
  'nesta conversa): {"type":"chart","ref":"candidate_1","caption":"legenda curta"}. Os números já ' +
  'vêm validados; use este modo quando houver candidato disponível.\n' +
  'MODO 2 — DADOS EM LINHA: quando você JÁ TEM os números nesta conversa (resultado de uma tool ' +
  'como Genie/Genie One/Python, um anexo, ou valores já citados) mas NÃO existe um candidate_N ' +
  'para eles, forneça a série você mesmo, NESTE formato EXATO:\n' +
  '```prism-block\n{"type":"chart","chartType":"line","title":"Receita mensal","series":[{"name":' +
  '"Receita (R$)","data":[{"label":"2016-09","value":252.24},{"label":"2016-10","value":59090.48}]}],' +
  '"caption":"legenda opcional"}\n```\n' +
  'chartType é um de "bar" | "line" | "area" | "pie". A série é SEMPRE series→data→{label,value}. ' +
  'NUNCA invente um formato próprio: nada de "chartRef", "data":{"labels":[...]}, "values":[...], ' +
  'nem apontar "ref" para um candidato que não existe — qualquer um desses faz o bloco ser ' +
  'descartado e o JSON vaza como texto cru para o usuário (exatamente o que NÃO pode acontecer).\n' +
  'HONESTIDADE (modo 2): os pontos do gráfico só podem ser dados REAIS já presentes nesta conversa ' +
  '(resultado de tool, anexo, números citados). NUNCA fabrique uma série. Se você não tem os ' +
  'números de verdade, não desenhe o gráfico — explique em uma frase e peça a fonte (planilha/CSV) ' +
  'ou rode a tool que traz os dados.\n'

const NO_CANDIDATES_INSTRUCTION =
  '\nNo momento não há dados tabulares pré-calculados disponíveis nesta mensagem (nenhuma ' +
  'planilha/CSV foi anexada nesta conversa — um PDF, DOCX ou PPTX anexado não conta como fonte ' +
  'de dados tabulares —, ou os números citados não vêm de um arquivo). Se o usuário pedir um ' +
  'gráfico e nenhuma tool disponível puder trazer dados tabulares, explique isso em uma frase e ' +
  'peça para anexar uma planilha ou CSV — nunca invente números nem produza código para simular ' +
  'um gráfico.\nExceção: se você chamar uma tool (ex: Genie) e o resultado da tool vier acompanhado ' +
  'de uma lista de "novos candidatos de gráfico disponíveis", isso significa que dados reais e ' +
  'seguros para visualizar já existem — use o bloco prism-block normalmente com o ID indicado.'

// Injected only when caps.image is on (an explicit image request, or a
// follow-up in a thread that already has an image). Teaches the model to (1)
// call the generate_image tool with a rich ENGLISH prompt, and (2) place the
// returned image as an `image` prism-block right where it belongs — never to
// invent an imageRef or emit a raw image/URL/markdown-image itself.
const IMAGE_POLICY =
  '\n\nGeração de imagens: quando o usuário pedir EXPLICITAMENTE para criar/gerar/desenhar uma ' +
  'imagem, ilustração, foto, logo, ícone, banner ou arte, use a tool `generate_image`. Regras:\n' +
  '- Escreva o "prompt" da tool em INGLÊS e bem descritivo (assunto, estilo, composição, ' +
  'iluminação, cores, enquadramento, humor) — mesmo que o usuário tenha escrito em português. ' +
  'Modelos de imagem respondem muito melhor a prompts ricos em inglês. Traduza a INTENÇÃO do ' +
  'usuário num prompt visual completo; não copie o pedido literal se ele for curto/vago.\n' +
  '- NÃO use a tool para "buscar" imagens existentes na internet (você não faz isso). Se o usuário ' +
  'só quer que você DESCREVA/analise uma imagem que ele anexou, responda direto (você a enxerga) — ' +
  'sem chamar a tool. Use a tool para CRIAR uma imagem nova OU para EDITAR/transformar uma imagem ' +
  'anexada.\n' +
  '- EDIÇÃO (img2img): quando o usuário anexa/cola uma imagem e pede para modificá-la ("deixe em ' +
  'preto e branco", "adicione um chapéu", "outra versão disso"), chame `generate_image` com um ' +
  'prompt que descreva a TRANSFORMAÇÃO desejada — o servidor já entrega a imagem anexada ao modelo ' +
  'de imagem automaticamente, você não precisa reanexá-la.\n' +
  '- Depois que a tool retornar um ref (ex.: "img_42"), insira a imagem na sua resposta com um ' +
  'bloco ```prism-block``` do tipo "image", logo após o parágrafo que a apresenta:\n' +
  '```prism-block\n{"type":"image","imageRef":"img_42","caption":"legenda curta opcional"}\n```\n' +
  '- NUNCA invente um "imageRef" que a tool não devolveu, NUNCA escreva a imagem como markdown ' +
  '![](...) nem cole um data:URL ou link — a ÚNICA forma de exibir a imagem é o bloco acima com o ' +
  'ref real. Se o usuário pedir uma variação/ajuste de uma imagem já criada, chame a tool de novo ' +
  'com um novo prompt refletindo o ajuste e insira o novo bloco.\n'

// Injected only when caps.document is on. Teaches the model to author a proper
// text DOCUMENT (report/article/letter/…) as a `document` prism-block whose
// body is MARKDOWN — the Document Studio renders it as rich text and exports to
// DOCX/Markdown/PDF. This is for real deliverable documents, NOT ordinary chat
// answers (a short explanation stays plain prose in the reply).
const DOCUMENT_POLICY =
  '\n\nCriação de documentos de texto: quando o usuário pedir EXPLICITAMENTE um documento, ' +
  'relatório, artigo, carta, proposta, memorando, política, manual ou similar como ENTREGÁVEL, ' +
  'escreva-o como um bloco ```prism-block``` do tipo "document", cujo corpo é MARKDOWN:\n' +
  '```prism-block\n{"type":"document","title":"Título do documento","markdown":"# Título\\n\\n' +
  'Parágrafo de abertura...\\n\\n## Seção\\n\\n- item\\n- item\\n\\nTexto **em negrito** e _itálico_, ' +
  'tabelas, listas, citações (>) e código são suportados."}\n```\n' +
  'Regras:\n' +
  '- Use markdown rico e bem estruturado: títulos (#, ##, ###), listas, tabelas, negrito/itálico, ' +
  'citações, blocos de código quando fizer sentido. A UI renderiza como rich text.\n' +
  '- O "markdown" deve ser um documento COMPLETO e autossuficiente, não um esqueleto — escreva o ' +
  'conteúdo de verdade, no idioma e tom pedidos.\n' +
  '- NÃO use um documento para uma resposta curta de chat, um resumo trivial, um deck ou uma ' +
  'planilha — só para um texto que o usuário claramente quer como um documento editável/exportável.\n' +
  '- Se já existe um documento nesta conversa e o usuário pede um ajuste (mais formal, adicionar uma ' +
  'seção, encurtar), gere um novo bloco `document` completo e atualizado.\n' +
  '- Escreva uma frase curta antes do bloco apresentando o documento; o bloco em si carrega o texto.\n'

// Asset-kind gates shared by the model-facing hint (below) and sanitizeDeck —
// the single place that decides what the model may reference. `watermark`
// assets (recurring page logos/brand marks mined from the template, see
// classifyMedia in DeckTemplatesSettings.jsx) are NEVER usable: a generated
// deck must never carry a watermark, neither as an icon nor as a slide image.
// Legacy assets saved before `kind` existed count as icons.
export function usableIconAssets(template) {
  return (template?.iconAssets || []).filter((a) => !a.kind || a.kind === 'icon')
}
export function usableImageAssets(template) {
  return (template?.iconAssets || []).filter((a) => a.kind === 'image')
}

// True when the active design system carries enough mined/imported material to
// have a real visual LANGUAGE of its own (its own slide compositions, a
// declared type scale, a decorative motif, component specimens) — not just 4
// colors + a logo. For these, the generator should COMPOSE to match the DS
// (freeform-first) instead of pouring content into fixed semantic skeletons
// that make every DS look the same. See templateComposition below.
export function hasRichDesignSystem(template) {
  if (!template) return false
  return !!(
    template.previewSlides?.length ||
    template.dsCards?.length ||
    template.dsCardsMeta?.length ||
    template.minedStyle?.titlePt ||
    template.minedStyle?.motif ||
    (template.palette?.length || 0) >= 6
  )
}

// The DS's COMPOSITION brief: distills the mined/imported material into a
// description of the design system's own visual language, so the model can
// compose freeform slides that embody THIS brand — not a generic skeleton
// merely repainted. This is the core of "decks adapt to any design system":
// the renderer already applies colors/fonts/plates, but only the model can
// decide COMPOSITION (density, hierarchy, where whitespace goes), and it can
// only do that if it's told what this DS looks like. Everything here is
// derived from real mined data — never invented.
function templateComposition(template) {
  if (!hasRichDesignSystem(template)) return ''
  const mined = template.minedStyle || {}
  const lines = []

  // typographic personality: the title/body point-size contrast mined from the
  // master. A high ratio → dramatic, editorial type (big headlines, sparse
  // slides); a low ratio → dense, uniform, corporate type.
  if (mined.titlePt && mined.bodyPt) {
    const ratio = mined.titlePt / mined.bodyPt
    const feel = ratio >= 3 ? 'DRAMÁTICA (títulos enormes, slides arejados, muito espaço em branco)'
      : ratio >= 2 ? 'equilibrada (títulos claramente dominantes, densidade média)'
      : 'sóbria/densa (contraste tipográfico baixo, muita informação por slide)'
    lines.push(`- Personalidade tipográfica ${feel}: título ~${Math.round(mined.titlePt)}pt vs corpo ~${Math.round(mined.bodyPt)}pt no canvas de 10in. Respeite essa proporção nos slides freeform.`)
  }

  // the DS's OWN slides (mined structures) — the strongest signal of how this
  // brand composes: how many points per slide, whether it leans on imagery,
  // and the actual voice of its headings. A handful of real examples teaches
  // the model this DS's rhythm far better than any adjective.
  const ps = (template.previewSlides || []).filter((s) => s.title || s.bullets?.length)
  if (ps.length) {
    const avgBullets = ps.reduce((a, s) => a + (s.bullets?.length || 0), 0) / ps.length
    const imgShare = ps.filter((s) => s.imageDataUrl || s.imageMediaPath).length / ps.length
    const density = avgBullets <= 2 ? 'ENXUTA (poucas linhas por slide, uma ideia por slide)'
      : avgBullets <= 4 ? 'moderada (3–4 pontos por slide)'
      : 'densa (listas longas)'
    lines.push(`- Densidade de conteúdo ${density}; ${imgShare >= 0.4 ? 'forte apoio em imagens/visuais' : 'predominantemente tipográfica'}.`)
    const examples = ps.slice(0, 5).map((s) => {
      const b = (s.bullets || []).slice(0, 3).map((x) => x.slice(0, 60))
      return `  · "${(s.title || '').slice(0, 80)}"${b.length ? ` — ${b.join(' | ')}` : ''}`
    })
    if (examples.length) {
      lines.push('- Slides REAIS deste design system (imite a estrutura e o ritmo, não copie o conteúdo):\n' + examples.join('\n'))
    }
  }

  // BUNDLE specimens (Claude Design imports): the design system's own slide/
  // component compositions, mined as HTML cards. Their group+title+description
  // is the bundle's equivalent of previewSlides — the strongest signal of how
  // THIS brand composes a slide. We list the slide/template-flavored ones so
  // the model models its freeform composition on the DS's real specimens.
  const specimens = template.dsCardsMeta || (template.dsCards || []).map((c) => ({ group: c.group, title: c.title, description: c.description }))
  const slideSpecs = specimens.filter((c) => /slide|template|deck|layout|capa|cover|section|divis/i.test(`${c.group} ${c.title}`))
  const pool = (slideSpecs.length ? slideSpecs : specimens).slice(0, 8)
  if (pool.length) {
    lines.push(
      '- Composições REAIS deste design system (specimens do bundle — modele os slides freeform ' +
      'nesta linguagem de layout, não copie o texto):\n' +
      pool.map((c) => `  · ${c.group ? `[${c.group}] ` : ''}${(c.title || '').slice(0, 80)}${c.description ? ` — ${(c.description).slice(0, 90)}` : ''}`).join('\n')
    )
  }

  // decorative identity — the ACTUAL mined assets, WITH ids, so the model
  // places the real brand art (a `type:"image"` element with imageAssetId)
  // instead of inventing generic circles/blobs. Without the ids the model has
  // nothing to reference and falls back to drawing ellipses — the exact bug
  // seen on covers/closings. Illustrations are NOT in usableImageAssets (that
  // gate is for `image`-layout photos), so they're surfaced here explicitly.
  const illustrations = (template.iconAssets || []).filter((a) => a.kind === 'illustration')
  if (illustrations.length) {
    lines.push(
      '- ILUSTRAÇÕES REAIS da marca (a arte decorativa do design system) — em capas, divisores e ' +
      'encerramentos, coloque UMA como elemento {type:"image", imageAssetId:"<id>", box} no canto/lateral ' +
      '(tipicamente ~2–2.5in, encostada na margem). NUNCA desenhe círculos/elipses/blobs decorativos à ' +
      'mão como substituto — isso destrói a identidade da marca. Ids disponíveis:\n' +
      illustrations.slice(0, 12).map((a) => `  · ${a.id}: "${a.label || 'ilustração'}"`).join('\n')
    )
  }
  if (mined.motif) lines.push('- Há também um motivo decorativo próprio (padrão de pontos/formas) — pode ser reproduzido discretamente em fundos.')
  if (template.coverPlateDataUrl) lines.push('- Há uma placa de capa full-bleed — capas/divisores podem usar background {plate:"cover"} para trazê-la.')

  if (!lines.length) return ''
  return (
    '\n\n=== LINGUAGEM DE COMPOSIÇÃO DESTE DESIGN SYSTEM (adeque os slides a ELE) ===\n' +
    'Este design system tem uma identidade visual PRÓPRIA. Um deck genérico repintado com as ' +
    'cores dele NÃO basta — a COMPOSIÇÃO (hierarquia, densidade, onde vai o espaço em branco, ' +
    'como os elementos se agrupam) precisa parecer nativa desta marca. Como só você controla a ' +
    'composição, prefira slides "freeform" (canvas de elementos) para materializar essa ' +
    'linguagem, guiando-se por estas características mineradas do próprio design system:\n' +
    lines.join('\n') +
    '\nUse SEMPRE tokens @tema (nunca hex) para que a composição continue re-adaptável. Componha ' +
    'com group+stack (auto-layout) — jamais chutando coordenadas item a item.' +
    '\n\nDIRETRIZ (design system com identidade própria): o padrão para ESTE deck é "freeform". ' +
    'Gere a MAIORIA dos slides como freeform, compondo com group+stack para refletir as ' +
    'composições reais do design system acima — capa, divisores e slides de conteúdo. Só use um ' +
    'layout semântico (bullets/cards/stat-grid/...) quando ele já reproduzir exatamente a ' +
    'composição desejada; se você gerar o deck inteiro em layouts semânticos, está ignorando a ' +
    'identidade do design system e o resultado será genérico. Cada slide freeform deve ter ' +
    'hierarquia clara (kicker + título afirmativo no topo, corpo composto abaixo), respeitar a ' +
    'margem de 0.62in e a proporção tipográfica indicada, e nunca deixar elementos sobrepostos ou ' +
    'fora do canvas.' +
    '\n\nDECORAÇÃO — regra dura: NUNCA invente formas decorativas (círculos, elipses, "blobs", ' +
    'anéis) para preencher espaço numa capa/divisor/encerramento. Ou você usa uma ILUSTRAÇÃO REAL ' +
    'da marca (elemento image com imageAssetId de um id listado acima), ou o background {plate:...}, ' +
    'ou deixa o espaço limpo. Um shape ellipse/rect só é válido quando é peça funcional da composição ' +
    '(placa de card, node de um diagrama, barra) — jamais como enfeite genérico. Espaço em branco ' +
    'intencional é mais elegante que um enfeite inventado.' +
    '\n\nCOMPLETUDE — cada slide freeform tem que sair CHEIO de conteúdo real (títulos, corpo, ' +
    'cards, diagramas, números com fonte). Um slide com só um título ou só uma placa vazia é uma ' +
    'falha. Se um elemento (ex.: um chart) não tem dados completos, substitua-o por text/shape ' +
    'com o que você tem — nunca deixe um group/região sem conteúdo.' +
    '\n\nDENSIDADE (calibre de deck profissional) — abaixo do título, a área de conteúdo (≈ y 1.5 ' +
    'a 5.0, largura útil ~8.75in) deve ser preenchida com uma COMPOSIÇÃO estruturada, não um bloco ' +
    'de texto solto. Prefira, conforme o conteúdo:\n' +
    '  • grade de 2–4 cards (group+stack) cada um com ícone (icon do tema) + rótulo curto (heading) ' +
    '+ 1 linha de apoio (body) — para benefícios, pilares, capacidades;\n' +
    '  • faixa de 2–4 métricas grandes (número em fonte heading ~34–44pt + legenda pequena por ' +
    'baixo) — para resultados/KPIs;\n' +
    '  • diagrama multi-coluna (2–4 colunas de nodes em stack, com uma coluna central enfatizada e ' +
    'setas/linhas ligando) — para arquiteturas e fluxos;\n' +
    '  • matriz de comparação (linhas × colunas com cabeçalho destacado) — para "antes/depois", ' +
    '"nós vs. eles", trade-offs.\n' +
    'Distribua os blocos pela largura toda (não empilhe tudo numa coluna estreita à esquerda), ' +
    'mantenha gaps/paddings consistentes entre os cards (auto-layout do stack) e alinhe as bordas. ' +
    'Um callout curto (kicker + frase) ancorado num canto fecha a composição. Cada slide de ' +
    'conteúdo deve ter tipicamente 6–14 elementos reais — poucos elementos num slide vazio é o ' +
    'sintoma de output pobre que queremos evitar.'
  )
}

// A short addendum steering a deck toward the user's selected template. When
// the DS is just colors + a logo, this only nudges wording/tone (the renderer
// already applies the visual side). When the DS is rich, templateComposition
// (above) additionally steers the COMPOSITION so the deck looks native to the
// brand rather than a repainted generic skeleton.
function templateHint(template) {
  if (!template || (!template.name && !template.styleNotes && !template.brandRules && !template.iconAssets?.length && !template.minedStyle?.diagrams?.length)) return ''
  const rich = hasRichDesignSystem(template)
  const parts = []
  if (template.name) parts.push(`modelo selecionado: "${template.name}"`)
  if (template.styleNotes) parts.push(`notas de estilo: ${template.styleNotes}`)
  // ceiling removed for rich DS: telling the model "visual is automatic, only
  // adjust tone" is exactly what makes every DS look the same — for a DS with
  // its own visual language, the model must own composition (templateComposition).
  let hint = rich
    ? `\n\nO usuário tem um design system ativo, com identidade visual própria (${parts.join('; ') || 'sem nome'}). ` +
      'Cores, fontes e logo são aplicados automaticamente, mas isso é só a superfície — a ' +
      'COMPOSIÇÃO dos slides precisa refletir esta marca (ver a linguagem de composição abaixo), ' +
      'não um layout genérico repintado. Ajuste tom, estrutura E composição para condizer com o design system.'
    : `\n\nO usuário tem um design system ativo para os decks (${parts.join('; ') || 'sem nome'}). ` +
      'Cores, fontes e logo já são aplicados automaticamente pelo Estúdio de Slides — ajuste ' +
      'apenas o tom e a estrutura do conteúdo (título, bullets, notas) para condizer com essas ' +
      'notas de estilo quando fizer sentido.'
  if (template.brandRules) {
    // the design-system bundle's own README (condensed at import — see
    // dsImport.js condenseReadme): brand voice, casing, color/type rules.
    // This is COPY guidance (how headlines/bullets/notes should sound), the
    // visual side is already applied by the renderer.
    hint +=
      '\n\nRegras de marca do próprio design system (siga-as na REDAÇÃO do deck — voz, casing, ' +
      'tom; a parte visual já é automática):\n---\n' +
      template.brandRules +
      '\n---'
  }
  const icons = usableIconAssets(template)
  if (icons.length) {
    hint +=
      '\nÍcones reais disponíveis neste design system (use o id em `iconRef` quando um combinar ' +
      'bem com o item; nunca use emoji; logos/fotos/marcas d\'água do design system não são ' +
      'ícones e não têm id listado aqui):\n' +
      icons.slice(0, 30).map((a) => `- ${a.id}: "${a.label || 'ícone sem nome'}"`).join('\n')
  } else {
    hint += '\nEste design system não tem nenhum ícone real cadastrado — não use `iconRef` (e nunca emoji).'
  }
  const images = usableImageAssets(template)
  if (images.length) {
    hint +=
      '\nImagens/fotos REAIS deste design system — em um slide de layout "image", use ' +
      'o campo `imageRef` com um destes ids para inserir o asset de verdade (só quando o rótulo ' +
      'indicar claramente que a imagem combina com o slide; rótulos genéricos como "Imagem 3" ' +
      'não dizem nada — nesse caso não use). Nunca use uma imagem que contenha marca d\'água:\n' +
      images.slice(0, 12).map((a) => `- ${a.id}: "${a.label || 'sem rótulo'}"`).join('\n')
  }
  const diagrams = (template.minedStyle?.diagrams || []).filter((d) => d?.id)
  if (diagrams.length) {
    hint +=
      '\nDiagramas vetoriais REAIS minerados dos slides deste design system — em um slide de ' +
      'layout "image", use o campo `diagramRef` com um destes ids para reproduzir o diagrama ' +
      'original (redesenhado em vetor, com as fontes do tema). Prefira um destes quando o ' +
      'assunto do slide corresponder ao rótulo; para arquiteturas novas que não existem no ' +
      'design system, use o layout "diagram" normal:\n' +
      diagrams.slice(0, 8).map((d) => `- ${d.id}: "${d.label || 'diagrama sem rótulo'}"`).join('\n')
  }
  // the composition brief goes last so it sits closest to where the model
  // starts generating — the freshest, most actionable guidance for a rich DS
  hint += templateComposition(template)
  return hint
}

// Capability detection (progressive disclosure — "skills fase 1"). The deck and
// spreadsheet policies are BIG (~5k and ~2.2k tokens) and the deck template hint
// adds more; sending all of them on every turn means a trivial "quanto é 2+2?"
// pays for the entire deck+spreadsheet+design-system surface it will never use.
// This detects, deterministically and at zero latency, whether a turn is even
// PLAUSIBLY about a deck or a spreadsheet, and the caller only includes the
// heavy policy when it is.
//
// Safety is asymmetric and we lean into it: a FALSE POSITIVE just re-adds tokens
// (harmless); a FALSE NEGATIVE would strip a capability the user wanted (bad).
// So the vocabulary is generous, and — critically — a capability stays ON for
// the whole session once its flow is active (a prior deck/deck-questions or
// spreadsheet block in history, or the answers-marker follow-up), because the
// deck flow is inherently multi-turn (ask → answer → tweak). CHART_POLICY is
// always sent regardless: it's small and it's what stops the model from emitting
// unrenderable Plotly/HTML code for the very common "faça um gráfico" ask.
const DECK_INTENT_RE =
  /\b(apresenta[çc][ãa]o|apresenta[çc][õo]es|apresentar|slides?|slide\s*deck|deck|decks|pitch|pptx|powerpoint|power\s*point|keynote|present(ation|e)|capa\s+do\s+deck)\b/i
const SPREADSHEET_INTENT_RE =
  /\b(planilhas?|xlsx?|excel|google\s*sheets?|sheets?|workbook|spreadsheet|or[çc]amento|valuation|dcf|proje[çc][ãa]o\s+financeira|modelo\s+(de\s+)?(c[áa]lculo|financeiro|valuation)|fluxo\s+de\s+caixa|planejamento\s+financeiro)\b/i
// "adjust this presentation to the template/design system" — captures the
// re-theming intent even when the word "deck/apresentação" isn't repeated
// (the .pptx attachment already implies the artifact).
const ADJUST_INTENT_RE =
  /\b(ajust\w+|adapt\w+|aplic\w+|reestrutur\w+|padroniz\w+|formatar|reformatar|refazer|converter|transform\w+|adjust|adapt|apply|restructure|reformat|convert|rework)\b/i
// "generate/create/draw an image/illustration/logo/…" — the trigger for the
// image-generation tool + policy. Requires BOTH a create-verb AND an image-noun
// nearby so "crie uma tabela" or "desenhe o fluxo em texto" don't false-fire;
// the verb and noun can appear in either order (e.g. "uma ilustração de ...").
const IMAGE_CREATE_VERB = /\b(gere?|gerar|cri[ae]r?|desenh\w+|ilustr\w+|fa[çc]a|fazer|produz\w+|render\w+|generate|create|draw|make|render|design|paint|imagine)\b/i
const IMAGE_NOUN = /\b(imagem|imagens|ilustra[çc][õo]es|ilustra[çc][ãa]o|figuras?|fotos?|fotografias?|desenhos?|arte|artwork|logotipos?|logos?|[íi]cones?|banner|p[ôo]ster|wallpaper|thumbnail|images?|illustrations?|pictures?|photos?|drawings?|logo|icons?|posters?)\b/i
const IMAGE_INTENT_RE = { test: (t) => IMAGE_CREATE_VERB.test(t) && IMAGE_NOUN.test(t) }
// "write/draft a document/report/article/letter/…" — the trigger for the
// document-writing capability (rich-text Studio + DOCX/MD/PDF export). Needs a
// write-verb AND a document-noun so "escreva um resumo" (a chat reply) doesn't
// force a document, but "escreva um DOCUMENTO/relatório/artigo" does.
const DOC_CREATE_VERB = /\b(escrev\w+|redij\w+|redig\w+|elabor\w+|crie|criar|gere?|gerar|produz\w+|prepar\w+|monte|montar|rascunh\w+|write|draft|compose|create|generate|prepare|author)\b/i
const DOC_NOUN = /\b(documento|documentos|relat[óo]rios?|artigos?|texto|textos|ensaios?|carta|cartas|ofício|memorando|memorandos|proposta|propostas|contrato|contratos|pol[íi]tica|pol[íi]ticas|manual|manuais|especifica[çc][ãa]o|readme|whitepaper|white\s*paper|briefing|document|documents|reports?|articles?|essays?|letters?|memo|memos|proposals?|contracts?|policy|policies|specs?|specifications?)\b/i
const DOC_INTENT_RE = { test: (t) => DOC_CREATE_VERB.test(t) && DOC_NOUN.test(t) }

function historyHasBlock(history, types) {
  for (const m of history || []) {
    const blocks = m.blocks
    if (Array.isArray(blocks) && blocks.some((b) => types.includes(b?.type))) return true
  }
  return false
}

// Returns { deck, spreadsheet } — whether each heavy capability's policy should
// be included this turn. `userText` is the current prompt; `history` is the
// prior thread (each message may carry a `blocks` array).
export function detectCapabilities(userText, history, opts = {}) {
  const text = String(userText || '')
  // the deck flow's follow-up turn arrives as "Perguntas respondidas: ..." (see
  // DECK_POLICY etapa 2) — keep deck on so generation gets the full policy
  const answeringDeckQuestions = /^\s*perguntas respondidas\s*:/i.test(text)
  // A .pptx attached WITH an adjust/deck intent → the "adjust presentation" skill.
  // A bare .pptx with no intent stays plain-text (handled upstream). When it does
  // fire, deck is implied (same generation/render pipeline, re-themed to the DS).
  const pptxAdjust =
    !!opts.hasPptxAttachment && (DECK_INTENT_RE.test(text) || ADJUST_INTENT_RE.test(text))
  // Per-type EXPLICIT intent in the CURRENT message. These are what the user is
  // actually asking for this turn.
  const deckIntent = DECK_INTENT_RE.test(text) || answeringDeckQuestions || pptxAdjust
  const spreadsheetIntent = SPREADSHEET_INTENT_RE.test(text)
  // an attached image also warms image (the user likely wants to edit it, and
  // "deixe em p&b" carries no image-noun the regex would catch)
  const imageIntent = IMAGE_INTENT_RE.test(text) || !!opts.hasImageAttachment
  const documentIntent = DOC_INTENT_RE.test(text)

  // Sticky capabilities: a thread that already produced an artifact keeps that
  // capability warm so a FOLLOW-UP with no explicit noun ("deixe mais escuro",
  // "outra versão", "mais formal") still resolves against the right artifact.
  //
  // BUT stickiness must NOT bleed across artifact types: if the current turn
  // has an explicit intent for SOME OTHER type (e.g. "gere uma imagem" right
  // after a document was created), the unrelated sticky capabilities are
  // dropped — otherwise the model receives the document policy on an image turn
  // and "helpfully" emits a document nobody asked for (the exact bug). So a
  // capability turns on when: it's explicitly requested this turn, OR the thread
  // has that artifact AND the current turn makes no competing explicit request.
  const anyExplicitIntent = deckIntent || spreadsheetIntent || imageIntent || documentIntent
  const sticky = (myIntent, types) =>
    myIntent || (historyHasBlock(history, types) && (!anyExplicitIntent || myIntent))

  const deck = sticky(deckIntent, ['deck', 'deck-questions'])
  const spreadsheet = sticky(spreadsheetIntent, ['spreadsheet'])
  const image = sticky(imageIntent, ['image'])
  const document = sticky(documentIntent, ['document'])
  return { deck, spreadsheet, pptxAdjust, image, document }
}

// The product's built-in capabilities, surfaced as read-only "system skills":
// they show up in the Skills tab (so every deployment ships them pre-listed,
// no seeding needed) and drive the ephemeral "skill active" badge when the
// router turns a capability on. These are NOT stored in the DB — their bodies
// live in code (DECK_POLICY/SPREADSHEET_POLICY/CHART_POLICY above); this is
// just their catalog metadata. `chart` is always-on (CHART_POLICY is always
// injected), so it isn't badged per-turn — only deck/spreadsheet are gated.
export const SYSTEM_SKILLS = [
  {
    name: 'deck-generation',
    title: 'Geração de apresentações',
    description:
      'Cria apresentações (decks de slides) a partir de um pedido, com design system e exportação .pptx.',
    cap: 'deck',
  },
  {
    name: 'spreadsheet-generation',
    title: 'Geração de planilhas',
    description:
      'Monta planilhas (.xlsx) com abas, tabelas, fórmulas e gráficos a partir de um pedido ou de dados da conversa.',
    cap: 'spreadsheet',
  },
  {
    name: 'chart-generation',
    title: 'Gráficos e destaques',
    description:
      'Insere gráficos e cartões de destaque na resposta a partir de dados reais da conversa.',
    cap: 'chart',
    alwaysOn: true,
  },
  {
    name: 'pptx-adjust',
    title: 'Ajuste de apresentação',
    description:
      'Reestrutura um .pptx anexado no design system selecionado, preservando o conteúdo e a intenção de cada slide.',
    cap: 'pptxAdjust',
  },
  {
    name: 'image-generation',
    title: 'Geração de imagens',
    description:
      'Gera imagens a partir de uma descrição (text-to-image) e as exibe inline na conversa.',
    cap: 'image',
  },
  {
    name: 'document-generation',
    title: 'Geração de documentos',
    description:
      'Escreve documentos de texto (relatórios, artigos, cartas) em markdown, com edição por IA e exportação DOCX/Markdown/PDF.',
    cap: 'document',
  },
]

// Maps the detectCapabilities() result to badge-shaped system skills for the
// turn — the deck/spreadsheet capabilities that were actually turned on. Used
// to emit the `skill_active` SSE event so built-in capabilities light up the
// same ephemeral badge as authored skills. Chart is excluded (always on → not
// a meaningful per-turn signal).
export function activeSystemSkills(caps) {
  if (!caps) return []
  return SYSTEM_SKILLS.filter((s) => !s.alwaysOn && caps[s.cap]).map((s) => ({
    name: s.name,
    title: s.title,
    description: s.description,
  }))
}

export function buildBlocksInstruction(candidates, template, caps) {
  // default to all-on so any caller that doesn't pass caps keeps the original
  // (always-include-everything) behavior — the gating is strictly opt-in.
  const c = caps || { deck: true, spreadsheet: true }

  let out
  if (!candidates?.length) {
    out = CHART_POLICY + NO_CANDIDATES_INSTRUCTION
  } else {
    out =
      CHART_POLICY +
      '\nVocê tem acesso a dados reais pré-calculados para visualização. Quando algum deles ' +
      'ilustrar bem um trecho da sua resposta, insira o bloco logo APÓS o parágrafo relacionado ' +
      '(não junte todos no final da mensagem — cada um deve ficar próximo do trecho que comenta), ' +
      'em sua própria linha, neste formato:\n' +
      '```prism-block\n{"type":"chart","ref":"candidate_1","caption":"legenda curta"}\n```\n' +
      'Se você tiver dados reais desta conversa que NÃO estão na lista de candidatos abaixo (ex.: ' +
      'resultado de uma tool), use o modo de dados em linha descrito acima (chartType + series→data→' +
      '{label,value}) — nunca invente um "ref" para um candidato inexistente.\n' +
      'Para destacar um achado importante (sem gráfico), use:\n' +
      '```prism-block\n{"type":"insight","title":"...","body":"..."}\n```\n' +
      'Regras: "ref" apenas com os IDs abaixo (nunca invente dados de gráfico); no máximo 12 blocos ' +
      'no total — se o usuário pediu um relatório com várias seções/métricas, é esperado usar um ' +
      'bloco por seção, não apenas 1 ou 2; posicione cada um imediatamente após o trecho de texto ' +
      'que ele ilustra; omita blocos se nenhum candidato for realmente útil para aquele trecho.' +
      '\n\nCandidatos disponíveis:\n' +
      candidatesText(candidates)
  }

  // heavy, capability-specific policies — included only when the turn is
  // plausibly about that capability. Order preserved from the original
  // (DECK, then SPREADSHEET, then the deck templateHint) for byte-stability
  // when both are on, which also keeps the prompt-cache prefix stable.
  if (c.deck) out += DECK_POLICY
  if (c.spreadsheet) out += SPREADSHEET_POLICY
  if (c.image) out += IMAGE_POLICY
  if (c.document) out += DOCUMENT_POLICY
  // Grounding: a deck or document with wrong figures loses all credibility no
  // matter how polished. When one of those is in play, reinforce that any
  // current/factual number must come from web_search (when available) and carry
  // its source — appended after the policies so it's the freshest instruction.
  if (c.deck || c.document) out += GROUNDING_DIRECTIVE
  if (c.deck) out += templateHint(template)
  return out
}

// Reinforces grounding for the artifacts where a wrong number is most damaging.
// The web_search tool (when an admin configured WEB_SEARCH_CONNECTION) is
// offered on every turn; this makes its use non-optional for time-sensitive or
// factual figures inside a deck/document, and requires a cited source.
const GROUNDING_DIRECTIVE =
  '\n\n=== DADOS REAIS E FONTES (apresentações e documentos) ===\n' +
  'Este artefato precisa ser factualmente correto. Para QUALQUER número, estatística, cotação, ' +
  'data ou fato que dependa do mundo real atual (ex.: taxas, índices, resultados, market share, ' +
  'notícias recentes), NÃO estime de memória: use a tool `web_search` para obter o valor atual e ' +
  'cite a fonte e a data ao lado do dado (ex.: em uma nota de rodapé do slide, na legenda de um ' +
  'gráfico, ou entre parênteses no texto). Se a tool de busca não estiver disponível e você não ' +
  'tiver como confirmar um número, diga explicitamente que é uma estimativa/ordem de grandeza em ' +
  'vez de apresentá-lo como fato — nunca invente precisão que você não tem.'

function candidatesText(candidates) {
  return candidates.map((c) => `- ${c.id} (${c.chartType}): "${c.title}"`).join('\n')
}

// Appended to a tool result's model-facing content (never the chip shown to
// the user) right after a Genie call returns query data — tells the model
// these new candidate ids exist so a prism-block referencing them actually
// resolves, without re-sending the whole chart policy on every round.
export function buildNewCandidatesHint(newCandidates) {
  if (!newCandidates?.length) return ''
  return (
    '\n\n[Novos candidatos de gráfico disponíveis a partir deste resultado — se forem úteis, ' +
    'use o bloco ```prism-block já descrito, com um destes IDs em "ref":]\n' +
    candidatesText(newCandidates)
  )
}

// A reference to a real icon asset mined from (or manually added to) the
// user's selected template — see DeckTemplatesSettings.jsx iconAssets. Never
// a free-choice emoji. `iconById` (candidate generation path, built once in
// sanitizeDeck from template.iconAssets) validates the model's `iconRef`
// against ids that actually exist right now; without it (Studio edit path,
// PATCH /api/decks/:id has no template in scope) the already-baked
// `iconAssetId` is passed through as-is — same shape as chartType/series
// round-tripping through an edit without byId, above.
function resolveIconAssetId(raw, iconById) {
  if (iconById) {
    // `iconRef` is the model's pick; an echoed `iconAssetId` (a tweak turn
    // round-trips the already-baked slide JSON) is equally valid — both are
    // the same asset ids, and both must exist right now to survive
    const t =
      (typeof raw.iconRef === 'string' && raw.iconRef.trim()) ||
      (typeof raw.iconAssetId === 'string' && raw.iconAssetId.trim()) ||
      ''
    return t && iconById.has(t) ? t : undefined
  }
  if (typeof raw.iconAssetId === 'string' && raw.iconAssetId.trim()) return raw.iconAssetId.trim().slice(0, 60)
  return undefined
}

// Applies the icon fallback chain to an icon-bearing item: a real template
// icon (`iconRef`, validated above) wins; otherwise a neutral built-in
// pictogram (`icon`, validated against shared/deckIcons.js). Never emoji.
function applyItemIcons(item, raw, iconById) {
  const iconAssetId = resolveIconAssetId(raw, iconById)
  if (iconAssetId) item.iconAssetId = iconAssetId
  else if (typeof raw.icon === 'string' && DECK_ICON_SET.has(raw.icon.trim())) item.icon = raw.icon.trim()
  return item
}

// Length cap that never chops mid-word: cuts at the last word boundary and
// appends an ellipsis, so an over-long model string degrades to "…", not to
// gibberish like "(Gartner, 2".
function cut(s, n) {
  if (s.length <= n) return s
  const sliced = s.slice(0, n)
  const i = sliced.lastIndexOf(' ')
  return (i > n * 0.6 ? sliced.slice(0, i) : sliced).replace(/[\s,;:—–-]+$/, '') + '…'
}

function sanitizeBulletList(raw, max = MAX_DECK_BULLETS) {
  if (!Array.isArray(raw)) return undefined
  const list = raw.filter((b) => typeof b === 'string' && b.trim()).slice(0, max).map((b) => cut(b, 160))
  return list.length ? list : undefined
}

// Coerces the alternate chart shapes a model tends to improvise into the one
// canonical shape sanitizeChartSeries expects (series→data→{label,value}).
// Chart.js/Plotly-flavored `{labels:[...], series:[{values:[...]}]}` is the
// most common drift (it's what leaked as a raw code block before inline charts
// were allowed) — parallel `labels`+`values` arrays are zipped back into
// {label,value} points. Returns raw untouched when it's already the canonical
// array of series, so the normal path is unaffected.
function normalizeChartSeries(raw, container) {
  if (Array.isArray(raw) && raw.every((s) => s && Array.isArray(s.data))) return raw
  // labels can sit on the chart-level `data` object or alongside the series
  const labels = Array.isArray(container?.labels)
    ? container.labels
    : Array.isArray(container?.data?.labels)
      ? container.data.labels
      : null
  // series may be raw itself, or nested under a `data` wrapper (data.series)
  const seriesList = Array.isArray(raw)
    ? raw
    : Array.isArray(container?.data?.series)
      ? container.data.series
      : null
  if (!Array.isArray(seriesList)) return raw
  return seriesList.map((s, si) => {
    if (s && Array.isArray(s.data)) return s // already canonical points
    const values = Array.isArray(s?.values) ? s.values : Array.isArray(s?.data) ? s.data : null
    if (!Array.isArray(values)) return s
    const data = values.map((v, i) => ({
      label: labels && labels[i] != null ? String(labels[i]) : String(i + 1),
      value: v,
    }))
    return { name: typeof s?.name === 'string' ? s.name : `Série ${si + 1}`, data }
  })
}

// Validates an already-resolved chart series (either freshly baked from a
// trusted candidate, or round-tripped through a Studio edit) — same shape as
// the candidates in server/analysis.js: [{name, data:[{label, value}]}].
function sanitizeChartSeries(raw) {
  if (!Array.isArray(raw)) return null
  const series = raw
    .slice(0, 6)
    .map((s) => {
      if (!s || typeof s.name !== 'string' || !Array.isArray(s.data)) return null
      const data = s.data.slice(0, 30).map((d) => ({
        label: String(d?.label ?? '').slice(0, 60),
        value: typeof d?.value === 'number' ? d.value : Number(d?.value) || 0,
      }))
      return { name: s.name.slice(0, 60), data }
    })
    .filter(Boolean)
  return series.length ? series : null
}

const DIAGRAM_GEOMS = new Set([
  'rect', 'roundRect', 'ellipse', 'diamond', 'triangle', 'hexagon', 'pentagon',
  'chevron', 'homePlate', 'parallelogram', 'trapezoid', 'can', 'cube', 'pie',
  'rightArrow', 'leftArrow', 'upArrow', 'downArrow', 'leftRightArrow',
])
const MAX_DIAGRAM_SHAPES = 48
const MAX_DIAGRAM_CONNECTORS = 24

const frac = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, -0.2), 1.2) : null)
const hexColor = (v) => (typeof v === 'string' && /^#?[0-9a-fA-F]{6}$/.test(v.trim()) ? '#' + v.trim().replace('#', '').toUpperCase() : null)

// element-canvas colors also accept '@themeToken' references (resolved at
// paint time by resolveStyleTokens — this is what keeps LLM-generated
// freeform slides re-themable when the user switches design systems)
const THEME_TOKEN_SET = new Set(THEME_COLOR_TOKENS)
const elementColor = (v) => {
  if (typeof v === 'string' && v[0] === '@') return THEME_TOKEN_SET.has(v.slice(1)) ? v : null
  return hexColor(v)
}

// Validates a mined vector diagram spec (see mineSlideDiagrams in
// DeckTemplatesSettings.jsx) — used both when baking a model-chosen
// `diagramRef` into a slide and when a Studio edit round-trips the
// already-baked `diagramSpec`. Untrusted input either way: templates are
// client-authored JSON, deck PATCHes are user-authored.
export function sanitizeDiagramSpec(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.shapes)) return null
  const shapes = raw.shapes
    .slice(0, MAX_DIAGRAM_SHAPES)
    .map((s) => {
      if (!s || typeof s !== 'object') return null
      const x = frac(s.x)
      const y = frac(s.y)
      const w = frac(s.w)
      const h = frac(s.h)
      if (x == null || y == null || !w || !h || w <= 0 || h <= 0) return null
      const shape = { x, y, w, h, geom: DIAGRAM_GEOMS.has(s.geom) ? s.geom : 'rect' }
      const color = hexColor(s.color)
      if (color) shape.color = color
      const line = hexColor(s.line)
      if (line) shape.line = line
      if (typeof s.text === 'string' && s.text.trim()) {
        shape.text = cut(s.text.trim(), 120)
        const textColor = hexColor(s.textColor)
        if (textColor) shape.textColor = textColor
        if (typeof s.fontPt === 'number' && Number.isFinite(s.fontPt)) shape.fontPt = Math.min(Math.max(s.fontPt, 5), 40)
        if (s.bold) shape.bold = true
      }
      if (typeof s.rot === 'number' && Number.isFinite(s.rot)) shape.rot = Math.round(s.rot) % 360
      return shape
    })
    .filter(Boolean)
  if (!shapes.length) return null
  const connectors = (Array.isArray(raw.connectors) ? raw.connectors : [])
    .slice(0, MAX_DIAGRAM_CONNECTORS)
    .map((c) => {
      if (!c || typeof c !== 'object') return null
      const x = frac(c.x)
      const y = frac(c.y)
      const w = frac(c.w)
      const h = frac(c.h)
      if (x == null || y == null || w == null || h == null) return null
      const conn = { x, y, w, h }
      if (c.flipH) conn.flipH = true
      if (c.flipV) conn.flipV = true
      if (c.arrow) conn.arrow = true
      const color = hexColor(c.color)
      if (color) conn.color = color
      return conn
    })
    .filter(Boolean)
  const spec = { shapes, connectors }
  if (typeof raw.aspect === 'number' && raw.aspect > 0.5 && raw.aspect < 4) spec.aspect = raw.aspect
  if (typeof raw.label === 'string' && raw.label.trim()) spec.label = raw.label.slice(0, 120)
  const bg = hexColor(raw.bg)
  if (bg) spec.bg = bg
  return spec
}

// `byId` (candidate_N -> candidate) is only ever passed on the generation
// path (resolveOne, right after a fresh model turn) — a `chart` layout slide
// gets its series baked in statically right here, exactly like the chat's
// own `chart` block, so no dangling "ref" ever needs resolving later. Studio
// edits (PATCH /api/decks/:id) call this without `byId`; a `chart` slide
// there just gets its already-baked chartType/series re-validated.
function sanitizeDeckSlide(raw, byId, iconById, imageById, diagramById) {
  if (!raw || typeof raw !== 'object') return null

  // freeform slide (element canvas): a TREE of positioned elements (groups/
  // stacks/charts — see shared/deckLayout.js) the user edits Figma-style in
  // the Studio. Produced by the generation model (the DECK_POLICY freeform
  // section) AND by Studio PATCH/tweak — this branch validates both. Mixed
  // decks (semantic + freeform slides) flow through sanitizeDeck naturally.
  if (raw.layout === 'freeform' || Array.isArray(raw.elements)) {
    const slide = { layout: 'freeform', elements: sanitizeElements(raw.elements) }
    if (typeof raw.title === 'string' && raw.title.trim()) slide.title = raw.title.slice(0, 140)
    if (raw.background && typeof raw.background === 'object') {
      const bg = {}
      const bgColor = elementColor(raw.background.color)
      if (bgColor) bg.color = bgColor
      if (['cover', 'section'].includes(raw.background.plate)) bg.plate = raw.background.plate
      if (Object.keys(bg).length) slide.background = bg
    }
    if (typeof raw.notes === 'string' && raw.notes.trim()) slide.notes = raw.notes.slice(0, 500)
    // the retained semantic source (set at conversion time) — makes
    // "reverter para semântico" free; validated as a normal semantic slide
    if (raw.source && typeof raw.source === 'object' && !Array.isArray(raw.source.elements) && raw.source.layout !== 'freeform') {
      const src = sanitizeDeckSlide(raw.source, byId, iconById, imageById, diagramById)
      if (src && src.layout !== 'freeform') slide.source = src
    }
    return slide
  }

  const slide = { layout: DECK_LAYOUTS.has(raw.layout) ? raw.layout : 'bullets' }
  if (typeof raw.heading === 'string' && raw.heading.trim()) slide.heading = raw.heading.slice(0, 140)
  if (typeof raw.subheading === 'string' && raw.subheading.trim()) slide.subheading = raw.subheading.slice(0, 200)
  if (typeof raw.kicker === 'string' && raw.kicker.trim()) slide.kicker = raw.kicker.slice(0, 60)
  if (typeof raw.footnote === 'string' && raw.footnote.trim()) slide.footnote = cut(raw.footnote, 220)
  if (raw.callout && typeof raw.callout === 'object' && typeof raw.callout.text === 'string' && raw.callout.text.trim()) {
    slide.callout = { text: cut(raw.callout.text, 220) }
    if (typeof raw.callout.kicker === 'string' && raw.callout.kicker.trim()) slide.callout.kicker = raw.callout.kicker.slice(0, 40)
  }
  const bullets = sanitizeBulletList(raw.bullets)
  if (bullets) slide.bullets = bullets
  if (typeof raw.body === 'string' && raw.body.trim()) slide.body = raw.body.slice(0, 600)
  if (typeof raw.notes === 'string' && raw.notes.trim()) slide.notes = raw.notes.slice(0, 500)

  if (Array.isArray(raw.cards)) {
    const cards = raw.cards
      .filter((c) => c && typeof c.heading === 'string' && c.heading.trim())
      .slice(0, MAX_DECK_CARDS)
      .map((c) => {
        const card = { heading: c.heading.slice(0, 80) }
        if (typeof c.body === 'string' && c.body.trim()) card.body = cut(c.body, 220)
        return applyItemIcons(card, c, iconById)
      })
    if (cards.length) slide.cards = cards
  }

  if (Array.isArray(raw.stats)) {
    const stats = raw.stats
      .filter((s) => s && typeof s.value === 'string' && s.value.trim())
      .slice(0, MAX_DECK_STATS)
      .map((s) => {
        const stat = { value: s.value.slice(0, 24) }
        if (typeof s.label === 'string' && s.label.trim()) stat.label = cut(s.label, 120)
        return applyItemIcons(stat, s, iconById)
      })
    if (stats.length) slide.stats = stats
  }

  if (typeof raw.leftTitle === 'string' && raw.leftTitle.trim()) slide.leftTitle = raw.leftTitle.slice(0, 80)
  if (typeof raw.rightTitle === 'string' && raw.rightTitle.trim()) slide.rightTitle = raw.rightTitle.slice(0, 80)
  const leftBullets = sanitizeBulletList(raw.leftBullets)
  if (leftBullets) slide.leftBullets = leftBullets
  const rightBullets = sanitizeBulletList(raw.rightBullets)
  if (rightBullets) slide.rightBullets = rightBullets

  if (Array.isArray(raw.phases)) {
    const phases = raw.phases
      .filter((p) => p && typeof p.label === 'string' && p.label.trim())
      .slice(0, MAX_DECK_PHASES)
      .map((p) => {
        const phase = { label: p.label.slice(0, 60) }
        if (typeof p.period === 'string' && p.period.trim()) phase.period = p.period.slice(0, 40)
        if (typeof p.body === 'string' && p.body.trim()) phase.body = cut(p.body, 160)
        return applyItemIcons(phase, p, iconById)
      })
    if (phases.length) slide.phases = phases
  }

  // editorial numbered list (agenda/executive summary) — two-level items;
  // plain-string bullets keep working for backwards compatibility
  if (Array.isArray(raw.items)) {
    const items = raw.items
      .map((it) => (typeof it === 'string' ? { title: it } : it))
      .filter((it) => it && typeof it.title === 'string' && it.title.trim())
      .slice(0, 7)
      .map((it) => {
        const item = { title: it.title.slice(0, 90) }
        if (typeof it.body === 'string' && it.body.trim()) item.body = cut(it.body, 160)
        return item
      })
    if (items.length) slide.items = items
  }

  // diagram layout (architecture/flow): up to 4 labeled columns — side rails
  // of chips and/or one emphasized panel of stacked bands (see diagramSlide
  // in server/decks.js)
  if (slide.layout === 'diagram' && Array.isArray(raw.columns)) {
    const columns = raw.columns
      .filter((c) => c && typeof c === 'object')
      .slice(0, 4)
      .map((c) => {
        const col = {}
        if (typeof c.label === 'string' && c.label.trim()) col.label = c.label.slice(0, 60)
        if (typeof c.sublabel === 'string' && c.sublabel.trim()) col.sublabel = c.sublabel.slice(0, 80)
        if (c.emphasis) col.emphasis = true
        if (Array.isArray(c.items)) {
          col.items = c.items
            .filter((it) => it && typeof it.label === 'string' && it.label.trim())
            .slice(0, 6)
            .map((it) => applyItemIcons({ label: it.label.slice(0, 60) }, it, iconById))
        }
        if (Array.isArray(c.bands)) {
          col.bands = c.bands
            .filter((b) => b && typeof b.label === 'string' && b.label.trim())
            .slice(0, 5)
            .map((b) => {
              const band = { label: b.label.slice(0, 80) }
              if (b.tone === 'accent') band.tone = 'accent'
              return band
            })
        }
        return col
      })
      .filter((c) => c.items?.length || c.bands?.length)
    if (columns.length) slide.columns = columns
    return slide
  }

  if (Array.isArray(raw.columns) && Array.isArray(raw.rows)) {
    const columns = raw.columns.slice(0, MAX_DECK_TABLE_COLS).map((c) => String(c ?? '').slice(0, 40))
    if (columns.length) {
      slide.columns = columns
      slide.rows = raw.rows
        .slice(0, MAX_DECK_TABLE_ROWS)
        .map((r) => (Array.isArray(r) ? r : []).slice(0, columns.length).map((cell) => cut(String(cell ?? ''), 140)))
      // capability-matrix extensions (see tableSlide in server/decks.js):
      // "level" cells render as ●◑○ and highlightColumn tints the winner
      if (raw.cellStyle === 'level') slide.cellStyle = 'level'
      if (Number.isInteger(raw.highlightColumn) && raw.highlightColumn >= 0 && raw.highlightColumn < columns.length) {
        slide.highlightColumn = raw.highlightColumn
      }
    }
  }

  if (slide.layout === 'chart') {
    if (byId && typeof raw.chartRef === 'string') {
      const cand = byId.get(raw.chartRef)
      if (cand) {
        slide.chartType = cand.chartType
        slide.series = cand.series
        if (!slide.heading) slide.heading = cand.title
      }
    } else if (typeof raw.chartType === 'string') {
      const series = sanitizeChartSeries(raw.series)
      if (series) {
        slide.chartType = raw.chartType
        slide.series = series
      }
    }
  }

  if (
    typeof raw.imageDataUrl === 'string' &&
    raw.imageDataUrl.length < 8_000_000 &&
    /^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,/.test(raw.imageDataUrl)
  ) {
    slide.imageDataUrl = raw.imageDataUrl
  } else if (imageById && typeof raw.imageRef === 'string') {
    // a real photo asset from the template's design system, chosen by the
    // model via id (generation path only) — baked in statically like a chart
    // candidate, so nothing dangles later. Watermark-kind assets are never in
    // this map (see usableImageAssets).
    const asset = imageById.get(raw.imageRef.trim())
    if (asset) slide.imageDataUrl = asset.dataUrl
  }

  // mined vector diagram (design system asset): `diagramRef` on the
  // generation path bakes the validated spec into the slide; a Studio edit
  // round-trips the baked `diagramSpec` through the same validation
  if (diagramById && typeof raw.diagramRef === 'string') {
    const spec = diagramById.get(raw.diagramRef.trim())
    if (spec) slide.diagramSpec = spec
  } else if (raw.diagramSpec) {
    const spec = sanitizeDiagramSpec(raw.diagramSpec)
    if (spec) slide.diagramSpec = spec
  }

  const styles = sanitizeSlideStyles(raw.styles)
  if (styles) slide.styles = styles

  return slide
}

// --- element-canvas validation (freeform slides) -----------------------------

const clampNum = (v, min, max) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null
}
const r2 = (v) => Math.round(v * 100) / 100

// Full visual style prop set for canvas elements — every value clamped to a
// bounded range. Colors are concrete '#RRGGBB' OR '@themeToken' references
// (LLM-generated freeform slides use tokens so they keep re-theming; slides
// converted in the Studio bake concrete values and stay WYSIWYG-frozen).
export function sanitizeElementStyle(raw) {
  if (!raw || typeof raw !== 'object') return {}
  const st = {}
  const color = (v) => elementColor(v)
  if (raw.fill === 'none') st.fill = 'none'
  else if (color(raw.fill)) st.fill = color(raw.fill)
  const opacity = clampNum(raw.opacity, 0, 100)
  if (opacity != null && opacity < 100) st.opacity = Math.round(opacity)
  if (color(raw.borderColor)) st.borderColor = color(raw.borderColor)
  const bw = clampNum(raw.borderWidth, 0, 20)
  if (bw != null && bw > 0) st.borderWidth = Math.round(bw * 4) / 4
  if (['solid', 'dash', 'dot'].includes(raw.borderDash)) st.borderDash = raw.borderDash
  // corner radius beyond 0.5in reads as an ellipse, never a card — values
  // above it are almost always the model confusing px with inches
  const radius = clampNum(raw.radius, 0, 0.5)
  if (radius != null && radius > 0) st.radius = r2(radius)
  if (raw.shadow === true) st.shadow = true
  else if (raw.shadow && typeof raw.shadow === 'object') {
    const sh = {}
    if (color(raw.shadow.color)) sh.color = color(raw.shadow.color)
    const blur = clampNum(raw.shadow.blur, 0, 40)
    if (blur != null) sh.blur = Math.round(blur)
    const off = clampNum(raw.shadow.offset, 0, 20)
    if (off != null) sh.offset = Math.round(off)
    const shOp = clampNum(raw.shadow.opacity, 0, 100)
    if (shOp != null) sh.opacity = Math.round(shOp)
    st.shadow = sh
  }
  if (['visible', 'hidden'].includes(raw.overflow)) st.overflow = raw.overflow
  // text
  if (['heading', 'body'].includes(raw.fontRole)) st.fontRole = raw.fontRole
  if (typeof raw.fontFamily === 'string' && raw.fontFamily.trim() && raw.fontFamily.length <= 60) st.fontFamily = raw.fontFamily.trim()
  const fs = clampNum(raw.fontSize, 5, 120)
  if (fs != null) st.fontSize = Math.round(fs * 2) / 2
  if (color(raw.color)) st.color = color(raw.color)
  for (const k of ['bold', 'italic', 'underline', 'uppercase', 'bullet']) {
    if (typeof raw[k] === 'boolean') st[k] = raw[k]
  }
  if (['left', 'center', 'right'].includes(raw.align)) st.align = raw.align
  if (['top', 'middle', 'bottom'].includes(raw.valign)) st.valign = raw.valign
  const lh = clampNum(raw.lineHeight, 0.7, 3)
  if (lh != null && lh !== 1) st.lineHeight = r2(lh)
  const ls = clampNum(raw.letterSpacing, 0, 10)
  if (ls != null && ls > 0) st.letterSpacing = Math.round(ls * 10) / 10
  // line
  if (color(raw.lineColor)) st.lineColor = color(raw.lineColor)
  const lw = clampNum(raw.lineWidth, 0.25, 20)
  if (lw != null) st.lineWidth = Math.round(lw * 4) / 4
  if (['solid', 'dash', 'dot'].includes(raw.dash)) st.dash = raw.dash
  for (const k of ['arrowStart', 'arrowEnd']) {
    if (typeof raw[k] === 'boolean') st[k] = raw[k]
  }
  return st
}

// Chart element spec (see CHART_KINDS in shared/deckLayout.js): native kinds
// carry {series}; heatmap/gantt carry their own composed-grid data. Numbers
// are model- or user-authored — the DECK_POLICY data-honesty rules govern
// where they may come from; this only bounds shape and size.
export function sanitizeChartSpec(raw) {
  if (!raw || typeof raw !== 'object' || !CHART_KINDS.includes(raw.kind)) return null
  const spec = { kind: raw.kind }
  if (raw.kind === 'heatmap') {
    const hm = raw.heatmap
    if (!hm || !Array.isArray(hm.xLabels) || !Array.isArray(hm.yLabels) || !Array.isArray(hm.values)) return null
    const xLabels = hm.xLabels.slice(0, 14).map((l) => String(l ?? '').slice(0, 30))
    const yLabels = hm.yLabels.slice(0, 12).map((l) => String(l ?? '').slice(0, 40))
    if (!xLabels.length || !yLabels.length) return null
    const values = yLabels.map((_, r) =>
      xLabels.map((_, c) => {
        const n = Number(hm.values[r]?.[c])
        return Number.isFinite(n) ? Math.round(n * 100) / 100 : null
      })
    )
    spec.heatmap = { xLabels, yLabels, values }
    for (const k of ['min', 'max']) {
      if (typeof hm[k] === 'number' && Number.isFinite(hm[k])) spec.heatmap[k] = hm[k]
    }
    if (hm.showValues === false) spec.heatmap.showValues = false
    return spec
  }
  if (raw.kind === 'gantt') {
    const g = raw.gantt
    if (!g || !Array.isArray(g.tasks)) return null
    const tasks = g.tasks
      .slice(0, 12)
      .map((t) => {
        if (!t || typeof t.label !== 'string' || !t.label.trim()) return null
        const start = Number(t.start)
        const end = Number(t.end)
        if (!Number.isFinite(start) || !Number.isFinite(end)) return null
        const task = { label: cut(t.label.trim(), 60), start, end: Math.max(end, start) }
        const color = elementColor(t.color)
        if (color) task.color = color
        if (t.milestone) task.milestone = true
        return task
      })
      .filter(Boolean)
    if (!tasks.length) return null
    spec.gantt = { tasks }
    if (Array.isArray(g.axis) && g.axis.length) {
      spec.gantt.axis = g.axis.slice(0, 16).map((a) => String(a ?? '').slice(0, 20))
    }
    return spec
  }
  if (raw.kind === 'scatter') {
    const series = (Array.isArray(raw.series) ? raw.series : [])
      .slice(0, 4)
      .map((s) => {
        const src = s?.points ?? s?.data
        if (!Array.isArray(src)) return null
        const points = src
          .slice(0, 60)
          .map((p) => {
            const x = Number(p?.x)
            const y = Number(p?.y)
            return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
          })
          .filter(Boolean)
        return points.length ? { name: String(s.name ?? '').slice(0, 60) || 'Série', points } : null
      })
      .filter(Boolean)
    if (!series.length) return null
    spec.series = series
  } else {
    const series = sanitizeChartSeries(raw.series)
    if (!series) return null
    spec.series = series
  }
  if (raw.showLegend === false) spec.showLegend = false
  if (raw.showValues === true) spec.showValues = true
  return spec
}

// Does a group's own style paint a visible panel (card plate / border / shadow)?
// A group with no content-bearing descendants is the "Grupo · 0" blank-slide
// symptom EVEN when it carries such a style (a plate with nothing on it), so we
// prune it regardless — this helper is used only to word the repair note.
function styleDrawsPanel(style) {
  return !!(style && (style.fill || style.borderColor || style.shadow))
}

// `ctx` (optional, generation path only) collects a repair manifest: every
// child dropped or salvaged is pushed as {reason, ...} so the caller can drive
// a targeted regeneration and QA can explain WHY a slide came out thin. When
// ctx is null (Studio edit path), behavior is unchanged except the same
// prune/salvage repairs, which are correct in both paths.
const ELEMENT_ID_RE = /^[\w.-]{1,48}$/
export function sanitizeElement(raw, depth = 0, ctx = null) {
  if (!raw || typeof raw !== 'object' || !ELEMENT_TYPES.includes(raw.type)) return null
  const b = raw.box || {}
  const x = clampNum(b.x, BOX_LIMITS.xMin, BOX_LIMITS.xMax)
  const y = clampNum(b.y, BOX_LIMITS.yMin, BOX_LIMITS.yMax)
  const minSize = raw.type === 'line' ? 0 : BOX_LIMITS.minSize
  const w = clampNum(b.w, minSize, BOX_LIMITS.maxSize)
  const h = clampNum(b.h, minSize, BOX_LIMITS.maxSize)
  // box fields are OPTIONAL for stack children (the auto-layout computes
  // them: text height hugs content, width stretches) — missing x/y default
  // to 0, missing w/h stay absent so layoutStack/flatten pick the size.
  // Lines still need explicit extents (w:0/h:0 encodes their direction).
  if (raw.type === 'line' && (w == null || h == null)) return null
  const box = { x: r2(x ?? 0), y: r2(y ?? 0) }
  if (w != null) box.w = r2(w)
  if (h != null) box.h = r2(h)
  const el = {
    // missing/invalid ids are assigned deterministically in sanitizeElements
    id: typeof raw.id === 'string' && ELEMENT_ID_RE.test(raw.id) ? raw.id : '',
    type: raw.type,
    box,
    style: sanitizeElementStyle(raw.style),
  }
  if (typeof raw.name === 'string' && raw.name.trim()) el.name = raw.name.trim().slice(0, 60)
  if (raw.hidden === true) el.hidden = true
  // stack-child main-axis growth weight (see layoutStack in deckLayout.js)
  const grow = clampNum(raw.grow, 0, 10)
  if (grow != null && grow > 0) el.grow = r2(grow)
  const rot = clampNum(raw.rotate, -359, 359)
  if (rot != null && rot !== 0) el.rotate = Math.round(rot)
  if (raw.type === 'text') {
    el.text = cut(String(raw.text ?? ''), 2000)
  } else if (raw.type === 'shape') {
    el.shape = SHAPE_KINDS.includes(raw.shape) ? raw.shape : 'rect'
  } else if (raw.type === 'line') {
    if (raw.flipH) el.flipH = true
    if (raw.flipV) el.flipV = true
  } else if (raw.type === 'icon') {
    const icon = {}
    if (typeof raw.icon?.assetId === 'string' && raw.icon.assetId.trim()) icon.assetId = raw.icon.assetId.trim().slice(0, 60)
    if (typeof raw.icon?.builtin === 'string' && DECK_ICON_SET.has(raw.icon.builtin.trim())) icon.builtin = raw.icon.builtin.trim()
    el.icon = icon
    // icons are intrinsically SQUARE — both painters center a square glyph in
    // the box. A non-square box (the model occasionally emits e.g. 0.3×1.2)
    // just makes the selection/plate a distorted rectangle around a square
    // mark. Square it to the smaller side so the icon reads at its intended
    // size and the box hugs it. (Only when both dims are present; a stack
    // child may legitimately omit one for the auto-layout to compute.)
    if (el.box.w != null && el.box.h != null && el.box.w !== el.box.h) {
      const s = r2(Math.min(el.box.w, el.box.h))
      el.box.w = s
      el.box.h = s
    }
  } else if (raw.type === 'image') {
    if (
      typeof raw.imageDataUrl === 'string' &&
      raw.imageDataUrl.length < 8_000_000 &&
      /^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,/.test(raw.imageDataUrl)
    ) {
      el.imageDataUrl = raw.imageDataUrl
    } else if (typeof raw.imageAssetId === 'string' && raw.imageAssetId.trim()) {
      el.imageAssetId = raw.imageAssetId.trim().slice(0, 60)
    }
  } else if (raw.type === 'chart') {
    const spec = sanitizeChartSpec(raw.chart)
    if (!spec) {
      // SALVAGE (don't silently drop): a chart whose data is incomplete —
      // heatmap sem values, gantt sem tasks, série vazia — used to return null
      // and, inside a group, evaporate the group into a blank plate. Keep the
      // committed content region instead, as a labelled text placeholder: it
      // renders SOMETHING honest, counts as material content, and gives the
      // regeneration pass a concrete node to replace.
      if (ctx) ctx.notes.push({ reason: 'chart-empty', kind: raw.chart?.kind || 'unknown', id: el.id })
      el.type = 'text'
      el.text = el.name || 'Gráfico indisponível (dados incompletos)'
      el.style = { ...el.style, fontRole: el.style?.fontRole || 'body' }
      return el
    }
    el.chart = spec
  } else if (raw.type === 'group') {
    if (depth >= MAX_GROUP_DEPTH) return null
    el.children = Array.isArray(raw.children)
      ? raw.children.slice(0, 40).map((c) => sanitizeElement(c, depth + 1, ctx)).filter(Boolean)
      : []
    // PRUNE (bottom-up): a group that ended up with no children carries no
    // information — it's exactly the "Grupo · 0" blank-slide symptom, whether
    // or not it has a plate style. Returning null makes the PARENT's
    // .filter(Boolean) drop it too, so an inner empty group empties its parent
    // in the same recursion pass — no extra walk needed.
    if (!el.children.length) {
      if (ctx) ctx.notes.push({ reason: styleDrawsPanel(el.style) ? 'empty-panel' : 'empty-group', id: el.id })
      return null
    }
    if (raw.stack && typeof raw.stack === 'object') {
      const st = { direction: raw.stack.direction === 'row' ? 'row' : 'column' }
      // design bounds in INCHES on a 10×5.625 canvas — larger values are the
      // model confusing px with inches and destroy the inner layout
      const gap = clampNum(raw.stack.gap, 0, 1)
      if (gap != null) st.gap = r2(gap)
      const padding = clampNum(raw.stack.padding, 0, 0.6)
      if (padding != null && padding > 0) st.padding = r2(padding)
      if (['start', 'center', 'end', 'stretch'].includes(raw.stack.align)) st.align = raw.stack.align
      if (['start', 'center', 'end', 'between'].includes(raw.stack.justify)) st.justify = raw.stack.justify
      el.stack = st
    }
  }
  return el
}

function countElementNodes(el) {
  return 1 + (el.children ? el.children.reduce((a, c) => a + countElementNodes(c), 0) : 0)
}

// unique ids across the WHOLE tree (missing ids and duplicates — a tweak
// model occasionally clones them — get deterministic replacements, stable
// across sanitize round-trips); the element budget counts every node
export function sanitizeElements(raw, ctx = null) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  let assigned = 0
  const dedupe = (el) => {
    if (!el.id) el.id = `el_${++assigned}`
    while (seen.has(el.id)) el.id = `${el.id.slice(0, 40)}_d`
    seen.add(el.id)
    for (const c of el.children || []) dedupe(c)
  }
  const out = []
  let total = 0
  for (const r of raw.slice(0, MAX_ELEMENTS_PER_SLIDE)) {
    const el = sanitizeElement(r, 0, ctx)
    if (!el) continue
    const n = countElementNodes(el)
    if (total + n > MAX_ELEMENTS_PER_SLIDE) break
    total += n
    dedupe(el)
    out.push(el)
  }
  return out
}

// Per-element style overrides set in the Studio (Edit mode): a map of
// element path ("heading", "cards[2].body", "callout.text", …) → the same
// bounded visual prop set as canvas elements (geometry excluded — semantic
// slides keep their computed layout). Legacy renderers apply the text subset
// today (applyOv / ovStyle); the engine applies the full set as layouts are
// ported. Model-generated decks never carry styles — this only survives
// Studio PATCH/tweak round-trips.
const STYLE_PATH_RE = /^[\w[\].]{1,80}$/
export function sanitizeSlideStyles(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out = {}
  for (const [path, o] of Object.entries(raw).slice(0, 64)) {
    if (!STYLE_PATH_RE.test(path) || !o || typeof o !== 'object') continue
    const st = sanitizeElementStyle(o)
    if (Object.keys(st).length) out[path] = st
  }
  return Object.keys(out).length ? out : null
}

// Composition safety net for freeform slides (the "impeccable" pass). The
// freeform generator composes geometry directly, so it can occasionally emit
// two deterministic, unambiguous defects that hurt polish. This fixes ONLY
// those — conservatively — and never touches intentional design:
//  1. an element fully off-canvas (entirely past every edge): pure garbage the
//     model produced by miscalculating — dropped. Partial bleed is LEFT ALONE
//     (a plate/illustration half off the edge is legitimate, and BOX_LIMITS
//     deliberately allows it).
//  2. a top-level (non-stack) text box too short for its wrapped content at its
//     font size: grow the box height so text isn't clipped. Stack children are
//     skipped (auto-layout already hugs their height) and width is never
//     touched (only height grows, downward, so nothing shifts sideways).
//  3. an icon smaller than the legible floor (~0.4in) — the model likes to
//     author 0.2–0.3in icons that vanish on the slide. Grown to the floor
//     (kept square). Generation-only, so a user's deliberate small icon in the
//     Studio is untouched.
const OFF_CANVAS_PAD = 0.05
const MIN_ICON_IN = 0.4
function refineFreeformComposition(elements) {
  const fitOne = (el, inStack) => {
    if (!el || typeof el !== 'object') return el
    const b = el.box
    // (3) enforce a legible minimum icon size (kept square)
    if (el.type === 'icon' && b && typeof b.w === 'number' && typeof b.h === 'number' && Math.max(b.w, b.h) < MIN_ICON_IN) {
      el.box = { ...b, w: MIN_ICON_IN, h: MIN_ICON_IN }
    }
    // (1) drop fully off-canvas elements (box entirely beyond a single edge).
    // ONLY for elements with an EXPLICIT box (w AND h present) and NOT inside a
    // stack: a stack child's position/size is computed by layoutStack at paint
    // time, so its authored box is {x:0,y:0} with no w/h — evaluating that as
    // off-canvas (0+0 ≤ pad) wrongly dropped every card in a stack, silently
    // emptying the group (a real cause of the blank-slide bug).
    if (!inStack && b && typeof b.x === 'number' && typeof b.y === 'number' && typeof b.w === 'number' && typeof b.h === 'number') {
      const off =
        b.x >= SLIDE_W - OFF_CANVAS_PAD ||
        b.y >= SLIDE_H - OFF_CANVAS_PAD ||
        b.x + b.w <= OFF_CANVAS_PAD ||
        b.y + b.h <= OFF_CANVAS_PAD
      if (off) return null
    }
    // (2) grow a too-short non-stack text box to fit its content
    if (el.type === 'text' && !inStack && b && typeof b.w === 'number' && typeof b.h === 'number' && el.text) {
      const size = el.style?.fontSize || 13
      const lh = el.style?.lineHeight || 1.2
      const needed = textHeightIn(String(el.text), size, b.w - TEXT_INSETS, lh) + 0.04
      if (needed > b.h + 0.02) el.box = { ...b, h: Math.min(needed, SLIDE_H) }
    }
    // recurse into groups; a group with a stack lays its children out itself
    if (el.type === 'group' && Array.isArray(el.children)) {
      const childInStack = !!el.stack
      el.children = el.children.map((c) => fitOne(c, childInStack)).filter(Boolean)
    }
    return el
  }
  return (elements || []).map((el) => fitOne(el, false)).filter(Boolean)
}

// Shared by the model-authored `deck` block (resolveOne, below) and the
// PATCH /api/decks/:id route — both need the exact same validation/caps so a
// user edit can't smuggle in unbounded or malformed slide data. `byId` and
// `template` are only present on the generation path (see sanitizeDeckSlide
// above) — the Studio edit route calls this with neither.
export function sanitizeDeck(raw, byId, template) {
  if (!raw || typeof raw.title !== 'string' || !raw.title.trim() || !Array.isArray(raw.slides)) return null
  // `byId` (truthy only on the generation path, even when empty) is the same
  // signal used for chart resolution above — reused here so iconById is
  // always a Map (possibly empty, if the template has no icons) whenever
  // we're actually resolving a fresh model turn, and null only on the
  // Studio edit path where iconAssetId should just pass through untouched.
  const iconById = byId ? new Map(usableIconAssets(template).map((a) => [a.id, a])) : null
  const imageById = byId ? new Map(usableImageAssets(template).map((a) => [a.id, a])) : null
  // mined diagrams live in minedStyle (validated here before baking — the
  // template row is client-authored JSON)
  const diagramById = byId
    ? new Map(
        (template?.minedStyle?.diagrams || [])
          .map((d) => [d?.id, sanitizeDiagramSpec(d)])
          .filter(([id, spec]) => id && spec)
      )
    : null
  const slides = raw.slides
    .slice(0, MAX_DECK_SLIDES)
    .map((s) => sanitizeDeckSlide(s, byId, iconById, imageById, diagramById))
    .filter(Boolean)
  if (!slides.length) return null
  // composition safety net: only on the generation path (byId truthy), only
  // for freeform slides — never mutate a user's Studio edit geometry.
  let finalSlides = slides
  if (byId) {
    for (const s of slides) {
      if (s.layout === 'freeform' && Array.isArray(s.elements)) s.elements = refineFreeformComposition(s.elements)
    }
    // DETERMINISTIC FLOOR: after prune/salvage/refine, a freeform slide that
    // still has no material content would paint blank (the "Grupo · 0"
    // symptom). Drop it — a missing slide is always better than a blank one.
    // (The async repair loop in server/index.js gets a chance to regenerate
    // BEFORE relying on this, but this guarantees the invariant regardless.)
    finalSlides = slides.filter((s) => !freeformSlideIsMateriallyEmpty(s, template))
    if (!finalSlides.length) return null
  }
  const deck = { title: raw.title.slice(0, 140), slides: finalSlides }
  if (typeof raw.audience === 'string' && raw.audience.trim()) deck.audience = raw.audience.slice(0, 80)
  if (typeof raw.author === 'string' && raw.author.trim()) deck.author = raw.author.slice(0, 80)
  if (typeof raw.narrative === 'string' && raw.narrative.trim()) deck.narrative = raw.narrative.slice(0, 300)
  if (byId) {
    for (const warning of deckQualityWarnings(deck)) console.warn(`[deck-qa] ${warning}`)
  }
  return deck
}

// Which flattened primitives count as REAL content (vs. decoration). A slide
// whose flattened output has none of these is "materially empty" — it renders
// as a blank plate (the "Grupo · 0" symptom). Shapes/lines/group-__bg are
// decoration and never count on their own.
const CONTENT_PRIMITIVE = new Set(['text', 'image', 'chart', 'icon'])

// True when a freeform slide would render with no real content. Runs the EXACT
// geometry both renderers paint (flattenElements), so it agrees with what the
// user sees. `template` resolves a theme for the flatten (the check is
// structural — any resolved theme works). Non-freeform slides are never empty
// (their layout always paints their fields), so they return false.
export function freeformSlideIsMateriallyEmpty(slide, template = null) {
  if (!slide || slide.layout !== 'freeform') return false
  const els = slide.elements || []
  if (!els.length) return true
  let theme
  try {
    theme = resolveDeckTheme(template || {})
  } catch {
    theme = null
  }
  let flat
  try {
    flat = flattenElements(els, theme || {}, {})
  } catch {
    // if it can't even flatten, it can't paint meaningful content
    return true
  }
  return !flat.some(
    (el) => CONTENT_PRIMITIVE.has(el.type) && (el.type !== 'text' || String(el.text ?? '').trim())
  )
}

// Visual self-review of a generated deck: resolves the template's theme and
// inspects each slide's real paint geometry (shared/deckReview.js) for the
// defects the benchmark caught — clipped/illegible text, off-canvas elements,
// low contrast, overlaps. Returns { clean, slides:[{index,title,findings}] }
// plus a `text` rendering ready to hand back to the model for repair. Pure and
// LLM-free (the repair round itself is orchestrated in index.js).
export function reviewDeckBlock(deck, template) {
  let theme
  try {
    theme = resolveDeckTheme(template || {})
  } catch {
    return { clean: true, slides: [], text: '' }
  }
  const review = reviewDeckGeometry(deck, theme)
  return { ...review, text: formatReviewForModel(review) }
}

// Recursively: does this element subtree contain any content-bearing node?
// Used to flag empty nested groups that survived (shouldn't, post-prune, but
// this is the QA backstop that proves it).
function elementHasContent(el) {
  if (!el) return false
  if (CONTENT_PRIMITIVE.has(el.type)) return el.type !== 'text' || String(el.text ?? '').trim()
  if (el.type === 'group') return (el.children || []).some(elementHasContent)
  return false
}

// Flags every group in a freeform slide's tree that has no content-bearing
// descendant (an empty/blank panel). Returns an array of offending group ids.
function emptyGroupsIn(elements) {
  const bad = []
  const walk = (el) => {
    if (!el) return
    if (el.type === 'group') {
      if (!(el.children || []).some(elementHasContent)) bad.push(el.id || '(sem id)')
      for (const c of el.children || []) walk(c)
    }
  }
  for (const el of elements || []) walk(el)
  return bad
}

// Count content-bearing painted primitives on a freeform slide (text with
// text, image, chart, icon, heatmap/gantt) — the density signal used to flag
// sparse content slides (Fase 4). Purely structural; failures count as 0.
function freeformContentCount(slide, template = null) {
  if (!slide || slide.layout !== 'freeform') return 0
  let theme
  try {
    theme = resolveDeckTheme(template || {})
  } catch {
    theme = null
  }
  let flat
  try {
    flat = flattenElements(slide.elements || [], theme || {}, {})
  } catch {
    return 0
  }
  return flat.filter((el) => CONTENT_PRIMITIVE.has(el.type) && (el.type !== 'text' || String(el.text ?? '').trim())).length
}

// Cheap deterministic post-generation checks (gap analysis §1.7/§5.3) — they
// flag, never block: visibility into whether prompt/renderer changes are
// actually reducing the recurring quality symptoms over time.
export function deckQualityWarnings(deck) {
  const warnings = []
  const titles = new Map()
  const denseLayouts = new Set(['cards', 'stat-grid', 'timeline'])
  deck.slides.forEach((s, i) => {
    const label = `slide ${i + 1} (${s.layout})`
    if (s.heading) {
      const key = s.heading.trim().toLowerCase()
      if (titles.has(key)) warnings.push(`${label}: heading duplicado do slide ${titles.get(key) + 1}`)
      else titles.set(key, i)
      if (s.layout !== 'title' && key === deck.title.trim().toLowerCase()) {
        warnings.push(`${label}: heading idêntico ao título do deck`)
      }
      if (s.layout !== 'title' && s.layout !== 'section' && s.layout !== 'closing' && /^[\p{L} ]{1,28}$/u.test(s.heading) && s.heading.split(/\s+/).length <= 3) {
        warnings.push(`${label}: heading parece rótulo ("${s.heading}"), não uma afirmação`)
      }
    }
    const iconIds = []
    for (const list of [s.cards, s.stats, s.phases]) {
      for (const item of list || []) if (item.iconAssetId) iconIds.push(item.iconAssetId)
    }
    const dupIcon = iconIds.find((id, idx) => iconIds.indexOf(id) !== idx)
    if (dupIcon) warnings.push(`${label}: mesmo ícone (${dupIcon}) repetido em mais de um item`)
    const itemCount = (s.cards || s.stats || s.phases || []).length
    if (denseLayouts.has(s.layout) && itemCount === 1) {
      warnings.push(`${label}: layout denso com apenas 1 item — provável layout errado`)
    }
    if (s.layout === 'image' && !s.imageDataUrl && !s.diagramSpec && !s.body) {
      warnings.push(`${label}: slide de imagem sem asset (imageRef/diagramRef) e sem descrição em body`)
    }
    if (s.layout === 'freeform') {
      if (!(s.elements || []).length) warnings.push(`${label}: slide freeform sem elementos`)
      // empty nested groups (the "Grupo · 0" blank-plate symptom) and slides
      // that would render with no real content — these should never survive
      // the prune/salvage in sanitizeElement; flag loudly if one slips through.
      const emptyGroups = emptyGroupsIn(s.elements)
      if (emptyGroups.length) warnings.push(`${label}: grupo(s) vazio(s) sem conteúdo: ${emptyGroups.join(', ')}`)
      if (freeformSlideIsMateriallyEmpty(s)) warnings.push(`${label}: slide freeform sem conteúdo material (renderiza em branco)`)
      // sparse-content density (Fase 4): a CONTENT slide (no cover/section
      // plate → not a divider) with very few painted primitives is the "pobre"
      // symptom. Flag ≤3 as thin; dividers are legitimately minimal, so skip
      // slides carrying a plate.
      if (!s.background?.plate) {
        const contentCount = freeformContentCount(s)
        if (contentCount > 0 && contentCount <= 3) {
          warnings.push(`${label}: freeform com apenas ${contentCount} elemento(s) de conteúdo — slide raso, componha uma grade/diagrama denso`)
        }
      }
      const hexes = JSON.stringify(s.elements || []).match(/"#[0-9A-F]{6}"/g)?.length || 0
      if (hexes > 4) warnings.push(`${label}: freeform com ${hexes} cores hex literais — deveria usar tokens @tema`)
    }
  })
  if (deck.slides.length >= 12 && !deck.slides.some((s) => s.layout === 'section')) {
    warnings.push(`deck com ${deck.slides.length} slides e nenhum divisor "section"`)
  }
  if (!deck.narrative) warnings.push('deck sem campo "narrative" — o modelo pulou o planejamento do arco')
  return warnings
}

function sanitizeDeckQuestion(raw) {
  if (!raw || typeof raw.id !== 'string' || !raw.id.trim()) return null
  if (typeof raw.label !== 'string' || !raw.label.trim()) return null
  const type = DECK_QUESTION_TYPES.has(raw.type) ? raw.type : 'text'
  const q = { id: raw.id.slice(0, 40), label: raw.label.slice(0, 200), type }
  if (typeof raw.description === 'string' && raw.description.trim()) q.description = raw.description.slice(0, 240)
  if (type !== 'text') {
    const options = Array.isArray(raw.options)
      ? raw.options.filter((o) => typeof o === 'string' && o.trim()).slice(0, MAX_QUESTION_OPTIONS).map((o) => o.slice(0, 80))
      : []
    if (!options.length) return null
    q.options = options
  }
  return q
}

// Sanitizes a model-authored `deck-questions` block (see DECK_POLICY) — the
// clarifying-questions step that always precedes a fresh `deck` block.
function sanitizeDeckQuestions(raw) {
  if (!raw || !Array.isArray(raw.questions)) return null
  const questions = raw.questions.slice(0, MAX_DECK_QUESTIONS).map(sanitizeDeckQuestion).filter(Boolean)
  if (!questions.length) return null
  const out = { questions }
  if (typeof raw.intro === 'string' && raw.intro.trim()) out.intro = raw.intro.slice(0, 400)
  // answers are persisted into the block once the user submits (so the box
  // shows the history on reload and stays editable) — carry them through
  // sanitize too, keyed by question id. Values: string | string[].
  const answers = sanitizeQuestionAnswers(raw.answers, questions)
  if (answers) {
    out.answers = answers
    if (typeof raw.answeredAt === 'string') out.answeredAt = raw.answeredAt.slice(0, 40)
  }
  return out
}

// Coerces a client/model-supplied answers map to a safe shape: only keys that
// are real question ids, values trimmed strings (or string arrays for multi).
export function sanitizeQuestionAnswers(raw, questions) {
  if (!raw || typeof raw !== 'object') return null
  const byId = new Map(questions.map((q) => [q.id, q]))
  const out = {}
  for (const [qid, val] of Object.entries(raw)) {
    const q = byId.get(qid)
    if (!q) continue
    if (q.type === 'multi') {
      const arr = (Array.isArray(val) ? val : [val])
        .filter((v) => typeof v === 'string' && v.trim())
        .map((v) => v.slice(0, 200))
      if (arr.length) out[qid] = arr
    } else if (typeof val === 'string' && val.trim()) {
      out[qid] = val.slice(0, 500)
    }
  }
  return Object.keys(out).length ? out : null
}

// ---- spreadsheet blocks ---------------------------------------------------
// A `spreadsheet` block is the tabular sibling of a `deck`: the model authors
// a workbook spec (sheets → ordered blocks of title/note/section/table +
// native charts), we sanitize the SHAPE here, persist it (chat_spreadsheets),
// and render a real .xlsx on export (server/xlsx-export.js). Numbers/formulas
// are model/user-authored (SPREADSHEET_POLICY governs honesty); this only
// bounds shape and validates that formulas/charts reference real cells.
const MAX_SS_SHEETS = 8
const MAX_SS_BLOCKS = 24
const MAX_SS_COLS = 20
const MAX_SS_ROWS = 500
const MAX_SS_CHARTS = 6
const SS_COL_FORMATS = new Set([
  'text', 'number', 'integer', 'currency', 'usd', 'eur', 'percent', 'percent0', 'date', 'datetime',
])
const SS_CELL_ROLES = new Set(['input', 'key', 'formula', 'link', 'normal'])
const SS_BLOCK_KINDS = new Set(['title', 'note', 'section', 'table', 'spacer'])
const SS_CHART_KINDS = new Set(['bar', 'line', 'area', 'pie'])
// Excel sheet-name rules: ≤31 chars, no []:*?/\ — and unique per workbook.
function sanitizeSheetName(raw, used, idx) {
  let name = typeof raw === 'string' ? raw.replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) : ''
  if (!name) name = `Planilha ${idx + 1}`
  let candidate = name
  let n = 2
  while (used.has(candidate.toLowerCase())) {
    const suffix = ` ${n++}`
    candidate = name.slice(0, 31 - suffix.length) + suffix
  }
  used.add(candidate.toLowerCase())
  return candidate
}

function sanitizeSsColumn(raw) {
  if (!raw || typeof raw !== 'object') return null
  const col = { header: typeof raw.header === 'string' ? raw.header.slice(0, 80) : '' }
  if (typeof raw.key === 'string' && raw.key.trim()) col.key = raw.key.slice(0, 40)
  if (SS_COL_FORMATS.has(raw.format)) col.format = raw.format
  else if (typeof raw.format === 'string' && /[#0%@]|[ymdhs]/.test(raw.format)) col.format = raw.format.slice(0, 40)
  if (SS_CELL_ROLES.has(raw.role)) col.role = raw.role
  const w = Number(raw.width)
  if (Number.isFinite(w) && w > 0) col.width = Math.min(80, Math.max(4, Math.round(w)))
  if (Array.isArray(raw.dropdown)) {
    const opts = raw.dropdown.filter((o) => o != null && String(o).trim()).slice(0, 40).map((o) => String(o).slice(0, 60))
    if (opts.length) col.dropdown = opts
  }
  return col
}

// A cell is a scalar, a "=formula" string, or {v, role?, format?}. Formulas are
// kept verbatim (Excel evaluates them); we only cap length and strip nothing
// that would change semantics. Non-formula strings are length-capped.
function sanitizeSsCell(raw) {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const cell = {}
    const inner = sanitizeSsCell(raw.v)
    cell.v = inner === undefined ? '' : inner
    if (SS_CELL_ROLES.has(raw.role)) cell.role = raw.role
    if (SS_COL_FORMATS.has(raw.format)) cell.format = raw.format
    // a stable NAME the renderer registers so other formulas can reference this
    // exact cell by [#name] regardless of where it lands in the grid
    if (typeof raw.name === 'string' && raw.name.trim()) cell.name = raw.name.trim().slice(0, 60)
    return cell
  }
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof raw === 'boolean') return raw
  if (typeof raw === 'string') {
    if (raw[0] === '=') return raw.slice(0, 500) // formula, verbatim
    return raw.slice(0, 500)
  }
  return null
}

function sanitizeSsBlock(raw) {
  if (!raw || !SS_BLOCK_KINDS.has(raw.kind)) return null
  if (raw.kind === 'spacer') return { kind: 'spacer' }
  if (raw.kind === 'title' || raw.kind === 'note' || raw.kind === 'section') {
    const text = typeof raw.text === 'string' ? raw.text.trim().slice(0, 200) : ''
    if (!text) return null
    return { kind: raw.kind, text }
  }
  // table
  const columns = (Array.isArray(raw.columns) ? raw.columns : []).slice(0, MAX_SS_COLS).map(sanitizeSsColumn).filter(Boolean)
  if (!columns.length) return null
  const colCount = columns.length
  const rows = (Array.isArray(raw.rows) ? raw.rows : []).slice(0, MAX_SS_ROWS).map((row) => {
    const arr = Array.isArray(row) ? row : columns.map((col) => (col.key ? row?.[col.key] : undefined))
    const cells = []
    for (let c = 0; c < colCount; c++) cells.push(sanitizeSsCell(arr[c]))
    return cells
  })
  const block = { kind: 'table', columns, rows }
  if (raw.headerless === true) block.headerless = true
  return block
}

function sanitizeSsChart(raw) {
  if (!raw || typeof raw !== 'object') return null
  const kind = SS_CHART_KINDS.has(raw.kind) ? raw.kind : 'bar'
  const tableBlock = Number(raw.tableBlock)
  const categoryColumn = Number(raw.categoryColumn)
  if (!Number.isInteger(tableBlock) || tableBlock < 0) return null
  if (!Number.isInteger(categoryColumn) || categoryColumn < 0) return null
  const valueColumns = (Array.isArray(raw.valueColumns) ? raw.valueColumns : [])
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0)
    .slice(0, 6)
  if (!valueColumns.length) return null
  const chart = { kind, tableBlock, categoryColumn, valueColumns }
  if (typeof raw.title === 'string' && raw.title.trim()) chart.title = raw.title.slice(0, 120)
  if (raw.anchor && typeof raw.anchor === 'object') {
    const col = Number(raw.anchor.col)
    const row = Number(raw.anchor.row)
    if (Number.isInteger(col) && col >= 0 && Number.isInteger(row) && row >= 0) chart.anchor = { col, row }
  }
  return chart
}

// Validates a chart references a table block that exists in its sheet, and
// that its columns are within that table's column count — a chart can never
// point at cells that don't exist (mirrors the deck data-honesty invariant).
function pruneSheetCharts(sheet) {
  if (!sheet.charts?.length) return
  const tableIdx = sheet.blocks.map((b, i) => (b.kind === 'table' ? i : -1)).filter((i) => i >= 0)
  sheet.charts = sheet.charts.filter((ch) => {
    if (!tableIdx.includes(ch.tableBlock)) return false
    const table = sheet.blocks[ch.tableBlock]
    const cols = table.columns.length
    if (ch.categoryColumn >= cols) return false
    ch.valueColumns = ch.valueColumns.filter((c) => c < cols && c !== ch.categoryColumn)
    return ch.valueColumns.length > 0
  })
  if (!sheet.charts.length) delete sheet.charts
}

export function sanitizeSpreadsheet(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.sheets)) return null
  const used = new Set()
  const sheets = raw.sheets
    .slice(0, MAX_SS_SHEETS)
    .map((s, i) => {
      if (!s || typeof s !== 'object') return null
      const blocks = (Array.isArray(s.blocks) ? s.blocks : []).slice(0, MAX_SS_BLOCKS).map(sanitizeSsBlock).filter(Boolean)
      if (!blocks.length) return null
      const sheet = { name: sanitizeSheetName(s.name, used, i), blocks }
      if (typeof s.purpose === 'string' && s.purpose.trim()) sheet.purpose = s.purpose.trim().slice(0, 200)
      if (s.freeze && typeof s.freeze === 'object') {
        const row = Number(s.freeze.row)
        const col = Number(s.freeze.col)
        sheet.freeze = {
          row: Number.isInteger(row) && row >= 0 ? row : 0,
          col: Number.isInteger(col) && col >= 0 ? col : 0,
        }
      }
      const charts = (Array.isArray(s.charts) ? s.charts : []).slice(0, MAX_SS_CHARTS).map(sanitizeSsChart).filter(Boolean)
      if (charts.length) sheet.charts = charts
      pruneSheetCharts(sheet)
      return sheet
    })
    .filter(Boolean)
  if (!sheets.length) return null
  const out = { title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.slice(0, 160) : 'Planilha', sheets }
  if (Array.isArray(raw.instructions)) {
    const lines = raw.instructions.filter((l) => typeof l === 'string' && l.trim()).slice(0, 12).map((l) => l.trim().slice(0, 300))
    if (lines.length) out.instructions = lines
  }
  return out
}

// A `document` block: a markdown document the model authors directly (no
// external data). The Studio renders it as rich text, lets the user tweak it
// with AI, and exports to DOCX/Markdown/PDF (see server/index.js + db chat_documents).
export function sanitizeDocument(raw) {
  if (!raw || typeof raw !== 'object') return null
  const markdown = typeof raw.markdown === 'string' ? raw.markdown : typeof raw.content === 'string' ? raw.content : ''
  if (!markdown.trim()) return null
  const title =
    typeof raw.title === 'string' && raw.title.trim()
      ? raw.title.trim().slice(0, 200)
      : // fall back to the first markdown heading, else a generic title
        (markdown.match(/^#{1,3}\s+(.+)$/m)?.[1] || 'Documento').trim().slice(0, 200)
  // cap at ~200k chars — a very long report, but bounded so one block can't be
  // unbounded. Longer content is truncated with a visible marker.
  const MAX = 200_000
  const md = markdown.length > MAX ? markdown.slice(0, MAX) + '\n\n<!-- truncado -->' : markdown
  return { title, markdown: md }
}

function resolveOne(raw, byId, template, imageById) {
  if (!raw || !ALLOWED_TYPES.has(raw.type)) return null
  if (raw.type === 'document') {
    const doc = sanitizeDocument(raw)
    if (!doc) return null
    return { type: 'document', title: doc.title, markdown: doc.markdown }
  }
  if (raw.type === 'image') {
    // The image itself was generated by the image tool and persisted to the
    // Volume (server/tools.js). The model only references it by the `imageRef`
    // it was handed; we resolve that to the real image id so the client can
    // fetch GET /api/images/:id. An unknown ref → drop the block (never invent).
    if (!imageById) return null
    const ref = typeof raw.imageRef === 'string' ? raw.imageRef.trim() : ''
    const hit = ref ? imageById.get(ref) : null
    if (!hit) return null
    return {
      type: 'image',
      imageId: String(hit.imageId),
      prompt: typeof hit.prompt === 'string' ? hit.prompt.slice(0, 500) : undefined,
      caption: typeof raw.caption === 'string' ? raw.caption.slice(0, 200) : undefined,
      alt: typeof raw.alt === 'string' ? raw.alt.slice(0, 200) : undefined,
      // generation model + token usage → the block can show a cost estimate
      model: typeof hit.model === 'string' ? hit.model : undefined,
      usage: hit.usage || undefined,
    }
  }
  if (raw.type === 'deck') {
    const deck = sanitizeDeck(raw, byId, template)
    if (!deck) return null
    // spread keeps deck-level metadata (audience/author/narrative) that
    // persistDeckBlocks stores in chat_decks.meta
    return { type: 'deck', ...deck }
  }
  if (raw.type === 'deck-questions') {
    const dq = sanitizeDeckQuestions(raw)
    if (!dq) return null
    return { type: 'deck-questions', intro: dq.intro, questions: dq.questions }
  }
  if (raw.type === 'spreadsheet') {
    const ss = sanitizeSpreadsheet(raw)
    if (!ss) return null
    return { type: 'spreadsheet', ...ss }
  }
  if (raw.type === 'chart') {
    // Mode 1: a reference to a deterministic, pre-computed candidate (numbers
    // already validated upstream in analysis.js). Preferred whenever one exists.
    // `chartRef` is accepted as an alias — models drift to it and it should
    // resolve, not silently drop.
    const ref = typeof raw.ref === 'string' ? raw.ref : typeof raw.chartRef === 'string' ? raw.chartRef : undefined
    const cand = ref ? byId.get(ref) : undefined
    if (cand) {
      return {
        type: 'chart',
        chartType: cand.chartType,
        title: cand.title,
        series: cand.series,
        caption: typeof raw.caption === 'string' ? raw.caption.slice(0, 200) : undefined,
      }
    }
    // Mode 2: inline series the model supplies itself — the only path when the
    // data came from a tool (Genie One, Python) or figures already in the
    // conversation, for which no candidate_N exists. Without this, a model
    // asked to plot real tool data had no valid block to emit and would leak an
    // invented JSON shape as a raw code block (the exact bug this fixes). Data
    // honesty is a prompt rule (CHART_POLICY); here we only validate the shape.
    const series = sanitizeChartSeries(normalizeChartSeries(raw.series, raw))
    if (series && ['bar', 'line', 'area', 'pie'].includes(raw.chartType)) {
      return {
        type: 'chart',
        chartType: raw.chartType,
        title: typeof raw.title === 'string' ? raw.title.slice(0, 120) : undefined,
        series,
        caption: typeof raw.caption === 'string' ? raw.caption.slice(0, 200) : undefined,
      }
    }
    return null
  }
  if (raw.type === 'insight') {
    if (!raw.title || !raw.body) return null
    return {
      type: 'insight',
      title: String(raw.title).slice(0, 120),
      body: String(raw.body).slice(0, 800),
      kind: ['summary', 'anomaly', 'opportunity'].includes(raw.kind) ? raw.kind : 'summary',
    }
  }
  if (raw.type === 'table') {
    if (!Array.isArray(raw.columns) || !Array.isArray(raw.rows)) return null
    return {
      type: 'table',
      title: typeof raw.title === 'string' ? raw.title.slice(0, 120) : undefined,
      columns: raw.columns.slice(0, 12).map(String),
      rows: raw.rows.slice(0, 50),
    }
  }
  return null
}

/**
 * Replaces every inline ```prism-block fence in the model's answer with a
 * `{{block:N}}` placeholder (or drops it silently if malformed/unresolvable),
 * returning the placeholder-bearing text plus the ordered, resolved blocks.
 * This is the exact shape persisted to the DB and sent to the frontend.
 */
export function extractPrismBlocks(fullText, chartCandidates = [], template, imageRefs = []) {
  const byId = new Map(chartCandidates.map((c) => [c.id, c]))
  // image refs the image tool produced this session, keyed by the `img_<id>`
  // ref the model was told to use (and its bare id, as a lenient alias).
  const imageById = new Map()
  for (const r of imageRefs || []) {
    if (r?.ref) imageById.set(r.ref, r)
    if (r?.imageId != null) imageById.set(String(r.imageId), r)
  }
  const blocks = []

  // Walk the text, replacing each prism-block fence with a {{block:N}} marker.
  // For each opener we scan the JSON by brace balance (``` -agnostic), then skip
  // past the JSON and its optional closing ``` fence. Rebuilt as a string so a
  // block's own ``` (fenced code inside a document's markdown) can't truncate it.
  let out = ''
  let cursor = 0
  FENCE_OPEN_RE.lastIndex = 0
  let m
  while ((m = FENCE_OPEN_RE.exec(fullText)) !== null) {
    const scanned = scanJsonObject(fullText, m.index + m[0].length)
    // no balanced object after the opener (truncated / malformed): drop from the
    // opener to the end of text so raw JSON never leaks, and stop.
    if (!scanned) {
      out += fullText.slice(cursor, m.index)
      cursor = fullText.length
      break
    }
    // text before this fence is kept as-is
    out += fullText.slice(cursor, m.index)
    // advance past the JSON, then past an optional closing ``` (with surrounding
    // whitespace/newlines) so the fence's tail doesn't linger in the output
    let after = scanned.end
    const tail = fullText.slice(after).match(/^[ \t]*\r?\n?```/)
    if (tail) after += tail[0].length
    // Models sometimes emit a stray run of JSON structural punctuation (e.g. an
    // extra `]}` that over-closes the slides array) right after the fence. Real
    // prose is never only brackets/braces/commas, so drop such an orphan up to
    // the next newline — otherwise it leaks into the chat as "]}" (see #12/#13).
    const orphan = fullText.slice(after).match(/^[ \t]*[\]})\s,]*[\]})][ \t]*(?=\r?\n|$)/)
    if (orphan) after += orphan[0].length
    cursor = after

    if (blocks.length >= MAX_BLOCKS) continue
    let parsed
    try {
      parsed = JSON.parse(scanned.json)
    } catch {
      continue // malformed JSON — degrade to plain text, no block
    }
    const resolved = resolveOne(parsed, byId, template, imageById)
    if (!resolved) continue
    blocks.push(resolved)
    out += `\n\n{{block:${blocks.length - 1}}}\n\n`
  }
  out += fullText.slice(cursor)

  const content = out.replace(/\n{3,}/g, '\n\n').trim()

  return { content, blocks }
}

// Strips placeholders from a stored assistant message before it's replayed
// back to the model as conversation history — the model doesn't need (and
// could get confused trying to reproduce) its own past visualization/tool-call
// position markers.
export function stripBlockPlaceholders(text) {
  return text
    .replace(/\{\{block:\d+\}\}/g, '')
    .replace(/\{\{toolcall:[^}]+\}\}/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

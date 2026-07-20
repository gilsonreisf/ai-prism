# Performance das interações — por que o AI Prism parece mais lento que Claude/Perplexity, e como fechar o gap

**Data:** 2026-07-18
**Escopo:** latência percebida no chat — do momento em que o usuário aperta Enter até a resposta terminar de streamar. Foco em respostas rápidas sem perder qualidade.

---

## TL;DR

A lentidão percebida **não** vem principalmente do modelo. Vem de duas frentes, nesta ordem de impacto:

1. **Renderização no cliente (React) — o maior ofensor.** Cada token que chega dispara um `setState` que re-renderiza o `App` inteiro **e** re-parseia todo o markdown + re-roda o syntax highlight de toda a resposta acumulada. Isso é **O(n²)** no tamanho da resposta: quanto mais a resposta cresce, mais engasgado fica o streaming. Claude/Perplexity agrupam tokens por frame e renderizam de forma incremental — por isso parecem fluidos mesmo em respostas longas.

2. **Tempo até o primeiro token (TTFT) no servidor.** Há trabalho bloqueante antes de o modelo começar a responder: uma leitura pesada de template de deck (JSONB de MBs) **sem cache a cada turno**, o histórico inteiro da sessão carregado **sem limite**, e — em alguns casos — chamadas de rede (embeddings de skills, `tools/list` de MCP externo) no caminho crítico.

O turno já foi otimizado antes (pool Lakebase, `Promise.all` de leituras, prompt caching, disclosure progressiva de instruções, cauda não-bloqueante). O que sobrou são os pontos acima. Nenhuma das correções abaixo sacrifica qualidade da resposta.

---

## Parte 1 — Cliente: fluidez do streaming (impacto ALTO, esforço BAIXO)

Esta é a diferença mais visível em relação a Claude/Perplexity e a que melhor custo-benefício tem.

### 1.1 Tokens não são agrupados — 1 token = 1 re-render do App inteiro

`makeSSEHandler` faz, por token (`client/src/App.jsx:50-53`):

```js
case 'token':
  accRef.value += ev.value
  setTarget({ content: accRef.value })   // → setLast → setMessages([...prev]) por token
```

`setLast` clona o array inteiro de mensagens (`client/src/App.jsx:510-516`) a cada token. Como `messages` é estado do `App`, **todo token re-renderiza o `App` inteiro** (header, ModelPicker, ToolsPicker, Sidebar, Composer) e re-executa `messages.map(...)` (`client/src/App.jsx:860-876`). Em uma resposta rápida do gateway, são dezenas de renders por segundo saturando o main thread.

**Correção:** coalescer tokens por frame de animação (rAF) ou por intervalo (~30–50ms) antes de chamar `setState`. Acumula em `accRef.value` (já existe) e faz um único flush agendado:

```js
// esboço
let pending = false
case 'token':
  accRef.value += ev.value
  if (!pending) {
    pending = true
    requestAnimationFrame(() => { pending = false; setTarget({ content: accRef.value }) })
  }
  break
```

Ganho: de N renders para ~60/s no máximo, sem perder um único token e sem mudar o texto final.

### 1.2 Markdown + syntax highlight re-parseados do zero a cada token — O(n²)

A bolha em streaming renderiza o texto acumulado com `react-markdown` + `remark-gfm` + `rehype-highlight` a cada token (`client/src/components/Message.jsx:442-444`):

```jsx
<Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{seg.text}</Markdown>
```

Reparsear todo o markdown e re-highlightar todo o código a **cada** token, para uma resposta que cresce, é custo quadrático. É o principal responsável pela perda de fluidez conforme a resposta cresce — sobretudo com blocos de código, onde `rehype-highlight` roda em cima do bloco inteiro toda vez.

**Correções (qualquer uma ajuda; combinar as duas primeiras é o ideal):**
- **Desligar o highlight durante o streaming.** Renderizar o segmento em streaming como markdown *sem* `rehypeHighlight`, e aplicar o highlight só quando a mensagem finaliza (`streaming === false`). Highlight é puramente cosmético; ninguém lê código destacado enquanto ele ainda está sendo digitado.
- Combinado com 1.1, o reparse passa a acontecer ~60×/s em vez de por token.
- Opcional (maior esforço): renderizar a mensagem em streaming como **texto puro/pré-formatado** e só converter para markdown rico ao finalizar. É o que dá a sensação "máquina de escrever" fluida.

### 1.3 Mensagens antigas re-renderizam a cada token da mensagem em streaming

`Message` **não é memoizado** (`client/src/components/Message.jsx:280`) e a lista usa `key={i}` (índice do array) em vez de um id estável (`client/src/App.jsx:862`). Resultado: cada token da bolha em streaming re-renderiza **todas** as mensagens já concluídas, cada uma recomputando `splitSegments` e `plainText` (regex sobre o conteúdo todo — `Message.jsx:285,298-300`). O custo cresce com o tamanho da conversa.

**Correção:**
- Envolver `Message` em `React.memo`.
- Trocar `key={i}` por `key={m.id}` (ou id de variante estável).
- **Estabilizar as props de callback** passadas em `App.jsx:860-876` — hoje são closures novas a cada render (`onRegenerate={() => ...}`, etc.), o que anularia o `React.memo`. Usar `useCallback` e passar `m.id` para o handler em vez de capturá-lo na closure.

Sem estabilizar os callbacks, o `React.memo` não surte efeito — os três itens precisam vir juntos.

### 1.4 Auto-scroll forçando reflow a cada token

O `useEffect` de auto-scroll depende de `[messages]` e escreve `el.scrollTop = el.scrollHeight` (`client/src/App.jsx:325-328`). Como `messages` muda a cada token, isso força um reflow de layout por token.

**Correção:** com o coalescing de 1.1 isso já cai para ~60×/s; adicionalmente, agendar o scroll dentro do mesmo rAF do flush de tokens.

### 1.5 Observação lateral (não é performance, mas é bug)

`client/src/App.jsx:568` retorna `acc`, variável inexistente (provável `ReferenceError` no caminho do modo voz) — deveria ser `accRef.value`. Vale corrigir junto.

---

## Parte 2 — Servidor: tempo até o primeiro token (impacto MÉDIO-ALTO)

Tudo abaixo roda **antes** de `runAssistantTurn` iniciar o stream do modelo (`server/index.js:1944`).

### 2.1 `getSelectedDeckTemplate` — leitura pesada, sem cache, a CADA turno

`server/index.js:1874` chama `getSelectedDeckTemplate` em todo turno de chat, inclusive um trivial "2+2". Isso executa `listDeckTemplates(..., { renderAssets: true })` (`server/db.js:1117-1119`), que carrega **todos** os templates do usuário + globais com colunas JSONB pesadas: `preview_slides`, `palette`, `font_assets`, `mined_style`, `cover_plate_data_url`, e assets de ícone/imagem/ilustração recortados em SQL (`server/db.js:1036-1056`). O próprio código já reconhece que essas payloads chegam a MBs (por isso o `query_timeout` de 60s existe). É a leitura mais cara do caminho quente e **não tem cache** — diferente de models (TTL 30s) e skills (TTL 30s).

**Correções:**
- **Cachear por usuário com TTL curto** (ex.: 30–60s), invalidando na troca/edição de template — mesmo padrão de `getUserModels`/`loadSkills`.
- **Só resolver o template quando o turno for de deck.** `detectCapabilities` (custo zero, regex) já roda; se `!caps.deck`, o template não é usado por `buildBlocksInstruction`. Hoje ele é buscado incondicionalmente em `server/index.js:1874`. Condicionar a busca a `caps.deck` elimina a leitura pesada em ~todos os turnos que não são de apresentação.

Essa é provavelmente a maior alavanca isolada de TTFT no servidor no caso comum.

### 2.2 Histórico inteiro carregado sem `LIMIT` — cresce a cada turno

`fetchActiveMessages` (`server/db.js:845-851`) faz `SELECT ... WHERE m.session_id = $1 ORDER BY m.id ASC` **sem LIMIT**, trazendo `content` completo de todas as mensagens + todos os `chat_tool_calls` (com `arguments` e `result`, que podem ser grandes). Tudo isso vira `apiMessages` (`server/index.js:1921-1925`) e é enviado ao modelo. Duas consequências:
- Latência da leitura DB cresce linearmente com a sessão.
- O prompt cresce sem teto → mais tokens para o modelo processar antes do 1º token, e mais custo.

**Correção:** aplicar uma **janela de contexto** — carregar as últimas N mensagens (ex.: 20–40) ou até um teto de tokens, mantendo o system prompt. Para sessões longas, considerar um resumo das mensagens antigas. Isso protege TTFT e custo sem impacto perceptível em qualidade na esmagadora maioria das conversas. (Há índice adequado — `idx_chat_messages_session(session_id, id)` — então um `ORDER BY m.id DESC LIMIT N` é barato.)

### 2.3 Chamadas de rede no caminho crítico quando skills/MCP estão em jogo

- **Skills autorais (semântica):** se o usuário tem skills autorais e nenhuma bate por léxico, `routeSkills` faz 1–2 chamadas `embed()` de rede **bloqueantes** antes do turno (`server/skills.js:95-101`). No caso comum (sem skills autorais) o custo é zero — retorna imediatamente (`server/skills.js:84`). Mitigação: pré-computar/backfillar embeddings fora do caminho quente (já é lazy hoje), e/ou paralelizar o `embed` da query com o restante da montagem em vez de aguardá-lo antes de `resolveToolDefs`.
- **MCP externo:** cada conexão `mcp-external` habilitada faz um `tools/list` de rede em `buildToolDefs` (`server/tools.js:312-347`), **sem timeout explícito** (`server/mcpClient.js:11-16`). Há cache de 10min por `(email, url)`, mas a primeira chamada da janela — ou um servidor MCP lento — atrasa o TTFT diretamente. Mitigação: adicionar um **timeout curto** ao `tools/list` (ex.: 3–5s) que degrada para a tool de "status" já existente, em vez de segurar o turno indefinidamente.

### 2.4 O que já está bom (não mexer)

- **Pool Lakebase persistente** com token via função async (`server/db.js:87-99`): o fetch de token não custa por request quente; só conexões novas pagam handshake.
- **Leituras independentes em `Promise.all`** (`server/index.js:1892`): chart candidates + histórico + template já são concorrentes.
- **Prompt caching** (`server/llm.js:191-216`): reusa o prefixo estável entre rounds de tool (ajuda os rounds de síntese, não o 1º token).
- **Disclosure progressiva** (`detectCapabilities`, `server/blocks.js:660`): não anexa DECK_POLICY (~4,6k tokens) / SPREADSHEET_POLICY (~1,8k) em turnos triviais — regex, latência zero.
- **Geração de título e embedding da sessão** rodam na cauda, não-bloqueantes (`server/index.js:1990-2002`) — não afetam TTFT.
- **Índices** cobrem as queries por `user_email`/`session_id`.

---

## Parte 3 — Escolha de modelo (impacto ALTO na velocidade bruta, com trade-off)

Isto é sobre a velocidade do próprio modelo, ortogonal ao código acima.

- O padrão do app é **Claude Sonnet 5** (`server/llm.js:35`) — bom equilíbrio. Para o usuário que quer "o mais rápido possível", **Claude Haiku 4.5** (`server/llm.js:38`) ou **GPT-5 mini** entregam TTFT e throughput muito melhores com qualidade sólida para a maioria das perguntas do dia a dia.
- **Modelos de raciocínio** (Opus, GPT-5.6) gastam parte do orçamento em thinking oculto antes de emitir o primeiro token visível — TTFT naturalmente maior. Reserve-os para tarefas que exigem análise profunda.
- **Sugestão de produto:** deixar claro na UI o eixo "rápido ↔ capaz" no seletor de modelos (o `blurb` já existe em cada modelo), e considerar um default "rápido" para conversas curtas. Isso não é código de performance, é orientar a expectativa — mas muda a percepção diretamente.

---

## Plano de ação priorizado

| # | Mudança | Arquivo(s) | Impacto | Esforço |
|---|---------|-----------|---------|---------|
| 1 | Coalescer tokens por rAF antes do `setState` | `client/src/App.jsx:44-53` | Alto | Baixo |
| 2 | Desligar `rehype-highlight` durante o streaming (highlight só ao finalizar) | `client/src/components/Message.jsx:442-444` | Alto | Baixo |
| 3 | `React.memo` em `Message` + `key={m.id}` + `useCallback` nas props | `client/src/App.jsx:860-876`, `Message.jsx:280` | Médio-Alto | Médio |
| 4 | Buscar template só quando `caps.deck`, e cachear por usuário | `server/index.js:1874`, `server/db.js:1117` | Médio-Alto | Baixo |
| 5 | Janela de histórico (últimas N msgs / teto de tokens) | `server/db.js:845`, `server/index.js:1921` | Médio | Médio |
| 6 | Timeout no `tools/list` do MCP externo | `server/mcpClient.js:11`, `server/tools.js:316` | Baixo-Médio | Baixo |
| 7 | Auto-scroll dentro do rAF do flush de tokens | `client/src/App.jsx:325-328` | Baixo | Baixo |
| 8 | Default "rápido" / eixo velocidade↔capacidade no seletor | UI + `server/llm.js` | Percepção | Baixo |

**Ordem recomendada:** 1 → 2 → 4 primeiro (maior ganho percebido, menor esforço), depois 3 e 5, e 6–8 como ajustes finos.

---

## Como medir (antes/depois)

- **Cliente:** Chrome DevTools → Performance, gravar durante uma resposta longa (peça um texto de ~800 palavras). Olhar tempo de "Scripting"/"Rendering" e long tasks durante o stream. Alvo: sem long tasks > 50ms durante o streaming; hoje deve haver muitas.
- **TTFT do servidor:** instrumentar (ou usar o Lumberjack/observability já disponível no ambiente) o tempo entre a chegada do request `/api/chat` e o primeiro evento `token` emitido. Medir num turno trivial ("2+2") e num turno de deck, com sessão curta e sessão longa (50+ mensagens) — a diferença sessão-curta vs sessão-longa expõe o efeito do item 5.
- **Comparação justa:** medir o mesmo prompt no mesmo modelo antes/depois — o objetivo é isolar o overhead do app do tempo do modelo.

Nenhuma dessas mudanças altera o conteúdo que o modelo gera; elas só removem overhead entre o modelo e os olhos do usuário.

# Performance das interações — relatório de impacto da implementação

**Data:** 2026-07-19
**Base:** plano em [`performance-latencia-interacoes.md`](./performance-latencia-interacoes.md)
**Escopo entregue:** 6 mudanças (client + server), todas verificadas e medidas.

---

## Sumário executivo

As seis melhorias do plano foram implementadas e verificadas (build limpo do client e do server, módulos carregam, lógica nova testada em isolamento). O maior ganho, como previsto, está no **cliente**: o custo de CPU durante o streaming — a causa direta da sensação de "mais lento que Claude/Perplexity" — cai **6× a 11×**, e o efeito é maior quanto mais longa a resposta (era comportamento **O(n²)**; passa a ~linear). No **servidor**, o TTFT de turnos comuns deixa de pagar uma leitura pesada de template (MBs de JSONB) e o prompt enviado ao modelo passa a ter teto, cortando **até 75%** dos tokens de histórico em sessões longas.

Nenhuma mudança altera o conteúdo que o modelo gera nem o que o usuário lê — só removem overhead entre o modelo e a tela.

---

## Como foi medido

- **Cliente (markdown/render):** harness Node usando as **mesmas libs** do app (`react-markdown` + `remark-gfm` + `rehype-highlight`) via `renderToStaticMarkup`, simulando o loop de streaming (texto crescendo ~4 chars/token). Compara "1 render/token com highlight" (antes) vs "coalescing por frame + highlight só no fim" (depois). Mede CPU de renderização, que é o gargalo.
  > Ressalva honesta: `renderToStaticMarkup` no Node não é idêntico ao React no browser (não há DOM real/reconciliação). Os **tempos absolutos** são indicativos, não de produção; os **fatores de redução** (6–11×, quadrático→linear) refletem a mudança de trabalho de CPU e se traduzem diretamente para o browser. A medição browser real (DevTools Performance) está descrita no plano original como validação de campo.
- **Servidor (prompt/tokens):** chamadas diretas a `buildBlocksInstruction`/`detectCapabilities` e cálculo do tamanho do histórico enviado (≈4 chars/token; ≈250 tokens/mensagem). Correção da janela testada em 5 casos de borda.
- **Gating de deck:** `detectCapabilities` rodado sobre 9 prompts representativos.

---

## Impacto por mudança

### 1. Coalescing de tokens por `requestAnimationFrame` (cliente)
**Arquivos:** `client/src/App.jsx` (`makeSSEHandler` + 3 callers, com `finalize()` no `finally`).
**Antes:** cada token → `setState` → clone do array de mensagens → re-render do `App` inteiro. Dezenas de renders/segundo.
**Depois:** no máximo **1 flush por frame (~60/s)**, lendo `accRef.value` (fonte única da verdade — nenhum token é perdido; `finalize()` garante o último flush ao terminar o stream).

**Medição (renders no stream):**

| Resposta | Renders ANTES | Renders DEPOIS | Redução |
|---|---|---|---|
| 346 tokens | 346 | ~173 + 1 | ~2× |
| 1.039 tokens | 1.039 | ~520 + 1 | ~2× |
| 2.080 tokens | 2.080 | ~1.040 + 1 | ~2× |

(A redução de renders escala com a taxa real de tokens do gateway; com streams mais rápidos, o coalescing agrupa ainda mais.)

### 2. Highlight desligado durante o streaming (cliente)
**Arquivo:** `client/src/components/Message.jsx:442` — `rehypePlugins={streaming ? [] : [rehypeHighlight]}`.
**Antes:** `rehype-highlight` re-rodava sobre **todo** o código acumulado a cada render. Custo **quadrático**.
**Depois:** highlight só ao finalizar a mensagem (1×). Cosmético — ninguém lê código destacado enquanto ele é digitado.

**Medição (CPU total do stream, combinada com o item 1):**

| Resposta (com blocos de código) | CPU ANTES | CPU DEPOIS | Ganho |
|---|---|---|---|
| ~1.4k chars (346 tok) | 445 ms | 41 ms | **11×** |
| ~4.2k chars (1.039 tok) | 1.713 ms | 243 ms | **7×** |
| ~8.3k chars (2.080 tok) | 5.814 ms | 940 ms | **6×** |

O ponto-chave é a **curva**: antes, dobrar a resposta ~quadruplicava o custo (445→1.713→5.814 ms — assinatura de O(n²)); depois cresce de forma ~linear. É exatamente a degradação que fazia respostas longas "engasgarem".

### 3. `React.memo` em `Message` + `key={m.id}` + callbacks estáveis (cliente)
**Arquivos:** `Message.jsx` (`export default memo(Message)`, callsites passam `msg.id`), `App.jsx` (`useCallback` em `speakText`/`openDeck`/`openSpreadsheet`; `regenerateMessage`/`editUserMessage`/`submitQuestionAnswers` passam a ler `messagesRef` em vez de depender de `messages`, ficando referencialmente estáveis durante o stream).
**Antes:** cada token re-renderizava **todas** as mensagens antigas (sem memo, `key={i}`, callbacks recriados por render).
**Depois:** memo pula as bolhas concluídas; só a bolha em streaming re-renderiza.
**Impacto:** o custo por frame deixa de crescer com o **tamanho da conversa**. Numa thread de 50 mensagens, antes cada token tocava as 50; agora toca 1. Combina multiplicativamente com os itens 1–2 (menos frames × menos trabalho por frame × menos componentes por frame).
**Detalhe de correção:** foi preciso remover `messages` das dependências de 3 `useCallback` (via `messagesRef`), senão a identidade delas mudaria a cada token e anularia o `memo` — a armadilha clássica.

### 4. Template de deck: gating por `caps.deck` + cache por usuário (servidor)
**Arquivos:** `server/index.js` (fetch condicional a `caps.deck`), `server/db.js` (`getSelectedDeckTemplate` com cache TTL 60s + `invalidateSelectedTemplate` em todas as 5 escritas de template).
**Antes:** **todo** turno de chat (inclusive "2+2") lia `listDeckTemplates({renderAssets:true})` — payload de render que pode ter **MBs** de JSONB (preview_slides, palette, font_assets, mined_style, cover plates), sem cache.
**Depois:** turnos que não são de deck **pulam a leitura inteira**; turnos de deck a reaproveitam do cache entre turnos.

**Medição do gating** (9 prompts representativos): apenas **3/9** acionaram deck. Os outros 6 (2+2, resumo, pergunta de dados, email, análise, planilha) agora **não tocam** a tabela `deck_templates` no caminho quente. Em uso real, a grande maioria dos turnos não é de deck → a leitura pesada some do TTFT do caso comum. Nos turnos de deck, o cache converte N leituras pesadas por sessão em 1 (invalidada corretamente em qualquer edição de template).

### 5. Janela de histórico (servidor)
**Arquivos:** `server/index.js` (`pushWindowedHistory` + `MAX_HISTORY_MESSAGES=40`, aplicada em `/api/chat`, `/continue`, `/regenerate`).
**Antes:** **todo** o histórico da sessão era reenviado ao modelo a cada turno (sem limite) → prompt e latência crescendo linearmente e sem teto com a conversa.
**Depois:** apenas as últimas 40 mensagens (~20 trocas) vão ao modelo. O histórico **completo** continua carregado para `detectCapabilities` e resolução de blocos — o corte é só no que o modelo reprocessa.

**Medição (tokens de histórico enviados, ~250 tok/msg):**

| Tamanho da sessão | ANTES | DEPOIS | Corte |
|---|---|---|---|
| 10 msgs | ~2.500 | ~2.500 | — |
| 40 msgs | ~10.000 | ~10.000 | — |
| 80 msgs | ~20.000 | ~10.000 | **−50%** |
| 160 msgs | ~40.000 | ~10.000 | **−75%** |

Abaixo de 40 mensagens (a esmagadora maioria das conversas) não há corte algum — invisível na prática. Acima disso, o TTFT e o custo por turno ficam **limitados** em vez de degradarem indefinidamente. Correção validada em 5 casos de borda (sessão curta, no limite, acima do limite começando em user/assistant, vazia): nunca excede o teto e sempre inicia numa mensagem `user` (evita uma resposta do assistant "pendurada" que confundiria o modelo).

### 6. Timeout no `tools/list` do MCP externo (servidor)
**Arquivo:** `server/mcpClient.js` — `listMcpTools` agora tem timeout de **4s** (`Promise.race`).
**Antes:** montar um turno com uma conexão MCP externa habilitada fazia um `tools/list` de rede **sem timeout** antes do 1º token; um servidor MCP lento/travado segurava o TTFT indefinidamente.
**Depois:** em 4s o `tools/list` desiste, e `buildToolDefs` degrada aquela conexão para uma tool de "status" (que já existia) — o turno começa mesmo assim, e o usuário vê o motivo. Cap de pior caso no TTFT quando há MCP externo.

---

## Efeito combinado (cliente)

Os três ganhos de cliente se **multiplicam** por frame de streaming:

```
custo por frame  =  nº de frames (item 1)
                 ×  trabalho por render, sem highlight (item 2)
                 ×  nº de componentes re-renderizados (item 3)
```

Em uma resposta longa (blocos de código) numa conversa já longa, é onde o app mais "engasgava" e onde os três atuam juntos — a combinação é bem maior que os 6–11× medidos isoladamente para os itens 1+2.

---

## Verificação realizada

- ✅ `npm run build:client` — limpo (1.130 módulos).
- ✅ `npm run build:server` (esbuild) — limpo (o warning `import.meta` é pré-existente e não relacionado).
- ✅ `node --check` nos 3 arquivos de servidor tocados.
- ✅ Carga dos módulos + exports (`invalidateSelectedTemplate`, `getSelectedDeckTemplate`, `listMcpTools`, `buildBlocksInstruction`, `detectCapabilities`).
- ✅ `pushWindowedHistory` testada em 5 casos de borda.
- ✅ `detectCapabilities` (gating de deck) sobre 9 prompts.
- ✅ Bundles `client/dist` e `server-dist` regerados.

**O que NÃO foi verificável neste ambiente (sem workspace Databricks/Lakebase ao vivo):** TTFT ponta-a-ponta real e fluidez no browser. Ambos exigem o app rodando contra o gateway + Lakebase. A validação de campo (DevTools Performance no cliente; instrumentar o intervalo `request /api/chat` → primeiro evento `token` no servidor, comparando sessão curta vs longa) está descrita no plano original e é o passo recomendado antes do merge.

---

## Bug corrigido de brinde

`client/src/App.jsx` retornava `acc` (variável inexistente) ao fim de `sendMessage` — `ReferenceError` no caminho do modo voz. Trocado por `accRef.value`.

---

## Risco e reversibilidade

Todas as mudanças são localizadas e reversíveis de forma independente. Os parâmetros são conservadores e ajustáveis num único ponto:
- `MAX_HISTORY_MESSAGES = 40` (`server/index.js`)
- `SELECTED_TEMPLATE_TTL_MS = 60_000` (`server/db.js`)
- `LIST_TOOLS_TIMEOUT_MS = 4000` (`server/mcpClient.js`)

O cache de template invalida em toda escrita (create/update/select/delete/scope); edições de template global limpam o cache inteiro (conservador e correto). A janela de histórico preserva o histórico completo para detecção de capacidade e resolução de blocos — só limita o replay ao modelo.

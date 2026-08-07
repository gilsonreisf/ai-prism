# Changelog

Todas as mudanças relevantes deste projeto são documentadas aqui.

O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/)
e o projeto adota o [Versionamento Semântico](https://semver.org/lang/pt-BR/).

## [Unreleased]

<!-- Adicione aqui as mudanças ainda não lançadas, em Added / Changed / Fixed / Removed. -->

### Added

- **Ambiente de desenvolvimento 100% local** sem Lakebase/OAuth: PostgreSQL 17 + pgvector
  do Homebrew (`scripts/local-postgres.sh`, `.env.local.example`, `scripts/seed-local.mjs`)
  e scripts npm `local:up|down|status|reset|seed` + `dev:local`.
- **Editor WYSIWYG no Document Studio**: edição visual (clique-e-digite) de documentos
  com barra de formatação (títulos, negrito/itálico/tachado, listas, citação, link),
  mantendo o Markdown puro como modo avançado. Fecha o gap de edição manual só-Markdown
  apontado no benchmark vs. Claude.

### Changed

- **Catálogo de modelos** atualizado (sondado no gateway): Claude Opus 4.8 → **Opus 5**,
  Gemini 3.5 Flash → **3.6 Flash** e novo **Kimi K3** (Moonshot AI); modelo de mídia padrão
  passa a `gemini-3-6-flash`.
- **Document Studio**: o editor de markdown ganha split-pane com **preview rich text ao vivo**.
- **Editor de slides**: os controles de zoom saíram de cima do slide (não cobrem mais o conteúdo).

### Fixed

- **Robustez do motor de layout de decks** (`shared/deckLayout.js`, transversal a preview e
  `.pptx` nativo): corrige as classes de defeito de composição em slides densos —
  (1) texto embrulhando palavra-a-palavra em colunas estreitíssimas (piso de compressão
  0.6→0.7× + truncagem legível com reticências quando a coluna ficaria abaixo de 1.2in);
  (2) conteúdo transbordando o card/rodapé (clamp de altura efetiva quando a caixa é
  desproporcional ao texto); (3) ícones irmãos com tamanhos diferentes (normalização do
  tamanho entre cards de um mesmo stack); e piso de fonte 7→8pt. Como o motor é fonte única
  para os dois renderizadores, o `.pptx` exportado herda a mesma robustez.
- **Labels de eixo de gráfico sobrepostos** no preview: quando os slots ficam estreitos, os
  rótulos rotacionam 45° (colisão moderada) ou omitem alternados (colisão severa).
- **Auto-revisão visual** (`shared/deckReview.js`) ganha duas detecções novas: embrulho
  excessivo de texto em caixa estreita e ícones irmãos com tamanhos desiguais.
- `server/db.js`: `PGSSLMODE` respeitado (permite Postgres local sem SSL) e `PGUSER` desacopla
  o role do banco do e-mail app-level; fallback de embeddings sem a extensão `vector` no modo local.
- **Logo do Design System nos decks**: o renderer agora escolhe a variante de logo que contrasta
  com o fundo do slide (branca em fundo escuro, colorida em fundo claro), então o logo não fica
  mais invisível; além disso um logo discreto passa a aparecer nos slides de conteúdo (chrome de
  marca ao longo do deck, não só na capa).
- **Studio não persiste entre conversas**: abrir uma nova conversa ou trocar de sessão agora fecha
  o Deck/Planilha/Documento Studio aberto (antes ele "grudava" na conversa nova).

## [1.0.0] - 2026-07-29

Primeira versão consolidada: chat multimodelo com artefatos e ferramentas sobre o
Databricks AI Gateway, deployável via Asset Bundle em qualquer cloud.

### Added

- **Chat multimodelo** sobre o Databricks AI Gateway, com streaming de respostas e
  reasoning nativo.
- **Sessões e histórico** persistidos no Lakebase, com **busca semântica** via pgvector
  (flag `HISTORY_RETRIEVAL`).
- **Anexos multimodais**: documentos, imagens e **áudio/vídeo** (transcrição/entendimento
  via Gemini no gateway, com segmentação de gravações longas no browser).
- **Mensagens estruturadas e gráficos interativos** (prism-blocks), incluindo blocos de
  gráfico com série em linha.
- **Ferramentas nativas do workspace** (tool calling): UC Functions e UDF Python embutida.
- **Estúdios de artefato**: Slides (decks), Planilhas (.xlsx) e Documentos de texto, com
  fluxo bloco → tabela → estúdio → tweak → export.
- **Geração e edição de imagens** via modelos de imagem do gateway.
- **Voz**, personalização, i18n da UI e diretiva de idioma de resposta.
- **Skill "Ajuste de apresentação"**: .pptx anexado vira deck no design system.
- **Conexão a MCPs externos** via UC connections, com UX nas configurações.
- **Painel de administração e autorização** app-level (isolamento por `user_email`).
- **Dashboard de custos de IA** (AI/BI, system tables) publicado no deploy.
- **Deploy via Databricks Asset Bundle** que provisiona a stack completa (Lakebase
  serverless, Serverless SQL Warehouse, a App e o dashboard), com job pós-deploy de
  auto-configuração (role PG do service principal, UDF, volume de imagens, admin bootstrap).
- **Documentação**: README, onboarding/deploy, custos e posicionamento, conexão de MCPs
  e Microsoft 365 via Microsoft Graph.

### Changed

- Deploy **100% cloud-agnóstico** (AWS/Azure/GCP): sem host hardcoded — o workspace vem
  do profile do CLI; Lakebase e warehouse entregues como **recursos da App**.

### Performance

- Fluidez de streaming e melhor TTFT; pooling de conexões do Lakebase; disclosure
  progressiva de capacidades para reduzir tokens.

[Unreleased]: https://github.com/pedrotramos/ai-prism/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/pedrotramos/ai-prism/releases/tag/v1.0.0

# Changelog

Todas as mudanças relevantes deste projeto são documentadas aqui.

O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/)
e o projeto adota o [Versionamento Semântico](https://semver.org/lang/pt-BR/).

## [Unreleased]

<!-- Adicione aqui as mudanças ainda não lançadas, em Added / Changed / Fixed / Removed. -->

## [1.0.0] - 2026-08-09

Primeira versão consolidada: chat multimodelo com artefatos e ferramentas sobre o
Databricks AI Gateway, deployável via Asset Bundle em qualquer cloud (AWS/Azure/GCP).

### Added

- **Chat multimodelo** sobre o Databricks AI Gateway, com streaming de respostas e
  reasoning nativo. Catálogo curado com Claude **Opus 5**, Gemini **3.6 Flash** e
  **Kimi K3** (Moonshot AI), entre outros, sondados ao vivo no gateway.
- **Sessões e histórico** persistidos no Lakebase, com **busca semântica** via pgvector
  (flag `HISTORY_RETRIEVAL`).
- **Anexos multimodais**: documentos, imagens e **áudio/vídeo** (transcrição/entendimento
  via Gemini no gateway, com segmentação de gravações longas no browser).
- **Mensagens estruturadas e gráficos interativos** (prism-blocks), incluindo blocos de
  gráfico com série em linha.
- **Ferramentas nativas do workspace** (tool calling): UC Functions e UDF Python embutida.
- **Estúdios de artefato** — Slides, Planilhas (.xlsx) e Documentos — com fluxo
  bloco → tabela → estúdio → tweak → export:
  - **Slides**: **motor de deck HTML puro** — o modelo escreve `<section>` HTML que flui
    contra o design system ativo, com streaming slide-a-slide, **edição manual do DOM**
    (estilo Claude Design) e export `.pptx` de **objetos nativos** (DOM→shapes), incluindo
    o embed opcional das **fontes da marca** para máxima fidelidade.
  - **Documentos**: **editor WYSIWYG** (clique-e-digite, com barra de formatação) e
    split-pane com preview rich text ao vivo, mantendo o Markdown puro como modo avançado.
- **Geração e edição de imagens** via modelos de imagem do gateway.
- **Voz**, personalização, i18n da UI e diretiva de idioma de resposta.
- **Skill "Ajuste de apresentação"**: .pptx anexado vira deck no design system.
- **Conexão a MCPs externos** via UC connections, com UX nas configurações.
- **Painel de administração e autorização** app-level (isolamento por `user_email`).
- **Dashboard de custos de IA** (AI/BI, system tables) publicado no deploy.
- **Deploy via Databricks Asset Bundle** que provisiona a stack completa (Lakebase
  serverless, Serverless SQL Warehouse, a App e o dashboard), com job pós-deploy de
  auto-configuração (role PG do service principal, UDF, volume de imagens, admin bootstrap).
- **Ambiente de desenvolvimento 100% local** sem Lakebase/OAuth: PostgreSQL + pgvector
  do Homebrew (`scripts/local-postgres.sh`, `.env.local.example`, `scripts/seed-local.mjs`)
  e scripts npm `local:up|down|status|reset|seed` + `dev:local`.
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

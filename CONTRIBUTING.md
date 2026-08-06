# Contribuindo com o AI Prism

Obrigado pelo interesse em contribuir! Este guia cobre como preparar o ambiente,
o fluxo de desenvolvimento e as convenções que mantemos no repositório.

> O AI Prism é um **acelerador de solução open-source**, não um produto oficial da
> Databricks. Cada pessoa deploya a sua própria cópia no próprio workspace — veja o
> [README](README.md) e o [onboarding de deploy](docs/onboarding-deployment.md).

## Índice

- [Código de conduta](#código-de-conduta)
- [Pré-requisitos](#pré-requisitos)
- [Configurando o ambiente](#configurando-o-ambiente)
- [Fluxo de desenvolvimento](#fluxo-de-desenvolvimento)
- [Padrões de commit](#padrões-de-commit)
- [Testes e QA](#testes-e-qa)
- [Abrindo um Pull Request](#abrindo-um-pull-request)
- [Reportando bugs e sugerindo features](#reportando-bugs-e-sugerindo-features)
- [Segurança](#segurança)

## Código de conduta

Este projeto adota o [Contributor Covenant](CODE_OF_CONDUCT.md). Ao participar,
você concorda em manter as interações respeitosas e acolhedoras.

## Pré-requisitos

- **Node.js 22+** (veja [`.nvmrc`](.nvmrc) — `nvm use` seleciona a versão certa).
- **Databricks CLI ≥ 1.8** para deploy e para rodar o app contra um workspace real.
- Acesso a um workspace Databricks com AI Gateway, Serverless SQL e Lakebase habilitados,
  caso queira exercitar o fluxo completo (o QA offline não precisa de workspace).

## Configurando o ambiente

```bash
nvm use                 # Node da versão do .nvmrc
npm install
cp .env.example .env     # preencha as variáveis para dev local (veja comentários no arquivo)
npm run dev              # client (Vite, :5173) + servidor (Node --watch, :8000)
```

O Vite faz proxy de `/api` para `http://localhost:8000`. Fora do runtime da Databricks App,
as variáveis de ambiente do [`.env.example`](.env.example) suprem o que o runtime injetaria
(host do workspace, warehouse, Lakebase etc.).

## Fluxo de desenvolvimento

1. Crie um branch a partir de `main` com um nome descritivo e prefixo de tipo:
   `feat/…`, `fix/…`, `docs/…`, `chore/…`, `perf/…`.
2. Faça as mudanças mantendo o estilo do código ao redor (comentários, nomes, idioma).
3. Rode o [QA](#testes-e-qa) e valide localmente o que for afetado.
4. Faça commits pequenos e coesos seguindo os [padrões de commit](#padrões-de-commit).
5. Abra um [Pull Request](#abrindo-um-pull-request) contra `main`.

O app roda os artefatos **pré-compilados** (`client/dist` + `server-dist/index.cjs`).
Sempre rode `npm run bundle` antes de qualquer `bundle deploy` / `apps deploy`.

## Padrões de commit

Usamos [Conventional Commits](https://www.conventionalcommits.org/). O escopo é opcional
mas recomendado; a descrição pode ser em português.

```
<tipo>(<escopo>): <descrição no imperativo>
```

Tipos usados no projeto: `feat`, `fix`, `docs`, `chore`, `perf`, `refactor`, `test`.

Exemplos reais do histórico:

```
feat(deck): Fase 3 — tweaks de IA melhores (região, prévia, recompor, histórico)
fix(blocks): documento com bloco de código vazava JSON cru no chat
perf: fluidez de streaming + TTFT
```

Mudanças relevantes para quem usa/deploya o app devem ganhar uma entrada no
[CHANGELOG.md](CHANGELOG.md), na seção `## [Unreleased]`.

## Testes e QA

O pipeline de artefatos (decks, planilhas, mineração de .pptx) tem checagens
determinísticas que rodam **offline, sem workspace**:

```bash
npm run qa   # deck-elements + deck-composition + mine-pptx + spreadsheet QA
```

Rode o QA antes de abrir um PR que toque em geração de deck/planilha/documento.
Para mudanças de UI ou de servidor, valide manualmente rodando `npm run dev` e,
quando fizer sentido, contra um workspace real via `bundle deploy`.

## Abrindo um Pull Request

- Preencha o [template de PR](.github/pull_request_template.md).
- Descreva **o quê** e **por quê**, não só o *como*.
- Liste como testou (QA, dev local, deploy num workspace).
- PRs pequenos e focados são revisados mais rápido.
- CI/QA verde e pelo menos uma aprovação antes do merge.

## Reportando bugs e sugerindo features

Use os templates de issue em `.github/ISSUE_TEMPLATE/`. Para bugs, inclua passos de
reprodução, comportamento esperado vs. obtido e o ambiente (cloud, versão do CLI, modelo).

## Segurança

**Não** abra issues públicas para vulnerabilidades. Siga a [política de segurança](SECURITY.md).

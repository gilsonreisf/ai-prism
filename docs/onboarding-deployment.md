# Onboarding: seu próprio "ChatGPT" no Databricks em ~15 minutos

> **Aviso.** O AI Prism não é um produto oficial da Databricks e não tem SLA. É
> um acelerador open-source que **você deploya no seu próprio workspace** e
> customiza como quiser. Seus dados permanecem na sua conta Databricks e não são
> usados para treinar modelos de terceiros.

Este guia leva você de "workspace vazio" a "app rodando para o time" com **um
único comando**. Toda a infra (Lakebase, SQL Warehouse, App, dashboard, UDF) é
provisionada por um **Databricks Asset Bundle** — você não cria recursos à mão.

---

## Visão do fluxo

```mermaid
flowchart LR
    A["1· Pré-requisitos<br/>workspace + CLI"] --> B["2· npm run bundle<br/>artefatos de build"]
    B --> C["3· bundle deploy<br/>provisiona TUDO"]
    C --> D["4· Primeiro acesso<br/>admin + modelos"]
    D --> E["5· Customizar<br/>marca · templates · tools"]
    E --> F["6· Convidar time<br/>permissões da App"]
```

O passo 3 cria, de uma vez: **Lakebase serverless** (autoscaling 0.5–16 CU,
auto-stop em 30 min), **Serverless SQL Warehouse**, a **App** (com o env já
cabeado a partir desses recursos), o **dashboard de custos** e um **job de
auto-configuração** que provisiona a UDF de Python e descobre o e-mail de quem
deployou (que vira o admin bootstrap).

---

## 1. Pré-requisitos (5 min)

- Um **workspace Databricks** (AWS, Azure ou GCP) com Unity Catalog habilitado.
- **AI Gateway / Foundation Model APIs** disponíveis na região (endpoints
  `databricks-claude-*`, `databricks-gpt-*`, etc.).
- **Databricks CLI recente (≥ 0.240)** autenticada num profile para o workspace.
  Use uma versão atual: CLIs antigas (ex.: 0.29x) podem falhar ao baixar o
  Terraform interno com `openpgp: key expired` no `bundle deploy`.
  ```bash
  # Azure: use o host do seu workspace (adb-<id>.<n>.azuredatabricks.net)
  databricks auth login --host https://<seu-workspace> -p <PROFILE>
  ```
- Permissão para criar **Databricks App**, **SQL Warehouse**, **Lakebase** e
  **Jobs** (o bundle cria todos).
- **Node.js 18+** e **npm** para o build local.

**Checagem:** `databricks current-user me -p <PROFILE>` retorna seu e-mail.

> **Nota (cloud-agnóstico):** o `databricks.yml` **não** fixa host de workspace —
> o alvo do deploy vem inteiramente do profile do `-p <PROFILE>`. O mesmo bundle
> deploya em AWS, Azure ou GCP sem editar arquivo nenhum. Se a sua CLI ≥ 1.8
> reclamar de credencial em cache de versão antiga, exporte
> `DATABRICKS_AUTH_STORAGE=plaintext` ou rode `databricks auth login` de novo.

---

## 2. Build dos artefatos (2 min)

A App roda os artefatos pré-compilados (`client/dist` + `server-dist/index.cjs`),
não o código-fonte — então **sempre** reconstrua antes de deployar:

```bash
npm ci --include=dev   # só na 1ª vez (ver nota sobre devDeps abaixo)
npm run bundle         # client/dist + server-dist/index.cjs
```

> **Nota (devDeps):** neste projeto, `npm install <pkg>` avulso pode podar as
> devDependencies necessárias ao build. Use `npm ci --include=dev` /
> `npm install --include=dev`.

---

## 3. Deploy da stack completa (5 min)

Um comando provisiona tudo e sobe a App:

```bash
# valida a configuração do bundle (não cria nada)
databricks bundle validate -p <PROFILE> -t dev

# provisiona Lakebase + Warehouse + App + dashboard + job, e sobe a App
databricks bundle deploy -p <PROFILE> -t dev

# roda o job de auto-config (provisiona a UDF Python, imprime a config resolvida)
databricks bundle run ai_prism_auto_config -p <PROFILE> -t dev
```

O que o bundle (`databricks.yml`) gerencia:

| Recurso | Configuração |
|---|---|
| **Lakebase** (`postgres_projects` + `postgres_endpoints`) | serverless, autoscaling **0.5–16 CU**, **auto-stop 30 min** |
| **SQL Warehouse** (`sql_warehouses`) | Serverless, 2X-Small, Photon, auto-stop 10 min |
| **App** (`apps`) | env cabeado a partir dos recursos acima; `APP_OWNER_EMAIL` = quem deployou |
| **Dashboard de custos** (`dashboards`) | Lakeview de auditoria de custos (system tables) |
| **Job de auto-config** (`jobs`) | provisiona a UDF `ai_prism_python_exec` **e o Volume de imagens** (catálogo/schema/volume dedicados + grant ao SP do app); imprime a config |

> **Alvos:** `dev` (padrão, prefixa recursos com seu usuário — bom para testar) e
> `prod` (nomes limpos, para o deploy oficial). Troque `-t dev` por `-t prod`
> quando for para valer. Nenhum dos alvos fixa host — o workspace vem do
> `-p <PROFILE>`, então não é preciso editar o `databricks.yml`.

> **Sobre os IDs do Lakebase serverless:** o app lê `PGHOST` do output do endpoint
> Postgres do bundle. Na primeira vez, confira no `bundle summary` (ou no job de
> auto-config, que imprime `PGHOST`/`PGDATABASE`) se o host resolvido está correto
> antes de anunciar o app para o time.

Ao final, `databricks bundle summary -p <PROFILE> -t dev` mostra a URL pública da
App (atrás do OAuth do workspace).

### Sobre a UDF de Python (`execute_python`)

O AI Prism embarca a própria UDF (`ai_prism_python_exec`) em vez de usar
`system.ai.python_exec`: a nossa respeita uma variável `result`, captura `stdout`
**e** trata exceções retornando `"ERROR: ..."` sem derrubar a query — a função de
plataforma falha a statement inteira em qualquer erro. A definição vive em
`shared/pythonUdf.js` (fonte única); o job de deploy usa a versão gerada em
`bundle/python_udf_ddl.py` (via `node scripts/gen-python-udf-ddl.mjs`), e o app a
provisiona também em runtime — as duas são idênticas byte a byte.

`TOOLS_CATALOG` / `TOOLS_SCHEMA` definem **apenas onde essa UDF é criada** — não
limitam quais UC Functions o usuário pode anexar como tool. A descoberta de UC
Functions varre todos os catálogos/schemas que o usuário enxerga (via
`system.information_schema.routines`, exceto `system`), sempre escopada pelas
permissões reais dele no Unity Catalog.

### Sobre o Volume de imagens geradas

As imagens geradas/editadas no chat têm bytes reais, então vão para um **UC Volume
dedicado** — mantido separado do catálogo de tools para não misturar com outros
assets. O caminho é configurável por `IMAGE_VOLUME_CATALOG` / `IMAGE_VOLUME_SCHEMA`
/ `IMAGE_VOLUME_NAME` (default `ai_prism.default.ai_prism_images`). O job de
auto-config cria o catálogo/schema/volume e concede `READ/WRITE VOLUME` ao
**service principal do app** — o app escreve/lê as imagens como o SP (não pelo
token OAuth do usuário), evitando depender do escopo `files` reconsentido no
browser. O isolamento por usuário continua **app-level** (`WHERE user_email` em
`chat_images`), como todo artefato. O **modelo de imagem padrão é o Nano Banana 2**.

---

## 4. Primeiro acesso e configuração de modelos (5 min)

1. Abra a URL da App e autentique com sua conta do workspace.
2. Como você é o `APP_OWNER_EMAIL` (o deployer), verá as abas de **admin** em
   *Configurações*.
3. **Modelos (LLM)**: habilite os endpoints de serving que o time deve usar e
   defina rótulos/ordem. Só os habilitados aparecem para usuários comuns.
4. **Custos de IA**: a auditoria de custos vive no **dashboard AI/BI** provisionado
   pelo bundle (não em uma aba do app) — abra-o no workspace e **publique** para os
   demais admins. Detalhes em [`dashboards/README.md`](../dashboards/README.md).

---

## 5. Customização (opcional, quando quiser)

- **Marca / design system**: em *Configurações → Templates de apresentação*,
  importe o design system da empresa (cores, fontes, logo, ícones — de um `.pptx`
  de marca ou de um bundle). Decks e planilhas passam a sair no seu visual.
- **Ferramentas**: conecte **Genie Agents**, **UC Functions** e **Vector Search**
  como tools do chat; adicione **conexões MCP externas** se necessário.
- **UI/features**: o código é seu — ajuste textos, tema e comportamento, rode
  `npm run bundle` e redeploye com `databricks bundle deploy`.

---

## 6. Convidar o time (2 min)

- Dê à App a permissão **CAN_USE** para os usuários/grupos que devem acessá-la
  (UI de permissões da App, ou API).
- Para adicionar outros **administradores**, use *Configurações → Administradores*
  dentro do app (o autocomplete sugere quem já tem acesso).
- Cada usuário passa a operar com a **própria identidade**: conversas, permissões
  de dados e custo são atribuídos a ele.

---

## Resolvendo problemas comuns

| Sintoma | Causa provável | Ação |
|---|---|---|
| `bundle deploy` falha em Lakebase/endpoint | recurso serverless Postgres indisponível na região/conta | confirme disponibilidade do Lakebase serverless; ajuste `databricks.yml` |
| App sobe mas não conecta no Postgres | `PGHOST` resolveu para host errado | veja o `PGHOST` impresso pelo job de auto-config / `bundle summary` |
| Tool `execute_python` some | UDF não provisionada | rode `databricks bundle run ai_prism_auto_config` (ou o app a cria no 1º uso) |
| Modelos não aparecem | Nenhum endpoint habilitado no catálogo | Admin → *Modelos (LLM)* → habilite |
| Deploy sem efeito | Esqueceu de `npm run bundle` | Rebuild + `bundle deploy` novamente |

---

*Fluxo desenhado para o cliente deployar e operar o AI Prism no próprio
workspace. Ajuste hosts/targets no `databricks.yml` conforme sua organização.*

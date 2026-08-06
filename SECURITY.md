# Política de Segurança

O AI Prism é um acelerador de solução open-source que você deploya no **seu próprio**
workspace Databricks. Não é um produto oficial da Databricks e não possui SLA. Ainda
assim, levamos vulnerabilidades a sério — este documento explica como reportá-las.

## Reportando uma vulnerabilidade

**Não abra uma issue pública** para relatar uma vulnerabilidade de segurança.

Em vez disso, use o canal privado do GitHub:

1. Acesse a aba **Security** do repositório.
2. Clique em **Report a vulnerability** (GitHub Security Advisories).

Se preferir, abra uma issue mínima **sem detalhes técnicos** pedindo um canal privado
de contato, e a resposta virá por lá.

Inclua no relatório, sempre que possível:

- Uma descrição da vulnerabilidade e do impacto potencial.
- Passos para reproduzir (proof of concept).
- Versões/ambiente afetados (cloud, versão do Databricks CLI, commit).
- Qualquer mitigação que você já tenha identificado.

Faremos o possível para confirmar o recebimento em poucos dias úteis e manter você
informado sobre o progresso até a resolução.

## Escopo

Como cada instalação roda no workspace de quem deploya, tenha em mente o modelo de
confiança do projeto:

- **Isolamento entre usuários é feito no nível da aplicação** (cláusulas `WHERE user_email`),
  sobre uma identidade fornecida pelo proxy da Databricks App. Relatos sobre furos nesse
  isolamento (um usuário acessando dados de outro) são especialmente bem-vindos.
- Autenticação usa **OBO (on-behalf-of) do usuário** para chamadas de API e o **service
  principal do app** para armazenamento próprio (Lakebase, Volume de imagens).
- Segredos (tokens do workspace, credenciais do Lakebase) **nunca** devem ser commitados.
  Veja o [`.env.example`](.env.example) e o [`.gitignore`](.gitignore) — `.env` é ignorado.

## Fora de escopo

- Vulnerabilidades na plataforma Databricks em si (reporte à Databricks).
- Configurações inseguras feitas por quem deploya (ex.: expor segredos, conceder
  permissões amplas demais no workspace).

## Boas práticas para quem deploya

- Rode sempre a versão mais recente do `main`.
- Não hardcode hosts, tokens ou credenciais em `app.yaml` / `databricks.yml` — o modelo
  cloud-agnóstico injeta tudo em runtime (veja o README).
- Restrinja o acesso à App e ao workspace pelos ACLs da Databricks.

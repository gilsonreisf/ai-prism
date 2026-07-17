# Kit inicial de design system — AI Prism

Este kit é um bundle de design system **válido e importável** com placeholders da marca
fictícia "ACME". Substitua os placeholders pelos assets da sua marca, mantenha a estrutura
de pastas e as convenções de nome, e importe a pasta inteira no AI Prism
(Configurações → Modelos de apresentação → **Importar pasta**).

> Este arquivo (INSTRUCOES.md) é ignorado pelo importador — pode deixá-lo no bundle.

## Como o AI Prism reconhece um bundle

A pasta é tratada como design system quando contém `_ds_manifest.json` **ou**
(`README.md` **e** `colors_and_type.css`). Sem isso, os arquivos são tratados
individualmente (e a maioria é ignorada).

## Estrutura

```
acme-design-system/
├── _ds_manifest.json      ← fonte de verdade: tokens, fontes, cartões (recomendado)
├── README.md              ← guia da marca que a IA LÊ a cada deck (seções específicas)
├── colors_and_type.css    ← tokens de cor CSS (fallback quando não há manifest)
├── fonts/                 ← webfonts .ttf/.otf/.woff2 (≤16 arquivos, ≤1.5MB cada)
├── assets/                ← ÚNICA pasta escaneada em busca de assets de marca
├── preview/               ← cartões HTML de especificação (referenciados no manifest)
├── slides/                ← slides de exemplo em HTML (1280×720)
└── templates/             ← templates de slide em HTML (1280×720)
```

## Convenções de nome em `assets/` (é assim que o tipo é decidido!)

O importador classifica cada arquivo **pelo nome**, nesta ordem de precedência:

| Padrão no nome do arquivo                  | Vira                              |
| ------------------------------------------ | --------------------------------- |
| `illustration` ou `nodal`                  | Ilustração (capas/divisores)      |
| `bg-`, `background` ou `industry-`         | Fundo (imagem full-bleed)         |
| `lockup`                                   | Lockup (logo de produto/parceria) |
| `-icon-` ou `-icon.` (ex.: `acme-icon-database.svg`) | Ícone                  |
| `logo` ou `symbol`                         | Lockup / logo principal           |
| **qualquer outro nome**                    | "Imagem" genérica (⚠ verifique!)  |

⚠ **Arquivos que não casam com nenhum padrão viram "imagem" genérica** — o relatório da
importação lista esses nomes para você conferir. Um ícone chamado `database.svg` NÃO vira
ícone; chame-o de `acme-icon-database.svg`.

### Logo principal

O importador procura em `assets/` nomes com `logo`/`symbol` (sem `lockup`): a variante
com `white` vira o logo para fundos escuros; a `full-color`, para fundos claros.

### Variantes puladas (de propósito)

Para manter 1 entrada canônica por produto: arquivos com `-alt`, `-container`, `-white`
são pulados quando existe a versão principal; famílias `primary-icon-*`/`secondary-icon-*`
mantêm apenas a variante `-orange.svg`.

### Limites por tipo

48 ícones · 24 lockups · 16 ilustrações · 12 fundos · 16 imagens. Fundos/fotos acima de
~450KB são reduzidos para JPEG de 1440px (indistinguível num slide de 10 pol).

## Cores (`colors_and_type.css` e/ou manifest `tokens`)

Declare tokens como variáveis CSS com hex de 6 dígitos. Os 4 slots do tema são escolhidos
por **dicas no nome** (edite depois no formulário se quiser):

- Fundo claro: nomes com `oat`, `bg`, `background`, `paper`, `surface` (cor clara)
- Primária escura: `navy`, `primary`, `brand`, `ink`, `dark`
- Destaque (CTA): `lava`, `accent`, `cta` (cor saturada)
- Secundária: `coral`, `secondary`

## Fontes

Prefira declarar no manifest (`fonts: [{family, weight, style, files:["fonts/…"]}]`) —
fallback: blocos `@font-face` no CSS. Máx. 16 arquivos de 1.5MB cada. O `.pptx` exportado
referencia as fontes **por nome**; os arquivos servem ao preview/apresentação no app.

## README.md — o que a IA realmente lê

O texto completo fica disponível no inspetor, mas a IA recebe um corte condensado
(~3800 caracteres) **apenas das seções com estes títulos**:

`## Content Fundamentals` · `## Visual Foundations` · `## Iconography` ·
`## Quick Reference` · `## Voice and Tone`

Concentre nessas seções as regras que mudam o resultado: tom de voz, capitalização,
o que nunca fazer, combinações de cor permitidas. (Os títulos devem ficar em inglês —
é o padrão que o importador reconhece; o conteúdo pode ser em português.)

## Cartões HTML (preview/, slides/, templates/)

Referencie-os no manifest (`cards: [{path, group, title, description}]` e
`templates: [{name, entryPath, description}]`). Grupos `Colors`, `Type`, `Components`,
`Slides`, `Templates`, `Brand`, `Spacing` ganham seções no inspetor. Cada cartão vira um
documento auto-contido (CSS/JS/imagens inlinados) — limite de 600KB por cartão após o
inline e 9MB no total. Slides/templates são autorados em um palco fixo de 1280×720.

## Qualidade: o que mais eleva o resultado dos decks gerados

1. README com regras de voz/estilo concretas (é injetado no prompt de TODO deck).
2. Paleta nomeada completa (não só 4 cores) + fontes reais da marca.
3. Ícones de produto nomeados semanticamente (`acme-icon-<conceito>.svg`) — a IA escolhe
   ícones pelo rótulo.
4. Ilustrações e fundos de marca (capas/divisores usam esses assets diretamente).
5. Depois de importar, use "Rotular assets com IA" no formulário para dar rótulos
   semânticos ao que veio sem nome bom.

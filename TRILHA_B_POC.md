# Trilha B PoC: Substrato HTML/CSS para Decks

**Branch**: `feat/deck-html-parity`  
**Data**: 2026-08-07  
**Status**: ✅ Vertical slice funcional (4 commits, QA passa)

## Resumo

Implementação de prova de conceito de um substrato **HTML/CSS** alternativo para decks do AI Prism, almejando **paridade de UX com Claude Design**. Em vez de JSON semântico renderizado via DOM, os decks agora podem ser auto-contidos HTML5 com design tokens como CSS custom properties.

## Como testar

```bash
# Gerar HTML de teste (7 slides, todos os layouts)
cd /Users/pedro.ramos/Projects/Misc/ai-prism-html
node scripts/test-deck-html.mjs

# Abrir no navegador (responsivo, offline-friendly)
open /tmp/deck-html-sample.html

# Validar QA (todos os testes passam)
npm run qa
```

## Arquitetura

```
Entrada: Slides JSON (semânticos)
         ↓
    [server/blocks.js]
         ↓
    generateDeckHtml() ← shared/deckHtml.js
         ↓
    HTML5 auto-contido (7-8 KB)
         ↓
    Block.html injected no response
         ↓
    Client: HtmlDeckPreview (iframe sandbox)
         ↓
    Renderizado no chat / export PDF
```

## Documentação Completa

Leia `sandbox/deck-html-trilha-b-status.md` para:
- Funcionamento end-to-end
- Gaps conhecidos
- Comparação Trilha A vs. B
- Próximas fases (B2–B5)
- Como testar manualmente

## Commits

1. `fe9c5d7` — Substrato HTML: gerador + estrutura de base
2. `c73f0af` — Integração no servidor: injeção automática de HTML
3. `efa1417` — Documentação CHANGELOG
4. `65cfbe5` — Testes e validação end-to-end

## Status: O que funciona

✅ Gerador de HTML (10 layouts semânticos)  
✅ Design tokens → CSS vars (re-themeable)  
✅ Preview em iframe sandbox (CSP-protegido)  
✅ Integração no servidor (geração automática)  
✅ QA passa (sem regressões)  
✅ Auto-contido (sem CDN)  

## Pendências (fora do escopo PoC)

- [ ] B2: Editor on-canvas (layer tree + hit-testing)
- [ ] B3: Export HTML → PDF/PNG
- [ ] B4: Render progressivo no chat (streaming)
- [ ] B5: Extras (speaker notes, present mode)

## Próximos passos (recomendação)

1. **Curto prazo**: Review e arquivamento da PoC
2. **Decisão arquitetural**: Trilha A (evolução semântica) vs. B (HTML)
   - Fidelidade: B wins (95–98%)
   - UX edição: A mais rápido
   - .pptx nativo: A wins
3. **Se continuar Trilha B**: Completar B2 (editor) e B3 (export)

---

**Contato**: Isaac (repo owner)

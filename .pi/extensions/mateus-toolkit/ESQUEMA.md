# ESQUEMA — mateus-toolkit

Esquema detalhado do projeto, gerado a partir de leitura completa do código-fonte.
Todos os fatos abaixo foram verificados nos arquivos reais do projeto.

---

## 1. Visão geral

Extensão modular para o **pi** (coding agent, v0.82.1) que força o agente a trabalhar
sempre com **todo list + resumo** e adiciona ferramentas de web, shell, qualidade,
micro-agentes (juiz/documentador) e um "brain" no Notion (via CLI `ntn`).

- Entrypoint: `.pi/extensions/mateus-toolkit/index.ts` (carregada com `pi -e ...`)
- Runtime: Node v22.19.0 com TypeScript nativo (type stripping, imports com `.ts`)
- Linhas de código: ~3239 (TS + CJS, sem contar logs)
- Dependências diretas (package.json): `node-pty ^1.1.0` (só para o driver de teste CLI)
- Dependências de runtime (do pi): `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai` (`compat`)
- CLIs externas usadas: `ntn` 0.21.7 (Notion), `curl` (teste de provider), `pi --list-models`
- Ambiente verificado: pi 0.82.1 · node v22.19.0 · ntn 0.21.7

## 2. Estrutura de arquivos

```
mateus-toolkit/
├── index.ts                  → entrypoint; registra os 10 módulos na ExtensionAPI
├── logger.ts                 → log diário em logs/YYYY-MM-DD.log + console.error
├── controle-tendencia.ts     → NÚCLEO: tools create_todo/check_todo/get_todo,
│                               comandos /todo e /summary, ciclo completo de eventos
├── juiz.ts                   → micro-agente juiz (ATENDEU | NAO_ATENDEU: <motivo>)
│                               + tool 'juiz' + runJuiz() programático
├── documentador.ts           → micro-agente que gera o MD da entrega e chama
│                               criar_page() no brain; + tool 'documentador'
├── webfetch.ts               → tool 'webfetch' (URL → texto, max 25K chars, timeout 30s)
├── webfetch-agent.ts         → tool 'webfetch_agent' (fetch + micro-agente com
│                               detail small|medium|large)
├── websearch.ts              → tool 'websearch' (DuckDuckGo HTML, top ~8 resultados)
├── permission-gate.ts        → guard de segurança (deny-list) para tools bash
├── quality-monitor.ts        → anti-loop: resposta vazia, tool inventada, tool call repetida
├── shell-session.ts          → tools ShellSession / ShellSessionCwd / ShellSessionReset
├── shell-helpers.ts          → formatOutput: strip ANSI, dedup de linhas, truncate
├── shell-write.ts            → parser de comandos: splitCommandChain, detectWriteTargets
├── add-new-model.ts          → tool 'add_new_model' + comando /models + persistência
│                               em ~/.pi/agent/providers.json
├── lmstudio-provider.ts      → registra provider LM Studio local (não importado no index.ts)
├── run-terminal-pty.cjs      → driver CLI de teste (node-pty) — fora do fluxo da extensão
├── brain/
│   ├── brain.ts              → lógica pura do brain via CLI ntn (753 linhas)
│   └── index.ts              → tools 'brain_bootstrap' e 'criar_page'
├── logs/                     → 2026-07-28.log, 2026-08-01.log
├── ESQUEMA.md                → este documento
└── package.json / package-lock.json
```

## 3. Arquitetura: padrões de integração com o pi

A extensão usa 4 mecanismos da ExtensionAPI (verificados no código):

| Mecanismo | API | Usado por |
|-----------|-----|-----------|
| Tools | `pi.registerTool({name, label, description, parameters, execute})` | create_todo, check_todo, get_todo, webfetch, webfetch_agent, websearch, juiz, documentador, add_new_model, ShellSession, ShellSessionCwd, ShellSessionReset, brain_bootstrap, criar_page |
| Eventos | `pi.on("evento", handler)` | session_start, input, before_agent_start, tool_call (×2), agent_end, agent_settled, turn_end, tool_execution_start |
| Comandos | `pi.registerCommand("nome", {...})` | /todo, /summary, /models |
| Estado/persistência | `pi.appendEntry("mateus-todo"/"mateus-summary", data)` | todo e resumo restaurados no session_start via `ctx.sessionManager.getBranch()` |
| Provider | `pi.registerProvider(name, {...})` | add_new_model, lmstudio-provider |

Micro-agentes usam `complete()` de `@earendil-works/pi-ai/compat` com o modelo ativo
(`ctx.model`) + auth resolvida via `ctx.modelRegistry.getApiKeyAndHeaders()`.

## 4. Ciclo de vida (fluxo de eventos)

```
carregamento
  index.ts → registra 10 módulos → "All modules registered"

session_start
  limpa estado; restaura todo/summary do branch (custom entries)

input (mensagem do usuário)
  ├─ sem todo        → injeta [CONTEXTO - CRIAR TODO OBRIGATÓRIO] → força create_todo
  ├─ todo ativo      → injeta [CONTEXTO - PLANO ATIVO - ALTERAÇÃO SOLICITADA] → força create_todo (atualiza plano)
  └─ todo 100%       → limpa todo; força novo create_todo

before_agent_start
  ├─ sem todo        → system prompt: [MATEUS-TOOLKIT - BLOQUEADO ATÉ CRIAR TODO]
  ├─ todo pendente   → system prompt: [MATEUS-TOOLKIT - SEGUIR PLANO]
  └─ todo completo   → sem injeção

tool_call (guard 1)
  sem todo criado no turno → BLOQUEIA tudo exceto create_todo / add_new_model

tool_call (guard 2)
  contador de tools externas (ignora create_todo/check_todo/get_todo/websearch/webfetch)

agent_end
  ├─ criou todo neste turno:
  │    ├─ pendentes  → injecta steer "[SISTEMA] item #N ainda falta..." (1×, com guard)
  │    └─ 100%       → roda JUIZ
  │         ├─ ATENDEU        → roda DOCUMENTADOR → criar_page no brain → para o chat
  │         ├─ NAO_ATENDEU/INVALIDO → retry com novo create_todo (máx 3, anti-trava)
  │         └─ erro           → para o chat sem injetar turno
  ├─ não criou todo → steer corretivo forçando create_todo (máx 3 por input)
  └─ turno abortado (ESC) → não re-trigga (respeita interrupção)

turn_end
  ├─ reforço a cada 10 turnos: [ALINHAMENTO CONFORME PLANO — TURNO N] (deliverAs: steer)
  └─ quality-monitor: analisa a resposta (vazia / tool inventada / tool repetida)

agent_settled → log de idle
```

Regras centrais do ciclo (hardcoded no controle-tendencia):
1. `create_todo` é a PRIMEIRA tool obrigatória de toda resposta.
2. `check_todo` NÃO dispara followUp (corrigido loop infinito de re-trigger).
3. Todo ganha automaticamente um item final: "Apresentar diff resumido do que foi corrigido/implementado".
4. A entrega final (juiz ATENDEU) dispara o documentador automaticamente.
5. Bloqueio de tool_call garante que nada roda antes do todo.

## 5. Catálogo de módulos

| Módulo | Arquivo | O que faz |
|--------|---------|-----------|
| Controle de tendência | controle-tendencia.ts | Orquestra todo/summary, ciclo de eventos, steers, juiz e documentador |
| Juiz | juiz.ts | Avalia se a entrega ATENDEU ao pedido + plano + últimas 3 msgs da IA |
| Documentador | documentador.ts | Gera MD completo da entrega, valida H1/tamanho, extrai Tipo/Palavras-chave e chama criar_page |
| WebFetch | webfetch.ts | Fetch de URL com strip de HTML, cap 25K chars, timeout 30s |
| WebFetch Agent | webfetch-agent.ts | Fetch + micro-agente com nível small/medium/large (~100/~300/ilimitado palavras) |
| WebSearch | websearch.ts | Busca DuckDuckGo (html.duckduckgo.com), top 8 títulos+snippets |
| Permission Gate | permission-gate.ts | Deny-list de comandos destrutivos (Linux/Windows), rm/del só dentro do cwd, bloqueia escrita em paths de sistema |
| Quality Monitor | quality-monitor.ts | Detecta resposta vazia, tool call sem nome/inventada, tool call repetida; corrige via steer (máx 2 consecutivas) |
| Shell Session | shell-session.ts | execSync bash com timeout (5–600s), output formatado (ANSI, dedup, truncate) |
| Shell Helpers | shell-helpers.ts | stripAnsi, dedupLines, truncateLines (200 linhas: metade head + quarto tail) |
| Shell Write | shell-write.ts | Parser de comandos: splitCommandChain, detectWriteTargets (redirect/append/tee/dd), heredocs |
| Add New Model | add-new-model.ts | Testa endpoint OpenAI-like com curl, registra provider e salva em providers.json; /models lista modelos |
| LM Studio Provider | lmstudio-provider.ts | Registra provider local http://localhost:1234/v1 (não usado pelo index.ts) |
| Brain | brain/index.ts + brain/brain.ts | Notion via ntn: bootstrap idempotente (página MateusNotion → database Brain → indexador Indice) + criar_page |

## 6. Módulo brain (Notion via ntn)

Constantes: `BRAIN_PAGE="MateusNotion"`, `BRAIN_DB="Brain"`, `BRAIN_DS="Indice"`.

Bootstrap (ensureBrain) — idempotente:
```
login (ntn whoami; senão abre terminal novo com `ntn login`)
  → página "MateusNotion" (findPageByTitle via search)
  → database "Brain" (data source automático)
  → indexador "Indice" (listDataSources via `ntn datasources resolve`, sem lag)
```

criar_page(md, tipo, palavrasChave, {metadata}):
- Valida: md não vazio, ntn logado, brain inicializado.
- Garante schema do índice (propriedades Git + Session + opções pesquisa/codigo).
- Extrai gitUrl do markdown (github/gitlab/bitbucket, http ou ssh).
- **tipo "pesquisa"**: 1 página por sessão (Session = id da sessão). Se a sessão já tem
  página, ANEXA o novo MD no final (appendToPage), mesclando tags.
- **tipo "codigo"**: se gitUrl já tem anotação no índice, ATUALIZA a página existente
  (conteúdo + Nome/Tipo/Git/Tags); senão cria nova.
- Criação: `ntn pages create --parent data-source:<dsId> --json` com metadata fixa no
  início (blockquote `_meta: data hora · sessão · provider/model · PC`).
- Índices: Nome (título H1), Tipo, Session, Git, Tags (multi_select).

Tools expostas: `brain_bootstrap` (dry | checkOnly) e `criar_page` (md, tipo, palavrasChave).

## 7. Integrações externas

| Alvo | Como | Onde |
|------|------|------|
| Web (fetch) | fetch() nativo com AbortController 30s, UA mateus-toolkit/1.0 | webfetch.ts, webfetch-agent.ts |
| DuckDuckGo | fetch em html.duckduckgo.com + regex de títulos/snippets | websearch.ts |
| Modelo ativo (micro-agentes) | complete() de @earendil-works/pi-ai/compat, auth via modelRegistry | juiz.ts, documentador.ts, webfetch-agent.ts |
| Notion | CLI ntn: api (search, pages, databases, data_sources, PATCH), datasources resolve/query, pages create/get/edit | brain/brain.ts |
| Shell | execSync com /bin/bash, timeout, maxBuffer 10MB | shell-session.ts |
| PTY (teste) | node-pty spawn do cli.js do pi | run-terminal-pty.cjs |
| Config de providers | ~/.pi/agent/providers.json | add-new-model.ts |

## 8. Segurança (permission-gate)

- Abordagem **deny-list**: tudo permitido por padrão.
- Bloqueia: `rm -rf /`, `mkfs`, `dd` em disco, fork bomb, shutdown/reboot, killall,
  comandos destrutivos do PowerShell/cmd (Format-Volume, Stop-Computer, rd /s /q, etc.).
- `rm` / `del` / `Remove-Item` só dentro do `ctx.cwd`.
- Bloqueia redirecionamento (>, >>, tee, dd of=) para paths de sistema
  (/etc/, /usr/, C:\Windows, C:\Program Files, etc.) — via `detectWriteTargets`.

## 9. Quality monitor (anti-loop)

- Detecta: resposta vazia sem tool call, tool call sem nome, tool name inexistente,
  tool call idêntica à anterior (name+input).
- Corrige via `pi.sendUserMessage(correction, {deliverAs: "steer"})`.
- Desiste após 2 correções consecutivas (notifica no UI).
- Ignora turnos abortados (ESC).

## 10. Observações verificadas

- `run-terminal-pty.cjs` menciona "pi global instalado (0.74.2)" no comentário, mas o
  `pi --version` atual retorna **0.82.1** — comentário desatualizado.
- `lmstudio-provider.ts` existe mas **não é importado** no index.ts (dead code do ponto
  de vista de registro automático).
- Logs diários são gerados em `logs/YYYY-MM-DD.log` (2026-07-28 e 2026-08-01 existem).
- O módulo está versionado no repo pi-mono (últimos commits: módulo brain, juiz, webfetch-agent).

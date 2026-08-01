# Diagnóstico: por que o brain.ts estava criando objetos repetidos

> Lista das causas reais (verificadas empiricamente no workspace "Notion de Mateus Oro",
> via `ntn api v1/search` e execuções repetidas de `node brain.ts`).

## Causas da duplicação

### 1. Título da página lido no campo errado (Bug de código)
- **Problema**: `findPageByTitle()` lia `r.title` nos resultados da busca. No novo modelo
  da API do Notion (2025-09-03), o search devolve o título em
  `properties.title.title[0].plain_text` — `r.title` é `undefined`.
- **Efeito**: a comparação de título nunca batia → o script achava que a página
  "MateusNotion" não existia → **criava outra a cada execução**.
- **Prova**: dump do JSON real da busca mostrou `keys: ... properties, public_url, url`
  (sem `title` no topo) e o título dentro de `properties.title.title[0].plain_text`.
- **Correção**: helper `resultTitle()` extrai de `properties.title.title` e faz fallback
  para `title`.

### 2. Tipo de objeto errado na busca (Bug de código)
- **Problema**: `findDatabaseUnder()` filtrava `r.object === "database"`. A busca do Notion
  devolve objetos **`data_source`** (nunca `database`), com `database_parent.page_id`
  (página dona) e `parent.database_id` (database pai).
- **Efeito**: nunca encontrava o database "Brain" → **criava outro database a cada execução**.
- **Prova**: busca por "Brain" retornou só `OBJ: data_source` (ex.: `21fec54a-…`, título
  "Brain", props `["Name"]`).
- **Correção**: `findDataSourceUnder()` busca `data_source`, filtra por
  `database_parent.page_id === pageId` e deriva o database via `parent.database_id`.

### 3. Lag de indexação do search (Fator externo)
- **Problema**: objetos recém-criados não aparecem na busca imediatamente; em execuções
  consecutivas, o search pode retornar vazio nos primeiros segundos.
- **Efeito**: falso "não existe" reforçava os bugs 1 e 2.
- **Correção**: `searchWithRetry()` — até 4 tentativas com espera de 2s.

### 4. API não permite apagar página de workspace (Limitação da API)
- **Problema**: tentativa de limpar duplicatas com `ntn pages trash …` falhou com
  `400 validation_error: Archiving workspace level pages via API not supported`.
- **Efeito**: as páginas duplicadas ficam no workspace e só podem ser removidas pela UI.
- **Correção**: limpeza manual no Notion (links na seção abaixo).

## Resultado: idempotência comprovada
Rodei `node brain.ts` 2× seguidas após as correções — nenhum objeto novo foi criado:
- ✅ Página mãe: `3af50deb-8443-818d-bd56-ee2dc76cc913` (MateusNotion)
- ✅ Database: `d77d8352-182b-451b-9297-b13360f4c8ab` (Brain)
- ✅ Indexador: `3af50deb-8443-81f0-8438-000bedc36665` (Indice: Nome/Tipo/Tags/Status)

## Duplicatas pendentes de limpeza manual (na UI do Notion)
Manter apenas a primeira; deletar as duas seguintes (botão direito → Delete):
- ✅ Manter: https://app.notion.com/p/MateusNotion-3af50deb8443818dbd56ee2dc76cc913
- 🔴 Apagar: https://app.notion.com/p/MateusNotion-3af50deb844381dea6eac8eedbe19789
- 🔴 Apagar: https://app.notion.com/p/MateusNotion-3af50deb84438182a949f72883129de9

## Arquivos
- `brain.ts` — script corrigido (bootstrap idempotente; `--check` read-only, `--dry` simula).
- `DIAGNOSTICO-DUPLICATAS.md` — este documento.

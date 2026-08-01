# brain — módulo MegaBrains (dentro do mateus-toolkit)

Base da extensão **brain**: gestão do cérebro de projetos no Notion via CLI oficial `ntn`.

## Estrutura modular

```
mateus-toolkit/brain/
├── brain.ts   ← funções modulares (lógica pura, testável via node)
└── index.ts   ← registro dos tools no pi (pi.registerTool)
```

## Funções modulares (brain.ts)

| Função | Descrição |
|--------|-----------|
| `BRAIN_PAGE` / `BRAIN_DB` / `BRAIN_DS` | Constantes: "MateusNotion" / "Brain" / "Indice" |
| `isLoggedIn()` | Verifica se o `ntn` está autenticado (`ntn whoami`) |
| `openLoginTerminal()` | Abre um terminal novo rodando `ntn login` |
| `findPageByTitle(title)` | Busca página pelo título (search da API) |
| `findDataSourceUnder(pageId, dsTitle)` | Acha data source cujo database está sob a página |
| `listDataSources(databaseId)` | Lista data sources via `ntn datasources resolve --json` (sem lag) |
| `createWorkspacePage(title)` | Cria página na raiz do workspace |
| `createDatabase(pageId, title)` | Cria database sob uma página |
| `createDataSource(databaseId, title)` | Cria data source (indexador) com schema Nome/Tipo/Tags/Status |
| `ensureBrain({dry, checkOnly, logger})` | **Orquestrador idempotente**: login → página → database → indexador |

## Uso standalone (sem o pi)

```bash
node brain/brain.ts            # bootstrap completo (idempotente)
node brain/brain.ts --dry      # simula sem criar
node brain/brain.ts --check    # só verifica (read-only)
```

## Uso como tool do pi

O tool `brain_bootstrap` (parâmetros opcionais `dry` e `checkOnly`) executa o
`ensureBrain` e retorna os logs + IDs estruturados. O `main()` do brain.ts só roda
quando o arquivo é executado diretamente — ao importar como módulo, nada executa.

## Como adicionar um novo módulo (padrão)

1. Crie `brain/<nome>.ts` exportando as funções (use `run()`/`apiPost()` de brain.ts, ou importe delas).
2. Crie/edite `brain/index.ts` chamando `pi.registerTool({...})` no padrão abaixo.
3. Se o módulo tiver entry point próprio, registre-o no `index.ts` do mateus-toolkit.

```ts
import { Type } from "@earendil-works/pi-ai";
import { registerBrain, suaFuncao } from "./brain.ts";

pi.registerTool({
  name: "brain_sua_funcao",
  label: "Brain ...",
  description: "...",
  parameters: Type.Object({ ... }),
  async execute(_id, params) {
    const result = suaFuncao(params);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      details: { result },
      isError: false,
    };
  },
});
```

## Validações realizadas

- `node brain/brain.ts` — standalone idempotente (2× seguidas, nada duplicado).
- `pi -p "chame brain_bootstrap..."` — tool registrado e executado dentro do pi:
  - checkOnly: login + página (read-only) ✅
  - completo: página `3af50deb-8443-8126-b36b-e01b9c87a92b`, database
    `0c806ca7-0809-4c84-931e-63544d34b6b4`, indexador
    `3af50deb-8443-8193-a076-000b58621a21` ✅

# mateus-toolkit

Extensão para Pi que força criação de todo list + resumo detalhado + controle de tendência.

## Funcionalidade

1. **create_todo** - Após cada prompt, gera checklist com passos atômicos e resumo detalhado (arquitetura, stack, estrutura)
2. **check_todo** - Marca itens como concluídos
3. **get_todo** - Consulta estado atual do todo e resumo
4. **Controle de tendência** - A cada 5 turnos, injeta prompt validando se o agente está seguindo o plano

## Como testar

```powershell
# Modo interativo
pi -e .pi/extensions/mateus-toolkit/index.ts

# Modo impressão (teste rápido)
pi -e .pi/extensions/mateus-toolkit/index.ts -p "crie um arquivo hello.txt"
```

## run-terminal-pty (CLI)

Abre o **TUI interativo** do pi num PTY real (via `node-pty`), envia um prompt
(padrão `oi`) e imprime a saída completa capturada.

O processo roda **na raiz do projeto** (detectada dinamicamente subindo de
`__dirname` até achar `.pi/extensions`), então o pi **carrega as extensões** da
pasta automaticamente.

```bash
# Dentro de .pi/extensions/mateus-toolkit/
node run-terminal-pty.cjs

# Com opções
node run-terminal-pty.cjs --prompt "oi" --model "opencode-go/deepseek-v4-flash" --timeout 120
```

### Requisitos

- `node-pty` instalado localmente (via `package.json` + `npm install`).
- Pi global instalado (o driver usará `node.exe` + `dist/cli.js` do pi).

### Opções

| Flag | Padrão | Descrição |
|------|--------|-----------|
| `--prompt` | `oi` | Texto enviado ao prompt do TUI |
| `--model` | `opencode-go/deepseek-v4-flash` | Modelo usado pelo pi |
| `--provider` | `opencode-go` | Provider do modelo |
| `--timeout` | `120` | Tempo de coleta (s) até fechar o PTY |
| `--send-at` | `8` | Após quantos segundos enviar o prompt |

Arquivos: `run-terminal-pty.cjs` (driver Node/node-pty) e `package.json`
(declara a dependência `node-pty` em `node_modules/`).

## Comandos

| Comando | Descrição |
|---------|-----------|
| `/todo` | Mostrar todo list |
| `/summary` | Mostrar resumo detalhado |

## Fluxo

```
Usuário → create_todo (checklist + resumo)
        → implementação normal
        → check_todo (marca itens concluídos)
        → [a cada 5 turnos] controle de tendência
```

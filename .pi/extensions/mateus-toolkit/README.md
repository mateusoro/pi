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

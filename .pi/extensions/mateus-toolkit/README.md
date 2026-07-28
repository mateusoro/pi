# mateus-toolkit

Extensão para Pi que exige criação de task antes de executar ações.

## Funcionalidade

Quando o usuário envia uma mensagem, a IA **deve** criar uma task usando a tool `create_task` antes de executar qualquer ação. Se não criar, a extensão injeta um prompt ordenando que crie.

## Como testar

### 1. Instalar o Pi

```powershell
npm install -g @earendil-works/pi-coding-agent
```

### 2. Rodar com a extensão

**Modo interativo** (recomendado para testar o fluxo completo):

```powershell
cd C:\Users\mateu\Documents\pi-mateus\pi
pi -e .pi/extensions/mateus-toolkit/index.ts
```

**Modo impressão** (teste rápido):

```powershell
pi -e .pi/extensions/mateus-toolkit/index.ts -p "diga oi"
```

### 3. O que acontece

1. Você digita uma mensagem (ex: "crie uma API de login")
2. A IA recebe a instrução no system prompt para usar `create_task`
3. Se a IA **não** criar a task → a extensão injeta follow-up ordenando
4. Se a IA **criar** a task → executa normalmente

### 4. Comandos disponíveis

| Comando | Descrição |
|---------|-----------|
| `/tasks` | Listar todas as tasks da sessão |
| `/done` | Marcar task atual como concluída |

## Estrutura do projeto

```
.pi/extensions/mateus-toolkit/
└── index.ts    # Extensão principal
```

## Configuração do provider

Certifique-se de ter um provider configurado no Pi. Exemplo com OpenCode Zen:

```powershell
pi --provider opencode --model deepseek-v4-flash-free
```

Ou configure permanentemente via `/settings` no modo interativo.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { log } from "./logger.ts";

interface TodoItem {
  id: number;
  text: string;
  done: boolean;
}

interface TodoList {
  items: TodoItem[];
  nextId: number;
  createdAt: number;
}

interface Summary {
  text: string;
  createdAt: number;
}

export function registerControleTendencia(pi: ExtensionAPI) {
  let todo: TodoList | null = null;
  let summary: Summary | null = null;
  let turnCounter = 0;
  let lastUserMessage = "";
  let todoCreatedThisTurn = false;
  let externalToolCallCount = 0;

  pi.on("session_start", async (_event, ctx) => {
    log("INFO", "Controle de tendência: session started", { reason: _event.reason });
    todo = null;
    summary = null;
    turnCounter = 0;
    lastUserMessage = "";
    todoCreatedThisTurn = false;
    externalToolCallCount = 0;

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom") {
        if (entry.customType === "mateus-todo") {
          todo = entry.data as TodoList;
        }
        if (entry.customType === "mateus-summary") {
          summary = entry.data as Summary;
        }
      }
    }
  });

  // ── create_todo ──
  pi.registerTool({
    name: "create_todo",
    label: "Create Todo",
    description:
      "Gere um checklist com passos atômicos + resumo detalhado. PRIMEIRA tool obrigatória. " +
      "NUNCA invente dados. Se não sabe algo, inclua fase de pesquisa no todo.",
    promptSnippet: "create_todo: PRIMEIRA tool em TODA resposta",
    promptGuidelines: [
      "Sua PRIMEIRA resposta DEVE ser create_todo.",
      "NÃO responda com texto antes de create_todo.",
      "Cada item = passo atômico e verificável.",
      "NUNCA invente informações. Use apenas dados reais e verificáveis.",
      "Se não sabe sobre o assunto, PRIMEIRO item DEVE ser 'Pesquisar sobre [assunto]'.",
      "Se não conhece uma API/lib, PRIMEIRO item DEVE ser 'Verificar documentação de [API/lib]'.",
      "O resumo DEVE conter apenas fatos que você tem certeza. Se incerto, diga 'a ser verificado'.",
      "Altere APENAS o que foi explicitamente solicitado pelo usuário. NÃO modifique arquivos, configs ou código não relacionado ao pedido.",
    ],
    parameters: Type.Object({
      items: Type.Array(Type.String(), { description: "Passos atômicos" }),
      summary: Type.String({ description: "Resumo detalhado: arquitetura, stack, estrutura" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      log("INFO", "create_todo called", { items: params.items.length });
      todoCreatedThisTurn = true;
      turnCounter = 0;
      externalToolCallCount = 0;

      const newTodo: TodoList = {
        items: params.items.map((text, i) => ({ id: i + 1, text, done: false })),
        nextId: params.items.length + 1,
        createdAt: Date.now(),
      };

      // Adicionar item de diff como último item (hardcoded)
      const diffItemId = newTodo.items.length + 1;
      newTodo.items.push({ id: diffItemId, text: "Apresentar diff resumido do que foi corrigido/implementado", done: false });
      newTodo.nextId = diffItemId + 1;

      const newSummary: Summary = { text: params.summary, createdAt: Date.now() };

      todo = newTodo;
      summary = newSummary;

      pi.appendEntry("mateus-todo", newTodo);
      pi.appendEntry("mateus-summary", newSummary);

      const checklist = newTodo.items.map((item) => `- [ ] ${item.id}. ${item.text}`).join("\n");
      return {
        content: [{ type: "text", text: `TODO (${newTodo.items.length} itens):\n${checklist}\nResumo salvo. Prossiga com o item #1.` }],
        details: { todo: newTodo, summary: newSummary },
      };
    },
  });

  // ── check_todo ──
  pi.registerTool({
    name: "check_todo",
    label: "Check Todo",
    description: "Marque um item como concluído.",
    parameters: Type.Object({
      id: Type.Number({ description: "ID do item" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!todo) return { content: [{ type: "text", text: "Nenhum todo ativo." }] };
      const item = todo.items.find((i) => i.id === params.id);
      log("INFO", "check_todo called", { id: params.id, item: item?.text });
      if (!item) return { content: [{ type: "text", text: `Item #${params.id} não encontrado.` }] };

      item.done = true;
      externalToolCallCount = 0; // reseta ao concluir item
      pi.appendEntry("mateus-todo", { ...todo });

      const pending = todo.items.filter((i) => !i.done);
      const done = todo.items.filter((i) => i.done);
      const proximo = pending.length > 0 ? pending[0] : null;

      // Se tem próximo item, injetar steer pra forçar um item por vez
      if (proximo) {
        setTimeout(() => {
          pi.sendUserMessage(
            `Item #${item.id} concluído. Agora implemente APENAS o item #${proximo.id}: ${proximo.text}. Ao terminar, chame check_todo(id=${proximo.id}).`,
            { deliverAs: "steer" }
          );
        }, 100);
      }

      return {
        content: [{
          type: "text",
          text: proximo
            ? `#${item.id} concluído: "${item.text}"\nProgresso: ${done.length}/${todo.items.length}\nPróximo: #${proximo.id}. ${proximo.text}`
            : `#${item.id} concluído: "${item.text}"\nTODO 100% concluído!`,
        }],
        details: { todo },
      };
    },
  });

  // ── get_todo ──
  pi.registerTool({
    name: "get_todo",
    label: "Get Todo",
    description: "Consulte todo list e resumo.",
    parameters: Type.Object({}),
    async execute() {
      if (!todo) return { content: [{ type: "text", text: "Nenhum todo ativo." }] };
      const checklist = todo.items.map((item) => `- [${item.done ? "x" : " "}] ${item.id}. ${item.text}`).join("\n");
      const summaryText = summary ? `\n\nResumo:\n${summary.text}` : "";
      return { content: [{ type: "text", text: `TODO:\n${checklist}${summaryText}` }] };
    },
  });

  // ── Comandos ──
  pi.registerCommand("todo", {
    description: "Mostrar todo list",
    handler: async (_args, ctx) => {
      if (!todo) { ctx.ui.notify("Nenhum todo ativo", "info"); return; }
      const checklist = todo.items.map((item) => `[${item.done ? "x" : " "}] ${item.id}. ${item.text}`).join("\n");
      ctx.ui.notify(checklist, "info");
    },
  });

  // ── Capturar input + injetar prompt junto com a mensagem ──
  pi.on("input", async (event, ctx) => {
    // Pular comandos, steers do próprio toolkit, e mensagens de outros módulos
    if (event.text.startsWith("/") || event.source === "extension") return { action: "continue" };
    // Pular steers/followUps internos (controle de tendência, quality monitor)
    if (event.text.startsWith("[SISTEMA]") || event.text.startsWith("[ALINHAMENTO")) return { action: "continue" };
    lastUserMessage = event.text;
    todoCreatedThisTurn = false;
    turnCounter = 0;
    externalToolCallCount = 0;

    // Sem todo ativo → forçar criação do todo
    if (!todo) {
      const userSnippet = event.text.substring(0, 200).replace(/"/g, '\\"');
      const forceTodo = `
[CONTEXTO - CRIAR TODO OBRIGATÓRIO]
SUA ÚNICA RESPOSTA DEVE SER create_todo(items=["passo1","passo2"...], summary="resumo").
NÃO escreva texto. NÃO chame OUTRAS tools.

REGRAS OBRIGATÓRIAS PARA O TODO:
1. NUNCA invente dados. Use apenas fatos reais e verificáveis.
2. Se NÃO sabe sobre o assunto: PRIMEIRO item = "Pesquisar sobre [assunto]".
3. Se NÃO conhece uma API/lib: PRIMEIRO item = "Verificar documentação de [API/lib]".
4. Se tem DÚVIDA sobre algo: inclua item "Verificar/validar [dúvida]".
5. O resumo DEVE conter apenas certezas. Se incerto, diga "a ser verificado".
6. NUNCA presupuna que algo funciona sem ter verificado.
7. Altere APENAS o que foi explicitamente solicitado pelo usuário. NÃO modifique arquivos, configs ou código não relacionado ao pedido.

O usuário pediu: "${userSnippet}"
[/CONTEXTO - CRIAR TODO OBRIGATÓRIO]`;
      return { action: "transform", text: event.text + forceTodo };
    }

    // Todo ativo → SEMPRE chamar create_todo pra atualizar o plano
    const pending = todo.items.filter((i) => !i.done);
    const done = todo.items.filter((i) => i.done);
    const proximo = pending.length > 0 ? pending[0] : null;
    const total = todo.items.length;
    const progresso = total > 0 ? Math.round((done.length / total) * 100) : 0;

    if (proximo) {
      const checklist = todo.items.map((item) =>
        `[${item.done ? "x" : " "}] #${item.id}. ${item.text}`
      ).join("\n");

      const contextSnippet = `
[CONTEXTO - PLANO ATIVO - ALTERAÇÃO SOLICITADA]
TODO atual:
${checklist}

Progresso: ${done.length}/${total} (${progresso}%).

O usuário está mandando você corrigir a rota atual. Pare o que está fazendo.
Chame create_todo para atualizar o todo conforme a mensagem do usuário.
[/CONTEXTO - PLANO ATIVO - ALTERAÇÃO SOLICITADA]`;
      return { action: "transform", text: event.text + contextSnippet };
    }

    // Todos concluídos
    return { action: "continue" };
  });

  // ── before_agent_start: INJETAR instrução obrigatória ──
  pi.on("before_agent_start", async (event, ctx) => {
    const systemPrompt = ctx.getSystemPrompt();

    // Se já criou o todo neste turno OU já existe todo ativo, não injeta
    if (todoCreatedThisTurn || todo) return { systemPrompt };

    const userSnippet = lastUserMessage.substring(0, 200).replace(/"/g, '\\"');

    const instruction = `
[MATEUS-TOOLKIT - BLOQUEADO ATÉ CRIAR TODO]
SUA ÚNICA PERMITIDA É CHAMAR create_todo.
NÃO escreva texto. NÃO chame OUTRAS tools.
APENAS: create_todo(items=["passo1","passo2"...], summary="resumo")

REGRAS OBRIGATÓRIAS PARA O TODO:
1. NUNCA invente dados. Use apenas fatos reais e verificáveis.
2. Se NÃO sabe sobre o assunto: PRIMEIRO item = "Pesquisar sobre [assunto]".
3. Se NÃO conhece uma API/lib: PRIMEIRO item = "Verificar documentação de [API/lib]".
4. Se tem DÚVIDA sobre algo: inclua item "Verificar/validar [dúvida]".
5. O resumo DEVE conter apenas certezas. Se incerto, diga "a ser verificado".
6. NUNCA presupuna que algo funciona sem ter verificado.
7. Altere APENAS o que foi explicitamente solicitado pelo usuário. NÃO modifique arquivos, configs ou código não relacionado ao pedido.

O usuário pediu: "${userSnippet}"
[/MATEUS-TOOLKIT]`;

    // systemPrompt injeta a instrução (SEM message display - antes do modelo responder)
    return { systemPrompt: systemPrompt + instruction };
  });

  // ── tool_call: BLOQUEAR tudo que não é create_todo/check_todo/get_todo ──
  pi.on("tool_call", async (event, ctx) => {
    // Se já criou o todo, permitir check_todo e get_todo
    if (todoCreatedThisTurn) {
      if (["create_todo", "check_todo", "get_todo"].includes(event.toolName)) return;
      // Permitir outras tools normalmente
      return;
    }

    // Se NÃO criou o todo, bloquear TUDO exceto create_todo e add_new_model
    if (event.toolName === "create_todo") return;
    if (event.toolName === "add_new_model") return;

    log("BLOCK", `Tool bloqueada (sem todo): ${event.toolName}`);
    return {
      block: true,
      reason: `BLOQUEADO: Você NÃO pode usar ${event.toolName}. CHAME create_todo PRIMEIRO.`,
    };
  });

  // ── Contador de tools externas: buscar internet após 10 chamadas ──
  const INTERNAL_TOOLS = ["create_todo", "check_todo", "get_todo", "websearch", "webfetch"];

  pi.on("tool_call", async (event) => {
    if (!todo) return;
    if (INTERNAL_TOOLS.includes(event.toolName)) return;
    externalToolCallCount++;
    log("TOOL_COUNT", `Tool externa #${externalToolCallCount}: ${event.toolName}`);
  });

  // ── agent_end: verificar se create_todo foi chamado ──
  let steerCount = 0;
  pi.on("agent_end", async (event, ctx) => {
    if (todoCreatedThisTurn) {
      steerCount = 0;

      // Se tem todo ativo com itens pendentes, injetar steer para atualizar
      if (todo) {
        const pending = todo.items.filter((i) => !i.done);
        if (pending.length > 0) {
          const checklist = todo.items.map((item) =>
            `- [${item.done ? "x" : " "}] #${item.id}. ${item.text}`
          ).join("\n");
          const proximo = pending[0];
          log("INFO", `Todo ativo com ${pending.length} itens pendentes. Injetando steer para continuação.`);
          pi.sendUserMessage(
            `[SISTEMA] O item #${proximo.id} ainda precisa ser implementado: ${proximo.text}\n\nTodo atual:\n${checklist}\n\nChame get_todo() para ver o estado completo e implemente o próximo item.`,
            { deliverAs: "followUp" }
          );
        }
      }
      return;
    }

    const todoCalled = event.messages.some(
      (m) => m.role === "toolResult" && m.toolName === "create_todo"
    );

    if (todoCalled) {
      todoCreatedThisTurn = true;
      steerCount = 0;
      return;
    }

    // Limitar steer para evitar loop infinito
    steerCount++;
    if (steerCount > 3) {
      log("WARN", `Steer limit atingido (${steerCount}). Aguardando próximo input.`);
      steerCount = 0;
      return;
    }

    // Extrair a última resposta do modelo para log
    const lastAssistant = [...event.messages].reverse().find(
      (m) => m.role === "assistant"
    );
    const wrongText = lastAssistant?.content
      ?.filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join(" ")
      .substring(0, 300) || "(resposta vazia)";

    // NÃO criou - forçar com steer (o steer cria mensagem visível no chat)
    log("WARN", `create_todo NÃO chamado (steer #${steerCount}). Resposta: "${wrongText.substring(0, 100)}"`);
    pi.sendUserMessage(
      `[SISTEMA] Você respondeu: "${wrongText.substring(0, 150)}"\n\nIsso está ERRADO. Você NÃO pode apenas responder texto.\nSua ÚNICA resposta agora DEVE ser create_todo(items=["passo1"], summary="resumo"). NADA MAIS.`,
      { deliverAs: "steer" }
    );
  });

  // ── Turnos + reforço ──
  pi.on("turn_end", async () => {
    turnCounter++;
    log("TURN", `Turno ${turnCounter} finalizado`);

    // Reforço a cada 5 turnos (se tem todo e tem itens pendentes)
    if (turnCounter > 0 && turnCounter % 10 === 0 && todo) {
      const pending = todo.items.filter((i) => !i.done);
      const done = todo.items.filter((i) => i.done);
      const total = todo.items.length;
      const progresso = total > 0 ? Math.round((done.length / total) * 100) : 0;

      // Se não tem pendentes, o trabalho acabou - não injeta reforço
      if (pending.length === 0) {
        log("REFORCO", "Todos concluídos, reforço ignorado");
        return;
      }

      const proximo = pending[0];

      log("REFORCO", `Reforço injetado`, { turno: turnCounter, progresso: `${done.length}/${total}` });

      pi.sendUserMessage(
        `[ALINHAMENTO CONFORME PLANO — TURNO ${turnCounter}]
Progresso: ${done.length}/${total} (${progresso}%).
ATUAL SENDO REALIZADO: #${proximo.id}. ${proximo.text}
Siga o plano, se precisar mudar algo, chame create_todo para alterar o plano. Ao concluir, chame check_todo(id=${proximo.id}).
[/ALINHAMENTO CONFORME PLANO]`,
        { deliverAs: "steer" }
      );
    }
  });
}

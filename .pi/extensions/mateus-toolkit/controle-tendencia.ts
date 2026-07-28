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
  let retryCount = 0;

  pi.on("session_start", async (_event, ctx) => {
    log("INFO", "Controle de tendência: session started", { reason: _event.reason });
    todo = null;
    summary = null;
    turnCounter = 0;
    lastUserMessage = "";
    todoCreatedThisTurn = false;
    retryCount = 0;

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
    description: "Gere um checklist com passos atômicos + resumo detalhado. PRIMEIRA tool obrigatória.",
    promptSnippet: "create_todo: PRIMEIRA tool em TODA resposta",
    promptGuidelines: [
      "Sua PRIMEIRA resposta DEVE ser create_todo.",
      "NÃO responda com texto antes de create_todo.",
      "Cada item = passo atômico e verificável.",
      "APÓS create_todo, implemente UM item por vez.",
      "Ao concluir cada item, reporte o que fez e chame check_todo.",
    ],
    parameters: Type.Object({
      items: Type.Array(Type.String(), { description: "Passos atômicos" }),
      summary: Type.String({ description: "Resumo detalhado: arquitetura, stack, estrutura" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      log("INFO", "create_todo called", { items: params.items.length });
      todoCreatedThisTurn = true;
      retryCount = 0;
      turnCounter = 0;

      const newTodo: TodoList = {
        items: params.items.map((text, i) => ({ id: i + 1, text, done: false })),
        nextId: params.items.length + 1,
        createdAt: Date.now(),
      };
      const newSummary: Summary = { text: params.summary, createdAt: Date.now() };

      todo = newTodo;
      summary = newSummary;

      pi.appendEntry("mateus-todo", newTodo);
      pi.appendEntry("mateus-summary", newSummary);

      const checklist = newTodo.items.map((item) => `- [ ] ${item.id}. ${item.text}`).join("\n");
      return {
        content: [{ type: "text", text: `TODO (${newTodo.items.length} itens):\n${checklist}\nResumo salvo. Prossiga.` }],
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
      pi.appendEntry("mateus-todo", { ...todo });

      const pending = todo.items.filter((i) => !i.done);
      const done = todo.items.filter((i) => i.done);
      return {
        content: [{ type: "text", text: `#${item.id} concluído: "${item.text}"\nProgresso: ${done.length}/${todo.items.length} - Restam ${pending.length}` }],
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

  pi.registerCommand("summary", {
    description: "Mostrar resumo",
    handler: async (_args, ctx) => {
      if (!summary) { ctx.ui.notify("Nenhum resumo", "info"); return; }
      ctx.ui.notify(summary.text, "info");
    },
  });

  // ── Capturar input ──
  pi.on("input", async (event, ctx) => {
    if (event.text.startsWith("/") || event.source === "extension") return { action: "continue" };
    lastUserMessage = event.text;
    todoCreatedThisTurn = false;
    return { action: "continue" };
  });

  // ── before_agent_start: FORÇA create_todo ──
  pi.on("before_agent_start", async (event, ctx) => {
    const systemPrompt = ctx.getSystemPrompt();
    const userSnippet = lastUserMessage.substring(0, 200).replace(/"/g, '\\"');

    if (todoCreatedThisTurn) return { systemPrompt };

    let instruction = "";

    if (retryCount === 0) {
      instruction = `
[MATEUS-TOOLKIT - OBRIGATÓRIO]
REGRA 1: Sua PRIMEIRA resposta deve ser create_todo.
REGRA 2: APÓS create_todo, implemente UM item por vez.
REGRA 3: Ao concluir cada item, reporte o que fez e chame check_todo.
REGRA 4: NÃO faça tudo de uma vez. Um passo, um reporte.
O usuário pediu: "${userSnippet}"
[/MATEUS-TOOLKIT]`;
    } else if (retryCount === 1) {
      instruction = `
[MATEUS-TOOLKIT - VOCÊ NÃO OBEDECEU]
Você NÃO chamou create_todo. Isso é OBRIGATÓRIO.
Sua ÚNICA resposta agora DEVE ser: create_todo
NADA MAIS. SOMENTE A TOOL.
Resposta do usuário: "${userSnippet}"
[/MATEUS-TOOLKIT]`;
    } else {
      instruction = `
[MATEUS-TOOLKIT - BLOQUEADO - TENTATIVA ${retryCount + 1}]
CHAME create_todo AGORA.
Pedido: "${userSnippet}"
[/MATEUS-TOOLKIT]`;
    }

    return { systemPrompt: systemPrompt + instruction };
  });

  // ── agent_end: verificar se create_todo foi chamado ──
  pi.on("agent_end", async (event, ctx) => {
    if (todoCreatedThisTurn) return;

    const todoCalled = event.messages.some(
      (m) => m.role === "toolResult" && m.toolName === "create_todo"
    );

    if (todoCalled) {
      todoCreatedThisTurn = true;
      retryCount = 0;
    } else {
      retryCount++;
      log("WARN", `create_todo NÃO chamado. Retry: ${retryCount}`);
      if (retryCount < 5) {
        pi.sendUserMessage(
          `[SISTEMA] Chame create_todo AGORA com items e summary para: "${lastUserMessage.substring(0, 150)}"`,
          { deliverAs: "followUp" }
        );
      }
    }
  });

  // ── Bloquear tools antes de create_todo ──
  pi.on("tool_call", async (event, ctx) => {
    if (["create_todo", "check_todo", "get_todo"].includes(event.toolName)) return;
    if (todo) return;
    log("BLOCK", `Tool bloqueada: ${event.toolName}`);
    return { block: true, reason: `BLOQUEADO: chame create_todo PRIMEIRO.` };
  });

  // ── Turnos + controle de tendência ──
  pi.on("turn_end", async () => {
    turnCounter++;
    log("TURN", `Turno ${turnCounter} finalizado`);

    if (turnCounter > 0 && turnCounter % 5 === 0 && todo && todo.items.some((i) => !i.done)) {
      const pending = todo.items.filter((i) => !i.done);
      const done = todo.items.filter((i) => i.done);
      const total = todo.items.length;
      const progresso = total > 0 ? Math.round((done.length / total) * 100) : 0;
      const proximo = pending.length > 0 ? pending[0] : null;

      log("REFORCO", `Controle de tendência injetado`, { turno: turnCounter, progresso: `${done.length}/${total}` });

      pi.sendUserMessage(
        `[REFORÇO — TURNO ${turnCounter}]
Bom progresso: ${done.length}/${total} (${progresso}%).
Próximo item: #${proximo?.id}. ${proximo?.text || "(nenhum pendente)"}
Você é OBRIGADO a seguir este todo list e o resumo detalhado. NÃO desvie.
Se não conseguir, chame create_todo para refazer o plano.
Ao concluir item, chame check_todo(id=${proximo?.id || 0}).
[/REFORÇO]`,
        { deliverAs: "followUp" }
      );
    }
  });
}

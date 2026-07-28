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

  pi.on("session_start", async (_event, ctx) => {
    log("INFO", "Controle de tendência: session started", { reason: _event.reason });
    todo = null;
    summary = null;
    turnCounter = 0;
    lastUserMessage = "";
    todoCreatedThisTurn = false;

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
    ],
    parameters: Type.Object({
      items: Type.Array(Type.String(), { description: "Passos atômicos" }),
      summary: Type.String({ description: "Resumo detalhado: arquitetura, stack, estrutura" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      log("INFO", "create_todo called", { items: params.items.length });
      todoCreatedThisTurn = true;
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

  // ── Capturar input ──
  pi.on("input", async (event, ctx) => {
    if (event.text.startsWith("/") || event.source === "extension") return { action: "continue" };
    lastUserMessage = event.text;
    todoCreatedThisTurn = false;
    turnCounter = 0;
    return { action: "continue" };
  });

  // ── before_agent_start: INJETAR instrução obrigatória ──
  pi.on("before_agent_start", async (event, ctx) => {
    const systemPrompt = ctx.getSystemPrompt();

    // Se já criou o todo neste turno, não injeta
    if (todoCreatedThisTurn) return { systemPrompt };

    const userSnippet = lastUserMessage.substring(0, 200).replace(/"/g, '\\"');

    const instruction = `
[MATEUS-TOOLKIT - BLOQUEADO ATÉ CRIAR TODO]
SUA ÚNICA PERMITIDA É CHAMAR create_todo.
NÃO escreva texto. NÃO chame OUTRAS tools.
APENAS: create_todo(items=["passo1","passo2"...], summary="resumo")
O usuário pediu: "${userSnippet}"
Se já existe um todo ativo, chame get_todo para ver o estado.
[/MATEUS-TOOLKIT]`;

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

    // Se NÃO criou o todo, bloquear TUDO exceto create_todo
    if (event.toolName === "create_todo") return;

    log("BLOCK", `Tool bloqueada (sem todo): ${event.toolName}`);
    return {
      block: true,
      reason: `BLOQUEADO: Você NÃO pode usar ${event.toolName}. CHAME create_todo PRIMEIRO.`,
    };
  });

  // ── agent_end: verificar se create_todo foi chamado ──
  pi.on("agent_end", async (event, ctx) => {
    if (todoCreatedThisTurn) return;

    const todoCalled = event.messages.some(
      (m) => m.role === "toolResult" && m.toolName === "create_todo"
    );

    if (todoCalled) {
      todoCreatedThisTurn = true;
      return;
    }

    // NÃO criou - forçar com steer (entrega imediatamente)
    log("WARN", `create_todo NÃO chamado. Forçando...`);
    pi.sendUserMessage(
      `[SISTEMA] Você NÃO chamou create_todo. Sua ÚNICA resposta agora DEVE ser create_todo(items=["passo1"], summary="resumo"). NADA MAIS.`,
      { deliverAs: "steer" }
    );
  });

  // ── Turnos + reforço ──
  pi.on("turn_end", async () => {
    turnCounter++;
    log("TURN", `Turno ${turnCounter} finalizado`);

    // Reforço a cada 5 turnos (se tem todo e tem itens pendentes)
    if (turnCounter > 0 && turnCounter % 5 === 0 && todo) {
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
        `[REFORÇO — TURNO ${turnCounter}]
Progresso: ${done.length}/${total} (${progresso}%).
Próximo: #${proximo.id}. ${proximo.text}
Siga o plano. Ao concluir, chame check_todo(id=${proximo.id}).
[/REFORÇO]`,
        { deliverAs: "steer" }
      );
    }
  });
}

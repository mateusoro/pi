import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";

/**
 * mateus-toolkit - Força create_todo + resumo + controle de tendência
 *
 * Abordagem: before_agent_start injeta system prompt + mensagem obrigatória.
 * O modelo é obrigado a chamar create_todo como PRIMEIRA tool.
 */

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

export default function (pi: ExtensionAPI) {
  console.error("[MATEUS-TOOLKIT] Loading...");

  let todo: TodoList | null = null;
  let summary: Summary | null = null;
  let turnCounter = 0;
  let lastUserMessage = "";

  pi.on("session_start", async (_event, ctx) => {
    console.error("[MATEUS-TOOLKIT] Session started");
    todo = null;
    summary = null;
    turnCounter = 0;
    lastUserMessage = "";

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
      "Gere um checklist com passos atômicos + resumo detalhado. PRIMEIRA tool obrigatória.",
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
      console.error("[MATEUS-TOOLKIT] create_todo called");
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
        content: [{ type: "text", text: `TODO (${newTodo.items.length} itens):\n${checklist}\nResumo salvo. Prossiga com a implementação.` }],
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
    turnCounter = 0;
    return { action: "continue" };
  });

  // ── before_agent_start: FORÇA create_todo ──
  pi.on("before_agent_start", async (event, ctx) => {
    const systemPrompt = ctx.getSystemPrompt();

    const userSnippet = lastUserMessage.substring(0, 200).replace(/"/g, '\\"');

    let injected = `

[MATEUS-TOOLKIT - REGRAS OBRIGATÓRIAS]
REGRA 1: Sua PRIMEIRA resposta DEVE conter EXATAMENTE UMA chamada à tool create_todo.
REGRA 2: NÃO escreva nenhum texto antes ou depois de create_todo nesta primeira resposta.
REGRA 3: O campo items deve conter TODOS os passos atômicos necessários.
REGRA 4: O campo summary deve conter o resumo detalhado da implementação.
REGRA 5: Somente APÓS create_todo retornar resultado, você pode escrever texto e usar outras tools.
EXEMPLO de resposta correta: SOMENTE a chamada create_todo, nada mais.
O usuário pediu: "${userSnippet}"
[/MATEUS-TOOLKIT]`;

    // Controle de tendência a cada 5 turnos
    if (turnCounter > 0 && turnCounter % 5 === 0 && todo) {
      const pending = todo.items.filter((i) => !i.done);
      const done = todo.items.filter((i) => i.done);
      const pendingList = pending.map((i) => `  - #${i.id}: ${i.text}`).join("\n");
      const doneList = done.map((i) => `  - #${i.id}: ${i.text}`).join("\n");

      injected += `

[CONTROLE TENDÊNCIA - TURNO ${turnCounter}]
Valide se está seguindo o plano:
Concluídos (${done.length}): ${doneList || "(nenhum)"}
Pendentes (${pending.length}): ${pendingList || "(nenhum)"}
Resumo: ${summary?.text || "(nenhum)"}
Se desviou, corrija. Se OK, continue e marque check_todo.
[/CONTROLE TENDÊNCIA]`;
    }

    return { systemPrompt: systemPrompt + injected };
  });

  // ── Contar turnos ──
  pi.on("turn_end", async () => { turnCounter++; });

  // ── Bloquear tools antes de create_todo ──
  pi.on("tool_call", async (event, ctx) => {
    if (["create_todo", "check_todo", "get_todo"].includes(event.toolName)) return;
    if (todo) return;
    return { block: true, reason: `BLOQUEADO: chame create_todo PRIMEIRO.` };
  });

  // ── after_provider_request: log para debug ──
  pi.on("before_provider_request", async (event, ctx) => {
    console.error("[MATEUS-TOOLKIT] Provider request sent");
  });
}
